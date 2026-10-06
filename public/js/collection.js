// Collection page — shows soulbound tokens and credentials for connected wallet
import { F } from './fragments.js'
import { query } from './ponder.js'
import { ipfsUrl, escapeHtml, resolveAddresses, resolveDomain, renderMedia, getPublicClient , formatEthAmount, registerPage, openMediaSheet, artPlaceholder, resolveContentTypes, classifyContentType as classifyCT, slugify } from './utils.js'
import { t } from './i18n.js'
import { getCollection, annotateRelistings } from './media.js'
import { getCached, setCache, TTL } from './cache.js'
import { renderMediaCard, renderMediaCardRow } from './media-card.js'
// Side-effect: feed-cards.js registers the global .track-play-btn /
// .album-play-btn delegation that the universal MediaCard relies on.
import './feed-cards.js'

let _collectionInited = false
let _collectionWalletBound = false
let _collectionLoaded = false
let _collectionLoading = false
let _mediaCursor = null
let _mediaHasMore = false
let _credsCursor = null
let _credsHasMore = false
let _currentAddr = null
let _domainMap = {}
const _OBJ_CACHE_MAX = 1000
const _mediaDetails = new Map()
const _projectMap = new Map()
const _coverArtMap = new Map()
const _mediaTypeCache = new Map()
let _mediaLoadingMore = false
let _credsLoadingMore = false
let _allMediaPurchases = []
let _allCredentials = []
let _allSavedItems = []
let _selectedArtist = null
let _artistMap = new Map()
let _searchQuery = ''
let _viewMode = localStorage.getItem('praxis:collection-view') || 'grid'
let _mediaObserver = null
let _credsObserver = null
const _artistSiteCache = new Map() // domain -> { modules, aliases }
const _albumInfoCache = new Map() // coverCid -> { name, path, aliasName }
const _CACHE_MAX = 200
function _lruSet(map, key, value) {
  if (map.has(key)) map.delete(key)
  map.set(key, value)
  if (map.size > _CACHE_MAX) { const oldest = map.keys().next().value; map.delete(oldest) }
}
function _lruGet(map, key) {
  if (!map.has(key)) return undefined
  const v = map.get(key); map.delete(key); map.set(key, v); return v
}

registerPage('collection-page', () => { _collectionInited = true; init() })

function getSavedLibraryItems(addr) {
  const key = `praxis:bookmarks:${addr.toLowerCase()}`
  try {
    const items = JSON.parse(localStorage.getItem(key) || '[]')
    return items.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))
  } catch { return [] }
}

function init() {
  const statusEl = document.getElementById('collection-status')
  const contentEl = document.getElementById('collection-content')
  if (!statusEl || !contentEl) return

  _collectionLoaded = false

  function tryLoad() {
    if (_collectionLoaded) return
    const s = document.getElementById('collection-status')
    const c = document.getElementById('collection-content')
    if (!s || !c) return
    const addr = window.getWalletAddress?.()
    if (addr) { _collectionLoaded = true; loadCollection(addr, s, c) }
  }

  // check now, and once more after wallet auto-connect has time to fire
  tryLoad()

  if (!_collectionWalletBound) {
    _collectionWalletBound = true
    window.addEventListener('wallet-connected', (e) => {
      if (!document.getElementById('collection-page')) return
      _collectionLoaded = false
      const s = document.getElementById('collection-status')
      const c = document.getElementById('collection-content')
      if (!s || !c) return
      const a = e.detail?.address || window.getWalletAddress?.()
      if (a) { _collectionLoaded = true; loadCollection(a, s, c) }
    })

    window.addEventListener('wallet-disconnected', () => {
      if (!document.getElementById('collection-page')) return
      _collectionLoaded = false
      const s = document.getElementById('collection-status')
      const c = document.getElementById('collection-content')
      if (s) s.textContent = t('collection.connect')
      if (c) c.innerHTML = ''
    })
  }

  // if still not connected after 2s, show connect message
  setTimeout(() => {
    if (!_collectionLoaded && !_collectionLoading) {
      const s = document.getElementById('collection-status')
      if (s) s.textContent = t('collection.connect')
    }
  }, 2000)
}

// pagination state + media type cache declared above registerPage to avoid TDZ

