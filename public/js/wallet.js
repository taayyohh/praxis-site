import { t } from './i18n.js'
import { getWalletProvider, boundedSet, escapeHtml } from './utils.js'

const status = document.getElementById('wallet-status')
const topBarWallet = document.getElementById('top-bar-wallet')
let connectedAddress = null
// Module-scoped so SPA navigations / repeated showDock() calls can disconnect
// the old observer before creating a new one. Without this, every showDock()
// stacked another MutationObserver on document.body.
let _portfolioObserver = null

// track whether current connection is via embedded wallet
let _usingEmbeddedWallet = false

// boundedSet() imported from utils.js (shared with messages.js)

// --- Fix 1 (C1): XMTP background stream address→domain resolve cache + batcher ---
// Each incoming DM toast needs to show the sender's domain. Without batching,
// every message fires a /api/artists/resolve fetch — a spammy inbox melts the
// network tab. We keep a bounded LRU cache and debounce misses into a 200ms
// batch call to the existing POST endpoint, which already accepts multiple
// addresses per request.
const _addrToDomainCache = new Map() // lowercase addr -> domain string (or '' for miss)
const _ADDR_CACHE_MAX = 500
const _resolveQueue = new Set() // pending addresses
const _resolveWaiters = new Map() // addr -> [resolve, ...]
let _resolveFlushTimer = null

// Fix NEW-H1 (cycle-2): separate negative cache with short TTL so we never
// poison the positive cache with '' on transient fetch failure. Previously,
// a single network error caused every queued address to be cached as ''
// permanently (until disconnect()).
const _addrNegativeCache = new Map() // addr -> ts (negative cached until ts + TTL)
const _NEG_CACHE_TTL_MS = 30 * 1000

function _flushResolveQueue() {
  _resolveFlushTimer = null
  if (_resolveQueue.size === 0) return
  const batch = [..._resolveQueue]
  _resolveQueue.clear()
  ;(async () => {
    let ok = false
    let map = {}
    try {
      const res = await fetch('/api/artists/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addresses: batch }),
      })
      if (res && res.ok) {
        const data = await res.json().catch(() => null)
        if (data && typeof data === 'object') {
          map = data.addresses || {}
          ok = true
        }
      }
    } catch {}
    const now = Date.now()
    for (const addr of batch) {
      const domain = map[addr] || map[addr.toLowerCase()] || ''
      if (ok) {
        if (domain) {
          // Positive hit — cache it and clear any negative entry.
          boundedSet(_addrToDomainCache, addr, domain, _ADDR_CACHE_MAX)
          _addrNegativeCache.delete(addr)
        } else {
          // Confirmed miss from a successful response — negative-cache with TTL.
          boundedSet(_addrNegativeCache, addr, now, _ADDR_CACHE_MAX)
        }
      }
      // On fetch failure (ok === false), do NOT write any cache entry. Waiters
      // still get '' so they unblock, but the next call will re-attempt.
      const waiters = _resolveWaiters.get(addr)
      if (waiters) {
        _resolveWaiters.delete(addr)
        for (const w of waiters) { try { w(domain) } catch {} }
      }
    }
  })()
}

function resolveAddrToDomain(address) {
  const addr = (address || '').toLowerCase()
  if (!addr) return Promise.resolve('')
  if (_addrToDomainCache.has(addr)) {
    // bump recency
    const v = _addrToDomainCache.get(addr)
    _addrToDomainCache.delete(addr)
    _addrToDomainCache.set(addr, v)
    return Promise.resolve(v)
  }
  // Fix NEW-H1: respect short-TTL negative cache for confirmed misses.
  const negTs = _addrNegativeCache.get(addr)
  if (negTs != null) {
    if (Date.now() - negTs < _NEG_CACHE_TTL_MS) return Promise.resolve('')
    _addrNegativeCache.delete(addr)
  }
  return new Promise((resolve) => {
    let waiters = _resolveWaiters.get(addr)
    if (!waiters) { waiters = []; _resolveWaiters.set(addr, waiters) }
    waiters.push(resolve)
    _resolveQueue.add(addr)
    if (_resolveFlushTimer == null) _resolveFlushTimer = setTimeout(_flushResolveQueue, 200)
  })
}

// --- Cross-origin wallet bridge (Fix 3 Part B) ---
//
// Praxis sites live on many hostnames (artist custom domains + subdomains of
// ourpraxis.network). To share a single session across all of them without
// third-party cookies, we embed a hidden iframe of the ourpraxis.network
// wallet-bridge.html page which reads/writes 'praxis-active-wallet' on the
// shared ourpraxis.network localStorage origin. Requests are postMessage'd
// through the iframe; the bridge replies with the address (or null).
//
// `getBridgeAddress()` is called during autoConnect if no local session
// exists, and `setBridgeAddress(addr)` is called every time we successfully
// sign in, so every Praxis site stays in sync.
//
// Server-side support: server.js skips setting X-Frame-Options on the
// /wallet-bridge.html path and sends a minimal CSP, so the iframe can load
// from any origin. Security relies on the bridge's own JS-level origin
// allowlist (isAllowedOrigin() checks against ourpraxis.network + fetched
// artist domain list) which silently drops messages from disallowed
// origins. The bridge's only response to an unauthorized iframe is the
// 'ready' postMessage on load, which carries zero sensitive data.
const BRIDGE_ORIGIN = 'https://ourpraxis.network'
const BRIDGE_URL = BRIDGE_ORIGIN + '/wallet-bridge.html'
let _bridgeIframe = null
let _bridgeReady = null

function ensureBridgeIframe() {
  if (_bridgeIframe) return _bridgeReady
  // Don't self-iframe — on ourpraxis.network we already have direct localStorage
  // access to the shared origin.
  if (location.origin === BRIDGE_ORIGIN) {
    _bridgeReady = Promise.resolve(null)
    return _bridgeReady
  }
  try {
    _bridgeIframe = document.createElement('iframe')
    _bridgeIframe.src = BRIDGE_URL
    _bridgeIframe.setAttribute('aria-hidden', 'true')
    _bridgeIframe.setAttribute('tabindex', '-1')
    _bridgeIframe.style.cssText = 'position:absolute;width:1px;height:1px;left:-9999px;top:-9999px;border:0;visibility:hidden'
    _bridgeReady = new Promise((resolve) => {
      const onMessage = (e) => {
        if (e.origin !== BRIDGE_ORIGIN) return
        if (e.data?.type === 'praxis-bridge-ready') {
          window.removeEventListener('message', onMessage)
          resolve(_bridgeIframe)
        }
      }
      window.addEventListener('message', onMessage)
      // Hard timeout so a blocked iframe doesn't hang the caller forever.
      setTimeout(() => {
        window.removeEventListener('message', onMessage)
        resolve(null)
      }, 4000)
    })
    // Attach once <body> is ready.
    if (document.body) document.body.appendChild(_bridgeIframe)
    else document.addEventListener('DOMContentLoaded', () => document.body.appendChild(_bridgeIframe), { once: true })
  } catch {
    _bridgeReady = Promise.resolve(null)
  }
  return _bridgeReady
}

async function bridgeRequest(message, timeoutMs = 4000) {
  const iframe = await ensureBridgeIframe()
  if (!iframe) {
    // Direct localStorage fallback when we're on ourpraxis.network itself.
    if (location.origin === BRIDGE_ORIGIN) {
      try {
        if (message.type === 'praxis-bridge-get') return { address: localStorage.getItem('praxis-active-wallet'), restoreToken: null }
        if (message.type === 'praxis-bridge-get-with-token') {
          // Same-origin: fetch the token directly
          const addr = localStorage.getItem('praxis-active-wallet')
          if (!addr) return { address: null, restoreToken: null }
          try {
            const tr = await fetch('/api/wallet/restore-token', { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: addr }) })
            const tj = tr.ok ? await tr.json() : null
            return { address: addr, restoreToken: tj?.token || null }
          } catch { return { address: addr, restoreToken: null } }
        }
        if (message.type === 'praxis-bridge-set' && message.address) { localStorage.setItem('praxis-active-wallet', message.address.toLowerCase()); return { address: message.address.toLowerCase(), restoreToken: null } }
        if (message.type === 'praxis-bridge-clear') { localStorage.removeItem('praxis-active-wallet'); return { address: null, restoreToken: null } }
      } catch {}
    }
    return { address: null, restoreToken: null }
  }
  return new Promise((resolve) => {
    const onMessage = (e) => {
      if (e.origin !== BRIDGE_ORIGIN) return
      if (e.data?.type !== 'praxis-bridge-value') return
      window.removeEventListener('message', onMessage)
      resolve({ address: e.data.address || null, restoreToken: e.data.restoreToken || null })
    }
    window.addEventListener('message', onMessage)
    try { iframe.contentWindow?.postMessage(message, BRIDGE_ORIGIN) } catch {}
    setTimeout(() => {
      window.removeEventListener('message', onMessage)
      resolve({ address: null, restoreToken: null })
    }, timeoutMs)
  })
}

