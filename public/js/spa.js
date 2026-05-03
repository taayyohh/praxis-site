// Soft-SPA navigation — intercepts internal links to preserve global player
// Dispatches 'spa-navigate' CustomEvent after each transition
// Dynamically imports route-specific modules on demand

// DNS-propagation banner for users who just finished signup with a custom
// domain. Self-initializes from a localStorage flag; fires and forgets.
import('./dns-banner.js').catch(() => {})

const EXCLUDE_PATHS = ['/api/']

// --- Dynamic module loading ---
// Route-specific modules are loaded on demand instead of via static <script> tags.
// Each entry maps a route prefix to the module(s) it needs.
// Modules use registerPage() internally so they self-init when their DOM element exists.

const ROUTE_MODULES = {
  '/': ['/js/feed.js', '/js/supporter-home.js', '/js/gallery-ui.js'],
  '/network': ['/js/network.js', '/js/profile.js', '/js/graph.js'],
  '/projects': ['/js/projects.js'],
  '/project': ['/js/project-detail.js'],
  '/library': ['/js/library.js'],
  '/post': ['/js/post.js'],
  '/blog': ['/js/post.js'],
  '/journal': ['/js/journal.js'],
  '/messages': ['/js/messages.js'],
  '/earnings': ['/js/earnings.js'],
  '/collection': ['/js/collection.js'],
  '/works': ['/js/works.js'],
  '/art': ['/js/art.js'],
  '/event': ['/js/project-detail.js'],
  '/visual': ['/js/gallery-ui.js'],
  '/gallery': ['/js/gallery-ui.js'],
  '/org': ['/js/org.js'],
}

const _loadedModules = new Set()

async function loadRouteModules(pathname) {
  // normalize: strip trailing slash, default to '/'
  const path = pathname === '/' ? '/' : pathname.replace(/\/$/, '')
  const modules = ROUTE_MODULES[path]
  if (!modules) return
  const loads = []
  for (const mod of modules) {
    if (_loadedModules.has(mod)) continue
    _loadedModules.add(mod)
    loads.push(import(mod).catch(e => console.warn('[spa] module load failed:', mod, e)))
  }
  if (loads.length) await Promise.all(loads)
}

// load modules for initial page
loadRouteModules(location.pathname)

function shouldIntercept(anchor) {
  // must be same origin
  if (anchor.origin !== location.origin) return false
  // skip target="_blank"
  if (anchor.target === '_blank') return false
  // skip hash-only links
  if (anchor.getAttribute('href')?.startsWith('#')) return false
  // skip excluded paths
  const href = anchor.pathname
  for (const p of EXCLUDE_PATHS) {
    if (href.startsWith(p)) return false
  }
  // skip download links
  if (anchor.hasAttribute('download')) return false
  return true
}

// Remove modals/overlays appended to document.body that would otherwise
// survive SPA navigation (their container is outside <main>). After enough
// navs with an open sheet, these orphaned overlays stack at z-index 9000
// and absorb all clicks, leaving the new page unclickable.
function cleanupPersistentOverlays() {
  // Bottom sheets (library items, writing publications, etc.)
  document.getElementById('library-sheet')?.remove()
  document.getElementById('writing-sheet')?.remove()
  // Modal overlays (tag modal, confirm dialogs, wizard)
  document.querySelectorAll('.praxis-modal-overlay').forEach(el => el.remove())
  // Body state that sheets set
  if (document.body.style.overflow === 'hidden') document.body.style.overflow = ''
  // Drop URL params that trigger sheet re-open — the user already
  // navigated away, they don't want the sheet back.
  try {
    const u = new URL(window.location)
    let changed = false
    // Only strip ?item= on the /library route (it triggers sheet re-open).
    // Other routes like /art?type=video&item=0 NEED the param.
    if (u.pathname === '/library' && u.searchParams.has('item')) { u.searchParams.delete('item'); changed = true }
    if (changed) history.replaceState(null, '', u)
  } catch {}
}

// Shared apply path for both the first-try and retry branches of navigate().
// Parses fetched HTML, swaps main/title, pushes history, restores opacity,
// scrolls, loads route modules, applies translations, and dispatches
// spa-navigate. Keeping both branches in one place prevents drift.
async function applyHtmlAndModules(main, html, url, pushState) {
  const parser = new DOMParser()
  const doc = parser.parseFromString(html, 'text/html')
  const newMain = doc.querySelector('main')
  const newTitle = doc.querySelector('title')
  if (newMain) main.innerHTML = newMain.innerHTML
  if (newTitle) document.title = newTitle.textContent
  if (pushState) history.pushState({}, '', url)
  cleanupPersistentOverlays()
  main.style.opacity = '1'
  window.scrollTo(0, 0)

  // Execute inline <script> tags from the new content. innerHTML assignment
  // parses scripts but doesn't run them. Module pages (music, video, demos,
  // etc.) rely on inline scripts for click handlers, media wiring, etc.
  main.querySelectorAll('script').forEach(old => {
    const s = document.createElement('script')
    if (old.src) { s.src = old.src; s.type = old.type || '' }
    else { s.textContent = old.textContent; if (old.type) s.type = old.type }
    old.replaceWith(s)
  })

  await loadRouteModules(new URL(url, location.origin).pathname)
  try {
    const { applyTranslations } = await import('./i18n.js')
    applyTranslations()
  } catch {}
  _lastSpaUrl = location.pathname + location.search
  window.dispatchEvent(new CustomEvent('spa-navigate'))
}