async function loadCollection(addr, statusEl, contentEl) {
  if (_collectionLoading) return
  _collectionLoading = true
  statusEl.textContent = ''
  contentEl.innerHTML = '<div class="praxis-loader"></div>'

  // reset pagination state
  _mediaCursor = null
  _mediaHasMore = false
  _credsCursor = null
  _credsHasMore = false
  _currentAddr = addr
  _mediaDetails.clear()
  _projectMap.clear()
  _coverArtMap.clear()
  _mediaLoadingMore = false
  _credsLoadingMore = false
  _allMediaPurchases = []
  _allCredentials = []
  _allSavedItems = []
  _searchQuery = ''
  _selectedArtist = null
  _artistMap = new Map()
  if (_mediaObserver) { _mediaObserver.disconnect(); _mediaObserver = null }
  if (_credsObserver) { _credsObserver.disconnect(); _credsObserver = null }

  try {
    // M12: check structured data cache first (purchases + media details, not rendered HTML)
    const collectionCacheKey = 'collection-data:' + addr.toLowerCase()
    const cachedData = getCached(collectionCacheKey)
    let mediaPurchases, credentials
    if (cachedData) {
      try {
        const parsed = JSON.parse(cachedData)
        mediaPurchases = parsed.purchases || []
        credentials = parsed.credentials || []
        _mediaCursor = parsed.mediaCursor || null
        _mediaHasMore = parsed.mediaHasMore || false
        _credsCursor = parsed.credsCursor || null
        _credsHasMore = parsed.credsHasMore || false
        _mediaDetails.clear(); for (const [k, v] of Object.entries(parsed.mediaDetails || {})) _mediaDetails.set(k, v)
        _projectMap.clear(); for (const [k, v] of Object.entries(parsed.projectMap || {})) _projectMap.set(k, v)
        _domainMap = parsed.domainMap || {}
      } catch { /* fall through to fetch */ }
    }

    if (!mediaPurchases) {
    // fetch FIRST PAGE of media purchases and credentials in parallel
    const [mediaResult, credsResult] = await Promise.all([
      getCollection(addr),
      fetchCredentialsPage(addr.toLowerCase(), null),
    ])

    mediaPurchases = mediaResult.items
    _mediaCursor = mediaResult.cursor
    _mediaHasMore = mediaResult.hasMore

    credentials = credsResult.items
    _credsCursor = credsResult.cursor
    _credsHasMore = credsResult.hasMore

    // get media details for purchases
    if (mediaPurchases.length > 0) {
      const mediaIds = [...new Set(mediaPurchases.map(p => p.mediaId))]
      try {
        const items = await fetchByIds('mediaListings', 'MediaDetails', mediaIds, F.mediaListingFull)
        for (const m of items) {
          _lruSet(_mediaDetails, m.id, m)
        }
      } catch (e) {
        console.warn('could not fetch media details:', e)
      }
    }

    // get project details for credentials
    const projectIds = [...new Set(credentials.map(c => c.projectId))]
    if (projectIds.length > 0) {
      try {
        const items = await fetchByIds('projects', 'Projects', projectIds, F.projectSummary)
        for (const p of items) {
          _lruSet(_projectMap, p.id, p)
        }
      } catch (e) {
        console.warn('could not fetch project details:', e)
      }
    }
    }

    // annotate relistings — mark superseded media
    if (_mediaDetails.size > 0) {
      annotateRelistings([..._mediaDetails.values()])
    }

    // resolve artist domains from media details
    const artistAddresses = [..._mediaDetails.values()].map(m => m.artist).filter(Boolean)
    _domainMap = await resolveAddresses(query, artistAddresses)

    // fetch cover art + resolve album names
    await fetchCoverArt(mediaPurchases, _domainMap)
    // Pre-group to resolve album names from artist site.json
    const preGroups = []
    const tempAlbumMap = new Map()
    for (const p of mediaPurchases) {
      const cid = _coverArtMap.get(p.mediaId) || ''
      if (cid) {
        if (!tempAlbumMap.has(cid)) tempAlbumMap.set(cid, { items: [], coverCid: cid })
        tempAlbumMap.get(cid).items.push(p)
      }
    }
    for (const g of tempAlbumMap.values()) { if (g.items.length >= 2) preGroups.push(g) }
    if (preGroups.length > 0) await resolveAlbumInfo(preGroups)

    // sort: active listings first, superseded at bottom
    mediaPurchases.sort((a, b) => {
      const aSuperseded = _mediaDetails.get(a.mediaId)?.superseded ? 1 : 0
      const bSuperseded = _mediaDetails.get(b.mediaId)?.superseded ? 1 : 0
      return aSuperseded - bSuperseded
    })

    const contributorCreds = credentials.filter(c => c.tokenType === 3)
    const producerCreds = credentials.filter(c => c.tokenType === 2)
    const allCreds = [...contributorCreds, ...producerCreds]

    // get saved library items
    const savedItems = getSavedLibraryItems(addr)

    if (mediaPurchases.length === 0 && allCreds.length === 0 && savedItems.length === 0 && !_mediaHasMore && !_credsHasMore) {
      contentEl.innerHTML = ''
      statusEl.textContent = t('collection.empty') || 'no items in your collection yet'
      statusEl.style.textAlign = 'center'
      return
    }

    statusEl.textContent = ''

    // Build artist map for sidebar
    _artistMap = new Map()
    for (const purchase of mediaPurchases) {
      const media = _mediaDetails.get(purchase.mediaId)
      if (!media?.artist) continue
      const addr = media.artist.toLowerCase()
      if (!_artistMap.has(addr)) _artistMap.set(addr, { domain: '', mediaCount: 0, credCount: 0 })
      _artistMap.get(addr).mediaCount++
    }
    for (const cred of allCreds) {
      const proposer = _projectMap.get(cred.projectId)?.proposer
      const addr = (proposer || '').toLowerCase()
      if (!addr) continue
      if (!_artistMap.has(addr)) _artistMap.set(addr, { domain: '', mediaCount: 0, credCount: 0 })
      _artistMap.get(addr).credCount++
    }
    for (const [addr, entry] of _artistMap) {
      // Try to get alias name from album cache
      const rawDomain = _domainMap[addr] || ''
      let aliasName = rawDomain
      for (const info of _albumInfoCache.values()) {
        if (info.domain === rawDomain && info.aliasName && info.aliasName !== rawDomain) {
          aliasName = info.aliasName
          break
        }
      }
      entry.domain = aliasName || rawDomain || `${addr.slice(0,6)}...${addr.slice(-4)}`
    }

    // Honor /collection?artist=<domain> so attribution links from
    // elsewhere in the app (album/media cards) land pre-filtered on
    // the current tenant's local collection view.
    try {
      const wantedDomain = new URLSearchParams(location.search).get('artist')?.toLowerCase() || ''
      if (wantedDomain) {
        for (const [addr, entry] of _artistMap) {
          const domain = String(entry.domain || _domainMap[addr] || '').toLowerCase()
          if (domain === wantedDomain) { _selectedArtist = addr; break }
        }
      }
    } catch {}

    let mainHtml = ''

    // filter pills
    const hasMedia = mediaPurchases.length > 0 || _mediaHasMore
    const hasCreds = allCreds.length > 0 || _credsHasMore
    const hasSaved = savedItems.length > 0
    if (hasMedia || hasCreds || hasSaved) {
      mainHtml += `<div class="collection-filters" style="display:flex;gap:0.5ch;margin-bottom:1.5em;flex-wrap:wrap">`
      mainHtml += `<button class="collection-filter active" data-filter="all" style="background:var(--surface);border:1px solid var(--accent);color:var(--accent);font-family:inherit;font-size:0.8em;padding:0.3em 1ch;cursor:pointer;border-radius:2px">all</button>`
      if (hasMedia) mainHtml += `<button class="collection-filter" data-filter="media" style="background:none;border:1px solid var(--border);color:var(--muted);font-family:inherit;font-size:0.8em;padding:0.3em 1ch;cursor:pointer;border-radius:2px">media (${mediaPurchases.length}${_mediaHasMore ? '+' : ''})</button>`
      if (hasCreds) mainHtml += `<button class="collection-filter" data-filter="credentials" style="background:none;border:1px solid var(--border);color:var(--muted);font-family:inherit;font-size:0.8em;padding:0.3em 1ch;cursor:pointer;border-radius:2px">credentials (${allCreds.length}${_credsHasMore ? '+' : ''})</button>`
      const savedPosts = savedItems.filter(i => i.type === 'post')
      const savedLibrary = savedItems.filter(i => i.type !== 'post')
      if (savedLibrary.length > 0) mainHtml += `<button class="collection-filter" data-filter="saved-library" style="background:none;border:1px solid var(--border);color:var(--muted);font-family:inherit;font-size:0.8em;padding:0.3em 1ch;cursor:pointer;border-radius:2px">saved (${savedLibrary.length})</button>`
      if (savedPosts.length > 0) mainHtml += `<button class="collection-filter" data-filter="saved-posts" style="background:none;border:1px solid var(--border);color:var(--muted);font-family:inherit;font-size:0.8em;padding:0.3em 1ch;cursor:pointer;border-radius:2px">posts (${savedPosts.length})</button>`
      mainHtml += `</div>`
    }

    // search input
    mainHtml += `<div id="collection-search" style="margin-bottom:1em">
      <input type="text" id="collection-search-input" placeholder="${t('collection.searchPlaceholder') || 'search collection...'}" class="project-input" style="max-width:400px;width:100%">
    </div>`

    // media section
    if (mediaPurchases.length > 0) {
      mainHtml += `<div class="collection-section" data-section="media">
        <h3>${t('collection.media')}</h3>
        <div class="collection-toolbar">
          <div class="media-sub-filters" style="display:flex;gap:0.5ch;flex-wrap:wrap">
            <button class="media-sub-filter active" data-media-filter="all" style="background:var(--surface);border:1px solid var(--accent);color:var(--accent);font-family:inherit;font-size:0.75em;padding:0.2em 0.8ch;cursor:pointer;border-radius:2px">all</button>
            <button class="media-sub-filter" data-media-filter="audio" style="background:none;border:1px solid var(--border);color:var(--muted);font-family:inherit;font-size:0.75em;padding:0.2em 0.8ch;cursor:pointer;border-radius:2px">audio <span class="media-type-count" data-type-count="audio">(...)</span></button>
            <button class="media-sub-filter" data-media-filter="video" style="background:none;border:1px solid var(--border);color:var(--muted);font-family:inherit;font-size:0.75em;padding:0.2em 0.8ch;cursor:pointer;border-radius:2px">video <span class="media-type-count" data-type-count="video">(...)</span></button>
            <button class="media-sub-filter" data-media-filter="image" style="background:none;border:1px solid var(--border);color:var(--muted);font-family:inherit;font-size:0.75em;padding:0.2em 0.8ch;cursor:pointer;border-radius:2px">image <span class="media-type-count" data-type-count="image">(...)</span></button>
            <button class="media-sub-filter" data-media-filter="other" style="background:none;border:1px solid var(--border);color:var(--muted);font-family:inherit;font-size:0.75em;padding:0.2em 0.8ch;cursor:pointer;border-radius:2px">other <span class="media-type-count" data-type-count="other">(...)</span></button>
          </div>
          <div class="collection-view-toggle">
            <button class="view-toggle-btn ${_viewMode === 'grid' ? 'active' : ''}" data-view="grid"><i class="ph ph-grid-four"></i></button>
            <button class="view-toggle-btn ${_viewMode === 'list' ? 'active' : ''}" data-view="list"><i class="ph ph-list"></i></button>
          </div>
        </div>
        <div class="collection-media ${_viewMode === 'grid' ? 'collection-grid-view' : 'collection-list-view'}" id="collection-media-grid">`
      mainHtml += renderMediaItems(mediaPurchases)
      mainHtml += `</div>`
      if (_mediaHasMore) {
        mainHtml += `<div id="collection-media-sentinel" style="height:1px;margin-top:1em"></div>`
      }
      mainHtml += `</div>`
    }

    // credentials section
    if (allCreds.length > 0) {
      mainHtml += `<div class="collection-section" data-section="credentials">
        <h3>${t('collection.credentials')}</h3>
        <div class="collection-grid" id="collection-creds-grid">`
      mainHtml += renderCredentialItems(allCreds)
      mainHtml += `</div>`
      if (_credsHasMore) {
        mainHtml += `<div id="collection-creds-sentinel" style="height:1px;margin-top:1em"></div>`
      }
      mainHtml += `</div>`
    }

    // saved items — split into library saves and post saves
    const savedPostItems = savedItems.filter(i => i.type === 'post')
    const savedLibraryItems = savedItems.filter(i => i.type !== 'post')

    function renderSavedItem(item) {
      const title = escapeHtml(item.title || 'untitled')
      const author = item.author ? escapeHtml(item.author) : ''
      const savedDate = item.savedAt ? new Date(item.savedAt).toLocaleDateString() : ''
      const href = escapeHtml(item.url || '#')
      return `<div class="collection-item collection-saved-item" data-url="${href}" data-title="${title}" data-author="${author}" data-item-id="${item.id || ''}" style="padding:0.75em;border:1px solid var(--border);border-radius:6px;margin-bottom:0.5em;cursor:pointer">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="color:var(--accent)">${title}</span>
          <span style="color:var(--dim);font-size:0.75em">${savedDate}</span>
        </div>
        ${author ? `<div style="color:var(--muted);font-size:0.85em;margin-top:0.2em">${author}</div>` : ''}
      </div>`
    }

    if (savedLibraryItems.length > 0) {
      mainHtml += `<div class="collection-section" data-section="saved-library" style="display:none">
        <h3>${t('collection.saved')}</h3>
        <div class="collection-grid">${savedLibraryItems.map(renderSavedItem).join('')}</div>
      </div>`
    }
    if (savedPostItems.length > 0) {
      mainHtml += `<div class="collection-section" data-section="saved-posts" style="display:none">
        <h3>saved posts</h3>
        <div class="collection-grid">${savedPostItems.map(renderSavedItem).join('')}</div>
      </div>`
    }

    // Two-column layout: sidebar + main content
    contentEl.innerHTML = `<div class="collection-container">
      <div class="collection-sidebar">
        <input type="text" id="collection-artist-search" placeholder="find in artists" class="project-input">
        <div id="collection-artist-list"></div>
      </div>
      <div class="collection-main">
        <div class="collection-main-header">
          <button id="collection-back" class="collection-back-btn"><i class="ph ph-arrow-left"></i></button>
          <span id="collection-main-title">all</span>
        </div>
        <p style="color:var(--dim);font-size:0.85em;max-width:55ch;margin:0 0 1.5em;line-height:1.5">your collection is <a href="https://vitalik.eth.limo/general/2022/01/26/soulbound.html" target="_blank" style="color:var(--accent)">soulbound</a> — permanently yours, can't be sold or transferred. every purchase, contribution, and collaboration lives here forever. <a href="https://ourpraxis.network/how-it-works#soulbound" target="_blank" style="color:var(--accent)">learn more</a></p>
        <div id="collection-main-content">${mainHtml}</div>
      </div>
    </div>`

    // Render artist sidebar
    renderArtistSidebar()

    // Wire sidebar search
    document.getElementById('collection-artist-search')?.addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase()
      document.querySelectorAll('.collection-artist-item').forEach(el => {
        const name = el.querySelector('span')?.textContent?.toLowerCase() || ''
        el.style.display = !q || name.includes(q) ? '' : 'none'
      })
    })

    // Wire back button (mobile)
    document.getElementById('collection-back')?.addEventListener('click', () => {
      document.querySelector('.collection-container')?.classList.remove('collection-active')
    })

    // store items for search filtering
    _allMediaPurchases = [...mediaPurchases]
    _allCredentials = [...allCreds]
    _allSavedItems = [...savedItems]

    // saved items: posts navigate to post page, library items open media sheet
    contentEl.querySelectorAll('.collection-saved-item').forEach(el => {
      el.addEventListener('click', () => {
        const url = el.dataset.url || ''
        if (url.startsWith('/post?')) {
          window.location.href = url
        } else {
          openMediaSheet({ url, title: el.dataset.title, author: el.dataset.author, itemId: el.dataset.itemId })
        }
      })
    })

    // cache the rendered HTML with medium TTL (only if fully loaded)
    // note: we cache AFTER type detection updates the DOM, see below
    const shouldCache = !_mediaHasMore && !_credsHasMore

    // filter pill handlers
    attachFilterHandlers(contentEl)
    attachMediaSubFilterHandlers(contentEl)

    // view toggle handler
    contentEl.querySelectorAll('.view-toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        _viewMode = btn.dataset.view
        localStorage.setItem('praxis:collection-view', _viewMode)
        contentEl.querySelectorAll('.view-toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.view === _viewMode))
        renderFilteredCollection(contentEl)
      })
    })

    // search filter (debounced)
    attachSearchHandler(contentEl)

    // auto-select tab from URL param (?tab=media or ?tab=credentials)
    const tabParam = new URLSearchParams(window.location.search).get('tab')
    if (tabParam) {
      const tabBtn = contentEl.querySelector(`.collection-filter[data-filter="${tabParam}"]`)
      if (tabBtn) tabBtn.click()
    }

    // infinite scroll observers
    setupInfiniteScroll(contentEl, addr)

    // detect media types in background via batched HEAD requests, then update DOM
    if (mediaPurchases.length > 0) {
      detectMediaTypes(mediaPurchases, contentEl).then(() => {
        if (shouldCache) {
          // M12: cache structured data instead of rendered HTML
          try {
            const dataStr = JSON.stringify({ purchases: mediaPurchases, credentials, mediaCursor: _mediaCursor, mediaHasMore: _mediaHasMore, credsCursor: _credsCursor, credsHasMore: _credsHasMore, mediaDetails: Object.fromEntries(_mediaDetails), projectMap: Object.fromEntries(_projectMap), domainMap: _domainMap })
            if (dataStr.length <= 100 * 1024) setCache(collectionCacheKey, dataStr, TTL.medium)
          } catch {}
        }
      })
    } else if (shouldCache) {
      try {
        const dataStr = JSON.stringify({ purchases: mediaPurchases, credentials, mediaCursor: _mediaCursor, mediaHasMore: _mediaHasMore, credsCursor: _credsCursor, credsHasMore: _credsHasMore, mediaDetails: Object.fromEntries(_mediaDetails), projectMap: Object.fromEntries(_projectMap), domainMap: _domainMap })
        if (dataStr.length <= 100 * 1024) setCache(collectionCacheKey, dataStr, TTL.medium)
      } catch {}
    }

  } catch (e) {
    console.warn('collection load error:', e)
    statusEl.textContent = t('collection.error') || 'could not load collection'
  } finally {
    _collectionLoading = false
  }
}

