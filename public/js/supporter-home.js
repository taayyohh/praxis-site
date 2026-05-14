// Supporter homepage — masonry grid of collected art + "my artists" section
import { F } from './fragments.js'
import { query } from './ponder.js'
import { ipfsUrl, escapeHtml, resolveAddresses, resolveDomain, registerPage } from './utils.js'
import { getCollection } from './media.js'

const PAGE_SIZE = 30
let _cursor = null
let _hasMore = false
let _loading = false
let _ownerAddr = null
let _domainMap = {}
let _mediaDetails = {}
let _observer = null

// Init when feed exists (supporter page) — sets up toggle + eager-loads collection
registerPage('feed', () => {
  initSupporterToggle()
  // Eager-init collection even though it's hidden
  const section = document.getElementById('supporter-collection-section')
  if (section && !_loading) init()
})

function initSupporterToggle() {
  const feed = document.getElementById('feed')
  const collection = document.getElementById('supporter-collection-section')
  if (!feed || !collection) return
  // Wire dock nav: first icon = feed (home), second icon = collection
  const navLinks = document.querySelectorAll('.portfolio-nav a, #mobile-portfolio-nav a')
  if (navLinks.length >= 1) {
    // On supporter pages, first nav link = collection toggle
    navLinks[0]?.addEventListener('click', (e) => {
      e.preventDefault()
      const showingCollection = collection.style.display !== 'none'
      feed.style.display = showingCollection ? '' : 'none'
      collection.style.display = showingCollection ? 'none' : ''
    })
  }
  // Also trigger collection init when shown
  if (collection.style.display !== 'none') init()
}

function init() {
  const section = document.getElementById('supporter-collection-section')
  if (!section) return

  _ownerAddr = section.dataset.wallet || null
  if (!_ownerAddr) return

  // load top artists
  loadTopArtists()

  // load collection masonry
  _cursor = null
  _hasMore = false
  _mediaDetails = {}
  _domainMap = {}
  if (_observer) { _observer.disconnect(); _observer = null }
  loadCollectionMasonry(_ownerAddr)
}

async function loadTopArtists() {
  const grid = document.getElementById('top-artists-grid')
  if (!grid) return

  const cards = [...grid.querySelectorAll('.top-artist-card')]
  // fetch all artist data in parallel (not sequentially)
  await Promise.allSettled(cards.map(async (card) => {
    const domain = card.dataset.domain
    if (!domain) return
    try {
      const res = await fetch(`https://${domain}/api/site`)
      if (!res.ok) return
      const data = await res.json()
      let artUrl = null
      for (const mod of (data.modules || [])) {
        if (mod.type === 'music' && mod.data?.aliases) {
          for (const alias of mod.data.aliases) {
            for (const album of (alias.albums || [])) {
              if (album.art) { artUrl = `https://${domain}/api/img?url=${encodeURIComponent(album.art)}&w=200`; break }
            }
            if (artUrl) break
          }
        }
        if (artUrl) break
      }
      if (!artUrl) artUrl = `https://${domain}/og/index.png`
      const img = card.querySelector('.top-artist-avatar')
      if (img) { img.src = artUrl; img.alt = data.name || domain }
      const nameEl = card.querySelector('.top-artist-name')
      if (nameEl) nameEl.textContent = data.name || domain
    } catch {}
  }))
}

async function loadCollectionMasonry(ownerAddr) {
  const grid = document.getElementById('masonry-grid')
  const status = document.getElementById('supporter-collection-status')
  if (!grid) return

  if (_loading) return
  _loading = true
  if (status) status.innerHTML = '<span class="praxis-loader"></span>'

  try {
    const result = await getCollection(ownerAddr, _cursor)
    const purchases = result.items
    _cursor = result.cursor
    _hasMore = result.hasMore

    if (purchases.length === 0 && !_cursor) {
      if (status) status.textContent = 'no collected works yet'
      _loading = false
      return
    }

    // fetch media details for purchases
    const mediaIds = [...new Set(purchases.map(p => p.mediaId))]
    if (mediaIds.length > 0) {
      try {
        const data = await query(`
          query MediaDetails($ids: [BigInt!]!) {
            mediaListings(where: { id_in: $ids }, limit: 100) {
              items { ${F.mediaListingFull} }
            }
          }
        `, { ids: mediaIds })
        for (const m of (data.mediaListings?.items || [])) {
          _mediaDetails[m.id] = m
        }
      } catch (e) {
        console.warn('[supporter-home] media details error:', e)
      }
    }

    // resolve artist domains
    const artistAddresses = Object.values(_mediaDetails).map(m => m.artist).filter(Boolean)
    const newDomains = await resolveAddresses(query, artistAddresses)
    Object.assign(_domainMap, newDomains)

    // render tiles
    for (const purchase of purchases) {
      const tile = renderMasonryTile(purchase)
      if (tile) grid.insertAdjacentHTML('beforeend', tile)
    }

    if (status) status.textContent = ''

    // setup infinite scroll
    setupInfiniteScroll(grid, ownerAddr)
  } catch (e) {
    console.warn('[supporter-home] collection load error:', e)
    if (status) status.textContent = 'could not load collection'
  }

  _loading = false
}

