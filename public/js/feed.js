// Social feed — shows blog posts from followed artists on the homepage
// Compose box to publish on-chain blog posts via BlogRegistry
import { F } from './fragments.js'
import { createWalletClient, custom } from './vendor.js'
import { optimism } from './vendor.js'
import { query } from './ponder.js'
import { escapeHtml, ensureWallet, resolveAddresses, resolveDomain, formatTxError, getAllFollows, rewriteIpfsUrls, ipfsUrl, getPublicClient , formatEthAmount, isBlocked, registerPage, openMediaSheet, isBookmarked as _isBookmarked, saveBookmark as _saveBookmark, removeBookmark as _removeBookmark, getBookmarks as _getBookmarks , getWalletProvider, renderMarkdown, renderPdfThumbnail } from './utils.js'
import { t, whenReady as i18nReady } from './i18n.js'
import { getCached, setCache, invalidate, TTL } from './cache.js'

// Temporary map used during renderCachedFeed to collect replies and inject
// them under their parent post card. Set to {} before rendering, null after.
let _replyMap = null

import { BLOG_ABI } from './contracts.js'

let feedContainer = document.getElementById('feed')
let highlightsContainer = document.getElementById('portfolio-highlights')

// Feed only shows on your OWN domain.
// When visiting someone else's site, always show their portfolio.
let siteOwnerWallet = feedContainer?.dataset.owner || ''

function isOwnSite(walletAddr) {
  if (!walletAddr || !siteOwnerWallet) return false
  return walletAddr.toLowerCase() === siteOwnerWallet.toLowerCase()
}

// anti-flash is handled by inline <script> in layout.html (runs before modules load)
// feed-mode-pending class is set synchronously based on localStorage wallet match


// listen for dock events (dock is created by wallet.js, events handled here)
window.addEventListener('open-compose', (e) => {
  const blogAddr = document.body.dataset.blog || document.getElementById('feed')?.dataset.blog
  if (blogAddr) {
    const detail = e.detail || {}
    openComposeModal(blogAddr, detail.amendPostId, detail.title, detail.content)
  }
})
window.addEventListener('toggle-portfolio', () => {
  const feed = document.getElementById('feed')
  const highlights = document.getElementById('portfolio-highlights')
  const inFeed = document.body.classList.contains('feed-mode')
  if (inFeed) {
    document.body.classList.remove('feed-mode')
    if (feed) feed.style.display = 'none'
    if (highlights) highlights.style.display = 'block'
  } else {
    document.body.classList.add('feed-mode')
    if (feed) feed.style.display = 'block'
    if (highlights) highlights.style.display = 'none'
  }
})

// --- Pagination state for incremental feed loading ---
// Declared before initFeed() to avoid temporal dead zone
let _feedServerCursor = null   // cursor for server-side paginated feed endpoint
let _feedServerHasMore = false // whether more pages exist on server
let _feedAuthors = []
let _feedDomainMap = {}
let _feedRenderedItems = []
let _feedLoading = false
let _feedObserver = null
let _feedWalletBound = false
let _feedLoadId = 0
let _feedLoadInFlight = false
// LRU-style seen-key tracker using Map insertion order. The previous Set-based
// version rebuilt the entire Set every add past the cap (O(n) each add). Map
// delete-then-set keeps eviction O(1).
let _feedSeenKeys = new Map()
const _FEED_SEEN_MAX = 5000

function _feedSeenAdd(key) {
  if (_feedSeenKeys.has(key)) {
    _feedSeenKeys.delete(key) // bump to end (most-recently used)
  } else if (_feedSeenKeys.size >= _FEED_SEEN_MAX) {
    // evict the oldest entry (first key in insertion order)
    const oldest = _feedSeenKeys.keys().next().value
    if (oldest !== undefined) _feedSeenKeys.delete(oldest)
  }
  _feedSeenKeys.set(key, 1)
}

registerPage('feed', () => {
  feedContainer = document.getElementById('feed')
  highlightsContainer = document.getElementById('portfolio-highlights')
  siteOwnerWallet = feedContainer?.dataset.owner || ''
  initFeed()
})

async function initFeed() {
  await i18nReady()
  const blogAddr = feedContainer.dataset.blog

  // show feed when wallet connects
  function checkWallet() {
    const addr = window.getWalletAddress?.()

    if (addr && isOwnSite(addr)) {
      document.body.classList.remove('feed-mode-pending')
      document.body.classList.add('feed-mode')
      feedContainer.style.display = 'block'
      loadBalance(addr)
      loadFeed(addr.toLowerCase(), blogAddr)
    } else {
      document.body.classList.remove('feed-mode-pending', 'feed-mode')
      feedContainer.style.display = 'none'
      if (highlightsContainer) highlightsContainer.style.display = 'block'
    }
  }

  if (!_feedWalletBound) {
    _feedWalletBound = true
    window.addEventListener('wallet-connected', checkWallet)
    window.addEventListener('wallet-disconnected', checkWallet)
  }
  checkWallet()
}

async function loadBalance(addr) {
  try {
    const { getCachedBalance } = await import('./utils.js')
    const balance = await getCachedBalance(addr)
    renderBalance(addr, balance)
  } catch (e) { if (e?.message) console.warn("praxis:", e.message) }
}

function renderBalance(addr, balance) {
    const ethBalance = (Number(balance) / 1e18).toFixed(4).replace(/\.?0+$/, '')

    // render in dock
    const topBalance = document.getElementById('top-balance')
    if (topBalance) {
      const short = parseFloat(ethBalance).toFixed(4)
      topBalance.textContent = `${short}\u039E `
      topBalance.title = `${ethBalance} ETH on Optimism`
    }
}

