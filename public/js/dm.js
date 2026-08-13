// Global DM panel — iMessage-style messaging via XMTP
// Loaded on every page. Owns the single XMTP client instance.
import { query } from './ponder.js'
import { createWalletClient, custom, parseEther } from './vendor.js'
import { optimism } from './vendor.js'
import { escapeHtml, resolveAddresses, getPublicClient , getWalletProvider, timeAgo, dbg } from './utils.js'
import { getEthPrices, getUserCurrency, formatFiat } from './fiat.js'

let client = null
let sdk = null
let conversations = []
let activeConvo = null
let activeStream = null
let activePeerAddr = null
let inboxToAddr = {}
let addrToDomain = {}
let panelOpen = false

const ADDR_MAP_MAX = 500
function boundedAssign(obj, key, value) {
  const keys = Object.keys(obj)
  if (keys.length >= ADDR_MAP_MAX) delete obj[keys[0]]
  obj[key] = value
}

// patchWorker() imported from xmtp-proxy.js (shared with messages.js + wallet.js)

// --- Panel HTML injection ---

function injectPanel() {
  // add unread dot to toggle button (top-bar only — dock-chat navigates to /messages)
  const toggle = document.getElementById('dm-toggle')
  if (toggle) {
    const dot = document.createElement('span')
    dot.id = 'dm-badge'
    dot.className = 'dm-badge'
    toggle.appendChild(dot)
    if (!toggle.dataset.dmBound) {
      toggle.dataset.dmBound = '1'
      toggle.addEventListener('click', togglePanel)
    }
  }
  // add badge to dock chat link (no click handler — it's a navigation link)
  const dockChat = document.getElementById('dock-chat')
  if (dockChat && !document.getElementById('dock-dm-badge')) {
    const dot = document.createElement('span')
    dot.id = 'dock-dm-badge'
    dot.className = 'dm-badge'
    dockChat.appendChild(dot)
  }

  const panel = document.createElement('div')
  panel.id = 'dm-panel'
  panel.className = 'dm-closed'
  panel.innerHTML = `
    <div id="dm-list-view">
      <div class="dm-header">
        <span>messages</span>
        <button id="dm-close-btn" class="dm-icon-btn"><i class="ph ph-x"></i></button>
      </div>
      <div id="dm-connect-prompt" style="padding:1em;color:#666">connect wallet to message</div>
      <div id="dm-loading" style="padding:1em;display:none"><div class="praxis-loader"></div></div>
      <div id="dm-tabs" style="display:none;padding:0 1em;border-bottom:1px solid #1a1a1a">
        <button class="dm-tab dm-tab-active" data-tab="dms">dms</button>
        <button class="dm-tab" data-tab="projects">projects</button>
      </div>
      <div id="dm-convo-list"></div>
      <div id="dm-project-list" style="display:none"></div>
      <div id="dm-new-section" style="display:none">
        <button id="dm-new-btn" class="buy-btn" style="width:100%;margin:0.5em 0">new message</button>
        <div id="dm-new-picker" style="display:none"></div>
      </div>
    </div>
    <div id="dm-convo-view" style="display:none">
      <div class="dm-header">
        <button id="dm-back-btn" class="dm-icon-btn"><i class="ph ph-arrow-left"></i></button>
        <span id="dm-convo-peer"></span>
        <button id="dm-close-btn2" class="dm-icon-btn"><i class="ph ph-x"></i></button>
      </div>
      <div id="dm-messages"></div>
      <div id="dm-pay-bar" class="pay-bar-panel">
        <div class="pay-stepper-wrap" id="dm-pay-stepper">
          <button type="button" class="pay-step-btn" data-dir="minus">−</button>
          <div class="pay-amount-center"><span id="dm-pay-display" class="pay-display">$0</span></div>
          <button type="button" class="pay-step-btn" data-dir="plus">+</button>
        </div>
        <div class="pay-keypad-wrap" id="dm-pay-keypad">
          <input type="text" inputmode="decimal" id="dm-pay-eth-input" class="pay-eth-input" placeholder="0" autocomplete="off">
          <span class="pay-currency-label">ETH</span>
        </div>
        <span id="dm-pay-conversion" class="pay-conversion-line"></span>
        <button type="button" id="dm-pay-mode-toggle" class="pay-mode-toggle">Show Keypad</button>
        <span id="dm-pay-balance" class="pay-balance-line"></span>
        <div class="pay-actions">
          <button type="button" id="dm-pay-request" class="pay-action-btn pay-request-btn">Request</button>
          <button type="button" id="dm-pay-send" class="pay-action-btn pay-send-btn">Send</button>
        </div>
        <button type="button" id="dm-pay-cancel" class="pay-cancel-link">cancel</button>
      </div>
      <form id="dm-send-form">
        <input type="text" id="dm-input" placeholder="type a message..." autocomplete="off">
        <button type="submit" class="dm-icon-btn"><i class="ph ph-paper-plane-tilt"></i></button>
        <button type="button" id="dm-pay-toggle" class="dm-icon-btn" title="send ETH" aria-label="send ETH"><i class="ph ph-money"></i></button>
      </form>
    </div>
  `
  document.body.appendChild(panel)

  document.getElementById('dm-close-btn').addEventListener('click', togglePanel)
  document.getElementById('dm-close-btn2').addEventListener('click', togglePanel)
  document.getElementById('dm-back-btn').addEventListener('click', showListView)
  document.getElementById('dm-send-form').addEventListener('submit', sendMessage)

  // payment toggle — replaces message input with pay UI
  document.getElementById('dm-pay-toggle').addEventListener('click', () => {
    const bar = document.getElementById('dm-pay-bar')
    const form = document.getElementById('dm-send-form')
    const open = bar.style.display === 'none' || !bar.style.display
    bar.style.display = open ? 'flex' : 'none'
    form.style.display = open ? 'none' : 'flex'
    if (open) {
      _dmPayFiatAmount = 0
      _dmPayKeypadMode = false
      _dmPayUpdateDisplay()
      _fetchPayBalance()
    }
  })
  document.getElementById('dm-pay-cancel').addEventListener('click', _dmPayClose)
  document.getElementById('dm-pay-send').addEventListener('click', () => sendPayment('send'))
  document.getElementById('dm-pay-request').addEventListener('click', () => sendPayment('request'))
  document.getElementById('dm-pay-mode-toggle').addEventListener('click', () => {
    _dmPayKeypadMode = !_dmPayKeypadMode
    document.getElementById('dm-pay-stepper').style.display = _dmPayKeypadMode ? 'none' : 'flex'
    document.getElementById('dm-pay-keypad').style.display = _dmPayKeypadMode ? 'flex' : 'none'
    document.getElementById('dm-pay-mode-toggle').textContent = _dmPayKeypadMode ? 'Use Stepper' : 'Show Keypad'
    if (_dmPayKeypadMode) document.getElementById('dm-pay-eth-input').focus()
    _dmPayUpdateDisplay()
  })
  document.getElementById('dm-pay-bar').querySelectorAll('.pay-step-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const dir = btn.dataset.dir === 'plus' ? 1 : -1
      _dmPayFiatAmount = Math.max(0, _dmPayFiatAmount + dir)
      _dmPayUpdateDisplay()
    })
  })
  document.getElementById('dm-pay-eth-input').addEventListener('input', () => _dmPayUpdateDisplay())
}

