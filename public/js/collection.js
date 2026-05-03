// Collection page — shows soulbound tokens and credentials for connected wallet
import { F } from './fragments.js'
import { query } from './ponder.js'
import { ipfsUrl, escapeHtml, resolveAddresses, resolveDomain, renderMedia, getPublicClient , formatEthAmount, registerPage, openMediaSheet, artPlaceholder } from './utils.js'
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
let _mediaDetails = {}
let _projectMap = {}
let _coverArtMap = {}
const _mediaTypeCache = {}
let _mediaLoadingMore = false
let _credsLoadingMore = false
let _allMediaPurchases = []
let _allCredentials = []
let _allSavedItems = []
let _searchQuery = ''
let _mediaObserver = null
let _credsObserver = null

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
  _mediaDetails = {}
  _projectMap = {}
  _coverArtMap = {}
  _mediaLoadingMore = false
  _credsLoadingMore = false
  _allMediaPurchases = []
  _allCredentials = []
  _allSavedItems = []
  _searchQuery = ''
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
        _mediaDetails = parsed.mediaDetails || {}
        _projectMap = parsed.projectMap || {}
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
          _mediaDetails[m.id] = m
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
          _projectMap[p.id] = p
        }
      } catch (e) {
        console.warn('could not fetch project details:', e)
      }
    }
    }

    // annotate relistings — mark superseded media
    if (Object.keys(_mediaDetails).length > 0) {
      annotateRelistings(Object.values(_mediaDetails))
    }

    // resolve artist domains from media details
    const artistAddresses = Object.values(_mediaDetails).map(m => m.artist).filter(Boolean)
    _domainMap = await resolveAddresses(query, artistAddresses)

    // fetch cover art
    await fetchCoverArt(mediaPurchases, _domainMap)

    // sort: active listings first, superseded at bottom
    mediaPurchases.sort((a, b) => {
      const aSuperseded = _mediaDetails[a.mediaId]?.superseded ? 1 : 0
      const bSuperseded = _mediaDetails[b.mediaId]?.superseded ? 1 : 0
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
    let html = ''

    // filter pills
    const hasMedia = mediaPurchases.length > 0 || _mediaHasMore
    const hasCreds = allCreds.length > 0 || _credsHasMore
    const hasSaved = savedItems.length > 0
    if (hasMedia || hasCreds || hasSaved) {
      html += `<div class="collection-filters" style="display:flex;gap:0.5ch;margin-bottom:1.5em;flex-wrap:wrap">`
      html += `<button class="collection-filter active" data-filter="all" style="background:var(--surface);border:1px solid var(--accent);color:var(--accent);font-family:inherit;font-size:0.8em;padding:0.3em 1ch;cursor:pointer;border-radius:2px">all</button>`
      if (hasMedia) html += `<button class="collection-filter" data-filter="media" style="background:none;border:1px solid var(--border);color:var(--muted);font-family:inherit;font-size:0.8em;padding:0.3em 1ch;cursor:pointer;border-radius:2px">media (${mediaPurchases.length}${_mediaHasMore ? '+' : ''})</button>`
      if (hasCreds) html += `<button class="collection-filter" data-filter="credentials" style="background:none;border:1px solid var(--border);color:var(--muted);font-family:inherit;font-size:0.8em;padding:0.3em 1ch;cursor:pointer;border-radius:2px">credentials (${allCreds.length}${_credsHasMore ? '+' : ''})</button>`
      const savedPosts = savedItems.filter(i => i.type === 'post')
      const savedLibrary = savedItems.filter(i => i.type !== 'post')
      if (savedLibrary.length > 0) html += `<button class="collection-filter" data-filter="saved-library" style="background:none;border:1px solid var(--border);color:var(--muted);font-family:inherit;font-size:0.8em;padding:0.3em 1ch;cursor:pointer;border-radius:2px">saved (${savedLibrary.length})</button>`
      if (savedPosts.length > 0) html += `<button class="collection-filter" data-filter="saved-posts" style="background:none;border:1px solid var(--border);color:var(--muted);font-family:inherit;font-size:0.8em;padding:0.3em 1ch;cursor:pointer;border-radius:2px">posts (${savedPosts.length})</button>`
      html += `</div>`
    }

    // search input
    html += `<div id="collection-search" style="margin-bottom:1.5em">
      <input type="text" id="collection-search-input" placeholder="${t('collection.searchPlaceholder') || 'search collection...'}" class="project-input" style="max-width:400px;width:100%">
    </div>`

    // media section
    if (mediaPurchases.length > 0) {
      html += `<div class="collection-section" data-section="media">
        <h3>${t('collection.media')}</h3>
        <div class="media-sub-filters" style="display:flex;gap:0.5ch;margin-bottom:1em;flex-wrap:wrap">
          <button class="media-sub-filter active" data-media-filter="all" style="background:var(--surface);border:1px solid var(--accent);color:var(--accent);font-family:inherit;font-size:0.75em;padding:0.2em 0.8ch;cursor:pointer;border-radius:2px">all</button>
          <button class="media-sub-filter" data-media-filter="audio" style="background:none;border:1px solid var(--border);color:var(--muted);font-family:inherit;font-size:0.75em;padding:0.2em 0.8ch;cursor:pointer;border-radius:2px">audio <span class="media-type-count" data-type-count="audio">(...)</span></button>
          <button class="media-sub-filter" data-media-filter="video" style="background:none;border:1px solid var(--border);color:var(--muted);font-family:inherit;font-size:0.75em;padding:0.2em 0.8ch;cursor:pointer;border-radius:2px">video <span class="media-type-count" data-type-count="video">(...)</span></button>
          <button class="media-sub-filter" data-media-filter="image" style="background:none;border:1px solid var(--border);color:var(--muted);font-family:inherit;font-size:0.75em;padding:0.2em 0.8ch;cursor:pointer;border-radius:2px">image <span class="media-type-count" data-type-count="image">(...)</span></button>
          <button class="media-sub-filter" data-media-filter="other" style="background:none;border:1px solid var(--border);color:var(--muted);font-family:inherit;font-size:0.75em;padding:0.2em 0.8ch;cursor:pointer;border-radius:2px">other <span class="media-type-count" data-type-count="other">(...)</span></button>
        </div>
        <div class="collection-grid" id="collection-media-grid">`
      html += renderMediaItems(mediaPurchases)
      html += `</div>`
      if (_mediaHasMore) {
        html += `<div id="collection-media-sentinel" style="height:1px;margin-top:1em"></div>`
      }
      html += `</div>`
    }

    // credentials section
    if (allCreds.length > 0) {
      html += `<div class="collection-section" data-section="credentials">
        <h3>${t('collection.credentials')}</h3>
        <div class="collection-grid" id="collection-creds-grid">`
      html += renderCredentialItems(allCreds)
      html += `</div>`
      if (_credsHasMore) {
        html += `<div id="collection-creds-sentinel" style="height:1px;margin-top:1em"></div>`
      }
      html += `</div>`
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
      html += `<div class="collection-section" data-section="saved-library" style="display:none">
        <h3>${t('collection.saved')}</h3>
        <div class="collection-grid">${savedLibraryItems.map(renderSavedItem).join('')}</div>
      </div>`
    }
    if (savedPostItems.length > 0) {
      html += `<div class="collection-section" data-section="saved-posts" style="display:none">
        <h3>saved posts</h3>
        <div class="collection-grid">${savedPostItems.map(renderSavedItem).join('')}</div>
      </div>`
    }

    contentEl.innerHTML = html

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
            const dataStr = JSON.stringify({ purchases: mediaPurchases, credentials, mediaCursor: _mediaCursor, mediaHasMore: _mediaHasMore, credsCursor: _credsCursor, credsHasMore: _credsHasMore, mediaDetails: _mediaDetails, projectMap: _projectMap, domainMap: _domainMap })
            if (dataStr.length <= 100 * 1024) setCache(collectionCacheKey, dataStr, TTL.medium)
          } catch {}
        }
      })
    } else if (shouldCache) {
      try {
        const dataStr = JSON.stringify({ purchases: mediaPurchases, credentials, mediaCursor: _mediaCursor, mediaHasMore: _mediaHasMore, credsCursor: _credsCursor, credsHasMore: _credsHasMore, mediaDetails: _mediaDetails, projectMap: _projectMap, domainMap: _domainMap })
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
    const media = _mediaDetails[purchase.mediaId]
    if (!media?.ipfsCid) continue
    const cid = media.ipfsCid
    if (!cidToMediaIds[cid]) cidToMediaIds[cid] = []
    cidToMediaIds[cid].push(purchase.mediaId)

    // use indexed contentType from Ponder if available (skip HEAD request)
    if (!_mediaTypeCache[cid] && media.contentType) {
      const cacheKeys = Object.keys(_mediaTypeCache)
      if (cacheKeys.length > 500) {
        const toRemove = cacheKeys.slice(0, Math.floor(cacheKeys.length / 2))
        for (const k of toRemove) delete _mediaTypeCache[k]
      }
      _mediaTypeCache[cid] = classifyContentType(media.contentType)
    }
  }

  // only HEAD-request CIDs not already resolved from indexed contentType
  const uniqueCids = Object.keys(cidToMediaIds).filter(cid => !_mediaTypeCache[cid])
  if (uniqueCids.length > 0) {
    // throttled HEAD requests — max 10 concurrent to avoid overwhelming IPFS proxy
    const CONCURRENCY = 10
    const results = []
    for (let i = 0; i < uniqueCids.length; i += CONCURRENCY) {
      const batch = uniqueCids.slice(i, i + CONCURRENCY)
      const batchResults = await Promise.all(
        batch.map(cid =>
          fetch(ipfsUrl(cid), { method: 'HEAD' })
            .then(res => {
              const ct = (res.headers.get('content-type') || '').split(';')[0].trim()
              return { cid, contentType: ct }
            })
            .catch(() => ({ cid, contentType: '' }))
        )
      )
      results.push(...batchResults)
    }

    for (const { cid, contentType } of results) {
      // bound _mediaTypeCache to 500 entries max — clear oldest half if exceeded
      const cacheKeys = Object.keys(_mediaTypeCache)
      if (cacheKeys.length > 500) {
        const toRemove = cacheKeys.slice(0, Math.floor(cacheKeys.length / 2))
        for (const k of toRemove) delete _mediaTypeCache[k]
      }
      _mediaTypeCache[cid] = classifyContentType(contentType)
    }
  }

  // tag each collection-item with data-media-type
  const grid = contentEl.querySelector('#collection-media-grid')
  if (!grid) return

  const items = grid.querySelectorAll('.collection-item[data-media-id]')
  for (const item of items) {
    const mediaId = item.dataset.mediaId
    const media = _mediaDetails[mediaId]
    if (!media?.ipfsCid) {
      item.dataset.mediaType = 'other'
      continue
    }
    const type = _mediaTypeCache[media.ipfsCid] || 'other'
    item.dataset.mediaType = type
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
      const media = _mediaDetails[mediaId]
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
          const newIds = [...new Set(result.items.map(p => p.mediaId).filter(id => !_mediaDetails[id]))]
          if (newIds.length > 0) {
            try {
              const items = await fetchByIds('mediaListings', 'MediaDetails', newIds, F.mediaListingFull)
              for (const m of items) _mediaDetails[m.id] = m
            } catch (e) { console.warn('media details:', e) }
          }
          await fetchCoverArt(result.items, _domainMap)
          _allMediaPurchases.push(...result.items)
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

        const newProjIds = [...new Set(result.items.map(c => c.projectId).filter(id => !_projectMap[id]))]
        if (newProjIds.length > 0) {
          try {
            const items = await fetchByIds('projects', 'Projects', newProjIds, F.projectSummary)
            for (const p of items) _projectMap[p.id] = p
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

function renderMediaItems(mediaPurchases) {
  let html = ''
  for (const purchase of mediaPurchases) {
    const media = _mediaDetails[purchase.mediaId]
    const title = media ? escapeHtml(media.title) : `#${purchase.mediaId}`
    const artistDomain = media ? resolveDomain(_domainMap, media.artist) : ''
    const artistLink = media ? `https://${artistDomain}` : '#'

    const mediaUrl = media?.ipfsCid ? ipfsUrl(media.ipfsCid) : ''
    const priceEth = purchase.price ? formatEthAmount(purchase.price) : '0'
    const coverCid = _coverArtMap[purchase.mediaId] || ''
    const coverUrl = coverCid ? ipfsUrl(coverCid) : ''

    // use cached type if available, otherwise 'pending' (will be updated by detectMediaTypes)
    const cachedType = media?.ipfsCid ? (_mediaTypeCache[media.ipfsCid] || 'pending') : 'other'
    const isSuperseded = media?.superseded === true
    const supersededStyle = isSuperseded ? 'opacity:0.5;' : ''

    const artDetailUrl = isSuperseded ? `/art?media=${media.activeListingId}` : `/art?media=${purchase.mediaId}`
    html += `<div class="collection-item${isSuperseded ? ' media-superseded' : ''}" data-media-id="${purchase.mediaId}" data-media-type="${cachedType}" style="display:flex;gap:1.5ch;padding:1em;border:1px solid var(--border);margin-bottom:0.75em;align-items:center;${supersededStyle}">
      <div class="collection-art" id="art-${purchase.mediaId}" style="width:60px;height:60px;background:var(--surface);border:1px solid var(--border);flex-shrink:0;display:flex;align-items:center;justify-content:center;overflow:hidden">
        <a href="${artDetailUrl}">${coverUrl ? `<img loading="lazy" src="/api/img?url=${encodeURIComponent(coverUrl)}&w=240" style="width:100%;height:100%;object-fit:cover">` : artPlaceholder(title, 60)}</a>
      </div>
      <div style="flex:1;min-width:0">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <a href="${artDetailUrl}" style="color:var(--accent);font-size:1em;text-decoration:none">${title}</a>
          <span style="color:var(--dim);font-size:0.8em" data-eth-wei="${purchase.price || '0'}">${priceEth} ETH</span>
        </div>`

    if (isSuperseded) {
      html += `<div style="margin-top:0.25em"><span style="font-size:0.75em;color:var(--muted)">superseded</span> <a href="/art?media=${media.activeListingId}" style="font-size:0.75em;color:var(--accent)">view current</a></div>`
    } else if (artistDomain) {
      html += `<div style="color:var(--muted);font-size:0.85em;margin-top:0.25em">by <a href="${artistLink}" style="color:var(--muted)">${escapeHtml(artistDomain)}</a></div>`
    }

    if (mediaUrl && !isSuperseded) {
      html += `<div style="margin-top:0.5em;display:flex;gap:1ch;align-items:center">
        <button class="track-play-btn" data-track-src="${mediaUrl}" data-track-title="${title}" data-track-artist="${escapeHtml(artistDomain || '')}" style="background:none;border:1px solid var(--border);color:var(--fg);font-family:inherit;font-size:0.8em;padding:0.2em 0.8ch;cursor:pointer">play</button>
        <a href="${mediaUrl}" download="${title}" style="color:var(--dim);font-size:0.8em">download</a>
      </div>`
    }

    html += `</div></div>`
  }
  return html
}

function renderCredentialItems(allCreds) {
  const PROJECT_TYPES = ['show', 'film', 'theater', 'recording', 'workshop', 'installation', 'other']
  let html = ''
  for (const cred of allCreds) {
    const proj = _projectMap[cred.projectId]
    const title = proj ? escapeHtml(proj.title) : `project #${cred.projectId}`
    const type = proj ? PROJECT_TYPES[proj.projectType] || '' : ''
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
    const uniqueIds = [...new Set(mediaPurchases.map(p => p.mediaId).filter(id => !_coverArtMap[id]))]
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
        _coverArtMap[id] = metadataCid
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
            fetch(`https://${domain}/api/site`).then(r => r.json()).catch(() => null)
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
                    if (artMatch) _coverArtMap[id] = artMatch[1]
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