// Detect media types for all items via batched HEAD requests, tag DOM elements, update counts
async function detectMediaTypes(mediaPurchases, contentEl) {
  // collect unique CIDs that need detection
  const cidToMediaIds = {} // cid -> [mediaId, ...]
  for (const purchase of mediaPurchases) {
    const media = _mediaDetails.get(purchase.mediaId)
    if (!media?.ipfsCid) continue
    const cid = media.ipfsCid
    if (!cidToMediaIds[cid]) cidToMediaIds[cid] = []
    cidToMediaIds[cid].push(purchase.mediaId)

    // use indexed contentType from Ponder if available (skip HEAD request)
    if (!_mediaTypeCache.get(cid) && media.contentType) {
      _lruSet(_mediaTypeCache, cid, classifyContentType(media.contentType))
    }
  }

  // Batch-resolve unknown CIDs via server endpoint (persistent cache, no client HEAD)
  const uniqueCids = Object.keys(cidToMediaIds).filter(cid => !_mediaTypeCache.get(cid))
  if (uniqueCids.length > 0) {
    const resolved = await resolveContentTypes(uniqueCids)
    for (const [cid, ct] of Object.entries(resolved)) {
      _lruSet(_mediaTypeCache, cid, classifyContentType(ct))
    }
  }

  // tag each collection-item with data-media-type + upgrade video cards
  const grid = contentEl.querySelector('#collection-media-grid')
  if (!grid) return

  const items = grid.querySelectorAll('.collection-item[data-media-id]')
  for (const item of items) {
    const mediaId = item.dataset.mediaId
    const media = _mediaDetails.get(mediaId)
    if (!media?.ipfsCid) {
      item.dataset.mediaType = 'other'
      continue
    }
    const type = _mediaTypeCache.get(media.ipfsCid) || 'other'
    item.dataset.mediaType = type

    // Upgrade video cards that were initially rendered as audio/placeholder
    if (type === 'video' && !item.querySelector('.video-lazy')) {
      const cardArt = item.querySelector('.card-art')
      if (cardArt) {
        const mediaUrl = ipfsUrl(media.ipfsCid)
        const title = escapeHtml(media.title || '')
        // Override square aspect-ratio from CSS for widescreen video
        cardArt.style.aspectRatio = '2/1'
        const thumbUrl = `/api/video-thumb?cid=${encodeURIComponent(media.ipfsCid)}&w=600`
        cardArt.innerHTML = `<img src="${thumbUrl}" loading="lazy" alt="${title}" style="width:100%;height:100%;object-fit:cover" onerror="this.style.display='none'"><div class="video-lazy" data-src="${escapeHtml(mediaUrl)}" data-title="${title}" style="position:absolute;inset:0;cursor:pointer"><button class="media-play-overlay media-play-overlay--video"><i class="ph ph-play"></i></button></div>`
        // Remove audio play button if present
        const audioBtn = item.querySelector('.track-play-btn')
        if (audioBtn) audioBtn.remove()
      }
    }
  }

  // update sub-filter counts
  updateMediaSubFilterCounts(contentEl)
}