async function togglePanel() {
  const panel = document.getElementById('dm-panel')
  panelOpen = !panelOpen
  panel.className = panelOpen ? 'dm-open' : 'dm-closed'
  if (panelOpen) {
    if (!client) await lazyInitClient()
    if (client) loadConversations()
  }
}

// --- XMTP Client ---

async function initClient() {
  const address = window.getWalletAddress()
  if (!address || client) return

  // Reuse existing client from messages.js or wallet.js if available
  if (window._xmtpClient?.inboxId) {
    client = window._xmtpClient
    sdk = window._xmtpSdk || await import('./vendor-xmtp.js')
    startGlobalMessageStream()
    await _initDmUI()
    return
  }

  // Only use Client.build (FREE — no identity operation cost).
  // dm.js loads on every page and must NEVER create new installations.
  // If no OPFS database exists (user never visited /messages), skip XMTP entirely.
  const hasRegistered = localStorage.getItem(`xmtp-registered-${address.toLowerCase()}`)
  if (!hasRegistered) {
    dbg('praxis: dm.js skipping XMTP — no prior registration (visit /messages first)')
    return
  }

  // Cross-tab coordination via xmtp-proxy module
  const _xmtpLockName = `xmtp-${location.hostname}`
  const { acquireLeadership, createProxyClient, startLeaderResponder, patchWorker } = await import('./xmtp-proxy.js')
  const { isLeader, channel, onPromoted, release } = await acquireLeadership(_xmtpLockName)

  if (isLeader) {
    window._xmtpLockHolder = true
  }

  let _dmUIBound = false
  async function _initDmUI() {
    document.getElementById('dm-connect-prompt').style.display = 'none'
    document.getElementById('dm-new-section').style.display = 'block'
    document.getElementById('dm-tabs').style.display = 'flex'
    if (!_dmUIBound) {
      _dmUIBound = true
      document.getElementById('dm-new-btn').addEventListener('click', toggleNewPicker)
      document.querySelectorAll('.dm-tab').forEach(tab => {
        tab.addEventListener('click', () => {
          document.querySelectorAll('.dm-tab').forEach(t => t.classList.remove('dm-tab-active'))
          tab.classList.add('dm-tab-active')
          const tabName = tab.dataset.tab
          document.getElementById('dm-convo-list').style.display = tabName === 'dms' ? 'block' : 'none'
          document.getElementById('dm-project-list').style.display = tabName === 'projects' ? 'block' : 'none'
          document.getElementById('dm-new-section').style.display = tabName === 'dms' ? 'block' : 'none'
          if (tabName === 'projects') loadProjectGroups()
        })
      })
    }
    await resolveArtistDomains()
    await loadConversations()
    await updateUnreadBadge()
  }

  if (!isLeader) {
    // Follower: use proxy client for full DM functionality
    dbg('praxis: dm.js follower — using proxy client')
    client = createProxyClient(channel)
    sdk = await import('./vendor-xmtp.js')
    window._xmtpClient = client
    window._xmtpSdk = sdk
    // start global message stream for unread dot (via proxy broadcasts)
    startGlobalMessageStream()
    await _initDmUI()
    // Auto-promote when leader closes
    onPromoted.then(async () => {
      dbg('praxis: dm.js promoted to leader')
      window._xmtpLockHolder = true
      try {
        if (client?.close) client.close()
        patchWorker()
        const identifier = { identifier: address, identifierKind: sdk.IdentifierKind.Ethereum }
        client = await sdk.Client.build(identifier, { env: 'production' })
        if (client?.inboxId) {
          window._xmtpClient = client
          startLeaderResponder(channel, () => client, { releaseLock: release })
          startGlobalMessageStream()
        }
      } catch (e) { console.warn('praxis: dm.js leader promotion failed:', e?.message) }
    })
    return
  }

  // Leader: initialize real XMTP client
  patchWorker()
  sdk = await import('./vendor-xmtp.js')

  const identifier = {
    identifier: address,
    identifierKind: sdk.IdentifierKind.Ethereum,
  }

  try {
    client = await sdk.Client.build(identifier, { env: 'production' })
    if (!client?.inboxId) {
      client = null
      console.warn('praxis: dm.js Client.build returned no inboxId')
      return
    }
  } catch (e) {
    client = null
    console.warn('praxis: dm.js Client.build failed:', e?.message)
    return
  }

  window._xmtpClient = client
  window._xmtpSdk = sdk

  // Start leader responder — releaseLock lets /messages tab take over
  startLeaderResponder(channel, () => client, { releaseLock: release })

  // start global message stream for unread dot on dock
  startGlobalMessageStream()

  await _initDmUI()
}

// --- Domain resolution ---

async function resolveArtistDomains() {
  // resolve peer domains on demand from discovered addresses
  try {
    const peerAddrs = Object.values(inboxToAddr).filter(a => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a))
    dbg('praxis dm: resolving', peerAddrs.length, 'addresses:', peerAddrs)
    if (peerAddrs.length > 0) {
      const resolved = await resolveAddresses(query, peerAddrs)
      dbg('praxis dm: resolved:', resolved)
      // merge with lowercase keys for consistent lookup
      for (const [addr, domain] of Object.entries(resolved)) {
        boundedAssign(addrToDomain, addr, domain)
        boundedAssign(addrToDomain, addr.toLowerCase(), domain)
      }
    }
  } catch (e) { console.warn("praxis dm resolve error:", e?.message) }
}


// CQ-H15: this only ever checked the local cache and returned null on a miss —
// it never actually resolved anything for a newly-seen inbox ID. Mirror the
// fallback used throughout messages.js: ask the XMTP network via
// fetchInboxStates for the address(es) associated with this inbox, then cache
// the result both ways.
async function resolveInboxId(inboxId) {
  if (inboxToAddr[inboxId]) return inboxToAddr[inboxId]
  if (!inboxId || !sdk) return null
  try {
    const states = await sdk.Client.fetchInboxStates?.([inboxId], 'production')
    if (Array.isArray(states) && states[0]) {
      const ids = states[0].accountIdentifiers || states[0].accountAddresses || states[0].identifiers || []
      for (const id of ids) {
        const addr = typeof id === 'string' ? id : id?.identifier || id?.address
        if (addr && /^0x[0-9a-f]{40}$/i.test(addr)) {
          const lower = addr.toLowerCase()
          boundedAssign(inboxToAddr, inboxId, lower)
          boundedAssign(inboxToAddr, lower, inboxId)
          return lower
        }
      }
    }
  } catch (e) { if (e?.message) console.warn('praxis dm resolveInboxId:', e.message) }
  return null
}

