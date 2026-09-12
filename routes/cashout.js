// Cashout order metadata — server-side persistence of the
// `depositId`s the browser sheet produced, so a cleared cache or new
// device doesn't strand an in-flight order. The depositId is public
// on-chain (Peer's escrow) so we don't encrypt; the small privacy
// gain isn't worth the ceremony. Auth-gated per session.
//
// Shape:
//   [
//     { depositId, platform, amountFiat, currency, createdAt },
//     …
//   ]
// Capped at 100 rows per wallet — anything beyond that is ancient and
// the client should look at Peer's own list via `orders(owner)`.

import { existsSync, renameSync } from 'fs'
import { readFile as readFileAsync, writeFile as writeFileAsync } from 'fs/promises'
import { join } from 'path'

const MAX_ROWS = 100

/** @param {object} ctx @returns {Promise<boolean>} */
export async function handleCashout(ctx) {
  const { req, res, path, method, json, body, getSession, siteDir } = ctx
  if (!path.startsWith('/api/cashout')) return false

  function parseJson(raw) { try { return JSON.parse(raw) } catch { return null } }

  if (path === '/api/cashout/orders' && method === 'GET') {
    const session = getSession(req)
    if (!session) { json(res, { error: 'unauthorized' }, 401); return true }
    const ordersPath = join(siteDir, `cashout-orders-${session.addr.toLowerCase()}.json`)
    if (!existsSync(ordersPath)) { json(res, { orders: [] }); return true }
    try {
      const raw = await readFileAsync(ordersPath, 'utf8')
      const arr = JSON.parse(raw)
      json(res, { orders: Array.isArray(arr) ? arr : [] }); return true
    } catch { json(res, { orders: [] }); return true }
  }

  if (path === '/api/cashout/orders' && method === 'DELETE') {
    // Prune a known-terminal (delivered/returned) order so the resume
    // fallback stops treating it as pending. Body: { depositId }.
    const session = getSession(req)
    if (!session) { json(res, { error: 'unauthorized' }, 401); return true }
    const parsed = parseJson(await body(req))
    if (!parsed || typeof parsed.depositId !== 'string') {
      json(res, { error: 'depositId required' }, 400); return true
    }
    const ordersPath = join(siteDir, `cashout-orders-${session.addr.toLowerCase()}.json`)
    let existing = []
    try { existing = JSON.parse(await readFileAsync(ordersPath, 'utf8')) } catch {}
    if (!Array.isArray(existing)) existing = []
    const before = existing.length
    existing = existing.filter(x => x.depositId !== parsed.depositId)
    if (existing.length === before) { json(res, { ok: true, count: existing.length }); return true }
    const tmp = ordersPath + '.tmp'
    await writeFileAsync(tmp, JSON.stringify(existing))
    renameSync(tmp, ordersPath)
    json(res, { ok: true, count: existing.length }); return true
  }

  if (path === '/api/cashout/orders' && method === 'POST') {
    const session = getSession(req)
    if (!session) { json(res, { error: 'unauthorized' }, 401); return true }
    const parsed = parseJson(await body(req))
    if (!parsed || typeof parsed.depositId !== 'string' || parsed.depositId.length > 200) {
      json(res, { error: 'valid depositId required' }, 400); return true
    }
    const rec = {
      depositId: String(parsed.depositId).slice(0, 200),
      platform: String(parsed.platform || '').slice(0, 40),
      amountFiat: Number.isFinite(parsed.amountFiat) ? Number(parsed.amountFiat) : null,
      currency: String(parsed.currency || 'USD').slice(0, 8).toUpperCase(),
      createdAt: Date.now(),
    }
    const ordersPath = join(siteDir, `cashout-orders-${session.addr.toLowerCase()}.json`)
    let existing = []
    try { existing = JSON.parse(await readFileAsync(ordersPath, 'utf8')) } catch {}
    if (!Array.isArray(existing)) existing = []
    // De-dupe by depositId (same order posted twice on retry).
    existing = existing.filter(x => x.depositId !== rec.depositId)
    existing.push(rec)
    if (existing.length > MAX_ROWS) existing = existing.slice(-MAX_ROWS)
    const tmp = ordersPath + '.tmp'
    await writeFileAsync(tmp, JSON.stringify(existing))
    renameSync(tmp, ordersPath)
    json(res, { ok: true, count: existing.length }); return true
  }

  return false
}