function renderCachedFeed(feedItems, domainMap, postsEl) {
  const PROJECT_TYPES = ['show', 'film', 'theater', 'recording', 'workshop', 'installation', 'other']
  const resolve = addr => domainMap[addr.toLowerCase()] || `${addr.slice(0, 6)}...${addr.slice(-4)}`

  function renderItem(item) {
    if (item.type === 'post') return renderPost(item.data, domainMap)
    if (item.type === 'project') return renderProjectCard(item.data, domainMap, PROJECT_TYPES)
    if (item.type === 'funded') return renderFundedActivity(item.data, resolve)
    if (item.type === 'follow') return renderFollowActivity(item.data, resolve)
    if (item.type === 'library') return renderLibraryActivity(item.data, resolve)
    if (item.type === 'supporter') return renderSupporterActivity(item.data, resolve)
    if (item.type === 'purchase') return renderPurchaseActivity(item.data, resolve)
    if (item.type === 'listed') return renderListedActivity(item.data, resolve)
    if (item.type === 'listed-batch') return renderListedBatchActivity(item.data, resolve)
    return ''
  }

  // Pre-pass: collect replies into a map keyed by parent post ID, so they
  // can be injected under their parent post card after rendering.
  _replyMap = {}

  // deduplicate cached items
  const seen = new Set()
  postsEl.innerHTML = feedItems.filter(item => {
    const addr = item.data?.author || item.data?.proposer || item.data?.funder || item.data?.follower || item.data?.contributor || item.data?.wallet || item.data?.buyer
    if (addr && isBlocked(addr)) return false
    const key = feedItemKey(item)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).map(renderItem).filter(Boolean).join('<div class="feed-separator">\u25C7</div>')

  // Inject reply sections under their parent post cards. Each post card
  // has data-post-id="<id>". Replies are grouped in a scrollable mini-box
  // (max-height 120px) so 100 replies don't blow up the feed layout.
  for (const [parentId, replies] of Object.entries(_replyMap)) {
    const parentCard = postsEl.querySelector(`.feed-article[data-post-id="${parentId}"]`)
    if (!parentCard) continue
    const replyHtml = replies.map((r, i) =>
      `<div style="padding:0.4em 0;${i > 0 ? 'border-top:1px solid var(--border);' : ''}font-size:0.8em">
        <div style="display:flex;gap:0.5ch;align-items:baseline">
          <span class="feed-author" style="font-size:1em">${escapeHtml(r.author)}</span>
          <span style="color:var(--dim)">replied</span>
          <span style="color:var(--dim);margin-left:auto;font-size:0.9em">${r.time}</span>
        </div>
        ${r.excerpt ? `<div style="color:var(--muted);font-size:0.9em;margin-top:0.2em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(r.excerpt)}${r.excerpt.length >= 100 ? '...' : ''}</div>` : ''}
      </div>`
    ).join('')
    parentCard.insertAdjacentHTML('beforeend',
      `<div style="max-height:120px;overflow-y:auto;border-top:1px solid var(--border);padding:0.5em 1em">${replyHtml}</div>`
    )
  }
  _replyMap = null

  postsEl.querySelectorAll('.feed-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.tagName === 'A' || e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return
      const content = item.querySelector('.feed-content')
      if (content) content.classList.toggle('expanded')
      item.classList.toggle('expanded')
    })
  })

  // Lazy-load PDF thumbnails for library cards
  observePdfThumbs(postsEl)
}

async function loadFeed(myAddr, blogAddr) {
  const statusEl = document.getElementById('feed-status')
  const postsEl = document.getElementById('feed-posts')

  if (!myAddr || typeof myAddr !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(myAddr)) {
    if (statusEl) statusEl.textContent = t('feed.empty') || 'no activity yet -- follow artists and start creating'
    return
  }

  // guard against concurrent loadFeed calls (race between checkWallet + wallet-connected event)
  const thisLoadId = ++_feedLoadId
  _feedLoadInFlight = true

  // check cache first (useful on SPA back-navigation)
  const cacheKey = 'feed:' + myAddr.toLowerCase()
  const cached = getCached(cacheKey)
  if (cached) {
    statusEl.textContent = ''
    renderCachedFeed(cached.feedItems, cached.domainMap, postsEl)

    // Background freshness check — lightweight: compare latest global post timestamp
    // Uses cached follow list from the feed cache itself (no extra getAllFollows call)
    // Skip if a loadFeed is already in flight (avoids redundant 6-query cascade)
    if (!_feedLoadInFlight) {
      ;(async () => {
        try {
          const authors = cached.authors || [myAddr]
          const latestData = await query(`query FeedFresh($authors: [String!]!) { blogPosts(where: { author_in: $authors }, orderBy: "timestamp", orderDirection: "desc", limit: 1) { items { ${F.postSummary} } } }`, { authors: authors.slice(0, 50) })
          const latestTs = latestData.blogPosts?.items?.[0]?.timestamp
          const cachedTs = cached.feedItems?.find(i => i.type === 'post')?.data?.timestamp
          if (latestTs && cachedTs && Number(latestTs) > Number(cachedTs)) {
            invalidate('feed:')
            loadFeed(myAddr, blogAddr)
          }
        } catch {}
      })()
    }

    _feedLoadInFlight = false
    return
  }

  statusEl.innerHTML = '<div class="praxis-loader"></div>'

  // reset pagination state
  _feedServerCursor = null
  _feedServerHasMore = false
  _feedRenderedItems = []
  _feedLoading = false
  _feedSeenKeys = new Map()

  try {
    // get who I follow (capped at 200 most recent to keep _in filters small)
    const followed = await getAllFollows(query, myAddr, 200)
    // include own posts — filter to valid eth addresses only
    _feedAuthors = [...new Set([myAddr, ...followed])].filter(a => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a))

    if (_feedAuthors.length === 0) {
      statusEl.textContent = t('feed.empty')
      statusEl.style.cssText = 'text-align:center;padding:2em'
      return
    }

    // resolve domains for followed authors on demand
    _feedDomainMap = await resolveAddresses(query, _feedAuthors)

    // abort if a newer loadFeed call has started (race condition guard)
    if (thisLoadId !== _feedLoadId) return

    // fetch FIRST PAGE of posts + activity (not all pages)
    const firstPageItems = await fetchNextFeedPages()

    // abort if a newer loadFeed call has started
    if (thisLoadId !== _feedLoadId) return

    if (firstPageItems.length === 0 && !hasMoreFeedPages()) {
      statusEl.textContent = t('feed.noActivity')
      statusEl.style.cssText = 'text-align:center;padding:2em'
      return
    }

    statusEl.textContent = ''
    postsEl.innerHTML = ''

    // render first batch
    await renderFeedBatch(firstPageItems, postsEl)

    // cache only the first page (max 50 items) to bound sessionStorage usage
    if (!hasMoreFeedPages()) {
      setCache(cacheKey, { feedItems: _feedRenderedItems.slice(0, 50), domainMap: _feedDomainMap, authors: _feedAuthors }, TTL.medium)
    }

    // set up IntersectionObserver for infinite scroll
    setupFeedObserver(postsEl, myAddr)

  } catch (e) {
    statusEl.textContent = t('feed.error')
    console.error('feed error:', e)
  } finally {
    _feedLoadInFlight = false
  }
}

function hasMoreFeedPages() {
  return _feedServerHasMore
}

function feedItemKey(item) {
  const d = item.data
  if (item.type === 'post') return `post:${d.id}`
  if (item.type === 'project') return `project:${d.id}`
  if (item.type === 'funded') return `funded:${d.id}`
  if (item.type === 'follow') return `follow:${d.follower}-${d.followed}`
  if (item.type === 'library') return `library:${d.id}`
  if (item.type === 'supporter') return `supporter:${d.wallet}`
  if (item.type === 'purchase') return `purchase:${d.buyer}-${d.mediaId}`
  if (item.type === 'listed') return `listed:${d.artist}-${d.mediaId}`
  if (item.type === 'listed-batch') return `listed-batch:${d.artist}-${d.items?.[0]?.mediaId || item.timestamp}`
  return `${item.type}:${item.timestamp}`
}

// All pages use the unified /api/feed/timeline server endpoint with cursor-based pagination.
async function fetchNextFeedPages() {
  if (!_feedServerHasMore && _feedServerCursor !== null) return []

  const authors = _feedAuthors.slice(0, 100)
  let items = []
  try {
    const feedRes = await fetch('/api/feed/timeline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authors, after: _feedServerCursor }),
    }).then(r => { if (!r.ok) throw new Error(`feed ${r.status}`); return r.json() })

    if (!feedRes?.items) throw new Error('invalid response')

    items = feedRes.items
    _feedServerCursor = feedRes.endCursor || null
    _feedServerHasMore = feedRes.hasMore || false

    // Merge server-provided domains into feed domain map
    if (feedRes.domains) {
      for (const [addr, domain] of Object.entries(feedRes.domains)) {
        _feedDomainMap[addr.toLowerCase()] = domain
      }
    }
  } catch (e) {
    console.warn('feed timeline request failed:', e?.message)
    _feedServerHasMore = false
    return []
  }

  // sort, filter blocked, deduplicate
  items.sort((a, b) => b.timestamp - a.timestamp)
  items = items.filter(item => {
    const addr = item.data?.author || item.data?.proposer || item.data?.funder || item.data?.follower || item.data?.contributor || item.data?.wallet || item.data?.buyer
    return !addr || !isBlocked(addr)
  })
  items = items.filter(item => {
    const key = feedItemKey(item)
    if (_feedSeenKeys.has(key)) return false
    _feedSeenAdd(key)
    return true
  })
  return items
}

async function renderFeedBatch(items, postsEl) {
  // collect all addresses referenced in this batch (including follow targets, funders, etc.)
  const missing = []
  for (const item of items) {
    const addrs = [
      item.data?.author, item.data?.proposer, item.data?.funder,
      item.data?.follower, item.data?.followed, item.data?.contributor, item.data?.wallet, item.data?.buyer
    ].filter(a => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) && !_feedDomainMap[a.toLowerCase()])
    missing.push(...addrs)
  }
  if (missing.length > 0) {
    const extra = await resolveAddresses(query, [...new Set(missing)])
    Object.assign(_feedDomainMap, extra)
  }

  const PROJECT_TYPES = ['show', 'film', 'theater', 'recording', 'workshop', 'installation', 'other']
  const resolve = addr => _feedDomainMap[addr.toLowerCase()] || `${addr.slice(0, 6)}...${addr.slice(-4)}`

  function renderItem(item) {
    if (item.type === 'post') return renderPost(item.data, _feedDomainMap)
    if (item.type === 'project') return renderProjectCard(item.data, _feedDomainMap, PROJECT_TYPES)
    if (item.type === 'funded') return renderFundedActivity(item.data, resolve)
    if (item.type === 'follow') return renderFollowActivity(item.data, resolve)
    if (item.type === 'library') return renderLibraryActivity(item.data, resolve)
    if (item.type === 'supporter') return renderSupporterActivity(item.data, resolve)
    if (item.type === 'purchase') return renderPurchaseActivity(item.data, resolve)
    if (item.type === 'listed') return renderListedActivity(item.data, resolve)
    if (item.type === 'listed-batch') return renderListedBatchActivity(item.data, resolve)
    return ''
  }

  // remove sentinel before appending
  postsEl.querySelector('#feed-sentinel')?.remove()

  const html = items.map(renderItem).filter(Boolean).join('<div class="feed-separator">\u25C7</div>')
  postsEl.insertAdjacentHTML('beforeend', html)
  _feedRenderedItems.push(...items)
  // cap rendered items to prevent unbounded memory growth
  if (_feedRenderedItems.length > 200) {
    _feedRenderedItems.splice(0, _feedRenderedItems.length - 200)
  }

  // add click handlers to new items
  postsEl.querySelectorAll('.feed-item:not([data-bound])').forEach(item => {
    item.dataset.bound = '1'
    item.addEventListener('click', (e) => {
      if (e.target.tagName === 'A' || e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return
      const content = item.querySelector('.feed-content')
      if (content) content.classList.toggle('expanded')
      item.classList.toggle('expanded')
    })
  })

  // Lazy-load PDF thumbnails for any new library cards
  observePdfThumbs(postsEl)

  // Hover-to-play videos in feed cards
  if (!postsEl._feedHoverBound) {
    postsEl._feedHoverBound = true
    postsEl.addEventListener('mouseenter', (e) => {
      const wrap = e.target.closest('.feed-media-wrap')
      if (!wrap) return
      const vid = wrap.querySelector('video')
      if (vid) { vid.muted = true; vid.play().catch(() => {}) }
    }, true)
    postsEl.addEventListener('mouseleave', (e) => {
      const wrap = e.target.closest('.feed-media-wrap')
      if (!wrap) return
      const vid = wrap.querySelector('video')
      if (vid) { vid.pause(); vid.currentTime = 0 }
    }, true)
  }

  // add sentinel if more pages available
  if (hasMoreFeedPages()) {
    postsEl.insertAdjacentHTML('beforeend', '<div id="feed-sentinel" style="height:1px"></div>')
  }
}

function setupFeedObserver(postsEl, myAddr) {
  if (_feedObserver) _feedObserver.disconnect()

  _feedObserver = new IntersectionObserver(async (entries) => {
    if (!entries[0]?.isIntersecting || _feedLoading) return
    if (!hasMoreFeedPages()) {
      _feedObserver.disconnect()
      // cache only first page of feed items to bound sessionStorage usage
      const cacheKey = 'feed:' + myAddr.toLowerCase()
      setCache(cacheKey, { feedItems: _feedRenderedItems.slice(0, 50), domainMap: _feedDomainMap, authors: _feedAuthors }, TTL.medium)
      return
    }

    _feedLoading = true
    // show loading indicator in sentinel
    const sentinelEl = postsEl.querySelector('#feed-sentinel')
    if (sentinelEl) {
      sentinelEl.textContent = 'loading...'
      sentinelEl.style.cssText = 'text-align:center;padding:1em;color:var(--dim);font-size:0.85em'
    }
    try {
      const nextItems = await fetchNextFeedPages()
      if (nextItems.length > 0) {
        await renderFeedBatch(nextItems, postsEl)
      }

      // re-observe the new sentinel
      if (hasMoreFeedPages()) {
        const newSentinel = postsEl.querySelector('#feed-sentinel')
        if (newSentinel) _feedObserver.observe(newSentinel)
      } else {
        _feedObserver.disconnect()
        const cacheKey = 'feed:' + myAddr.toLowerCase()
        setCache(cacheKey, { feedItems: _feedRenderedItems.slice(0, 50), domainMap: _feedDomainMap, authors: _feedAuthors }, TTL.medium)
      }
    } catch (e) {
      console.warn('feed scroll error:', e)
    }
    _feedLoading = false
  }, { rootMargin: '200px' })

  const sentinel = postsEl.querySelector('#feed-sentinel')
  if (sentinel) _feedObserver.observe(sentinel)
}

// --- PDF thumbnail lazy-loader for library cards in the feed ---
// Uses IntersectionObserver to lazy-render first-page thumbnails when visible.
// Checks content-type via HEAD for IPFS CID items (no file extension).
let _pdfThumbObserver = null
const _pdfThumbRendered = new Set() // track processed elements to avoid duplicates
const _PDF_THUMB_RENDERED_MAX = 200

function observePdfThumbs(container) {
  if (!_pdfThumbObserver) {
    _pdfThumbObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const el = entry.target
        _pdfThumbObserver.unobserve(el)
        const url = el.dataset.pdfThumb
        if (!url || _pdfThumbRendered.has(url)) continue
        // Bound the set
        if (_pdfThumbRendered.size >= _PDF_THUMB_RENDERED_MAX) {
          const oldest = _pdfThumbRendered.values().next().value
          _pdfThumbRendered.delete(oldest)
        }
        _pdfThumbRendered.add(url)
        _renderFeedPdfThumb(el, url)
      }
    }, { rootMargin: '300px' })
  }

  container.querySelectorAll('[data-pdf-thumb]:not([data-pdf-thumb-init])').forEach(el => {
    el.dataset.pdfThumbInit = '1'
    _pdfThumbObserver.observe(el)
  })
}

async function _renderFeedPdfThumb(card, url) {
  const slot = card.querySelector('.feed-pdf-thumb-slot')
  if (!slot) return

  const img = document.createElement('img')
  img.src = `/api/pdf-thumb?url=${encodeURIComponent(url)}`
  img.style.cssText = 'width:100%;max-height:200px;object-fit:cover;object-position:top;display:block;border-radius:6px 6px 0 0;cursor:pointer'
  img.loading = 'lazy'
  img.addEventListener('click', (e) => {
    e.stopPropagation()
    const openLink = card.querySelector('.feed-library-open')
    if (openLink) openLink.click()
  })
  img.onerror = () => {
    // Fallback: PDF icon
    slot.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:80px;background:var(--surface,#1a1a1a);border-radius:6px 6px 0 0;cursor:pointer"><i class="ph ph-file-pdf" style="font-size:2em;color:var(--dim)"></i></div>`
  }
  slot.innerHTML = ''
  slot.appendChild(img)
  slot.style.display = 'block'
}

// compose state for references and amendments
let composeRef = { type: 0, id: 0 }
let _amendPostId = null
let authToken = ''
window.addEventListener('wallet-connected', () => { authToken = '' })
window.addEventListener('wallet-disconnected', () => { authToken = '' })

async function getAuthToken() {
  if (authToken) return authToken
  const addr = window.getWalletAddress?.()
  if (!addr || !getWalletProvider()) return ''
  try {
    await window.ensureAuthorized?.()
    const msg = `admin:${location.hostname}:${Date.now()}`
    const sig = await getWalletProvider().request({ method: 'personal_sign', params: [msg, addr] })
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: addr, signature: sig, message: msg }),
    })
    if (!res.ok) throw new Error(`auth ${res.status}`)
    const data = await res.json()
    if (data.error) console.warn('auth error:', data.error)
    if (data.token) authToken = data.token
    return authToken
  } catch (e) {
    console.warn('getAuthToken failed:', e?.message)
    return ''
  }
}