function domainForInbox(inboxId) {
  const addr = inboxToAddr[inboxId]
  if (addr) {
    const domain = addrToDomain[addr] || addrToDomain[addr.toLowerCase()]
    if (!domain) dbg('praxis dm: no domain for addr', addr, 'addrToDomain keys:', Object.keys(addrToDomain))
    if (domain) return domain
    return addr.slice(0, 6) + '...' + addr.slice(-4)
  }
  return inboxId?.slice(0, 8) + '...'
}

// --- Conversation list ---

async function loadConversations() {
  const listEl = document.getElementById('dm-convo-list')
  const loadingEl = document.getElementById('dm-loading')
  if (!client) return

  loadingEl.style.display = 'block'

  const CHUNK = 10
  // Fix 5 (H3): paginate client.conversations.list(). Returning every convo
  // ever seen hangs the main thread for seconds at 1000+ DMs, and the chunk
  // loop below is N+1 on lastMessage/peerInboxId/members.
  const CONVO_PAGE = 100
  try {
    await client.conversations.sync()
    // MEDIUM-2: no silent fallback — if the SDK rejects the limit arg we
    // warn and continue with an empty list rather than fetching every convo.
    let all = []
    try {
      all = await client.conversations.list({ limit: BigInt(CONVO_PAGE) })
    } catch (e) {
      console.warn('praxis: conversations.list({limit}) rejected:', e?.message)
      all = []
    }
    // Cap processing at CONVO_PAGE regardless of what list() returned.
    if (Array.isArray(all) && all.length > CONVO_PAGE) all = all.slice(0, CONVO_PAGE)
    conversations = all

    // Process conversations in parallel chunks (capped to CONVO_PAGE)
    const items = []
    for (let i = 0; i < conversations.length; i += CHUNK) {
      const chunk = conversations.slice(i, i + CHUNK)
      const results = await Promise.all(chunk.map(async (c) => {
        const lastMsg = await c.lastMessage().catch(() => null)
        let peerInboxId = null
        try { peerInboxId = await c.peerInboxId() } catch (e) { if (e?.message) console.warn("praxis:", e.message) }
        // Lazy resolve: only resolve this conversation's peer address
        if (peerInboxId && !inboxToAddr[peerInboxId]) {
          // Eagerly resolve inbox ID → wallet address for conversation list display
          try {
            const members = await c.members()
            for (const m of members) {
              const mAddr = m.accountAddresses?.[0]?.toLowerCase()
              const mInboxId = m.inboxId
              if (mAddr && mInboxId) {
                boundedAssign(inboxToAddr, mInboxId, mAddr)
                boundedAssign(inboxToAddr, mAddr, mInboxId)
              }
            }
          } catch {}
        }
        const peerDomain = peerInboxId ? domainForInbox(peerInboxId) : 'unknown'
        const text = extractText(lastMsg)
        const time = lastMsg?.sentAtNs ? timeAgo(Number(lastMsg.sentAtNs) / 1e6) : ''
        return { convo: c, peerDomain, preview: text || '', time, peerInboxId }
      }))
      items.push(...results)
    }

    // sort by most recent
    items.sort((a, b) => {
      const ta = a.convo.createdAtNs || 0
      const tb = b.convo.createdAtNs || 0
      return tb - ta
    })

    if (items.length === 0) {
      listEl.innerHTML = `<div style="color:var(--muted);padding:2em 1em;text-align:center;font-size:0.9em">no conversations yet — start one with the <span style="font-size:1.1em">+</span> button above</div>`
    } else {
      const hasMore = items.length >= CONVO_PAGE
      listEl.innerHTML = items.map((item, i) => `
        <div class="dm-convo-item" data-idx="${i}">
          <div class="dm-convo-peer">${escapeHtml(item.peerDomain)}</div>
          <div class="dm-convo-preview">${escapeHtml(item.preview.slice(0, 50))}${item.preview.length > 50 ? '...' : ''}</div>
          <div class="dm-convo-time">${item.time}</div>
        </div>
      `).join('') + (hasMore ? `<div id="dm-load-more" class="dm-convo-item" style="text-align:center;color:var(--muted);cursor:pointer;padding:0.75em 1em">load more</div>` : '')
    }

    // store for click handler
    window._dmItems = items

    // MEDIUM-1: prune dm-unread-* localStorage keys for conversations no longer
    // in the active list (left groups, blocks, etc.) so the badge doesn't leak.
    try {
      const liveIds = new Set(items.map(it => it.convo?.id).filter(Boolean))
      const toRemove = []
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (k && k.startsWith(UNREAD_KEY_PREFIX)) {
          const convoId = k.slice(UNREAD_KEY_PREFIX.length)
          if (!liveIds.has(convoId)) toRemove.push(k)
        }
      }
      for (const k of toRemove) localStorage.removeItem(k)
      if (toRemove.length) _recomputeBadgeTotal()
    } catch {}

    listEl.querySelectorAll('.dm-convo-item:not(#dm-load-more)').forEach(el => {
      if (el.dataset.bound) return
      el.dataset.bound = '1'
      el.addEventListener('click', () => {
        const idx = parseInt(el.dataset.idx)
        const item = window._dmItems[idx]
        if (item) openConversation(item.convo, item.peerDomain)
      })
    })

    // Fix 5 (H3): load-more button for additional conversation pages.
    const loadMoreEl = document.getElementById('dm-load-more')
    if (loadMoreEl) {
      loadMoreEl.addEventListener('click', async () => {
        loadMoreEl.textContent = 'loading...'
        let more = []
        try {
          // Fix NEW-M2: XMTP v7 browser SDK does not document an `offset` cursor
          // for conversations.list(). Previous fallback silently fetched the FULL
          // list — defeating pagination at 1000+ convos. We now call with limit
          // only and let the SDK error out if offset isn't honored, so we fail
          // loudly rather than stalling the UI. Known limitation: true cursor
          // pagination will need a createdAt/createdAfter filter once the SDK
          // exposes one.
          more = await client.conversations.list({ limit: BigInt(CONVO_PAGE), offset: BigInt(conversations.length) })
        } catch (e) { console.warn('praxis: dm load more failed:', e?.message) }
        if (!more || more.length === 0) { loadMoreEl.remove(); return }
        conversations = conversations.concat(more)
        // Process the new slice using the same chunk pattern
        const moreItems = []
        for (let i = 0; i < more.length; i += CHUNK) {
          const chunk = more.slice(i, i + CHUNK)
          const results = await Promise.all(chunk.map(async (c) => {
            const lastMsg = await c.lastMessage().catch(() => null)
            let peerInboxId = null
            try { peerInboxId = await c.peerInboxId() } catch {}
            const peerDomain = peerInboxId ? domainForInbox(peerInboxId) : 'unknown'
            const text = extractText(lastMsg)
            const time = lastMsg?.sentAtNs ? timeAgo(Number(lastMsg.sentAtNs) / 1e6) : ''
            return { convo: c, peerDomain, preview: text || '', time, peerInboxId }
          }))
          moreItems.push(...results)
        }
        const startIdx = window._dmItems.length
        window._dmItems = window._dmItems.concat(moreItems)
        const stillMore = more.length >= CONVO_PAGE
        const newHtml = moreItems.map((item, j) => `
          <div class="dm-convo-item" data-idx="${startIdx + j}">
            <div class="dm-convo-peer">${escapeHtml(item.peerDomain)}</div>
            <div class="dm-convo-preview">${escapeHtml(item.preview.slice(0, 50))}${item.preview.length > 50 ? '...' : ''}</div>
            <div class="dm-convo-time">${item.time}</div>
          </div>
        `).join('')
        loadMoreEl.insertAdjacentHTML('beforebegin', newHtml)
        if (stillMore) loadMoreEl.textContent = 'load more'
        else loadMoreEl.remove()
        // Re-bind click handlers on newly-inserted items
        listEl.querySelectorAll('.dm-convo-item:not(#dm-load-more)').forEach(el => {
          if (el.dataset.bound) return
          el.dataset.bound = '1'
          el.addEventListener('click', () => {
            const idx = parseInt(el.dataset.idx)
            const item = window._dmItems[idx]
            if (item) openConversation(item.convo, item.peerDomain)
          })
        })
      })
    }
  } catch (e) {
    console.error('load conversations error:', e)
  }

  loadingEl.style.display = 'none'
}