async function getBridgeAddress() {
  try {
    const { address } = await bridgeRequest({ type: 'praxis-bridge-get' })
    if (address && /^0x[0-9a-f]{40}$/i.test(address)) return address.toLowerCase()
  } catch {}
  return null
}

// Cross-Praxis sign-in: returns { address, restoreToken } so the caller can
// directly POST to /api/wallet/retrieve without needing a private key on the
// destination origin. The bridge fetches the token on its own origin
// (ourpraxis.network) where the strict origin check on /api/wallet/restore-token
// will pass.
async function getBridgeAddressWithToken() {
  try {
    const result = await bridgeRequest({ type: 'praxis-bridge-get-with-token' })
    if (result?.address && /^0x[0-9a-f]{40}$/i.test(result.address)) {
      return { address: result.address.toLowerCase(), restoreToken: result.restoreToken || null }
    }
  } catch {}
  return { address: null, restoreToken: null }
}

function setBridgeAddress(addr) {
  if (!addr) return
  // fire-and-forget — never block the caller. The new bridgeRequest returns
  // { address, restoreToken } but we don't need either here.
  bridgeRequest({ type: 'praxis-bridge-set', address: addr }).catch(() => {})
}

function clearBridgeAddress() {
  bridgeRequest({ type: 'praxis-bridge-clear' }).catch(() => {})
}

function showAddress(address) {
  connectedAddress = address
  sessionStorage.removeItem('wallet-disconnected')
  try { localStorage.setItem('praxis-wallet', address.toLowerCase()) } catch {}
  // Publish to the cross-origin bridge so other Praxis sites can pick it up.
  try { setBridgeAddress(address) } catch {}

  // top bar: bell in header bar, wallet actions inline in planet dropdown
  if (topBarWallet) {
    const siteOwner = document.body.dataset.owner?.toLowerCase() || ''
    const isOwnerView = siteOwner && address.toLowerCase() === siteOwner

    // bell in the top bar itself (next to planet icon), owner's site only
    if (isOwnerView && !document.getElementById('top-notifications')) {
      const bell = document.createElement('a')
      bell.href = '/notifications'
      bell.id = 'top-notifications'
      bell.className = 'top-bar-bell'
      bell.title = t('dock.notifications')
      bell.innerHTML = `<i class="ph ph-bell"></i><span id="notif-badge" class="notif-badge" style="display:none">0</span>`
      const trigger = document.getElementById('praxis-menu-trigger')
      if (trigger) trigger.parentNode.insertBefore(bell, trigger)
    }

    // populate planet dropdown with wallet items
    const dropdown = document.getElementById('praxis-menu-dropdown')
    const closeFn = () => {
      if (dropdown) dropdown.classList.add('praxis-dropdown-hidden')
      const trig = document.getElementById('praxis-menu-trigger')
      if (trig) trig.classList.remove('menu-open')
    }

    // balance at the very top of the dropdown (before nav links)
    document.getElementById('wallet-top-section')?.remove()
    if (dropdown) {
      const top = document.createElement('div')
      top.id = 'wallet-top-section'
      top.innerHTML = `
        <div class="wallet-menu-balance" id="top-balance">${address.slice(0,6)}...${address.slice(-4)}</div>
        <button class="wallet-menu-addr" id="dd-copy">${address.slice(0,6)}...${address.slice(-4)} <i class="ph ph-copy"></i></button>
        <div class="praxis-menu-divider"></div>
      `
      dropdown.insertBefore(top, dropdown.firstChild)
      top.querySelector('#dd-copy')?.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(address)
          const icon = top.querySelector('#dd-copy i')
          if (icon) { icon.style.color = 'var(--green)'; setTimeout(() => { icon.style.color = '' }, 1500) }
        } catch {}
      })
    }

    // wallet actions below nav links
    topBarWallet.innerHTML = `
      ${isOwnerView ? `<a href="/earnings" class="wallet-menu-link" id="dd-earnings" data-i18n="earnings.title">earnings</a>` : ''}
      <button class="wallet-menu-link" id="dd-fund" data-i18n="wallet.fundWallet">add funds</button>
      <button class="wallet-menu-link" id="dd-cashout" data-i18n="wallet.cashOut">cash out</button>
      ${isOwnerView ? `<button class="wallet-menu-link" id="dd-settings" data-i18n="dock.settings">settings</button>` : ''}
      <div class="praxis-menu-divider"></div>
      <button class="wallet-menu-link wallet-menu-signout" id="dd-disconnect">sign out</button>
    `
    topBarWallet.querySelector('#dd-disconnect')?.addEventListener('click', () => { closeFn(); disconnect() })
    topBarWallet.querySelector('#dd-fund')?.addEventListener('click', async () => {
      closeFn()
      try {
        const { showFundingSheet } = await import('./pay.js')
        await showFundingSheet(address, 0n)
        loadTopBarBalance(address)
      } catch (e) { console.warn('fund sheet error:', e) }
    })
    topBarWallet.querySelector('#dd-cashout')?.addEventListener('click', () => {
      closeFn()
      window.open('https://www.peer.xyz/swap?tab=sell', '_blank')
    })
    topBarWallet.querySelector('#dd-settings')?.addEventListener('click', () => {
      closeFn()
      window.dispatchEvent(new CustomEvent('open-settings'))
    })
    topBarWallet.querySelector('#dd-earnings')?.addEventListener('click', () => closeFn())
  }

  // show floating dock only for site owner
  const owner = document.body.dataset.owner
  const isOwner = owner && address.toLowerCase() === owner.toLowerCase()
  if (isOwner) {
    showDock()
    checkDomainRenewal(address)
  }

  // load balance into top bar
  loadTopBarBalance(address)

  // check audience registration (only on artist sites, not if owner)
  if (!isOwner) {
    checkAudienceRegistration(address)
  }

  window.dispatchEvent(new CustomEvent('wallet-connected', { detail: { address } }))
}