function openComposeModal(blogAddr, amendPostId, prefillTitle, prefillContent) {
  document.getElementById('compose-panel')?.remove()
  composeRef = { type: 0, id: 0 }
  _amendPostId = amendPostId || null

  // Restore draft if no prefill content provided
  if (!prefillTitle && !prefillContent && !amendPostId) {
    try {
      const draft = JSON.parse(localStorage.getItem('praxis-blog-draft') || 'null')
      if (draft && (draft.title || draft.body)) {
        prefillTitle = draft.title || ''
        prefillContent = draft.body || ''
      }
    } catch {}
  }

  const isAmend = !!_amendPostId
  const headerLabel = isAmend ? `${t('compose.amending')} #${_amendPostId}` : t('compose.write')
  const publishLabel = isAmend ? t('compose.saveEdit') : t('compose.publish')

  const panel = document.createElement('div')
  panel.id = 'compose-panel'
  panel.className = 'compose-panel'
  panel.innerHTML = `
    <div class="compose-panel-inner">
      <div class="compose-header" style="display:flex;align-items:center;justify-content:space-between;padding:0.75em 0;position:relative">
        <button id="compose-close" class="compose-close-btn" aria-label="close compose" style="display:flex;align-items:center;padding:0;margin:0;background:none;border:none;color:var(--fg);cursor:pointer"><i class="ph ph-x"></i></button>
        <span class="compose-label" style="position:absolute;left:50%;transform:translateX(-50%)">${headerLabel}</span>
        <div style="display:flex;align-items:center;gap:1ch">
          <button id="compose-preview-toggle" class="compose-tool" title="${t('compose.preview')}" style="font-size:0.85em;padding:0.3em 1.5ch;vertical-align:middle;margin:0">${t('compose.preview')}</button>
          <button id="compose-post" class="buy-btn" style="font-size:0.85em;padding:0.3em 1.5ch;vertical-align:middle;margin:0">${publishLabel}</button>
        </div>
      </div>
      <div class="compose-body">
        <input type="text" id="compose-title" class="compose-title" placeholder="${t('compose.titlePlaceholder')}" autocomplete="off">
        <div class="compose-format-bar">
          <button class="compose-fmt" data-wrap="**" title="${t('compose.bold')}"><b>B</b></button>
          <button class="compose-fmt" data-wrap="*" title="${t('compose.italic')}"><i>I</i></button>
          <button class="compose-fmt" data-prefix="## " title="${t('compose.heading')}">H</button>
          <button class="compose-fmt" data-prefix="> " title="${t('compose.quote')}"><i class="ph ph-quotes"></i></button>
          <button class="compose-fmt" data-link="true" title="${t('compose.link')}"><i class="ph ph-link-simple"></i></button>
          <button id="compose-image" class="compose-fmt" title="${t('compose.image')}"><i class="ph ph-image"></i></button>
          <button class="compose-fmt" data-inline-ref="true" title="${t('compose.inlineRef')}"><i class="ph ph-at"></i></button>
        </div>
        <textarea id="compose-content" class="compose-content" placeholder="${t('compose.bodyPlaceholder')}"></textarea>
        <div id="compose-preview" class="compose-preview" style="display:none"></div>
        <div class="compose-toolbar" style="display:flex;justify-content:space-between;align-items:center;padding:0.75em 1ch;margin-top:0.5em">
          <div style="display:flex;align-items:center;gap:1.5ch">
            <button id="compose-ref" class="compose-tool" title="${t('compose.addReference')}"><i class="ph ph-link"></i> <span style="font-size:0.8em">${t('compose.reference')}</span></button>
            <span id="compose-ref-label" style="color:var(--dim);font-size:0.8em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:40ch"></span>
          </div>
          <a href="/blog" id="compose-blog-link" style="color:var(--dim);font-size:0.8em;white-space:nowrap;flex-shrink:0">your posts</a>
        </div>
        <div style="display:flex;justify-content:center;padding:0.75em 0 0.25em;border-top:1px solid var(--border)">
          <span style="color:var(--dim);font-size:0.75em">${t('compose.permanent')}</span>
        </div>
        <div id="compose-ref-picker" style="display:none"></div>
        <p id="compose-status" style="color:var(--muted);font-size:0.85em;margin-top:0.5em"></p>
      </div>
    </div>
  `
  document.body.appendChild(panel)

  // prevent background scroll while compose is open
  document.body.style.overflow = 'hidden'

  // animate in
  requestAnimationFrame(() => panel.classList.add('compose-open'))

  // close
  document.getElementById('compose-close').addEventListener('click', closeCompose)

  // your posts link — close compose first
  document.getElementById('compose-blog-link')?.addEventListener('click', (e) => {
    e.preventDefault()
    closeCompose()
    setTimeout(() => { window.location.href = '/blog' }, 300)
  })

  // publish
  document.getElementById('compose-post').addEventListener('click', () => submitPost(blogAddr))

  // image upload
  document.getElementById('compose-image').addEventListener('click', async () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.onchange = async () => {
      const file = input.files[0]
      if (!file) return
      const statusEl = document.getElementById('compose-status')
      statusEl.textContent = t('compose.uploading')
      try {
        const token = await getAuthToken()
        if (!token) { statusEl.textContent = t('compose.walletRequired'); return }
        const buffer = await file.arrayBuffer()
        const res = await fetch(`/api/ipfs?name=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` },
          body: buffer,
        })
        const data = await res.json()
        if (data.cid) {
          const textarea = document.getElementById('compose-content')
          const url = ipfsUrl(data.cid)
          // insert markdown at cursor position
          const pos = textarea.selectionStart || textarea.value.length
          const before = textarea.value.substring(0, pos)
          const after = textarea.value.substring(pos)
          textarea.value = before + (before.endsWith('\n') || !before ? '' : '\n') + `![${file.name}](${url})` + '\n' + after
          // show inline thumbnail preview
          statusEl.innerHTML = `<img src="${escapeHtml(url)}" loading="lazy" style="max-width:200px;max-height:100px;margin-top:0.5em;border:1px solid var(--border)"> ${t('compose.uploaded')}`
        } else {
          statusEl.textContent = t('compose.uploadFailed', { error: data.error || 'unknown' })
        }
      } catch (e) { statusEl.textContent = t('compose.uploadError', { error: e.message }) }
    }
    input.click()
  })

  // --- Drag-and-drop + paste media upload on compose textarea ---
  const composeTextarea = document.getElementById('compose-content')
  let _composeDropOverlay = null

  // File type helpers
  function _composeFileCategory(file) {
    if (!file || !file.type) return 'other'
    if (file.type.startsWith('image/')) return 'image'
    if (file.type.startsWith('video/')) return 'video'
    if (file.type.startsWith('audio/')) return 'audio'
    if (file.type === 'application/pdf') return 'pdf'
    return 'other'
  }

  function _composeSizeLimit(category) {
    // 10MB images, 50MB video, 50MB audio, 10MB PDF
    if (category === 'video' || category === 'audio') return 50 * 1024 * 1024
    return 10 * 1024 * 1024
  }

  function _composeMarkdown(category, filename, url) {
    if (category === 'image') return `![${filename}](${url})`
    if (category === 'video') return `[video: ${filename}](${url})`
    if (category === 'audio') return `[audio: ${filename}](${url})`
    return `[${filename}](${url})`
  }

  function _composeInsertText(textarea, text) {
    const pos = textarea.selectionStart || textarea.value.length
    const before = textarea.value.substring(0, pos)
    const after = textarea.value.substring(pos)
    const nl = before.endsWith('\n') || !before ? '' : '\n'
    textarea.value = before + nl + text + '\n' + after
    textarea.selectionStart = textarea.selectionEnd = pos + nl.length + text.length + 1
  }

  function _composeShowDropOverlay(show) {
    if (show) {
      if (!_composeDropOverlay) {
        _composeDropOverlay = document.createElement('div')
        _composeDropOverlay.className = 'compose-drop-overlay'
        _composeDropOverlay.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5);border:2px dashed var(--accent);border-radius:4px;color:var(--accent);font-size:0.95em;pointer-events:none;z-index:10'
        _composeDropOverlay.textContent = 'drop to upload'
      }
      const wrapper = composeTextarea.parentElement
      if (wrapper && !wrapper.contains(_composeDropOverlay)) {
        wrapper.style.position = 'relative'
        wrapper.appendChild(_composeDropOverlay)
      }
      composeTextarea.style.borderColor = 'var(--accent)'
    } else {
      if (_composeDropOverlay?.parentElement) _composeDropOverlay.remove()
      composeTextarea.style.borderColor = ''
    }
  }

  // Poll IPFS upload job until done (mirrors settings.js _pollUploadJob)
  async function _composePollJob(jobId, statusEl, onStatus) {
    const POLL_INTERVAL = 2000
    const MAX_POLLS = 300
    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL))
      try {
        const res = await fetch(`/api/ipfs/status/${jobId}`)
        const data = await res.json()
        if (data.status === 'done' && data.cid) return data.cid
        if (data.status === 'error') throw new Error(data.error || 'upload failed')
        const msg = data.status === 'queued' ? 'queued — waiting...' : 'pinning to IPFS...'
        statusEl.textContent = msg
        if (onStatus) onStatus(msg)
      } catch (e) { throw e }
    }
    throw new Error('upload timed out')
  }

  // Core upload handler shared by drag-drop and paste
  let _composeUploadActive = 0

  function _composeSetPublishEnabled(enabled) {
    const btn = document.getElementById('compose-post')
    if (btn) { btn.disabled = !enabled; btn.style.opacity = enabled ? '1' : '0.4' }
  }

  async function _composeUploadFile(file) {
    const statusEl = document.getElementById('compose-status')
    const category = _composeFileCategory(file)
    if (category === 'other') { statusEl.textContent = 'unsupported file type'; return }

    const limit = _composeSizeLimit(category)
    if (file.size > limit) {
      const limitMB = Math.round(limit / (1024 * 1024))
      statusEl.textContent = `file too large (max ${limitMB}MB for ${category})`
      return
    }

    // Disable publish while uploading
    _composeUploadActive++
    _composeSetPublishEnabled(false)

    // Insert placeholder at cursor (updated with % during upload)
    const safeName = escapeHtml(file.name)
    let placeholder = `[uploading ${safeName} 0%...]`
    _composeInsertText(composeTextarea, placeholder)
    statusEl.textContent = t('compose.uploading')

    function updatePlaceholder(pct) {
      const newPlaceholder = `[uploading ${safeName} ${pct}%...]`
      composeTextarea.value = composeTextarea.value.replace(placeholder, newPlaceholder)
      placeholder = newPlaceholder
    }

    try {
      const token = await getAuthToken()
      if (!token) {
        composeTextarea.value = composeTextarea.value.replace(placeholder, '')
        statusEl.textContent = t('compose.walletRequired')
        return
      }

      // Phase 1: XHR upload with progress
      const queueData = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('POST', `/api/ipfs?name=${encodeURIComponent(file.name)}`)
        xhr.setRequestHeader('Authorization', `Bearer ${token}`)
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100)
            updatePlaceholder(pct)
            statusEl.textContent = `uploading... ${pct}%`
          }
        }
        xhr.onload = () => {
          try { resolve(JSON.parse(xhr.responseText)) }
          catch { reject(new Error(xhr.statusText || 'upload failed')) }
        }
        xhr.onerror = () => reject(new Error('upload failed'))
        xhr.ontimeout = () => reject(new Error('upload timeout'))
        xhr.timeout = 10 * 60 * 1000
        xhr.send(file)
      })

      if (queueData.error) {
        composeTextarea.value = composeTextarea.value.replace(placeholder, '')
        statusEl.textContent = t('compose.uploadFailed', { error: queueData.error })
        return
      }

      // Phase 2: resolve CID (poll job queue or use direct CID)
      let cid
      if (queueData.jobId) {
        statusEl.textContent = 'queued...'
        cid = await _composePollJob(queueData.jobId, statusEl, (msg) => {
          const newPlaceholder = `[${msg} ${safeName}...]`
          composeTextarea.value = composeTextarea.value.replace(placeholder, newPlaceholder)
          placeholder = newPlaceholder
        })
      } else if (queueData.cid) {
        cid = queueData.cid
      } else {
        composeTextarea.value = composeTextarea.value.replace(placeholder, '')
        statusEl.textContent = t('compose.uploadFailed', { error: 'no CID returned' })
        return
      }

      const url = ipfsUrl(cid)
      const md = _composeMarkdown(category, file.name, url)
      composeTextarea.value = composeTextarea.value.replace(placeholder, md)

      // Show preview for images
      if (category === 'image') {
        statusEl.innerHTML = `<img src="${escapeHtml(url)}" loading="lazy" style="max-width:200px;max-height:100px;margin-top:0.5em;border:1px solid var(--border)"> ${t('compose.uploaded')}`
      } else {
        statusEl.textContent = `${t('compose.uploaded')} (${category})`
      }
    } catch (e) {
      composeTextarea.value = composeTextarea.value.replace(placeholder, '')
      statusEl.textContent = t('compose.uploadError', { error: e.message })
    } finally {
      _composeUploadActive = Math.max(0, _composeUploadActive - 1)
      if (_composeUploadActive === 0) _composeSetPublishEnabled(true)
    }
  }

  // Drag events
  let _composeDragCounter = 0
  composeTextarea.addEventListener('dragenter', (e) => {
    e.preventDefault()
    _composeDragCounter++
    _composeShowDropOverlay(true)
  })
  composeTextarea.addEventListener('dragover', (e) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  })
  composeTextarea.addEventListener('dragleave', (e) => {
    e.preventDefault()
    _composeDragCounter--
    if (_composeDragCounter <= 0) { _composeDragCounter = 0; _composeShowDropOverlay(false) }
  })
  composeTextarea.addEventListener('drop', async (e) => {
    e.preventDefault()
    _composeDragCounter = 0
    _composeShowDropOverlay(false)
    const files = e.dataTransfer?.files
    if (!files?.length) return
    // Upload first valid file
    for (const file of files) {
      const cat = _composeFileCategory(file)
      if (cat !== 'other') { await _composeUploadFile(file); break }
    }
  })

  // Paste support (Ctrl+V / Cmd+V images from clipboard)
  composeTextarea.addEventListener('paste', async (e) => {
    const items = e.clipboardData?.items
    if (!items) return
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile()
        if (!file) continue
        const cat = _composeFileCategory(file)
        if (cat !== 'other') {
          e.preventDefault()
          await _composeUploadFile(file)
          return
        }
      }
    }
  })

  // formatting buttons
  document.querySelectorAll('.compose-fmt').forEach(btn => {
    if (btn.id === 'compose-image') return // handled separately
    btn.addEventListener('click', () => {
      const textarea = document.getElementById('compose-content')
      const start = textarea.selectionStart
      const end = textarea.selectionEnd
      const selected = textarea.value.substring(start, end)

      if (btn.dataset.wrap) {
        const wrap = btn.dataset.wrap
        textarea.value = textarea.value.substring(0, start) + wrap + selected + wrap + textarea.value.substring(end)
        textarea.selectionStart = start + wrap.length
        textarea.selectionEnd = end + wrap.length
      } else if (btn.dataset.prefix) {
        const prefix = btn.dataset.prefix
        textarea.value = textarea.value.substring(0, start) + prefix + selected + textarea.value.substring(end)
        textarea.selectionStart = start + prefix.length
        textarea.selectionEnd = end + prefix.length
      } else if (btn.dataset.link) {
        // inline link input instead of browser prompt
        const existing = document.getElementById('compose-link-input')
        if (existing) { existing.remove(); return }
        const linkBar = document.createElement('div')
        linkBar.id = 'compose-link-input'
        linkBar.style.cssText = 'display:flex;gap:0.5ch;align-items:center;padding:0.5em 0;'
        linkBar.innerHTML = `
          <input type="url" id="compose-link-url" placeholder="https://..." style="flex:1;background:#111;border:1px solid #333;color:#c0c0c0;font-family:inherit;font-size:0.85em;padding:0.4em 1ch;box-sizing:border-box">
          <button id="compose-link-insert" class="buy-btn" style="font-size:0.8em;padding:0.3em 1ch">insert</button>
          <button id="compose-link-cancel" style="background:none;border:none;color:#666;font-family:inherit;font-size:0.8em;cursor:pointer">cancel</button>
        `
        btn.parentElement.after(linkBar)
        const urlInput = document.getElementById('compose-link-url')
        urlInput.focus()
        document.getElementById('compose-link-insert').addEventListener('click', () => {
          const url = urlInput.value.trim()
          if (url) {
            const linkText = selected || 'link'
            textarea.value = textarea.value.substring(0, start) + `[${linkText}](${url})` + textarea.value.substring(end)
          }
          linkBar.remove()
          textarea.focus()
        })
        urlInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); document.getElementById('compose-link-insert').click() }
          if (e.key === 'Escape') linkBar.remove()
        })
        document.getElementById('compose-link-cancel').addEventListener('click', () => linkBar.remove())
        return // don't focus textarea yet
      } else if (btn.dataset.inlineRef) {
        // inline reference picker
        const existing = document.getElementById('compose-inline-ref')
        if (existing) { existing.remove(); return }
        const refBar = document.createElement('div')
        refBar.id = 'compose-inline-ref'
        refBar.style.cssText = 'padding:0.5em 0;'
        refBar.innerHTML = `
          <input type="text" id="inline-ref-search" placeholder="${t('compose.searchRefs')}" style="width:100%;background:transparent;border:1px solid #333;color:var(--fg);font-family:inherit;font-size:0.85em;padding:0.4em 0.75ch;box-sizing:border-box;margin-bottom:0.5em" autocomplete="off">
          <div id="inline-ref-results" style="max-height:200px;overflow-y:auto"></div>
        `
        btn.parentElement.after(refBar)
        const refSearchInput = document.getElementById('inline-ref-search')
        refSearchInput.focus()

        let inlineRefTimer = null
        const doInlineRefSearch = async (q) => {
          const resultsEl = document.getElementById('inline-ref-results')
          if (!resultsEl) return
          try {
            const [projData, postData, libData, mediaData] = await Promise.all([
              query(`{ projects(limit: 20, orderBy: "createdAt", orderDirection: "desc") { items { ${F.projectSummary} } } }`),
              query(`{ blogPosts(limit: 20, orderBy: "timestamp", orderDirection: "desc") { items { ${F.postSummary} } } }`),
              query(`{ libraryItems(limit: 20, orderBy: "timestamp", orderDirection: "desc") { items { ${F.libraryItem} } } }`),
              query(`{ mediaListings(limit: 20, orderBy: "timestamp", orderDirection: "desc") { items { ${F.mediaListing} } } }`),
            ])
            const lower = q.toLowerCase()
            const filter = (items) => (items || []).filter(i => !q || (i.title || '').toLowerCase().includes(lower)).slice(0, 5)
            const projects = filter(projData.projects?.items).map(i => ({ ...i, _type: 'project' }))
            const posts = filter(postData.blogPosts?.items).map(i => ({ ...i, _type: 'post' }))
            const library = filter(libData.libraryItems?.items).map(i => ({ ...i, _type: 'library' }))
            const media = filter(mediaData.mediaListings?.items).map(i => ({ ...i, _type: 'media' }))
            const all = [...projects, ...posts, ...library, ...media]
            if (all.length === 0) {
              resultsEl.innerHTML = `<p style="color:var(--dim);font-size:0.8em">${t('compose.noMatches')}</p>`
              return
            }
            const badgeColors = { project: '#6a9955', post: '#569cd6', library: '#c586c0', media: '#ce9178' }
            resultsEl.innerHTML = all.map(item => `
              <div class="inline-ref-item" data-type="${item._type}" data-id="${item.id}" data-title="${escapeHtml(item.title)}" style="display:flex;align-items:center;gap:1ch;padding:0.4em 0.5ch;cursor:pointer;font-size:0.85em;border-bottom:1px solid var(--border)">
                <span style="font-size:0.7em;padding:0.15em 0.5ch;border-radius:2px;background:${badgeColors[item._type]};color:#000;text-transform:uppercase;flex-shrink:0">${item._type}</span>
                <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(item.title)}</span>
              </div>
            `).join('')
            resultsEl.querySelectorAll('.inline-ref-item').forEach(el => {
              el.addEventListener('click', () => {
                const type = el.dataset.type
                const id = el.dataset.id
                const title = el.dataset.title
                const linkText = selected || title
                textarea.value = textarea.value.substring(0, start) + `[${linkText}](praxis://${type}/${id})` + textarea.value.substring(end)
                refBar.remove()
                textarea.focus()
              })
            })
          } catch (e) {
            const resultsEl = document.getElementById('inline-ref-results')
            if (resultsEl) resultsEl.innerHTML = `<p style="color:var(--dim);font-size:0.8em">${t('compose.couldNotSearch')}</p>`
          }
        }

        doInlineRefSearch('')
        refSearchInput.addEventListener('input', () => {
          clearTimeout(inlineRefTimer)
          inlineRefTimer = setTimeout(() => doInlineRefSearch(refSearchInput.value.trim()), 250)
        })
        refSearchInput.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') refBar.remove()
        })
        return // don't focus textarea yet
      }
      textarea.focus()
    })
  })

  // preview toggle
  let previewing = false
  document.getElementById('compose-preview-toggle').addEventListener('click', () => {
    previewing = !previewing
    const textarea = document.getElementById('compose-content')
    const preview = document.getElementById('compose-preview')
    const toggleBtn = document.getElementById('compose-preview-toggle')

    if (previewing) {
      preview.innerHTML = renderMarkdown(textarea.value)
      preview.style.display = 'block'
      textarea.style.display = 'none'
      toggleBtn.textContent = t('compose.edit')
      toggleBtn.style.color = 'var(--accent)'
    } else {
      preview.style.display = 'none'
      textarea.style.display = ''
      toggleBtn.textContent = t('compose.preview')
      toggleBtn.style.color = ''
    }
  })

  // reference picker
  document.getElementById('compose-ref').addEventListener('click', toggleRefPicker)

  // pre-fill for amendments
  if (prefillTitle) document.getElementById('compose-title').value = prefillTitle
  if (prefillContent) document.getElementById('compose-content').value = prefillContent

  document.getElementById('compose-title').focus()
}