function renderMasonryTile(purchase) {
  const media = _mediaDetails[purchase.mediaId]
  if (!media) return ''

  const artistAddr = (media.artist || '').toLowerCase()
  const domain = _domainMap[artistAddr]
  const artistLink = domain ? `https://${escapeHtml(domain)}/works` : '#'
  const title = escapeHtml(media.title || 'untitled')
  const artistName = domain || `${artistAddr.slice(0, 6)}...${artistAddr.slice(-4)}`
  const ct = (media.contentType || '').toLowerCase()

  let inner = ''

  if (ct.startsWith('audio/') || ct === 'audio') {
    // audio: album art with overlay
    const imgSrc = media.ipfsCid ? `/api/img?url=${encodeURIComponent(ipfsUrl(media.ipfsCid))}&w=400` : ''
    inner = `
      <img src="${imgSrc}" loading="lazy" alt="${title}">
      <div class="masonry-tile-overlay">
        <div style="font-size:0.9em;font-weight:600;color:#fff">${title}</div>
        <div style="font-size:0.75em;color:#ccc">${escapeHtml(artistName)}</div>
      </div>`
  } else if (ct.startsWith('video/') || ct === 'video') {
    // video: thumbnail with play icon
    const thumbSrc = media.ipfsCid ? `/api/video-thumb?cid=${media.ipfsCid}&w=400` : ''
    inner = `
      <img src="${thumbSrc}" loading="lazy" alt="${title}">
      <div class="masonry-tile-overlay">
        <i class="ph ph-play-circle" style="font-size:2em;color:#fff"></i>
        <div style="font-size:0.9em;color:#fff;margin-top:0.25em">${title}</div>
      </div>`
  } else if (ct.startsWith('image/') || ct === 'image') {
    // image: direct display
    const imgSrc = media.ipfsCid ? `/api/img?url=${encodeURIComponent(ipfsUrl(media.ipfsCid))}&w=400` : ''
    inner = `
      <img src="${imgSrc}" loading="lazy" alt="${title}">
      <div class="masonry-tile-overlay">
        <div style="font-size:0.9em;color:#fff">${title}</div>
      </div>`
  } else if (ct.startsWith('text/') || ct === 'writing') {
    // writing: styled text card
    inner = `
      <div style="padding:1.5em;min-height:120px;display:flex;flex-direction:column;justify-content:flex-end">
        <div style="font-size:1.1em;font-weight:600;color:var(--fg)">${title}</div>
        <div style="font-size:0.8em;color:var(--muted);margin-top:0.5em">${escapeHtml(artistName)}</div>
      </div>`
  } else {
    // fallback: try video-thumb first (for unknown contentType), then image proxy
    const thumbSrc = media.ipfsCid ? `/api/video-thumb?cid=${media.ipfsCid}&w=400` : ''
    const imgSrc = media.ipfsCid ? `/api/img?url=${encodeURIComponent(ipfsUrl(media.ipfsCid))}&w=400` : ''
    if (thumbSrc || imgSrc) {
      inner = `
        <img src="${thumbSrc || imgSrc}" loading="lazy" alt="${title}" onerror="if(this.src.includes('video-thumb')){this.src='${imgSrc}'}else{this.style.display='none'}">
        <div class="masonry-tile-overlay">
          <div style="font-size:0.9em;color:#fff">${title}</div>
        </div>`
    } else {
      inner = `
        <div style="padding:1.5em;min-height:100px">
          <div style="font-size:1em;color:var(--fg)">${title}</div>
          <div style="font-size:0.8em;color:var(--muted);margin-top:0.5em">${escapeHtml(artistName)}</div>
        </div>`
    }
  }

  return `<a href="${artistLink}" class="masonry-tile" target="_blank" rel="noopener">${inner}</a>`
}

function setupInfiniteScroll(grid, ownerAddr) {
  if (_observer) _observer.disconnect()
  if (!_hasMore) return

  const sentinel = document.createElement('div')
  sentinel.id = 'masonry-sentinel'
  sentinel.style.height = '1px'
  grid.parentElement.appendChild(sentinel)

  _observer = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && _hasMore && !_loading) {
      loadCollectionMasonry(ownerAddr)
    }
  }, { rootMargin: '200px' })

  _observer.observe(sentinel)
}