function showDock() {
  if (document.getElementById('owner-dock')) return
  const dock = document.createElement('div')
  dock.id = 'owner-dock'
  dock.className = 'owner-dock'
  // build portfolio section links from the nav
  const portfolioNav = document.querySelector('.portfolio-nav')
  let sectionLinks = ''
  if (portfolioNav) {
    const links = portfolioNav.querySelectorAll('a')
    links.forEach(a => {
      sectionLinks += `<a href="${a.href}" class="dock-section-link">${a.textContent}</a>`
    })
  }

  dock.innerHTML = `
    <div class="dock-tools">
      <button class="dock-btn" id="dock-portfolio" title="${t('dock.portfolio')}"><i class="ph ${document.body.classList.contains('feed-mode') ? 'ph-pulse' : 'ph-squares-four'}"></i></button>
      <a href="/collection" class="dock-btn" title="${t('dock.collection')}"><i class="ph ph-cards-three"></i></a>
      <button class="dock-btn" id="dock-write" title="${t('dock.write')}"><i class="ph ph-pencil-simple"></i></button>
      <a href="/messages" class="dock-btn" id="dock-chat" title="${t('dock.messages')}" style="position:relative"><i class="ph ph-chat-circle"></i><span id="dock-msg-dot" class="dock-msg-dot" style="display:none"></span></a>
      <a href="/journal" class="dock-btn" title="${t('dock.journal')}"><i class="ph ph-file-dashed"></i></a>
      <button class="dock-btn" id="dock-sections-toggle" title="sections"><i class="ph ph-dots-three"></i></button>
    </div>
    ${sectionLinks ? `<div class="dock-sections">${sectionLinks}</div>` : ''}
  `
  document.body.appendChild(dock)

  // highlight active dock icon based on current page
  function updateDockActive() {
    const p = window.location.pathname
    dock.querySelectorAll('.dock-btn').forEach(btn => {
      const href = btn.getAttribute('href')
      const isActive = (href && p === href) || (!href && btn.id === 'dock-portfolio' && (p === '/' || p === ''))
      btn.classList.toggle('active', !!isActive)
    })
  }
  updateDockActive()
  window.addEventListener('spa-navigate', updateDockActive)

  document.getElementById('dock-write')?.addEventListener('click', () => {
    window.location.href = '/write'
  })
  // restore unread dot from session (persists across pages)
  if (sessionStorage.getItem('praxis-unread-msgs')) {
    const dot = document.getElementById('dock-msg-dot')
    if (dot) dot.style.display = ''
  }
  // dock-chat is now an <a> link to /messages
  document.getElementById('dock-portfolio')?.addEventListener('click', () => {
    if (window.location.pathname === '/' || window.location.pathname === '') {
      window.dispatchEvent(new CustomEvent('toggle-portfolio'))
    } else {
      const a = document.createElement('a'); a.href = '/'; document.body.appendChild(a); a.click(); a.remove()
    }
  })

  // ⋯ button: on desktop, toggles the pop-out section links.
  // On mobile (bottom dock), opens a bottom sheet with portfolio sections.
  document.getElementById('dock-sections-toggle')?.addEventListener('click', (e) => {
    e.stopPropagation()
    const isMobile = window.innerWidth <= 768
    if (isMobile) {
      // Bottom sheet for mobile
      const existing = document.getElementById('dock-sections-sheet')
      if (existing) { existing.remove(); return }
      const sections = document.querySelector('.dock-sections')
      if (!sections) return
      const sheet = document.createElement('div')
      sheet.id = 'dock-sections-sheet'
      sheet.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:var(--bg);border-top:1px solid var(--border);border-radius:12px 12px 0 0;z-index:9999;padding:1em 1.5em calc(1em + env(safe-area-inset-bottom));transform:translateY(100%);transition:transform 0.25s ease'
      const links = sections.querySelectorAll('.dock-section-link')
      let html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75em"><span style="color:var(--dim);font-size:0.8em;text-transform:uppercase;letter-spacing:0.1em">portfolio</span><button id="dock-sheet-close" style="background:none;border:none;color:var(--dim);font-size:1.2em;cursor:pointer">&times;</button></div>'
      html += '<div style="display:flex;flex-direction:column;gap:0.5em">'
      links.forEach(a => {
        html += `<a href="${a.getAttribute('href')}" style="color:var(--fg);text-decoration:none;font-size:0.95em;padding:0.4em 0">${a.textContent}</a>`
      })
      html += '</div>'
      sheet.innerHTML = html
      document.body.appendChild(sheet)
      requestAnimationFrame(() => { sheet.style.transform = 'translateY(0)' })
      sheet.querySelector('#dock-sheet-close').addEventListener('click', () => {
        sheet.style.transform = 'translateY(100%)'
        setTimeout(() => sheet.remove(), 250)
      })
      // close on link click (SPA navigates)
      sheet.querySelectorAll('a').forEach(a => a.addEventListener('click', () => {
        sheet.style.transform = 'translateY(100%)'
        setTimeout(() => sheet.remove(), 250)
      }))
      // close on outside tap
      const backdrop = document.createElement('div')
      backdrop.style.cssText = 'position:fixed;inset:0;z-index:9998'
      backdrop.addEventListener('click', () => {
        sheet.style.transform = 'translateY(100%)'
        setTimeout(() => { sheet.remove(); backdrop.remove() }, 250)
      })
      document.body.appendChild(backdrop)
    } else {
      // Desktop: toggle pop-out
      const sections = document.querySelector('.dock-sections')
      if (sections) sections.classList.toggle('expanded')
    }
  })
  // close desktop pop-out on outside click
  if (!window._dockSectionsClickBound) {
    window._dockSectionsClickBound = true
    document.addEventListener('click', (e) => {
      if (e.target.closest('.dock-sections') || e.target.closest('#dock-sections-toggle')) return
      document.querySelector('.dock-sections.expanded')?.classList.remove('expanded')
    })
  }

  // sync portfolio/feed icon with feed-mode state
  function updatePortfolioIcon() {
    const btn = document.getElementById('dock-portfolio')
    if (!btn) return
    const icon = btn.querySelector('i')
    if (!icon) return
    const inFeed = document.body.classList.contains('feed-mode')
    icon.className = inFeed ? 'ph ph-pulse' : 'ph ph-squares-four'
  }
  window.addEventListener('toggle-portfolio', updatePortfolioIcon)
  // also catch programmatic feed-mode changes (e.g. wallet connect in feed.js)
  // Disconnect any prior observer first so repeated showDock() calls (SPA
  // navigations, reconnects) don't leak observers.
  _portfolioObserver?.disconnect()
  _portfolioObserver = new MutationObserver(updatePortfolioIcon)
  _portfolioObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] })

  // background XMTP: use Client.build (no signature required) for unread detection
  // Client.build reconnects from OPFS database created on first /messages visit
  if (!window.location.pathname.startsWith('/messages')) {
    setTimeout(async () => {
      if (window._xmtpClient) {
        window._startXmtpUnreadStream?.()
        return
      }
      // only attempt if user has previously signed into XMTP
      const addr = connectedAddress
      if (!addr || !localStorage.getItem(`xmtp-registered-${addr.toLowerCase()}`)) return

      // Cross-tab coordination via xmtp-proxy module
      const _xmtpLockName = `xmtp-${location.hostname}`
      const { acquireLeadership, startLeaderResponder, broadcastNewMessage, broadcastUnread } = await import('./xmtp-proxy.js')
      const { isLeader, channel, onPromoted, release } = await acquireLeadership(_xmtpLockName)

      if (isLeader) {
        window._xmtpLockHolder = true
      }

      // Helper: show toast for new message (used by both leader stream and follower broadcast)
      const _streamStartMs = Date.now()
      function showMsgToast(msg) {
        if (window.location.pathname.startsWith('/messages')) return
        const dot = document.getElementById('dock-msg-dot')
        if (dot) dot.style.display = ''
        try { sessionStorage.setItem('praxis-unread-msgs', '1') } catch {}
        // Skip toasts for old messages
        const sentMs = Number(msg.sentAtNs || 0) / 1e6
        if (sentMs < _streamStartMs) return
        const text = typeof msg.content === 'string' ? msg.content.slice(0, 80) : 'new message'
        let senderName = (msg.senderInboxId || '').slice(0, 8) + '...'
        const toast = document.createElement('div')
        toast.style.cssText = 'position:fixed;bottom:70px;right:16px;background:var(--surface,#1a1a1a);border:1px solid var(--border,#333);color:var(--fg,#c0c0c0);padding:1em 1.5ch;font-size:0.9em;font-family:inherit;z-index:2000;max-width:320px;border-radius:8px;cursor:pointer;opacity:0;transform:translateY(10px);transition:opacity 0.3s,transform 0.3s'
        const esc = escapeHtml
        toast.innerHTML = `<div style="color:var(--accent);font-size:0.85em;margin-bottom:0.3em;font-weight:bold">${esc(senderName)}</div><div>${esc(text)}</div>`
        toast.addEventListener('click', () => { toast.remove(); window.location.href = '/messages' })
        document.body.appendChild(toast)
        requestAnimationFrame(() => { toast.style.opacity = '1'; toast.style.transform = 'translateY(0)' })
        setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300) }, 8000)
      }

      if (!isLeader) {
        // Follower: listen for new-message broadcasts for toasts + unread dots
        console.log('praxis: XMTP follower tab, listening for broadcasts + queued for promotion')
        channel.addEventListener('message', (e) => {
          if (e.data?.type === 'new-message' && e.data.message) {
            showMsgToast(e.data.message)
          }
          if (e.data?.type === 'unread') {
            const dot = document.getElementById('dock-msg-dot')
            if (dot) dot.style.display = ''
            try { sessionStorage.setItem('praxis-unread-msgs', '1') } catch {}
          }
        })
        // Auto-promote when leader tab closes
        onPromoted.then(async () => {
          console.log('praxis: promoted to XMTP leader (wallet.js)')
          window._xmtpLockHolder = true
          try {
            await _initLeaderXmtp(addr, channel, showMsgToast)
          } catch (e) { console.warn('praxis: leader promotion failed:', e?.message) }
        })
        return
      }

      // Leader: initialize XMTP client + start responder
      await _initLeaderXmtp(addr, channel, showMsgToast)

      async function _initLeaderXmtp(address, bc, toastFn) {
        try {
          // patch Worker constructor so XMTP SDK uses local worker bundles
          const { patchWorker } = await import('./xmtp-proxy.js')
          patchWorker()
          const xsdk = await import('./vendor-xmtp.js')
          const identifier = { identifier: address, identifierKind: xsdk.IdentifierKind.Ethereum }
          const xc = await xsdk.Client.build(identifier, { env: 'production' })
          if (!xc?.inboxId) { xc?.close?.(); return }
          window._xmtpClient = xc
          window._xmtpSdk = xsdk
          window._xmtpClientIsReadOnly = true
          console.log('praxis: XMTP leader (wallet.js) via Client.build')

          // Start leader responder — releaseLock lets /messages tab take over
          let _yielded = false
          startLeaderResponder(bc, () => window._xmtpClient, {
            releaseLock: release,
            onYield: () => {
              _yielded = true
              try { window._xmtpBgStream?.return?.() } catch {}
              window._xmtpBgStream = null
            }
          })

          // check for unread since last visit
          await xc.conversations.sync()
          const convos = await xc.conversations.list()
          const lastSeen = parseInt(localStorage.getItem('praxis-msg-seen') || '0', 10)
          for (const c of convos) {
            const lastMsg = await c.lastMessage?.().catch(() => null)
            if (!lastMsg) continue
            const msgTime = Number(lastMsg.sentAtNs || 0) / 1e6
            if (msgTime > lastSeen && lastMsg.senderInboxId !== xc.inboxId) {
              const dot = document.getElementById('dock-msg-dot')
              if (dot) dot.style.display = ''
              try { sessionStorage.setItem('praxis-unread-msgs', '1') } catch {}
              broadcastUnread(bc, c.id)
              break
            }
          }

          // Periodic sync (stop on yield or SPA nav)
          const _syncInterval = setInterval(async () => {
            if (_yielded) { clearInterval(_syncInterval); return }
            try { await (xc.conversations.syncAll?.(['allowed', 'unknown']) || xc.conversations.sync()) } catch {}
          }, 30000)
          window.addEventListener('spa-navigate', () => clearInterval(_syncInterval), { once: true })

          // Real-time stream — broadcast to other tabs
          if (_yielded) return
          const stream = await xc.conversations.streamAllMessages()
          window._xmtpBgStream = stream
          for await (const msg of stream) {
            if (_yielded) break
            if (msg.senderInboxId === xc.inboxId) continue
            // Broadcast to all tabs (followers get toast + unread dot)
            broadcastNewMessage(bc, msg)
            broadcastUnread(bc, msg.conversationId)
            // Show toast locally too
            toastFn(msg)
          }
        } catch (e) { console.warn('praxis: bg xmtp:', e?.message) }
      }
    }, 2000)
  }
}

