import { readdir, stat as fsStat, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import Database from 'better-sqlite3'

// --- SQLite backend (source of truth when DB exists) ---

let _db = null
function getDb() {
  if (_db) return _db
  const dbPath = process.env.STATE_DB || '/data/orchestrator/state.db'
  if (!existsSync(dbPath)) return null
  try {
    _db = new Database(dbPath, { readonly: true, fileMustExist: true })
    _db.pragma('journal_mode = WAL')
  } catch {
    _db = null
  }
  return _db
}

function useSqlite() {
  if (process.env.INDEX_STORE_BACKEND === 'sqlite') return !!getDb()
  return !!getDb()
}

// --- TTL cache (60s) layered over SQLite ---

const CACHE_TTL = 60_000
const _domainCache = new Map()   // domain -> { value, ts }
const _walletCache = new Map()   // lowercase wallet -> { value, ts }
const _handleCache = new Map()   // handle -> { value, ts }

function cacheGet(map, key) {
  const entry = map.get(key)
  if (!entry) return undefined
  if (Date.now() - entry.ts > CACHE_TTL) {
    map.delete(key)
    return undefined
  }
  return entry.value
}

function cacheSet(map, key, value) {
  // Bound cache to 10K entries with simple eviction
  if (map.size >= 10_000) {
    const firstKey = map.keys().next().value
    map.delete(firstKey)
  }
  map.set(key, { value, ts: Date.now() })
}

function cacheClear() {
  _domainCache.clear()
  _walletCache.clear()
  _handleCache.clear()
}

// --- Prepared statements (lazily created, reused) ---

let _stmtDomain = null
let _stmtWallet = null
let _stmtHandle = null
let _stmtAllDomains = null
let _stmtCount = null
let _stmtHasDomain = null
let _stmtAllWallets = null
let _stmtAll = null

function stmtDomain() {
  if (!_stmtDomain) _stmtDomain = getDb().prepare("SELECT handle FROM artists WHERE domain = ? AND status = 'live'")
  return _stmtDomain
}
function stmtWallet() {
  if (!_stmtWallet) _stmtWallet = getDb().prepare("SELECT handle FROM artists WHERE wallet = ? COLLATE NOCASE AND status = 'live'")
  return _stmtWallet
}
function stmtHandle() {
  if (!_stmtHandle) _stmtHandle = getDb().prepare("SELECT domain FROM artists WHERE handle = ? AND status = 'live'")
  return _stmtHandle
}
function stmtAllDomains() {
  if (!_stmtAllDomains) _stmtAllDomains = getDb().prepare("SELECT domain FROM artists WHERE domain IS NOT NULL AND domain != '' AND status = 'live'")
  return _stmtAllDomains
}
function stmtCount() {
  if (!_stmtCount) _stmtCount = getDb().prepare("SELECT COUNT(*) as c FROM artists WHERE domain IS NOT NULL AND domain != '' AND status = 'live'")
  return _stmtCount
}
function stmtHasDomain() {
  if (!_stmtHasDomain) _stmtHasDomain = getDb().prepare("SELECT 1 FROM artists WHERE domain = ? AND status = 'live'")
  return _stmtHasDomain
}
function stmtAllWallets() {
  if (!_stmtAllWallets) _stmtAllWallets = getDb().prepare("SELECT wallet FROM artists WHERE status = 'live'")
  return _stmtAllWallets
}
function stmtAll() {
  if (!_stmtAll) _stmtAll = getDb().prepare("SELECT wallet, handle, domain FROM artists WHERE status = 'live'")
  return _stmtAll
}

// --- In-memory Maps (legacy fallback) ---

const _domainIndex = new Map() // domain -> handle
const _siteJsonMtime = new Map() // handle -> mtimeMs
const _handleToDomain = new Map() // handle -> domain
const _walletIndex = new Map() // lowercase wallet -> handle
let _domainIndexBuilding = false
let _domainIndexReady = false

// --- Public API ---

export function resolveDomain(domain) {
  if (useSqlite()) {
    const cached = cacheGet(_domainCache, domain)
    if (cached !== undefined) return cached
    try {
      const row = stmtDomain().get(domain)
      const result = row ? row.handle : null
      cacheSet(_domainCache, domain, result)
      return result
    } catch { return null }
  }
  return _domainIndex.get(domain) || null
}

export function resolveWallet(wallet) {
  if (!wallet) return null
  const wl = wallet.toLowerCase()
  if (useSqlite()) {
    const cached = cacheGet(_walletCache, wl)
    if (cached !== undefined) return cached
    try {
      const row = stmtWallet().get(wl)
      const result = row ? row.handle : null
      cacheSet(_walletCache, wl, result)
      return result
    } catch { return null }
  }
  return _walletIndex.get(wl) || null
}

export function resolveHandle(handle) {
  if (useSqlite()) {
    const cached = cacheGet(_handleCache, handle)
    if (cached !== undefined) return cached
    try {
      const row = stmtHandle().get(handle)
      const result = row ? row.domain : null
      cacheSet(_handleCache, handle, result)
      return result
    } catch { return null }
  }
  return _handleToDomain.get(handle) || null
}

export function setArtist(handle, { domain, wallet }) {
  // Always update in-memory Maps (needed for IPC snapshots + fallback)
  const prevDomain = _handleToDomain.get(handle)
  if (prevDomain && prevDomain !== domain) _domainIndex.delete(prevDomain)
  if (domain) {
    _domainIndex.set(domain, handle)
    _handleToDomain.set(handle, domain)
  } else if (prevDomain) {
    _domainIndex.delete(prevDomain)
    _handleToDomain.delete(handle)
  }
  if (wallet) {
    const wl = wallet.toLowerCase()
    for (const [w, h] of _walletIndex) { if (h === handle && w !== wl) { _walletIndex.delete(w); break } }
    _walletIndex.set(wl, handle)
  }
  // Invalidate SQLite caches for this artist
  if (domain) { _domainCache.delete(domain); if (prevDomain && prevDomain !== domain) _domainCache.delete(prevDomain) }
  if (handle) _handleCache.delete(handle)
  if (wallet) _walletCache.delete(wallet.toLowerCase())
}

export function removeArtist(handle) {
  const prevDomain = _handleToDomain.get(handle)
  if (prevDomain) { _domainIndex.delete(prevDomain); _domainCache.delete(prevDomain) }
  _handleToDomain.delete(handle)
  _siteJsonMtime.delete(handle)
  _handleCache.delete(handle)
  for (const [w, h] of _walletIndex) {
    if (h === handle) {
      _walletIndex.delete(w)
      _walletCache.delete(w)
    }
  }
}

export function getAllDomains() {
  if (useSqlite()) {
    try {
      return stmtAllDomains().all().map(r => r.domain)
    } catch { /* fall through */ }
  }
  return Array.from(_domainIndex.keys())
}

export function size() {
  if (useSqlite()) {
    try {
      return stmtCount().get().c
    } catch { /* fall through */ }
  }
  return _domainIndex.size
}

export function isReady() {
  if (useSqlite()) return true
  return _domainIndexReady
}

export function hasDomain(domain) {
  if (useSqlite()) {
    // Check cache first
    const cached = cacheGet(_domainCache, domain)
    if (cached !== undefined) return cached !== null
    try {
      const row = stmtHasDomain().get(domain)
      return !!row
    } catch { /* fall through */ }
  }
  return _domainIndex.has(domain)
}

export function getAllWalletKeys() {
  if (useSqlite()) {
    try {
      return stmtAllWallets().all().map(r => r.wallet.toLowerCase())
    } catch { /* fall through */ }
  }
  return Array.from(_walletIndex.keys())
}

export async function rebuildIndex(artistsDir) {
  if (useSqlite()) {
    // SQLite IS the index — just clear caches so next read gets fresh data
    cacheClear()
    // Invalidate prepared statements in case DB schema changed
    _stmtDomain = _stmtWallet = _stmtHandle = _stmtAllDomains = null
    _stmtCount = _stmtHasDomain = _stmtAllWallets = _stmtAll = null
    _domainIndexReady = true
    return
  }
  // Legacy filesystem scan
  if (_domainIndexBuilding) return
  _domainIndexBuilding = true
  try {
    const handles = await readdir(artistsDir)
    const seen = new Set()
    let changed = 0
    for (const handle of handles) {
      seen.add(handle)
      const siteJsonPath = join(artistsDir, handle, 'site.json')
      try {
        const st = await fsStat(siteJsonPath)
        const prevMtime = _siteJsonMtime.get(handle)
        if (prevMtime === st.mtimeMs) continue
        const raw = await readFile(siteJsonPath, 'utf8')
        const data = JSON.parse(raw)
        setArtist(handle, { domain: data.domain, wallet: data.wallet })
        _siteJsonMtime.set(handle, st.mtimeMs)
        changed++
      } catch {}
    }
    for (const handle of Array.from(_siteJsonMtime.keys())) {
      if (!seen.has(handle)) {
        removeArtist(handle)
      }
    }
    _domainIndexReady = true
    if (changed > 0) console.log(`domain index updated: ${changed} changed, ${_domainIndex.size} total`)
  } catch (e) { console.error('domain index build failed:', e.message) }
  _domainIndexBuilding = false
}

export function getIndex() {
  if (useSqlite()) {
    // Build snapshot from SQLite for IPC to workers
    const domainIndex = {}
    const walletIndex = {}
    try {
      const rows = stmtAll().all()
      for (const row of rows) {
        if (row.domain) domainIndex[row.domain] = row.handle
        if (row.wallet) walletIndex[row.wallet.toLowerCase()] = row.handle
      }
    } catch { /* fall through to in-memory */ }
    return { domainIndex, walletIndex }
  }
  return {
    domainIndex: Object.fromEntries(_domainIndex),
    walletIndex: Object.fromEntries(_walletIndex)
  }
}

export function loadIndex({ domainIndex, walletIndex }) {
  // Workers receiving IPC snapshot — populate in-memory Maps
  _domainIndex.clear()
  _walletIndex.clear()
  _handleToDomain.clear()
  for (const [domain, handle] of Object.entries(domainIndex)) {
    _domainIndex.set(domain, handle)
    _handleToDomain.set(handle, domain)
  }
  for (const [wallet, handle] of Object.entries(walletIndex)) {
    _walletIndex.set(wallet, handle)
  }
  _domainIndexReady = true
}