let refSearchTimer = null

function toggleRefPicker() {
  const picker = document.getElementById('compose-ref-picker')
  if (picker.style.display !== 'none') { picker.style.display = 'none'; return }

  picker.style.display = 'block'
  picker.innerHTML = `
    <div style="border:1px solid var(--border);padding:0.75em;border-radius:6px">
      <input type="text" id="ref-search" placeholder="${t('compose.searchRefs')}" style="width:100%;background:transparent;border:1px solid #222;color:var(--fg);font-family:inherit;font-size:0.85em;padding:0.4em 0.75ch;margin-bottom:0.5em" autocomplete="off">
      <div id="ref-results" style="max-height:200px;overflow-y:auto"></div>
      <p style="color:var(--dim);font-size:0.75em;margin-top:0.5em">${t('compose.searchHelp')}</p>
    </div>
  `

  const searchInput = document.getElementById('ref-search')
  searchInput.focus()

  // load recent items immediately
  searchRefs('')

  searchInput.addEventListener('input', () => {
    clearTimeout(refSearchTimer)
    refSearchTimer = setTimeout(() => searchRefs(searchInput.value.trim()), 250)
  })
}

async function searchRefs(q) {
  const resultsEl = document.getElementById('ref-results')
  if (!resultsEl) return

  try {
    const [libData, projData] = await Promise.all([
      query(`{ libraryItems(limit: 50, orderBy: "timestamp", orderDirection: "desc") { items { ${F.libraryItem} } } }`),
      query(`{ projects(limit: 50, orderBy: "createdAt", orderDirection: "desc") { items { ${F.projectSummary} } } }`),
    ])

    const lower = q.toLowerCase()
    const libItems = (libData.libraryItems?.items || []).filter(i =>
      !q || i.title.toLowerCase().includes(lower) || (i.author || '').toLowerCase().includes(lower)
    ).slice(0, 10)
    const projItems = (projData.projects?.items || []).filter(i =>
      !q || i.title.toLowerCase().includes(lower)
    ).slice(0, 10)

    if (libItems.length === 0 && projItems.length === 0) {
      resultsEl.innerHTML = `<p style="color:var(--muted);font-size:0.85em;padding:0.5em">${q ? t('compose.noMatches') : t('compose.noItems')}</p>`
      return
    }

    let html = ''

    if (libItems.length > 0) {
      html += `<p style="color:var(--dim);font-size:0.7em;text-transform:uppercase;letter-spacing:0.05em;padding:0.3em 0.5em">${t('compose.refLibrary')}</p>`
      for (const item of libItems) {
        html += `<div class="ref-option" data-ref-type="4" data-ref-id="${item.id}">
          <span style="color:var(--accent)">${escapeHtml(item.title)}</span>
          ${item.author ? `<span style="color:var(--dim)"> -- ${escapeHtml(item.author)}</span>` : ''}
        </div>`
      }
    }

    if (projItems.length > 0) {
      html += `<p style="color:var(--dim);font-size:0.7em;text-transform:uppercase;letter-spacing:0.05em;padding:0.3em 0.5em;margin-top:0.5em">${t('compose.refProjects')}</p>`
      for (const proj of projItems) {
        html += `<div class="ref-option" data-ref-type="1" data-ref-id="${proj.id}">
          <span style="color:var(--accent)">${escapeHtml(proj.title)}</span>
        </div>`
      }
    }

    resultsEl.innerHTML = html

    resultsEl.querySelectorAll('.ref-option').forEach(opt => {
      opt.style.cssText = 'padding:0.4em 0.5em;cursor:pointer;font-size:0.85em;border-bottom:1px solid var(--border)'
      opt.addEventListener('click', () => {
        composeRef.type = parseInt(opt.dataset.refType)
        composeRef.id = parseInt(opt.dataset.refId)
        const title = opt.querySelector('span')?.textContent || ''
        document.getElementById('compose-ref-label').textContent = t('compose.referencing', { title })
        document.getElementById('compose-ref-picker').style.display = 'none'
      })
      opt.addEventListener('mouseenter', () => opt.style.background = 'var(--surface)')
      opt.addEventListener('mouseleave', () => opt.style.background = '')
    })
  } catch {
    resultsEl.innerHTML = `<p style="color:var(--muted);font-size:0.85em">${t('compose.couldNotSearch')}</p>`
  }
}