// --- Audience registration prompt on artist sites ---

const AUDIENCE_ABI = [
  { name: 'artists', type: 'function', inputs: [{ name: '', type: 'address' }], outputs: [{ name: 'domain', type: 'string' }, { name: 'registeredAt', type: 'uint256' }], stateMutability: 'view' },
  { name: 'supporters', type: 'function', inputs: [{ name: '', type: 'address' }], outputs: [{ name: 'handle', type: 'string' }, { name: 'registeredAt', type: 'uint256' }], stateMutability: 'view' },
  { name: 'registerSupporter', type: 'function', inputs: [{ name: 'handle', type: 'string' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'handleAvailable', type: 'function', inputs: [{ name: 'handle', type: 'string' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
]

async function checkAudienceRegistration(address) {
  // only show once per session
  if (sessionStorage.getItem('praxis-audience-checked')) return

  // never show for site owner (even if wallet switched)
  const owner = document.body.dataset.owner
  if (owner && address.toLowerCase() === owner.toLowerCase()) {
    sessionStorage.setItem('praxis-audience-checked', '1')
    return
  }

  const registryAddress = document.body.dataset.registry
  if (!registryAddress) return

  try {
    const { getPublicClient } = await import('./utils.js')
    const publicClient = await getPublicClient()

    // check if registered as artist or supporter (parallel)
    const [artistResult, supporterResult] = await Promise.all([
      publicClient.readContract({
        address: registryAddress,
        abi: AUDIENCE_ABI,
        functionName: 'artists',
        args: [address],
      }),
      publicClient.readContract({
        address: registryAddress,
        abi: AUDIENCE_ABI,
        functionName: 'supporters',
        args: [address],
      }),
    ])
    const [, artistAt] = artistResult
    const [supporterHandle, supporterAt] = supporterResult
    if (artistAt > 0n || supporterAt > 0n) {
      sessionStorage.setItem('praxis-audience-checked', '1')
      // self-healing: if registered as supporter but setup may have failed, retry setup
      if (supporterAt > 0n && supporterHandle) {
        fetch('https://ourpraxis.network/orchestrator/supporter/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ handle: supporterHandle, wallet: address }),
        }).catch(() => {})
      }
      return
    }

    // not registered — show prompt
    showAudiencePrompt(address, registryAddress, publicClient)
  } catch (e) {
    // on error, don't show prompt — assume registered to avoid false prompts
    console.warn('praxis: audience check failed, skipping:', e?.message)
    sessionStorage.setItem('praxis-audience-checked', '1')
  }
}

function showAudiencePrompt(address, registryAddress, publicClient) {
  if (document.getElementById('audience-prompt')) return

  const bar = document.createElement('div')
  bar.id = 'audience-prompt'
  bar.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:var(--bg, #0a0a0a);border-top:1px solid var(--border, #333);padding:0.5em 1.5ch;z-index:9998;font-size:0.85em;display:flex;align-items:center;gap:1ch;flex-wrap:wrap'

  bar.innerHTML = `
    <span style="color:var(--muted, #666)">${t('audience.registerPrompt')}</span>
    <input id="audience-handle" type="text" maxlength="32" autocomplete="off" spellcheck="false" placeholder="${t('audience.handlePlaceholder')}" style="background:none;border:1px solid var(--border, #333);color:var(--fg, #c0c0c0);font-family:inherit;font-size:0.9em;padding:0.25em 0.75ch;width:16ch">
    <span id="audience-handle-status" style="font-size:0.9em;min-width:1.5ch"></span>
    <button id="audience-register-btn" disabled style="background:none;border:1px solid var(--border, #333);color:var(--fg, #c0c0c0);font-family:inherit;font-size:0.85em;padding:0.25em 1.5ch;cursor:pointer;opacity:0.4">${t('audience.register')}</button>
    <span id="audience-status" style="color:var(--dim, #444);font-size:0.85em"></span>
    <button id="audience-dismiss" style="background:none;border:none;color:var(--dim, #444);font-family:inherit;font-size:0.85em;cursor:pointer;margin-left:auto">${t('audience.dismiss')}</button>
  `

  document.body.appendChild(bar)

  // prevent content overlap on mobile — add bottom padding for the bar
  const barHeight = bar.offsetHeight || 48
  document.body.style.paddingBottom = barHeight + 'px'

  const handleInput = document.getElementById('audience-handle')
  const handleStatus = document.getElementById('audience-handle-status')
  const registerBtn = document.getElementById('audience-register-btn')
  const statusEl = document.getElementById('audience-status')
  const dismissBtn = document.getElementById('audience-dismiss')

  let txInProgress = false
  let handleAvail = false

  // dismiss
  dismissBtn.addEventListener('click', () => {
    if (txInProgress) return
    bar.remove()
    document.body.style.paddingBottom = ''
    sessionStorage.setItem('praxis-audience-checked', '1')
  })

  function updateRegisterState() {
    const canSubmit = handleAvail && !txInProgress
    registerBtn.disabled = !canSubmit
    registerBtn.style.opacity = canSubmit ? '1' : '0.4'
  }

  // debounced handle check
  let checkTimeout = null
  handleInput.addEventListener('input', () => {
    clearTimeout(checkTimeout)
    handleStatus.textContent = ''
    handleAvail = false
    updateRegisterState()
    const raw = handleInput.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '')
    handleInput.value = raw
    if (raw.length < 3) {
      if (raw.length > 0) handleStatus.textContent = '...'
      return
    }
    checkTimeout = setTimeout(async () => {
      try {
        handleStatus.textContent = '...'
        const available = await publicClient.readContract({
          address: registryAddress,
          abi: AUDIENCE_ABI,
          functionName: 'handleAvailable',
          args: [raw],
        })
        handleStatus.textContent = available ? '\u2713' : '\u2717'
        handleStatus.style.color = available ? 'var(--green, #4ade80)' : 'var(--red, #ef4444)'
        handleAvail = available
        updateRegisterState()
      } catch {
        handleStatus.textContent = ''
        handleAvail = false
        updateRegisterState()
      }
    }, 300)
  })

  // register
  registerBtn.addEventListener('click', async () => {
    const handle = handleInput.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '')
    if (handle.length < 3 || !handleAvail) return

    txInProgress = true
    statusEl.textContent = t('audience.registering')
    registerBtn.disabled = true
    registerBtn.style.opacity = '0.4'
    dismissBtn.style.display = 'none'

    try {
      if (!await ensureOptimism()) { registerBtn.textContent = 'join audience'; registerBtn.style.opacity = ''; dismissBtn.style.display = ''; return }

      // sponsor gas
      const sponsorRes = await fetch('https://ourpraxis.network/orchestrator/sponsor-gas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: address, handle: handle }),
      }).then(r => r.json()).catch(() => null)

      if (sponsorRes?.sponsored && sponsorRes?.txHash) {
        await publicClient.waitForTransactionReceipt({ hash: sponsorRes.txHash })
      }

      const { createWalletClient, custom, optimism } = await import('./vendor.js')

      const currentAccount = await ensureAuthorized() || address
      const walletClient = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })
      const hash = await walletClient.writeContract({
        address: registryAddress,
        abi: AUDIENCE_ABI,
        functionName: 'registerSupporter',
        args: [handle],
        account: currentAccount,
      })

      await publicClient.waitForTransactionReceipt({ hash })

      // Set up supporter site (non-fatal — subdomain still works via legacy if this fails)
      fetch('https://ourpraxis.network/orchestrator/supporter/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle, wallet: address }),
      }).catch(() => {})

      statusEl.textContent = t('audience.registered')
      sessionStorage.setItem('praxis-audience-checked', '1')

      // offer biometric setup if supported and using embedded wallet
      if (window.PublicKeyCredential && !localStorage.getItem('praxis-webauthn-cred') && getWalletProvider()?.isPraxis) {
        registerBtn.style.display = 'none'
        handleInput.style.display = 'none'
        handleStatus.style.display = 'none'
        statusEl.innerHTML = `
          <span style="color:var(--fg, #c0c0c0);font-size:0.95em">enable fingerprint / Face ID for transactions?</span>
          <button id="bio-prompt-yes" style="background:none;border:1px solid var(--border, #333);color:var(--fg, #c0c0c0);font-family:inherit;font-size:0.85em;padding:0.25em 1.5ch;cursor:pointer;margin-left:1ch">yes</button>
          <button id="bio-prompt-skip" style="background:none;border:none;color:var(--dim, #444);font-family:inherit;font-size:0.8em;cursor:pointer">skip</button>
        `
        document.getElementById('bio-prompt-yes')?.addEventListener('click', async () => {
          await window.setupBiometric?.()
          bar.remove(); document.body.style.paddingBottom = ''
        })
        document.getElementById('bio-prompt-skip')?.addEventListener('click', () => {
          bar.remove(); document.body.style.paddingBottom = ''
        })
        return
      }

      // dismiss after brief delay
      setTimeout(() => { bar.remove(); document.body.style.paddingBottom = '' }, 2000)
    } catch (e) {
      const msg = e.shortMessage || e.message || ''
      statusEl.textContent = msg.includes('handle taken') ? 'handle taken'
        : msg.includes('already registered') ? 'already registered'
        : msg.includes('User rejected') ? t('status.cancelled')
        : (msg.slice(0, 60) || 'error')
      txInProgress = false
      dismissBtn.style.display = ''
      updateRegisterState()
    }
  })
}