// Classify a Content-Type string into our type buckets
function classifyContentType(ct) {
  if (!ct) return 'other'
  if (ct.startsWith('audio/')) return 'audio'
  if (ct.startsWith('video/')) return 'video'
  if (ct.startsWith('image/')) return 'image'
  if (ct === 'application/ogg') return 'audio'
  return 'other'
}

// Update the count badges on media sub-filter pills
function updateMediaSubFilterCounts(contentEl) {
  const grid = contentEl.querySelector('#collection-media-grid')
  if (!grid) return

  const counts = { audio: 0, video: 0, image: 0, other: 0 }
  const items = grid.querySelectorAll('.collection-item[data-media-type]')
  for (const item of items) {
    const type = item.dataset.mediaType
    if (counts[type] !== undefined) counts[type]++
    else counts.other++
  }

  for (const type of ['audio', 'video', 'image', 'other']) {
    const span = contentEl.querySelector(`.media-type-count[data-type-count="${type}"]`)
    if (span) span.textContent = `(${counts[type]})`
  }

  // hide sub-filter pills for types with 0 items (but keep "all")
  for (const type of ['audio', 'video', 'image', 'other']) {
    const btn = contentEl.querySelector(`.media-sub-filter[data-media-filter="${type}"]`)
    if (btn) btn.style.display = counts[type] > 0 ? '' : 'none'
  }
}