// --- SPA page cache ---
// Cache the DOM content of recently visited pages so back-navigation
// restores instantly without re-fetching or destroying/recreating images.
// Bounded at 10 entries, LRU eviction.
const _pageCache = new Map()
const PAGE_CACHE_MAX = 10

function cacheCurrentPage() {
  const main = document.querySelector('main')
  if (!main) return
  const key = location.pathname + location.search
  // Clone the live DOM (preserves img decode state, scroll positions inside elements)
  _pageCache.set(key, {
    html: main.innerHTML,
    title: document.title,
    scroll: window.scrollY,
  })
  if (_pageCache.size > PAGE_CACHE_MAX) {
    const oldest = _pageCache.keys().next().value
    _pageCache.delete(oldest)
  }
}

async function navigate(url, pushState = true) {
  const main = document.querySelector('main')
  if (!main) {
    window.location = url
    return
  }

  // Let mini-player grab any playing video before the DOM is destroyed
  window.dispatchEvent(new CustomEvent('spa-before-navigate'))

  // Cache current page before navigating away (skip during popstate —
  // popstate handler already cached the old page under the correct key)
  if (_popstateNavigating) {
    _popstateNavigating = false
  } else {
    cacheCurrentPage()
  }

  const targetPath = new URL(url, location.origin)
  const cacheKey = targetPath.pathname + targetPath.search

  // Check page cache — instant restore without network fetch
  const cached = _pageCache.get(cacheKey)
  if (cached) {
    main.innerHTML = cached.html
    document.title = cached.title
    if (pushState) history.pushState({}, '', url)
    cleanupPersistentOverlays()
    main.style.opacity = '1'
    window.scrollTo(0, cached.scroll || 0)
    // Re-execute scripts for the cached page
    main.querySelectorAll('script').forEach(old => {
      const s = document.createElement('script')
      if (old.src) { s.src = old.src; s.type = old.type || '' }
      else { s.textContent = old.textContent; if (old.type) s.type = old.type }
      old.replaceWith(s)
    })
    await loadRouteModules(targetPath.pathname)
    try { const { applyTranslations } = await import('./i18n.js'); applyTranslations() } catch {}
    _lastSpaUrl = location.pathname + location.search
  window.dispatchEvent(new CustomEvent('spa-navigate'))
    return
  }

  // subtle loading indicator — dim main content
  main.style.opacity = '0.5'
  main.style.transition = 'opacity 0.15s'

  // Hard timeout so a hanging fetch can never strand the user on a permanently
  // dimmed page (was the root cause of "clicking the header doesn't navigate" —
  // when the response stalled, opacity stayed at 0.5 forever and the catch
  // never fired because the fetch never rejected).
  const ctrl = new AbortController()
  const timeoutId = setTimeout(() => ctrl.abort(), 5000)
  try {
    const resp = await fetch(url, { headers: { 'Accept': 'text/html' }, signal: ctrl.signal })
    clearTimeout(timeoutId)
    if (!resp.ok) throw new Error(resp.status)

    const html = await resp.text()
    await applyHtmlAndModules(main, html, url, pushState)
  } catch (e) {
    clearTimeout(timeoutId)
    console.warn('[spa] navigation failed, retrying once:', e)
    // Always restore opacity before retry/hard-nav so the user never gets stuck dimmed
    main.style.opacity = '1'
    // retry once before hard navigation — avoids killing audio player during deploy restarts
    try {
      await new Promise(r => setTimeout(r, 500))
      const ctrl2 = new AbortController()
      const t2 = setTimeout(() => ctrl2.abort(), 5000)
      const resp2 = await fetch(url, { headers: { 'Accept': 'text/html' }, signal: ctrl2.signal })
      clearTimeout(t2)
      if (resp2.ok) {
        const html2 = await resp2.text()
        await applyHtmlAndModules(main, html2, url, pushState)
      } else {
        window.location = url
      }
    } catch {
      window.location = url
    }
  }
}

