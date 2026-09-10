// Encrypted bookmark server-sync.
//
// The localStorage layer lives in utils.js (getBookmarks / saveBookmark /
// removeBookmark / isBookmarked). This module is the SERVER half:
//   - listens for `bookmarks-changed` (dispatched by utils.js and post.js)
//     and encrypts + PUTs the whole array to /api/bookmarks
//   - on `wallet-connected`, resets the derived key and re-runs the merge
//     sync so the new wallet's server copy is pulled in
//   - on `wallet-disconnected`, forgets the derived key
//
// Encryption: AES-GCM with a key derived from a personal_sign of
// `praxis:journal-key:v1:<addr>` (same ceremony as journal.js). The wire
// format is `${ivHex}:${ctHex}:${tagHex}` — spec 133 test 4 asserts this.
//
// This module used to live inline in feed.js. It was hoisted out so
// bookmarks sync from every route (post.js, library, collection, ...),
// not only routes that happen to load feed.js.

import { getWalletProvider, getAuthToken, getBookmarks } from './utils.js'

let _bookmarkToken = ''
let _bookmarkKeyDerived = false
let _bookmarkCryptoKey = null
let _bookmarkSyncing = false
let _listenersInstalled = false

function _bmHexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substr(i, 2), 16)
  return bytes
}
function _bmBytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function _bmEncrypt(plaintext) {
  if (!_bookmarkCryptoKey) throw new Error('bookmarks locked')
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const enc = new TextEncoder()
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, _bookmarkCryptoKey, enc.encode(plaintext))
  const cipherBytes = new Uint8Array(cipherBuf)
  const encrypted = cipherBytes.slice(0, -16)
  const tag = cipherBytes.slice(-16)
  return `${_bmBytesToHex(iv)}:${_bmBytesToHex(encrypted)}:${_bmBytesToHex(tag)}`
}

async function _bmDecrypt(data) {
  if (!_bookmarkCryptoKey) throw new Error('bookmarks locked')
  const [ivHex, encHex, tagHex] = data.split(':')
  const iv = _bmHexToBytes(ivHex)
  const encrypted = _bmHexToBytes(encHex)
  const tag = _bmHexToBytes(tagHex)
  const combined = new Uint8Array(encrypted.length + tag.length)
  combined.set(encrypted)
  combined.set(tag, encrypted.length)
  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, _bookmarkCryptoKey, combined)
  return new TextDecoder().decode(plainBuf)
}

function _localBookmarkKey() {
  const addr = window.getWalletAddress?.()?.toLowerCase()
  return addr ? `praxis:bookmarks:${addr}` : null
}

function _setLocalBookmarks(bookmarks) {
  const key = _localBookmarkKey()
  if (!key) return
  try { localStorage.setItem(key, JSON.stringify(bookmarks)) } catch {}
}

// Encrypt + PUT the bookmarks array to /api/bookmarks. No-op if we don't
// have a session token or a derived key yet — the caller doesn't need to
// coordinate; syncBookmarks() will drive the key derivation on next
// wallet-connected.
export async function pushBookmarks(bookmarks) {
  if (!_bookmarkToken || !_bookmarkKeyDerived || !_bookmarkCryptoKey) return
  try {
    const encrypted = await _bmEncrypt(JSON.stringify(bookmarks))
    await fetch('/api/bookmarks', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${_bookmarkToken}` },
      body: JSON.stringify({ data: encrypted }),
    })
  } catch { /* server push failed, localStorage still has the data */ }
}

// Sync bookmarks from server — called on wallet connect. Requires a
// wallet signature to derive the AES key (same ceremony as journal).
export async function syncBookmarks() {
  if (_bookmarkSyncing) return
  _bookmarkSyncing = true
  const addr = window.getWalletAddress?.()
  if (!addr || !getWalletProvider()) { _bookmarkSyncing = false; return }

  try {
    // authenticate (get session token)
    if (!_bookmarkToken) {
      _bookmarkToken = await getAuthToken()
      if (!_bookmarkToken) { _bookmarkSyncing = false; return }
    }

    // derive encryption key (same deterministic message as journal)
    if (!_bookmarkKeyDerived) {
      const keyMsg = `praxis:journal-key:v1:${addr.toLowerCase()}`
      const keySig = await getWalletProvider().request({
        method: 'personal_sign',
        params: [keyMsg, addr],
      })
      const sigBytes = new Uint8Array(keySig.slice(2).match(/.{2}/g).map(b => parseInt(b, 16)))
      const hashBuffer = await crypto.subtle.digest('SHA-256', sigBytes)
      const keyBytes = new Uint8Array(hashBuffer)
      _bookmarkCryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
      _bookmarkKeyDerived = true
    }

    // fetch server bookmarks
    const res = await fetch('/api/bookmarks', {
      headers: { 'Authorization': `Bearer ${_bookmarkToken}` },
    })
    const result = await res.json()

    if (result.encrypted) {
      const decrypted = await _bmDecrypt(result.encrypted)
      const serverBookmarks = JSON.parse(decrypted)
      const localBookmarks = getBookmarks()

      // merge: union by id, prefer newer savedAt
      const merged = new Map()
      for (const b of serverBookmarks) merged.set(b.id, b)
      for (const b of localBookmarks) {
        const existing = merged.get(b.id)
        if (!existing || (b.savedAt && (!existing.savedAt || b.savedAt > existing.savedAt))) {
          merged.set(b.id, b)
        }
      }
      const mergedList = [...merged.values()].sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))

      _setLocalBookmarks(mergedList)

      // push merged result back if there were local-only items
      if (mergedList.length !== serverBookmarks.length) {
        pushBookmarks(mergedList)
      }
    } else {
      // no server data — push local bookmarks up
      const local = getBookmarks()
      if (local.length > 0) pushBookmarks(local)
    }
  } catch {
    // sync failed — localStorage still has the data
  } finally {
    _bookmarkSyncing = false
  }
}

// Install the wallet + bookmarks-changed listeners. Idempotent — safe to
// call from any route entry point (spa.js does at module load).
export function startBookmarkSync() {
  if (_listenersInstalled) return
  _listenersInstalled = true

  window.addEventListener('wallet-connected', () => {
    _bookmarkToken = ''
    _bookmarkCryptoKey = null
    _bookmarkKeyDerived = false
  })
  window.addEventListener('wallet-disconnected', () => {
    _bookmarkToken = ''
    _bookmarkCryptoKey = null
    _bookmarkKeyDerived = false
  })
  window.addEventListener('bookmarks-changed', (e) => {
    if (e.detail) pushBookmarks(e.detail)
  })

  // auto-sync when wallet connects (non-blocking)
  window.addEventListener('wallet-connected', () => { syncBookmarks().catch(() => {}) })
}