// Render the artist sidebar from _artistMap
function renderArtistSidebar() {
  const list = document.getElementById('collection-artist-list')
  if (!list) return
  const totalItems = [..._artistMap.values()].reduce((s, a) => s + a.mediaCount + a.credCount, 0)
  let html = `<div class="collection-artist-item ${!_selectedArtist ? 'active' : ''}" data-addr="">
    <span>all</span><span style="color:var(--dim);font-size:0.8em">${totalItems}</span>
  </div>`
  const sorted = [..._artistMap.entries()].sort((a, b) => (b[1].mediaCount + b[1].credCount) - (a[1].mediaCount + a[1].credCount))
  for (const [addr, data] of sorted) {
    const count = data.mediaCount + data.credCount
    html += `<div class="collection-artist-item ${_selectedArtist === addr ? 'active' : ''}" data-addr="${addr}">
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(data.domain)}</span>
      <span style="color:var(--dim);font-size:0.8em;flex-shrink:0">${count}</span>
    </div>`
  }
  list.innerHTML = html
  list.querySelectorAll('.collection-artist-item').forEach(el => {
    el.addEventListener('click', () => {
      _selectedArtist = el.dataset.addr || null
      renderArtistSidebar()
      const contentEl = document.getElementById('collection-content')
      if (contentEl) renderFilteredCollection(contentEl)
      // Update header title
      const titleEl = document.getElementById('collection-main-title')
      if (titleEl) {
        titleEl.textContent = _selectedArtist ? (_artistMap.get(_selectedArtist)?.domain || 'unknown') : 'all'
      }
      // Mobile: show main panel
      document.querySelector('.collection-container')?.classList.add('collection-active')
    })
  })
}

// Re-render the media grid and credentials filtered by _selectedArtist
function renderFilteredCollection(contentEl) {
  // Filter purchases by artist
  const filteredMedia = _selectedArtist
    ? _allMediaPurchases.filter(p => {
        const media = _mediaDetails.get(p.mediaId)
        return media?.artist?.toLowerCase() === _selectedArtist
      })
    : _allMediaPurchases

  // Filter credentials by artist
  const filteredCreds = _selectedArtist
    ? _allCredentials.filter(c => {
        const proj = _projectMap.get(c.projectId)
        return proj?.proposer?.toLowerCase() === _selectedArtist
      })
    : _allCredentials

  // Re-render the media grid
  const grid = document.getElementById('collection-media-grid')
  if (grid) {
    grid.className = `collection-media ${_viewMode === 'grid' ? 'collection-grid-view' : 'collection-list-view'}`
    grid.innerHTML = renderMediaItems(filteredMedia)
    detectMediaTypes(filteredMedia, contentEl)
  }

  // Re-render the credentials grid
  const credsGrid = document.getElementById('collection-creds-grid')
  if (credsGrid) {
    credsGrid.innerHTML = renderCredentialItems(filteredCreds)
  }

  // Show/hide sections based on filtered content
  const mediaSection = contentEl.querySelector('.collection-section[data-section="media"]')
  if (mediaSection) mediaSection.style.display = filteredMedia.length > 0 ? '' : 'none'
  const credsSection = contentEl.querySelector('.collection-section[data-section="credentials"]')
  if (credsSection) credsSection.style.display = filteredCreds.length > 0 ? '' : 'none'

  // Re-apply search filter if active
  if (_searchQuery) applySearchFilter(contentEl)

  // Reset media sub-filter to "all"
  resetMediaSubFilter(contentEl)
}

function attachFilterHandlers(contentEl) {
  contentEl.querySelectorAll('.collection-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      contentEl.querySelectorAll('.collection-filter').forEach(b => {
        b.style.background = 'none'
        b.style.borderColor = 'var(--border)'
        b.style.color = 'var(--muted)'
        b.classList.remove('active')
      })
      btn.style.background = 'var(--surface)'
      btn.style.borderColor = 'var(--accent)'
      btn.style.color = 'var(--accent)'
      btn.classList.add('active')
      const filter = btn.dataset.filter
      contentEl.querySelectorAll('.collection-section').forEach(sec => {
        if (filter === 'all') {
          // hide saved sections from "all" view — only show when explicitly selected
          const s = sec.dataset.section
          sec.style.display = (s === 'saved-library' || s === 'saved-posts') ? 'none' : ''
        } else {
          sec.style.display = sec.dataset.section === filter ? '' : 'none'
        }
      })
      // reset media sub-filter to "all" when switching top-level filters
      if (filter === 'all' || filter === 'media') {
        resetMediaSubFilter(contentEl)
      }
    })
  })
}

function attachMediaSubFilterHandlers(contentEl) {
  contentEl.querySelectorAll('.media-sub-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      // update active state for sub-filter pills
      contentEl.querySelectorAll('.media-sub-filter').forEach(b => {
        b.style.background = 'none'
        b.style.borderColor = 'var(--border)'
        b.style.color = 'var(--muted)'
        b.classList.remove('active')
      })
      btn.style.background = 'var(--surface)'
      btn.style.borderColor = 'var(--accent)'
      btn.style.color = 'var(--accent)'
      btn.classList.add('active')

      const filter = btn.dataset.mediaFilter
      const grid = contentEl.querySelector('#collection-media-grid')
      if (!grid) return

      const items = grid.querySelectorAll('.collection-item[data-media-id]')
      for (const item of items) {
        if (filter === 'all') {
          item.style.display = ''
        } else {
          item.style.display = item.dataset.mediaType === filter ? '' : 'none'
        }
      }
    })
  })
}