async function disconnect() {
  connectedAddress = null
  sessionStorage.setItem('wallet-disconnected', '1')
  try { localStorage.removeItem('praxis-wallet') } catch {}
  try { clearBridgeAddress() } catch {}

  // Fix 3 (C3): tear down XMTP background stream + client so reconnects don't
  // leak OPFS handles, stream iterators, or the address→domain cache.
  try { await window._xmtpBgStream?.return?.() } catch {}
  window._xmtpBgStream = null
  try { window._xmtpClient?.close?.() } catch {}
  window._xmtpClient = null
  try { _addrToDomainCache.clear() } catch {}
  try { _addrNegativeCache.clear() } catch {}
  try { _resolveQueue.clear() } catch {}
  try { _resolveWaiters.clear() } catch {}
  if (_resolveFlushTimer != null) { clearTimeout(_resolveFlushTimer); _resolveFlushTimer = null }
  try { window.dispatchEvent(new CustomEvent('xmtp-teardown')) } catch {}

  if (_usingEmbeddedWallet) {
    window.deactivateEmbeddedProvider?.()
    _usingEmbeddedWallet = false
  }

  if (topBarWallet) {
    topBarWallet.innerHTML = ''
    // remove balance section from dropdown top
    document.getElementById('wallet-top-section')?.remove()
    // put sign-in at top of dropdown
    const dropdown = document.getElementById('praxis-menu-dropdown')
    if (dropdown) {
      const existing = document.getElementById('wallet-top-section')
      if (existing) existing.remove()
      const top = document.createElement('div')
      top.id = 'wallet-top-section'
      top.className = 'wallet-top-signin'
      top.innerHTML = `<button class="buy-btn top-bar-signin" id="top-connect" data-i18n="wallet.connectShort">sign in</button><div class="praxis-menu-divider"></div>`
      dropdown.insertBefore(top, dropdown.firstChild)
      top.querySelector('#top-connect')?.addEventListener('click', connect)
    }
    document.getElementById('top-notifications')?.remove()
  }

  document.getElementById('owner-dock')?.remove()

  window.dispatchEvent(new CustomEvent('wallet-disconnected'))
}

async function connectEmbedded() {
  // lazy load the embedded wallet module
  await import('./embedded-wallet.js')
  await window._walletReady // cross-subdomain restore

  if (window.hasEmbeddedWallet?.()) {
    // has existing wallet — unlock
    const address = await window.showUnlockPrompt?.()
    if (address) {
      _usingEmbeddedWallet = true
      showAddress(address)
      return address
    }
  } else {
    // no wallet — create one
    const address = await window.showCreateWalletPrompt?.()
    if (address) {
      _usingEmbeddedWallet = true
      showAddress(address)
      return address
    }
  }
  return null
}