function closeCompose() {
  const panel = document.getElementById('compose-panel')
  if (!panel) return
  // Save draft if there's content
  const title = panel.querySelector('#compose-title')?.value?.trim() || ''
  const body = panel.querySelector('#compose-body')?.value?.trim() || ''
  if (title || body) {
    try { localStorage.setItem('praxis-blog-draft', JSON.stringify({ title, body, ts: Date.now() })) } catch {}
  }
  panel.classList.remove('compose-open')
  document.body.style.overflow = ''
  setTimeout(() => {
    if (panel.parentNode) panel.remove()
  }, 300)
  const dockWrite = document.getElementById('dock-write')
  if (dockWrite) dockWrite.disabled = false
}


function stripMarkdown(text, preserveNewlines = false) {
  let out = text
    .replace(/!\[([^\]]*)\]\s*\(([^)]+)\)/g, '$1')  // images
    .replace(/\[([^\]]+)\]\s*\(([^)]+)\)/g, '$1')    // links
    .replace(/\*\*(.+?)\*\*/g, '$1')                  // bold
    .replace(/\*(.+?)\*/g, '$1')                       // italic
    .replace(/^#{1,6}\s+/gm, '')                       // headings
    .replace(/^>\s+/gm, '')                            // blockquotes
    .replace(/^---+$/gm, '')                           // horizontal rules
  if (preserveNewlines) {
    out = out.replace(/\n{3,}/g, '\n\n').trim()        // cap at double newline
  } else {
    out = out.replace(/\n{2,}/g, ' ').replace(/\n/g, ' ').trim()
  }
  return out
}