// Reset media sub-filter to show all items
function resetMediaSubFilter(contentEl) {
  contentEl.querySelectorAll('.media-sub-filter').forEach(b => {
    const isAll = b.dataset.mediaFilter === 'all'
    b.style.background = isAll ? 'var(--surface)' : 'none'
    b.style.borderColor = isAll ? 'var(--accent)' : 'var(--border)'
    b.style.color = isAll ? 'var(--accent)' : 'var(--muted)'
    if (isAll) b.classList.add('active')
    else b.classList.remove('active')
  })
  const grid = contentEl.querySelector('#collection-media-grid')
  if (grid) {
    grid.querySelectorAll('.collection-item[data-media-id]').forEach(item => {
      item.style.display = ''
    })
  }
}

// Debounced search handler for collection
function attachSearchHandler(contentEl) {
  const input = contentEl.querySelector('#collection-search-input')
  if (!input) return

  let debounceTimer = null
  input.addEventListener('input', () => {
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      _searchQuery = input.value.toLowerCase().trim()
      applySearchFilter(contentEl)
    }, 200)
  })
}

// Apply search filter across all visible items
function applySearchFilter(contentEl) {
  const q = _searchQuery

  // filter media items
  const mediaGrid = contentEl.querySelector('#collection-media-grid')
  if (mediaGrid) {
    mediaGrid.querySelectorAll('.collection-item[data-media-id]').forEach(el => {
      if (!q) { el.style.display = ''; return }
      const mediaId = el.dataset.mediaId
      const media = _mediaDetails.get(mediaId)
      const title = (media?.title || '').toLowerCase()
      const artist = media ? (resolveDomain(_domainMap, media.artist) || '').toLowerCase() : ''
      el.style.display = (title.includes(q) || artist.includes(q)) ? '' : 'none'
    })
  }

  // filter credential items
  const credsGrid = contentEl.querySelector('#collection-creds-grid')
  if (credsGrid) {
    credsGrid.querySelectorAll('.collection-item').forEach(el => {
      if (!q) { el.style.display = ''; return }
      const titleEl = el.querySelector('.collection-item-title a')
      const title = (titleEl?.textContent || '').toLowerCase()
      const roleEl = el.querySelector('.credential-role')
      const role = (roleEl?.textContent || '').toLowerCase()
      el.style.display = (title.includes(q) || role.includes(q)) ? '' : 'none'
    })
  }

  // filter saved items
  const savedGrid = contentEl.querySelector('#collection-saved-grid')
  if (savedGrid) {
    savedGrid.querySelectorAll('.collection-saved-item').forEach(el => {
      if (!q) { el.style.display = ''; return }
      const title = (el.dataset.title || '').toLowerCase()
      const author = (el.dataset.author || '').toLowerCase()
      el.style.display = (title.includes(q) || author.includes(q)) ? '' : 'none'
    })
  }
}

// IntersectionObserver-based infinite scroll for media and credentials
function setupInfiniteScroll(contentEl, addr) {
  // clean up previous observers
  if (_mediaObserver) _mediaObserver.disconnect()
  if (_credsObserver) _credsObserver.disconnect()

  const mediaSentinel = contentEl.querySelector('#collection-media-sentinel')
  if (mediaSentinel && _mediaHasMore) {
    _mediaObserver = new IntersectionObserver(async (entries) => {
      if (!entries[0].isIntersecting || _mediaLoadingMore || !_mediaHasMore || !_mediaCursor) return
      _mediaLoadingMore = true
      try {
        const result = await getCollection(addr, _mediaCursor)
        _mediaCursor = result.cursor
        _mediaHasMore = result.hasMore

        if (result.items.length > 0) {
          const newIds = [...new Set(result.items.map(p => p.mediaId).filter(id => !_mediaDetails.has(id)))]
          if (newIds.length > 0) {
            try {
              const items = await fetchByIds('mediaListings', 'MediaDetails', newIds, F.mediaListingFull)
              for (const m of items) _lruSet(_mediaDetails, m.id, m)
            } catch (e) { console.warn('media details:', e) }
          }
          await fetchCoverArt(result.items, _domainMap)
          _allMediaPurchases.push(...result.items)
          if (_allMediaPurchases.length > 2000) _allMediaPurchases = _allMediaPurchases.slice(-2000)
          const grid = contentEl.querySelector('#collection-media-grid')
          if (grid) {
            grid.insertAdjacentHTML('beforeend', renderMediaItems(result.items))
            detectMediaTypes(result.items, contentEl)
            // re-apply search filter to new items
            if (_searchQuery) applySearchFilter(contentEl)
          }
        }

        if (!_mediaHasMore) {
          _mediaObserver.disconnect()
          mediaSentinel.remove()
        }
      } catch (e) {
        console.warn('infinite scroll media error:', e)
      } finally {
        _mediaLoadingMore = false
      }
    }, { rootMargin: '200px' })
    _mediaObserver.observe(mediaSentinel)
  }

  const credsSentinel = contentEl.querySelector('#collection-creds-sentinel')
  if (credsSentinel && _credsHasMore) {
    _credsObserver = new IntersectionObserver(async (entries) => {
      if (!entries[0].isIntersecting || _credsLoadingMore || !_credsHasMore || !_credsCursor) return
      _credsLoadingMore = true
      try {
        const result = await fetchCredentialsPage(addr.toLowerCase(), _credsCursor)
        _credsCursor = result.cursor
        _credsHasMore = result.hasMore

        const newProjIds = [...new Set(result.items.map(c => c.projectId).filter(id => !_projectMap.get(id)))]
        if (newProjIds.length > 0) {
          try {
            const items = await fetchByIds('projects', 'Projects', newProjIds, F.projectSummary)
            for (const p of items) _lruSet(_projectMap, p.id, p)
          } catch (e) { console.warn('project details:', e) }
        }

        const contributorCreds = result.items.filter(c => c.tokenType === 3)
        const producerCreds = result.items.filter(c => c.tokenType === 2)
        const newCreds = [...contributorCreds, ...producerCreds]
        _allCredentials.push(...newCreds)

        if (newCreds.length > 0) {
          const grid = contentEl.querySelector('#collection-creds-grid')
          if (grid) {
            grid.insertAdjacentHTML('beforeend', renderCredentialItems(newCreds))
            if (_searchQuery) applySearchFilter(contentEl)
          }
        }

        if (!_credsHasMore) {
          _credsObserver.disconnect()
          credsSentinel.remove()
        }
      } catch (e) {
        console.warn('infinite scroll creds error:', e)
      } finally {
        _credsLoadingMore = false
      }
    }, { rootMargin: '200px' })
    _credsObserver.observe(credsSentinel)
  }
}