async function connect(forceChoice = false) {
  // lazy load embedded wallet module to check if one exists
  await import('./embedded-wallet.js')
  await window._walletReady // cross-subdomain restore

  const hasEmbedded = window.hasEmbeddedWallet?.()

  if (!forceChoice) {
    // has embedded wallet → unlock it directly
    if (hasEmbedded) {
      return connectEmbedded()
    }
  }

  // show connection choice dialog
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.id = 'wallet-choice-overlay'
    overlay.className = 'praxis-modal-overlay'
    overlay.style.zIndex = '10002'

    const dialog = document.createElement('div')
    dialog.className = 'praxis-modal-dialog'
    dialog.style.cssText = 'max-width:380px'

    let html = `<h3 style="color:var(--accent, #00ff41);margin-bottom:1em">sign in</h3>`
    html += '<div style="display:flex;flex-direction:column;gap:0.75em">'

    if (hasEmbedded) {
      html += `<button id="choice-embedded" style="background:none;border:1px solid var(--border, #333);color:var(--fg, #c0c0c0);font-family:inherit;font-size:0.9em;padding:0.7em 1.5ch;cursor:pointer;text-align:left">unlock account<br><span style="color:var(--dim, #666);font-size:0.8em">enter your password to continue</span></button>`
    }

    html += `<button id="choice-signin" style="background:none;border:1px solid var(--border, #333);color:var(--fg, #c0c0c0);font-family:inherit;font-size:0.9em;padding:0.7em 1.5ch;cursor:pointer;text-align:left">sign in to praxis<br><span style="color:var(--dim, #666);font-size:0.8em">${hasEmbedded ? 'switch to a different account' : 'enter your handle + password'}</span></button>`

    if (!hasEmbedded) {
      html += `<button id="choice-create" style="background:none;border:1px solid var(--border, #333);color:var(--fg, #c0c0c0);font-family:inherit;font-size:0.9em;padding:0.7em 1.5ch;cursor:pointer;text-align:left">create account<br><span style="color:var(--dim, #666);font-size:0.8em">instant. secured with your password.</span></button>`
    }

    html += `<button id="choice-recover" style="background:none;border:none;color:var(--dim, #555);font-family:inherit;font-size:0.8em;padding:0.3em 0;cursor:pointer;text-align:left;text-decoration:underline">recover account with phrase</button>`
    html += `<button id="choice-cancel" style="background:none;border:none;color:var(--dim, #444);font-family:inherit;font-size:0.8em;padding:0.3em 0;cursor:pointer;text-align:left">cancel</button>`
    html += '</div>'

    dialog.innerHTML = html
    overlay.appendChild(dialog)
    document.body.appendChild(overlay)

    function cleanup() { overlay.remove() }
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { cleanup(); resolve(null) } })

    document.getElementById('choice-embedded')?.addEventListener('click', async () => {
      cleanup()
      resolve(await connectEmbedded())
    })

    document.getElementById('choice-signin')?.addEventListener('click', async () => {
      cleanup()
      const addr = await window.showSignInPrompt?.()
      if (addr) {
        _usingEmbeddedWallet = true
        showAddress(addr)
        resolve(addr)
      } else { resolve(null) }
    })

    document.getElementById('choice-create')?.addEventListener('click', async () => {
      cleanup()
      resolve(await connectEmbedded())
    })

    document.getElementById('choice-recover')?.addEventListener('click', async () => {
      cleanup()
      await import('./embedded-wallet.js')
      const address = await window.showRecoveryPrompt?.()
      if (address) {
        _usingEmbeddedWallet = true
        showAddress(address)
        resolve(address)
      } else {
        resolve(null)
      }
    })

    document.getElementById('choice-cancel')?.addEventListener('click', () => {
      cleanup()
      resolve(null)
    })
  })
}

// auto-connect logic — check embedded wallet
async function autoConnect() {
  if (sessionStorage.getItem('wallet-disconnected')) {
    showConnectButton()
    return
  }

  // check for ?restore=ADDRESS param (post-signup cross-domain wallet restore)
  const restoreAddr = new URLSearchParams(location.search).get('restore')
  if (restoreAddr && /^0x[0-9a-f]{40}$/i.test(restoreAddr)) {
    // try server-side wallet restore — fetch backup, then prompt for password.
    // Cycle 4 hotfix: post-H3, /api/wallet/retrieve no longer accepts a bare
    // {address} request — we need an HMAC restore token from the bridge.
    // Reuse the same getBridgeAddressWithToken() helper that the bridge-only
    // path below uses; the bridge will hand us a token bound to this IP and
    // we redeem it on the destination origin with no key required.
    try {
      await import('./embedded-wallet.js')
      await window._walletReady
      if (!window.hasEmbeddedWallet?.()) {
        // Try bridge token first (best: HMAC-verified, IP-bound)
        let restored = false
        try {
          const { address: bridgeAddr2, restoreToken: token2 } = await getBridgeAddressWithToken()
          if (token2 && bridgeAddr2?.toLowerCase() === restoreAddr.toLowerCase()) {
            const resp = await fetch('/api/wallet/retrieve', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ address: restoreAddr, restoreToken: token2 }),
            })
            if (resp.ok) {
              const { encrypted } = await resp.json()
              if (encrypted) {
                localStorage.setItem('praxis-wallet-enc', encrypted)
                localStorage.setItem('praxis-embedded-addr', restoreAddr.toLowerCase())
                restored = true
              }
            }
          }
        } catch {}
        // Fallback: address-only retrieve (rate-limited, no token needed).
        // Handles the case where the bridge doesn't have the address yet
        // (first visit, ourpraxis.network localStorage empty) but the URL
        // has ?restore= from a link click.
        if (!restored) {
          try {
            const resp = await fetch('/api/wallet/retrieve', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ address: restoreAddr }),
            })
            if (resp.ok) {
              const { encrypted } = await resp.json()
              if (encrypted) {
                localStorage.setItem('praxis-wallet-enc', encrypted)
                localStorage.setItem('praxis-embedded-addr', restoreAddr.toLowerCase())
              }
            }
          } catch {}
        }
      }
      // wallet backup is now in localStorage — show password prompt
      if (window.hasEmbeddedWallet?.()) {
        const address = await window.showUnlockPrompt?.()
        if (address) {
          _usingEmbeddedWallet = true
          connectedAddress = address.toLowerCase()
          showAddress(address)
          // clean URL only after successful unlock
          const url = new URL(location.href)
          url.searchParams.delete('restore')
          history.replaceState(null, '', url.pathname + url.search)
          return
        }
      }
    } catch (e) { console.warn('praxis: restore from URL failed:', e?.message) }
    // clean URL even if unlock was cancelled/failed
    const url = new URL(location.href)
    url.searchParams.delete('restore')
    history.replaceState(null, '', url.pathname + url.search)
  }

  // Cross-Praxis sign-in: if there's no local wallet yet, ask the shared
  // ourpraxis.network bridge for the user's address PLUS a fresh restore
  // token. The token is HMAC-signed and IP-bound on the server side; the
  // bridge issues it from its own origin where the strict origin check on
  // /api/wallet/restore-token passes. The destination origin then redeems
  // the token at /api/wallet/retrieve to get the encrypted blob and prompts
  // unlock — no signature required.
  if (!localStorage.getItem('praxis-embedded-addr') && !sessionStorage.getItem('wallet-disconnected')) {
    try {
      const { address: bridgeAddr, restoreToken } = await getBridgeAddressWithToken()
      if (bridgeAddr && restoreToken) {
        await import('./embedded-wallet.js')
        await window._walletReady
        if (!window.hasEmbeddedWallet?.()) {
          const resp = await fetch('/api/wallet/retrieve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address: bridgeAddr, restoreToken }),
          })
          if (resp.ok) {
            const { encrypted } = await resp.json()
            if (encrypted) {
              localStorage.setItem('praxis-wallet-enc', encrypted)
              localStorage.setItem('praxis-embedded-addr', bridgeAddr.toLowerCase())
            }
          }
        }
        if (window.hasEmbeddedWallet?.()) {
          const address = await window.showUnlockPrompt?.()
          if (address) {
            _usingEmbeddedWallet = true
            connectedAddress = address.toLowerCase()
            showAddress(address)
            return
          }
        }
      }
    } catch (e) { console.warn('praxis: cross-site restore failed:', e?.message) }
  }

  // check for embedded wallet
  const embeddedAddr = localStorage.getItem('praxis-embedded-addr')
  if (embeddedAddr) {
    // embedded wallet exists — show address but in locked state
    // user must unlock to sign transactions
    connectedAddress = embeddedAddr
    _usingEmbeddedWallet = true
    try { localStorage.setItem('praxis-wallet', embeddedAddr) } catch {}

    // show the address in UI (read-only until unlocked)
    showAddress(embeddedAddr)

    // try to load the embedded wallet module in background for when signing is needed
    import('./embedded-wallet.js').catch(() => {})
    return
  }

  showConnectButton()
}

function showConnectButton() {
  if (topBarWallet) {
    topBarWallet.innerHTML = ''
    document.getElementById('wallet-top-section')?.remove()
    const dropdown = document.getElementById('praxis-menu-dropdown')
    if (dropdown) {
      const top = document.createElement('div')
      top.id = 'wallet-top-section'
      top.className = 'wallet-top-signin'
      top.innerHTML = `<button class="buy-btn top-bar-signin" id="top-connect" data-i18n="wallet.connectShort">sign in</button><div class="praxis-menu-divider"></div>`
      dropdown.insertBefore(top, dropdown.firstChild)
      top.querySelector('#top-connect')?.addEventListener('click', connect)
    }
  }
  document.getElementById('top-notifications')?.remove()
}

// run auto-connect
autoConnect()

async function loadTopBarBalance(address) {
  const el = document.getElementById('top-balance')
  if (!el) return
  try {
    const { getCachedBalance } = await import('/js/utils.js')
    const { getEthPrices, formatFiat, getUserCurrency } = await import('/js/fiat.js')
    const [balance, prices] = await Promise.all([
      getCachedBalance(address),
      getEthPrices().catch(() => null),
    ])
    const eth = (Number(balance) / 1e18).toFixed(4)
    let text = `${eth}Ξ`
    if (prices) {
      const currency = getUserCurrency()
      const rate = prices[currency]
      if (rate) {
        const fiatVal = Number(balance) / 1e18 * rate
        text += ` <span style="color:var(--muted);font-size:0.85em">(~${formatFiat(fiatVal, currency)})</span>`
      }
    }
    el.innerHTML = text
  } catch (e) { console.warn('praxis: loadTopBarBalance failed:', e?.message) }
}

