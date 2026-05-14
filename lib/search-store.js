import { SEARCH_MAX, SEARCH_REBUILD_INTERVAL } from './config.js'
import { mkdirSync } from 'fs'
import { dirname } from 'path'

// --- SQLite FTS5 search index with in-memory fallback ---

let _db = null
let _useFts = false

// Cached prepared statements for hot path (avoid re-preparing on every search call)
let _stmtSearchMatch = null
let _stmtSearchAll = null
let _stmtMetaSize = null
let _stmtMetaBuild = null

// Attempt to initialize SQLite FTS5 on module load
try {
  const Database = (await import('better-sqlite3')).default
  const dbPath = process.env.SEARCH_DB || '/data/search.db'
  // Ensure directory exists
  try { mkdirSync(dirname(dbPath), { recursive: true }) } catch {}
  _db = new Database(dbPath)
  _db.pragma('journal_mode = WAL')
  _db.pragma('synchronous = NORMAL')
  // FTS5 virtual table with trigram tokenizer for substring matching
  _db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS search_entries USING fts5(
    id, name, type,
    tokenize='trigram'
  )`)
  // Metadata table for build stats
  _db.exec(`CREATE TABLE IF NOT EXISTS search_meta (
    key TEXT PRIMARY KEY,
    value TEXT
  )`)
  // Pre-cache prepared statements for the hot search path
  _stmtSearchMatch = _db.prepare(
    `SELECT id, name, type FROM search_entries WHERE search_entries MATCH '"' || ? || '"' LIMIT ?`
  )
  _stmtSearchAll = _db.prepare('SELECT id, name, type FROM search_entries LIMIT ?')
  _stmtMetaSize = _db.prepare("SELECT value FROM search_meta WHERE key = 'size'")
  _stmtMetaBuild = _db.prepare("SELECT value FROM search_meta WHERE key = 'lastBuild'")
  _useFts = true
  console.log('search-store: SQLite FTS5 initialized at', dbPath)
} catch (err) {
  console.warn('search-store: SQLite FTS5 unavailable, falling back to in-memory:', err.message)
  _db = null
  _useFts = false
}

// --- In-memory fallback state ---
let _searchEntries = []
let _searchLastBuild = 0

/**
 * Search the index by substring match.
 * FTS5 mode: uses trigram tokenizer for sub-millisecond search across millions of entries.
 * Fallback mode: in-memory array filter (capped at SEARCH_MAX).
 * @param {string} query - search term
 * @param {number} limit - max results to return
 * @returns {{ results: Array, total: number, indexAge: number }}
 */
export function search(query, limit = 100) {
  const q = (query || '').toLowerCase().trim()

  if (_useFts && _db) {
    return ftsSearch(q, limit)
  }
  return memSearch(q, limit)
}

function ftsSearch(q, limit) {
  const stats = getStats()
  const age = stats.lastBuild ? Date.now() - stats.lastBuild : 0
  if (!q || q.length < 2) {
    // Empty/short query — return recent entries
    const rows = _stmtSearchAll.all(limit)
    return { results: rows, total: stats.size, indexAge: age }
  }
  // Sanitize: strip quotes and limit length to prevent injection in FTS5 MATCH
  const safeQuery = q.replace(/['"]/g, '').slice(0, 100)
  if (!safeQuery) {
    const rows = _stmtSearchAll.all(limit)
    return { results: rows, total: stats.size, indexAge: age }
  }
  try {
    // FTS5 trigram MATCH — wrapping in quotes enables substring matching
    const rows = _stmtSearchMatch.all(safeQuery, limit)
    return { results: rows, total: stats.size, indexAge: age }
  } catch (err) {
    // If FTS5 query fails (bad characters, etc.), fall back to empty results
    console.warn('search-store: FTS5 query error:', err.message)
    return { results: [], total: stats.size, indexAge: age }
  }
}

function memSearch(q, limit) {
  if (!q || q.length < 2) return { results: [], total: _searchEntries.length, indexAge: Date.now() - _searchLastBuild }
  const results = _searchEntries
    .filter(e => e.name.toLowerCase().includes(q))
    .slice(0, limit)
  return { results, total: _searchEntries.length, indexAge: Date.now() - _searchLastBuild }
}

/**
 * Rebuild the search index from Ponder data.
 * FTS5 mode: writes to SQLite DB (no cap). Other workers read via WAL.
 * Fallback mode: rebuilds in-memory array (capped at SEARCH_MAX).
 * @param {function} ponderQueryFn - async function(cacheKey, graphql, variables, ttlMs) => data
 */
export async function rebuild(ponderQueryFn) {
  const REBUILD_INTERVAL = SEARCH_REBUILD_INTERVAL
  const entries = []

  // Fetch all artists (paginated, up to 500 pages of 200)
  let cursor = null
  for (let page = 0; page < 500; page++) {
    const vars = { limit: 200 }
    if (cursor) vars.after = cursor
    const data = await ponderQueryFn(
      `search-artists:${page}`,
      `query SearchArtists($limit: Int!, $after: String) {
        artists(limit: $limit, after: $after) {
          items { id domain }
          pageInfo { endCursor hasNextPage }
        }
      }`,
      vars,
      REBUILD_INTERVAL
    )
    for (const a of (data.artists?.items || [])) {
      if (a.domain) entries.push({ id: a.id, name: a.domain, type: 'artist' })
    }
    // In-memory mode: cap at 100K to prevent OOM during fetch
    if (!_useFts && entries.length >= 100000) break
    if (!data.artists?.pageInfo?.hasNextPage) break
    cursor = data.artists.pageInfo.endCursor
  }

  // Fetch all supporters (paginated, up to 500 pages of 200)
  cursor = null
  for (let page = 0; page < 500; page++) {
    const vars = { limit: 200 }
    if (cursor) vars.after = cursor
    const data = await ponderQueryFn(
      `search-supporters:${page}`,
      `query SearchSupporters($limit: Int!, $after: String) {
        supporters(limit: $limit, after: $after) {
          items { id handle }
          pageInfo { endCursor hasNextPage }
        }
      }`,
      vars,
      REBUILD_INTERVAL
    )
    for (const s of (data.supporters?.items || [])) {
      if (s.handle) entries.push({ id: s.id, name: s.handle, type: 'audience' })
    }
    // In-memory mode: cap at 100K to prevent OOM during fetch
    if (!_useFts && entries.length >= 100000) break
    if (!data.supporters?.pageInfo?.hasNextPage) break
    cursor = data.supporters.pageInfo.endCursor
  }

  if (_useFts && _db) {
    // FTS5 mode: atomic rebuild of the entire index (no cap)
    try {
      const deleteAll = _db.prepare('DELETE FROM search_entries')
      const insert = _db.prepare('INSERT INTO search_entries (id, name, type) VALUES (?, ?, ?)')
      const upsertMeta = _db.prepare('INSERT OR REPLACE INTO search_meta (key, value) VALUES (?, ?)')

      const rebuildTransaction = _db.transaction((entries) => {
        deleteAll.run()
        for (const e of entries) {
          insert.run(e.id, e.name, e.type)
        }
        upsertMeta.run('lastBuild', String(Date.now()))
        upsertMeta.run('size', String(entries.length))
      })
      rebuildTransaction(entries)
      _searchLastBuild = Date.now()
      console.log(`search index built (FTS5): ${entries.length} entries`)
    } catch (err) {
      console.error('search-store: FTS5 rebuild failed:', err.message)
      // Don't update lastBuild — stale data is better than no data
    }
  } else {
    // In-memory fallback: apply cap
    if (entries.length > SEARCH_MAX) entries.length = SEARCH_MAX
    _searchEntries = null // free old array before assigning new one
    _searchEntries = entries
    _searchLastBuild = Date.now()
    console.log(`search index built (in-memory): ${entries.length} entries`)
  }
}

/**
 * Get the current search entries for IPC serialization.
 * FTS5 mode: returns null (workers read from the shared DB file directly).
 * Fallback mode: returns the in-memory array.
 * @returns {Array<{id: string, name: string, type: string}>|null}
 */
export function getEntries() {
  if (_useFts) return null // no IPC needed — workers read from WAL DB
  return _searchEntries
}

/**
 * Load pre-built search entries from IPC (Phase 0.3: primary relay).
 * FTS5 mode: no-op (each worker reads from the shared DB file).
 * Fallback mode: replaces in-memory array.
 * @param {Array<{id: string, name: string, type: string}>|null} entries
 */
export function loadEntries(entries) {
  if (_useFts) return // no-op — DB is shared via WAL
  _searchEntries = entries || []
  _searchLastBuild = Date.now()
}

/**
 * Get stats about the current search index.
 * @returns {{ size: number, lastBuild: number }}
 */
export function getStats() {
  if (_useFts && _db) {
    try {
      const sizeRow = _stmtMetaSize.get()
      const buildRow = _stmtMetaBuild.get()
      return {
        size: sizeRow ? parseInt(sizeRow.value, 10) : 0,
        lastBuild: buildRow ? parseInt(buildRow.value, 10) : _searchLastBuild
      }
    } catch {
      return { size: 0, lastBuild: _searchLastBuild }
    }
  }
  return { size: _searchEntries.length, lastBuild: _searchLastBuild }
}

/**
 * Whether the store is using FTS5 (true) or in-memory fallback (false).
 * @returns {boolean}
 */
export function isFts() {
  return _useFts
}

/**
 * Close the SQLite database connection (for graceful shutdown).
 */
export function close() {
  if (_db) {
    try { _db.close() } catch {}
    _db = null
  }
}