// --- Conversation view ---

async function openConversation(convo, peerDomain) {
  activeConvo = convo
  if (activeStream) { try { activeStream.return?.() } catch (e) { if (e?.message) console.warn("praxis:", e.message) } }
  activeStream = null
  // resolve peer address for payments
  try {
    const peerInboxId = await convo.peerInboxId()
    activePeerAddr = peerInboxId ? inboxToAddr[peerInboxId] : null
  } catch { activePeerAddr = null }
  document.getElementById('dm-pay-bar').style.display = 'none'
  document.getElementById('dm-send-form').style.display = 'flex'

  document.getElementById('dm-list-view').style.display = 'none'
  document.getElementById('dm-convo-view').style.display = 'flex'
  document.getElementById('dm-convo-peer').textContent = peerDomain
  markConversationSeen(convo.id)

  const messagesEl = document.getElementById('dm-messages')
  messagesEl.innerHTML = '<div class="praxis-loader"></div>'

  try {
    await convo.sync()
    const messages = await convo.messages()
    renderMessages(messages)
    // Re-scroll after paint to guarantee newest messages visible
    // Double-rAF ensures flex layout has fully resolved before scrolling
    { const _el = document.getElementById('dm-messages'); if (_el) requestAnimationFrame(() => requestAnimationFrame(() => { _el.scrollTop = _el.scrollHeight })) }
    // Belt-and-suspenders: also scroll after a short delay for slow layout engines
    setTimeout(() => { const _el2 = document.getElementById('dm-messages'); if (_el2) _el2.scrollTop = _el2.scrollHeight }, 150)

    // stream new messages — Fix 4 (H2): append a single DOM node per frame
    // instead of re-syncing + re-fetching + re-rendering the full conversation.
    activeStream = await convo.stream()
    ;(async () => {
      try {
        for await (const msg of activeStream) {
          if (!msg) continue
          if (activeConvo?.id !== convo.id) break
          appendMessageDom(msg)
        }
      } catch (e) { if (e?.message) console.warn("praxis:", e.message) }
    })()
  } catch (e) {
    messagesEl.innerHTML = `<div style="color:#666;padding:1em">error: ${escapeHtml(e.message)}</div>`
  }
}

function showListView() {
  if (activeStream) { try { activeStream.return?.() } catch (e) { if (e?.message) console.warn("praxis:", e.message) } }
  activeStream = null
  activeConvo = null
  document.getElementById('dm-convo-view').style.display = 'none'
  document.getElementById('dm-list-view').style.display = 'block'
  loadConversations()
}

// --- Message rendering ---

function extractText(m) {
  if (!m) return null
  if (typeof m.content === 'string') return m.content
  if (m.content?.text) return m.content.text
  if (m.content?.content) return m.content.content
  if (m.contentType?.typeId === 'group_updated') return null
  if (m.kind !== undefined && m.kind !== 1) return null
  if (typeof m.content === 'object' && m.content !== null) {
    if (m.content.initiatedByInboxId || m.content.addedInboxes) return null
  }
  return null
}

function _renderPayCard(text, isMe) {
  const sendMatch = text.match(/^\[ethpay:send:([0-9.]+):([^:]+)(?::([^\]]*))?\]$/)
  if (sendMatch) {
    const eth = parseFloat(sendMatch[1])
    const hash = sendMatch[2]
    const fiat = sendMatch[3] || ''
    return `<div class="pay-card">
      <div class="pay-card-header"><i class="ph ph-currency-eth"></i> Praxis Pay</div>
      <div class="pay-card-amount">${fiat || eth.toFixed(6) + ' ETH'}</div>
      <div class="pay-card-eth">${fiat ? eth.toFixed(6) + ' ETH' : ''}</div>
      <div class="pay-card-status sent">${isMe ? 'Sent' : 'Received'} ✓</div>
    </div>`
  }
  const reqMatch = text.match(/^\[ethpay:request:([0-9.]+)(?::([^\]]*))?\]$/)
  if (reqMatch) {
    const eth = parseFloat(reqMatch[1])
    const fiat = reqMatch[2] || ''
    if (isMe) {
      return `<div class="pay-card">
        <div class="pay-card-header"><i class="ph ph-currency-eth"></i> Praxis Pay</div>
        <div class="pay-card-amount">${fiat || eth.toFixed(6) + ' ETH'}</div>
        <div class="pay-card-eth">${fiat ? eth.toFixed(6) + ' ETH' : ''}</div>
        <div class="pay-card-status">Requested</div>
      </div>`
    }
    return `<div class="pay-card">
      <div class="pay-card-header"><i class="ph ph-currency-eth"></i> Praxis Pay</div>
      <div class="pay-card-amount">${fiat || eth.toFixed(6) + ' ETH'}</div>
      <div class="pay-card-eth">${fiat ? eth.toFixed(6) + ' ETH' : ''}</div>
      <button class="pay-card-accept-btn" data-eth-amount="${eth}">Accept</button>
    </div>`
  }
  const legacyMatch = text.match(/^sent ([0-9.]+) ETH(?: → tx: (0x[0-9a-f]+))?$/i)
  if (legacyMatch) {
    const eth = parseFloat(legacyMatch[1])
    return `<div class="pay-card">
      <div class="pay-card-header"><i class="ph ph-currency-eth"></i> Praxis Pay</div>
      <div class="pay-card-amount">${eth} ETH</div>
      <div class="pay-card-status sent">${isMe ? 'Sent' : 'Received'} ✓</div>
    </div>`
  }
  return null
}

