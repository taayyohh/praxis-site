// Full-page messaging — XMTP v7
// Two-column layout: conversation list (left) + active chat (right)
import { query } from './ponder.js'
import { t } from './i18n.js'
import { createWalletClient, custom, http, parseEther, formatEther } from './vendor.js'
import { optimism } from './vendor.js'
import { escapeHtml, resolveAddresses, isBlocked, blockUser, unblockUser, registerPage, dbg} from './utils.js'

// Sign a message via the embedded wallet, falling back to window.ethereum.
// Critical: when another wallet (Phantom, Coinbase, Rabby) has locked window.ethereum
// we can't reassign it, so our embedded provider lives at window.praxisEthereum.
// The XMTP signer must use that, otherwise signing routes to the wrong wallet
// → "Account is not connected" error.
async function _xmtpPersonalSign(address, message) {
  // Prefer the explicit embedded helper if exposed (signs locally with no popup)
  if (window.signMessage) {
    try {
      const hex = await window.signMessage(message)
      return new Uint8Array(hex.slice(2).match(/.{2}/g).map(b => parseInt(b, 16)))
    } catch (e) {
      console.warn('[messages] window.signMessage failed, trying provider request:', e?.message)
    }
  }
  // Next: our injected provider via the praxis namespace (survives window.ethereum lockdown).
  // Use getWalletProvider() helper to keep the routing pattern consistent across the
  // codebase (returns window.praxisEthereum first, falls back to window.ethereum).
  const provider = (typeof window.getWalletProvider === 'function' ? window.getWalletProvider() : null) || window.praxisEthereum || window.ethereum
  if (!provider) throw new Error('no wallet available')
  const hex = await provider.request({ method: 'personal_sign', params: [message, address] })
  return new Uint8Array(hex.slice(2).match(/.{2}/g).map(b => parseInt(b, 16)))
}

let client = null
let sdk = null
let _initInFlight = false

// Fix NEW-M4 (cycle-2): hoist module state referenced by the xmtp-teardown
// handler above its previous declaration site. The listener is async so TDZ
// wouldn't actually fire today, but the ordering was fragile — any refactor
// that made the dispatch sync (or moved the dispatch earlier) would explode.
let conversations = []
let activeConvo = null
let activeStream = null
let activePeerAddr = null
let activeIsGroup = false

// Per-conversation read-receipt / typing state (referenced by teardown handler).
// Bounded via boundedSet() helper (cap = _CONVO_MAP_CAP) to prevent unbounded growth.
const _peerReadWatermark = new Map() // convoId -> BigInt-as-string
const _peerTypingAt = new Map() // convoId -> epoch ms

// First successful active-conversation open kicks a one-shot background
// sync for older conversations. Declared early so the teardown handler can
// reset it without a TDZ risk.
let _bgSyncKicked = false

// Fix 3 (C3): tear down module state when wallet.js disconnects the wallet.
// Without this, `client` stays referenced across reconnects and the OPFS
// database leaks, and the Fix 8 "have I sent here" cache holds stale convo
// IDs from the previous inbox.
window.addEventListener('xmtp-teardown', () => {
  try { activeStream?.return?.() } catch {}
  activeStream = null
  activeConvo = null
  client = null
  _initInFlight = false
  conversations = []
  _peerReadWatermark.clear()
  _peerTypingAt.clear()
  _bgSyncKicked = false
  // Invalidate the Fix 8 "have I sent here" cache.
  try {
    const rm = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith('praxis-msg-checked:')) rm.push(k)
    }
    for (const k of rm) localStorage.removeItem(k)
  } catch {}
})

// expose globally so wallet.js can start the unread stream on any page
// DO NOT null these — wallet.js may have already set them via Client.build
if (!window._xmtpClient) window._xmtpClient = null
if (!window._xmtpSdk) window._xmtpSdk = null
// Note: conversations/activeConvo/activeStream/activePeerAddr/activeIsGroup
// and _peerReadWatermark/_peerTypingAt/_bgSyncKicked are declared above
// (hoisted) so the xmtp-teardown listener can reference them safely.

// --- Read receipts + typing indicators (custom ephemeral content) ---
// XMTP v7 browser-sdk has no bundled read-receipt or typing codec, and adding a
// new package would require a vendor bundle rebuild. Instead we piggyback on
// sendText() with a NUL-prefixed sentinel payload. extractText() filters these
// out so they never render as normal bubbles, and the active-conversation
// stream iterator interprets them as control messages.
//
// Formats:
//   \x00praxis:read:<sentAtNs>     — peer has read every message <= sentAtNs
//   \x00praxis:typing:<epochMs>    — peer was typing at <epochMs>
const PX_READ_PREFIX = '\x00praxis:read:'
const PX_TYPING_PREFIX = '\x00praxis:typing:'
// Per-conversation watermark + typing maps are declared above (hoisted for
// the xmtp-teardown listener).
// Fix 6 (H6): bounded-LRU helper for the two Maps above, to prevent unbounded
// growth over many conversations. Delete-then-set bumps the key to the end of
// insertion order so the oldest entry is always evicted first.
const _CONVO_MAP_CAP = 500
function boundedSet(map, key, value, cap = _CONVO_MAP_CAP) {
  if (map.has(key)) map.delete(key)
  else if (map.size >= cap) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
  map.set(key, value)
}
let _typingIndicatorTimer = null
// Local debounce for outgoing typing events.
let _lastTypingSentAt = 0
const TYPING_SEND_INTERVAL_MS = 3000
const TYPING_DISPLAY_MS = 5000
let _msgItems = []
let _msgDisplayCount = 0
const INBOX_ADDR_MAX = 500
let inboxToAddr = {}
let _inboxToAddrOrder = []
let addrToDomain = {}

// restore inbox-addr mapping from localStorage (for toast on non-messages pages)
try {
  const stored = JSON.parse(localStorage.getItem('praxis:inbox-addr-map') || '{}')
  Object.assign(inboxToAddr, stored)
  _inboxToAddrOrder.push(...Object.keys(stored))
} catch {}
let _messagesWalletBound = false

function trimInboxToAddr() {
  if (_inboxToAddrOrder.length > INBOX_ADDR_MAX) {
    // Evict oldest entries (from front of order array) to stay at max
    const evictCount = _inboxToAddrOrder.length - INBOX_ADDR_MAX
    const toRemove = _inboxToAddrOrder.splice(0, evictCount)
    for (const k of toRemove) delete inboxToAddr[k]
  }
}

// LRU-aware setter: moves key to end of order list
// Intentionally uses indexOf O(n) — INBOX_ADDR_MAX is 500, so linear scan is negligible
function setInboxToAddr(key, value) {
  if (inboxToAddr[key] !== undefined) {
    const idx = _inboxToAddrOrder.indexOf(key)
    if (idx !== -1) _inboxToAddrOrder.splice(idx, 1)
  }
  inboxToAddr[key] = value
  _inboxToAddrOrder.push(key)
  trimInboxToAddr()
  // persist to localStorage for toast resolution on non-messages pages
  try {
    const stored = JSON.parse(localStorage.getItem('praxis:inbox-addr-map') || '{}')
    stored[key] = value
    // cap at 200 entries
    const keys = Object.keys(stored)
    if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete stored[k]
    localStorage.setItem('praxis:inbox-addr-map', JSON.stringify(stored))
  } catch {}
}

// LRU-aware getter: touches key (moves to end)
function getInboxToAddr(key) {
  const val = inboxToAddr[key]
  if (val !== undefined) {
    const idx = _inboxToAddrOrder.indexOf(key)
    if (idx !== -1) {
      _inboxToAddrOrder.splice(idx, 1)
      _inboxToAddrOrder.push(key)
    }
  }
  return val
}

registerPage('messages-page', initMessages)

function clearMsgDot() {
  const dot = document.getElementById('dock-msg-dot')
  if (dot) dot.style.display = 'none'
  try { sessionStorage.removeItem('praxis-unread-msgs') } catch {}
}
window._clearMsgDot = clearMsgDot

// --- Worker patching for XMTP ---
function patchWorker() {
  if (window._workerPatched) return
  window._workerPatched = true
  const Orig = window.Worker
  window.Worker = function(url, opts) {
    const s = url instanceof URL ? url.href : url
    if (typeof s === 'string' && (s.includes('esm.sh') || s.includes('xmtp') || s.includes('workers/client') || s.includes('workers/opfs'))) {
      if (s.includes('client')) return new Orig('/js/xmtp-workers/client.js', { ...opts, type: 'module' })
      if (s.includes('opfs')) return new Orig('/js/xmtp-workers/opfs.js', { ...opts, type: 'module' })
    }
    return new Orig(url, opts)
  }
}

// cleanup XMTP stream on SPA navigation away from messages
window.addEventListener('spa-navigate', () => {
  if (activeStream) {
    try { activeStream.return?.() } catch {}
    activeStream = null
  }
})

function cleanupOldSeenKeys() {
  // throttle: only run once per 24h to avoid scanning localStorage on every page load
  const CLEANUP_TS_KEY = 'praxis:msg-seen-cleanup-ts'
  try {
    const lastCleanup = parseInt(localStorage.getItem(CLEANUP_TS_KEY) || '0', 10)
    if (Date.now() - lastCleanup < 86400000) return // <24h since last cleanup
  } catch {}
  const thirtyDaysAgo = (Date.now() - 30 * 86400000) * 1e6 // nanoseconds
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i)
    if (key?.startsWith('praxis:msg-seen:')) {
      const val = parseInt(localStorage.getItem(key) || '0', 10)
      if (val < thirtyDaysAgo) localStorage.removeItem(key)
    }
  }
  try { localStorage.setItem(CLEANUP_TS_KEY, String(Date.now())) } catch {}
}

async function initMessages() {
  dbg('praxis: initMessages called', { _initInFlight, hasClient: !!client?.inboxId, hasWindowClient: !!window._xmtpClient?.inboxId, isReadOnly: !!window._xmtpClientIsReadOnly })
  if (_initInFlight) { console.warn('praxis: initMessages blocked by _initInFlight'); return }
  _initInFlight = true
  // mobile back button
  const backBtn = document.getElementById('messages-back')
  if (backBtn && !backBtn._bound) {
    backBtn._bound = true
    backBtn.addEventListener('click', () => {
      document.getElementById('messages-container')?.classList.remove('chat-active')
    })
  }

  // prune stale per-conversation seen timestamps (>30 days old)
  try { cleanupOldSeenKeys() } catch {}
  // clear unread indicator and mark as seen
  clearMsgDot()
  try { localStorage.setItem('praxis-msg-seen', String(Date.now())) } catch {}

  const addr = window.getWalletAddress?.()
  const connectEl = document.getElementById('messages-connect')
  const loadingEl = document.getElementById('messages-loading')
  if (addr) {
    // wallet already connected — hide connect prompt, show loader
    if (connectEl) connectEl.style.display = 'none'
    if (loadingEl) loadingEl.style.display = 'block'
    startXmtp(addr)
  } else {
    // also check localStorage in case wallet.js hasn't fired yet
    const savedAddr = localStorage.getItem('praxis-wallet')
    if (savedAddr) {
      if (connectEl) connectEl.style.display = 'none'
      if (loadingEl) loadingEl.style.display = 'block'
      // wait briefly for wallet.js to connect, then start
      setTimeout(() => {
        const a = window.getWalletAddress?.() || savedAddr
        startXmtp(a)
      }, 1000)
    } else if (!_messagesWalletBound) {
      _messagesWalletBound = true
      if (connectEl) connectEl.style.display = 'block'
      if (loadingEl) loadingEl.style.display = 'none'
      window.addEventListener('wallet-connected', (e) => {
        if (connectEl) connectEl.style.display = 'none'
        if (loadingEl) loadingEl.style.display = 'block'
        startXmtp(e.detail.address)
      })
    }
  }

  // compose modal
  const composeBtn = document.getElementById('messages-compose')
  composeBtn?.addEventListener('click', () => {
    // Remove existing modal
    document.getElementById('messages-compose-modal')?.remove()
    const overlay = document.createElement('div')
    overlay.id = 'messages-compose-modal'
    overlay.className = 'msg-compose-overlay'
    const sheet = document.createElement('div')
    sheet.className = 'msg-compose-sheet'
    overlay.appendChild(sheet)

    function showMenu() {
      sheet.innerHTML = `
        <h3 style="margin:0 0 1em;font-size:1em;font-weight:600">new conversation</h3>
        <button id="messages-new" class="msg-compose-option"><i class="ph ph-chat-circle"></i> direct message</button>
        <button id="messages-group" class="msg-compose-option"><i class="ph ph-users-three"></i> group chat</button>
        <button class="msg-compose-cancel">cancel</button>
      `
      sheet.querySelector('.msg-compose-cancel').addEventListener('click', () => overlay.remove())
      sheet.querySelector('#messages-new').addEventListener('click', () => showDmPicker())
      sheet.querySelector('#messages-group').addEventListener('click', () => showGroupPicker())
    }

    async function showDmPicker() {
      sheet.innerHTML = `<div class="msg-picker-header"><button class="msg-picker-back"><i class="ph ph-arrow-left"></i></button><span>direct message</span></div><input class="msg-picker-search" type="text" placeholder="search..." autofocus><div class="msg-picker-list" style="max-height:300px;overflow-y:auto"><div style="padding:1.5em;display:flex;justify-content:center"><span class="praxis-loader"></span></div></div>`
      sheet.querySelector('.msg-picker-back').addEventListener('click', showMenu)
      try {
        const mutuals = await _fetchMutuals()
        const listEl = sheet.querySelector('.msg-picker-list')
        if (!mutuals.length) { listEl.innerHTML = `<div style="color:var(--muted);padding:1em;font-size:0.85em">no mutual follows yet</div>`; return }
        const mutualDomains = await resolveAddresses(query, mutuals).catch(() => ({}))
        Object.assign(addrToDomain, mutualDomains)
        listEl.innerHTML = mutuals.map(addr => {
          const domain = addrToDomain[addr] || `${addr.slice(0, 6)}...${addr.slice(-4)}`
          return `<div class="msg-convo-item msg-new-item" data-addr="${escapeHtml(addr)}" data-domain="${escapeHtml(domain)}">${escapeHtml(domain)}</div>`
        }).join('')
        sheet.querySelector('.msg-picker-search')?.addEventListener('input', (e) => {
          const q = e.target.value.toLowerCase()
          listEl.querySelectorAll('.msg-new-item').forEach(el => { el.style.display = el.dataset.domain.toLowerCase().includes(q) ? '' : 'none' })
        })
        listEl.querySelectorAll('.msg-new-item').forEach(el => {
          el.addEventListener('click', () => { overlay.remove(); openDmByAddress(el.dataset.addr, el.dataset.domain) })
        })
      } catch { sheet.querySelector('.msg-picker-list').innerHTML = `<div style="color:var(--muted);padding:1em">failed to load</div>` }
    }

    async function showGroupPicker() {
      sheet.innerHTML = `<div class="msg-picker-header"><button class="msg-picker-back"><i class="ph ph-arrow-left"></i></button><span>new group</span></div><div style="padding:1.5em;display:flex;justify-content:center"><span class="praxis-loader"></span></div>`
      sheet.querySelector('.msg-picker-back').addEventListener('click', showMenu)
      try {
        const mutuals = await _fetchMutuals()
        if (!mutuals.length) { sheet.querySelector('div[style*=padding]').innerHTML = `<div style="color:var(--muted);font-size:0.85em">no mutual follows yet</div>`; return }
        const mutualDomains = await resolveAddresses(query, mutuals).catch(() => ({}))
        Object.assign(addrToDomain, mutualDomains)
        const formHtml = `<div style="padding:0 1em 1em">
          <div style="font-size:0.75em;color:var(--muted);margin-bottom:0.3em">group name</div>
          <input id="group-name-input" type="text" placeholder="e.g. the crew" style="width:100%;padding:0.5em;margin-bottom:0.75em;background:var(--surface);border:1px solid var(--border);color:var(--fg);font-family:inherit;font-size:0.85em;border-radius:4px;box-sizing:border-box">
          <div style="font-size:0.75em;color:var(--muted);margin-bottom:0.3em">add members</div>
          <div style="max-height:200px;overflow-y:auto">${mutuals.map(addr => {
            const domain = addrToDomain[addr] || addr.slice(0, 6) + '...' + addr.slice(-4)
            return `<label class="msg-convo-item" style="display:flex;align-items:center;gap:0.5em;cursor:pointer"><input type="checkbox" data-addr="${escapeHtml(addr)}" style="accent-color:var(--accent)"><span style="font-size:0.85em">${escapeHtml(domain)}</span></label>`
          }).join('')}</div>
          <button id="group-create-btn" class="msg-compose-option" style="margin-top:0.75em;justify-content:center;font-weight:600">create group</button>
        </div>`
        sheet.querySelector('div[style*=padding]').outerHTML = formHtml
        sheet.querySelector('#group-create-btn')?.addEventListener('click', async () => {
          const name = sheet.querySelector('#group-name-input')?.value.trim()
          const addrs = [...sheet.querySelectorAll('input[type="checkbox"]:checked')].map(cb => cb.dataset.addr)
          if (!name || !addrs.length) return
          const inboxIds = []
          for (const addr of addrs) {
            try {
              const id = await client.fetchInboxIdByIdentifier({ identifier: addr, identifierKind: sdk.IdentifierKind.Ethereum })
              if (id) inboxIds.push(id)
            } catch {}
          }
          if (!inboxIds.length) return
          try {
            const group = await client.conversations.createGroup(inboxIds, { name })
            overlay.remove()
            await loadConversations()
            openConversation(group, name)
          } catch (e) { console.error('create group error:', e) }
        })
      } catch { sheet.querySelector('div[style*=padding]').innerHTML = `<div style="color:var(--muted)">failed to load</div>` }
    }

    showMenu()
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
    document.body.appendChild(overlay)
  })
  // settings button — manage XMTP installations
  document.getElementById('messages-settings-btn')?.addEventListener('click', () => {
    showMessagesSettings()
  })

  document.getElementById('messages-send-form')?.addEventListener('submit', sendMessage)
  // Textarea auto-resize (iMessage-style: grows with content up to max-height,
  // then scrolls). Also Enter submits, Shift+Enter inserts a newline.
  const _msgInputEl = document.getElementById('messages-input')
  if (_msgInputEl && !_msgInputEl._praxisBound) {
    _msgInputEl._praxisBound = true
    // auto-resize on every input
    _msgInputEl.addEventListener('input', () => {
      requestAnimationFrame(() => {
        _msgInputEl.style.height = 'auto' // shrink first so scrollHeight is accurate
        _msgInputEl.style.height = Math.min(_msgInputEl.scrollHeight, 128) + 'px' // max ~8 lines
        _msgInputEl.style.overflowY = _msgInputEl.scrollHeight > 128 ? 'auto' : 'hidden'
      })
      if (_msgInputEl.value.trim().length > 0) sendTypingIndicator()
    })
    // Enter submits the form, Shift+Enter inserts a newline
    _msgInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        _msgInputEl.closest('form')?.dispatchEvent(new Event('submit', { cancelable: true }))
      }
    })
  }
  // Attachment button
  document.getElementById('messages-attach-btn')?.addEventListener('click', () => {
    const input = document.getElementById('messages-attach-input')
    if (input) { input.value = ''; input.click() }
  })
  document.getElementById('messages-attach-input')?.addEventListener('change', async (e) => {
    const fileList = [...(e.target.files || [])] // copy to array before reset clears FileList
    e.target.value = '' // reset for next use
    console.log('[attach] change event, files:', fileList.length, 'activeConvo:', !!activeConvo)
    if (!fileList.length) return
    if (!activeConvo) { const { toast } = await import('./toast.js'); toast.error('select a conversation first'); return }
    for (const file of fileList) {
      try {
        console.log('[attach] file:', file.name, 'type:', file.type, 'size:', file.size)
        const isImage = file.type.startsWith('image/')
        const isVideo = file.type.startsWith('video/')
        const isPdf = file.type === 'application/pdf'
        if (!isImage && !isVideo && !isPdf) { console.warn('[attach] unsupported type:', file.type); continue }
        if (file.size > 100 * 1024 * 1024) { const { toast } = await import('./toast.js'); toast.error('max 100MB for message attachments'); continue }
        const inputEl = document.getElementById('messages-input')
        if (inputEl) inputEl.placeholder = `uploading ${file.name}...`

        // Upload to IPFS via async queue (requires auth session token)
        const addr = window.getWalletAddress?.()
        console.log('[attach] addr:', addr, 'file:', file.name, file.type, file.size)
        if (!addr) { console.error('[attach] wallet not connected'); continue }
        // Get or create auth session
        let authToken = sessionStorage.getItem('praxis-auth-token') || ''
        console.log('[attach] cached authToken:', authToken ? 'yes' : 'no')
        if (!authToken) {
          try {
            await window.ensureAuthorized?.()
            const provider = window.getWalletProvider?.()
            console.log('[attach] provider:', !!provider)
            if (provider) {
              const msg = `admin:${location.hostname}:${Date.now()}`
              const sig = await provider.request({ method: 'personal_sign', params: [msg, addr] })
              console.log('[attach] got signature, authenticating...')
              const authRes = await fetch('/api/auth', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ address: addr, signature: sig, message: msg }),
              })
              const authData = await authRes.json()
              console.log('[attach] auth result:', authData.token ? 'got token' : authData.error || 'no token')
              if (authData.token) { authToken = authData.token; sessionStorage.setItem('praxis-auth-token', authToken) }
            }
          } catch (authErr) {
            console.error('[attach] auth failed:', authErr.message)
            const { toast } = await import('./toast.js')
            toast.error('sign in to attach files')
            continue
          }
        }
        if (!authToken) { console.error('[attach] no auth token'); const { toast } = await import('./toast.js'); toast.error('authentication required'); continue }
        console.log('[attach] uploading', file.size, 'bytes...')
        const arrayBuf = await file.arrayBuffer()
        const uploadRes = await fetch(`/api/ipfs?name=${encodeURIComponent(file.name)}&ephemeral=1`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(arrayBuf.byteLength), 'Authorization': `Bearer ${authToken}` },
          body: arrayBuf,
        })
        console.log('[attach] upload response:', uploadRes.status)
        const uploadData = await uploadRes.json()
        if (!uploadData.jobId) { console.error('upload failed:', uploadData); if (inputEl) inputEl.placeholder = 'type a message...'; continue }

        // Poll for completion
        let cid = null
        for (let i = 0; i < 60; i++) {
          await new Promise(r => setTimeout(r, 1000))
          const statusRes = await fetch(`/api/ipfs/status/${uploadData.jobId}`)
          const statusData = await statusRes.json()
          if (statusData.status === 'done' && statusData.cid) { cid = statusData.cid; break }
          if (statusData.status === 'error') { console.error('upload error:', statusData.error); break }
          if (inputEl) inputEl.placeholder = `uploading ${file.name}...`
        }
        if (inputEl) inputEl.placeholder = 'type a message...'
        if (!cid) { const { toast } = await import('./toast.js'); toast.error('upload failed — try again'); continue }

        const ipfsUrl = `/api/ipfs-proxy/${cid}`
        const prefix = isImage ? 'image' : (isVideo ? 'video' : 'pdf')
        const msgText = `[${prefix}:${file.name}](${ipfsUrl})`
        // Upgrade client if read-only
        if (window._xmtpClientIsReadOnly) {
          const upgraded = await ensureFullClient()
          if (!upgraded) continue
          await client.conversations.sync()
          const convos = await client.conversations.list()
          const match = convos.find(c => c.id === activeConvo.id)
          if (match) activeConvo = match
        }
        await activeConvo.sendText(msgText)
        await activeConvo.sync()
        renderMessages(await activeConvo.messages())
      } catch (err) {
        console.error('attachment send failed:', err)
        const inputEl = document.getElementById('messages-input')
        if (inputEl) inputEl.placeholder = 'type a message...'
        const { toast } = await import('./toast.js')
        toast.error(`attachment failed: ${(err.message || '').slice(0, 50)}`)
      }
    }
  })

  document.getElementById('messages-pay-toggle')?.addEventListener('click', () => {
    const bar = document.getElementById('messages-pay-bar')
    bar.style.display = bar.style.display === 'none' ? 'flex' : 'none'
  })
  document.getElementById('messages-pay-cancel')?.addEventListener('click', () => {
    document.getElementById('messages-pay-bar').style.display = 'none'
  })
  document.getElementById('messages-pay-send')?.addEventListener('click', sendPayment)

  // Live fiat conversion as user types ETH amount
  const payAmtInput = document.getElementById('messages-pay-amount')
  const payFiatSpan = document.getElementById('messages-pay-fiat')
  if (payAmtInput && payFiatSpan) {
    let _payPrices = null
    import('./fiat.js').then(m => m.getEthPrices().then(p => { _payPrices = p })).catch(() => {})
    const updatePayFiat = async () => {
      const eth = parseFloat(payAmtInput.value)
      if (!eth || !_payPrices) { payFiatSpan.textContent = ''; return }
      const { getUserCurrency, formatFiat } = await import('./fiat.js')
      const currency = getUserCurrency()
      const rate = _payPrices[currency]
      if (!rate) { payFiatSpan.textContent = ''; return }
      payFiatSpan.textContent = `~${formatFiat(eth * rate, currency)}`
    }
    payAmtInput.addEventListener('input', updatePayFiat)
  }

  // check URL params for direct message
  const params = new URLSearchParams(window.location.search)
  const toAddr = params.get('to')
  if (toAddr && !window._messagesDmBound) {
    window._messagesDmBound = true
    window.addEventListener('wallet-connected', () => {
      setTimeout(() => openDmByAddress(toAddr, addrToDomain[toAddr.toLowerCase()] || toAddr.slice(0, 10)), 2000)
    })
  }
}