// Fetch a single page of credentials
async function fetchCredentialsPage(holder, cursor) {
  const data = await query(`
    query CollectionCreds($holder: String!, $after: String) {
      credentials(where: { holder: $holder }, limit: 50, after: $after) {
        items { ${F.credential} }
        ${F.pageInfo}
      }
    }
  `, { holder, after: cursor })
  return {
    items: data.credentials?.items || [],
    cursor: data.credentials?.pageInfo?.endCursor || null,
    hasMore: data.credentials?.pageInfo?.hasNextPage || false,
  }
}

// Fetch items by ID (single page — sufficient for detail lookups)
async function fetchByIds(entityName, queryName, ids, fields) {
  const batches = []
  for (let i = 0; i < ids.length; i += 100) batches.push(ids.slice(i, i + 100))
  const results = await Promise.all(batches.map(batch => query(`
    query ${queryName}($ids: [BigInt!]!) {
      ${entityName}(where: { id_in: $ids }, limit: 100) {
        items { ${fields} }
      }
    }
  `, { ids: batch })))
  return results.flatMap(data => data[entityName]?.items || [])
}

// Resolve album names + paths from artist site.json for grouped purchases
async function resolveAlbumInfo(albums) {
  const domainFetches = new Map() // domain -> promise
  // First pass: resolve domains and kick off fetches
  for (const album of albums) {
    const first = album.items[0]
    const media = _mediaDetails.get(first.mediaId)
    const artistAddr = media?.artist?.toLowerCase() || ''
    const domain = _domainMap[artistAddr] || ''
    album._domain = domain // stash for matching
    if (!domain || !domain.includes('.') || _artistSiteCache.has(domain)) continue
    if (!domainFetches.has(domain)) {
      // Proxy through our server to avoid CSP cross-origin restrictions
      domainFetches.set(domain, fetch(`/api/artist-site?domain=${encodeURIComponent(domain)}`).then(r => r.ok ? r.json() : null).catch(() => null))
    }
  }
  for (const [domain, promise] of domainFetches) {
    const data = await promise
    if (data) _lruSet(_artistSiteCache, domain, data)
  }
  // Match albums to site.json data
  for (const album of albums) {
    if (_albumInfoCache.has(album.coverCid)) continue
    const domain = album._domain || ''
    const siteData = _lruGet(_artistSiteCache, domain)
    if (!siteData?.modules) continue
    const trackTitles = new Set(album.items.map(p => (_mediaDetails.get(p.mediaId)?.title || '').toLowerCase()).filter(Boolean))
    for (let mi = 0; mi < siteData.modules.length; mi++) {
      const mod = siteData.modules[mi]
      if (mod.type !== 'music') continue
      for (let ai = 0; ai < (mod.data?.aliases || []).length; ai++) {
        const alias = mod.data.aliases[ai]
        for (let bi = 0; bi < (alias.albums || []).length; bi++) {
          const alb = alias.albums[bi]
          const albumTracks = (alb.tracks || []).map(t => (t.title || '').toLowerCase()).filter(Boolean)
          const matches = albumTracks.filter(t => trackTitles.has(t)).length
          if (matches >= Math.min(trackTitles.size, albumTracks.length) * 0.5 && matches >= 2) {
            _lruSet(_albumInfoCache, album.coverCid, { name: alb.title || '', path: { alias: ai, album: bi }, aliasName: alias.name || domain, domain })
          }
        }
      }
    }
  }
}

// Map the cached collection media-type ('audio' / 'video' / 'other')
// to a MediaCard content category. For 'other' items we rely on the
// contentType the server now attaches server-side.
function collectionTypeToCategory(cachedType, contentType) {
  if (cachedType === 'audio' || cachedType === 'video') return cachedType
  if (contentType?.startsWith('image/')) return 'image'
  if (contentType === 'application/pdf' || contentType?.startsWith('text/')) return 'document'
  if (contentType?.startsWith('audio/') || contentType === 'application/ogg') return 'audio'
  if (contentType?.startsWith('video/')) return 'video'
  return 'other'
}

function renderMediaItems(mediaPurchases) {
  // Group by shared cover art CID (album grouping).
  const albumGroups = new Map()
  const singles = []
  for (const purchase of mediaPurchases) {
    const coverCid = _coverArtMap.get(purchase.mediaId) || ''
    if (coverCid) {
      if (!albumGroups.has(coverCid)) albumGroups.set(coverCid, { items: [], coverCid })
      albumGroups.get(coverCid).items.push(purchase)
    } else {
      singles.push(purchase)
    }
  }
  // Groups with 2+ items are albums; singletons fall back into the
  // flat singles list.
  const albums = []
  for (const [, group] of albumGroups) {
    if (group.items.length >= 2) albums.push(group)
    else singles.push(...group.items)
  }

  let html = ''

  // ── Albums ──────────────────────────────────────────────────
  for (const album of albums) {
    const first = album.items[0]
    const firstMedia = _mediaDetails.get(first.mediaId) || {}
    const artistDomain = firstMedia.artist ? resolveDomain(_domainMap, firstMedia.artist) : ''
    const sorted = [...album.items].sort((a, b) => {
      try { return Number(BigInt(a.mediaId) - BigInt(b.mediaId)) } catch { return 0 }
    })
    const info = _lruGet(_albumInfoCache, album.coverCid) || {}
    const albumName = info.name || `${sorted.length} tracks`
    const aliasName = info.aliasName || artistDomain
    // Local-tenant detail link — carries album + alias + artist so /art
    // can hydrate an in-house album detail page instead of bouncing to
    // the source artist's own site.
    const albumLink = (info.aliasName && info.name)
      ? `/art?media=${first.mediaId}&album=${encodeURIComponent(info.name)}&alias=${encodeURIComponent(info.aliasName)}&artist=${encodeURIComponent(artistDomain)}`
      : `/art?media=${first.mediaId}`
    const authorHref = artistDomain ? `/collection?artist=${encodeURIComponent(artistDomain)}` : null

    const albumItem = {
      mediaId: `album-${album.coverCid}`,
      title: albumName,
      headline: albumName,
      aliasName,
      metadataCid: album.coverCid,
      artist: firstMedia.artist || '',
      count: sorted.length,
      items: sorted.map(p => {
        const m = _mediaDetails.get(p.mediaId) || {}
        return {
          mediaId: p.mediaId,
          title: m.title || `#${p.mediaId}`,
          price: m.price || '0',
          ipfsCid: m.ipfsCid || '',
          contentType: m.contentType || '',
          metadataCid: m.metadataCid || album.coverCid,
        }
      }),
    }
    html += renderMediaCard(albumItem, {
      layout: 'album',
      category: 'audio',
      linkTo: albumLink,
      authorHref,
      resolve: addr => resolveDomain(_domainMap, addr) || addr,
      owned: true,
      actions: ['play-all', 'download'],
      extraClasses: 'collection-item collection-album-card',
      extraDataAttrs: { 'media-type': 'audio', span: '2' },
    })
  }

  // ── Singles ─────────────────────────────────────────────────
  for (const purchase of singles) {
    const media = _mediaDetails.get(purchase.mediaId) || {}
    const artistDomain = media.artist ? resolveDomain(_domainMap, media.artist) : ''
    const coverCid = _coverArtMap.get(purchase.mediaId) || ''
    const cachedType = media.ipfsCid
      ? (_mediaTypeCache.get(media.ipfsCid) || (media.contentType?.startsWith('video/') ? 'video' : 'audio'))
      : 'other'
    const category = collectionTypeToCategory(cachedType, media.contentType)
    const isSuperseded = media.superseded === true
    const linkTo = isSuperseded && media.activeListingId
      ? `/art?media=${media.activeListingId}`
      : `/art?media=${purchase.mediaId}`
    const authorHref = artistDomain ? `/collection?artist=${encodeURIComponent(artistDomain)}` : null

    const singleItem = {
      mediaId: purchase.mediaId,
      title: media.title || `#${purchase.mediaId}`,
      price: media.price || '0',
      ipfsCid: media.ipfsCid || '',
      contentType: media.contentType || '',
      metadataCid: coverCid || media.metadataCid || '',
      artist: media.artist || '',
      aliasName: artistDomain,
      superseded: isSuperseded,
      activeListingId: media.activeListingId,
    }

    const layout = _viewMode === 'grid'
      ? (category === 'video' ? 'wide' : 'square')
      : 'row'
    const renderer = layout === 'row' ? renderMediaCardRow : renderMediaCard
    html += renderer(singleItem, {
      layout,
      category,
      state: isSuperseded ? 'superseded' : null,
      linkTo,
      authorHref,
      resolve: addr => resolveDomain(_domainMap, addr) || addr,
      owned: true,
      extraClasses: 'collection-item',
      extraDataAttrs: { 'media-type': cachedType },
    })
  }
  return html
}