async function checkDomainRenewal(address) {
  const currentDomain = window.location.hostname
  if (!currentDomain || currentDomain === 'localhost') return
  // supporter subdomains don't have custom domains to renew
  if (currentDomain.endsWith('.ourpraxis.network')) return

  try {
    const orchBase = document.body.dataset.orchestrator || 'https://ourpraxis.network'
    const res = await fetch(`${orchBase}/orchestrator/domain-status?domain=${encodeURIComponent(currentDomain)}`, {
      mode: 'cors',
    }).catch(() => null)
    if (!res) return
    if (!res.ok) return
    const data = await res.json()

    if (data.daysRemaining !== null && data.daysRemaining < 60) {
      showRenewalBanner(currentDomain, data, address)
    }
  } catch { /* silent — not critical */ }
}

function showRenewalBanner(domain, statusData, address) {
  if (document.getElementById('renewal-banner')) return

  const banner = document.createElement('div')
  banner.id = 'renewal-banner'
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#1a1a00;border-bottom:1px solid #333;padding:0.6em 1.5ch;z-index:9999;font-size:0.85em;display:flex;align-items:center;justify-content:center;gap:1ch'

  const days = statusData.daysRemaining
  let message
  if (days <= 0) {
    const graceDays = 30 + days
    if (graceDays > 0) {
      message = t('renewal.grace', { days: graceDays })
    } else {
      message = t('renewal.expired')
    }
  } else {
    message = t('renewal.expiring', { days })
  }

  banner.innerHTML = `<span style="color:#c0a000">${message}</span><button id="renew-btn" style="background:none;border:1px solid #666;color:#c0c0c0;font-family:inherit;font-size:0.85em;padding:0.2em 1.5ch;cursor:pointer">${t('renewal.renew')}</button><span id="renew-status" style="color:var(--dim);font-size:0.85em"></span>`

  document.body.prepend(banner)

  document.getElementById('renew-btn').addEventListener('click', async () => {
    const statusEl = document.getElementById('renew-status')
    const orchBase = document.body.dataset.orchestrator || 'https://ourpraxis.network'

    try {
      statusEl.textContent = 'fetching price...'
      const priceRes = await fetch(`${orchBase}/orchestrator/renewal-price?domain=${encodeURIComponent(domain)}`)
      const priceData = await priceRes.json()
      if (priceData.error) { statusEl.textContent = priceData.error; return }

      const priceEth = priceData.priceEth
      const amountWei = BigInt(Math.ceil(parseFloat(priceEth) * 1e18))

      statusEl.textContent = t('renewal.price', { price: priceEth })

      // use ensureFundsForPurchase for the payment flow
      const { ensureFundsForPurchase } = await import('./utils.js')
      const addr = await ensureFundsForPurchase(amountWei.toString(), statusEl)
      if (!addr) return

      statusEl.textContent = 'confirm payment...'

      // send ETH to treasury
      const { createWalletClient, custom, parseEther, optimism } = await import('./vendor.js')
      const from = await ensureAuthorized() || addr
      const walletClient = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })

      // get treasury address from deploy-price endpoint
      const deployRes = await fetch(`${orchBase}/orchestrator/deploy-price`)
      const deployData = await deployRes.json()
      const treasuryAddress = deployData.treasury || '0x46db55AD42dA6bA3c29a3C1522EBBF8e16960725'

      const txHash = await walletClient.sendTransaction({
        to: treasuryAddress,
        value: amountWei,
        account: from,
      })

      statusEl.textContent = 'confirming...'

      // wait for confirmation then call renew endpoint
      const { getPublicClient } = await import('./utils.js')
      const publicClient = await getPublicClient()
      await publicClient.waitForTransactionReceipt({ hash: txHash })

      statusEl.textContent = 'renewing domain...'
      const renewRes = await fetch(`${orchBase}/orchestrator/renew`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain, txHash, address: addr }),
      })
      const renewData = await renewRes.json()

      if (renewData.ok) {
        banner.style.background = '#001a00'
        banner.innerHTML = `<span style="color:#00c000">${t('renewal.success')}</span>`
        setTimeout(() => banner.remove(), 5000)
      } else {
        statusEl.textContent = renewData.error || 'renewal failed'
      }
    } catch (e) {
      statusEl.textContent = e.message || 'error'
    }
  })
}

async function showUnregisterConfirmation(address) {
  // remove existing dialog if present
  document.getElementById('unregister-dialog')?.remove()

  const overlay = document.createElement('div')
  overlay.id = 'unregister-dialog'
  overlay.className = 'praxis-modal-overlay'
  overlay.style.cssText = 'background:rgba(0,0,0,0.7);z-index:9999'

  const dialog = document.createElement('div')
  dialog.className = 'praxis-modal-dialog'
  dialog.style.cssText = 'max-width:400px'
  const confirmPhrase = t('unregister.typePhrase') || 'i want to delete my account'
  dialog.innerHTML = `
    <h3 style="color:#8b3a3a;margin-bottom:1em">${t('unregister.title')}</h3>
    <p style="color:var(--fg, #c0c0c0);margin-bottom:1.5em;line-height:1.5;white-space:pre-line">${t('unregister.confirm')}</p>
    <p style="color:var(--dim, #666);font-size:0.85em;margin-bottom:0.5em">${t('unregister.typePrompt') || 'type'} <span style="color:var(--fg, #c0c0c0);font-style:italic">"${confirmPhrase}"</span> ${t('unregister.toContinue') || 'to continue'}</p>
    <input id="unregister-input" type="text" autocomplete="off" spellcheck="false" style="width:100%;background:none;border:1px solid var(--border, #333);color:var(--fg, #c0c0c0);font-family:inherit;font-size:0.85em;padding:0.5em 1ch;margin-bottom:1em;box-sizing:border-box" placeholder="${confirmPhrase}">
    <p id="unregister-status" style="color:var(--muted, #666);font-size:0.85em;margin-bottom:1em;min-height:1.2em"></p>
    <div style="display:flex;gap:1ch;justify-content:flex-end">
      <button id="unregister-cancel" style="background:none;border:1px solid var(--border, #333);color:var(--fg, #c0c0c0);font-family:inherit;font-size:0.85em;padding:0.4em 1.5ch;cursor:pointer">${t('unregister.cancel')}</button>
      <button id="unregister-confirm" disabled style="background:none;border:1px solid #8b3a3a;color:#8b3a3a;font-family:inherit;font-size:0.85em;padding:0.4em 1.5ch;cursor:not-allowed;opacity:0.4">${t('unregister.delete')}</button>
    </div>
  `
  overlay.appendChild(dialog)
  document.body.appendChild(overlay)

  // close on overlay click
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove()
  })

  const unregInput = document.getElementById('unregister-input')
  const unregConfirmBtn = document.getElementById('unregister-confirm')
  unregInput.addEventListener('input', () => {
    const match = unregInput.value.trim().toLowerCase() === confirmPhrase
    unregConfirmBtn.disabled = !match
    unregConfirmBtn.style.cursor = match ? 'pointer' : 'not-allowed'
    unregConfirmBtn.style.opacity = match ? '1' : '0.4'
  })
  unregInput.focus()

  document.getElementById('unregister-cancel').addEventListener('click', () => overlay.remove())

  unregConfirmBtn.addEventListener('click', async () => {
    if (unregConfirmBtn.disabled) return
    const statusEl = document.getElementById('unregister-status')
    const confirmBtn = document.getElementById('unregister-confirm')
    confirmBtn.disabled = true
    let currentAccount = null
    let registryAddress = null

    try {
      statusEl.textContent = t('unregister.switching')

      if (!await window.ensureOptimism?.()) return

      statusEl.textContent = t('unregister.confirming')

      const { createWalletClient, custom, optimism } = await import('./vendor.js')
      const { getPublicClient } = await import('./utils.js')

      const { REGISTRY_ABI, getRegistryAddress } = await import('./contracts.js')
      registryAddress = getRegistryAddress()
      if (!registryAddress) {
        statusEl.textContent = t('unregister.noRegistry')
        confirmBtn.disabled = false
        return
      }

      // Ensure wallet is fully unlocked — prompt password if needed
      currentAccount = await ensureAuthorized() || address
      if (!currentAccount) { statusEl.textContent = 'sign in first'; confirmBtn.disabled = false; return }

      const { encodeFunctionData } = await import('./vendor.js')
      const data = encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'unregister', args: [] })

      // Send tx — retry with re-auth if wallet session expired between unlock and send
      let hash
      try {
        hash = await getWalletProvider().request({
          method: 'eth_sendTransaction',
          params: [{ from: currentAccount, to: registryAddress, data, gas: '0x30D40' }],
        })
      } catch (txErr) {
        if (txErr.message?.includes('locked') || txErr.message?.includes('null') || txErr.message?.includes('address')) {
          statusEl.textContent = 'session expired — re-authenticating...'
          currentAccount = await ensureAuthorized() || address
          if (!currentAccount) { statusEl.textContent = 'sign in to continue'; confirmBtn.disabled = false; return }
          hash = await getWalletProvider().request({
            method: 'eth_sendTransaction',
            params: [{ from: currentAccount, to: registryAddress, data, gas: '0x30D40' }],
          })
        } else {
          throw txErr
        }
      }

      statusEl.textContent = t('status.confirming')
      const publicClient = await getPublicClient()
      await publicClient.waitForTransactionReceipt({ hash })

      statusEl.textContent = 'cleaning up server...'

      // clean up server-side artifacts (artist dir, Traefik route, orchestrator state)
      // Uses self-service endpoint — verifies unregistration on-chain, no secret needed
      try {
        const handle = window.location.hostname.split('.')[0]
        const domain = document.body.dataset?.domain || window.location.hostname
        await fetch('/orchestrator/cleanup-unregistered', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wallet: address, handle, domain }),
        })
      } catch (cleanupErr) {
        console.warn('server cleanup failed (manual cleanup may be needed):', cleanupErr.message)
      }

      statusEl.style.color = '#ef4444'
      statusEl.textContent = t('unregister.success')

      // clear local state
      disconnect()

      // redirect to landing page after brief delay
      setTimeout(() => {
        window.location.href = 'https://ourpraxis.network'
      }, 2000)
    } catch (e) {
      if (e.code === 4001) {
        statusEl.textContent = t('status.cancelled')
      } else {
        console.error('unregister failed:', { account: currentAccount, registry: registryAddress, error: e.shortMessage || e.message })
        statusEl.textContent = `error: ${(e.shortMessage || e.message || '').slice(0, 100)}`
      }
      confirmBtn.disabled = false
    }
  })
}