async function startXmtp(address) {
  document.getElementById('messages-connect').style.display = 'none'
  document.getElementById('messages-loading').style.display = 'block'

  // Cross-tab coordination: acquire the XMTP lock before proceeding.
  // Uses atomic request() — no pre-check with query() which has a TOCTOU race on refresh.
  // Skip if this tab already holds the lock (dm.js or wallet.js acquired it before SPA nav).
  const _xmtpLockName = `xmtp-${location.hostname}`
  if (navigator.locks && !client?.inboxId && !window._xmtpLockHolder) {
    const lockAcquired = await new Promise(resolve => {
      navigator.locks.request(_xmtpLockName, { ifAvailable: true }, async (lock) => {
        if (!lock) {
          resolve(false)
          return
        }
        resolve(true)
        // Hold lock until tab closes
        await new Promise(() => {})
      }).catch(() => resolve(false))
    })

    if (!lockAcquired) {
      // Another tab genuinely holds the lock — show message + listen for broadcasts
      const loadingEl = document.getElementById('messages-loading')
      loadingEl.innerHTML = '<div style="color:var(--muted);padding:1em">messaging is active in another tab. close the other tab to use messages here.</div>'
      try {
        const bc = new BroadcastChannel(_xmtpLockName)
        bc.onmessage = (e) => {
          if (e.data.type === 'unread') {
            const dot = document.getElementById('dock-msg-dot')
            if (dot) dot.style.display = ''
            try { sessionStorage.setItem('praxis-unread-msgs', '1') } catch {}
          }
        }
      } catch {}
      _initInFlight = false
      return
    }
  }

  // Set up BroadcastChannel to notify other tabs of unread messages
  let _xmtpBroadcast = null
  try { _xmtpBroadcast = new BroadcastChannel(`xmtp-${location.hostname}`) } catch {}
  window._xmtpBroadcast = _xmtpBroadcast

  try {
    patchWorker()
    sdk = await import('./vendor-xmtp.js')

    // Reuse existing full client (Client.create) if available
    // But NOT a read-only Client.build — it can't receive welcome messages for new DMs
    const existingClient = client || window._xmtpClient
    const isReadOnly = window._xmtpClientIsReadOnly
    dbg('praxis: startXmtp reuse check', { moduleClient: !!client, windowClient: !!window._xmtpClient, existingInboxId: existingClient?.inboxId?.slice(0, 8), isReadOnly })
    if (existingClient?.inboxId && !isReadOnly) {
      dbg('praxis: reusing existing full XMTP client')
      client = existingClient
      window._xmtpClient = existingClient
      window._xmtpSdk = sdk
      if (window._xmtpBgStream) {
        try { await window._xmtpBgStream.return?.() } catch {}
        window._xmtpBgStream = null
      }

      // SAFETY CHECK: the cached client may have been built without on-chain registration
      // (e.g. half-finished signup, OPFS state cleared, or a read-only client got mis-flagged).
      // Without register_identity(), every subsequent call fails with "Operation attempted
      // before register_identity() was called". Verify + register if needed before loading.
      try {
        const isRegistered = await client.isRegistered?.()
        if (isRegistered === false) {
          console.warn('praxis: cached XMTP client is not registered — registering now')
          await window.ensureAuthorized?.()
          // Build a fresh signer (the original may have come from a different scope)
          const repairSigner = {
            type: 'EOA',
            getIdentifier: () => ({ identifier: address, identifierKind: sdk.IdentifierKind.Ethereum }),
            signMessage: (message) => _xmtpPersonalSign(address, message),
          }
          try {
            await client.register?.(repairSigner)
            try { localStorage.setItem(`xmtp-registered-${address.toLowerCase()}`, '1') } catch {}
            dbg('praxis: repair register completed')
          } catch (regErr) {
            // "already registered" is fine — the SDK is just inconsistent about isRegistered
            if (!regErr?.message?.includes('already registered')) {
              console.warn('praxis: repair register failed, falling through to fresh Client.create:', regErr?.message)
              client = null
              window._xmtpClient = null
              // Fall through to the normal Client.create flow below
            }
          }
        }
      } catch (checkErr) {
        console.warn('praxis: isRegistered check failed (continuing):', checkErr?.message)
      }

      if (client) {
        await _loadConversations(address)
        _initInFlight = false
        return
      }
    }
    // Read-only Client.build exists — close it and upgrade to Client.create
    // Client.create registers the installation so we can receive new DMs (welcome messages)
    if (existingClient?.inboxId && isReadOnly) {
      dbg('praxis: upgrading from read-only Client.build to full Client.create')
      try { existingClient.close?.() } catch {}
      window._xmtpClient = null
      window._xmtpClientIsReadOnly = false
      // Fall through to Client.create below
    }

    // ensure embedded wallet is active before signing (same fix as ensureAuthorized)
    if (window.isWalletLocked?.() !== false && window.hasEmbeddedWallet?.()) {
      await window.ensureAuthorized?.()
    }

    const signer = {
      type: 'EOA',
      getIdentifier: () => ({
        identifier: address,
        identifierKind: sdk.IdentifierKind.Ethereum,
      }),
      signMessage: (message) => _xmtpPersonalSign(address, message),
    }

    // On /messages page, prefer Client.create (needs signer for send/revoke).
    // On other pages (e.g. dm.js unread badge), Client.build is fine for read-only.
    const isMessagesPage = !!document.getElementById('messages-page')
    const hasRegistered = localStorage.getItem(`xmtp-registered-${address.toLowerCase()}`)

    if (!isMessagesPage && hasRegistered) {
      // Try Client.build for read-only contexts (no signature popup)
      for (let _buildAttempt = 0; _buildAttempt < 3; _buildAttempt++) {
        try {
          const identifier = { identifier: address, identifierKind: sdk.IdentifierKind.Ethereum }
          client = await sdk.Client.build(identifier, { env: 'production' })
          if (client?.inboxId) {
            dbg('praxis: XMTP reconnected via Client.build (no signature)')
          } else {
            client = null
          }
          break
        } catch (buildErr) {
          const bMsg = buildErr?.message || ''
          if (_buildAttempt < 2 && (bMsg.includes('undefined') || bMsg.includes('worker') || bMsg === '')) {
            console.warn(`praxis: Client.build worker error (attempt ${_buildAttempt + 1}/3), retrying...`)
            await new Promise(r => setTimeout(r, (_buildAttempt + 1) * 1500))
            continue
          }
          console.warn('praxis: Client.build failed, falling back to create:', bMsg)
          client = null
          break
        }
      }
    }

    // Client.create (requires wallet signature) — always used on /messages page
    // Retry with backoff if OPFS lock is still held (SyncAccessHandle conflict)
    if (!client) {
      try {
        for (const attempt of [0, 1, 2]) {
          try {
            client = await sdk.Client.create(signer, { env: 'production', disableAutoRegister: true })
            try {
              const { ReactionCodec } = await import('./vendor-xmtp-reaction.js')
              client.registerCodec?.(new ReactionCodec())
            } catch {}
            break // success
          } catch (retryErr) {
            const msg = retryErr?.message || ''
            if (attempt < 2 && (msg.includes('Access Handle') || msg.includes('OPFS') || msg.includes('sync access') || msg.includes('createSyncAccessHandle') || msg.includes('undefined') || msg.includes('worker') || msg === '')) {
              console.warn(`praxis: Client.create worker/OPFS error (attempt ${attempt + 1}/3), retrying in ${(attempt + 1) * 2}s...`, msg || '(empty)')
              await new Promise(r => setTimeout(r, (attempt + 1) * 2000))
              continue
            }
            throw retryErr // non-OPFS error — let outer catch handle
          }
        }
      } catch (createErr) {
        const errMsg = createErr?.message || ''
        const isInstallLimit = errMsg.includes('installation') || errMsg.includes('10/10') || errMsg.includes('20/20') || errMsg.includes('maximum')
      if (!isInstallLimit) throw createErr

      console.warn('praxis: Client.create failed at installation limit:', errMsg)
      // Client.create fails even with disableAutoRegister when at 10/10.
      // Use static SDK methods (no client needed) to list + revoke installations.
      const loadingEl = document.getElementById('messages-loading')
      loadingEl.innerHTML = '<div style="color:var(--muted)">resolving installations...</div>'

      try {
        // Step 1: Get inbox ID using static method (no client needed)
        const identifier = { identifier: address, identifierKind: sdk.IdentifierKind.Ethereum }
        let inboxId = null

        // Try extracting from error message first
        const match = errMsg.match(/[Ii]nbox[Ii][Dd]\s*:?\s*([a-f0-9]{64})/i)
        if (match) inboxId = match[1]

        // If not in error, use static lookup
        if (!inboxId && sdk.createBackend && sdk.getInboxIdForIdentifier) {
          const backend = await sdk.createBackend({ env: 'production' })
          inboxId = await sdk.getInboxIdForIdentifier(backend, identifier)
        }

        if (!inboxId) {
          console.error('praxis: could not resolve inbox ID')
          throw createErr
        }

        dbg('praxis: resolved inbox ID:', inboxId)

        // Step 2: List installations using static method
        let installations = []
        try {
          const states = await sdk.Client.fetchInboxStates([inboxId], 'production')
          installations = states?.[0]?.installations || []
        } catch (e) { console.warn('praxis: fetchInboxStates failed:', e?.message) }

        if (installations.length === 0) {
          console.error('praxis: no installations found to revoke')
          throw createErr
        }

        dbg(`praxis: found ${installations.length} installations, showing revoke UI`)

        // Step 3: Show human-readable error directing to settings
        loadingEl.style.display = 'block'
        loadingEl.innerHTML = `
          <div style="padding:1.5em;max-width:400px;margin:0 auto;text-align:center">
            <div style="color:var(--muted);margin-bottom:1em;line-height:1.5">too many messaging sessions (${installations.length}/10). revoke old sessions in settings to reconnect.</div>
            <button id="xmtp-open-settings-inline" class="buy-btn" style="font-size:0.85em;padding:0.4em 2ch">open messaging settings</button>
          </div>
        `
        document.getElementById('xmtp-open-settings-inline')?.addEventListener('click', () => showMessagesSettings())
        _initInFlight = false
        return // stop here, user must revoke in settings then retry
      } catch (staticErr) {
        console.error('praxis: static installation management failed:', staticErr)
        // Fall through to show basic error UI
        loadingEl.style.display = 'block'
        loadingEl.innerHTML = `
          <div style="color:var(--muted);margin-bottom:0.5em">XMTP: too many installations (10/10)</div>
          <button id="xmtp-open-settings" class="buy-btn" style="font-size:0.85em;padding:0.3em 1.5ch">manage installations</button>
        `
        document.getElementById('xmtp-open-settings')?.addEventListener('click', () => showMessagesSettings())
        _initInFlight = false
        return
      }
    }

    } // close if (!client)

    // register only if not already registered (reuses existing OPFS installation)
    try {
      const registered = await client.isRegistered?.()
      if (!registered) {
        try {
          await client.register?.()
          dbg('praxis: registered new XMTP installation')
        } catch (regErr) {
          // "already registered" means identity exists on the network — this is success, not an error.
          // This happens when isRegistered() returns false/undefined but the identity is actually registered.
          if (regErr?.message?.includes('already registered')) {
            dbg('praxis: XMTP identity already registered, continuing')
          } else if (regErr?.message?.includes('installation') || regErr?.message?.includes('10/10') || regErr?.message?.includes('20/20')) {
            // hit installation limit during registration — use static revoke
            dbg('praxis: 10/10 hit during register, showing revoke UI...')
            const loadingEl = document.getElementById('messages-loading')
            loadingEl.innerHTML = '<div style="color:var(--muted)">resolving installations for revoke...</div>'
            try {
              const inboxId = client.inboxId
              // Backup conversations before revoking
              try {
                const key = crypto.getRandomValues(new Uint8Array(32))
                const archiveData = await client.createArchive(key)
                localStorage.setItem(`xmtp-archive-${address.toLowerCase()}`, JSON.stringify({
                  key: Array.from(key),
                  data: Array.from(new Uint8Array(archiveData))
                }))
                dbg('praxis: XMTP archive saved before revocation')
              } catch (e) { console.warn('praxis: archive backup failed:', e?.message) }
              const state = await client.inboxState?.(true)
              const installations = state?.installations || []
              if (installations.length > 0) {
                // revoke oldest installations one at a time until we free a slot
                for (let i = 0; i < installations.length && i < 5; i++) {
                  const inst = installations[i]
                  const id = inst.id || inst.installationId || inst
                  dbg(`praxis: revoking installation ${i}`)
                  try {
                    await client.revokeInstallations([id])
                    try {
                      await client.register?.()
                      dbg('praxis: registered after revoking installation', i)
                      break
                    } catch (regRetry) {
                      if (regRetry?.message?.includes('installation')) continue
                      throw regRetry
                    }
                  } catch (revokeOne) {
                    // client revoke failed, try static method
                    if (inboxId) {
                      const idBytes = typeof id === 'object' ? new Uint8Array(id.buffer || id) : new Uint8Array(String(id).match(/.{2}/g).map(b => parseInt(b, 16)))
                      try {
                        await sdk.Client.revokeInstallations(signer, inboxId, [idBytes], 'production')
                        try {
                          await client.register?.()
                          dbg('praxis: registered after static revoke')
                          break
                        } catch (regRetry2) {
                          if (regRetry2?.message?.includes('installation')) continue
                          throw regRetry2
                        }
                      } catch (staticRevErr) {
                        console.warn(`praxis: static revoke ${i} failed:`, staticRevErr?.message)
                        continue
                      }
                    }
                    console.warn(`praxis: failed to revoke installation ${i}:`, revokeOne?.message)
                    continue
                  }
                }
              } else {
                throw regErr
              }
            } catch (e3) {
              console.error('praxis: installation revoke during register failed:', e3)
              throw regErr
            }
          } else {
            throw regErr
          }
        }
      }
    } catch (regErr) {
      console.error('praxis: XMTP registration failed:', regErr?.message)
      const isSessionExpired = regErr?.message?.includes('session expired')
      const loadingEl = document.getElementById('messages-loading')
      loadingEl.style.display = 'block'
      if (isSessionExpired) {
        // auto-prompt unlock instead of showing error
        loadingEl.innerHTML = `
          <div style="color:var(--muted);margin-bottom:0.5em">session expired — unlock your account to continue</div>
          <button id="xmtp-unlock-btn" class="buy-btn" style="font-size:0.85em;padding:0.3em 1.5ch">unlock account</button>
        `
        document.getElementById('xmtp-unlock-btn')?.addEventListener('click', async () => {
          const addr = await window.showUnlockPrompt?.()
          if (addr) {
            loadingEl.innerHTML = '<div class="praxis-loader"></div>'
            _initInFlight = false
            initMessages() // retry after unlock
          }
        })
      } else {
        loadingEl.innerHTML = `
          <div style="color:var(--muted);margin-bottom:0.5em">could not connect to messages — ${escapeHtml(regErr?.message?.slice(0, 80) || 'unknown error')}</div>
          <button id="xmtp-retry-btn" class="buy-btn" style="font-size:0.85em;padding:0.3em 1.5ch">retry</button>
          <button id="xmtp-open-settings" class="buy-btn" style="font-size:0.85em;padding:0.3em 1.5ch;margin-left:0.5ch;background:none;border:1px solid #333;color:#666">settings</button>
        `
        document.getElementById('xmtp-retry-btn')?.addEventListener('click', () => { _initInFlight = false; initMessages() })
        document.getElementById('xmtp-open-settings')?.addEventListener('click', () => showMessagesSettings())
      }
      _initInFlight = false
      return
    }

    // Proactive cleanup: if installations exceed 8, revoke the OLDEST ones individually
    // to bring count down to 7, keeping the 3 most recent (likely active devices).
    // NEVER use revokeAllOtherInstallations — that breaks other real devices (phone, laptop).
    try {
      const state = await client.inboxState?.(true)
      const installations = state?.installations || []
      if (installations.length > 8) {
        // Backup conversations before revoking
        try {
          const key = crypto.getRandomValues(new Uint8Array(32))
          const archiveData = await client.createArchive(key)
          localStorage.setItem(`xmtp-archive-${address.toLowerCase()}`, JSON.stringify({
            key: Array.from(key),
            data: Array.from(new Uint8Array(archiveData))
          }))
          dbg('praxis: XMTP archive saved before revocation')
        } catch (e) { console.warn('praxis: archive backup failed:', e?.message) }

        // Sort by createdAt (oldest first) and keep the 3 most recent + current
        const myInstallId = client.installationId || ''
        const sorted = [...installations].sort((a, b) => {
          const ta = a.createdAt || a.createdAtNs || 0
          const tb = b.createdAt || b.createdAtNs || 0
          return Number(ta) - Number(tb)
        })
        // Filter out current installation, then take oldest ones to bring count to 7
        const toRevoke = sorted
          .filter(inst => {
            const id = inst.id || inst.installationId || ''
            const idStr = typeof id === 'object' ? Array.from(id).map(b => b.toString(16).padStart(2, '0')).join('') : String(id)
            return idStr !== String(myInstallId) && idStr.slice(0, 16) !== String(myInstallId).slice(0, 16)
          })
          .slice(0, installations.length - 7) // revoke enough to bring total to 7

        // Track operation count to warn if approaching lifetime budget
        const opsKey = `xmtp-ops-${address.toLowerCase()}`
        let opCount = parseInt(localStorage.getItem(opsKey) || '0', 10)

        for (const inst of toRevoke) {
          const id = inst.id || inst.installationId || inst
          try {
            await client.revokeInstallations([id])
            opCount++
            dbg(`praxis: revoked oldest installation (${opCount} total ops)`)
          } catch (e) {
            console.warn('praxis: individual revoke failed:', e?.message)
          }
        }

        try { localStorage.setItem(opsKey, String(opCount)) } catch {}
        if (opCount > 200) {
          console.warn(`praxis: XMTP identity operations at ${opCount}/256 — approaching lifetime limit`)
        }
      }
    } catch (e) { console.warn('praxis: installation cleanup:', e?.message) }

    // Request conversation history from other active installations
    try { await client.sendSyncRequest() } catch (e) { console.warn('praxis: sync request:', e?.message) }

    // Check for saved archive from previous revocation
    const archiveJson = localStorage.getItem(`xmtp-archive-${address.toLowerCase()}`)
    if (archiveJson) {
      try {
        const { key, data } = JSON.parse(archiveJson)
        await client.importArchive(new Uint8Array(data), new Uint8Array(key))
        await client.conversations.syncAll?.(['allowed', 'unknown'])
        localStorage.removeItem(`xmtp-archive-${address.toLowerCase()}`) // consumed
        dbg('praxis: imported XMTP archive from previous session')
      } catch (e) { console.warn('praxis: archive import failed:', e?.message) }
    }

    // mark as registered for background Client.build on other pages
    try { localStorage.setItem(`xmtp-registered-${address.toLowerCase()}`, '1') } catch {}
    // expose globally for unread stream on other pages
    window._xmtpClient = client
    window._xmtpSdk = sdk
    window._xmtpClientIsReadOnly = false

    // Verify installation validity and sync state across devices
    try {
      const myInstallId = client.installationId ? String(client.installationId) : ''
      if (myInstallId && client.inboxId) {
        const state = await client.inboxState?.(true) // refresh from network
        const installations = state?.installations || []
        const idStrs = installations.map(inst => {
          const id = inst.id || inst.installationId || ''
          return typeof id === 'object' ? Array.from(id).map(b => b.toString(16).padStart(2, '0')).join('') : String(id)
        })
        const isStillValid = idStrs.some(id => id === myInstallId || id.slice(0, 16) === myInstallId.slice(0, 16))

        dbg(`praxis: inbox has ${installations.length} installation(s), ours ${isStillValid ? 'valid' : 'REVOKED'} (${myInstallId.slice(0, 8)})`)

        if (!isStillValid) {
          console.warn('praxis: installation revoked — re-registering...')
          try {
            await Promise.race([
              client.registerIdentity?.(),
              new Promise((_, rej) => setTimeout(() => rej(new Error('registerIdentity timeout')), 10000))
            ])
            dbg('praxis: re-registered')
          } catch (regErr) {
            console.warn('praxis: re-registration failed:', regErr?.message, '— continuing with existing client')
          }
        }

        // Always request history sync from other installations (phone, other browsers)
        // This ensures conversations created on other devices appear here
        if (installations.length > 1) {
          dbg(`praxis: ${installations.length} installations — requesting history sync...`)
          try { await client.sendSyncRequest() } catch (e) { dbg('praxis: sendSyncRequest:', e?.message) }
        }

        // Persistent sync loop — keep syncing until inactive groups reactivate
        // or we've waited long enough. Other installations need time to respond.
        let inactiveCount = 0
        for (let attempt = 0; attempt < 2; attempt++) {
          await (client.conversations.syncAll?.(['allowed', 'unknown']) || client.conversations.sync())
          const convos = await client.conversations.list()
          inactiveCount = 0
          for (const c of convos) {
            try {
              const active = typeof c.isActive === 'function' ? await c.isActive() : true
              if (!active) inactiveCount++
            } catch {}
          }
          if (inactiveCount === 0) break
          dbg(`praxis: sync attempt ${attempt + 1}/2 — ${inactiveCount} inactive conversations, waiting...`)
          await new Promise(r => setTimeout(r, 3000))
        }
        if (inactiveCount > 0) {
          dbg(`praxis: ${inactiveCount} conversations still inactive after sync — they'll reactivate when peers come online`)
        }
      }
    } catch (e) { dbg('praxis: installation/sync check failed:', e?.message) }

    await _loadConversations(address)
    _initInFlight = false

    // Periodic sync to discover new DMs (every 30s) while on Messages page
    const _msgSyncInterval = setInterval(async () => {
      try {
        const before = (await client.conversations.list()).length
        await (client.conversations.syncAll?.(['allowed', 'unknown']) || client.conversations.sync())
        const after = (await client.conversations.list()).length
        if (after > before) {
          dbg(`praxis: discovered ${after - before} new conversation(s)`)
          await _loadConversations(address)
        }
      } catch {}
    }, 30000)
    window.addEventListener('spa-navigate', () => clearInterval(_msgSyncInterval), { once: true })
  } catch (e) {
    _initInFlight = false
    const msg = e.message || ''
    const loadingEl = document.getElementById('messages-loading')
    if (msg.includes('Access Handle') || msg.includes('OPFS') || msg.includes('sync access')) {
      if (loadingEl) loadingEl.innerHTML = '<div style="color:var(--muted);padding:1em">messaging is open in another tab. close other tabs and refresh.</div>'
    } else {
      if (loadingEl) loadingEl.innerHTML = `<div style="color:var(--muted);padding:1em">could not connect to messaging. try refreshing.</div>`
    }
    console.warn('praxis: XMTP init error:', msg)
  }
}

