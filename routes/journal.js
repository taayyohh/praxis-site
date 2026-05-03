// Journal routes — encrypted journal CRUD + bookmarks
import { readFileSync, existsSync, readdirSync, unlinkSync, renameSync, statSync, mkdirSync } from 'fs'
import { readdir as readdirAsync, stat as statAsync, readFile as readFileAsync, writeFile as writeFileAsync } from 'fs/promises'
import { join } from 'path'
import { JournalKeySchema, JournalPostSchema, JournalPutSchema, JournalPatchSchema, BookmarksPutSchema, validate } from '../lib/schemas.js'

/** @param {object} ctx @returns {Promise<boolean>} */
export async function handleJournal(ctx) {
  const { req, res, url, path, method,
    json, body, getSession, encryptEntry, decryptEntry,
    JOURNAL_DIR, siteDir } = ctx

  function parseJson(raw) { try { return JSON.parse(raw) } catch { return null } }

  // journal key — wallet-auth only, stores AES key on session
  if (path === '/api/journal-key' && method === 'POST') {
    const session = getSession(req)
    if (!session) { json(res, { error: 'wallet auth required for journal' }, 403); return true }
    const raw = parseJson(await body(req))
    const v = validate(JournalKeySchema, raw)
    if (v.error) { json(res, { error: v.error }, v.status); return true }
    session.journalKey = v.data.key
    ctx._persistSessions()
    json(res, { ok: true }); return true
  }

  // journal CRUD — requires journalKey on session
  if (path === '/api/journal' && method === 'GET') {
    const session = getSession(req)
    if (!session?.journalKey) { json(res, { error: 'journal locked' }, 403); return true }
    if (!existsSync(JOURNAL_DIR)) { json(res, { items: [], archived: [], total: 0, page: 1 }); return true }
    try {
      const showArchived = url.searchParams.get('archived') === '1'
      const dirFiles = await readdirAsync(JOURNAL_DIR)
      const allFiles = dirFiles.filter(f => showArchived ? f.endsWith('.enc.archived') : (f.endsWith('.enc') && !f.endsWith('.enc.archived'))).sort().reverse()
      const page = Math.max(1, parseInt(url.searchParams.get('page')) || 1)
      const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit')) || 20))
      const start = (page - 1) * limit
      const pageFiles = allFiles.slice(start, start + limit)
      const entries = await Promise.all(pageFiles.map(async f => {
        const fp = join(JOURNAL_DIR, f)
        const st = await statAsync(fp)
        const name = f.replace('.enc.archived', '').replace('.enc', '')
        return { file: name, size: st.size, modified: st.mtime.toISOString(), archived: f.endsWith('.archived') }
      }))
      json(res, { items: entries, total: allFiles.length, page }); return true
    } catch { json(res, { items: [], total: 0, page: 1 }); return true }
  }

  if (path.startsWith('/api/journal/') && method === 'GET') {
    const session = getSession(req)
    if (!session?.journalKey) { json(res, { error: 'journal locked' }, 403); return true }
    const file = decodeURIComponent(path.slice('/api/journal/'.length))
    const safe = file.replace(/[^a-z0-9-]/g, '')
    const filePath = join(JOURNAL_DIR, `${safe}.enc`)
    if (!existsSync(filePath)) { json(res, { error: 'not found' }, 404); return true }
    try {
      const raw = await readFileAsync(filePath, 'utf8')
      const content = decryptEntry(raw, session.journalKey)
      json(res, { file: safe, content }); return true
    } catch { json(res, { file: safe, content: '[decryption failed]' }); return true }
  }

  if (path === '/api/journal' && method === 'POST') {
    const session = getSession(req)
    if (!session?.journalKey) { json(res, { error: 'journal locked' }, 403); return true }
    const raw = parseJson(await body(req))
    const v = validate(JournalPostSchema, raw)
    if (v.error) { json(res, { error: v.error }, v.status); return true }
    const data = v.data
    const safe = data.filename.replace(/[^a-z0-9-]/g, '')
    if (!safe) { json(res, { error: 'invalid filename' }, 400); return true }
    if (!existsSync(JOURNAL_DIR)) mkdirSync(JOURNAL_DIR, { recursive: true })
    const encrypted = encryptEntry(data.content, session.journalKey)
    await writeFileAsync(join(JOURNAL_DIR, `${safe}.enc`), encrypted)
    json(res, { ok: true, file: safe }); return true
  }

  if (path.startsWith('/api/journal/') && method === 'PUT') {
    const session = getSession(req)
    if (!session?.journalKey) { json(res, { error: 'journal locked' }, 403); return true }
    const file = decodeURIComponent(path.slice('/api/journal/'.length))
    const safe = file.replace(/[^a-z0-9-]/g, '')
    const filePath = join(JOURNAL_DIR, `${safe}.enc`)
    if (!existsSync(filePath)) { json(res, { error: 'not found' }, 404); return true }
    const raw = parseJson(await body(req))
    const v = validate(JournalPutSchema, raw)
    if (v.error) { json(res, { error: v.error }, v.status); return true }
    const encrypted = encryptEntry(v.data.content, session.journalKey)
    await writeFileAsync(filePath, encrypted)
    json(res, { ok: true }); return true
  }

  if (path.startsWith('/api/journal/') && method === 'PATCH') {
    const session = getSession(req)
    if (!session?.journalKey) { json(res, { error: 'journal locked' }, 403); return true }
    const file = decodeURIComponent(path.slice('/api/journal/'.length))
    const safe = file.replace(/[^a-z0-9-]/g, '')
    const raw = parseJson(await body(req))
    const v = validate(JournalPatchSchema, raw)
    if (v.error) { json(res, { error: v.error }, v.status); return true }
    const activePath = join(JOURNAL_DIR, `${safe}.enc`)
    const archivedPath = join(JOURNAL_DIR, `${safe}.enc.archived`)
    if (v.data.archived) {
      if (existsSync(activePath)) renameSync(activePath, archivedPath)
      json(res, { ok: true, archived: true }); return true
    } else {
      if (existsSync(archivedPath)) renameSync(archivedPath, activePath)
      json(res, { ok: true, archived: false }); return true
    }
  }

  if (path.startsWith('/api/journal/') && method === 'DELETE') {
    const session = getSession(req)
    if (!session?.journalKey) { json(res, { error: 'journal locked' }, 403); return true }
    const file = decodeURIComponent(path.slice('/api/journal/'.length))
    const safe = file.replace(/[^a-z0-9-]/g, '')
    const archivedPath = join(JOURNAL_DIR, `${safe}.enc.archived`)
    if (!existsSync(archivedPath)) { json(res, { error: 'only archived entries can be deleted' }, 400); return true }
    unlinkSync(archivedPath)
    json(res, { ok: true }); return true
  }

  // --- Bookmarks (encrypted, same pattern as journal) ---
  if (path === '/api/bookmarks' && method === 'GET') {
    const session = getSession(req)
    if (!session?.journalKey) { json(res, { error: 'bookmarks locked' }, 403); return true }
    const bookmarksPath = join(siteDir, 'bookmarks.enc')
    if (!existsSync(bookmarksPath)) { json(res, { data: null }); return true }
    try {
      const raw = await readFileAsync(bookmarksPath, 'utf8')
      const decrypted = decryptEntry(raw, session.journalKey)
      json(res, { data: decrypted }); return true
    } catch { json(res, { data: null }); return true }
  }

  if (path === '/api/bookmarks' && method === 'PUT') {
    const session = getSession(req)
    if (!session?.journalKey) { json(res, { error: 'bookmarks locked' }, 403); return true }
    const raw = parseJson(await body(req))
    const v = validate(BookmarksPutSchema, raw)
    if (v.error) { json(res, { error: v.error }, v.status); return true }
    const encrypted = encryptEntry(v.data.data, session.journalKey)
    const _bmPath = join(siteDir, 'bookmarks.enc')
    const _bmTmp = _bmPath + '.tmp'
    await writeFileAsync(_bmTmp, encrypted)
    renameSync(_bmTmp, _bmPath)
    json(res, { ok: true }); return true
  }

  return false
}