function _renderSingleMessageHtml(m) {
  const text = extractText(m)
  if (!text) return ''
  const isMe = m.senderInboxId === client?.inboxId
  const time = m.sentAtNs ? new Date(Number(m.sentAtNs) / 1e6).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
  const cardHtml = _renderPayCard(text, isMe)
  const content = cardHtml || `<div class="dm-bubble">${escapeHtml(text)}</div>`
  return `<div class="dm-msg ${isMe ? 'dm-msg-mine' : 'dm-msg-theirs'}">
      ${content}
      <div class="dm-time">${time}</div>
    </div>`
}

function renderMessages(messages) {
  const el = document.getElementById('dm-messages')
  if (!el) return
  el.innerHTML = messages.slice(-100).map(_renderSingleMessageHtml).join('')
  el.scrollTop = el.scrollHeight
  if (!el._payBound) {
    el._payBound = true
    el.addEventListener('click', async e => {
      const btn = e.target.closest('.pay-card-accept-btn')
      if (!btn || btn.disabled) return
      btn.disabled = true
      btn.textContent = 'Sending...'
      await _acceptPayRequest(btn.dataset.ethAmount)
      btn.textContent = 'Accepted ✓'
    })
  }
}

// Fix 4 (H2): append a single streamed message to the existing list instead of
// re-fetching + re-rendering the whole conversation on every incoming frame.
// Preserves scroll position if the user has scrolled up.
function appendMessageDom(msg) {
  const el = document.getElementById('dm-messages')
  if (!el) return
  const html = _renderSingleMessageHtml(msg)
  if (!html) return
  const atBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < 40
  el.insertAdjacentHTML('beforeend', html)
  if (atBottom) el.scrollTop = el.scrollHeight
}

// --- Send ---

async function sendMessage(e) {
  e.preventDefault()
  const input = document.getElementById('dm-input')
  const text = input.value.trim()
  if (!activeConvo || !text) return
  input.value = ''
  try {
    await activeConvo.sendText(text)
  } catch (err) {
    console.error('send error:', err)
  }
}

// --- New message picker ---

async function toggleNewPicker() {
  const picker = document.getElementById('dm-new-picker')
  if (picker.style.display !== 'none') {
    picker.style.display = 'none'
    return
  }

  picker.innerHTML = '<div style="color:#666;padding:0.5em">loading mutual follows...</div>'
  picker.style.display = 'block'

  const myAddr = window.getWalletAddress()?.toLowerCase()
  if (!myAddr) return

  try {
    // paginate both directions to avoid silent data loss at 1000+
    async function fetchAllFollows(where, field) {
      const MAX_PAGES = 10
      let all = [], cursor = null, pages = 0
      while (true) {
        const vars = { me: myAddr, ...(cursor ? { after: cursor } : {}) }
        const data = await query(`
          query PaginatedFollows($me: String!, $after: String) {
            follows(where: { ${where}: $me }, limit: 200, after: $after) {
              items { ${field} }
              pageInfo { endCursor hasNextPage }
            }
          }
        `, vars)
        all.push(...data.follows.items)
        pages++
        if (!data.follows.pageInfo?.hasNextPage || pages >= MAX_PAGES) break
        cursor = data.follows.pageInfo.endCursor
      }
      return all
    }

    const [followingItems, followerItems] = await Promise.all([
      fetchAllFollows('follower', 'followed'),
      fetchAllFollows('followed', 'follower'),
    ])

    const iFollow = new Set(followingItems.map(f => f.followed.toLowerCase()))
    const followsMe = new Set(followerItems.map(f => f.follower.toLowerCase()))
    const mutuals = [...iFollow].filter(addr => followsMe.has(addr) && addr !== myAddr)
    const pendingFollowBack = [...iFollow].filter(addr => !followsMe.has(addr) && addr !== myAddr)

    if (mutuals.length === 0 && pendingFollowBack.length === 0) {
      picker.innerHTML = '<div style="color:var(--muted);padding:0.5em">follow artists to message them</div>'
      return
    }

    // resolve domains for all addresses in the picker
    const allPickerAddrs = [...mutuals, ...pendingFollowBack]
    try {
      const resolved = await resolveAddresses(query, allPickerAddrs)
      Object.assign(addrToDomain, resolved)
    } catch {}

    let html = ''

    // show pending follow-backs
    if (pendingFollowBack.length > 0) {
      html += pendingFollowBack.map(addr => {
        const domain = addrToDomain[addr] || `${addr.slice(0, 6)}...${addr.slice(-4)}`
        return `<div class="dm-convo-item" style="opacity:0.5">
          <span>${escapeHtml(domain)}</span>
          <span style="color:var(--dim);font-size:0.8em;margin-left:1ch">awaiting follow back</span>
        </div>`
      }).join('')
    }

    // show mutuals (can DM)
    picker.innerHTML = html + mutuals.map(addr => {
      const domain = addrToDomain[addr] || `${addr.slice(0, 6)}...${addr.slice(-4)}`
      return `<div class="dm-convo-item dm-new-item" data-addr="${addr}" data-domain="${escapeHtml(domain)}">${escapeHtml(domain)}</div>`
    }).join('')

    picker.querySelectorAll('.dm-new-item').forEach(el => {
      el.addEventListener('click', () => {
        picker.style.display = 'none'
        openDmByAddress(el.dataset.addr, el.dataset.domain)
      })
    })
  } catch (e) {
    picker.innerHTML = `<div style="color:#666;padding:0.5em">error loading follows</div>`
  }
}

// --- Public API: open DM by address ---

