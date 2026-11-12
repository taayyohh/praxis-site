// Social feed — shows blog posts from followed artists on the homepage
import { renderProjectCard, renderPostFeedCard, renderLibraryFeedCard, stripMarkdown } from './feed-cards.js'
import { renderMediaCard } from './media-card.js'
import { renderEventCard } from './event-card.js'
// feed-cards.js self-registers the global .feed-buy-btn + .track-play-btn
// delegation on import; keep the side-effect import so MediaCard's
// buttons continue to route through showPurchaseConfirmation.
import './feed-cards.js'

// Named constants for magic numbers used across the module
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
import { escapeHtml, resolveAddresses, getAllFollows, isBlocked, registerPage, openMediaSheet, renderMarkdown, getProfilePic, resolveDomain, formatEthAmount } from './utils.js'
import { t, whenReady as i18nReady } from './i18n.js'
import { getCached, setCache, invalidate, TTL } from './cache.js'
import { startBookmarkSync } from './bookmarks-sync.js'

// Defensive — spa.js already calls this on module load; this call is
// idempotent and covers the case where feed.js gets imported standalone.
startBookmarkSync()

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
  if (!feedContainer) return
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
    const ethBalance = formatEthAmount(balance)

    // render in dock
    const topBalance = document.getElementById('top-balance')
    if (topBalance) {
      const short = parseFloat(ethBalance).toFixed(4)
      topBalance.textContent = `${short}\u039E `
      topBalance.title = `${ethBalance} ETH on Optimism`
    }
}

// Feed dispatch — media types route to the universal MediaCard; the
// pure protocol-signal types route to the universal EventCard. Post,
// project (which carries a funding bar), and library stay bespoke for
// now. See public/js/media-card.js + public/js/event-card.js.
const EVENT_TYPES_TO_CARD = new Set([
  'follow', 'joined', 'supporter', 'funded', 'transfer', 'referral',
  'org-created', 'ticket-listed', 'ticket-purchased', 'credential',
  'project-completed', 'project-confirmed', 'project-completing',
  'project-disputed', 'project-cancelled', 'project-timedout',
  'revenue-distributed',
])

// Feed `type` → EventCard DESCRIPTORS key (differs for a few entries).
const EVENT_TYPE_ALIAS = {
  joined: 'joined-audience',
  'project-timedout': 'project-timed-out',
}

function renderItem(item, domainMap, resolve) {
  const t = item.type
  if (t === 'post') return renderPost(item.data, domainMap)
  if (t === 'project') return renderProjectCard(item.data, resolve)
  if (t === 'library') return renderLibraryActivity(item.data, resolve)

  // ── media (listings + purchases) ──────────────────────────
  // Layout rules the FEED enforces (works/collection grids pick their
  // own layouts, this only governs the full-width feed column):
  //   - batches (listed-batch, purchase-batch) → --album
  //       (220px cover + tracklist earns its size — an album is the
  //        biggest unit a card represents)
  //   - solo video → --wide (16:9 preview is the point)
  //   - solo everything else (audio, image, document, ticket, …) →
  //       --horizontal (120px art + info + inline buttons)
  // Why one shape for all singles: a single track isn't more important
  // than an album, so it must not take more viewport than an album.
  // Design philosophy §1 "content earns its size" + §9 "the eye should
  // never have to re-find where things are" — one rendering per unit.
  if (t === 'listed' || t === 'listed-batch' || t === 'purchase' || t === 'purchase-batch') {
    const d = item.data
    const isBatch = t === 'listed-batch' || t === 'purchase-batch'
    const isPurchase = t === 'purchase' || t === 'purchase-batch'
    const ct = (d.contentType || '').toLowerCase()
    const isVideo = ct.startsWith('video/')
    const layout = isBatch ? 'album' : (isVideo ? 'wide' : 'horizontal')
    // Phase 15: tag the item's kind at the call site so MediaCard
    // dispatches explicitly (no more duck-typing an album from the
    // presence of aliasName + title). Server may already emit `kind`
    // on timeline rows — honor it when present.
    const kind = d.kind || (isBatch ? 'album'
      : isVideo ? 'video'
      : ct.startsWith('audio/') ? 'single-track'
      : ct.startsWith('image/') ? 'gallery-image'
      : ct === 'application/pdf' || ct.startsWith('text/') ? 'writing'
      : 'single-track')
    return renderMediaCard({ ...d, kind }, {
      layout,
      resolve,
      header: isPurchase ? { kind: 'collected', actor: d.buyer } : null,
      actions: isPurchase
        ? (isBatch ? ['view'] : ['view'])
        : (isBatch ? ['play-all', 'buy-album'] : ['buy']),
    })
  }

  // ── events ────────────────────────────────────────────────
  if (EVENT_TYPES_TO_CARD.has(t)) {
    const descKey = EVENT_TYPE_ALIAS[t] || t
    const useBanner = (
      t === 'project-proposed' || t === 'project-confirmed' ||
      t === 'project-completing' || t === 'project-completed' ||
      t === 'project-disputed' || t === 'project-cancelled' ||
      t === 'project-timedout' || t === 'org-created' ||
      t === 'revenue-distributed' || t === 'funded'
    )
    return renderEventCard({ ...item.data, type: descKey }, {
      resolve,
      layout: useBanner ? 'banner' : 'line',
      // Phase 11b: flip the feed's line-layout events into the fat +
      // warm shape. Banner events (project lifecycle hero rows) stay
      // on their poster-above-headline rhythm.
      fat: !useBanner,
    })
  }
  return ''
}