function renderPost(p, domainMap) {
  const domain = domainMap[p.author.toLowerCase()] || `${p.author.slice(0, 6)}...${p.author.slice(-4)}`
  const date = new Date(Number(p.timestamp) * 1000)
  const timeStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

  const content = p.content || ''
  const hasMedia = /\[(video|audio):\s/.test(content) || /!\[/.test(content)
  let mediaHtml = ''
  let textPreview = ''
  if (hasMedia) {
    // Extract first media embed for the card banner
    const mediaMatch = content.match(/(\[video:\s*[^\]]*\]\s*\([^)]+\)|!\[[^\]]*\]\s*\([^)]+\))/)
    if (mediaMatch) mediaHtml = renderMarkdown(mediaMatch[0])
    // Strip media from text preview
    const textOnly = content.replace(/\[video:\s*[^\]]*\]\s*\([^)]+\)/g, '').replace(/!\[[^\]]*\]\s*\([^)]+\)/g, '').trim()
    if (textOnly) {
      const raw = stripMarkdown(textOnly, true)
      const truncated = raw.length > 200 ? raw.slice(0, 200) + '...' : raw
      textPreview = escapeHtml(truncated).replace(/\n/g, '<br>')
    }
  } else {
    const raw = stripMarkdown(content, true)
    const truncated = raw.length > 300 ? raw.slice(0, 300) + '...' : raw
    textPreview = escapeHtml(truncated).replace(/\n/g, '<br>')
  }

  // Replies are collected separately and injected under their parent post card
  // by renderCachedFeed (see _replyMap below). We return '' here so they don't
  // render as standalone items in the feed stream.
  const isReply = p.refType && Number(p.refType) > 0 && Number(p.refType) !== 5
  if (isReply) {
    // Stash this reply for the parent post to pick up.
    // IMPORTANT: refId can be 0 (post ID 0 is valid — postCount starts at 0).
    // Use != null instead of truthiness check so refId=0 isn't treated as "no parent".
    const parentId = p.refId != null ? String(p.refId) : ''
    if (parentId !== '' && _replyMap) {
      if (!_replyMap[parentId]) _replyMap[parentId] = []
      const excerpt = stripMarkdown(p.content || '').slice(0, 100)
      _replyMap[parentId].push({ author: domain, id: p.id, time: timeStr, excerpt })
    }
    return ''
  }

  const displayTitle = p.title || ''

  return `
    <div class="feed-item feed-article" data-post-id="${p.id}" style="border:1px solid var(--border);border-radius:6px;overflow:hidden;padding:0">
      ${mediaHtml ? `<div class="feed-media-wrap">${mediaHtml}</div>` : ''}
      <div style="padding:0.75em 1em">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.4em">
          <a href="/network?artist=${p.author.toLowerCase()}" class="feed-author">${escapeHtml(domain)}</a>
          <time class="feed-time" style="color:var(--dim);font-size:0.85em">${timeStr}</time>
        </div>
        <a href="/post?id=${p.id}" style="color:inherit;text-decoration:none;display:block">
          ${displayTitle ? `<div style="font-weight:700;margin-bottom:0.3em;font-size:1.4em;line-height:1.25;letter-spacing:-0.01em">${escapeHtml(displayTitle)}</div>` : ''}
          ${textPreview ? `<div style="color:var(--muted);font-size:0.9em;line-height:1.6">${textPreview}</div>` : ''}
        </a>
        <a href="/post?id=${p.id}" style="color:var(--accent);font-size:0.85em;margin-top:0.5em;display:inline-block">${t('feed.readMore')} \u2192</a>
      </div>
    </div>
  `
}