// Shared helper: resolve artist domains/inboxes, load conversations, start unread stream.
// Called both after fresh client creation and when reusing a cached client.
async function _loadConversations(address) {
    // addrToDomain starts empty — resolved on demand as conversations load
    addrToDomain = {}

    // Pre-build domain map from registered artists+supporters.
    // CAPPED at 5 pages × 200 = 1000 entries each so this scales to 1M+ users — the long
    // tail is resolved on-demand per conversation via domainForInbox()/resolveDomain().
    const MAX_PREFETCH_PAGES = 5
    const allArtistAddrs = []
    try {
      let cursor = null
      let hasMore = true
      let pages = 0
      while (hasMore && pages < MAX_PREFETCH_PAGES) {
        const safeCursor = cursor ? cursor.replace(/[^a-zA-Z0-9+/=_-]/g, '') : null
        const afterArg = safeCursor ? `, after: "${safeCursor}"` : ''
        const artistRes = await query(`{ artists(limit: 200${afterArg}) { items { id domain } pageInfo { endCursor hasNextPage } } }`)
        const artists = artistRes?.artists?.items || []
        for (const artist of artists) {
          const lc = artist.id.toLowerCase()
          addrToDomain[lc] = artist.domain
          allArtistAddrs.push(lc)
        }
        cursor = artistRes?.artists?.pageInfo?.endCursor || null
        hasMore = artistRes?.artists?.pageInfo?.hasNextPage || false
        pages++
      }
    } catch (e) { console.warn('praxis: artist domain pre-resolution failed:', e?.message) }

    // Also resolve supporters (they have handles, not domains) — same cap
    try {
      let cursor = null
      let hasMore = true
      let pages = 0
      while (hasMore && pages < MAX_PREFETCH_PAGES) {
        const safeCursor = cursor ? cursor.replace(/[^a-zA-Z0-9+/=_-]/g, '') : null
        const afterArg = safeCursor ? `, after: "${safeCursor}"` : ''
        const supRes = await query(`{ supporters(limit: 200${afterArg}) { items { id handle } pageInfo { endCursor hasNextPage } } }`)
        const supporters = supRes?.supporters?.items || []
        for (const s of supporters) {
          const lc = s.id.toLowerCase()
          if (!addrToDomain[lc]) addrToDomain[lc] = s.handle
        }
        cursor = supRes?.supporters?.pageInfo?.endCursor || null
        hasMore = supRes?.supporters?.pageInfo?.hasNextPage || false
        pages++
      }
    } catch (e) { console.warn('praxis: supporter domain pre-resolution failed:', e?.message) }

    // Batch-resolve inbox IDs concurrently (chunks of 10, not sequential N+1)
    async function batchResolveInboxIds(addrs) {
      if (!client || !sdk) return
      const CHUNK = 10
      for (let i = 0; i < addrs.length; i += CHUNK) {
        const chunk = addrs.slice(i, i + CHUNK)
        await Promise.all(chunk.map(async (addr) => {
          if (inboxToAddr[addr]) return
          try {
            if (typeof client.fetchInboxIdByIdentifier === 'function') {
              const id = await client.fetchInboxIdByIdentifier({
                identifier: addr,
                identifierKind: sdk.IdentifierKind?.Ethereum ?? 0,
              })
              if (id) { setInboxToAddr(id, addr); setInboxToAddr(addr, id) }
            } else if (typeof client.findInboxIdByAddress === 'function') {
              const id = await client.findInboxIdByAddress(addr)
              if (id) { setInboxToAddr(id, addr); setInboxToAddr(addr, id) }
            }
          } catch {}
        }))
      }
    }
    // Run inbox resolution in background (don't block conversation loading)
    batchResolveInboxIds(allArtistAddrs).then(() => {
      // update conversation names in-place after inbox IDs resolve
      if (_msgItems.length > 0) {
        for (const item of _msgItems) {
          if (item.peerInboxId && !item.isGroup) {
            const resolved = domainForInbox(item.peerInboxId)
            if (resolved !== item.peerDomain) {
              item.peerDomain = resolved
              const el = document.querySelector(`.msg-convo-item[data-idx="${_msgItems.indexOf(item)}"] .msg-convo-peer`)
              if (el) {
                const dot = el.querySelector('.msg-unread-dot')
                el.textContent = resolved
                if (dot) el.prepend(dot)
              }
            }
          }
        }
      }
    }).catch(() => {})

    const loadingEl = document.getElementById('messages-loading')
    if (loadingEl) loadingEl.style.display = 'none'
    await loadConversations()

    // start global message stream for unread dot on dock
    startUnreadStream()
}

// --- Unread message dot on dock ---
let _unreadStream = null

function showMsgDot() {
  if (window.location.pathname.startsWith('/messages')) return // don't show dot when already on messages
  const dot = document.getElementById('dock-msg-dot')
  if (dot) { dot.style.display = ''; dot.textContent = '' } // never show count, just dot
  try { sessionStorage.setItem('praxis-unread-msgs', '1') } catch {}
}

async function startUnreadStream() {
  if (_unreadStream || !client) return
  try {
    _unreadStream = await client.conversations.streamAllMessages()
    const myInboxId = client.inboxId
    for await (const msg of _unreadStream) {
      if (msg.senderInboxId === myInboxId) continue
      // Filter out control messages (typing indicators, read receipts)
      const msgText = extractText(msg)
      if (!msgText) continue
      // new message from someone else
      if (!window.location.pathname.startsWith('/messages')) {
        showMsgDot()
        showMsgToast(msg)
      }
      // Broadcast unread status to other tabs
      window._xmtpBroadcast?.postMessage({ type: 'unread', conversationId: msg.conversationId })
    }
  } catch (e) {
    const errMsg = e?.message || ''
    console.warn('praxis: unread stream error:', errMsg)
    _unreadStream = null
    // SecretReuseError recovery: re-sync and restart the stream
    if (errMsg.includes('SecretReuse') || errMsg.includes('epoch') || errMsg.includes('Welcome')) {
      console.warn('praxis: MLS unread stream error, re-syncing and restarting...')
      try {
        await client.conversations.sync()
        await new Promise(r => setTimeout(r, 2000))
        startUnreadStream()
      } catch (recErr) { console.warn('praxis: unread stream recovery failed:', recErr?.message) }
    }
  }
}

async function showMsgToast(msg) {
  // Double-check: skip typing/read control messages that slipped past extractText
  // Check all possible content locations — XMTP v3 can nest content in various shapes
  const rawText = typeof msg.content === 'string' ? msg.content : msg.content?.text || msg.content?.content || ''
  const fullDump = JSON.stringify(msg.content || '')
  if (rawText.includes('praxis:typing:') || rawText.includes('praxis:read:') ||
      fullDump.includes('praxis:typing:') || fullDump.includes('praxis:read:') ||
      rawText.includes('\x00praxis:') || fullDump.includes('\\u0000praxis:')) return

  // Stack toasts — shift existing ones up
  document.querySelectorAll('.msg-toast').forEach(t => {
    const cur = parseInt(t.style.bottom) || 50
    t.style.bottom = `${cur + 70}px`
  })
  // Cap at 4 visible toasts
  const all = document.querySelectorAll('.msg-toast')
  if (all.length >= 4) all[0].remove()
  // resolve sender domain — try cached, then fetchInboxStates, then Ponder
  let sender = msg.senderInboxId ? (inboxToAddr[msg.senderInboxId] || '') : ''
  let domain = ''
  // if no cached address for this inbox ID, try fetchInboxStates then conversation lookup
  if (!sender && msg.senderInboxId && sdk) {
    try {
      const states = await sdk.Client.fetchInboxStates?.([msg.senderInboxId], 'production')
      if (Array.isArray(states) && states[0]) {
        const ids = states[0].accountIdentifiers || states[0].accountAddresses || states[0].identifiers || []
        for (const id of ids) {
          const a = typeof id === 'string' ? id : id?.identifier || id?.address
          if (a && /^0x[0-9a-f]{40}$/i.test(a)) { sender = a.toLowerCase(); break }
        }
        if (!sender && states[0].recoveryIdentifier) {
          const ri = typeof states[0].recoveryIdentifier === 'string' ? states[0].recoveryIdentifier : states[0].recoveryIdentifier?.identifier
          if (ri && /^0x[0-9a-f]{40}$/i.test(ri)) sender = ri.toLowerCase()
        }
        if (sender) {
          setInboxToAddr(msg.senderInboxId, sender)
          setInboxToAddr(sender, msg.senderInboxId)
        }
      }
    } catch (e) { console.warn('fetchInboxStates failed:', e?.message) }
    // fallback: try to find the conversation and get peer inbox ID -> resolve
    if (!sender && client && msg.conversationId) {
      try {
        await client.conversations.sync()
        const convos = await client.conversations.list()
        const convo = convos.find(c => c.id === msg.conversationId)
        if (convo) {
          const members = await convo.members?.() || []
          for (const m of members) {
            if (m.inboxId !== client.inboxId) {
              const addrs = m.accountIdentifiers || m.addresses || []
              for (const a of addrs) {
                const addr = typeof a === 'string' ? a : a?.identifier || a?.address
                if (addr && /^0x[0-9a-f]{40}$/i.test(addr)) {
                  sender = addr.toLowerCase()
                  setInboxToAddr(msg.senderInboxId, sender)
                  break
                }
              }
              break
            }
          }
        }
      } catch {}
    }
  }
  if (sender) {
    domain = addrToDomain[sender] || ''
    if (!domain) {
      try {
        const { resolveAddresses } = await import('./utils.js')
        const { query } = await import('./ponder.js')
        const map = await resolveAddresses(query, [sender])
        if (map[sender]) { domain = map[sender]; addrToDomain[sender] = domain }
      } catch {}
    }
    if (!domain) domain = sender.slice(0, 6) + '...' + sender.slice(-4)
  }
  // last resort: try domainForInbox which checks inboxToAddr + addrToDomain caches
  if (!domain && msg.senderInboxId) {
    const resolved = domainForInbox(msg.senderInboxId)
    if (resolved && !resolved.includes('...')) domain = resolved
  }
  if (!domain) domain = msg.senderInboxId?.slice(0, 10) + '...'
  const text = typeof msg.content === 'string' ? msg.content.slice(0, 60) : 'new message'
  const { toast } = await import('./toast.js')
  toast(`<strong style="color:var(--accent)">${escapeHtml(domain)}</strong> ${escapeHtml(text)}`, {
    type: 'message', html: true, duration: 8000,
    onClick: () => { window.location.href = '/messages' },
  })
}

// expose stream starter globally so wallet.js can init on any page
window._startXmtpUnreadStream = startUnreadStream

// restore dot from session on SPA navigate
window.addEventListener('spa-navigate', () => {
  if (sessionStorage.getItem('praxis-unread-msgs') && !window.location.pathname.startsWith('/messages')) {
    showMsgDot()
  }
})

function domainForInbox(inboxId) {
  const addr = inboxToAddr[inboxId]
  if (addr) {
    const lc = addr.toLowerCase()
    const domain = addrToDomain[lc] || addrToDomain[addr]
    if (domain) return domain
    // lazy resolve in background — will show on next render
    resolveAddresses(query, [lc]).then(map => {
      if (map[lc]) {
        addrToDomain[lc] = map[lc]
        // update any visible conversation items with this address
        document.querySelectorAll('.msg-convo-peer').forEach(el => {
          if (el.textContent === lc.slice(0, 6) + '...' + lc.slice(-4)) {
            el.textContent = map[lc]
          }
        })
        // update chat header if showing this address
        const header = document.getElementById('msg-peer-name')
        if (header?.textContent === lc.slice(0, 6) + '...' + lc.slice(-4)) {
          header.textContent = map[lc]
        }
      }
    }).catch(() => {})
    // fallback: show shortened address instead of inbox ID
    return lc.slice(0, 6) + '...' + lc.slice(-4)
  }
  // emergency async resolve — all 4 approaches failed, try fetchInboxStates in background
  if (inboxId && sdk) {
    (async () => {
      try {
        const states = await sdk.Client.fetchInboxStates?.([inboxId], 'production')
        if (!Array.isArray(states) || !states[0]) return
        const state = states[0]
        let resolved = null
        for (const field of ['accountIdentifiers', 'accountAddresses', 'identifiers']) {
          for (const id of (state[field] || [])) {
            const a = typeof id === 'string' ? id : id?.identifier || id?.address
            if (a && /^0x[0-9a-f]{40}$/i.test(a)) { resolved = a.toLowerCase(); break }
          }
          if (resolved) break
        }
        if (!resolved && state.recoveryIdentifier) {
          const ri = typeof state.recoveryIdentifier === 'string' ? state.recoveryIdentifier : state.recoveryIdentifier?.identifier
          if (ri && /^0x[0-9a-f]{40}$/i.test(ri)) resolved = ri.toLowerCase()
        }
        if (!resolved) return
        setInboxToAddr(inboxId, resolved)
        setInboxToAddr(resolved, inboxId)
        const map = await resolveAddresses(query, [resolved]).catch(() => ({}))
        const name = map[resolved] || resolved.slice(0, 6) + '...' + resolved.slice(-4)
        if (map[resolved]) addrToDomain[resolved] = map[resolved]
        const short = inboxId.slice(0, 8) + '...'
        document.querySelectorAll('.msg-convo-peer').forEach(el => {
          if (el.textContent === short) el.textContent = name
        })
        const header = document.getElementById('msg-peer-name')
        if (header?.textContent === short) header.textContent = name
      } catch {}
    })()
  }
  return inboxId?.slice(0, 8) + '...'
}

// Lazy inbox ID resolution — only resolve when needed (single address)
async function resolveInboxIdForAddr(addr) {
  if (inboxToAddr[addr]) return inboxToAddr[addr]
  if (!client || !sdk) return null
  // Try findInboxIdByIdentifier first, then findInboxIdByAddress
  try {
    if (typeof client.findInboxIdByIdentifier === 'function') {
      const id = await client.findInboxIdByIdentifier({
        identifier: addr,
        identifierKind: sdk.IdentifierKind.Ethereum,
      })
      if (id) { setInboxToAddr(id, addr); setInboxToAddr(addr, id); return id }
    }
  } catch (e) { console.warn('praxis: resolveInboxIdForAddr findInboxIdByIdentifier:', e?.message) }
  try {
    if (typeof client.findInboxIdByAddress === 'function') {
      const id = await client.findInboxIdByAddress(addr)
      if (id) { setInboxToAddr(id, addr); setInboxToAddr(addr, id); return id }
    }
  } catch (e) { console.warn('praxis: resolveInboxIdForAddr findInboxIdByAddress:', e?.message) }
  try {
    if (typeof client.fetchInboxIdByIdentifier === 'function') {
      const id = await client.fetchInboxIdByIdentifier({
        identifier: addr,
        identifierKind: sdk.IdentifierKind.Ethereum,
      })
      if (id) { setInboxToAddr(id, addr); setInboxToAddr(addr, id); return id }
    }
  } catch (e) { console.warn('praxis: resolveInboxIdForAddr fetchInboxIdByIdentifier:', e?.message) }
  return null
}

function extractText(m) {
  if (!m) return null
  let txt = null
  if (typeof m.content === 'string') txt = m.content
  else if (m.content?.text) txt = m.content.text
  else if (m.content?.content) txt = m.content.content
  if (txt !== null && typeof txt === 'string') {
    // Filter praxis control messages (read receipts, typing indicators) so they
    // never render as visible bubbles. They are still delivered over the normal
    // message stream and handled in the activeStream iterator.
    if (txt.startsWith(PX_READ_PREFIX) || txt.startsWith(PX_TYPING_PREFIX) || txt.startsWith('praxis:typing:') || txt.startsWith('praxis:read:')) return null
    return txt
  }
  if (m.contentType?.typeId === 'group_updated') return null
  if (m.kind !== undefined && m.kind !== 1) return null
  if (typeof m.content === 'object' && m.content !== null) {
    if (m.content.initiatedByInboxId || m.content.addedInboxes) return null
  }
  return null
}

// Return the raw string content of a message (bypasses the sentinel filter).
// Used by the stream iterator to inspect praxis control messages.
function rawMessageText(m) {
  if (!m) return null
  if (typeof m.content === 'string') return m.content
  if (m.content?.text) return m.content.text
  if (m.content?.content) return m.content.content
  return null
}

// Find the sentAtNs of the most recent non-self VISIBLE (non-control) message.
function findLatestIncomingNs(messages) {
  const myInboxId = client?.inboxId
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || m.senderInboxId === myInboxId) continue
    const raw = rawMessageText(m)
    if (!raw) continue
    if (typeof raw === 'string' && (raw.startsWith(PX_READ_PREFIX) || raw.startsWith(PX_TYPING_PREFIX))) continue
    if (!extractText(m)) continue
    if (m.sentAtNs) return String(m.sentAtNs)
  }
  return null
}

// Handle a praxis control message. Returns true if m was a control message and
// the caller should skip normal rendering. Safe to call on any message.
function handlePraxisControlMessage(m, convo) {
  const raw = rawMessageText(m)
  if (!raw || typeof raw !== 'string') return false
  const myInboxId = client?.inboxId
  // Ignore our own control messages (echoed by the stream).
  if (m.senderInboxId === myInboxId) {
    return raw.startsWith(PX_READ_PREFIX) || raw.startsWith(PX_TYPING_PREFIX)
  }
  if (raw.startsWith(PX_READ_PREFIX)) {
    const ns = raw.slice(PX_READ_PREFIX.length).trim()
    if (ns && /^\d+$/.test(ns)) {
      const prev = _peerReadWatermark.get(convo.id) || '0'
      // Keep the max (string-compare since length is stable for ns timestamps)
      if (ns.length > prev.length || (ns.length === prev.length && ns > prev)) {
        boundedSet(_peerReadWatermark, convo.id, ns)
        applyReadReceiptsToDom(convo.id, ns)
      }
    }
    return true
  }
  if (raw.startsWith(PX_TYPING_PREFIX)) {
    boundedSet(_peerTypingAt, convo.id, Date.now())
    if (convo.id === activeConvo?.id) showTypingIndicator()
    return true
  }
  return false
}

// Mark outgoing bubbles up to and including sentAtNs as "seen", then refresh
// the single status indicator on the last outgoing bubble.
function applyReadReceiptsToDom(convoId, watermarkNs) {
  if (activeConvo?.id !== convoId) return
  let wm
  try { wm = BigInt(watermarkNs) } catch { return }
  const el = document.getElementById('messages-msgs')
  if (!el) return
  el.querySelectorAll('.dm-msg.dm-msg-mine').forEach(mEl => {
    const ns = mEl.dataset.sentNs
    if (!ns) return
    try {
      if (BigInt(ns) <= wm) {
        mEl.classList.add('dm-msg-seen')
      }
    } catch {}
  })
  updateLastReceiptIndicator()
}

// Render a single "sent" / "read" status pill below the LAST outgoing bubble
// in the active conversation. Replaces the previous per-message ✓✓ which
// felt cluttered. Status logic:
//   - "read" if the last outgoing bubble has dm-msg-seen (peer read receipt
//     watermark covers it)
//   - "sent" otherwise (it left this device successfully)
// Hidden in groups (no per-peer read state) and when the last message is
// incoming (no status to show).
function updateLastReceiptIndicator() {
  const el = document.getElementById('messages-msgs')
  if (!el) return
  // Remove any existing indicator first
  el.querySelector('.dm-last-receipt')?.remove()
  if (activeIsGroup) return
  const mineList = el.querySelectorAll('.dm-msg.dm-msg-mine')
  if (!mineList.length) return
  const lastMine = mineList[mineList.length - 1]
  // Only show on the LAST message overall — if a peer message came after,
  // don't render the receipt (the conversation moved on)
  const allMsgs = el.querySelectorAll('.dm-msg')
  if (allMsgs[allMsgs.length - 1] !== lastMine) return
  const isRead = lastMine.classList.contains('dm-msg-seen')
  const indicator = document.createElement('div')
  indicator.className = 'dm-last-receipt'
  indicator.setAttribute('aria-label', isRead ? 'read' : 'sent')
  indicator.textContent = isRead ? 'read' : 'sent'
  indicator.style.cssText = `text-align:right;font-size:0.7em;color:${isRead ? 'var(--accent)' : 'var(--muted)'};margin-top:0.2em;padding-right:0.5ch`
  lastMine.appendChild(indicator)
}