window.connectWallet = connect
window.disconnectWallet = disconnect
window.getWalletAddress = () => connectedAddress
window.showUnregisterConfirmation = showUnregisterConfirmation

document.getElementById('lang-switcher')?.addEventListener('change', async (e) => {
  const { setLanguage } = await import('./i18n.js')
  setLanguage(e.target.value)
})

// refresh balance display when currency changes
window.addEventListener('currency-changed', () => {
  if (connectedAddress) loadTopBarBalance(connectedAddress)
})

// refresh balance display when other modules report a change (after bridge, ramp, purchase, etc.)
// emit via: window.dispatchEvent(new CustomEvent('wallet-balance-changed'))
window.addEventListener('wallet-balance-changed', async () => {
  if (!connectedAddress) return
  try {
    // Force-refresh by clearing the cache key for this address
    const { invalidateBalanceCache } = await import('/js/utils.js')
    invalidateBalanceCache?.(connectedAddress)
  } catch {}
  loadTopBarBalance(connectedAddress)
})

// --- Optimism chain switching ---
const OPTIMISM_CHAIN_ID = '0xa' // 10
const OPTIMISM_CHAIN_CONFIG = {
  chainId: OPTIMISM_CHAIN_ID,
  chainName: 'Optimism',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://mainnet.optimism.io'],
  blockExplorerUrls: ['https://optimistic.etherscan.io'],
}

async function ensureOptimism() {
  // Returns true on success (provider present AND on Optimism), false otherwise.
  // Callers like library.js use `if (!await ensureOptimism()) return` so the
  // success path MUST return a truthy value or the caller bails out with a
  // false-negative "add Optimism" error.
  if (!getWalletProvider()) {
    // Provider not active — try restoring embedded wallet session first
    if (_usingEmbeddedWallet || window.hasEmbeddedWallet?.()) {
      await ensureAuthorized()
    }
    if (!getWalletProvider()) return false
  }
  // embedded wallet provider is always on Optimism — skip chain switching
  if (getWalletProvider()?.isPraxis) return true
  try {
    const chainId = await getWalletProvider().request({ method: 'eth_chainId' })
    if (chainId === OPTIMISM_CHAIN_ID) return true // already on Optimism
    try {
      await getWalletProvider().request({ method: 'wallet_switchEthereumChain', params: [{ chainId: OPTIMISM_CHAIN_ID }] })
      return true
    } catch (switchErr) {
      // chain not added yet — add it
      if (switchErr.code === 4902) {
        await getWalletProvider().request({ method: 'wallet_addEthereumChain', params: [OPTIMISM_CHAIN_CONFIG] })
        return true
      } else {
        throw switchErr
      }
    }
  } catch (e) {
    console.warn('ensureOptimism:', e?.message)
    return false
  }
}

window.ensureOptimism = ensureOptimism
// backward compat alias
window.ensureScroll = ensureOptimism

// Ensure embedded wallet is unlocked before signing transactions.
// If locked (after page refresh), prompt unlock and activate provider.
async function ensureAuthorized() {
  // If embedded wallet provider is active AND session is alive, return address
  if (getWalletProvider()?.isPraxis) {
    if (window.isWalletUnlocked?.()) return window.getWalletAddress()
    // Provider exists but session expired — prompt unlock
    const address = await window.showUnlockPrompt?.()
    if (address) return address
  }

  // embedded wallet in use but provider not active (page was refreshed) — unlock first
  if (_usingEmbeddedWallet) {
    await import('./embedded-wallet.js')
    await window._walletReady // cross-subdomain restore
    // After restore, check if provider is now active AND unlocked
    if (getWalletProvider()?.isPraxis && window.isWalletUnlocked?.()) return window.getWalletAddress()
    if (window.hasEmbeddedWallet?.()) {
      const address = await window.showUnlockPrompt?.()
      if (address) return address
    }
  }

  return window.getWalletAddress()
}
window.ensureAuthorized = ensureAuthorized

// --- Ensure embedded wallet is unlocked before signing ---
// intercept signing requests when wallet is locked
window.addEventListener('wallet-sign-needed', async () => {
  if (!_usingEmbeddedWallet) return
  if (window.isWalletLocked?.()) {
    await import('./embedded-wallet.js')
    await window.showUnlockPrompt?.()
  }
})

// --- Identity linking ---

// Check if two addresses are linked (from localStorage cache)
function _checkWalletsLinked(addrA, addrB) {
  if (!addrA || !addrB) return false
  const a = addrA.toLowerCase()
  const b = addrB.toLowerCase()
  if (a === b) return true
  try {
    const cached = localStorage.getItem(`praxis:wallet-linked:${a}:${b}`)
      || localStorage.getItem(`praxis:wallet-linked:${b}:${a}`)
    if (cached) return true
  } catch {}
  return false
}

// Fetch linked state from server (async, updates localStorage)
async function _fetchLinkedState(addr) {
  try {
    const res = await fetch(`/api/wallet/links?address=${addr.toLowerCase()}`)
    if (!res.ok) return null
    const data = await res.json()
    if (data.primary && data.linked?.length > 0) {
      // cache all pairwise links
      for (const linked of data.linked) {
        try { localStorage.setItem(`praxis:wallet-linked:${data.primary}:${linked}`, '1') } catch {}
      }
      return data
    }
  } catch {}
  return null
}

// On connect, check linked state from server (async, non-blocking)
window.addEventListener('wallet-connected', (e) => {
  const addr = e.detail?.address
  if (addr) _fetchLinkedState(addr)
})

// Expose for transaction routing
window.getLinkedPrimary = async function(addr) {
  const data = await _fetchLinkedState(addr)
  return data?.primary || null
}

window.isWalletLinked = function(addrA, addrB) {
  return _checkWalletsLinked(addrA, addrB)
}