function renderCredentialItems(allCreds) {
  // projectType is now a string directly from the contract
  let html = ''
  for (const cred of allCreds) {
    const proj = _projectMap.get(cred.projectId)
    const title = proj ? escapeHtml(proj.title) : `project #${cred.projectId}`
    const type = proj ? (proj.projectType || '') : ''
    const role = cred.tokenType === 3 ? 'contributor' : 'producer'

    html += `<div class="collection-item">
      <div class="collection-item-title">
        <a href="/project?id=${cred.projectId}" style="color:var(--fg)">${title}</a>
      </div>
      <div class="collection-item-meta">
        <span class="credential-role" style="color:var(--accent)">${role}</span>
        ${type ? `<span class="credential-type" style="color:var(--muted);margin-left:0.5ch">${type}</span>` : ''}
      </div>
    </div>`
  }
  return html
}

// fetch cover art: batch all media(id) reads via multicall, then parallel site.json lookups
async function fetchCoverArt(mediaPurchases, domainMap) {
  const mediaAddr = document.body.dataset.media
  if (!mediaAddr || mediaPurchases.length === 0) return

  try {
    const pc = await getPublicClient()
    const mediaAbi = [{ name: 'media', type: 'function', inputs: [{ name: 'mediaId', type: 'uint256' }], outputs: [{ name: 'artist', type: 'address' }, { name: 'title', type: 'string' }, { name: 'ipfsCid', type: 'string' }, { name: 'metadataCid', type: 'string' }, { name: 'price', type: 'uint256' }, { name: 'maxSupply', type: 'uint256' }, { name: 'totalMinted', type: 'uint256' }], stateMutability: 'view' }]
    const uniqueIds = [...new Set(mediaPurchases.map(p => p.mediaId).filter(id => !_coverArtMap.get(id)))]
    if (uniqueIds.length === 0) return

    const calls = uniqueIds.map(id => ({
      address: mediaAddr,
      abi: mediaAbi,
      functionName: 'media',
      args: [BigInt(id)],
    }))
    const multicallResults = []
    for (let i = 0; i < calls.length; i += 50) {
      const chunk = calls.slice(i, i + 50)
      const results = await pc.multicall({ contracts: chunk, allowFailure: true })
      multicallResults.push(...results)
    }

    const siteFallbacks = new Map()
    for (let i = 0; i < uniqueIds.length; i++) {
      const result = multicallResults[i]
      if (result.status !== 'success') continue
      const [artist, , trackCid, metadataCid] = result.result
      const id = uniqueIds[i]
      if (metadataCid) {
        _lruSet(_coverArtMap, id, metadataCid)
      } else {
        const artistDom = domainMap[artist.toLowerCase()]
        if (artistDom) {
          if (!siteFallbacks.has(artistDom)) siteFallbacks.set(artistDom, [])
          siteFallbacks.get(artistDom).push({ id, trackCid })
        }
      }
    }

    if (siteFallbacks.size > 0) {
      const siteEntries = [...siteFallbacks.entries()]
      // concurrency-limited site.json fetches (max 5 parallel)
      const SITE_CONCURRENCY = 5
      const siteResults = []
      for (let i = 0; i < siteEntries.length; i += SITE_CONCURRENCY) {
        const batch = siteEntries.slice(i, i + SITE_CONCURRENCY)
        const batchResults = await Promise.all(
          batch.map(([domain]) =>
            fetch(`/api/proxy-site?domain=${encodeURIComponent(domain)}`).then(r => r.json()).catch(() => null)
          )
        )
        siteResults.push(...batchResults)
      }
      for (let s = 0; s < siteEntries.length; s++) {
        const siteData = siteResults[s]
        if (!siteData) continue
        const items = siteEntries[s][1]
        for (const { id, trackCid } of items) {
          for (const mod of (siteData.modules || [])) {
            if (mod.type !== 'music') continue
            for (const alias of (mod.data?.aliases || [])) {
              for (const album of (alias.albums || [])) {
                for (const track of (album.tracks || [])) {
                  if (track.src?.includes(trackCid)) {
                    const artMatch = album.art?.match(/ipfs-proxy\/([A-Za-z0-9]+)/)
                    if (artMatch) _lruSet(_coverArtMap, id, artMatch[1])
                  }
                }
              }
            }
          }
        }
      }
    }
  } catch (e) { console.warn('cover art fetch:', e) }
}
