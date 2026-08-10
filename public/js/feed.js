// Social feed — shows blog posts from followed artists on the homepage
import { renderMediaCard, renderBatchCard, renderFollowCard, renderJoinedCard, renderProjectCard, renderFundedCard, renderPurchaseCard, renderPurchaseBatchCard, renderSupporterCard } from './feed-cards.js'

// Named constants for magic numbers used across the module
const PREVIEW_LEN_WITH_MEDIA = 200
const PREVIEW_LEN_TEXT_ONLY = 300
const FEED_CACHE_MAX = 50
const FEED_RENDERED_MAX = 200
const OWNED_MEDIA_MAX = 2000

// Cached site modules for album name resolution (fetched once lazily)
let _cachedSiteModules = null
async function _ensureSiteModules() {
  if (_cachedSiteModules) return
  try {
    const res = await fetch('/api/site')
    if (res.ok) {
      const data = await res.json()
      _cachedSiteModules = data.modules || []
    }
  } catch (e) { console.warn('praxis: failed to fetch site modules:', e?.message) }
}
// Pre-fetch on load (non-blocking)
_ensureSiteModules()

import { F } from './fragments.js'
import { query } from './ponder.js'
import { escapeHtml, resolveAddresses, getAllFollows, isBlocked, registerPage, openMediaSheet, isBookmarked as _isBookmarked, saveBookmark as _saveBookmark, removeBookmark as _removeBookmark, getBookmarks as _getBookmarks, getWalletProvider, renderMarkdown, getProfilePic } from './utils.js'
import { t, whenReady as i18nReady } from './i18n.js'
import { getCached, setCache, invalidate, TTL } from './cache.js'