async function submitPost(blogAddr) {
  const titleInput = document.getElementById('compose-title')
  const bodyInput = document.getElementById('compose-content') || document.getElementById('compose-body')
  const statusEl = document.getElementById('compose-status')
  const title = titleInput.value.trim()
  const content = bodyInput.value.trim()

  if (!title) { statusEl.textContent = t('compose.enterTitle'); return }

  const addr = window.getWalletAddress?.()
  if (!addr) {
    await window.connectWallet?.()
    if (!window.getWalletAddress?.()) { statusEl.textContent = t('compose.connectWallet'); return }
  }

  try {
    await getWalletProvider().request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0xa' }],
    })
  } catch (e) {
    if (e.code === 4902) { statusEl.textContent = t('compose.addOptimism'); return }
  }

  statusEl.textContent = t('compose.confirming')

  try {
    const publicClient = await getPublicClient()

    const isAmend = !!_amendPostId
    const useRef = isAmend || (composeRef.type > 0 && composeRef.id > 0)
    let fnArgs
    if (isAmend) {
      fnArgs = [title, content, 5, BigInt(_amendPostId)]
    } else if (useRef) {
      fnArgs = [title, content, composeRef.type, BigInt(composeRef.id)]
    } else {
      fnArgs = [title, content]
    }
    await window.ensureOptimism?.()
    const currentAccount = await window.ensureAuthorized?.() || window.getWalletAddress()
    const walletClient = createWalletClient({
      chain: optimism,
      transport: custom(getWalletProvider()),
    })
    const hash = await walletClient.writeContract({
      address: blogAddr,
      abi: BLOG_ABI,
      functionName: useRef ? 'postWithRef' : 'post',
      args: fnArgs,
      account: currentAccount,
    })

    statusEl.textContent = `tx: ${hash.slice(0, 14)}...`
    await publicClient.waitForTransactionReceipt({ hash })

    titleInput.value = ''
    bodyInput.value = ''
    _amendPostId = null
    try { localStorage.removeItem('praxis-blog-draft') } catch {}
    statusEl.textContent = t('compose.published')
    closeCompose()
    // Clear feed cache so the reload fetches fresh data from Ponder.
    // Ponder typically indexes within 5-10s on Optimism; reload after 5s.
    try { sessionStorage.removeItem('praxis-feed-' + document.body.dataset.owner?.toLowerCase()) } catch {}
    try { for (const k of Object.keys(sessionStorage)) { if (k.startsWith('praxis-feed')) sessionStorage.removeItem(k) } } catch {}
    setTimeout(() => location.reload(), 5000)
  } catch (e) {
    statusEl.textContent = formatTxError(e)
  }
}

