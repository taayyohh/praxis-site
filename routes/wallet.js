// Wallet routes — store, retrieve, link, links, restore-token (cross-Praxis sign-in)
import { existsSync, mkdirSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { createHmac, randomBytes, createHash } from 'crypto'
import { WalletStoreSchema, WalletRetrieveSchema, WalletRestoreTokenSchema, WalletLinkSchema, validate } from '../lib/schemas.js'

// HMAC secret for cross-Praxis restore tokens. MUST be set via env so every
// process (the praxis-on-ourpraxis.network process that ISSUES tokens, and
// the multi-tenant + per-artist-container processes that VERIFY them) shares
// the same value. A per-process random fallback is correct in dev but breaks
// cross-process verification in production — the bridge issues a token
// signed with secret A, the destination tries to verify with secret B, the
// HMAC mismatches, and cross-Praxis sign-in silently fails.
//
// In production we hard-fail at startup if the env var is missing so this
// can never silently regress. In NODE_ENV=development a random secret is
// generated for convenience.
let RESTORE_TOKEN_SECRET = process.env.RESTORE_TOKEN_SECRET
if (!RESTORE_TOKEN_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: RESTORE_TOKEN_SECRET must be set in production env (cross-Praxis sign-in requires it). Add to /root/praxis/.env and restart pm2 with --update-env.')
    process.exit(1)
  }
  RESTORE_TOKEN_SECRET = randomBytes(32).toString('hex')
  console.warn('[wallet] RESTORE_TOKEN_SECRET not set — using ephemeral dev secret. Cross-Praxis sign-in will not work across processes.')
}
const RESTORE_TOKEN_TTL_MS = 60 * 1000 // 60 seconds

function hashIp(ip) {
  return createHash('sha256').update(String(ip || '')).digest('hex').slice(0, 16)
}

function issueRestoreToken(address, ip) {
  const ts = Date.now()
  const ipHash = hashIp(ip)
  const payload = `${ts}.${address.toLowerCase()}.${ipHash}`
  const sig = createHmac('sha256', RESTORE_TOKEN_SECRET).update(payload).digest('hex').slice(0, 32)
  return `${payload}.${sig}`
}

function verifyRestoreToken(token, expectedAddress, ip) {
  if (typeof token !== 'string') return { ok: false, reason: 'no token' }
  const parts = token.split('.')
  if (parts.length !== 4) return { ok: false, reason: 'malformed' }
  const [tsStr, addr, ipHash, sig] = parts
  const ts = parseInt(tsStr, 10)
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad ts' }
  if (Date.now() - ts > RESTORE_TOKEN_TTL_MS) return { ok: false, reason: 'expired' }
  if (Date.now() - ts < -5000) return { ok: false, reason: 'future ts' }
  if (addr !== expectedAddress.toLowerCase()) return { ok: false, reason: 'address mismatch' }
  // IP binding: token can only be redeemed from the same IP that requested it
  if (ipHash !== hashIp(ip)) return { ok: false, reason: 'ip mismatch' }
  // Re-derive HMAC and constant-time compare
  const expected = createHmac('sha256', RESTORE_TOKEN_SECRET).update(`${tsStr}.${addr}.${ipHash}`).digest('hex').slice(0, 32)
  if (sig.length !== expected.length) return { ok: false, reason: 'sig length' }
  let diff = 0
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i)
  if (diff !== 0) return { ok: false, reason: 'sig mismatch' }
  return { ok: true }
}