// Temporary map used during renderCachedFeed to collect replies and inject
// them under their parent post card. Set to {} before rendering, null after.
let _replyMap = null

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
  const detail = e.detail || {}
  if (detail.amendPostId) {
    window.location.href = `/write?amend=${detail.amendPostId}`
  } else if (detail.title || detail.content) {
    const params = new URLSearchParams()
    if (detail.title) params.set('prefillTitle', detail.title)
    if (detail.content) params.set('prefillContent', detail.content)
    window.location.href = '/write?' + params.toString()
  } else {
    window.location.href = '/write'
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

// Module-level renderItem — shared by renderCachedFeed and renderFeedBatch.
// domainMap is passed explicitly so the caller controls which map is used.
function renderItem(item, domainMap, resolve) {
  if (item.type === 'post') return renderPost(item.data, domainMap)
  if (item.type === 'project') return renderProjectCard(item.data, resolve)
  if (item.type === 'funded') return renderFundedCard(item.data, resolve)
  if (item.type === 'follow') return renderFollowCard(item.data, resolve)
  if (item.type === 'joined') return renderJoinedCard(item.data, resolve)
  if (item.type === 'library') return renderLibraryActivity(item.data, resolve)
  if (item.type === 'supporter') return renderSupporterCard(item.data, resolve)
  if (item.type === 'purchase') return renderPurchaseCard(item.data, resolve)
  if (item.type === 'purchase-batch') return renderPurchaseBatchCard(item.data, resolve)
  if (item.type === 'listed') return renderMediaCard(item.data, resolve)
  if (item.type === 'listed-batch') return renderBatchCard(item.data, resolve, { siteModules: _cachedSiteModules })
  return ''
}

function renderCachedFeed(feedItems, domainMap, postsEl) {
  const resolve = addr => domainMap[addr.toLowerCase()] || `${addr.slice(0, 6)}...${addr.slice(-4)}`

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
  }).map(i => renderItem(i, domainMap, resolve)).filter(Boolean).join('<div class="feed-separator">\u25C7</div>')

  // Inject reply sections under their parent post cards. Each post card
  // has data-post-id="<id>". Replies are grouped in a scrollable mini-box
  // (max-height 120px) so 100 replies don't blow up the feed layout.
  const postEls = new Map()
  postsEl.querySelectorAll('.feed-article[data-post-id]').forEach(el => postEls.set(el.dataset.postId, el))
  for (const [parentId, replies] of Object.entries(_replyMap)) {
    const parentCard = postEls.get(parentId)
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
    _feedAuthors = [...new Set([myAddr, ...followed])].filter(a => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a)).slice(0, 1000)

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

    // Hide buy buttons for items the user already owns
    hideOwnedBuyButtons(postsEl, myAddr)

    // cache only the first page (max 50 items) to bound sessionStorage usage
    if (!hasMoreFeedPages()) {
      setCache(cacheKey, { feedItems: _feedRenderedItems.slice(0, FEED_CACHE_MAX), domainMap: _feedDomainMap, authors: _feedAuthors }, TTL.medium)
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
  if (item.type === 'purchase-batch') return `purchase-batch:${d.buyer}-${d.items?.[0]?.mediaId || item.timestamp}`
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

  const resolve = addr => _feedDomainMap[addr.toLowerCase()] || `${addr.slice(0, 6)}...${addr.slice(-4)}`

  // remove sentinel before appending
  postsEl.querySelector('#feed-sentinel')?.remove()

  const sep = '<div class="feed-separator">\u25C7</div>'
  const html = items.map(i => renderItem(i, _feedDomainMap, resolve)).filter(Boolean).join(sep)
  // Add separator before new items if there's existing content
  const needsSep = postsEl.children.length > 0 && html
  postsEl.insertAdjacentHTML('beforeend', (needsSep ? sep : '') + html)
  _feedRenderedItems.push(...items)
  // cap rendered items to prevent unbounded memory growth
  if (_feedRenderedItems.length > FEED_RENDERED_MAX) {
    _feedRenderedItems.splice(0, _feedRenderedItems.length - FEED_RENDERED_MAX)
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
      setCache(cacheKey, { feedItems: _feedRenderedItems.slice(0, FEED_CACHE_MAX), domainMap: _feedDomainMap, authors: _feedAuthors }, TTL.medium)
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
        hideOwnedBuyButtons(postsEl, window.getWalletAddress?.()?.toLowerCase())
      }

      // re-observe the new sentinel
      if (hasMoreFeedPages()) {
        const newSentinel = postsEl.querySelector('#feed-sentinel')
        if (newSentinel) _feedObserver.observe(newSentinel)
      } else {
        _feedObserver.disconnect()
        const cacheKey = 'feed:' + myAddr.toLowerCase()
        setCache(cacheKey, { feedItems: _feedRenderedItems.slice(0, FEED_CACHE_MAX), domainMap: _feedDomainMap, authors: _feedAuthors }, TTL.medium)
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
const _pdfThumbRendered = new Map() // LRU map: key=url, value=true
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
        // Evict oldest entry (first key in Map insertion order)
        if (_pdfThumbRendered.size >= _PDF_THUMB_RENDERED_MAX) {
          const oldest = _pdfThumbRendered.keys().next().value
          if (oldest !== undefined) _pdfThumbRendered.delete(oldest)
        }
        _pdfThumbRendered.set(url, true)
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



// (compose modal removed — all compose goes through /write page)

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
      const truncated = raw.length > PREVIEW_LEN_WITH_MEDIA ? raw.slice(0, PREVIEW_LEN_WITH_MEDIA) + '...' : raw
      textPreview = escapeHtml(truncated).replace(/\n/g, '<br>')
    }
  } else {
    const raw = stripMarkdown(content, true)
    const truncated = raw.length > PREVIEW_LEN_TEXT_ONLY ? raw.slice(0, PREVIEW_LEN_TEXT_ONLY) + '...' : raw
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
    <div class="feed-item feed-article" data-post-id="${escapeHtml(p.id)}" style="border:1px solid var(--border);border-radius:6px;overflow:hidden;padding:0">
      ${mediaHtml ? `<div class="feed-media-wrap">${mediaHtml}</div>` : ''}
      <div style="padding:0.75em 1em">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.4em">
          <a href="/network?artist=${p.author.toLowerCase()}" class="feed-author" style="display:flex;align-items:center;gap:0.5ch">${(() => { const pic = getProfilePic(p.author); return pic ? `<img src="${escapeHtml(pic)}" style="width:24px;height:24px;border-radius:50%;object-fit:cover;flex-shrink:0" loading="lazy" onerror="this.style.display='none'">` : '' })()}${escapeHtml(domain)}</a>
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


// Hide buy buttons for media the current user already owns (purchased)
let _ownedMediaIds = null
async function hideOwnedBuyButtons(container, myAddr) {
  if (!myAddr || !container) return
  try {
    // Lazy-load owned media IDs (once per session)
    if (!_ownedMediaIds) {
      const addr = myAddr.toLowerCase()
      const allIds = new Set()
      let cursor = null
      do {
        const res = await query(`query($buyer: String!, $limit: Int!${cursor ? ', $after: String' : ''}) { mediaPurchases(where: { buyer: $buyer }, limit: $limit${cursor ? ', after: $after' : ''}) { items { mediaId } pageInfo { endCursor hasNextPage } } }`, { buyer: addr, limit: 200, ...(cursor ? { after: cursor } : {}) })
        const items = res.mediaPurchases?.items || []
        for (const item of items) allIds.add(String(item.mediaId))
        cursor = res.mediaPurchases?.pageInfo?.hasNextPage ? res.mediaPurchases?.pageInfo?.endCursor : null
        if (allIds.size >= OWNED_MEDIA_MAX) break // safety cap
      } while (cursor)
      _ownedMediaIds = allIds
    }
    if (_ownedMediaIds.size === 0) return
    // Hide buy buttons for owned items
    container.querySelectorAll('.feed-buy-btn[data-media-id]').forEach(btn => {
      const ids = (btn.dataset.mediaId || '').split(',')
      if (ids.some(id => _ownedMediaIds.has(id))) {
        const owned = document.createElement('span')
        owned.className = 'feed-card-btn'
        owned.style.cssText = 'opacity:0.5;cursor:default;pointer-events:none'
        owned.innerHTML = '<i class="ph ph-check"></i> owned'
        btn.replaceWith(owned)
      }
    })
  } catch (e) { console.warn('praxis: hideOwnedBuyButtons failed:', e?.message) }
}

// renderProjectCard, renderFundedCard now imported from feed-cards.js

function renderLibraryActivity(item, resolve) {
  const domain = resolve(item.contributor)
  const tags = item.tags ? item.tags.split(',').map(tag => tag.trim()).filter(Boolean).map(tag =>
    `<a href="/library?tag=${encodeURIComponent(tag)}" style="display:inline-block;border:1px solid var(--border);color:var(--muted);font-size:0.75em;padding:0.1em 0.6ch;margin:0.15em 0.25ch 0 0;text-decoration:none">${escapeHtml(tag)}</a>`
  ).join('') : ''

  const cid = item.ipfsCid || ''
  const url = item.url || ''
  const hasFile = !!cid
  const mediaLink = cid ? `/api/ipfs-proxy/${cid}` : ''

  // Only show PDF thumb for IPFS-hosted files
  const pdfThumbAttr = hasFile && mediaLink ? ` data-pdf-thumb="${escapeHtml(mediaLink)}"` : ''

  // URL-only items (no IPFS file) open externally; file items open in our viewer
  const titleLink = hasFile
    ? `<a href="#" class="feed-library-open" data-media-url="${escapeHtml(mediaLink)}" data-title="${escapeHtml(item.title)}" data-author="${escapeHtml(item.author || '')}" data-item-id="${item.id || ''}" style="color:var(--fg);font-weight:700;font-size:1.1em;text-decoration:none;display:block">${escapeHtml(item.title)}</a>`
    : `<a href="${escapeHtml(url)}" target="_blank" style="color:var(--fg);font-weight:700;font-size:1.1em;text-decoration:none;display:flex;align-items:center;gap:0.5ch">${escapeHtml(item.title)} <i class="ph ph-arrow-square-out" style="font-size:0.8em;color:var(--muted)"></i></a>`

  // URL-only items show a link icon instead of PDF icon
  const iconSlot = hasFile
    ? '<div class="feed-pdf-thumb-slot" style="display:none"></div>'
    : ''

  return `
    <div class="feed-item" style="border:1px solid var(--border);border-radius:6px;overflow:hidden"${pdfThumbAttr}>
      ${iconSlot}
      <div style="padding:0.75em 1em">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.3em">
          <a href="/network?artist=${item.contributor.toLowerCase()}" class="feed-author" style="display:flex;align-items:center;gap:0.5ch">${(() => { const pic = getProfilePic(item.contributor); return pic ? `<img src="${escapeHtml(pic)}" style="width:24px;height:24px;border-radius:50%;object-fit:cover;flex-shrink:0" loading="lazy" onerror="this.style.display='none'">` : '' })()}${escapeHtml(domain)}</a>
          <span style="color:var(--dim);font-size:0.8em">${t('feed.addedToLibrary')}</span>
        </div>
        ${titleLink}
        ${item.author ? `<div style="color:var(--muted);font-size:0.85em;margin-top:0.2em">${escapeHtml(item.author)}</div>` : ''}
        ${tags ? `<div style="margin-top:0.4em;display:flex;flex-wrap:wrap">${tags}</div>` : ''}
      </div>
    </div>
  `
}

// renderSupporterCard, renderPurchaseCard now imported from feed-cards.js

// --- Bookmark server sync (localStorage base in utils.js) ---
let _bookmarkToken = ''
window.addEventListener('wallet-connected', () => { _bookmarkToken = ''; _bookmarkCryptoKey = null; _bookmarkKeyDerived = false })
window.addEventListener('wallet-disconnected', () => { _bookmarkToken = ''; _bookmarkCryptoKey = null; _bookmarkKeyDerived = false })
window.addEventListener('bookmarks-changed', (e) => { if (e.detail) _pushBookmarksToServer(e.detail) })
let _bookmarkKeyDerived = false
let _bookmarkCryptoKey = null

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

// Buy button delegation handled globally by feed-cards.js

// escapeHtml imported from utils.js