// Show the "peer is typing..." indicator in the active chat. Auto-hides after
// TYPING_DISPLAY_MS of silence.
function showTypingIndicator() {
  let el = document.getElementById('messages-typing-indicator')
  if (!el) {
    const msgs = document.getElementById('messages-msgs')
    if (!msgs) return
    el = document.createElement('div')
    el.id = 'messages-typing-indicator'
    el.className = 'dm-typing-indicator'
    el.style.cssText = 'color:var(--muted);font-size:0.8em;font-style:italic;padding:0.4em 1ch'
    msgs.parentElement?.insertBefore(el, msgs.nextSibling)
  }
  const peerName = activeIsGroup ? 'someone' : (document.getElementById('messages-peer-name')?.textContent || 'peer')
  el.textContent = `${peerName} is typing...`
  el.style.display = ''
  if (_typingIndicatorTimer) clearTimeout(_typingIndicatorTimer)
  _typingIndicatorTimer = setTimeout(() => {
    const n = document.getElementById('messages-typing-indicator')
    if (n) n.style.display = 'none'
  }, TYPING_DISPLAY_MS)
}

function hideTypingIndicator() {
  const el = document.getElementById('messages-typing-indicator')
  if (el) el.style.display = 'none'
  if (_typingIndicatorTimer) { clearTimeout(_typingIndicatorTimer); _typingIndicatorTimer = null }
}

// Send a read receipt for the latest incoming message in the active conversation.
async function sendReadReceipt(convo, latestIncomingNs) {
  if (!convo || !latestIncomingNs) return
  if (window._xmtpClientIsReadOnly) return // read-only client can't send
  try {
    await convo.sendText(`${PX_READ_PREFIX}${latestIncomingNs}`)
  } catch (e) {
    // Don't surface — read receipts are best-effort
    console.debug('praxis: read receipt send failed:', e?.message)
  }
}

// Send a typing indicator, rate-limited to one every TYPING_SEND_INTERVAL_MS.
async function sendTypingIndicator() {
  if (!activeConvo) return
  if (window._xmtpClientIsReadOnly) return
  const now = Date.now()
  if (now - _lastTypingSentAt < TYPING_SEND_INTERVAL_MS) return
  _lastTypingSentAt = now
  try {
    await activeConvo.sendText(`${PX_TYPING_PREFIX}${now}`)
  } catch (e) {
    console.debug('praxis: typing indicator send failed:', e?.message)
  }
}

function relativeTime(ms) {
  const diff = Date.now() - ms
  if (diff < 60000) return t('time.now')
  if (diff < 3600000) return t('time.minutes', { m: Math.floor(diff / 60000) })
  if (diff < 86400000) return t('time.hours', { h: Math.floor(diff / 3600000) })
  return t('time.days', { d: Math.floor(diff / 86400000) })
}

// --- Conversation list ---

const CONVO_PAGE_SIZE = 50
const CONVO_CHUNK = 10
// _bgSyncKicked is declared near the top of the file (hoisted for teardown handler).

async function loadConversations() {
  if (!client) { console.warn('praxis: loadConversations skipped — no client'); return }

  const listEl = document.getElementById('messages-list')
  dbg('praxis: loadConversations starting', { hasListEl: !!listEl })

  try {
    // Fix 7 (H7): render cached convos from OPFS immediately, then kick off
    // syncAll in the background. Previously this waited up to 17s (initial
    // syncAll + three retry delays) before painting anything.
    let all = []
    try { all = await client.conversations.list({ limit: BigInt(CONVO_PAGE_SIZE) }) }
    catch { all = await client.conversations.list() }
    dbg(`praxis: cached list done, ${all.length} conversations (pre-sync)`)

    // Kick off background syncAll + re-render when it completes. We only
    // re-render if the convo count changed to avoid churning the DOM.
    // Guard so a re-render triggered by the bg sync doesn't fire another bg
    // sync in an infinite loop.
    if (!_bgSyncKicked) {
      _bgSyncKicked = true
      ;(async () => {
        try {
          await (client.conversations.syncAll?.(['allowed', 'unknown']) || client.conversations.sync())
          let fresh = []
          try { fresh = await client.conversations.list({ limit: BigInt(CONVO_PAGE_SIZE) }) }
          catch { fresh = await client.conversations.list() }
          if (fresh.length !== conversations.length) {
            dbg(`praxis: bg sync changed convo count ${conversations.length} -> ${fresh.length}, re-rendering`)
            loadConversations()
          }
        } catch (e) { console.warn('praxis: bg syncAll failed:', e?.message) }
      })()
    }

    // Note: we do NOT create new DMs to "stitch" inactive conversations.
    // Per XMTP docs, inactive groups reactivate automatically when other
    // members sync. Creating new DMs causes duplicates and makes things worse.

    // Deduplicate conversations by peer — prefer active over inactive
    const peerMap = new Map() // peerId -> conversation (prefer active)
    const nonDm = [] // groups without peerInboxId
    for (const c of all) {
      try {
        const peerId = await c.peerInboxId?.()
        if (peerId) {
          const existing = peerMap.get(peerId)
          if (!existing) {
            peerMap.set(peerId, c)
          } else {
            // Keep the active one, or the newer one if both same state
            const existActive = typeof existing.isActive === 'function' ? await existing.isActive() : true
            const newActive = typeof c.isActive === 'function' ? await c.isActive() : true
            if (newActive && !existActive) peerMap.set(peerId, c)
          }
        } else {
          nonDm.push(c)
        }
      } catch { nonDm.push(c) }
    }
    all = [...peerMap.values(), ...nonDm]

    conversations = all
    dbg(`praxis: loaded ${all.length} conversations`)

    // Process conversations in parallel chunks of CONVO_CHUNK
    const items = []
    for (let i = 0; i < conversations.length; i += CONVO_CHUNK) {
      const chunk = conversations.slice(i, i + CONVO_CHUNK)
      const results = await Promise.all(chunk.map(async (convo) => {
        let c = convo
        // sync individual conversation to get latest messages
        try { await c.sync() } catch (e) {
          const msg = e?.message || ''
          if (msg.includes('inactive') || msg.includes('GroupError') || msg.includes('GroupInactive')) {
            // Try to stitch: create a new DM to replace the inactive group
            try {
              const peerInbox = await c.peerInboxId?.()
              if (peerInbox && client) {
                dbg('praxis: stitching inactive conversation with', peerInbox.slice(0, 8))
                const newC = await (client.conversations.getDmByInboxId?.(peerInbox) || client.conversations.createDm?.(peerInbox))
                if (newC) {
                  try { await newC.sync() } catch {}
                  c = newC
                } else {
                  return null // can't stitch, skip
                }
              } else {
                return null // no peer to stitch to
              }
            } catch (se) {
              console.warn('praxis: stitch failed:', se?.message)
              return null
            }
          } else {
            // Non-inactive sync error — log but continue with cached messages
            console.warn('praxis: sync failed for convo', c.id?.slice(0, 8), msg.slice(0, 60))
          }
        }
        const lastMsg = await c.lastMessage().catch((e) => { console.warn('praxis: lastMessage() failed:', e?.message); return null })
        let peerInboxId = null, isGroup = false, displayName = t('messages.unknown')
        try {
          peerInboxId = await c.peerInboxId()
          // resolve inbox ID to address — try multiple approaches
          if (peerInboxId && !inboxToAddr[peerInboxId]) {
            // Approach 1: members() on the conversation
            try {
              const members = typeof c.members === 'function' ? await c.members() : c.members || []
              for (const m of (members || [])) {
                const mAddr = m.addresses?.[0]?.toLowerCase() || m.accountAddresses?.[0]?.toLowerCase() || m.accountAddress?.toLowerCase()
                if (mAddr && m.inboxId) {
                  setInboxToAddr(m.inboxId, mAddr)
                  setInboxToAddr(mAddr, m.inboxId)
                  // also populate domain if we have it
                  if (!addrToDomain[mAddr]) {
                    const domainMap = await resolveAddresses(query, [mAddr]).catch(() => ({}))
                    if (domainMap[mAddr]) addrToDomain[mAddr] = domainMap[mAddr]
                  }
                }
              }
            } catch (e) { console.warn('praxis: members() failed:', e?.message) }
          }
          // Approach 2: getAddressFromInboxId (may exist on some SDK versions)
          if (peerInboxId && !inboxToAddr[peerInboxId] && client) {
            try {
              const addr = await client.getAddressFromInboxId?.(peerInboxId)
              if (addr) {
                setInboxToAddr(peerInboxId, addr.toLowerCase())
                setInboxToAddr(addr.toLowerCase(), peerInboxId)
              }
            } catch {}
          }
          // Approach 3: inboxState to get associated addresses
          if (peerInboxId && !inboxToAddr[peerInboxId] && client) {
            try {
              if (typeof client.inboxState === 'function') {
                const state = await client.inboxState([peerInboxId], false)
                const entries = state || []
                for (const entry of (Array.isArray(entries) ? entries : [entries])) {
                  const addr = entry?.accountAddresses?.[0]?.toLowerCase() || entry?.addresses?.[0]?.toLowerCase()
                  if (addr) {
                    setInboxToAddr(peerInboxId, addr)
                    setInboxToAddr(addr, peerInboxId)
                    if (!addrToDomain[addr]) {
                      const domainMap = await resolveAddresses(query, [addr]).catch(() => ({}))
                      if (domainMap[addr]) addrToDomain[addr] = domainMap[addr]
                    }
                  }
                }
              }
            } catch (e) { console.warn('praxis: inboxState failed:', e?.message) }
          }
          // Approach 4: fetchInboxStates as ultimate fallback
          if (peerInboxId && !inboxToAddr[peerInboxId] && sdk) {
            try {
              const states = await sdk.Client.fetchInboxStates?.([peerInboxId], 'production')
              if (Array.isArray(states) && states[0]) {
                const state = states[0]
                // try multiple structures the SDK might return
                let addr = null
                // v7+: state.accountIdentifiers or state.accountAddresses
                const identifiers = state.accountIdentifiers || state.accountAddresses || state.identifiers || []
                for (const id of identifiers) {
                  const a = typeof id === 'string' ? id : id?.identifier || id?.address || id?.accountAddress
                  if (a && /^0x[0-9a-f]{40}$/i.test(a)) { addr = a; break }
                }
                // fallback: check recovery address
                if (!addr && state.recoveryIdentifier) {
                  const ri = typeof state.recoveryIdentifier === 'string' ? state.recoveryIdentifier : state.recoveryIdentifier?.identifier
                  if (ri && /^0x[0-9a-f]{40}$/i.test(ri)) addr = ri
                }
                // fallback: dig into installations
                if (!addr && state.installations?.length) {
                  for (const inst of state.installations) {
                    const candidates = inst.accountAddresses || inst.accountIdentifiers || inst.members || []
                    for (const c of candidates) {
                      const a = typeof c === 'string' ? c : c?.identifier || c?.address
                      if (a && /^0x[0-9a-f]{40}$/i.test(a)) { addr = a; break }
                    }
                    if (addr) break
                  }
                }
                if (addr) {
                  addr = addr.toLowerCase()
                  setInboxToAddr(peerInboxId, addr)
                  setInboxToAddr(addr, peerInboxId)
                  if (!addrToDomain[addr]) {
                    const domainMap = await resolveAddresses(query, [addr]).catch(() => ({}))
                    if (domainMap[addr]) addrToDomain[addr] = domainMap[addr]
                  }
                } else {
                  try { console.warn('praxis: fetchInboxStates returned no address for', peerInboxId?.slice(0, 8), Object.keys(state)) } catch {}
                }
              }
            } catch (e) { console.warn('praxis: fetchInboxStates fallback:', e?.message) }
          }
          trimInboxToAddr()
          displayName = peerInboxId ? domainForInbox(peerInboxId) : t('messages.unknown')
        } catch {
          isGroup = true
          displayName = c.name || t('messages.unnamedGroup')
        }
        // If the last message is a control message (read receipt / typing indicator),
        // its text is null after extractText. Fall back to the PREVIOUS real message
        // for the conversation preview so the list always shows meaningful text.
        let text = extractText(lastMsg)
        let previewMsg = lastMsg
        // Check if last message is a reaction (contentType includes 'reaction')
        const isReaction = lastMsg?.contentType?.typeId === 'reaction' || lastMsg?.content?.action === 'added' || lastMsg?.content?.schema === 'unicode'
        if (!text && lastMsg) {
          if (isReaction) {
            text = 'reacted to a message'
            // Use lastMsg for timestamp/unread (reaction IS the latest activity)
          } else {
            try {
              const recent = await c.messages().catch(() => [])
              for (let i = recent.length - 1; i >= 0; i--) {
                const rm = recent[i]
                // Check if it's a reaction
                if (rm.contentType?.typeId === 'reaction' || rm.content?.action === 'added') {
                  text = 'reacted to a message'
                  previewMsg = rm
                  break
                }
                const t = extractText(rm)
                if (t) { text = t; previewMsg = rm; break }
              }
            } catch {}
          }
        }
        // Use the actual last message timestamp for unread (not the preview text message)
        const lastMsgTs = lastMsg?.sentAtNs ? Number(lastMsg.sentAtNs) : (previewMsg?.sentAtNs ? Number(previewMsg.sentAtNs) : 0)
        const time = lastMsgTs ? relativeTime(lastMsgTs / 1e6) : ''
        // check if conversation has unread messages (last message is from someone else)
        const myInboxId = client.inboxId
        const lastSeen = parseInt(localStorage.getItem(`praxis:msg-seen:${c.id}`) || '0', 10)
        // lastMsgTs is nanoseconds, lastSeen is nanoseconds (stored as nanos since fix)
        const isUnread = lastMsg && lastMsg.senderInboxId !== myInboxId && lastMsgTs > lastSeen
        // Clean attachment markdown for preview
        let preview = text || ''
        if (preview.includes('[image:')) preview = preview.replace(/\[image:[^\]]*\]\([^)]+\)/g, 'sent an image').trim()
        if (preview.includes('[video:')) preview = preview.replace(/\[video:[^\]]*\]\([^)]+\)/g, 'sent a video').trim()
        if (preview.includes('[pdf:')) preview = preview.replace(/\[pdf:[^\]]*\]\([^)]+\)/g, 'sent a PDF').trim()
        return { convo: c, peerDomain: displayName, preview, time, peerInboxId, isGroup, lastMsgTs, isUnread }
      }))
      items.push(...results.filter(Boolean))
    }

    // batch-resolve all peer addresses to domains before rendering
    const unresolvedAddrs = items
      .filter(i => !i.isGroup && i.peerInboxId && inboxToAddr[i.peerInboxId])
      .map(i => inboxToAddr[i.peerInboxId].toLowerCase())
      .filter(a => !addrToDomain[a])
    if (unresolvedAddrs.length > 0) {
      const domainMap = await resolveAddresses(query, [...new Set(unresolvedAddrs)]).catch(() => ({}))
      Object.assign(addrToDomain, domainMap)
      // re-compute display names for resolved addresses
      for (const item of items) {
        if (!item.isGroup && item.peerInboxId) {
          const resolved = domainForInbox(item.peerInboxId)
          if (resolved !== item.peerDomain) item.peerDomain = resolved
        }
      }
    }

    // filter: only show conversations with mutual follows (or groups)
    let mutualAddrs = new Set()
    try {
      const myAddr = window.getWalletAddress?.()?.toLowerCase()
      if (myAddr) {
        // H5: cursor-based pagination for follows, pages of 200, capped at 2000
        async function fetchAllFollows(field, extractKey) {
          const items = []
          let cursor = null
          for (let page = 0; page < 10; page++) {
            const vars = { me: myAddr }
            if (cursor) vars.after = cursor
            const data = await query(`query($me: String!${cursor ? ', $after: String' : ''}) { follows(where: { ${field}: $me }, limit: 200${cursor ? ', after: $after' : ''}) { items { ${extractKey} } pageInfo { endCursor hasNextPage } } }`, vars).catch(() => ({ follows: { items: [], pageInfo: {} } }))
            items.push(...(data.follows?.items || []))
            if (items.length >= 2000 || !data.follows?.pageInfo?.hasNextPage) break
            cursor = data.follows.pageInfo.endCursor
          }
          return items
        }
        const [followingItems, followerItems] = await Promise.all([
          fetchAllFollows('follower', 'followed'),
          fetchAllFollows('followed', 'follower'),
        ])
        const followingData = { follows: { items: followingItems } }
        const followersData = { follows: { items: followerItems } }
        const following = new Set((followingData.follows?.items || []).map(f => f.followed.toLowerCase()))
        const followers = new Set((followersData.follows?.items || []).map(f => f.follower.toLowerCase()))
        for (const addr of following) {
          if (followers.has(addr)) mutualAddrs.add(addr)
        }
      }
    } catch {}

    const filtered = []
    const requests = []
    const myInboxId = client?.inboxId

    // Separate items needing message check from already-filtered items.
    // Fix 8 (H8): cache "I have sent here" result per convoId in localStorage
    // with a 7-day TTL so the N+1 messages({limit:5n}) check only runs once
    // per conversation. Invalidated by xmtp-teardown (Fix 3).
    const _MSG_CHECK_TTL_MS = 7 * 24 * 60 * 60 * 1000
    const _checkedKey = (id) => `praxis-msg-checked:${id}`
    const needsCheck = []
    for (const item of items) {
      if (item.isGroup) { filtered.push(item); continue }
      const addr = item.peerInboxId ? inboxToAddr[item.peerInboxId] : null
      if (!addr) { filtered.push(item); continue }
      if (mutualAddrs.size === 0) { filtered.push(item); continue }
      if (mutualAddrs.has(addr.toLowerCase())) { filtered.push(item); continue }
      // Check cache before hitting the per-convo messages() call.
      let cached = null
      try {
        const raw = localStorage.getItem(_checkedKey(item.convo.id))
        if (raw) {
          const parsed = JSON.parse(raw)
          if (parsed && typeof parsed.ts === 'number' && (Date.now() - parsed.ts) < _MSG_CHECK_TTL_MS) {
            cached = parsed
          }
        }
      } catch {}
      if (cached?.sent === true) { filtered.push(item); continue }
      needsCheck.push(item)
    }

    // Parallel check: did I send in this conversation? (5s timeout per check)
    if (needsCheck.length > 0) {
      const results = await Promise.allSettled(
        needsCheck.map(item =>
          Promise.race([
            item.convo.messages({ limit: 5n }).then(msgs => ({
              item, sent: msgs?.some(m => m.senderInboxId === myInboxId)
            })),
            new Promise(resolve => setTimeout(() => resolve({ item, sent: false }), 5000))
          ])
        )
      )
      for (const r of results) {
        const { item, sent } = r.status === 'fulfilled' ? r.value : { item: r.reason?.item, sent: false }
        if (item) {
          // Only persist positive results — negatives may become positive once
          // the user replies, and we want the next load to re-check.
          if (sent) {
            try { localStorage.setItem(_checkedKey(item.convo.id), JSON.stringify({ sent: true, ts: Date.now() })) } catch {}
          }
          ;(sent ? filtered : requests).push(item)
        }
      }
    }

    const _sortTs = (item) => Number(item.lastMsgTs || 0) || Number(item.convo.createdAtNs || 0n) / 1e6
    filtered.sort((a, b) => _sortTs(b) - _sortTs(a))
    requests.sort((a, b) => _sortTs(b) - _sortTs(a))

    // Limit initial display to CONVO_PAGE_SIZE
    const displayItems = filtered.slice(0, CONVO_PAGE_SIZE)
    const hasMore = filtered.length > CONVO_PAGE_SIZE

    const listEl = document.getElementById('messages-list')
    if (!listEl) { console.warn('praxis: messages-list element not found, cannot render'); return }
    dbg(`praxis: rendering ${displayItems.length} conversations (${displayItems.filter(i => i.preview).length} with previews), ${requests.length} requests`)

    let html = displayItems.length === 0
      ? `<div id="messages-syncing" style="color:var(--muted);padding:2em 1em;text-align:center;font-size:0.9em">no conversations yet</div>`
      : displayItems.map((item, i) => `
      <div class="msg-convo-item${item.isGroup ? ' msg-convo-group' : ''}" data-idx="${i}">
        <div class="msg-convo-peer">${item.isUnread ? '<span class="msg-unread-dot" style="display:inline-block;width:6px;height:6px;background:var(--red);border-radius:50%;margin-right:0.5ch;vertical-align:middle"></span>' : ''}${escapeHtml(item.peerDomain)}</div>
        <div class="msg-convo-preview">${escapeHtml(item.preview.slice(0, 60))}</div>
        <div class="msg-convo-time">${item.time}</div>
      </div>
    `).join('') + (hasMore ? `<div id="messages-load-more" class="msg-convo-item" style="text-align:center;color:var(--muted);cursor:pointer">${t('messages.loadMore') || 'load more conversations'}</div>` : '')

    // Requests section (non-mutual DMs, collapsed by default)
    if (requests.length > 0) {
      html += `
        <div id="msg-requests-header" style="display:flex;align-items:center;gap:0.5em;padding:0.75em 1em;cursor:pointer;border-top:1px solid var(--border,#333);margin-top:0.5em;color:var(--muted);font-size:0.85em;user-select:none">
          <span id="msg-requests-arrow" style="transition:transform 0.2s;display:inline-block">&#9654;</span>
          <span>requests</span>
          <span style="background:var(--surface,#1a1a1a);border:1px solid var(--border,#333);border-radius:9999px;padding:0 0.5em;font-size:0.8em;min-width:1.2em;text-align:center">${requests.length}</span>
        </div>
        <div id="msg-requests-list" style="display:none">
          ${requests.map((item, i) => `
            <div class="msg-convo-item msg-convo-request" data-idx="${filtered.length + i}" style="opacity:0.55">
              <div class="msg-convo-peer">${item.isUnread ? '<span class="msg-unread-dot" style="display:inline-block;width:6px;height:6px;background:var(--red);border-radius:50%;margin-right:0.5ch;vertical-align:middle"></span>' : ''}${escapeHtml(item.peerDomain)} <span style="color:var(--muted);font-size:0.75em;margin-left:0.5ch">request</span></div>
              <div class="msg-convo-preview">${escapeHtml(item.preview.slice(0, 60))}</div>
              <div class="msg-convo-time">${item.time}</div>
            </div>
          `).join('')}
        </div>`
    }

    listEl.innerHTML = html

    // Store combined array: filtered first, then requests, matching data-idx values
    _msgItems = [...filtered, ...requests]
    _msgDisplayCount = CONVO_PAGE_SIZE

    // Requests section toggle
    const reqHeader = document.getElementById('msg-requests-header')
    const reqList = document.getElementById('msg-requests-list')
    const reqArrow = document.getElementById('msg-requests-arrow')
    if (reqHeader && reqList) {
      reqHeader.addEventListener('click', () => {
        const expanded = reqList.style.display !== 'none'
        reqList.style.display = expanded ? 'none' : 'block'
        if (reqArrow) reqArrow.style.transform = expanded ? '' : 'rotate(90deg)'
      })
    }

    listEl.querySelectorAll('.msg-convo-item:not(#messages-load-more):not(#msg-requests-header)').forEach(el => {
      el.addEventListener('click', () => {
        listEl.querySelectorAll('.msg-convo-item').forEach(e => e.classList.remove('active'))
        el.classList.add('active')
        const idx = parseInt(el.dataset.idx)
        const item = _msgItems[idx]
        if (item) {
          try { localStorage.setItem(`praxis:msg-seen:${item.convo.id}`, String(Date.now() * 1e6)) } catch {}
          // Remove the red unread dot from this conversation item
          el.querySelector('.msg-unread-dot')?.remove()
          openConversation(item.convo, item.peerDomain)
        }
      })
    })

    // "Load more" handler
    const loadMoreEl = document.getElementById('messages-load-more')
    if (loadMoreEl) {
      loadMoreEl.addEventListener('click', () => {
        const start = _msgDisplayCount
        const next = items.slice(start, start + CONVO_PAGE_SIZE)
        _msgDisplayCount += CONVO_PAGE_SIZE

        // Remove the load-more button
        loadMoreEl.remove()

        // Append new items
        const moreHtml = next.map((item, j) => {
          const idx = start + j
          return `<div class="msg-convo-item${item.isGroup ? ' msg-convo-group' : ''}" data-idx="${idx}">
            <div class="msg-convo-peer">${item.isUnread ? '<span class="msg-unread-dot" style="display:inline-block;width:6px;height:6px;background:var(--red);border-radius:50%;margin-right:0.5ch;vertical-align:middle"></span>' : ''}${escapeHtml(item.peerDomain)}</div>
            <div class="msg-convo-preview">${escapeHtml(item.preview.slice(0, 60))}</div>
            <div class="msg-convo-time">${item.time}</div>
          </div>`
        }).join('')

        const stillMore = items.length > start + CONVO_PAGE_SIZE
        listEl.insertAdjacentHTML('beforeend', moreHtml + (stillMore ? `<div id="messages-load-more" class="msg-convo-item" style="text-align:center;color:var(--muted);cursor:pointer">${t('messages.loadMore') || 'load more conversations'}</div>` : ''))

        // Bind click handlers on new items
        listEl.querySelectorAll('.msg-convo-item:not(#messages-load-more)').forEach(el => {
          if (!el.dataset.bound) {
            el.dataset.bound = '1'
            el.addEventListener('click', () => {
              listEl.querySelectorAll('.msg-convo-item').forEach(e => e.classList.remove('active'))
              el.classList.add('active')
              const item = _msgItems[parseInt(el.dataset.idx)]
              if (item) {
                try { localStorage.setItem(`praxis:msg-seen:${item.convo.id}`, String(Date.now() * 1e6)) } catch {}
          // Remove the red unread dot from this conversation item
          el.querySelector('.msg-unread-dot')?.remove()
                openConversation(item.convo, item.peerDomain)
              }
            })
          }
        })

        // Re-bind load more if added
        const newLoadMore = document.getElementById('messages-load-more')
        if (newLoadMore) {
          newLoadMore.addEventListener('click', loadMoreEl.onclick)
        }
      })
    }
  } catch (e) {
    console.error('load conversations:', e)
  }
}