/** @param {object} ctx @returns {Promise<boolean>} */
export async function handleWallet(ctx) {
  const { req, res, path, method, clientIp,
    json, parseBody, rateLimit, siteDir,
    ARTISTS_DIR, getSession, loadWalletLinks, saveWalletLinks, getWalletLinkEntry, _resolveCache } = ctx

  const SHARED_WALLET_DIR = join(ARTISTS_DIR, '..', 'wallet-backups')

  if (path === '/api/wallet/store' && method === 'POST') {
    if (rateLimit(clientIp, 'wallet-store', 5)) { json(res, { error: 'too many requests' }, 429); return true }
    try {
      const raw = await parseBody(req, 10 * 1024)
      const v = validate(WalletStoreSchema, raw)
      if (v.error) { json(res, { error: v.error }, v.status); return true }
      const data = v.data
      try {
        const parsed = JSON.parse(data.encrypted)
        if (!parsed.salt || !parsed.iv || !parsed.ct) {
          json(res, { error: 'invalid encrypted data format' }, 400); return true
        }
      } catch {
        json(res, { error: 'encrypted must be valid JSON' }, 400); return true
      }
      const filename = data.address.toLowerCase().replace(/[^0-9a-fx]/g, '') + '.json'
      const existingSharedPath = join(SHARED_WALLET_DIR, filename)
      if (existsSync(existingSharedPath)) {
        const session = getSession(req)
        if (!session?.wallet || session.wallet.toLowerCase() !== data.address.toLowerCase()) {
          json(res, { error: 'auth required to overwrite existing backup' }, 403); return true
        }
        try {
          const existing = JSON.parse(await readFile(existingSharedPath, 'utf8'))
          const existingParsed = JSON.parse(existing.encrypted)
          const newParsed = JSON.parse(data.encrypted)
          if (existingParsed.iv === newParsed.iv) {
            json(res, { error: 'backup unchanged (identical iv), re-encrypt before storing' }, 409); return true
          }
        } catch {}
      }
      const backupData = JSON.stringify({
        address: data.address.toLowerCase(),
        encrypted: data.encrypted,
        storedAt: new Date().toISOString(),
      })
      const walletDir = join(siteDir, 'wallet-backups')
      mkdirSync(walletDir, { recursive: true })
      await writeFile(join(walletDir, filename), backupData)
      mkdirSync(SHARED_WALLET_DIR, { recursive: true })
      await writeFile(join(SHARED_WALLET_DIR, filename), backupData)
      json(res, { ok: true }); return true
    } catch (e) {
      json(res, { error: e.message }, 500); return true
    }
  }

  if (path === '/api/wallet/retrieve' && method === 'POST') {
    if (rateLimit(clientIp, 'wallet-retrieve', 3)) { json(res, { error: 'too many requests' }, 429); return true }
    // Daily cap: max 20 retrievals per IP per day (all auth modes)
    const dayKey = `wallet-retrieve-day:${clientIp}`
    const now = Date.now()
    if (!handleWallet._dailyCaps) handleWallet._dailyCaps = new Map()
    const dc = handleWallet._dailyCaps
    const entry = dc.get(dayKey)
    if (entry && now - entry.start < 86400000) {
      if (entry.count >= 20) { json(res, { error: 'daily retrieval limit exceeded' }, 429); return true }
      entry.count++
    } else {
      dc.set(dayKey, { start: now, count: 1 })
    }
    // Evict stale daily cap entries
    if (dc.size > 50000) { for (const [k, v] of dc) { if (now - v.start >= 86400000) dc.delete(k); if (dc.size <= 25000) break } }
    try {
      const raw = await parseBody(req)
      const v = validate(WalletRetrieveSchema, raw)
      if (v.error) { json(res, { error: v.error }, v.status); return true }
      const data = v.data
      const addrLc = data.address.toLowerCase()

      // Three auth modes:
      // (a) Restore token issued by /api/wallet/restore-token via the bridge
      //     iframe. Used by cross-Praxis sign-in.
      // (b) Signed challenge `praxis-retrieve:<address>:<ts>`. Used by callers
      //     that already have the wallet's private key (refresh backup).
      // (c) Address-only (no signature, no token). The user is trying to sign
      //     in for the first time — they don't have a key yet, the whole point
      //     of this endpoint is to give them their encrypted blob so they can
      //     decrypt it with their password. Security relies on:
      //     - Rate limiting: 3/min + 5/day per IP for address-only (enforced above + below)
      //     - AES-256-GCM encryption: the blob is useless without the password
      //     - The password IS the auth — no separate key exists
      //     The H3 audit added a signature gate that broke ALL sign-in flows
      //     because users can't sign without the key they're trying to download.
      let authMode = 'address-only' // default — rate-limited but allowed
      if (data.restoreToken) {
        const result = verifyRestoreToken(data.restoreToken, addrLc, clientIp)
        if (!result.ok) {
          json(res, { error: `invalid restore token: ${result.reason}` }, 401); return true
        }
        authMode = 'token'
      } else if (data.message && data.signature) {
        const expectedPrefix = `praxis-retrieve:${addrLc}:`
        if (!data.message.startsWith(expectedPrefix)) {
          json(res, { error: 'invalid challenge message' }, 401); return true
        }
        const tsStr = data.message.slice(expectedPrefix.length)
        const ts = parseInt(tsStr, 10)
        if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 5 * 60 * 1000) {
          json(res, { error: 'challenge expired' }, 401); return true
        }
        try {
          const { verifyMessage } = await import('viem')
          const ok = await verifyMessage({ address: addrLc, message: data.message, signature: data.signature })
          if (!ok) { json(res, { error: 'invalid signature' }, 401); return true }
        } catch {
          json(res, { error: 'signature verification failed' }, 401); return true
        }
        authMode = 'signature'
      }
      // Mode (c): no auth fields → address-only, proceed with rate-limited blob fetch
      // Stricter daily cap for address-only: 5/day per IP (harvesting protection)
      if (authMode === 'address-only') {
        const aoKey = `wallet-retrieve-ao:${clientIp}`
        const aoEntry = dc.get(aoKey)
        if (aoEntry && now - aoEntry.start < 86400000) {
          if (aoEntry.count >= 5) { json(res, { error: 'daily retrieval limit exceeded' }, 429); return true }
          aoEntry.count++
        } else {
          dc.set(aoKey, { start: now, count: 1 })
        }
      }

      const filename = addrLc.replace(/[^0-9a-fx]/g, '') + '.json'
      const perSitePath = join(siteDir, 'wallet-backups', filename)
      const sharedPath = join(SHARED_WALLET_DIR, filename)
      const filepath = existsSync(perSitePath) ? perSitePath : existsSync(sharedPath) ? sharedPath : null
      if (!filepath) { json(res, { encrypted: null, authMode }); return true }
      const backup = JSON.parse(await readFile(filepath, 'utf8'))
      json(res, { encrypted: backup.encrypted, authMode }); return true
    } catch (e) {
      json(res, { error: e.message }, 500); return true
    }
  }

  // /api/wallet/restore-token — issue a short-lived HMAC token used by the
  // wallet-bridge iframe to authorize a cross-Praxis wallet restore. Strict
  // origin check (Origin header must be ourpraxis.network or a known Praxis
  // host) + per-IP rate limit make this bot-resistant. The token is bound to
  // the requesting IP, so an attacker who steals it from one network can't
  // use it from another.
  if (path === '/api/wallet/restore-token' && method === 'POST') {
    if (rateLimit(clientIp, 'wallet-restore-token', 5)) {
      json(res, { error: 'too many requests' }, 429); return true
    }
    // Strict origin check: only requests from the wallet-bridge (which lives
    // on ourpraxis.network) may issue tokens. The bridge has its own JS-level
    // origin allowlist that only proxies postMessages from Praxis-owned
    // parents, so this server-side check is the second layer.
    const origin = req.headers['origin'] || ''
    let originHost = ''
    try { originHost = new URL(origin).hostname.toLowerCase() } catch {}
    const isOurpraxis = originHost === 'ourpraxis.network' || originHost.endsWith('.ourpraxis.network')
    if (!isOurpraxis) {
      json(res, { error: 'restore tokens only available to the praxis bridge' }, 403); return true
    }
    try {
      const raw = await parseBody(req, 1024)
      const v = validate(WalletRestoreTokenSchema, raw)
      if (v.error) { json(res, { error: v.error }, v.status); return true }
      const token = issueRestoreToken(v.data.address, clientIp)
      json(res, { token, expiresInMs: RESTORE_TOKEN_TTL_MS }); return true
    } catch (e) {
      json(res, { error: e.message }, 500); return true
    }
  }

  if (path === '/api/wallet/link' && method === 'POST') {
    if (rateLimit(clientIp, 'wallet-link', 5)) { json(res, { error: 'too many requests' }, 429); return true }
    try {
      const raw = await parseBody(req, 4096)
      const v = validate(WalletLinkSchema, raw)
      if (v.error) { json(res, { error: v.error }, v.status); return true }
      const { primary, secondary, primarySig, secondarySig } = v.data
      if (primary.toLowerCase() === secondary.toLowerCase()) {
        json(res, { error: 'cannot link wallet to itself' }, 400); return true
      }
      const session = getSession(req)
      if (!session) { json(res, { error: 'wallet auth required' }, 401); return true }
      const sessionWallet = session.wallet?.toLowerCase()
      if (sessionWallet !== primary.toLowerCase() && sessionWallet !== secondary.toLowerCase()) {
        json(res, { error: 'authenticated wallet must be one of the linked wallets' }, 403); return true
      }
      const message = `link:${primary.toLowerCase()}:${secondary.toLowerCase()}`
      const { verifyMessage } = await import('viem')
      const primaryValid = await verifyMessage({ address: primary.toLowerCase(), message, signature: primarySig })
      if (!primaryValid) { json(res, { error: 'invalid primary signature' }, 401); return true }
      const secondaryValid = await verifyMessage({ address: secondary.toLowerCase(), message, signature: secondarySig })
      if (!secondaryValid) { json(res, { error: 'invalid secondary signature' }, 401); return true }
      const wl = await loadWalletLinks()
      const pKey = primary.toLowerCase()
      const sKey = secondary.toLowerCase()
      if (wl.reverse[sKey] && wl.reverse[sKey] !== pKey) {
        json(res, { error: 'secondary wallet already linked to another primary' }, 409); return true
      }
      if (wl.reverse[pKey]) {
        json(res, { error: 'primary wallet is already linked as a secondary' }, 409); return true
      }
      if (!wl.links[pKey]) wl.links[pKey] = []
      if (!wl.links[pKey].includes(sKey)) wl.links[pKey].push(sKey)
      wl.reverse[sKey] = pKey
      await saveWalletLinks(wl)
      _resolveCache.delete(sKey)
      json(res, { ok: true, primary: pKey, linked: wl.links[pKey] }); return true
    } catch (e) {
      json(res, { error: e.message }, 500); return true
    }
  }

  if (path === '/api/wallet/links' && method === 'GET') {
    if (rateLimit(clientIp, 'wallet-links', 30)) { json(res, { error: 'too many requests' }, 429); return true }
    try {
      const addr = ctx.url.searchParams.get('address')?.toLowerCase()
      if (!addr || !/^0x[0-9a-f]{40}$/.test(addr)) {
        json(res, { error: 'valid address required' }, 400); return true
      }
      const entry = await getWalletLinkEntry(addr)
      if (entry.links) {
        json(res, { primary: addr, linked: entry.links }); return true
      }
      if (entry.reverse) {
        const primary = entry.reverse
        const primaryEntry = await getWalletLinkEntry(primary)
        json(res, { primary, linked: primaryEntry.links || [] }); return true
      }
      json(res, { primary: null, linked: [] }); return true
    } catch (e) {
      json(res, { error: e.message }, 500); return true
    }
  }

  return false
}
