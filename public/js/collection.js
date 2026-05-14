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

    // fetch cover art + resolve album names
    await fetchCoverArt(mediaPurchases, _domainMap)
    // Pre-group to resolve album names from artist site.json
    const preGroups = []
    const tempAlbumMap = new Map()
    for (const p of mediaPurchases) {
      const cid = _coverArtMap[p.mediaId] || ''
      if (cid) {
        if (!tempAlbumMap.has(cid)) tempAlbumMap.set(cid, { items: [], coverCid: cid })
        tempAlbumMap.get(cid).items.push(p)
      }
    }
    for (const g of tempAlbumMap.values()) { if (g.items.length >= 2) preGroups.push(g) }
    if (preGroups.length > 0) await resolveAlbumInfo(preGroups)

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
    html += `<div id="collection-search" style="margin-bottom:1em">
      <input type="text" id="collection-search-input" placeholder="${t('collection.searchPlaceholder') || 'search collection...'}" class="project-input" style="max-width:400px;width:100%">
    </div>`

    // Passport stamps — circular, one per artist relationship
    const artistStamps = buildArtistStamps(mediaPurchases, allCreds)
    if (artistStamps.length > 0) {
      html += `<div class="stamps-section">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5em">
          <h3 style="margin:0;font-size:0.9em">soulbound</h3>
          <span style="color:var(--dim);font-size:0.7em">${artistStamps.reduce((s, st) => s + st.count, 0)} tokens · ${artistStamps.length} artist${artistStamps.length !== 1 ? 's' : ''} · <a href="https://ourpraxis.network/how-it-works#soulbound" target="_blank" style="color:var(--dim)">what is this?</a></span>
        </div>
        <div class="stamps-row">`
      for (const stamp of artistStamps) {
        const ogImg = stamp.domain.includes('.') ? `https://${escapeHtml(stamp.domain)}/og/index.png` : ''
        html += `<div class="stamp" data-artist="${escapeHtml(stamp.artistAddr)}" title="${escapeHtml(stamp.name)} · ${stamp.action}">
          ${ogImg ? `<div class="stamp-bg" style="background-image:url(${ogImg})"></div>` : ''}
          <div class="stamp-content">
            <div class="stamp-artist">${escapeHtml(stamp.name.split(' ')[0])}</div>
            <div class="stamp-action">${stamp.count || ''}</div>
          </div>
        </div>`
      }
      html += `</div></div>`
    }

    // media section
    if (mediaPurchases.length > 0) {
      html += `<div class="collection-section" data-section="media">
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

    // view toggle handler
    contentEl.querySelectorAll('.view-toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        _viewMode = btn.dataset.view
        localStorage.setItem('praxis:collection-view', _viewMode)
        contentEl.querySelectorAll('.view-toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.view === _viewMode))
        const grid = document.getElementById('collection-media-grid')
        if (grid) {
          grid.className = `collection-media ${_viewMode === 'grid' ? 'collection-grid-view' : 'collection-list-view'}`
          grid.innerHTML = renderMediaItems(_allMediaPurchases)
          detectMediaTypes(_allMediaPurchases, contentEl)
        }
      })
    })

    // Passport stamp click → open artist passport page
    contentEl.querySelectorAll('.stamp').forEach(stamp => {
      stamp.addEventListener('click', () => {
        const artistAddr = stamp.dataset.artist
        if (!artistAddr) return
        const domain = _domainMap[artistAddr] || ''
        const artistPurchases = _allMediaPurchases.filter(p => _mediaDetails[p.mediaId]?.artist?.toLowerCase() === artistAddr)
        const artistCreds = _allCredentials.filter(c => _projectMap[c.projectId]?.proposer?.toLowerCase() === artistAddr)
        const mediaAddr = document.body.dataset.media || '0xaF995dB3955419E9E2086FD02891580F8a025481'

        const overlay = document.createElement('div')
        overlay.className = 'wizard-overlay'
        overlay.style.cssText = 'z-index:10001;align-items:center;justify-content:center'
        const ogImg = domain.includes('.') ? `https://${escapeHtml(domain)}/og/index.png` : ''
        // Find alias name (only entries matching this artist's domain)
        let aliasName = domain
        for (const info of _albumInfoCache.values()) {
          if (info.domain === domain && info.aliasName && info.aliasName !== domain) { aliasName = info.aliasName; break }
        }

        let html = `<div style="max-width:500px;width:100%;padding:0;margin:0 auto">`
        // Banner
        if (ogImg) html += `<div style="height:120px;background:url(${ogImg}) center/cover;opacity:0.6"></div>`
        html += `<div style="padding:1.5em 2em">`
        html += `<h2 style="margin:0 0 0.15em;font-size:1.3em">${escapeHtml(aliasName)}</h2>`
        if (domain.includes('.')) html += `<a href="https://${escapeHtml(domain)}" target="_blank" style="color:var(--muted);font-size:0.85em">${escapeHtml(domain)}</a>`

        // Collected works
        if (artistPurchases.length > 0) {
          html += `<div style="margin-top:1.5em"><div style="color:var(--dim);font-size:0.7em;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:0.5em">collected · ${artistPurchases.length} work${artistPurchases.length !== 1 ? 's' : ''}</div>`
          for (const p of artistPurchases) {
            const m = _mediaDetails[p.mediaId]
            const title = m ? escapeHtml(m.title) : `#${p.mediaId}`
            const tokenId = BigInt(p.mediaId).toString(16).padStart(4, '0')
            html += `<div style="display:flex;align-items:center;gap:0.75ch;padding:0.35em 0;border-bottom:1px solid var(--border);font-size:0.85em">
              <span style="font-family:monospace;color:var(--dim);font-size:0.75em">0x${tokenId}</span>
              <a href="/art?media=${p.mediaId}" style="color:var(--fg);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${title}</a>
            </div>`
          }
          html += `</div>`
        }

        // Project credentials
        if (artistCreds.length > 0) {
          html += `<div style="margin-top:1.5em"><div style="color:var(--dim);font-size:0.7em;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:0.5em">project credits</div>`
          for (const c of artistCreds) {
            const proj = _projectMap[c.projectId]
            const title = proj ? escapeHtml(proj.title) : `project #${c.projectId}`
            const role = c.tokenType === 3 ? 'contributor' : 'producer'
            html += `<div style="display:flex;align-items:center;gap:0.75ch;padding:0.35em 0;border-bottom:1px solid var(--border);font-size:0.85em">
              <span style="color:${c.tokenType === 2 ? 'var(--green,#4ade80)' : '#a78bfa'};font-size:0.75em">${role}</span>
              <a href="/project?id=${c.projectId}" style="color:var(--fg);flex:1">${title}</a>
            </div>`
          }
          html += `</div>`
        }

        // Footer
        html += `<div style="margin-top:2em;padding-top:1em;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
          <span style="font-family:monospace;font-size:0.65em;color:var(--dim)">contract <a href="https://optimistic.etherscan.io/address/${escapeHtml(mediaAddr)}" target="_blank" style="color:var(--dim)">${mediaAddr.slice(0, 10)}...</a></span>
          <span style="font-size:0.65em;color:var(--dim)">permanent · non-transferable</span>
        </div>`
        html += `</div></div>`

        const dialog = document.createElement('div')
        dialog.innerHTML = html
        overlay.appendChild(dialog)
        const closeBtn = document.createElement('button')
        closeBtn.className = 'wizard-close'
        closeBtn.textContent = '\u00d7'
        closeBtn.addEventListener('click', () => { overlay.classList.add('closing'); overlay.addEventListener('animationend', () => overlay.remove(), { once: true }) })
        overlay.appendChild(closeBtn)
        overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.classList.add('closing'); overlay.addEventListener('animationend', () => overlay.remove(), { once: true }) } })
        document.body.appendChild(overlay)
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

  // tag each collection-item with data-media-type + upgrade video cards
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

    // Upgrade video cards that were initially rendered as audio/placeholder
    if (type === 'video' && !item.querySelector('.video-lazy')) {
      const cardArt = item.querySelector('.card-art')
      if (cardArt) {
        const mediaUrl = ipfsUrl(media.ipfsCid)
        const title = escapeHtml(media.title || '')
        cardArt.innerHTML = `<div class="video-lazy" data-src="${mediaUrl}" data-poster="" data-title="${title}" style="aspect-ratio:16/9;background:#111;position:relative;cursor:pointer;overflow:hidden;border-radius:6px"><div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:48px;height:48px;border-radius:50%;background:rgba(255,255,255,0.15);display:flex;align-items:center;justify-content:center"><i class="ph ph-play" style="color:#fff;font-size:18px"></i></div><span style="position:absolute;bottom:0.5em;left:0.75em;color:#999;font-size:0.8em">${title}</span></div>`
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

// Build passport stamps — one per artist relationship
function buildArtistStamps(mediaPurchases, credentials) {
  const artistMap = new Map() // artistAddr -> { count, domain, name, firstDate, mediaIds }
  for (const p of mediaPurchases) {
    const m = _mediaDetails[p.mediaId]
    if (!m) continue
    const addr = m.artist?.toLowerCase() || ''
    if (!addr) continue
    if (!artistMap.has(addr)) {
      const domain = _domainMap[addr] || ''
      // Try to get alias name from album cache (only entries matching this artist's domain)
      let aliasName = domain
      for (const info of _albumInfoCache.values()) {
        if (info.domain === domain && info.aliasName && info.aliasName !== domain) {
          aliasName = info.aliasName
          break
        }
      }
      artistMap.set(addr, { count: 0, domain, name: aliasName, firstDate: null, mediaIds: [], addr })
    }
    const entry = artistMap.get(addr)
    entry.count++
    entry.mediaIds.push(p.mediaId)
    // Track earliest date from purchase timestamp
    if (p.timestamp) {
      const ts = Number(p.timestamp) * (Number(p.timestamp) < 1e12 ? 1000 : 1)
      if (!entry.firstDate || ts < entry.firstDate) entry.firstDate = ts
    }
  }
  // Add project credentials
  for (const c of credentials) {
    const proj = _projectMap[c.projectId]
    const proposer = proj?.proposer?.toLowerCase() || ''
    if (!proposer) continue
    if (!artistMap.has(proposer)) {
      const domain = _domainMap[proposer] || ''
      artistMap.set(proposer, { count: 0, domain, name: domain, firstDate: null, mediaIds: [], addr: proposer, produced: 0, contributed: 0 })
    }
    const entry = artistMap.get(proposer)
    if (c.tokenType === 2) entry.produced = (entry.produced || 0) + 1
    if (c.tokenType === 3) entry.contributed = (entry.contributed || 0) + 1
  }

  const stamps = []
  for (const [addr, entry] of artistMap) {
    const parts = []
    if (entry.count > 0) parts.push(`${entry.count} collected`)
    if (entry.produced) parts.push(`${entry.produced} produced`)
    if (entry.contributed) parts.push(`${entry.contributed} contributed`)
    // Generate a token hash from first mediaId (simulates the ERC-6909 tokenId)
    const firstId = entry.mediaIds[0] || '0'
    const tokenHash = BigInt(firstId).toString(16).padStart(8, '0').slice(0, 8)
    stamps.push({
      artistAddr: addr,
      domain: entry.domain,
      name: entry.name || entry.domain || `${addr.slice(0, 6)}...`,
      action: parts.join(' · '),
      count: entry.count + (entry.produced || 0) + (entry.contributed || 0),
      tokenHash,
      date: entry.firstDate ? new Date(entry.firstDate).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '',
    })
  }
  return stamps.sort((a, b) => b.count - a.count) // most active first
}

// Resolve album names + paths from artist site.json for grouped purchases
async function resolveAlbumInfo(albums) {
  const domainFetches = new Map() // domain -> promise
  // First pass: resolve domains and kick off fetches
  for (const album of albums) {
    const first = album.items[0]
    const media = _mediaDetails[first.mediaId]
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
    const trackTitles = new Set(album.items.map(p => (_mediaDetails[p.mediaId]?.title || '').toLowerCase()).filter(Boolean))
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
    const coverCid = _coverArtMap[purchase.mediaId] || ''
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
    const media = _mediaDetails[first.mediaId]
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
    const albumLink = albumPath ? `https://${escapeHtml(artistDomain)}/art?type=music&alias=${albumPath.alias}&album=${albumPath.album}` : `/art?media=${first.mediaId}`

    // Build play-all queue
    const queueTracks = sorted.filter(p => _mediaDetails[p.mediaId]?.ipfsCid).map(p => {
      const m = _mediaDetails[p.mediaId]
      return { src: ipfsUrl(m.ipfsCid), title: m.title || '', artist: aliasName, art: `/api/img?url=${encodeURIComponent(coverUrl)}&w=200` }
    })
    const queueData = encodeURIComponent(JSON.stringify(queueTracks))

    if (_viewMode === 'grid') {
      html += `<div class="collection-card collection-album-card collection-item" data-media-id="${first.mediaId}" data-media-type="audio">
        <div class="card-art">
          <a href="${albumLink}"><img loading="lazy" src="/api/img?url=${encodeURIComponent(coverUrl)}&w=400" style="border-radius:6px"></a>
          <span class="card-type-badge">${trackCount} tracks</span>
        </div>
        <div class="card-info">
          <a href="${albumLink}" class="card-title">${escapeHtml(albumName)}</a>
          <a href="${artistLink}" class="card-artist">${escapeHtml(aliasName)}</a>
          <div class="card-actions">
            <button class="album-play-btn" data-queue="${queueData}" style="background:none;border:1px solid var(--border);color:var(--fg);width:24px;height:24px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:0.7em"><i class="ph ph-play"></i></button>
            <a href="${queueTracks[0]?.src || '#'}" download="${escapeHtml(albumName)}" style="color:var(--dim);font-size:0.9em"><i class="ph ph-download-simple"></i></a>
          </div>
        </div>
      </div>`
    } else {
      // Album in list view — iTunes style
      html += `<div class="collection-album-list collection-item" data-media-id="${first.mediaId}" data-media-type="audio">
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
        const m = _mediaDetails[p.mediaId]
        const trackTitle = m ? escapeHtml(m.title) : `#${p.mediaId}`
        const trackUrl = m?.ipfsCid ? ipfsUrl(m.ipfsCid) : ''
        html += `<div class="album-track">
          <span class="track-num">${i + 1}</span>
          ${trackUrl ? `<button class="track-play-btn" data-track-src="${trackUrl}" data-track-title="${trackTitle}" data-track-artist="${escapeHtml(aliasName)}" style="background:none;border:1px solid var(--border);color:var(--fg);width:22px;height:22px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:0.6em;flex-shrink:0"><i class="ph ph-play"></i></button>` : '<span style="width:22px"></span>'}
          <span class="track-title">${trackTitle}</span>
          <div style="display:flex;gap:0.5ch;align-items:center;flex-shrink:0;margin-left:auto;padding-right:0.5em">
            ${trackUrl ? `<button class="track-queue-btn" data-src="${trackUrl}" data-title="${trackTitle}" data-artist="${escapeHtml(aliasName)}" data-art="${queueTracks[0]?.art || ''}" style="background:none;border:none;color:var(--dim);font-size:0.85em;cursor:pointer;padding:0.15em" title="add to queue"><i class="ph ph-plus"></i></button>` : ''}
            ${trackUrl ? `<a href="${trackUrl}" download="${trackTitle}" style="color:var(--dim);font-size:0.85em;padding:0.15em" title="download"><i class="ph ph-download-simple"></i></a>` : ''}
          </div>
        </div>`
      }
      html += `</div></div>`
    }
  }

  // Render singles
  for (const purchase of singles) {
    const media = _mediaDetails[purchase.mediaId]
    const title = media ? escapeHtml(media.title) : `#${purchase.mediaId}`
    const artistDomain = media ? resolveDomain(_domainMap, media.artist) : ''
    const artistLink = `https://${escapeHtml(artistDomain)}`
    const mediaUrl = media?.ipfsCid ? ipfsUrl(media.ipfsCid) : ''
    const coverCid = _coverArtMap[purchase.mediaId] || ''
    const coverUrl = coverCid ? ipfsUrl(coverCid) : ''
    const cachedType = media?.ipfsCid ? (_mediaTypeCache[media.ipfsCid] || (media.contentType?.startsWith('video/') ? 'video' : 'audio')) : 'other'
    const isSuperseded = media?.superseded === true
    const artDetailUrl = isSuperseded ? `/art?media=${media.activeListingId}` : `/art?media=${purchase.mediaId}`
    const escapedArtist = escapeHtml(artistDomain || '')

    if (_viewMode === 'grid') {
      const isVideo = cachedType === 'video'
      const artHtml = isVideo && mediaUrl
        ? `<div class="video-lazy" data-src="${mediaUrl}" data-poster="" data-title="${title}" style="aspect-ratio:16/9;background:#111;position:relative;cursor:pointer;overflow:hidden;border-radius:6px"><div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:48px;height:48px;border-radius:50%;background:rgba(255,255,255,0.15);display:flex;align-items:center;justify-content:center"><i class="ph ph-play" style="color:#fff;font-size:18px"></i></div><span style="position:absolute;bottom:0.5em;left:0.75em;color:#999;font-size:0.8em">${title}</span></div>`
        : `<a href="${artDetailUrl}">${coverUrl ? `<img loading="lazy" src="/api/img?url=${encodeURIComponent(coverUrl)}&w=400" style="border-radius:6px">` : artPlaceholder(title, 180)}</a>`
      html += `<div class="collection-card collection-item${isSuperseded ? ' media-superseded' : ''}" data-media-id="${purchase.mediaId}" data-media-type="${cachedType}"${isSuperseded ? ' style="opacity:0.5"' : ''}>
        <div class="card-art">${artHtml}</div>
        <div class="card-info">
          <a href="${artDetailUrl}" class="card-title">${title}</a>
          <a href="${artistLink}" class="card-artist">${escapedArtist}</a>
          <div class="card-actions">
            ${mediaUrl && !isSuperseded && !isVideo ? `<button class="track-play-btn" data-track-src="${mediaUrl}" data-track-title="${title}" data-track-artist="${escapedArtist}" style="background:none;border:1px solid var(--border);color:var(--fg);width:24px;height:24px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:0.7em"><i class="ph ph-play"></i></button>` : ''}
            ${mediaUrl && !isSuperseded ? `<a href="${mediaUrl}" download="${title}" style="color:var(--dim);font-size:0.9em"><i class="ph ph-download-simple"></i></a>` : ''}
          </div>
        </div>
      </div>`
    } else {
      html += `<div class="collection-row collection-item${isSuperseded ? ' media-superseded' : ''}" data-media-id="${purchase.mediaId}" data-media-type="${cachedType}"${isSuperseded ? ' style="opacity:0.5"' : ''}>
        <a href="${artDetailUrl}" class="row-art">${coverUrl ? `<img loading="lazy" src="/api/img?url=${encodeURIComponent(coverUrl)}&w=120">` : artPlaceholder(title, 48)}</a>
        <div class="row-info">
          <a href="${artDetailUrl}" class="card-title">${title}</a>
          <a href="${artistLink}" class="card-artist">${escapedArtist}</a>
        </div>
        <div class="card-actions">
          ${mediaUrl && !isSuperseded ? `<button class="track-play-btn" data-track-src="${mediaUrl}" data-track-title="${title}" data-track-artist="${escapedArtist}" style="background:none;border:1px solid var(--border);color:var(--fg);width:22px;height:22px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:0.6em"><i class="ph ph-play"></i></button><a href="${mediaUrl}" download="${title}" class="track-dl"><i class="ph ph-download-simple"></i></a>` : ''}
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
    const proj = _projectMap[cred.projectId]
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