async function openDmByAddress(addr, domain) {
  if (!client) {
    await initClient()
    if (!client) return
  }

  // open panel if not open
  if (!panelOpen) togglePanel()

  const peerIdentifier = {
    identifier: addr,
    identifierKind: sdk.IdentifierKind.Ethereum,
  }

  try {
    const canMessage = await client.canMessage([peerIdentifier])
    if (!canMessage.get(addr.toLowerCase())) {
      alert(`${domain} has not enabled XMTP yet`)
      return
    }

    await client.conversations.sync()
    const peerInboxId = await client.fetchInboxIdByIdentifier(peerIdentifier)

    let convo = null
    if (peerInboxId) {
      convo = await client.conversations.getDmByInboxId(peerInboxId)
      if (!convo) {
        convo = await client.conversations.createDmWithIdentifier(peerIdentifier)
      }
    }

    if (convo) {
      activePeerAddr = addr
      openConversation(convo, domain)
    }
  } catch (e) {
    console.error('open dm error:', e)
  }
}

// --- Send payment ---

let _payPrices = null
let _payBalance = null
let _dmPayFiatAmount = 0
let _dmPayKeypadMode = false

window.addEventListener('currency-changed', () => {
  _dmPayUpdateBalanceDisplay()
  _dmPayUpdateDisplay()
})

async function _fetchPayBalance() {
  try {
    const addr = window.getWalletAddress?.()
    if (!addr) return
    const pc = await getPublicClient()
    const bal = await pc.getBalance({ address: addr })
    _payBalance = Number(bal) / 1e18
    _dmPayUpdateBalanceDisplay()
  } catch {}
}

function _dmPayUpdateBalanceDisplay() {
  const balEl = document.getElementById('dm-pay-balance')
  if (!balEl || _payBalance == null) return
  const currency = getUserCurrency()
  let extra = ''
  if (_payPrices && _payPrices[currency]) {
    extra = ` (${formatFiat(_payBalance * _payPrices[currency], currency)})`
  }
  balEl.textContent = `Balance: ${_payBalance.toFixed(6)} ETH${extra}`
}

function _dmPayGetEthAmount() {
  if (_dmPayKeypadMode) {
    return parseFloat(document.getElementById('dm-pay-eth-input')?.value) || 0
  }
  if (!_payPrices) return 0
  const currency = getUserCurrency()
  const rate = _payPrices[currency]
  if (!rate || !_dmPayFiatAmount) return 0
  return _dmPayFiatAmount / rate
}

async function _dmPayUpdateDisplay() {
  if (!_payPrices) _payPrices = await getEthPrices()
  const convEl = document.getElementById('dm-pay-conversion')
  const currency = getUserCurrency()

  if (_dmPayKeypadMode) {
    const eth = parseFloat(document.getElementById('dm-pay-eth-input')?.value) || 0
    const len = Math.max(2, (document.getElementById('dm-pay-eth-input')?.value || '').length + 1)
    document.getElementById('dm-pay-eth-input').style.width = Math.min(len, 12) + 'ch'
    if (eth > 0 && _payPrices && _payPrices[currency]) {
      convEl.textContent = `≈ ${formatFiat(eth * _payPrices[currency], currency)}`
    } else { convEl.textContent = '' }
  } else {
    const sym = _getCurrencySymbol(currency)
    document.getElementById('dm-pay-display').textContent = `${sym}${_dmPayFiatAmount}`
    const ethAmt = _dmPayGetEthAmount()
    if (ethAmt > 0) {
      convEl.textContent = `≈ ${ethAmt.toFixed(6)} ETH`
    } else { convEl.textContent = '' }
  }
  _dmPayCheckOverBalance()
}

function _dmPayCheckOverBalance() {
  const bar = document.getElementById('dm-pay-bar')
  const sendBtn = document.getElementById('dm-pay-send')
  if (!bar) return
  const eth = _dmPayGetEthAmount()
  const over = _payBalance != null && eth > 0 && eth > _payBalance
  bar.classList.toggle('pay-over-balance', over)
  if (sendBtn) sendBtn.disabled = over
}

function _dmPayClose() {
  const bar = document.getElementById('dm-pay-bar')
  bar.style.display = 'none'
  bar.classList.remove('pay-over-balance')
  document.getElementById('dm-send-form').style.display = 'flex'
  document.getElementById('dm-pay-eth-input').value = ''
  document.getElementById('dm-pay-conversion').textContent = ''
  document.getElementById('dm-pay-balance').textContent = ''
  _dmPayFiatAmount = 0
  _dmPayKeypadMode = false
  document.getElementById('dm-pay-stepper').style.display = 'flex'
  document.getElementById('dm-pay-keypad').style.display = 'none'
  document.getElementById('dm-pay-mode-toggle').textContent = 'Show Keypad'
  const sym = _getCurrencySymbol(getUserCurrency())
  document.getElementById('dm-pay-display').textContent = `${sym}0`
}

function _getCurrencySymbol(currency) {
  const symbols = { usd: '$', eur: '€', gbp: '£', jpy: '¥', cny: '¥', brl: 'R$', ngn: '₦', kes: 'KSh', inr: '₹', krw: '₩' }
  return symbols[currency] || '$'
}

async function sendPayment(mode) {
  if (!activeConvo || !activePeerAddr) return
  const ethAmount = _dmPayGetEthAmount()
  if (!ethAmount || ethAmount <= 0) return

  const fiatStr = _payPrices ? formatFiat(ethAmount * _payPrices[getUserCurrency()], getUserCurrency()) : ''

  if (mode === 'request') {
    await activeConvo.sendText(`[ethpay:request:${ethAmount.toFixed(8)}:${fiatStr}]`)
    _dmPayClose()
    return
  }

  const payBtn = document.getElementById('dm-pay-send')
  payBtn.textContent = 'Sending...'
  payBtn.disabled = true

  try {
    const sendAccount = await window.ensureAuthorized?.() || window.getWalletAddress()
    const walletClient = createWalletClient({
      chain: optimism,
      transport: custom(getWalletProvider()),
    })

    const hash = await walletClient.sendTransaction({
      to: activePeerAddr,
      value: parseEther(ethAmount.toFixed(18)),
      account: sendAccount,
    })

    const publicClient = await getPublicClient()
    await publicClient.waitForTransactionReceipt({ hash })

    await activeConvo.sendText(`[ethpay:send:${ethAmount.toFixed(8)}:${hash}:${fiatStr}]`)
    _dmPayClose()
  } catch (e) {
    if (e.code !== 4001) console.error('payment error:', e)
  }

  payBtn.textContent = 'Send'
  payBtn.disabled = false
}

async function _acceptPayRequest(ethAmount) {
  if (!activeConvo || !activePeerAddr) return
  try {
    const sendAccount = await window.ensureAuthorized?.() || window.getWalletAddress()
    const walletClient = createWalletClient({
      chain: optimism,
      transport: custom(getWalletProvider()),
    })
    const hash = await walletClient.sendTransaction({
      to: activePeerAddr,
      value: parseEther(ethAmount.toString()),
      account: sendAccount,
    })
    const publicClient = await getPublicClient()
    await publicClient.waitForTransactionReceipt({ hash })
    const fiatStr = _payPrices ? formatFiat(ethAmount * _payPrices[getUserCurrency()], getUserCurrency()) : ''
    await activeConvo.sendText(`[ethpay:send:${parseFloat(ethAmount).toFixed(8)}:${hash}:${fiatStr}]`)
  } catch (e) {
    if (e.code !== 4001) console.error('accept payment error:', e)
  }
}

