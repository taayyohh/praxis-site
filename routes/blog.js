// Blog routes — CRUD for markdown blog posts + reading list
import { writeFileSync, existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { BlogPostSchema, BlogPutSchema, ReadingPutSchema, validate } from '../lib/schemas.js'

/** @param {object} ctx @returns {Promise<boolean>} */
export async function handleBlog(ctx) {
  const { req, res, path, method,
    json, body, rebuild,
    ROOT, siteDir, _blogListingCache } = ctx

  function parseJson(raw) { try { return JSON.parse(raw) } catch { return null } }

  if (path === '/api/blog' && method === 'POST') {
    const raw = parseJson(await body(req))
    const v = validate(BlogPostSchema, raw)
    if (v.error) { json(res, { error: v.error }, v.status); return true }
    const { filename, content } = v.data
    const safe = filename.replace(/[^a-z0-9A-Z._-]/g, '')
    if (!safe || safe.includes('..')) { json(res, { error: 'invalid filename' }, 400); return true }
    writeFileSync(join(ROOT, 'content/blog', safe), content)
    for (const k of _blogListingCache.keys()) { if (k.startsWith(siteDir + ':')) _blogListingCache.delete(k) }
    await rebuild()
    json(res, { ok: true }); return true
  }

  if (path.startsWith('/api/blog/') && method === 'PUT') {
    const filename = decodeURIComponent(path.slice('/api/blog/'.length))
    const safe = filename.replace(/[^a-z0-9A-Z._-]/g, '')
    if (!safe || safe.includes('..')) { json(res, { error: 'invalid filename' }, 400); return true }
    const putRaw = parseJson(await body(req))
    const v = validate(BlogPutSchema, putRaw)
    if (v.error) { json(res, { error: v.error }, v.status); return true }
    const { content } = v.data
    writeFileSync(join(ROOT, 'content/blog', safe), content)
    for (const k of _blogListingCache.keys()) { if (k.startsWith(siteDir + ':')) _blogListingCache.delete(k) }
    await rebuild()
    json(res, { ok: true }); return true
  }

  if (path.startsWith('/api/blog/') && method === 'DELETE') {
    const filename = decodeURIComponent(path.slice('/api/blog/'.length))
    const safe = filename.replace(/[^a-z0-9A-Z._-]/g, '')
    if (!safe || safe.includes('..')) { json(res, { error: 'invalid filename' }, 400); return true }
    const fp = join(ROOT, 'content/blog', safe)
    if (existsSync(fp)) unlinkSync(fp)
    for (const k of _blogListingCache.keys()) { if (k.startsWith(siteDir + ':')) _blogListingCache.delete(k) }
    await rebuild()
    json(res, { ok: true }); return true
  }

  // reading list
  if (path === '/api/reading' && method === 'PUT') {
    const raw = parseJson(await body(req))
    const v = validate(ReadingPutSchema, raw)
    if (v.error) { json(res, { error: v.error }, v.status); return true }
    const data = v.data
    const readingFp = join(ROOT, 'content/reading/list.json')
    writeFileSync(readingFp, JSON.stringify(data, null, 2))
    ctx._readingListCache.delete(readingFp)
    await rebuild()
    json(res, { ok: true }); return true
  }

  // manual rebuild
  if (path === '/api/build' && method === 'POST') {
    await rebuild()
    json(res, { ok: true }); return true
  }

  return false
}