// --- Active conversation ---

async function openConversation(convo, peerDomain) {
  // Check if conversation is active — sync to try reactivation
  let _convoInactive = false
  try {
    // Sync to trigger reactivation (per XMTP docs, inactive groups reactivate
    // when members sync — the new installation gets added automatically)
    try { await convo.sync() } catch {}
    const isActive = typeof convo.isActive === 'function' ? await convo.isActive() : true
    if (!isActive) {
      _convoInactive = true
      dbg('praxis: openConversation — conversation inactive, will show read-only')
    }
  } catch (e) { dbg('praxis: openConversation sync failed:', e?.message) }

  activeConvo = convo
  if (activeStream) { try { activeStream.return?.() } catch {} }
  activeStream = null
  // Reset typing/read state for the newly-active conversation
  hideTypingIndicator()
  _lastTypingSentAt = 0

  // detect group vs DM
  try {
    const peerInboxId = await convo.peerInboxId()
    activePeerAddr = peerInboxId ? inboxToAddr[peerInboxId] : null
    activeIsGroup = false
  } catch {
    activePeerAddr = null
    activeIsGroup = true
  }

  const chatEmpty = document.getElementById('messages-chat-empty')
  const chatActive = document.getElementById('messages-chat-active')
  const peerNameEl = document.getElementById('messages-peer-name')
  const payBar = document.getElementById('messages-pay-bar')
  if (!chatEmpty || !chatActive || !peerNameEl) {
    console.warn('praxis: openConversation DOM not ready', { chatEmpty: !!chatEmpty, chatActive: !!chatActive, peerNameEl: !!peerNameEl })
    return
  }
  chatEmpty.style.display = 'none'
  chatActive.style.display = 'flex'
  // Make the peer name a clickable link to their site (opens in new tab).
  // For groups, just show the group name as plain text.
  if (!activeIsGroup && peerDomain && peerDomain.includes('.')) {
    peerNameEl.innerHTML = `<a href="https://${escapeHtml(peerDomain)}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none" title="visit ${escapeHtml(peerDomain)}">${escapeHtml(peerDomain)}</a>`
  } else {
    peerNameEl.textContent = peerDomain
  }
  // mobile: switch to chat view
  if (window.matchMedia('(max-width: 768px)').matches) {
    document.getElementById('messages-container')?.classList.add('chat-active')
  }
  if (payBar) payBar.style.display = 'none'
  // hide payment button for group conversations
  const payToggle = document.getElementById('messages-pay-toggle')
  if (payToggle) payToggle.style.display = activeIsGroup ? 'none' : ''

  // show/hide members button for groups, block button for DMs
  let membersBtn = document.getElementById('messages-members-btn')
  if (!membersBtn) {
    membersBtn = document.createElement('button')
    membersBtn.id = 'messages-members-btn'
    membersBtn.className = 'buy-btn'
    membersBtn.style.cssText = 'font-size:0.75em;padding:0.2em 0.8ch;margin-left:0.5ch'
    membersBtn.textContent = 'members'
    membersBtn.addEventListener('click', toggleMembersPanel)
    document.getElementById('messages-peer-name')?.parentElement?.appendChild(membersBtn)
  }
  membersBtn.style.display = activeIsGroup ? '' : 'none'

  let menuContainer = document.getElementById('messages-menu-container')
  if (!menuContainer) {
    menuContainer = document.createElement('div')
    menuContainer.id = 'messages-menu-container'
    menuContainer.style.cssText = 'position:relative;display:inline-block;margin-left:0.5ch'

    const menuBtn = document.createElement('button')
    menuBtn.style.cssText = 'background:none;border:none;color:var(--muted);cursor:pointer;font-size:1.2em;padding:0.2em'
    menuBtn.innerHTML = '<i class="ph ph-dots-three"></i>'

    const dropdown = document.createElement('div')
    dropdown.id = 'messages-menu-dropdown'
    dropdown.style.cssText = 'display:none;position:absolute;right:0;top:100%;background:var(--bg);border:1px solid var(--border);padding:0.3em 0;min-width:8ch;z-index:100'

    const blockOption = document.createElement('button')
    blockOption.id = 'messages-block-option'
    blockOption.style.cssText = 'display:block;width:100%;background:none;border:none;color:var(--red);font-family:inherit;font-size:0.85em;padding:0.4em 1ch;cursor:pointer;text-align:left'
    blockOption.addEventListener('click', async () => {
      if (!activePeerAddr) return
      if (isBlocked(activePeerAddr)) {
        unblockUser(activePeerAddr)
        blockOption.textContent = 'block'
        dropdown.style.display = 'none'
        return
      }
      // Custom modal (replaces native confirm) — same UX pattern as
      // profile.js's showBlockConfirmModal so blocking from the messages
      // dropdown matches blocking from the profile page.
      const ok = await new Promise(resolve => {
        const overlay = document.createElement('div')
        overlay.className = 'praxis-modal-overlay'
        const dialog = document.createElement('div')
        dialog.className = 'praxis-modal-dialog'
        dialog.style.cssText = 'max-width:380px;font-family:inherit'
        dialog.innerHTML = `
          <div style="color:var(--fg, #c0c0c0);margin-bottom:0.5em;font-size:0.95em">block this user?</div>
          <ul style="color:var(--dim, #888);font-size:0.85em;margin:0 0 1em;padding-left:1.2em;line-height:1.5">
            <li>their messages will be hidden</li>
            <li>they won't appear in your feed or notifications</li>
            <li>they won't be able to message you</li>
          </ul>
          <div style="display:flex;gap:1ch;justify-content:flex-end">
            <button id="msg-block-cancel" style="background:none;border:none;color:var(--dim, #444);font-family:inherit;font-size:0.85em;cursor:pointer">cancel</button>
            <button id="msg-block-confirm" style="background:none;border:1px solid #ef4444;color:#ef4444;font-family:inherit;font-size:0.85em;padding:0.4em 1.5ch;cursor:pointer">block</button>
          </div>
        `
        overlay.appendChild(dialog)
        document.body.appendChild(overlay)
        const cleanup = (r) => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(r) }
        const onKey = (e) => { if (e.key === 'Escape') cleanup(false) }
        document.addEventListener('keydown', onKey)
        dialog.querySelector('#msg-block-confirm').addEventListener('click', () => cleanup(true))
        dialog.querySelector('#msg-block-cancel').addEventListener('click', () => cleanup(false))
        overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false) })
      })
      if (!ok) return
      blockUser(activePeerAddr)
      blockOption.textContent = 'unblock'
      dropdown.style.display = 'none'
    })
    dropdown.appendChild(blockOption)

    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      dropdown.style.display = dropdown.style.display === 'none' ? '' : 'none'
    })
    // Use single delegated listener (prevents leak on repeated conversation switches)
    if (!window._msgMenuClickBound) {
      window._msgMenuClickBound = true
      document.addEventListener('click', () => {
        document.getElementById('messages-menu-dropdown')?.setAttribute('style', 'display:none')
      })
    }

    menuContainer.appendChild(menuBtn)
    menuContainer.appendChild(dropdown)
    document.getElementById('messages-peer-name')?.parentElement?.appendChild(menuContainer)
  }
  if (!activeIsGroup && activePeerAddr) {
    menuContainer.style.display = ''
    const blockOption = document.getElementById('messages-block-option')
    if (blockOption) blockOption.textContent = isBlocked(activePeerAddr) ? 'unblock' : 'block'
  } else {
    menuContainer.style.display = 'none'
  }

  // close members panel when switching conversations
  document.getElementById('messages-members-panel')?.remove()

  const msgsEl = document.getElementById('messages-msgs')
  if (!msgsEl) { console.warn('praxis: messages-msgs element not found'); return }
  msgsEl.innerHTML = '<div class="praxis-loader"></div>'

  try {
    // sync may fail (CORS, network) — still try to load messages from local OPFS store
    try { await convo.sync() } catch (syncErr) {
      console.warn('praxis: conversation sync failed (loading local messages):', syncErr?.message)
    }
    // Brief delay for WASM message processing to complete after sync
    await new Promise(r => setTimeout(r, 500))
    let messages = await convo.messages()
    dbg(`praxis: loaded ${messages.length} messages for conversation`)
    renderMessages(messages)
    setupBackwardScroll()
    // Re-scroll after sentinel prepend + paint to guarantee newest messages visible
    { const _el = document.getElementById('messages-msgs'); if (_el) requestAnimationFrame(() => { _el.scrollTop = _el.scrollHeight }) }
    // Acknowledge that we've read up to the latest visible incoming message.
    // Best-effort — failures are logged only at debug level.
    {
      const latest = findLatestIncomingNs(messages)
      if (latest) sendReadReceipt(convo, latest)
      // Re-apply any previously stored watermark so outgoing bubbles show "seen".
      const wm = _peerReadWatermark.get(convo.id)
      if (wm) applyReadReceiptsToDom(convo.id, wm)
    }
    // If no messages loaded (WASM still processing), retry with increasing delays
    if (messages.length === 0) {
      for (const delay of [1500, 3000, 5000]) {
        await new Promise(r => setTimeout(r, delay))
        try {
          if (activeConvo !== convo) break // user switched conversations
          messages = await convo.messages()
          if (messages.length > 0) { renderMessages(messages); break }
        } catch { break }
      }
    }

    try {
      activeStream = await convo.stream()
      ;(async () => {
        try {
          for await (const msg of activeStream) {
            // Intercept praxis control messages (read receipts + typing) BEFORE
            // doing the sync+render, so we don't pay the sync round-trip for an
            // event that won't change the visible message list.
            if (handlePraxisControlMessage(msg, convo)) continue
            try { await convo.sync() } catch {}
            const msgs = await convo.messages()
            renderMessages(msgs)
            // New incoming visible message → acknowledge read immediately
            if (msg.senderInboxId !== client?.inboxId && document.visibilityState === 'visible') {
              const latest = findLatestIncomingNs(msgs)
              if (latest) sendReadReceipt(convo, latest)
            }
          }
        } catch (streamInnerErr) {
          const errMsg = streamInnerErr?.message || ''
          if (errMsg.includes('SecretReuse') || errMsg.includes('epoch') || errMsg.includes('Welcome')) {
            console.warn('praxis: MLS stream error, re-syncing conversation...')
            try {
              await client.conversations.sync()
              const convos = await client.conversations.list()
              const match = convos.find(c => c.id === convo.id)
              if (match && activeConvo?.id === convo.id) {
                activeConvo = match
                await match.sync()
                renderMessages(await match.messages())
                // restart stream on recovered conversation
                activeStream = await match.stream()
                for await (const msg of activeStream) {
                  if (handlePraxisControlMessage(msg, match)) continue
                  try { await match.sync() } catch {}
                  renderMessages(await match.messages())
                }
              }
            } catch (recoveryErr) {
              console.warn('praxis: MLS stream recovery failed:', recoveryErr?.message)
            }
          }
        }
      })()
    } catch (streamErr) {
      console.warn('praxis: message stream failed:', streamErr?.message)
    }
  } catch (e) {
    const msg = e.message || ''
    if (msg.includes('SecretReuse') || msg.includes('epoch') || msg.includes('Welcome')) {
      // MLS epoch corruption — re-sync and retry opening this conversation
      console.warn('praxis: MLS epoch error on conversation open, recovering...')
      try {
        await client.conversations.sync()
        const convos = await client.conversations.list()
        const match = convos.find(c => c.id === convo.id)
        if (match) {
          activeConvo = match
          await match.sync()
          renderMessages(await match.messages())
          return
        }
      } catch (recErr) { console.warn('praxis: MLS conversation recovery failed:', recErr?.message) }
      msgsEl.innerHTML = `<div style="color:var(--muted);padding:1em">messaging session corrupted. go to settings and revoke old installations, then refresh.</div>`
    } else if (msg.includes('inactive') || msg.includes('GroupError') || msg.includes('Sync')) {
      msgsEl.innerHTML = `<div style="color:var(--muted);padding:1em">this conversation is no longer active. start a new one to continue messaging.</div>`
    } else {
      msgsEl.innerHTML = `<div style="color:var(--muted);padding:1em">could not load messages. try refreshing.</div>`
    }
    console.warn('praxis: conversation sync error:', msg)
  }

  // delayed focus for mobile Safari compatibility
  const msgInput = document.getElementById('messages-input')
  if (msgInput) setTimeout(() => msgInput.focus(), 100)
}

// Backward scroll state — tracks whether we've reached the oldest message
let _oldestLoadedNs = null
let _loadingOlder = false
let _reachedStart = false
let _backScrollObserver = null

function setupBackwardScroll() {
  const el = document.getElementById('messages-msgs')
  if (!el || !activeConvo) return
  if (_backScrollObserver) _backScrollObserver.disconnect()

  // Sentinel at the top of the messages list
  let sentinel = el.querySelector('#msgs-top-sentinel')
  if (!sentinel) {
    sentinel = document.createElement('div')
    sentinel.id = 'msgs-top-sentinel'
    sentinel.style.height = '1px'
    el.prepend(sentinel)
  }

  _backScrollObserver = new IntersectionObserver(async (entries) => {
    if (!entries[0].isIntersecting || _loadingOlder || _reachedStart || !activeConvo) return
    _loadingOlder = true
    try {
      const opts = { limit: BigInt(50) }
      if (_oldestLoadedNs) opts.beforeNs = _oldestLoadedNs
      const older = await activeConvo.messages(opts)
      if (!older.length || older.length === 0) {
        _reachedStart = true
        _loadingOlder = false
        return
      }
      // Filter out messages we already have
      const existingIds = new Set([...el.querySelectorAll('.dm-msg')].map(m => m.dataset.msgId))
      const fresh = older.filter(m => !existingIds.has(m.id))
      if (!fresh.length) { _reachedStart = true; _loadingOlder = false; return }

      // Update oldest timestamp
      const oldestMsg = fresh.reduce((a, b) => {
        const aNs = BigInt(a.sentAtNs || a.sentAt || 0)
        const bNs = BigInt(b.sentAtNs || b.sentAt || 0)
        return aNs < bNs ? a : b
      })
      _oldestLoadedNs = BigInt(oldestMsg.sentAtNs || oldestMsg.sentAt || 0)

      // Preserve scroll position before prepending
      const prevHeight = el.scrollHeight
      const prevTop = el.scrollTop

      // Render older messages and prepend
      prependMessages(fresh, el)
      el.scrollTop = prevTop + (el.scrollHeight - prevHeight)
    } catch (e) {
      dbg('backward scroll load failed:', e?.message)
    }
    _loadingOlder = false
  }, { root: el, threshold: 0, rootMargin: '200px 0px 0px 0px' })

  _backScrollObserver.observe(sentinel)
}

function prependMessages(messages, el) {
  const myInboxId = client?.inboxId
  const sentinel = el.querySelector('#msgs-top-sentinel')
  for (const m of messages.sort((a, b) => {
    const aN = BigInt(a.sentAtNs || a.sentAt || 0)
    const bN = BigInt(b.sentAtNs || b.sentAt || 0)
    return aN < bN ? -1 : aN > bN ? 1 : 0
  })) {
    const text = extractText(m)
    if (!text) continue
    const isMe = m.senderInboxId === myInboxId
    const sentNs = BigInt(m.sentAtNs || m.sentAt || 0)
    const sentMs = Number(sentNs / 1000000n)
    const time = new Date(sentMs).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    const div = document.createElement('div')
    div.className = `dm-msg ${isMe ? 'dm-msg-mine' : 'dm-msg-theirs'}`
    div.dataset.msgId = m.id || ''
    div.dataset.senderInbox = m.senderInboxId || ''
    div.dataset.sentNs = String(sentNs)
    div.innerHTML = `<div class="dm-bubble">${escapeHtml(text)}</div><div class="dm-time">${time}</div>`
    if (sentinel?.nextSibling) el.insertBefore(div, sentinel.nextSibling)
    else el.prepend(div)
  }
}

// --- Render message content with link previews and attachment embeds ---
function renderMessageContent(text) {
  const escaped = escapeHtml(text)
  // Detect attachment embeds: [image:filename](url) or [pdf:filename](url)
  let html = escaped.replace(/\[image:([^\]]*)\]\(([^)]+)\)/g, (_, name, url) => {
    const safeUrl = escapeHtml(url)
    return `<div style="margin:0.3em 0;position:relative" class="dm-img-wrap">
      <img src="${safeUrl}" alt="${escapeHtml(name)}" style="max-width:100%;max-height:300px;border-radius:8px;display:block;cursor:pointer" loading="lazy" onclick="window.open('${safeUrl}','_blank')">
      <a href="${safeUrl}" download="${escapeHtml(name)}" class="dm-img-download" title="download"><i class="ph ph-download-simple"></i></a>
    </div>`
  })
  html = html.replace(/\[video:([^\]]*)\]\(([^)]+)\)/g, (_, name, url) => {
    const safeUrl = escapeHtml(url)
    return `<div style="margin:0.3em 0;position:relative" class="dm-img-wrap">
      <video src="${safeUrl}" controls preload="none" playsinline style="max-width:100%;max-height:300px;border-radius:8px;display:block"></video>
      <a href="${safeUrl}" download="${escapeHtml(name)}" class="dm-img-download" title="download"><i class="ph ph-download-simple"></i></a>
    </div>`
  })
  html = html.replace(/\[pdf:([^\]]*)\]\(([^)]+)\)/g, (_, name, url) => {
    const safeUrl = escapeHtml(url)
    const thumbUrl = `/api/pdf-thumb?url=${encodeURIComponent(url)}`
    return `<div style="margin:0.3em 0;position:relative" class="dm-img-wrap">
      <img src="${thumbUrl}" alt="${escapeHtml(name)}" style="max-width:100%;max-height:300px;border-radius:8px;display:block;cursor:pointer;background:#fff" loading="lazy" onclick="window.open('${safeUrl}','_blank')" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
      <div style="display:none;align-items:center;gap:0.5ch;padding:0.75em 1em;cursor:pointer;font-size:0.9em" onclick="window.open('${safeUrl}','_blank')"><i class="ph ph-file-pdf" style="font-size:1.2em"></i><span>${escapeHtml(name)}</span></div>
      <a href="${safeUrl}" download="${escapeHtml(name)}" class="dm-img-download" title="download"><i class="ph ph-download-simple"></i></a>
    </div>`
  })
  // Detect artist domain URLs and render as link cards
  html = html.replace(/(https?:\/\/(?:[a-z0-9-]+\.ourpraxis\.network|[a-z0-9-]+\.[a-z]{2,})(?:\/[^\s<]*)?)/gi, (url) => {
    const safeUrl = escapeHtml(url)
    const domain = url.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    // Check if it looks like a praxis artist domain
    const isPraxis = domain.endsWith('.ourpraxis.network') || addrToDomain && Object.values(addrToDomain).includes(domain)
    if (isPraxis) {
      return `<a href="${safeUrl}" target="_blank" class="dm-og-card">
        <img src="https://${escapeHtml(domain)}/og/index.png" loading="lazy" onerror="this.style.display='none'">
        <div class="dm-og-domain">${escapeHtml(domain)}</div>
      </a>`
    }
    return `<a href="${safeUrl}" target="_blank" style="color:var(--accent);text-decoration:underline">${escapeHtml(domain)}</a>`
  })
  return html
}