// --- Helpers ---
// escapeHtml imported from utils.js


// --- Project group chats ---

async function loadProjectGroups() {
  const listEl = document.getElementById('dm-project-list')
  if (!listEl || !client) return

  listEl.innerHTML = '<div style="padding:1em;color:#666">loading project groups...</div>'

  try {
    // get projects the user is involved in (as funder, proposer, or collaborator)
    const myAddr = window.getWalletAddress()?.toLowerCase()
    if (!myAddr) return

    const data = await query(`
      query MyProjects($addr: String!) {
        projects(limit: 100, orderBy: "createdAt", orderDirection: "desc") {
          items { id title proposer status }
        }
        fundings(where: { funder: $addr }, limit: 100) {
          items { projectId }
        }
        collaborators(where: { artist: $addr }, limit: 100) {
          items { projectId }
        }
      }
    `, { addr: myAddr })

    const myProjectIds = new Set([
      ...data.fundings.items.map(f => f.projectId),
      ...data.collaborators.items.map(c => c.projectId),
    ])

    // include projects where user is proposer
    const myProjects = data.projects.items.filter(p =>
      p.proposer.toLowerCase() === myAddr || myProjectIds.has(p.id)
    )

    if (myProjects.length === 0) {
      listEl.innerHTML = '<div style="padding:1em;color:#666">no project groups yet</div>'
      return
    }

    // batch fetch all project group IDs in one request
    const projectIds = myProjects.map(p => p.id).join(',')
    let groupData = {}
    try {
      const groupRes = await fetch(`/api/project-groups?ids=${projectIds}`)
      groupData = await groupRes.json()
    } catch { /* fall back to empty */ }
    const projectsWithGroups = myProjects.map(p => ({ ...p, groupId: groupData[p.id] || null }))

    listEl.innerHTML = projectsWithGroups.map(p => {
      const isProposer = p.proposer.toLowerCase() === myAddr
      const hasGroup = !!p.groupId
      return `<div class="dm-convo-item" data-project-id="${p.id}" data-group-id="${p.groupId || ''}">
        <div class="dm-convo-peer">${escapeHtml(p.title)}</div>
        <div class="dm-convo-preview">${hasGroup ? 'tap to open group' : (isProposer ? 'create group chat' : 'no group yet')}</div>
      </div>`
    }).join('')

    listEl.querySelectorAll('.dm-convo-item').forEach(el => {
      el.addEventListener('click', async () => {
        const projectId = el.dataset.projectId
        const groupId = el.dataset.groupId
        const project = projectsWithGroups.find(p => p.id === projectId)

        if (groupId) {
          // open existing group
          await openProjectGroup(groupId, project?.title || `Project #${projectId}`)
        } else if (project?.proposer.toLowerCase() === myAddr) {
          // proposer creates the group
          await createProjectGroup(projectId, project?.title || `Project #${projectId}`)
        }
      })
    })
  } catch (e) {
    listEl.innerHTML = '<div style="padding:1em;color:#666">could not load projects</div>'
    console.error('project groups error:', e)
  }
}