function renderCachedFeed(feedItems, domainMap, postsEl) {
  const resolve = addr => resolveDomain(domainMap, addr)

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
  }).map(i => {
    const html = renderItem(i, domainMap, resolve)
    if (!html) return ''
    const key = feedItemKey(i)
    return `<div data-feed-key="${escapeHtml(key)}">${html}</div>`
  }).filter(Boolean).join('<div class="feed-separator">\u25C7</div>')

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

  // check cache first (useful on SPA back-navigation).
  // The version suffix invalidates every user's feed cache the moment any
  // client-side shape change ships. Older entries become unreachable
  // because the key differs — no per-user clearing needed. Bump this
  // whenever the batch grouping, merge logic, or card schema changes.
  const FEED_CACHE_VERSION = '2026-10-16-solo-album-fold'
  const cacheKey = `feed:${FEED_CACHE_VERSION}:${myAddr.toLowerCase()}`
  const cached = getCached(cacheKey)
  if (cached) {
    statusEl.textContent = ''
    renderCachedFeed(cached.feedItems, cached.domainMap, postsEl)

    // Background freshness check — hash the top server items and compare
    // against the top cached items. Any drift (new item, dropped item,
    // changed batch count, timestamp shift) invalidates the cache.
    // Comparing only the head missed server-side merge-logic changes that
    // reshaped older items while the newest item stayed identical. Hashing
    // the top 10 catches those too.
    ;(async () => {
      try {
        const authors = (cached.authors || [myAddr]).slice(0, 100)
        const res = await fetch('/api/feed/timeline', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ authors, after: null }),
        })
        if (!res.ok) return
        const latest = await res.json()
        const stamp = (list) => (list || [])
          .slice(0, 10)
          .map(i => {
            const d = i.data || {}
            return `${i.type}:${i.timestamp}:${d.count ?? ''}:${(d.items || []).length}`
          })
          .join('|')
        if (stamp(latest.items) !== stamp(cached.feedItems)) {
          invalidate('feed:')
          loadFeed(myAddr, blogAddr)
        }
      } catch {}
    })()

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
      setCache(cacheKey, { feedItems: _feedRenderedItems.slice(0, FEED_CACHE_MAX), domainMap: _feedDomainMap, authors: _feedAuthors }, TTL.short)
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

  // Cross-page merge for album purchases + listings. Server merges within
  // a single 50-item response, but a buyer's two on-chain purchaseBatch
  // txs for the same album can land on different pages. Here we scan the
  // items already rendered (_feedRenderedItems) for a matching batch key
  // and fold the new page's items into it when we find a hit.
  // Key: `${buyer}::${aliasName}::${albumPath.alias}::${albumPath.album}`
  const _albumKey = (it) => {
    const d = it?.data
    if (!d?.albumPath || !d.aliasName) return null
    const who = (d.buyer || d.artist || '').toLowerCase()
    if (!who) return null
    return `${who}::${d.aliasName}::${d.albumPath.alias}::${d.albumPath.album}`
  }
  const _foldAlbumBatch = (bucketType, incoming) => {
    const key = _albumKey(incoming)
    if (!key) return false
    const existing = _feedRenderedItems.find(x => x.type === bucketType && _albumKey(x) === key)
    if (!existing) return false
    const seen = new Set((existing.data.items || []).map(x => String(x.mediaId)))
    for (const sub of (incoming.data.items || [])) {
      if (!seen.has(String(sub.mediaId))) existing.data.items.push(sub)
    }
    existing.data.count = existing.data.items.length
    if (incoming.timestamp > existing.timestamp) existing.timestamp = incoming.timestamp
    // Re-render the single card in place so the user sees the newly merged
    // tracklist without reloading the whole feed.
    try {
      const card = document.querySelector(`[data-feed-key="${CSS.escape(feedItemKey(existing))}"]`)
      if (card) {
        const freshHtml = renderItem(existing, _feedDomainMap, addr => resolveDomain(_feedDomainMap, addr))
        if (freshHtml) card.outerHTML = freshHtml
      }
    } catch {}
    return true
  }
  items = items.filter(it => {
    if (it.type === 'purchase-batch') return !_foldAlbumBatch('purchase-batch', it)
    if (it.type === 'listed-batch') return !_foldAlbumBatch('listed-batch', it)
    if (it.type === 'purchase') {
      // Solo purchase of a track that belongs to an album — the server
      // now attaches albumPath/aliasName when it resolves. Wrap the solo
      // in a 1-item batch shape so _foldAlbumBatch can find the matching
      // purchase-batch for the same (buyer, album) and merge this track
      // in as a trailing item.
      const d = it.data
      if (!d?.albumPath || !d.aliasName) return true
      const wrapped = {
        type: 'purchase-batch',
        timestamp: it.timestamp,
        data: {
          buyer: d.buyer, artist: d.artist,
          aliasName: d.aliasName, albumPath: d.albumPath,
          items: [{
            mediaId: d.mediaId, title: d.title, price: d.price,
            ipfsCid: d.ipfsCid, contentType: d.contentType, metadataCid: d.metadataCid,
          }],
          count: 1,
        },
      }
      return !_foldAlbumBatch('purchase-batch', wrapped)
    }
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

  const resolve = addr => resolveDomain(_feedDomainMap, addr)

  // remove sentinel before appending
  postsEl.querySelector('#feed-sentinel')?.remove()

  const sep = '<div class="feed-separator">\u25C7</div>'
  const html = items.map(i => {
    const h = renderItem(i, _feedDomainMap, resolve)
    if (!h) return ''
    const key = feedItemKey(i)
    return `<div data-feed-key="${escapeHtml(key)}">${h}</div>`
  }).filter(Boolean).join(sep)
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
      setCache(cacheKey, { feedItems: _feedRenderedItems.slice(0, FEED_CACHE_MAX), domainMap: _feedDomainMap, authors: _feedAuthors }, TTL.short)
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
        setCache(cacheKey, { feedItems: _feedRenderedItems.slice(0, FEED_CACHE_MAX), domainMap: _feedDomainMap, authors: _feedAuthors }, TTL.short)
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

function renderPost(p, domainMap) {
  const domain = domainMap[p.author.toLowerCase()] || `${p.author.slice(0, 6)}...${p.author.slice(-4)}`
  const date = new Date(Number(p.timestamp) * 1000)
  const timeStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

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

  return renderPostFeedCard(p, {
    name: domain, pic: getProfilePic(p.author), timeStr,
    authorHref: `/network?artist=${p.author.toLowerCase()}`,
    postHref: `/post?id=${p.id}`,
  })
}


// Hide buy buttons for media the current user already owns (purchased).
// _ownedMediaIds is keyed BY wallet — the owner switches (sign-in, wallet
// swap, disconnect + reconnect) invalidate the prior cache so we don't
// show "owned" state from a previous user. Prior version kept a plain
// Set across the whole session, so a re-connect to a different wallet
// still saw the old wallet's owned items.
let _ownedMediaIds = null
let _ownedMediaFor = ''
if (typeof window !== 'undefined') {
  // Reset on wallet-connected / disconnect so the very next feed render
  // requeries the new owner's purchases. Also on wallet-balance-changed
  // (which fires after a successful buy) so a just-purchased item flips
  // from "buy" to "owned" without a full reload.
  const _resetOwned = () => { _ownedMediaIds = null; _ownedMediaFor = '' }
  window.addEventListener('wallet-connected', _resetOwned)
  window.addEventListener('wallet-disconnected', _resetOwned)
  window.addEventListener('wallet-balance-changed', _resetOwned)
  // Explicit purchase-completed hook — feed doesn't always see a
  // balance-change (free items, batches with zero price). pay.js dispatches
  // this after every successful buy.
  window.addEventListener('purchase-completed', _resetOwned)
}
async function hideOwnedBuyButtons(container, myAddr) {
  if (!myAddr || !container) return
  try {
    // Lazy-load owned media IDs (once per session, per owner).
    const addr = myAddr.toLowerCase()
    if (!_ownedMediaIds || _ownedMediaFor !== addr) {
      _ownedMediaFor = addr
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
  return renderLibraryFeedCard(item, {
    name: resolve(item.contributor), pic: getProfilePic(item.contributor),
    authorHref: `/network?artist=${item.contributor.toLowerCase()}`,
  })
}

// renderSupporterCard, renderPurchaseCard now imported from feed-cards.js

// Bookmark server sync has moved to public/js/bookmarks-sync.js — mounted
// at startup by spa.js (and defensively by feed.js above), so every route
// participates, not only the ones that load feed.js.

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