function renderMessages(messages) {
  const el = document.getElementById('messages-msgs')
  if (!el) return
  // Reset backward scroll state for new conversation
  _reachedStart = false
  _loadingOlder = false
  if (messages.length > 0) {
    const oldest = messages.reduce((a, b) => {
      const aN = BigInt(a.sentAtNs || a.sentAt || 0)
      const bN = BigInt(b.sentAtNs || b.sentAt || 0)
      return aN < bN ? a : b
    })
    _oldestLoadedNs = BigInt(oldest.sentAtNs || oldest.sentAt || 0)
  } else {
    _oldestLoadedNs = null
  }
  // Cap to last 200 messages per conversation to bound memory
  const MSG_CAP = 200
  if (messages.length > MSG_CAP) {
    messages = messages.slice(-MSG_CAP)
  }
  // build a map of message IDs to text for reply rendering
  const msgMap = {}
  for (const m of messages) {
    const txt = extractText(m)
    if (txt && m.id) msgMap[m.id] = txt
  }

  // collect reactions keyed by referenced message ID
  // v7 SDK: reactions are on m.reactions[] property (DecodedMessage<Reaction>[])
  // Legacy: reactions are separate messages with content.reference + content.action
  const reactions = {}
  const myReactedMsgs = new Set() // track which messages current user reacted to
  const reactionMsgIds = new Set()
  const myInboxId = client?.inboxId
  for (const m of messages) {
    // v7: check m.reactions property
    if (m.reactions && Array.isArray(m.reactions) && m.reactions.length > 0) {
      if (!reactions[m.id]) reactions[m.id] = []
      for (const r of m.reactions) {
        const rc = r.content || r
        const action = rc.action
        const content = rc.content || ''
        const isAdded = action === 'added' || action === 1
        const isRemoved = action === 'removed' || action === 2
        if (isAdded && content) {
          reactions[m.id].push(content)
          if (r.senderInboxId === myInboxId) myReactedMsgs.add(m.id)
        } else if (isRemoved && content) {
          const idx = reactions[m.id].indexOf(content)
          if (idx !== -1) reactions[m.id].splice(idx, 1)
          if (r.senderInboxId === myInboxId) myReactedMsgs.delete(m.id)
        }
      }
    }
    // legacy: check content object for reaction fields
    const c = m.content
    if (c && typeof c === 'object' && c.reference && c.action !== undefined && c.content) {
      const isAdded = c.action === 'added' || c.action === 1
      const isRemoved = c.action === 'removed' || c.action === 2
      if (isAdded) {
        if (!reactions[c.reference]) reactions[c.reference] = []
        reactions[c.reference].push(c.content)
        reactionMsgIds.add(m.id)
      } else if (isRemoved) {
        if (reactions[c.reference]) reactions[c.reference] = reactions[c.reference].filter(r => r !== c.content)
        reactionMsgIds.add(m.id)
      }
    }
  }

  el.innerHTML = messages.slice(-200).map(m => {
    // skip legacy reaction messages — they're shown as decorations on referenced messages
    if (reactionMsgIds.has(m.id)) return ''
    const text = extractText(m)
    if (!text) return ''
    const isMe = m.senderInboxId === client?.inboxId
    let time = ''
    if (m.sentAtNs) {
      const d = new Date(Number(m.sentAtNs) / 1e6)
      const now = new Date()
      const isToday = d.toDateString() === now.toDateString()
      const isYesterday = d.toDateString() === new Date(now - 86400000).toDateString()
      const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      if (isToday) time = timeStr
      else if (isYesterday) time = t('time.yesterday', { time: timeStr })
      else time = `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${timeStr}`
    }

    // detect quoted reply format: "> original text\n\nreply text"
    // The quote becomes a clickable element that scrolls to the original
    // message if it's still in the DOM. data-reply-text stores the quoted
    // text for the click handler to match against.
    let replyHtml = ''
    let displayText = text
    if (text.startsWith('> ')) {
      const parts = text.split('\n\n')
      if (parts.length >= 2) {
        const quoted = parts[0].slice(2) // remove "> "
        displayText = parts.slice(1).join('\n\n')
        replyHtml = `<div class="msg-reply-quote" data-reply-text="${escapeHtml(quoted.slice(0, 80))}" style="cursor:pointer" title="scroll to original">${escapeHtml(quoted.slice(0, 80))}${quoted.length > 80 ? '…' : ''}</div>`
      }
    }

    // show sender label for non-self messages in group conversations
    const senderHtml = (activeIsGroup && !isMe) ? `<div class="msg-sender">${escapeHtml(domainForInbox(m.senderInboxId))}</div>` : ''

    const msgReactions = reactions[m.id] || []
    // show unique emojis with count if > 1
    const reactionCounts = {}
    for (const r of msgReactions) { reactionCounts[r] = (reactionCounts[r] || 0) + 1 }
    const reactionHtml = Object.keys(reactionCounts).length ? `<div class="msg-reaction" style="font-size:0.85em;margin-top:0.25em;display:flex;gap:0.3em">${Object.entries(reactionCounts).map(([emoji, count]) => `<span style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:0.1em 0.5em;font-size:0.9em">${escapeHtml(emoji)}${count > 1 ? ` ${count}` : ''}</span>`).join('')}</div>` : ''

    const sentNs = m.sentAtNs ? String(m.sentAtNs) : ''
    // No per-message receipt indicator anymore. We render a single
    // "sent" / "read" status only on the LAST outgoing bubble after
    // the loop, see updateLastReceiptIndicator() below.
    return `<div class="dm-msg ${isMe ? 'dm-msg-mine' : 'dm-msg-theirs'}" data-msg-id="${m.id || ''}" data-sender-inbox="${m.senderInboxId || ''}" data-my-reaction="${myReactedMsgs.has(m.id) ? '1' : '0'}" data-sent-ns="${sentNs}">
      ${senderHtml}
      ${replyHtml}
      <div class="dm-bubble">${renderMessageContent(displayText)}</div>${reactionHtml}
      <div class="dm-time">${time}</div>
    </div>`
  }).join('')
  el.scrollTop = el.scrollHeight
  // After every render, update the receipt indicator on the LAST outgoing
  // bubble (single source of truth — much cleaner than per-message ✓✓).
  updateLastReceiptIndicator()
  // Re-apply peer read watermark after DOM rebuild
  {
    const wm = activeConvo ? _peerReadWatermark.get(activeConvo.id) : null
    if (wm) applyReadReceiptsToDom(activeConvo.id, wm)
  }

  // Click on a reply-quote to scroll to the original message. Matches the
  // quoted text against bubble content in the current DOM. If found, smooth-
  // scrolls + briefly highlights; if not (message scrolled out of view or
  // from a different session), silently no-ops.
  el.querySelectorAll('.msg-reply-quote[data-reply-text]').forEach(quoteEl => {
    quoteEl.addEventListener('click', (e) => {
      e.stopPropagation() // don't trigger double-click reaction on parent
      const quotedText = quoteEl.dataset.replyText
      if (!quotedText) return
      // Find the original message by scanning all bubbles for matching text
      const allBubbles = el.querySelectorAll('.dm-bubble')
      for (const bubble of allBubbles) {
        // Exact prefix match (the quote is sliced to 80 chars)
        if (bubble.textContent.startsWith(quotedText.replace(/…$/, ''))) {
          const msgEl = bubble.closest('.dm-msg')
          if (msgEl) {
            msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' })
            // Brief highlight
            msgEl.style.transition = 'background 0.3s'
            msgEl.style.background = 'var(--surface, #1a1a1a)'
            setTimeout(() => { msgEl.style.background = '' }, 1500)
          }
          return
        }
      }
    })
  })

  // long-press to copy message text (mobile-friendly)
  el.querySelectorAll('.dm-msg').forEach(msgEl => {
    let _lpTimer = null
    const startLp = (e) => {
      _lpTimer = setTimeout(() => {
        _lpTimer = null
        const bubble = msgEl.querySelector('.dm-bubble')
        if (!bubble) return
        const text = bubble.textContent
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(text).then(() => {
            bubble.style.transition = 'opacity 0.2s'
            bubble.style.opacity = '0.5'
            setTimeout(() => { bubble.style.opacity = '1' }, 400)
          }).catch(() => {})
        }
      }, 600)
    }
    const cancelLp = () => { if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null } }
    msgEl.addEventListener('touchstart', startLp, { passive: true })
    msgEl.addEventListener('touchend', cancelLp)
    msgEl.addEventListener('touchmove', cancelLp)
    msgEl.addEventListener('touchcancel', cancelLp)
  })

  // double-click to react with heart
  el.querySelectorAll('.dm-msg').forEach(msgEl => {
    msgEl.addEventListener('dblclick', async () => {
      const msgId = msgEl.dataset.msgId
      const senderInbox = msgEl.dataset.senderInbox
      if (!msgId || !activeConvo) return
      try {
        const existingReaction = msgEl.dataset.myReaction === '1'

        // Optimistic: immediately render the reaction change
        const reactionContainer = msgEl.querySelector('.msg-reaction')
        let prevReactionHtml = reactionContainer ? reactionContainer.innerHTML : ''
        if (!existingReaction) {
          // Adding heart — show it immediately
          if (reactionContainer) {
            // Check if heart already shown
            const hasHeart = reactionContainer.textContent.includes('\u2764')
            if (!hasHeart) {
              reactionContainer.insertAdjacentHTML('beforeend', '<span style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:0.1em 0.5em;font-size:0.9em">\u2764</span>')
            }
          } else {
            // Create new reaction container
            const bubble = msgEl.querySelector('.dm-bubble')
            if (bubble) {
              bubble.insertAdjacentHTML('afterend', '<div class="msg-reaction" style="font-size:0.85em;margin-top:0.25em;display:flex;gap:0.3em"><span style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:0.1em 0.5em;font-size:0.9em">\u2764</span></div>')
            }
          }
          msgEl.dataset.myReaction = '1'
        } else {
          // Removing heart — optimistically remove it
          if (reactionContainer) {
            const spans = reactionContainer.querySelectorAll('span')
            for (const span of spans) {
              if (span.textContent.includes('\u2764')) {
                span.remove()
                break
              }
            }
            if (reactionContainer.children.length === 0) reactionContainer.remove()
          }
          msgEl.dataset.myReaction = '0'
        }

        // Send reaction in background
        try {
          if (window._xmtpClientIsReadOnly) {
            const upgraded = await ensureFullClient()
            if (!upgraded) {
              console.warn('praxis: cannot react — client upgrade failed')
              // Revert optimistic change
              msgEl.dataset.myReaction = existingReaction ? '1' : '0'
              if (reactionContainer) reactionContainer.innerHTML = prevReactionHtml
              return
            }
            await client.conversations.sync()
            const convos = await client.conversations.list()
            const match = convos.find(c => c.id === activeConvo.id)
            if (match) activeConvo = match
          }
          await activeConvo.sendReaction({
            reference: msgId,
            referenceInboxId: senderInbox || '',
            action: existingReaction ? 2 : 1, // 1=Added, 2=Removed
            content: '\u2764',
            schema: 1, // ReactionSchema.Unicode
          })
          // Sync and re-render with real data after a brief delay
          setTimeout(async () => {
            try {
              await activeConvo.sync()
              renderMessages(await activeConvo.messages())
            } catch {}
          }, 1000)
        } catch (e) {
          console.warn('reaction send:', e?.message)
          // Revert optimistic reaction on failure
          msgEl.dataset.myReaction = existingReaction ? '1' : '0'
          try { await activeConvo.sync(); renderMessages(await activeConvo.messages()) } catch {}
        }
      } catch {}
    })

    // long-press to reply (mobile + desktop)
    let pressTimer = null
    msgEl.addEventListener('mousedown', () => {
      pressTimer = setTimeout(() => {
        const msgId = msgEl.dataset.msgId
        const text = msgEl.querySelector('.dm-bubble')?.textContent || ''
        if (msgId) startReply(msgId, text)
      }, 500)
    })
    msgEl.addEventListener('mouseup', () => clearTimeout(pressTimer))
    msgEl.addEventListener('mouseleave', () => clearTimeout(pressTimer))
  })
}

// --- Optimistic message helpers ---
let _optimisticId = 0

function appendOptimisticMessage(text, replyText) {
  const el = document.getElementById('messages-msgs')
  if (!el) return null
  const id = `optimistic-${++_optimisticId}`
  const now = new Date()
  const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  let replyHtml = ''
  if (replyText) {
    replyHtml = `<div class="msg-reply-quote">${escapeHtml(replyText.slice(0, 80))}</div>`
  }
  const html = `<div class="dm-msg dm-msg-mine dm-msg-optimistic" data-optimistic-id="${id}">
    ${replyHtml}
    <div class="dm-bubble">${escapeHtml(text)}</div>
    <div class="dm-time">${timeStr}</div>
  </div>`
  el.insertAdjacentHTML('beforeend', html)
  el.scrollTop = el.scrollHeight
  // Refresh the single "sent" / "read" indicator on the new last bubble
  updateLastReceiptIndicator()
  return id
}


function markOptimisticFailed(optimisticId, originalText, replyText) {
  const el = document.querySelector(`[data-optimistic-id="${optimisticId}"]`)
  if (!el) return
  const timeEl = el.querySelector('.dm-time')
  if (timeEl) timeEl.innerHTML += ` <span style="color:#ef4444;cursor:pointer" class="msg-retry-btn" title="failed to send -- click to retry"><i class="ph ph-x-circle" style="font-size:1.1em;vertical-align:middle"></i></span>`
  const retryBtn = el.querySelector('.msg-retry-btn')
  if (retryBtn) {
    retryBtn.addEventListener('click', async () => {
      retryBtn.textContent = '...'
      retryBtn.disabled = true
      try {
        if (replyText) {
          await activeConvo.sendText(`> ${replyText}\n\n${originalText}`)
        } else {
          await activeConvo.sendText(originalText)
        }
        // remove the error indicator, keep the message in place
        el.removeAttribute('data-optimistic-id')
        const failSpan = el.querySelector('.msg-retry-btn')
        if (failSpan) failSpan.parentElement.remove()
      } catch (e) {
        retryBtn.textContent = 'retry'
        retryBtn.disabled = false
        console.error('praxis: retry send failed:', e?.message)
      }
    })
  }
}

// --- Reply state ---
let replyTo = null

function startReply(msgId, previewText) {
  replyTo = { id: msgId, text: previewText.slice(0, 80) }
  const form = document.getElementById('messages-send-form')
  // show reply preview above input
  let replyBar = document.getElementById('messages-reply-bar')
  if (!replyBar) {
    replyBar = document.createElement('div')
    replyBar.id = 'messages-reply-bar'
    replyBar.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:0.5em 1.5em;border-top:1px solid var(--border);font-size:0.8em;color:var(--muted)'
    form.parentElement.insertBefore(replyBar, form)
  }
  replyBar.innerHTML = `<span>${t('messages.replyingTo', { text: escapeHtml(replyTo.text) })}${replyTo.text.length >= 80 ? '...' : ''}</span><button id="cancel-reply" aria-label="cancel reply" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:1.1em">&times;</button>`
  replyBar.style.display = 'flex'
  document.getElementById('cancel-reply').addEventListener('click', cancelReply)
  document.getElementById('messages-input')?.focus()
}

function cancelReply() {
  replyTo = null
  const bar = document.getElementById('messages-reply-bar')
  if (bar) bar.style.display = 'none'
}

// --- Send message ---

// Upgrade read-only Client.build to full Client.create (needed for sending)
async function ensureFullClient() {
  if (!window._xmtpClientIsReadOnly) return true // already full
  if (!client || !sdk) return false

  const address = window.getWalletAddress?.()
  if (!address) return false

  dbg('praxis: upgrading read-only client to full client for sending')
  const statusEl = document.getElementById('messages-input')
  try {
    // Close read-only client and create full client with signer
    if (window._xmtpBgStream) { try { await window._xmtpBgStream.return?.() } catch {} ; window._xmtpBgStream = null }
    if (activeStream) { try { await activeStream.return?.() } catch {} ; activeStream = null }
    if (_unreadStream) { try { await _unreadStream.return?.() } catch {} ; _unreadStream = null }
    try { await client.close?.() } catch {}
    client = null
    window._xmtpClient = null
    await new Promise(r => setTimeout(r, 1500))

    const signer = {
      type: 'EOA',
      getIdentifier: () => ({ identifier: address, identifierKind: sdk.IdentifierKind.Ethereum }),
      signMessage: (message) => _xmtpPersonalSign(address, message),
    }
    client = await sdk.Client.create(signer, { env: 'production', disableAutoRegister: true })
    try { const { ReactionCodec } = await import('./vendor-xmtp-reaction.js'); client.registerCodec?.(new ReactionCodec()) } catch {}
    window._xmtpClient = client
    window._xmtpClientIsReadOnly = false
    dbg('praxis: upgraded to full XMTP client')
    return true
  } catch (err) {
    console.error('praxis: client upgrade failed:', err?.message)
    return false
  }
}

async function sendMessage(e) {
  e.preventDefault()
  const input = document.getElementById('messages-input')
  const text = input.value.trim()
  if (!activeConvo || !text) return

  // Upgrade to full client if needed (first send triggers wallet signature)
  if (window._xmtpClientIsReadOnly) {
    const upgraded = await ensureFullClient()
    if (!upgraded) {
      console.warn('praxis: cannot send — client upgrade failed')
      return
    }
    // re-sync the active conversation with the new client
    await client.conversations.sync()
    const convos = await client.conversations.list()
    const match = convos.find(c => c.id === activeConvo.id)
    if (match) activeConvo = match
  }

  input.value = ''

  // Optimistic: immediately render the message in the UI
  const replyText = replyTo ? replyTo.text : null
  const optimisticId = appendOptimisticMessage(text, replyText)
  if (replyTo) cancelReply()

  try {
    if (replyText) {
      await activeConvo.sendText(`> ${replyText}\n\n${text}`)
    } else {
      await activeConvo.sendText(text)
    }
    // Success: just remove the optimistic marker — the stream listener will
    // pick up the real message and re-render naturally (no flash)
    const optEl = document.querySelector(`[data-optimistic-id="${optimisticId}"]`)
    if (optEl) optEl.removeAttribute('data-optimistic-id')
    // move active conversation to top of list (or add it if new)
    const listEl = document.getElementById('messages-list')
    if (listEl && activeConvo) {
      const activeItem = listEl.querySelector('.msg-convo-item.active')
      if (activeItem && activeItem !== listEl.firstElementChild) {
        listEl.insertBefore(activeItem, listEl.firstElementChild)
      }
      if (activeItem) {
        const preview = activeItem.querySelector('.msg-convo-preview')
        const time = activeItem.querySelector('.msg-convo-time')
        if (preview) preview.textContent = text.slice(0, 60)
        if (time) time.textContent = 'now'
      }
      // if no active item in list (new conversation), reload the list
      if (!activeItem) {
        try { await _loadConversations(window.getWalletAddress?.()) } catch {}
      }
    }
    // restart message stream if not active (may have been closed during client upgrade)
    if (!activeStream && activeConvo) {
      try {
        activeStream = await activeConvo.stream()
        ;(async () => {
          try {
            for await (const msg of activeStream) {
              if (handlePraxisControlMessage(msg, activeConvo)) continue
              if (msg.conversationId === activeConvo?.id) {
                await activeConvo.sync()
                renderMessages(await activeConvo.messages())
              }
            }
          } catch {}
        })()
      } catch {}
    }
    // if this was a request (non-mutual), move it to main list after replying
    const requestEl = document.querySelector(`.msg-convo-item[data-idx]`)
    if (requestEl?.closest('.msg-requests-section')) {
      _loadConversations(window.getWalletAddress?.()).catch(() => {})
    }
  } catch (err) {
    const errMsg = err?.message || ''
    // SecretReuseError = MLS epoch corruption from ghost installations.
    // Recovery: re-sync conversation state and retry once.
    if (errMsg.includes('SecretReuse') || errMsg.includes('epoch') || errMsg.includes('Welcome') || errMsg.includes('Unable to send')) {
      console.warn('praxis: MLS send error, attempting recovery...', errMsg.slice(0, 100))
      try {
        await client.conversations.sync()
        const convos = await client.conversations.list()
        const match = convos.find(c => c.id === activeConvo.id)
        if (match) {
          activeConvo = match
          await activeConvo.sync()
          // For stale installation errors, try removing and re-adding members
          if (errMsg.includes('Unable to send') && activeConvo.members) {
            try {
              const members = await activeConvo.members()
              for (const m of members) {
                if (m.inboxId !== client.inboxId) {
                  try {
                    await activeConvo.removeMembersByInboxId([m.inboxId])
                    await activeConvo.addMembersByInboxId([m.inboxId])
                  } catch {}
                }
              }
              await activeConvo.sync()
            } catch (memberErr) {
              console.warn('praxis: member refresh failed:', memberErr?.message)
            }
          }
          if (replyText) {
            await activeConvo.sendText(`> ${replyText}\n\n${text}`)
          } else {
            await activeConvo.sendText(text)
          }
          const optEl2 = document.querySelector(`[data-optimistic-id="${optimisticId}"]`)
          if (optEl2) optEl2.removeAttribute('data-optimistic-id')
          return
        }
      } catch (retryErr) {
        console.error('praxis: MLS recovery failed:', retryErr?.message)
      }
    }
    // GroupInactive: try re-register + sync + retry before giving up
    if (errMsg.includes('GroupInactive') || errMsg.includes('inactive group') || errMsg.includes('inactive')) {
      console.warn('praxis: group inactive — attempting recovery...')
      try {
        // Step 1: Check if our installation is still valid
        const sdk = window._xmtpSdk
        let needsReregister = false
        if (sdk && client.inboxId && client.installationId) {
          try {
            const states = await sdk.Client.fetchInboxStates([client.inboxId], 'production')
            const installs = states?.[0]?.installations || []
            const myId = String(client.installationId)
            const valid = installs.some(inst => {
              const id = inst.id || inst.installationId || ''
              const idStr = typeof id === 'object' ? Array.from(id).map(b => b.toString(16).padStart(2, '0')).join('') : String(id)
              return idStr === myId || idStr.slice(0, 16) === myId.slice(0, 16)
            })
            if (!valid) needsReregister = true
          } catch {}
        }

        // Step 2: Re-register if needed
        if (needsReregister) {
          console.warn('praxis: installation revoked, re-registering...')
          try {
            await client.registerIdentity?.()
            await client.sendSyncRequest?.()
            await new Promise(r => setTimeout(r, 1500))
          } catch (regErr) { console.warn('praxis: re-register on send failed:', regErr?.message) }
        }

        // Step 3: Sync everything
        await (client.conversations.syncAll?.(['allowed', 'unknown']) || client.conversations.sync())
        try { await activeConvo.sync() } catch {}

        // Step 4: Check if active now and retry
        const nowActive = typeof activeConvo.isActive === 'function' ? await activeConvo.isActive() : false
        if (nowActive) {
          if (replyText) await activeConvo.sendText(`> ${replyText}\n\n${text}`)
          else await activeConvo.sendText(text)
          const optEl3 = document.querySelector(`[data-optimistic-id="${optimisticId}"]`)
          if (optEl3) optEl3.removeAttribute('data-optimistic-id')
          console.log('praxis: group reactivated after recovery, message sent')
          return
        }

        // Still inactive after sync + re-register — group is permanently dead
        // for this installation. Create a new DM as last resort.
        console.warn('praxis: group permanently inactive — creating new DM with peer...')
        let peerInboxId = null
        try { peerInboxId = await activeConvo.peerInboxId?.() } catch {}
        if (!peerInboxId) {
          try {
            const members = await activeConvo.members()
            const peer = members.find(m => m.inboxId !== client.inboxId)
            if (peer) peerInboxId = peer.inboxId
          } catch {}
        }
        if (peerInboxId) {
          try {
            // Try createDmWithIdentifier (uses wallet address) which may create a fresh DM
            // unlike createDm(inboxId) which returns the same inactive group
            let newConvo = null
            const peerAddr = inboxToAddr[peerInboxId]
            if (peerAddr && client.conversations.createDmWithIdentifier) {
              try {
                // identifierKind must be numeric enum (0 = Ethereum) not string
                const sdk = window._xmtpSdk
                const kind = sdk?.IdentifierKind?.Ethereum ?? 0
                newConvo = await client.conversations.createDmWithIdentifier({ identifier: peerAddr, identifierKind: kind })
              } catch (e) { dbg('praxis: createDmWithIdentifier failed:', e?.message) }
            }
            if (!newConvo) {
              newConvo = await client.conversations.createDm(peerInboxId)
            }
            await newConvo.sync()
            // Check if the new convo is active (isActive is a getter in newer SDK)
            const newActive = newConvo.isActive ?? (typeof newConvo.isActive === 'function' ? await newConvo.isActive() : true)
            if (newActive && newConvo.id !== activeConvo.id) {
              activeConvo = newConvo
              if (replyText) await activeConvo.sendText(`> ${replyText}\n\n${text}`)
              else await activeConvo.sendText(text)
              const optEl3 = document.querySelector(`[data-optimistic-id="${optimisticId}"]`)
              if (optEl3) optEl3.removeAttribute('data-optimistic-id')
              try { await _loadConversations(window.getWalletAddress?.()) } catch {}
              console.log('praxis: message sent via new DM', newConvo.id?.slice(0, 8))
              return
            }
          } catch (createErr) {
            console.warn('praxis: new DM creation failed:', createErr?.message)
          }
        }
        // All attempts failed — offer to reset messaging database
        markOptimisticFailed(optimisticId, text, replyText)
        const msgsEl = document.getElementById('messages-msgs')
        if (msgsEl && !msgsEl.querySelector('.xmtp-inactive-notice')) {
          const notice = document.createElement('div')
          notice.className = 'xmtp-inactive-notice'
          notice.style.cssText = 'text-align:center;color:var(--dim);font-size:0.85em;padding:1em;border:1px solid var(--border);margin:0.5em 0;border-radius:6px'
          notice.innerHTML = `
            <p style="margin:0 0 0.75em">this conversation's encryption session is corrupted and can't be recovered.</p>
            <button id="xmtp-reset-btn" style="background:none;border:1px solid var(--accent);color:var(--accent);font-family:inherit;font-size:0.9em;padding:0.4em 1.5ch;cursor:pointer">reset messaging</button>
            <p style="margin:0.5em 0 0;font-size:0.8em;color:var(--dim)">this clears your local message cache and creates a fresh session. your conversation history may take a few minutes to re-sync from your other devices.</p>
          `
          notice.querySelector('#xmtp-reset-btn')?.addEventListener('click', async () => {
            notice.querySelector('#xmtp-reset-btn').disabled = true
            notice.querySelector('#xmtp-reset-btn').textContent = 'resetting...'
            try {
              // Clear OPFS database files for XMTP
              if (navigator.storage?.getDirectory) {
                const root = await navigator.storage.getDirectory()
                for await (const [name] of root.entries()) {
                  if (name.includes('xmtp') || name.includes('.db3')) {
                    try { await root.removeEntry(name, { recursive: true }) } catch {}
                  }
                }
              }
              // Clear localStorage XMTP state
              const addr = window.getWalletAddress?.()?.toLowerCase() || ''
              for (const key of Object.keys(localStorage)) {
                if (key.includes('xmtp') || key.includes('praxis-xmtp')) {
                  localStorage.removeItem(key)
                }
              }
              // Force page reload to create fresh client
              window.location.reload()
            } catch (e) {
              notice.querySelector('#xmtp-reset-btn').textContent = 'reset failed: ' + (e.message || '').slice(0, 30)
            }
          })
          msgsEl.appendChild(notice)
          msgsEl.scrollTop = msgsEl.scrollHeight
        }
        return
      } catch (syncErr) {
        console.warn('praxis: recovery failed:', syncErr?.message)
      }
    }
    console.error('send error:', err)
    // Mark optimistic message as failed with retry button
    markOptimisticFailed(optimisticId, text, replyText)
  }
}