async function createProjectGroup(projectId, title) {
  if (!client || !sdk) return

  try {
    const convo = await client.conversations.createGroup([], { groupName: title })
    const groupId = convo.id

    // store group ID on server
    await fetch(`/api/project-group?id=${projectId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId }),
    })

    // reload project list to show the new group
    await loadProjectGroups()
    await openProjectGroup(groupId, title)
  } catch (e) {
    console.error('create group error:', e)
  }
}

async function openProjectGroup(groupId, title) {
  if (!client) return

  try {
    await client.conversations.sync()
    const convo = client.conversations.getConversationById(groupId)
    if (convo) {
      openConversation(convo, title)
    }
  } catch (e) {
    console.error('open group error:', e)
  }
}

// --- Unread badge ---
// Fix M7 (cycle-2): no more N+1 lastMessage() per conversation. Instead we
// track unread state via the global message stream: every inbound message
// for a non-active convo increments a per-convoId counter in localStorage.
// updateUnreadBadge() just sums those counters — O(keys) local read, zero IO.

const UNREAD_KEY_PREFIX = 'dm-unread-'

// LOW-3: module-scoped badge total so updateUnreadBadge() is O(1) per
// incoming message. Cold-start from localStorage on first read; increment
// and decrement inline as unread counts change.
let _badgeTotal = 0
let _badgeTotalInit = false

function _recomputeBadgeTotal() {
  let total = 0
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(UNREAD_KEY_PREFIX)) {
        total += Number(localStorage.getItem(k) || '0') || 0
      }
    }
  } catch (e) { if (e?.message) console.warn("praxis:", e.message) }
  _badgeTotal = total
  _badgeTotalInit = true
  return total
}

function _getUnreadCount(convoId) {
  return Number(localStorage.getItem(UNREAD_KEY_PREFIX + convoId) || '0') || 0
}

function _setUnreadCount(convoId, n) {
  const prev = _getUnreadCount(convoId)
  if (n <= 0) {
    localStorage.removeItem(UNREAD_KEY_PREFIX + convoId)
    _badgeTotal -= prev
  } else {
    localStorage.setItem(UNREAD_KEY_PREFIX + convoId, String(n))
    _badgeTotal += (n - prev)
  }
  if (_badgeTotal < 0) _badgeTotal = 0
}

function incrementUnread(convoId) {
  if (!convoId) return
  if (!_badgeTotalInit) _recomputeBadgeTotal()
  _setUnreadCount(convoId, _getUnreadCount(convoId) + 1)
  updateUnreadBadge()
}

function updateUnreadBadge() {
  const badge = document.getElementById('dm-badge')
  const dockBadge = document.getElementById('dock-dm-badge')
  if (!badge && !dockBadge) return
  if (!_badgeTotalInit) _recomputeBadgeTotal()
  const unread = _badgeTotal

  const show = unread > 0
  const text = unread > 99 ? '99+' : String(unread)
  if (badge) { badge.textContent = text; badge.style.display = show ? 'flex' : 'none' }
  if (dockBadge) { dockBadge.textContent = text; dockBadge.style.display = show ? 'flex' : 'none' }
  // Only show the dock dot from here — never clear it. The dock dot is the
  // canonical unread indicator managed by wallet.js/messages.js background
  // streams. dm.js's per-convo badge total can drop to 0 independently (e.g.
  // before recomputing or after viewing DMs in the panel), and clearing the
  // dock dot here would race with the background stream that just set it.
  if (show) showMsgDot()
}

function markConversationSeen(convoId) {
  localStorage.setItem('dm-seen-' + convoId, String(Date.now() * 1e6)) // nanoseconds (legacy)
  if (!_badgeTotalInit) _recomputeBadgeTotal()
  _setUnreadCount(convoId, 0)
  updateUnreadBadge()
}

// --- Unread message dot (dock icon) ---

let globalStream = null

function showMsgDot() {
  const dot = document.getElementById('dock-msg-dot')
  if (dot) dot.style.display = ''
  try { sessionStorage.setItem('praxis-unread-msgs', '1') } catch {}
}

function clearMsgDot() {
  const dot = document.getElementById('dock-msg-dot')
  if (dot) dot.style.display = 'none'
  try { sessionStorage.removeItem('praxis-unread-msgs') } catch {}
}

// expose globally so messages.js can clear the dot
window._showMsgDot = showMsgDot
window._clearMsgDot = clearMsgDot

function startGlobalMessageStream() {
  if (globalStream || !client) return
  ;(async () => {
    try {
      await client.conversations.sync()
      globalStream = await client.conversations.streamAllMessages()
      for await (const msg of globalStream) {
        // ignore own messages
        if (msg.senderInboxId === client.inboxId) continue
        // Fix M7: track per-conversation unread count from the stream so the
        // badge can be computed without walking every conversation's lastMessage().
        const convoId = msg.conversationId || msg.conversation?.id
        const isActive = activeConvo?.id && convoId && activeConvo.id === convoId
        if (!isActive) {
          incrementUnread(convoId)
        }
        // check if user is currently on the messages page
        const onMessagesPage = !!document.getElementById('messages-page')
        if (!onMessagesPage) {
          showMsgDot()
        }
      }
    } catch (e) {
      globalStream = null
      if (e?.message) console.warn('praxis: global message stream error', e.message)
    }
  })()
}

// restore dot from sessionStorage on page load
if (sessionStorage.getItem('praxis-unread-msgs')) {
  // defer to ensure dock is rendered
  setTimeout(() => {
    const dot = document.getElementById('dock-msg-dot')
    if (dot) dot.style.display = ''
  }, 500)
}

// --- Init ---

injectPanel()

// defer XMTP init until panel is opened (lazy load)
// don't init on page load — XMTP SDK is heavy (~500KB)
let clientInitPromise = null
// Fix 2 (C2): coalesce + cooldown init attempts. Without this, repeated
// wallet-connected dispatches (cross-subdomain restore, balance refresh,
// multi-tab broadcast, page reload) race on the same OPFS database, causing
// "Access Handle" errors and silent client=null state.
let _lastInitAttemptTs = 0
let _lastInitFailureTs = 0
const _INIT_COOLDOWN_MS = 5000
const _INIT_FAILURE_BACKOFF_MS = 30000

function lazyInitClient() {
  if (client) return Promise.resolve(client)
  if (clientInitPromise) return clientInitPromise
  const now = Date.now()
  if (now - _lastInitAttemptTs < _INIT_COOLDOWN_MS) return Promise.resolve(null)
  if (now - _lastInitFailureTs < _INIT_FAILURE_BACKOFF_MS) return Promise.resolve(null)
  if (!window.getWalletAddress?.()) return Promise.resolve(null)
  _lastInitAttemptTs = Date.now()
  clientInitPromise = (async () => {
    try {
      const r = await initClient()
      return r
    } catch (e) {
      _lastInitFailureTs = Date.now()
      throw e
    } finally {
      clientInitPromise = null
    }
  })()
  return clientInitPromise
}

// Fix 3 (C3): null out client when wallet.disconnect() fires the teardown event
// so lazyInitClient() can build a fresh client on the next wallet-connected.
window.addEventListener('xmtp-teardown', () => {
  try { activeStream?.return?.() } catch {}
  activeStream = null
  activeConvo = null
  client = null
  clientInitPromise = null
  _lastInitAttemptTs = 0
  _lastInitFailureTs = 0
  conversations = []
  inboxToAddr = {}
  addrToDomain = {}
  // MEDIUM-1: clear dm-unread-* keys on disconnect/teardown (messages.js only
  // clears praxis-msg-checked:* keys). Without this, stale unread counters
  // persist across wallet switches and inflate the badge.
  try {
    const toRemove = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(UNREAD_KEY_PREFIX)) toRemove.push(k)
    }
    for (const k of toRemove) localStorage.removeItem(k)
  } catch {}
  _badgeTotal = 0
})

// listen for open-dm events from network.js
window.addEventListener('open-dm', (e) => {
  const { address, domain } = e.detail
  openDmByAddress(address, domain)
})

// listen for auto-dm events (e.g. after funding a project)
// non-blocking, fail-silent — the funding tx is what matters
window.addEventListener('auto-dm', async (e) => {
  const { to, message } = e.detail
  if (!to || !message) return

  // lazy-init XMTP if not already running
  if (!client) {
    try { await lazyInitClient() } catch { return }
    if (!client) return
  }

  try {
    const peerIdentifier = {
      identifier: to,
      identifierKind: sdk.IdentifierKind.Ethereum,
    }

    const canMsg = await client.canMessage([peerIdentifier])
    if (!canMsg.get(to.toLowerCase())) return // recipient not on XMTP

    await client.conversations.sync()
    const peerInboxId = await client.fetchInboxIdByIdentifier(peerIdentifier)
    if (!peerInboxId) return

    let convo = await client.conversations.getDmByInboxId(peerInboxId)
    if (!convo) {
      convo = await client.conversations.createDmWithIdentifier(peerIdentifier)
    }
    if (convo) await convo.sendText(message)
  } catch (e) { console.warn('auto-dm failed:', e) }
})

// eagerly init XMTP when wallet connects — for ANY signed-in user, not just the
// site owner. initClient() has a hasRegistered localStorage gate that blocks new
// installations, so first-time users still require an explicit /messages visit.
// For returning users (OPFS database already exists), Client.build reconnects
// silently in the background (~2-5s) with no signature, and streamAllMessages
// starts receiving DMs immediately. This closes the "friend DM'd me but I didn't
// see it until I opened /messages" bug. Small 1s defer so we don't race the
// initial page render.
window.addEventListener('wallet-connected', () => {
  const addr = window.getWalletAddress?.()
  if (!addr) return
  // Skip when on /messages page — messages.js owns the client there and uses
  // Client.create with a signer. dm.js's Client.build would conflict on OPFS.
  if (window.location.pathname.startsWith('/messages')) return
  setTimeout(() => {
    if (!client) lazyInitClient().catch(() => {})
  }, 1000)
})