function renderProjectCard(p, domainMap, PROJECT_TYPES) {
  const domain = domainMap[p.proposer.toLowerCase()] || `${p.proposer.slice(0, 6)}...${p.proposer.slice(-4)}`
  const date = new Date(Number(p.createdAt) * 1000)
  const timeStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const goalEth = formatEthAmount(p.fundingGoal)
  const fundedEth = formatEthAmount(p.totalFunded)
  const pct = Number(p.fundingGoal) > 0 ? Math.round(Number(p.totalFunded) * 100 / Number(p.fundingGoal)) : 0
  const typeName = PROJECT_TYPES[p.projectType] || 'other'
  const statusLabels = [t('projects.status.proposed'), t('projects.status.funded'), t('projects.status.confirmed'), t('projects.status.completing'), t('projects.status.completed'), t('projects.status.cancelled'), t('projects.status.disputed')]
  const statusColors = ['#c0c0c0', '#4ade80', '#60a5fa', '#fbbf24', '#a78bfa', '#666', '#ef4444']

  const deadlineStr = p.deadline > 0 ? new Date(Number(p.deadline) * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''

  return `
    <div class="feed-item feed-project-card">
      <div class="feed-project-type">${typeName}</div>
      <div class="feed-project-header">
        <a href="/project?id=${p.id}" class="feed-project-title">${escapeHtml(p.title)}</a>
        <time class="feed-time">${timeStr}</time>
      </div>
      <div class="feed-project-proposer">
        ${t('feed.proposedBy')} <a href="/network?artist=${p.proposer.toLowerCase()}">${escapeHtml(domain)}</a>
        ${deadlineStr ? `<span style="color:var(--dim)"> \u00b7 deadline ${deadlineStr}</span>` : ''}
      </div>
      ${p.description ? `<p class="feed-project-desc">${escapeHtml(p.description).slice(0, 300)}${p.description.length > 300 ? '...' : ''}</p>` : ''}
      <div class="feed-project-funding">
        <div class="feed-project-funding-row">
          <span class="feed-project-funded" data-eth-wei="${p.goal || '0'}">${fundedEth} / ${goalEth} ETH</span>
          <span style="color:${statusColors[p.status]}">${statusLabels[p.status]}</span>
        </div>
        <div class="project-progress-bar"><div class="project-progress-fill" style="width:${Math.min(pct, 100)}%"></div></div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:0.75em">
          <span style="color:var(--dim);font-size:0.8em">${pct}% funded</span>
          <a href="/project?id=${p.id}" class="buy-btn" style="font-size:0.8em;padding:0.3em 1.5ch">${t('feed.viewProject')}</a>
        </div>
      </div>
    </div>
  `
}

function renderFundedActivity(f, resolve) {
  const funderDomain = resolve(f.funder)
  const amountEth = formatEthAmount(f.amount)
  const amountLabel = formatEthAmount(f.amount) === '0' ? 'free' : `<span data-eth-wei="${f.amount || '0'}">${amountEth} ETH</span>`

  return `
    <div class="feed-item feed-activity">
      <div class="feed-activity-text">
        <a href="/network?artist=${f.funder.toLowerCase()}" class="feed-author">${escapeHtml(funderDomain)}</a>
        ${t('feed.funded')} <span style="color:#fff">${escapeHtml(f.projectTitle)}</span>
        <span style="color:#4ade80">${amountLabel}</span>
      </div>
    </div>
  `
}

function renderFollowActivity(f, resolve) {
  const followerDomain = resolve(f.follower)
  const followedDomain = resolve(f.followed)
  // Use the followed artist's OG image as a mini preview
  const ogImg = followedDomain.includes('.') ? `<img src="https://${escapeHtml(followedDomain)}/og/index.png" style="width:100%;height:80px;object-fit:cover;display:block;border-radius:6px 6px 0 0" loading="lazy" onerror="this.style.display='none'">` : ''

  return `
    <a href="/network?artist=${f.followed.toLowerCase()}" class="feed-item" style="display:block;border:1px solid var(--border);border-radius:6px;text-decoration:none;color:inherit;padding:0;margin-bottom:0.5em;overflow:hidden">
      ${ogImg}
      <div style="padding:0.6em 1em">
        <span style="color:var(--muted);font-size:0.85em"><span style="color:var(--fg)">${escapeHtml(followerDomain)}</span> ${t('feed.followed')} <span style="color:var(--fg);font-weight:500">${escapeHtml(followedDomain)}</span></span>
      </div>
    </a>
  `
}

function renderLibraryActivity(item, resolve) {
  const domain = resolve(item.contributor)
  const tags = item.tags ? item.tags.split(',').map(tag => tag.trim()).filter(Boolean).map(tag =>
    `<a href="/library?tag=${encodeURIComponent(tag)}" style="display:inline-block;border:1px solid var(--border);color:var(--muted);font-size:0.75em;padding:0.1em 0.6ch;margin:0.15em 0.25ch 0 0;text-decoration:none">${escapeHtml(tag)}</a>`
  ).join('') : ''

  const cid = item.ipfsCid || ''
  const url = item.url || ''
  const mediaLink = cid ? `/api/ipfs-proxy/${cid}` : url

  // All library items get a PDF thumb attempt — if it's not a PDF, the renderer silently skips
  const pdfThumbAttr = mediaLink ? ` data-pdf-thumb="${escapeHtml(mediaLink)}"` : ''

  return `
    <div class="feed-item" style="border:1px solid var(--border);border-radius:6px;overflow:hidden"${pdfThumbAttr}>
      <div class="feed-pdf-thumb-slot" style="display:none"></div>
      <div style="padding:0.75em 1em">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.3em">
          <a href="/network?artist=${item.contributor.toLowerCase()}" class="feed-author">${escapeHtml(domain)}</a>
          <span style="color:var(--dim);font-size:0.8em">${t('feed.addedToLibrary')}</span>
        </div>
        <a href="#" class="feed-library-open" data-media-url="${escapeHtml(mediaLink)}" data-title="${escapeHtml(item.title)}" data-author="${escapeHtml(item.author || '')}" data-item-id="${item.id || ''}" style="color:var(--fg);font-weight:700;font-size:1.1em;text-decoration:none;display:block">${escapeHtml(item.title)}</a>
        ${item.author ? `<div style="color:var(--muted);font-size:0.85em;margin-top:0.2em">${escapeHtml(item.author)}</div>` : ''}
        ${tags ? `<div style="margin-top:0.4em;display:flex;flex-wrap:wrap">${tags}</div>` : ''}
      </div>
    </div>
  `
}

function renderSupporterActivity(s, resolve) {
  const handle = s.handle
  const displayName = handle || resolve(s.wallet)
  const link = handle
    ? `https://${handle}.ourpraxis.network`
    : `/network?audience=${s.wallet.toLowerCase()}`

  return `
    <a href="${escapeHtml(link)}" class="feed-item" style="display:block;border:1px solid var(--border);border-radius:6px;text-decoration:none;color:inherit;padding:0.75em 1em">
      <span style="color:var(--fg);font-weight:500">${escapeHtml(displayName)}</span>
      <span style="color:var(--muted);font-size:0.85em"> ${t('feed.joinedAudience')}</span>
    </a>
  `
}

function renderPurchaseActivity(d, resolve) {
  const buyer = resolve(d.buyer)
  const title = d.title || 'untitled'
  const worksLink = `/works`
  return `
    <div class="feed-item feed-activity">
      <div class="feed-activity-text">
        <span class="feed-author">${escapeHtml(buyer)}</span>
        collected <a href="${worksLink}" class="accent">${escapeHtml(title)}</a>
      </div>
    </div>
  `
}

function renderListedActivity(d, resolve) {
  // Hide delisted listings entirely from feed surfaces. delistMedia() sets the
  // price to 2^128 wei (DELIST_PRICE_SENTINEL) when totalMinted=0; the server
  // also filters this in /api/feed/timeline, but client-side belt-and-braces
  // catches anything coming from older cached responses or fallback paths.
  let priceWei = 0n
  try { priceWei = BigInt(d.price || '0') } catch {}
  if (priceWei >= 2n ** 128n) return ''
  const artist = resolve(d.artist)
  const title = d.title || 'untitled'
  const artLink = `/art?media=${encodeURIComponent(d.mediaId)}`
  const priceEth = priceWei === 0n ? 'free' : `<span data-eth-wei="${d.price || '0'}">${(Number(priceWei) / 1e18).toFixed(4)} ETH</span>`
  return `
    <div class="feed-item feed-activity">
      <div class="feed-activity-text">
        <span class="feed-author">${escapeHtml(artist)}</span>
        listed <a href="${artLink}" class="accent">${escapeHtml(title)}</a>
        <span class="feed-meta"> · ${priceEth}</span>
      </div>
    </div>
  `
}

function renderListedBatchActivity(d, resolve) {
  const artist = resolve(d.artist)
  const headline = d.headline || 'untitled'
  const otherCount = d.count - 1
  const firstItem = d.items?.[0]
  const artLink = firstItem ? `/art?media=${encodeURIComponent(firstItem.mediaId)}` : '#'
  const itemLinks = (d.items || []).map(it =>
    `<a href="/art?media=${encodeURIComponent(it.mediaId)}" class="accent" style="font-size:0.85em">${escapeHtml(it.title || 'untitled')}</a>`
  ).join(', ')
  return `
    <div class="feed-item feed-activity">
      <div class="feed-activity-text">
        <span class="feed-author">${escapeHtml(artist)}</span>
        listed <a href="${artLink}" class="accent">${escapeHtml(headline)}</a>
        and ${otherCount} other track${otherCount !== 1 ? 's' : ''}
      </div>
      <div style="margin-top:0.3em;color:var(--muted);font-size:0.85em;line-height:1.6">${itemLinks}</div>
    </div>
  `
}

// --- Bookmark server sync (localStorage base in utils.js) ---
let _bookmarkToken = ''
window.addEventListener('wallet-connected', () => { _bookmarkToken = '' })
window.addEventListener('wallet-disconnected', () => { _bookmarkToken = '' })
let _bookmarkKeyDerived = false
let _bookmarkSyncing = false

function _localBookmarkKey() {
  const addr = window.getWalletAddress?.()?.toLowerCase()
  return addr ? `praxis:bookmarks:${addr}` : null
}

function _setLocalBookmarks(bookmarks) {
  const key = _localBookmarkKey()
  if (!key) return
  try { localStorage.setItem(key, JSON.stringify(bookmarks)) } catch {}
}

async function _pushBookmarksToServer(bookmarks) {
  if (!_bookmarkToken || !_bookmarkKeyDerived) return
  try {
    await fetch('/api/bookmarks', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${_bookmarkToken}` },
      body: JSON.stringify({ data: JSON.stringify(bookmarks) }),
    })
  } catch { /* server push failed, localStorage still has the data */ }
}

// Wrap utils bookmark functions with server push
function saveBookmark(item) {
  _saveBookmark(item)
  _pushBookmarksToServer(_getBookmarks())
}

function removeBookmark(itemId) {
  _removeBookmark(itemId)
  _pushBookmarksToServer(_getBookmarks())
}

function isBookmarked(itemId) {
  return _isBookmarked(itemId)
}

function getBookmarks() {
  return _getBookmarks()
}

// Sync bookmarks from server — called on wallet connect
// Requires wallet signature to derive AES key (same as journal)
async function syncBookmarks() {
  if (_bookmarkSyncing) return
  _bookmarkSyncing = true
  const addr = window.getWalletAddress?.()
  if (!addr || !getWalletProvider()) { _bookmarkSyncing = false; return }

  try {
    // authenticate (get session token)
    if (!_bookmarkToken) {
      await window.ensureAuthorized?.()
      const authMsg = `admin:${location.hostname}:${Date.now()}`
      const authSig = await getWalletProvider().request({
        method: 'personal_sign',
        params: [authMsg, addr],
      })
      const authRes = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: addr, signature: authSig, message: authMsg }),
      })
      const authData = await authRes.json()
      if (authData.error) { _bookmarkSyncing = false; return }
      _bookmarkToken = authData.token
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
      const keyHex = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('')

      await fetch('/api/journal-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${_bookmarkToken}` },
        body: JSON.stringify({ key: keyHex }),
      })
      _bookmarkKeyDerived = true
    }

    // fetch server bookmarks
    const res = await fetch('/api/bookmarks', {
      headers: { 'Authorization': `Bearer ${_bookmarkToken}` },
    })
    const result = await res.json()

    if (result.data) {
      const serverBookmarks = JSON.parse(result.data)
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
        _pushBookmarksToServer(mergedList)
      }
    } else {
      // no server data — push local bookmarks up
      const local = getBookmarks()
      if (local.length > 0) _pushBookmarksToServer(local)
    }
  } catch {
    // sync failed — localStorage still has the data
  } finally {
    _bookmarkSyncing = false
  }
}

// auto-sync when wallet connects (non-blocking)
window.addEventListener('wallet-connected', () => { syncBookmarks().catch(() => {}) })

// --- Library item bottom sheet (delegates to shared openMediaSheet in utils.js) ---
document.addEventListener('click', (e) => {
  const link = e.target.closest('.feed-library-open')
  if (!link) return
  e.preventDefault()
  const url = link.dataset.mediaUrl
  const title = link.dataset.title
  const author = link.dataset.author
  const itemId = link.dataset.itemId || ''
  if (!url) return
  openMediaSheet({ url, title, author, itemId })
})

// escapeHtml imported from utils.js