// --- Send payment ---

async function sendPayment() {
  const amountInput = document.getElementById('messages-pay-amount')
  const amount = parseFloat(amountInput.value)
  if (!amount || !activePeerAddr) return

  try {
    await window.ensureScroll?.()
    const payAccount = await window.ensureAuthorized?.() || window.getWalletAddress()
    // Use getWalletProvider() so embedded users with another wallet (Phantom/Coinbase/Rabby)
    // installed still hit our embedded provider — window.ethereum may be locked.
    const walletClient = createWalletClient({ chain: scroll, transport: custom(window.getWalletProvider?.() || window.ethereum) })
    const hash = await walletClient.sendTransaction({
      to: activePeerAddr,
      value: parseEther(amount.toString()),
      account: payAccount,
    })
    if (activeConvo) {
      await activeConvo.sendText(t('messages.sentEth', { amount }))
    }
    amountInput.value = ''
    document.getElementById('messages-pay-bar').style.display = 'none'
  } catch (e) {
    if (e.code !== 4001) console.error('payment error:', e)
  }
}

// --- Static installation renderer (works without client) ---
function renderStaticInstallations(chatEl, installations, inboxId, signer, tempClient) {
  const el = document.getElementById('xmtp-static-installations')
  if (!el) return
  el.innerHTML = `
    <div style="color:var(--dim);font-size:0.8em;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:0.5em">installations (${installations.length}/10)</div>
    <div style="font-family:monospace;font-size:0.75em;color:var(--dim);margin-bottom:0.75em;word-break:break-all">inbox: ${inboxId?.slice(0, 24)}...</div>
    ${installations.map((inst, i) => {
      const id = inst.id || inst.installationId || inst
      const idStr = typeof id === 'object' ? Array.from(new Uint8Array(id.buffer || id)).map(b => b.toString(16).padStart(2, '0')).join('') : String(id)
      // M5: skip non-hex ids so unescaped innerHTML insertion is safe
      if (!/^[0-9a-f]+$/i.test(idStr)) return ''
      return `
      <div style="padding:0.4em 0;border-bottom:1px solid var(--border);font-size:0.85em;display:flex;align-items:center;justify-content:space-between">
        <span style="font-family:monospace;color:var(--muted)">${idStr.slice(0, 20)}...</span>
        <button class="xmtp-static-revoke" data-idx="${i}" data-id="${idStr}" aria-label="revoke installation ${idStr.slice(0, 12)}" style="background:none;border:1px solid #ef4444;color:#ef4444;font-family:inherit;font-size:0.75em;padding:0.15em 0.75ch;cursor:pointer">revoke</button>
      </div>`
    }).join('')}
    <p id="xmtp-static-status" style="color:var(--muted);font-size:0.85em;margin-top:0.5em"></p>
    <button id="xmtp-static-retry" class="buy-btn" style="font-size:0.85em;padding:0.3em 1.5ch;margin-top:0.75em;display:none">retry connection</button>
  `
  // wire up revoke buttons — prioritize static method (no client needed)
  el.querySelectorAll('.xmtp-static-revoke').forEach(btn => {
    btn.addEventListener('click', async () => {
      const statusEl = document.getElementById('xmtp-static-status')
      btn.textContent = '...'
      btn.disabled = true
      try {
        const idStr = btn.dataset.id
        const idBytes = new Uint8Array(idStr.match(/.{2}/g).map(b => parseInt(b, 16)))
        let revoked = false
        // method 1: static Client.revokeInstallations — works without a client instance
        // Pass env as string 'production', not { env: 'production' }
        if (!revoked && sdk?.Client?.revokeInstallations && signer && inboxId) {
          try { await sdk.Client.revokeInstallations(signer, inboxId, [idBytes], 'production'); revoked = true } catch (e1) { console.warn('revoke via static:', e1?.message) }
        }
        // method 2: use temp client instance if available
        if (!revoked && tempClient) {
          try { await tempClient.revokeInstallations([idBytes]); revoked = true } catch (e2) { console.warn('revoke via tempClient:', e2?.message) }
        }
        if (revoked) {
          btn.parentElement.remove()
          if (statusEl) statusEl.textContent = 'revoked. revoke more or retry to reconnect.'
          const retryBtn = document.getElementById('xmtp-static-retry')
          if (retryBtn) retryBtn.style.display = ''
        } else {
          btn.textContent = 'failed'
          if (statusEl) statusEl.textContent = 'revoke failed — try clearing local data and reloading'
        }
      } catch (e) {
        btn.textContent = 'failed'
        console.error('revoke single:', e)
        if (statusEl) statusEl.textContent = `error: ${e.message?.slice(0, 80)}`
      }
    })
  })
  // retry button
  document.getElementById('xmtp-static-retry')?.addEventListener('click', () => {
    client = null
    if (tempClient) { try { tempClient.close?.() } catch {} }
    window.location.reload()
  })
}

// --- Messages settings (XMTP installations) ---

async function showMessagesSettings() {
  const chatEl = document.getElementById('messages-chat')
  if (!chatEl) return
  if (!client) {
    // no client — use static SDK methods to list + revoke installations
    const addr = window.getWalletAddress?.()
    if (!sdk) {
      try { sdk = await import('./vendor-xmtp.js') } catch {}
    }
    chatEl.innerHTML = `
      <div style="padding:2em;max-width:500px;margin:0 auto">
        <h3 style="margin-bottom:1em">message settings</h3>
        <div id="xmtp-static-installations" style="margin-bottom:1.5em">
          <p style="color:var(--muted);font-size:0.85em"><span class="praxis-loader"></span> loading installations...</p>
        </div>
        <button id="xmtp-clear-data" class="buy-btn" style="border-color:#ef4444;color:#ef4444;font-size:0.85em">clear local data and reload</button>
      </div>
    `
    // list installations using static SDK methods (no client instance needed)
    if (sdk && addr) {
      const loadEl = document.getElementById('xmtp-static-installations')
      try {
        const signer = {
          type: 'EOA',
          getIdentifier: () => ({ identifier: addr, identifierKind: sdk.IdentifierKind.Ethereum }),
          signMessage: (msg) => _xmtpPersonalSign(addr, msg),
        }
        let installations = []
        let inboxId = null
        let tempClient = null

        // Approach 1: Use static SDK methods (createBackend + getInboxIdForIdentifier + fetchInboxStates)
        // These work on the main thread without a worker, bypassing the 10/10 client creation issue
        if (sdk.createBackend && sdk.getInboxIdForIdentifier) {
          try {
            const identifier = { identifier: addr, identifierKind: sdk.IdentifierKind.Ethereum }
            const backend = await sdk.createBackend({ env: 'production' })
            inboxId = await sdk.getInboxIdForIdentifier(backend, identifier)
            if (inboxId) {
              const states = await sdk.Client.fetchInboxStates([inboxId], 'production')
              installations = states?.[0]?.installations || []
            }
          } catch (staticErr) {
            console.warn('praxis: static inbox lookup failed:', staticErr?.message)
          }
        }

        // Approach 2: Try Client.create (may work if not at 10/10, or if local state exists)
        if (installations.length === 0) {
          try {
            tempClient = await sdk.Client.create(signer, { env: 'production', disableAutoRegister: true })
            inboxId = tempClient.inboxId
            const state = await tempClient.inboxState?.(true)
            installations = state?.installations || []
          } catch (createErr) {
            console.warn('praxis: settings client create failed:', createErr?.message)
            // extract inbox ID from error message
            const match = createErr?.message?.match(/[Ii]nbox[Ii][Dd]\s*:?\s*([a-f0-9]{64})/i)
            if (match && !inboxId) inboxId = match[1]
            // try fetchInboxStates with extracted inbox ID
            if (inboxId && installations.length === 0) {
              try {
                const states = await sdk.Client.fetchInboxStates([inboxId], 'production')
                installations = states?.[0]?.installations || []
              } catch (e2) { console.warn('praxis: fetchInboxStates failed:', e2?.message) }
            }
          }
        }

        if (installations.length > 0) {
          renderStaticInstallations(chatEl, installations, inboxId, signer, tempClient)
        } else {
          loadEl.innerHTML = `
            <p style="color:var(--dim);font-size:0.85em">could not load installations</p>
            ${inboxId ? `<p style="font-family:monospace;font-size:0.75em;color:var(--dim);word-break:break-all;margin-top:0.5em">inbox: ${escapeHtml(inboxId)}</p>` : ''}
          `
        }
      } catch (e) {
        console.warn('praxis: settings failed:', e)
        loadEl.innerHTML = `<p style="color:var(--dim);font-size:0.85em">error: ${escapeHtml(e.message?.slice(0, 80))}</p>`
      }
    }
    document.getElementById('xmtp-clear-data')?.addEventListener('click', async () => {
      const dbs = await indexedDB.databases?.() || []
      for (const db of dbs) {
        if (db.name?.includes('xmtp') || db.name?.includes('libxmtp')) indexedDB.deleteDatabase(db.name)
      }
      try {
        if (navigator.storage?.getDirectory) {
          const root = await navigator.storage.getDirectory()
          for await (const name of root.keys()) {
            try { await root.removeEntry(name, { recursive: true }) } catch {}
          }
        }
      } catch {}
      window.location.reload()
    })
    return
  }

  chatEl.innerHTML = `
    <div style="padding:2em;max-width:500px;margin:0 auto">
      <h3 style="margin-bottom:1em">${t('messages.settings') || 'message settings'}</h3>
      <div style="margin-bottom:1.5em">
        <div style="color:var(--dim);font-size:0.8em;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:0.5em">${t('messages.inboxId') || 'your inbox id'}</div>
        <div style="font-family:monospace;font-size:0.85em;word-break:break-all;color:var(--muted)">${client.inboxId || 'unknown'}</div>
      </div>
      <div id="xmtp-installations" style="margin-bottom:1.5em">
        <div style="color:var(--dim);font-size:0.8em;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:0.5em">${t('messages.installations') || 'installations'}</div>
        <p style="color:var(--muted);font-size:0.85em"><span class="praxis-loader"></span></p>
      </div>
      <div id="xmtp-ops-display" style="margin-bottom:1.5em">
        <div style="color:var(--dim);font-size:0.8em;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:0.5em">identity operations</div>
        <div style="font-size:0.85em;color:var(--muted)" id="xmtp-ops-count"></div>
      </div>
      <button id="xmtp-revoke-all" class="buy-btn" style="border-color:var(--dim);color:var(--dim);font-size:0.85em">${t('messages.revokeOther')}</button>
      <button id="xmtp-clear-data" class="buy-btn" style="border-color:#ef4444;color:#ef4444;font-size:0.85em;margin-left:1ch">${t('messages.clearLocal')}</button>
      <button id="xmtp-rotate-inbox" class="buy-btn" style="border-color:#ef4444;color:#ef4444;font-size:0.85em;margin-left:1ch;display:none">rotate inbox</button>
      <p id="xmtp-settings-status" style="color:var(--muted);font-size:0.85em;margin-top:0.5em"></p>
    </div>
  `

  // load installations
  try {
    let state = null
    let installations = []
    try {
      // try inboxState (v7 SDK — may not exist on all builds)
      if (typeof client.inboxState === 'function') {
        state = await client.inboxState(true)
        installations = state?.installations || []
      } else if (typeof client.preferences?.inboxState === 'function') {
        state = await client.preferences.inboxState()
        installations = state?.installations || []
      } else if (client.inboxId) {
        // fallback: fetchInboxStates static method
        const states = await (sdk?.Client?.fetchInboxStates || sdk?.fetchInboxStates)?.([client.inboxId], 'production')
        installations = states?.[0]?.installations || []
      }
    } catch (e1) {
      console.warn('praxis: inbox state load failed:', e1?.message)
    }
    const installEl = document.getElementById('xmtp-installations')
    if (installEl) {
      const myId = client.installationId || ''
      installEl.innerHTML = `
        <div style="color:var(--dim);font-size:0.8em;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:0.5em">${t('messages.installations') || 'installations'} (${installations.length}/10)</div>
        ${installations.map(inst => {
          const id = inst.id || inst.installationId || ''
          const idStr = typeof id === 'object' ? Array.from(id).map(b => b.toString(16).padStart(2, '0')).join('') : String(id)
          // M5: skip non-hex ids so unescaped innerHTML insertion is safe
          if (!/^[0-9a-f]+$/i.test(idStr)) return ''
          const isCurrent = idStr === myId || idStr.slice(0, 16) === String(myId).slice(0, 16)
          return `
          <div style="padding:0.4em 0;border-bottom:1px solid var(--border);font-size:0.85em;display:flex;align-items:center;justify-content:space-between">
            <span style="font-family:monospace;color:var(--muted)">${idStr.slice(0, 20)}...</span>
            ${isCurrent
              ? '<span style="color:var(--green);font-size:0.75em">current</span>'
              : `<button class="xmtp-revoke-one" data-install-id="${idStr}" aria-label="revoke installation ${idStr.slice(0, 12)}" style="background:none;border:1px solid #ef4444;color:#ef4444;font-family:inherit;font-size:0.75em;padding:0.15em 0.75ch;cursor:pointer">revoke</button>`
            }
          </div>`
        }).join('')}
      `
      // individual revoke buttons
      installEl.querySelectorAll('.xmtp-revoke-one').forEach(btn => {
        btn.addEventListener('click', async () => {
          btn.textContent = '...'
          btn.disabled = true
          // Backup conversations before revoking
          try {
            const key = crypto.getRandomValues(new Uint8Array(32))
            const archiveData = await client.createArchive(key)
            const addr = window.getWalletAddress?.()?.toLowerCase() || ''
            if (addr) {
              localStorage.setItem(`xmtp-archive-${addr.toLowerCase()}`, JSON.stringify({
                key: Array.from(key),
                data: Array.from(new Uint8Array(archiveData))
              }))
              dbg('praxis: XMTP archive saved before revocation')
            }
          } catch (e) { console.warn('praxis: archive backup failed:', e?.message) }
          try {
            const idStr = btn.dataset.installId
            const idBytes = new Uint8Array(idStr.match(/.{2}/g).map(b => parseInt(b, 16)))
            // revokeInstallations requires a signer — re-create client if needed
            if (typeof client.revokeInstallations === 'function') {
              try {
                await client.revokeInstallations([idBytes])
              } catch (sigErr) {
                if (sigErr?.message?.includes('Signer unavailable') || sigErr?.message?.includes('signer')) {
                  // Client.build has no signer — on /messages page, client should already have signer.
                  // Try using the existing client which was created with Client.create on this page.
                  btn.textContent = 'sign...'
                  const addr = window.getWalletAddress?.()
                  if (!addr) throw new Error('connect wallet to revoke')
                  // Use static SDK revoke method instead of creating a new client
                  const freshSigner = {
                    type: 'EOA',
                    getIdentifier: () => ({ identifier: addr, identifierKind: sdk.IdentifierKind.Ethereum }),
                    signMessage: (msg) => _xmtpPersonalSign(addr, msg),
                  }
                  // Try static revoke (no new installation needed)
                  if (sdk.Client.revokeInstallations && client.inboxId) {
                    await sdk.Client.revokeInstallations(freshSigner, client.inboxId, [idBytes], 'production')
                  } else {
                    // Last resort: Client.create with disableAutoRegister (does NOT register a new installation)
                    const signerClient = await sdk.Client.create(freshSigner, { env: 'production', disableAutoRegister: true })
                    await signerClient.revokeInstallations([idBytes])
                  }
                } else {
                  throw sigErr
                }
              }
            }
            // Track operation count in localStorage
            try {
              const rAddr = window.getWalletAddress?.()?.toLowerCase() || ''
              if (rAddr) {
                const opsKey = `xmtp-ops-${rAddr}`
                const opCount = parseInt(localStorage.getItem(opsKey) || '0', 10) + 1
                localStorage.setItem(opsKey, String(opCount))
                if (opCount > 200) {
                  console.warn(`praxis: XMTP identity operations at ${opCount}/256 — approaching lifetime limit`)
                }
              }
            } catch {}
            btn.parentElement.remove()
            const countEl = installEl.querySelector('div:first-child')
            const remaining = installEl.querySelectorAll('.xmtp-revoke-one').length + 1
            if (countEl) countEl.textContent = `installations (${remaining}/10)`
          } catch (e) {
            btn.textContent = 'failed'
            console.error('revoke single:', e)
          }
        })
      })
    }
  } catch (e) {
    console.warn('praxis: installations load failed:', e?.message)
    const installEl = document.getElementById('xmtp-installations')
    if (installEl) installEl.innerHTML = `
      <p style="color:var(--dim);font-size:0.85em">could not load installations</p>
      ${client?.inboxId ? `<p style="font-family:monospace;font-size:0.75em;color:var(--dim);word-break:break-all;margin-top:0.5em">inbox: ${escapeHtml(client.inboxId)}</p>` : ''}
    `
  }

  // revoke handler — warns user this affects all other devices
  document.getElementById('xmtp-revoke-all')?.addEventListener('click', async () => {
    const status = document.getElementById('xmtp-settings-status')
    if (!confirm('this will disconnect all other devices (phone, laptop, etc). continue?')) return
    if (status) status.textContent = 'revoking...'
    try {
      // Backup conversations before revoking
      try {
        const key = crypto.getRandomValues(new Uint8Array(32))
        const archiveData = await client.createArchive(key)
        const addr = window.getWalletAddress?.()?.toLowerCase() || ''
        if (addr) {
          localStorage.setItem(`xmtp-archive-${addr.toLowerCase()}`, JSON.stringify({
            key: Array.from(key),
            data: Array.from(new Uint8Array(archiveData))
          }))
          dbg('praxis: XMTP archive saved before revocation')
        }
      } catch (e) { console.warn('praxis: archive backup failed:', e?.message) }

      // Track operation cost — revokeAll costs N operations (one per revoked installation)
      try {
        const rAddr = window.getWalletAddress?.()?.toLowerCase() || ''
        if (rAddr) {
          const st = await client.inboxState?.(true)
          const instCount = (st?.installations?.length || 1) - 1 // minus current
          const opsKey = `xmtp-ops-${rAddr}`
          const opCount = parseInt(localStorage.getItem(opsKey) || '0', 10) + instCount
          localStorage.setItem(opsKey, String(opCount))
          if (opCount > 200) {
            console.warn(`praxis: XMTP identity operations at ${opCount}/256 — approaching lifetime limit`)
          }
        }
      } catch {}

      await client.revokeAllOtherInstallations()
      if (status) status.textContent = 'done — other installations revoked. refresh to reconnect.'
    } catch (e) {
      if (status) status.textContent = `error: ${e.message}. try "clear local XMTP data" instead.`
    }
  })

  // clear local XMTP data (OPFS) — nuclear option for stuck installations
  document.getElementById('xmtp-clear-data')?.addEventListener('click', async () => {
    const status = document.getElementById('xmtp-settings-status')
    if (!confirm('this will clear all local XMTP data. you will need to re-sign to reconnect. continue?')) return
    if (status) status.textContent = 'clearing...'
    try {
      // close existing client
      if (client) { try { await client.close() } catch {} }
      client = null
      // clear OPFS storage
      if (navigator.storage?.getDirectory) {
        const root = await navigator.storage.getDirectory()
        for await (const [name] of root) {
          if (name.includes('xmtp') || name.includes('libxmtp')) {
            await root.removeEntry(name, { recursive: true })
          }
        }
      }
      // clear IndexedDB
      const dbs = await indexedDB.databases?.() || []
      for (const db of dbs) {
        if (db.name?.includes('xmtp')) indexedDB.deleteDatabase(db.name)
      }
      if (status) status.textContent = 'cleared. refreshing...'
      setTimeout(() => location.reload(), 1000)
    } catch (e) {
      if (status) status.textContent = `error: ${e.message}`
    }
  })

  // show operation count from SDK (not just localStorage)
  const addr = window.getWalletAddress?.()?.toLowerCase() || ''
  const opsKey = `xmtp-ops-${addr}`
  let opCount = parseInt(localStorage.getItem(opsKey) || '0', 10)
  // try to get actual count from SDK inboxState
  try {
    if (client?.inboxState) {
      const state = await client.inboxState(true)
      if (state?.identityOperationCount !== undefined) opCount = state.identityOperationCount
      else if (state?.operationCount !== undefined) opCount = state.operationCount
      try { localStorage.setItem(opsKey, String(opCount)) } catch {}
    }
  } catch {}
  const opsCountEl = document.getElementById('xmtp-ops-count')
  if (opsCountEl) {
    const pct = Math.round((opCount / 256) * 100)
    const color = opCount > 230 ? 'var(--red)' : opCount > 200 ? 'var(--yellow)' : 'var(--dim)'
    opsCountEl.innerHTML = `<span style="color:${color}">${opCount} / 256</span> <span style="color:var(--dim);font-size:0.8em">(${pct}% used)</span>`
    if (opCount > 200) {
      opsCountEl.innerHTML += `<br><span style="color:var(--yellow);font-size:0.8em;margin-top:0.3em;display:block">approaching lifetime limit. avoid revoking unless necessary.</span>`
    }
  }
  // show rotate button if near or at limit
  const rotateBtn = document.getElementById('xmtp-rotate-inbox')
  if (rotateBtn && opCount > 230) {
    rotateBtn.style.display = ''
    rotateBtn.addEventListener('click', async () => {
      if (!confirm('rotate your inbox?\n\nthis creates a new inbox ID using the same wallet address. all existing conversations and message history will be permanently lost.\n\nonly do this if you are at or near the 256 operation limit.')) return
      const status = document.getElementById('xmtp-settings-status')
      if (status) status.textContent = 'rotating inbox...'
      try {
        // clear all local XMTP data
        if (client) { try { await client.close() } catch {} }
        client = null
        window._xmtpClient = null
        // clear OPFS
        if (navigator.storage?.getDirectory) {
          const root = await navigator.storage.getDirectory()
          for await (const [name] of root) {
            if (name.includes('xmtp') || name.includes('libxmtp')) {
              await root.removeEntry(name, { recursive: true })
            }
          }
        }
        // clear IndexedDB
        const dbs = await indexedDB.databases?.() || []
        for (const db of dbs) {
          if (db.name?.includes('xmtp')) indexedDB.deleteDatabase(db.name)
        }
        // reset operation counter
        localStorage.setItem(opsKey, '0')
        // clear XMTP registration flag to force fresh Client.create
        localStorage.removeItem(`xmtp-registered-${addr.toLowerCase()}`)
        if (status) status.textContent = 'inbox rotated. refreshing...'
        setTimeout(() => location.reload(), 1500)
      } catch (e) {
        if (status) status.textContent = `rotation failed: ${e.message}`
      }
    })
  }
}