// --- Cross-Praxis-site sign-in (link augmentation) ---
//
// When a signed-in user clicks a link to another Praxis site, append
// ?restore=<address> so the destination's wallet autoConnect() picks up the
// session and unlocks without a fresh sign-in. Known Praxis hosts are tracked
// in window._praxisDomains but must be confirmed against the server-
// authoritative list before we trust them — otherwise a malicious follow
// record could inject a lookalike domain and steal the restore token.
const _praxisDomainsVerified = new Set()
let _domainsFetchInFlight = null
function fetchTrustedDomains() {
  if (_domainsFetchInFlight) return _domainsFetchInFlight
  _domainsFetchInFlight = fetch('/api/artists/domains-public', { credentials: 'omit' })
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      const list = Array.isArray(data) ? data : (data?.domains || [])
      if (list.length > 10000) return // refuse to populate unbounded set
      for (const d of list) {
        if (typeof d === 'string' && /^[a-z0-9.-]{1,253}$/i.test(d)) {
          _praxisDomainsVerified.add(d.toLowerCase())
        }
      }
      if (_praxisDomainsVerified.size > 10000) _praxisDomainsVerified.clear()
    })
    .catch(() => {})
  return _domainsFetchInFlight
}
// Kick off the fetch on module load so subsequent clicks have the allowlist.
try { fetchTrustedDomains() } catch {}

function isPraxisHost(host) {
  if (!host) return false
  const h = host.toLowerCase()
  if (h === 'ourpraxis.network' || h.endsWith('.ourpraxis.network')) return true
  // M12: only trust domains that the server has confirmed belong to a real
  // Praxis artist. The client-side _praxisDomains set (populated from follow
  // data) is NOT trusted on its own.
  if (_praxisDomainsVerified.has(h)) return true
  // If the client-side set claims this host, still require server confirmation.
  const clientKnown = window._praxisDomains
  if (clientKnown && typeof clientKnown.has === 'function' && clientKnown.has(h)) {
    // kick off a refresh so future clicks succeed, but do not trust now
    fetchTrustedDomains()
  }
  return false
}

function augmentCrossSiteLink(anchor) {
  try {
    if (anchor.hostname === location.hostname) return
    if (!isPraxisHost(anchor.hostname)) return
    const addr = window.getWalletAddress?.()
    if (!addr) return
    // Don't clobber an existing restore param (e.g. share links).
    const url = new URL(anchor.href)
    if (url.searchParams.has('restore')) return
    url.searchParams.set('restore', addr)
    anchor.href = url.toString()
  } catch {}
}

// --- Click delegation ---

document.addEventListener('click', (e) => {
  const anchor = e.target.closest('a')
  if (!anchor) return
  // Cross-site Praxis link: augment href with ?restore=<addr> before the
  // browser navigates. Runs BEFORE the modifier-key short-circuit so that
  // cmd-click / middle-click opening in a new tab still carries the session.
  if (anchor.hostname && anchor.hostname !== location.hostname) {
    augmentCrossSiteLink(anchor)
    return // cross-origin — let the browser handle navigation
  }
  // Honor modifier keys + middle/right click so cmd-click opens a new tab,
  // shift-click opens a new window, etc. — without these the SPA was eating
  // every click intent.
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
  if (!shouldIntercept(anchor)) return
  e.preventDefault()
  navigate(anchor.href)
})

// --- Back/forward ---

// Track previous URL so popstate can cache the CORRECT page
let _lastSpaUrl = location.pathname + location.search

window.addEventListener('popstate', () => {
  // On popstate, location already changed to the NEW url. The DOM still
  // shows the OLD page. We must NOT call cacheCurrentPage() inside
  // navigate() because it would save the old page under the new URL key,
  // corrupting the cache. Instead, cache the old page under the PREVIOUS
  // url, delete any stale cache for the new url, then navigate.
  const main = document.querySelector('main')
  if (main && _lastSpaUrl) {
    _pageCache.set(_lastSpaUrl, {
      html: main.innerHTML,
      title: document.title,
      scroll: window.scrollY,
    })
  }
  // Delete stale cache for target url (may be from a different page)
  const targetKey = location.pathname + location.search
  _pageCache.delete(targetKey)
  _popstateNavigating = true
  navigate(location.href, false)
})
let _popstateNavigating = false

// --- Bio truncation ---
// Clamp long bios to 3 lines with a "read more" link below.
function initBioTruncation() {
  document.querySelectorAll('.bio, .artist-bio').forEach(el => {
    if (el.dataset.bioInit) return
    el.dataset.bioInit = '1'
    // Measure full height before clamping
    const fullHeight = el.scrollHeight
    // Apply clamp
    el.classList.add('bio-clamped')
    // Use rAF so the browser reflows with the clamp applied
    requestAnimationFrame(() => {
      // offsetHeight = visible height after clamp; scrollHeight = full content
      if (el.scrollHeight <= el.offsetHeight + 2) {
        // Short bio — no truncation needed
        el.classList.remove('bio-clamped')
        return
      }
      const more = document.createElement('div')
      more.className = 'bio-read-more'
      more.textContent = 'read more...'
      el.after(more)
      const expand = () => {
        el.classList.remove('bio-clamped')
        el.classList.add('expanded')
        more.remove()
      }
      more.addEventListener('click', expand)
      el.addEventListener('click', expand)
    })
  })
}
requestAnimationFrame(initBioTruncation)
window.addEventListener('spa-navigate', () => requestAnimationFrame(initBioTruncation))
