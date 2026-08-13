// Collection page — shows soulbound tokens and credentials for connected wallet
import { F } from './fragments.js'
import { query } from './ponder.js'
import { ipfsUrl, escapeHtml, resolveAddresses, resolveDomain, renderMedia, getPublicClient , formatEthAmount, registerPage, openMediaSheet, artPlaceholder, resolveContentTypes, classifyContentType as classifyCT, slugify } from './utils.js'
import { t } from './i18n.js'
import { getCollection, annotateRelistings } from './media.js'
import { getCached, setCache, TTL } from './cache.js'

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
  let all = []
  const remaining = [...ids]
  while (remaining.length > 0) {
    const batch = remaining.splice(0, 100)
    const data = await query(`
      query ${queryName}($ids: [BigInt!]!) {
        ${entityName}(where: { id_in: $ids }, limit: 100) {
          items { ${fields} }
        }
      }
    `, { ids: batch })
    all.push(...(data[entityName]?.items || []))
  }
  return all
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

function renderMediaItems(mediaPurchases) {
  // Group by shared cover art CID (album grouping)
  const albumGroups = new Map() // coverCid -> { items, artistDomain, coverUrl }
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
  // Split: groups with 2+ items = albums, rest = singles
  const albums = []
  for (const [cid, group] of albumGroups) {
    if (group.items.length >= 2) {
      albums.push(group)
    } else {
      singles.push(...group.items)
    }
  }

  let html = ''

  // Render albums
  for (const album of albums) {
    const first = album.items[0]
    const media = _mediaDetails.get(first.mediaId)
    const artistDomain = media ? resolveDomain(_domainMap, media.artist) : ''
    const artistLink = `https://${escapeHtml(artistDomain)}`
    const coverUrl = ipfsUrl(album.coverCid)
    const sorted = [...album.items].sort((a, b) => { try { return Number(BigInt(a.mediaId) - BigInt(b.mediaId)) } catch { return 0 } })
    const trackCount = sorted.length

    // Album name + path from site.json resolution
    const info = _lruGet(_albumInfoCache, album.coverCid) || {}
    const albumName = info.name || `${trackCount} tracks`
    const aliasName = info.aliasName || artistDomain
    const albumPath = info.path
    const albumLink = (info.aliasName && info.name) ? `https://${escapeHtml(artistDomain)}/music/${slugify(info.aliasName)}/${slugify(info.name)}` : `/art?media=${first.mediaId}`

    // Build play-all queue
    const queueTracks = sorted.filter(p => _mediaDetails.get(p.mediaId)?.ipfsCid).map(p => {
      const m = _mediaDetails.get(p.mediaId)
      return { src: ipfsUrl(m.ipfsCid), title: m.title || '', artist: aliasName, art: `/api/img?url=${encodeURIComponent(coverUrl)}&w=200` }
    })
    const queueData = encodeURIComponent(JSON.stringify(queueTracks))

    if (_viewMode === 'grid') {
      html += `<div class="collection-card collection-album-card collection-item" data-media-id="${escapeHtml(String(first.mediaId))}" data-media-type="audio" data-span="2">
        <div class="card-art">
          <a href="${albumLink}"><img loading="lazy" src="/api/img?url=${encodeURIComponent(coverUrl)}&w=400" style="border-radius:6px"></a>
          <span class="card-type-badge">${trackCount} tracks</span>
        </div>
        <div class="card-info">
          <a href="${albumLink}" class="card-title">${escapeHtml(albumName)}</a>
          <a href="${artistLink}" class="card-artist">${escapeHtml(aliasName)}</a>
          <div class="card-actions">
            <button class="album-play-btn" data-queue="${queueData}" style="background:none;border:1px solid var(--border);color:var(--fg);width:24px;height:24px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:0.7em"><i class="ph ph-play"></i></button>
            <a href="${escapeHtml(queueTracks[0]?.src || '#')}" download="${escapeHtml(albumName)}" style="color:var(--dim);font-size:0.9em"><i class="ph ph-download-simple"></i></a>
          </div>
        </div>
      </div>`
    } else {
      // Album in list view — iTunes style
      html += `<div class="collection-album-list collection-item" data-media-id="${escapeHtml(String(first.mediaId))}" data-media-type="audio">
        <div class="album-list-header">
          <a href="${albumLink}"><img loading="lazy" src="/api/img?url=${encodeURIComponent(coverUrl)}&w=200" class="album-list-art"></a>
          <div class="album-list-info">
            <a href="${albumLink}" style="color:var(--fg);font-weight:600;text-decoration:none;font-size:1em">${escapeHtml(albumName)}</a>
            <a href="${artistLink}" class="card-artist">${escapeHtml(aliasName)}</a>
            <div style="display:flex;gap:0.5ch;margin-top:0.4em;align-items:center">
              <button class="album-play-btn" data-queue="${queueData}" style="background:none;border:1px solid var(--border);color:var(--fg);font-size:0.75em;padding:0.25em 0.8ch;cursor:pointer;display:inline-flex;align-items:center;gap:0.3ch"><i class="ph ph-play"></i> play all</button>
              <span style="color:var(--dim);font-size:0.75em">${trackCount} tracks</span>
            </div>
          </div>
        </div>
        <div class="album-tracklist">`
      for (let i = 0; i < sorted.length; i++) {
        const p = sorted[i]
        const m = _mediaDetails.get(p.mediaId)
        const trackTitle = m ? escapeHtml(m.title) : `#${p.mediaId}`
        const trackUrl = m?.ipfsCid ? ipfsUrl(m.ipfsCid) : ''
        html += `<div class="album-track">
          <span class="track-num">${i + 1}</span>
          ${trackUrl ? `<button class="track-play-btn" data-track-src="${escapeHtml(trackUrl)}" data-track-title="${trackTitle}" data-track-artist="${escapeHtml(aliasName)}" style="background:none;border:1px solid var(--border);color:var(--fg);width:22px;height:22px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:0.6em;flex-shrink:0"><i class="ph ph-play"></i></button>` : '<span style="width:22px"></span>'}
          <span class="track-title">${trackTitle}</span>
          <div style="display:flex;gap:0.5ch;align-items:center;flex-shrink:0;margin-left:auto;padding-right:0.5em">
            ${trackUrl ? `<button class="track-queue-btn" data-src="${escapeHtml(trackUrl)}" data-title="${trackTitle}" data-artist="${escapeHtml(aliasName)}" data-art="${escapeHtml(queueTracks[0]?.art || '')}" style="background:none;border:none;color:var(--dim);font-size:0.85em;cursor:pointer;padding:0.15em" title="add to queue"><i class="ph ph-plus"></i></button>` : ''}
            ${trackUrl ? `<a href="${escapeHtml(trackUrl)}" download="${trackTitle}" style="color:var(--dim);font-size:0.85em;padding:0.15em" title="download"><i class="ph ph-download-simple"></i></a>` : ''}
          </div>
        </div>`
      }
      html += `</div></div>`
    }
  }

  // Render singles
  for (const purchase of singles) {
    const media = _mediaDetails.get(purchase.mediaId)
    const title = media ? escapeHtml(media.title) : `#${purchase.mediaId}`
    const artistDomain = media ? resolveDomain(_domainMap, media.artist) : ''
    const artistLink = `https://${escapeHtml(artistDomain)}`
    const mediaUrl = media?.ipfsCid ? ipfsUrl(media.ipfsCid) : ''
    const coverCid = _coverArtMap.get(purchase.mediaId) || ''
    const coverUrl = coverCid ? ipfsUrl(coverCid) : ''
    const cachedType = media?.ipfsCid ? (_mediaTypeCache.get(media.ipfsCid) || (media.contentType?.startsWith('video/') ? 'video' : 'audio')) : 'other'
    const isSuperseded = media?.superseded === true
    const artDetailUrl = isSuperseded ? `/art?media=${media.activeListingId}` : `/art?media=${purchase.mediaId}`
    const escapedArtist = escapeHtml(artistDomain || '')

    if (_viewMode === 'grid') {
      const isVideo = cachedType === 'video'
      // Art content + play overlay matching feed card pattern
      let artInner = ''
      let playOverlay = ''
      if (isVideo && mediaUrl) {
        const posterUrl = coverUrl
          ? `/api/img?url=${encodeURIComponent(coverUrl)}&w=400`
          : media?.ipfsCid ? `/api/video-thumb?cid=${encodeURIComponent(media.ipfsCid)}&w=600` : ''
        const posterImg = posterUrl ? `<img loading="lazy" src="${posterUrl}" alt="${title}" style="width:100%;height:100%;object-fit:cover" onerror="this.style.display='none'">` : ''
        artInner = `${posterImg}<div class="video-lazy" data-src="${escapeHtml(mediaUrl)}" data-title="${title}" style="position:absolute;inset:0;cursor:pointer"><button class="media-play-overlay media-play-overlay--video"><i class="ph ph-play"></i></button></div>`
      } else {
        artInner = `<a href="${artDetailUrl}">${coverUrl ? `<img loading="lazy" src="/api/img?url=${encodeURIComponent(coverUrl)}&w=400">` : artPlaceholder(title, 180)}</a>`
        if (mediaUrl && !isSuperseded && !isVideo) {
          playOverlay = `<button class="track-play-btn media-play-overlay" data-track-src="${escapeHtml(mediaUrl)}" data-track-title="${title}" data-track-artist="${escapedArtist}"><i class="ph ph-play"></i></button>`
        }
      }
      const artStyle = isVideo ? ' style="aspect-ratio:2/1"' : ''
      html += `<div class="collection-card collection-item${isSuperseded ? ' media-superseded' : ''}" data-media-id="${escapeHtml(String(purchase.mediaId))}" data-media-type="${escapeHtml(cachedType)}"${isSuperseded ? ' style="opacity:0.5"' : ''}>
        <div class="card-art"${artStyle}>${artInner}${playOverlay}</div>
        <div class="card-info">
          <a href="${artDetailUrl}" class="card-title">${title}</a>
          <a href="${artistLink}" class="card-artist">${escapedArtist}</a>
          <div class="card-actions">
            ${mediaUrl && !isSuperseded ? `<a href="${escapeHtml(mediaUrl)}" download="${title}" style="color:var(--dim);font-size:0.9em"><i class="ph ph-download-simple"></i></a>` : ''}
          </div>
        </div>
      </div>`
    } else {
      html += `<div class="collection-row collection-item${isSuperseded ? ' media-superseded' : ''}" data-media-id="${escapeHtml(String(purchase.mediaId))}" data-media-type="${escapeHtml(cachedType)}"${isSuperseded ? ' style="opacity:0.5"' : ''}>
        <a href="${artDetailUrl}" class="row-art">${coverUrl ? `<img loading="lazy" src="/api/img?url=${encodeURIComponent(coverUrl)}&w=120">` : artPlaceholder(title, 48)}</a>
        <div class="row-info">
          <a href="${artDetailUrl}" class="card-title">${title}</a>
          <a href="${artistLink}" class="card-artist">${escapedArtist}</a>
        </div>
        <div class="card-actions">
          ${mediaUrl && !isSuperseded ? `<button class="track-play-btn" data-track-src="${escapeHtml(mediaUrl)}" data-track-title="${title}" data-track-artist="${escapedArtist}" style="background:none;border:1px solid var(--border);color:var(--fg);width:22px;height:22px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:0.6em"><i class="ph ph-play"></i></button><a href="${escapeHtml(mediaUrl)}" download="${title}" class="track-dl"><i class="ph ph-download-simple"></i></a>` : ''}
        </div>
      </div>`
    }
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