// --- New message picker ---

// Shared: fetch mutual follows for contact pickers
async function _fetchMutuals() {
  const myAddr = window.getWalletAddress()?.toLowerCase()
  if (!myAddr) return []
  async function _fetchPages(field, extractKey) {
    const items = []
    let cursor = null
    for (let page = 0; page < 10; page++) {
      const vars = { me: myAddr }
      if (cursor) vars.after = cursor
      const d = await query(`query($me: String!${cursor ? ', $after: String' : ''}) { follows(where: { ${field}: $me }, limit: 200${cursor ? ', after: $after' : ''}) { items { ${extractKey} } pageInfo { endCursor hasNextPage } } }`, vars)
      items.push(...(d.follows?.items || []))
      if (items.length >= 2000 || !d.follows?.pageInfo?.hasNextPage) break
      cursor = d.follows.pageInfo.endCursor
    }
    return items
  }
  const [followingItems, followerItems] = await Promise.all([
    _fetchPages('follower', 'followed'),
    _fetchPages('followed', 'follower'),
  ])
  const iFollow = new Set(followingItems.map(f => f.followed.toLowerCase()))
  const followsMe = new Set(followerItems.map(f => f.follower.toLowerCase()))
  return [...iFollow].filter(addr => followsMe.has(addr) && addr !== myAddr)
}

async function toggleNewPicker() {
  const picker = document.getElementById('messages-new-picker')
  if (picker.style.display !== 'none') { picker.style.display = 'none'; return }

  picker.innerHTML = `<div style="color:var(--muted);padding:0.5em;font-size:0.85em">${t('messages.loadingFollows')}</div>`
  picker.style.display = 'block'

  const myAddr = window.getWalletAddress()?.toLowerCase()
  if (!myAddr) return

  try {
    // H5: cursor-based pagination for mutual follows, pages of 200, capped at 2000
    async function fetchFollowPages(field, extractKey) {
      const items = []
      let cursor = null
      for (let page = 0; page < 10; page++) {
        const vars = { me: myAddr }
        if (cursor) vars.after = cursor
        const data = await query(`query($me: String!${cursor ? ', $after: String' : ''}) { follows(where: { ${field}: $me }, limit: 200${cursor ? ', after: $after' : ''}) { items { ${extractKey} } pageInfo { endCursor hasNextPage } } }`, vars)
        items.push(...(data.follows?.items || []))
        if (items.length >= 2000 || !data.follows?.pageInfo?.hasNextPage) break
        cursor = data.follows.pageInfo.endCursor
      }
      return items
    }
    const [followingItems, followerItems] = await Promise.all([
      fetchFollowPages('follower', 'followed'),
      fetchFollowPages('followed', 'follower'),
    ])
    const iFollow = new Set(followingItems.map(f => f.followed.toLowerCase()))
    const followsMe = new Set(followerItems.map(f => f.follower.toLowerCase()))
    const mutuals = [...iFollow].filter(addr => followsMe.has(addr) && addr !== myAddr)

    if (mutuals.length === 0) {
      picker.innerHTML = `<div style="color:var(--muted);padding:0.5em;font-size:0.85em">${t('messages.noMutuals')}</div>`
      return
    }

    // resolve mutual domains on demand
    const mutualDomains = await resolveAddresses(query, mutuals).catch(() => ({}))
    Object.assign(addrToDomain, mutualDomains)

    // Hide conversation list, show picker with header
    const list = document.getElementById('messages-list')
    if (list) list.style.display = 'none'

    let html = `<div class="msg-picker-header">
      <button class="msg-picker-back"><i class="ph ph-arrow-left"></i></button>
      <span>new message</span>
    </div>
    <input class="msg-picker-search" type="text" placeholder="search..." autofocus>`
    html += mutuals.map(addr => {
      const domain = addrToDomain[addr] || `${addr.slice(0, 6)}...${addr.slice(-4)}`
      return `<div class="msg-convo-item msg-new-item" data-addr="${escapeHtml(addr)}" data-domain="${escapeHtml(domain)}">${escapeHtml(domain)}</div>`
    }).join('')
    picker.innerHTML = html

    // Back button closes picker
    picker.querySelector('.msg-picker-back')?.addEventListener('click', () => {
      picker.style.display = 'none'
      if (list) list.style.display = ''
    })
    // Search filter
    picker.querySelector('.msg-picker-search')?.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase()
      picker.querySelectorAll('.msg-new-item').forEach(el => {
        el.style.display = el.dataset.domain.toLowerCase().includes(q) ? '' : 'none'
      })
    })
    picker.querySelectorAll('.msg-new-item').forEach(el => {
      el.addEventListener('click', () => {
        picker.style.display = 'none'
        if (list) list.style.display = ''
        openDmByAddress(el.dataset.addr, el.dataset.domain)
      })
    })
  } catch {
    picker.innerHTML = `<div style="color:var(--muted);padding:0.5em">${t('messages.errorLoading')}</div>`
  }
}

// --- Group chat picker ---

async function toggleGroupPicker() {
  const picker = document.getElementById('messages-new-picker')
  if (picker.style.display !== 'none') { picker.style.display = 'none'; return }

  picker.innerHTML = `<div style="color:var(--muted);padding:0.5em;font-size:0.85em">${t('messages.loadingFollows')}</div>`
  picker.style.display = 'block'

  const myAddr = window.getWalletAddress()?.toLowerCase()
  if (!myAddr) return

  try {
    // H5: cursor-based pagination for group follows, pages of 200, capped at 2000
    async function fetchGroupFollowPages(field, extractKey) {
      const items = []
      let cursor = null
      for (let page = 0; page < 10; page++) {
        const vars = { me: myAddr }
        if (cursor) vars.after = cursor
        const d = await query(`query($me: String!${cursor ? ', $after: String' : ''}) { follows(where: { ${field}: $me }, limit: 200${cursor ? ', after: $after' : ''}) { items { ${extractKey} } pageInfo { endCursor hasNextPage } } }`, vars)
        items.push(...(d.follows?.items || []))
        if (items.length >= 2000 || !d.follows?.pageInfo?.hasNextPage) break
        cursor = d.follows.pageInfo.endCursor
      }
      return items
    }
    const [followingItems, followerItems] = await Promise.all([
      fetchGroupFollowPages('follower', 'followed'),
      fetchGroupFollowPages('followed', 'follower'),
    ])
    const iFollow = new Set(followingItems.map(f => f.followed.toLowerCase()))
    const followsMe = new Set(followerItems.map(f => f.follower.toLowerCase()))
    const mutuals = [...iFollow].filter(addr => followsMe.has(addr) && addr !== myAddr)

    if (mutuals.length === 0) {
      picker.innerHTML = `<div style="color:var(--muted);padding:0.5em;font-size:0.85em">${t('messages.noMutuals')}</div>`
      return
    }

    // resolve mutual domains
    const mutualDomains = await resolveAddresses(query, mutuals).catch(() => ({}))
    Object.assign(addrToDomain, mutualDomains)

    const list = document.getElementById('messages-list')
    if (list) list.style.display = 'none'

    picker.innerHTML = `
      <div class="msg-picker-header">
        <button class="msg-picker-back"><i class="ph ph-arrow-left"></i></button>
        <span>new group</span>
      </div>
      <div style="padding:0.5em 1em">
        <div style="font-size:0.75em;color:var(--muted);margin-bottom:0.3em">group name</div>
        <input id="group-name-input" type="text" placeholder="e.g. the crew" autofocus style="width:100%;padding:0.4em 0.5em;margin-bottom:0.75em;background:var(--surface);border:1px solid var(--accent);color:var(--text);font-family:inherit;font-size:0.85em;outline:none">
        <div style="font-size:0.75em;color:var(--muted);margin-bottom:0.3em">add members (mutuals only)</div>
        <div id="group-member-list" style="max-height:200px;overflow-y:auto">
          ${mutuals.map(addr => {
            const domain = addrToDomain[addr] || addr.slice(0, 6) + '...' + addr.slice(-4)
            return `<label class="msg-convo-item" style="display:flex;align-items:center;gap:0.5em;cursor:pointer">
              <input type="checkbox" data-addr="${escapeHtml(addr)}" style="accent-color:var(--accent)">
              <span style="font-size:0.85em">${escapeHtml(domain)}</span>
            </label>`
          }).join('')}
        </div>
        <button id="group-create-btn" class="buy-btn" style="font-size:0.8em;padding:0.2em 0.8ch;margin-top:0.5em">${t('messages.create')}</button>
      </div>
    `

    picker.querySelector('.msg-picker-back')?.addEventListener('click', () => {
      picker.style.display = 'none'
      if (list) list.style.display = ''
    })

    document.getElementById('group-create-btn').addEventListener('click', async () => {
      const nameInput = document.getElementById('group-name-input')
      const name = nameInput.value.trim()
      const checked = [...picker.querySelectorAll('input[type="checkbox"]:checked')]
      const addrs = checked.map(cb => cb.dataset.addr)

      if (!name) { nameInput.focus(); nameInput.style.borderColor = 'var(--error, #f55)'; return }
      if (addrs.length === 0) return

      // resolve inbox IDs for selected members
      const inboxIds = []
      for (const addr of addrs) {
        let id = inboxToAddr[addr]
        if (!id) {
          try {
            id = await client.fetchInboxIdByIdentifier({
              identifier: addr,
              identifierKind: sdk.IdentifierKind.Ethereum,
            })
            if (id) { setInboxToAddr(id, addr); setInboxToAddr(addr, id) }
          } catch {}
        }
        if (id) inboxIds.push(id)
      }

      if (inboxIds.length === 0) return

      try {
        const group = await client.conversations.createGroup(inboxIds, { name })
        picker.style.display = 'none'
        if (list) list.style.display = ''
        await loadConversations()
        openConversation(group, name || t('messages.unnamedGroup'))
      } catch (e) {
        console.error('create group error:', e)
      }
    })
  } catch {
    picker.innerHTML = `<div style="color:var(--muted);padding:0.5em">${t('messages.errorLoading')}</div>`
  }
}

// --- Group members panel ---

async function toggleMembersPanel() {
  const existing = document.getElementById('messages-members-panel')
  if (existing) { existing.remove(); return }
  if (!activeConvo || !activeIsGroup) return

  const panel = document.createElement('div')
  panel.id = 'messages-members-panel'
  panel.style.cssText = 'position:absolute;top:2.5em;right:0;background:var(--bg,#111);border:1px solid var(--border,#333);padding:0.75em 1em;z-index:100;min-width:220px;max-height:300px;overflow-y:auto;font-size:0.85em'
  panel.innerHTML = '<div style="color:var(--muted)">loading members...</div>'

  const header = document.getElementById('messages-peer-name')?.parentElement
  if (header) {
    header.style.position = 'relative'
    header.appendChild(panel)
  }

  try {
    const members = typeof activeConvo.members === 'function' ? await activeConvo.members() : activeConvo.members || []
    const myInboxId = client?.inboxId

    // determine admin/super-admin status
    let admins = new Set()
    let superAdmins = new Set()
    try {
      // XMTP v7 group metadata
      if (activeConvo.admins) {
        const adminList = await activeConvo.admins()
        admins = new Set(adminList || [])
      }
      if (activeConvo.superAdmins) {
        const superList = await activeConvo.superAdmins()
        superAdmins = new Set(superList || [])
      }
    } catch (e) { console.warn('praxis: admin list:', e?.message) }

    const iAmAdmin = admins.has(myInboxId) || superAdmins.has(myInboxId)
    const iAmSuperAdmin = superAdmins.has(myInboxId)

    let html = '<div style="margin-bottom:0.5em;color:var(--muted);font-size:0.8em;text-transform:uppercase;letter-spacing:0.05em">members</div>'

    for (const m of members) {
      const mInboxId = m.inboxId || m
      const mAddr = inboxToAddr[mInboxId]
      const domain = mAddr ? (addrToDomain[mAddr] || mAddr.slice(0, 8) + '...') : (typeof mInboxId === 'string' ? mInboxId.slice(0, 8) + '...' : 'unknown')
      const isAdmin = admins.has(mInboxId)
      const isSuperAdmin = superAdmins.has(mInboxId)
      const isMe = mInboxId === myInboxId

      html += `<div style="display:flex;justify-content:space-between;align-items:center;padding:0.4em 0;border-bottom:1px solid var(--border)">`
      html += `<span style="color:var(--fg)">${escapeHtml(domain)}`
      if (isSuperAdmin) html += ' <span style="color:#a78bfa;font-size:0.7em">super admin</span>'
      else if (isAdmin) html += ' <span style="color:#60a5fa;font-size:0.7em">admin</span>'
      if (isMe) html += ' <span style="color:var(--dim);font-size:0.7em">(you)</span>'
      html += `</span>`

      // action buttons
      html += '<span style="display:flex;gap:0.3ch">'
      if (iAmAdmin && !isMe && !isSuperAdmin) {
        html += `<button class="buy-btn member-remove-btn" data-inbox="${mInboxId}" style="font-size:0.7em;padding:0.1em 0.5ch;border-color:#ef4444;color:#ef4444">remove</button>`
      }
      if (iAmSuperAdmin && !isMe && !isSuperAdmin) {
        if (isAdmin) {
          html += `<button class="buy-btn member-demote-btn" data-inbox="${mInboxId}" style="font-size:0.7em;padding:0.1em 0.5ch">demote</button>`
        } else {
          html += `<button class="buy-btn member-promote-btn" data-inbox="${mInboxId}" style="font-size:0.7em;padding:0.1em 0.5ch">promote</button>`
        }
      }
      html += '</span>'
      html += `</div>`
    }

    html += `<button class="buy-btn" id="members-leave-btn" style="margin-top:0.75em;font-size:0.8em;padding:0.3em 1ch;width:100%;border-color:#ef4444;color:#ef4444">leave group</button>`

    panel.innerHTML = html

    // wire up member action buttons
    panel.querySelectorAll('.member-remove-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const inboxId = btn.dataset.inbox
        if (!confirm('remove this member from the group?')) return
        btn.textContent = '...'
        try {
          await activeConvo.removeMembers([inboxId])
          btn.closest('div').remove()
        } catch (e) {
          console.warn('remove member:', e?.message)
          btn.textContent = 'error'
        }
      })
    })

    panel.querySelectorAll('.member-promote-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const inboxId = btn.dataset.inbox
        btn.textContent = '...'
        try {
          await activeConvo.addAdmin(inboxId)
          btn.textContent = 'promoted'
          btn.disabled = true
        } catch (e) {
          console.warn('promote:', e?.message)
          btn.textContent = 'error'
        }
      })
    })

    panel.querySelectorAll('.member-demote-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const inboxId = btn.dataset.inbox
        btn.textContent = '...'
        try {
          await activeConvo.removeAdmin(inboxId)
          btn.textContent = 'demoted'
          btn.disabled = true
        } catch (e) {
          console.warn('demote:', e?.message)
          btn.textContent = 'error'
        }
      })
    })

    document.getElementById('members-leave-btn')?.addEventListener('click', async () => {
      if (!confirm('leave this group?')) return
      try {
        // XMTP v7: remove self
        await activeConvo.removeMembers([myInboxId])
        panel.remove()
        // go back to conversation list
        document.getElementById('messages-chat-active').style.display = 'none'
        document.getElementById('messages-chat-empty').style.display = 'flex'
        activeConvo = null
        await loadConversations()
      } catch (e) {
        console.warn('leave group:', e?.message)
      }
    })

  } catch (e) {
    panel.innerHTML = `<div style="color:var(--muted)">could not load members: ${escapeHtml(e?.message || 'unknown error')}</div>`
  }
}

async function openDmByAddress(addr, domain) {
  if (!client) return

  try {
    const peerInboxId = await resolveInboxIdForAddr(addr)
    if (!peerInboxId) return

    // Find existing conversation (active or inactive) or create new
    await (client.conversations.syncAll?.(['allowed', 'unknown']) || client.conversations.sync())
    let convo = null
    let activeConvoFound = null
    for (const c of await client.conversations.list()) {
      try {
        if (await c.peerInboxId() === peerInboxId) {
          const isAct = typeof c.isActive === 'function' ? await c.isActive() : true
          if (isAct) { activeConvoFound = c; break }
          if (!convo) convo = c // keep first inactive as fallback
        }
      } catch {}
    }
    convo = activeConvoFound || convo
    if (!convo) {
      // Use findOrCreateDmWithIdentity if available, otherwise createDm
      if (client.conversations.findOrCreateDmWithIdentity) {
        const idKind = window._xmtpSdk?.IdentifierKind?.Ethereum ?? 0
        convo = await client.conversations.createDmWithIdentifier({ identifier: addr, identifierKind: idKind })
      } else {
        convo = await client.conversations.createDm(peerInboxId)
      }
      try { await convo.sync() } catch {}
    }
    openConversation(convo, domain)
    // Ensure the new/existing conversation appears in the sidebar
    try { await _loadConversations(window.getWalletAddress?.()) } catch {}
    // Re-highlight the active conversation in the refreshed list
    const listEl = document.getElementById('messages-list')
    if (listEl && convo) {
      listEl.querySelectorAll('.msg-convo-item').forEach(item => {
        item.classList.remove('active')
      })
      // Find the item by peer domain text
      listEl.querySelectorAll('.msg-convo-item').forEach(item => {
        const peerEl = item.querySelector('.msg-convo-peer')
        if (peerEl?.textContent === domain) {
          item.classList.add('active')
        }
      })
    }
  } catch (e) {
    console.error('open DM error:', e)
  }
}
