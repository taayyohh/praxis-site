// Supporter homepage — masonry grid of collected art + "my artists" section
import { F } from './fragments.js'
import { query } from './ponder.js'
import { ipfsUrl, escapeHtml, resolveAddresses, resolveDomain, registerPage, slugify } from './utils.js'
import { getCollection } from './media.js'

const MEDIA_CACHE_MAX = 500
const DOMAIN_CACHE_MAX = 200
const ALBUM_CACHE_MAX = 100

let _cursor = null
let _hasMore = false
let _loading = false
let _ownerAddr = null
let _domainMap = new Map()     // bounded LRU: artistAddr -> domain
let _mediaDetails = new Map()  // bounded LRU: mediaId -> details
let _albumArtCache = new Map() // bounded LRU: metadataCid -> { artUrl, albumName, ... }
let _renderedAlbums = new Set() // metadataCids already rendered (persists across pages)
let _observer = null

function lruSet(map, key, value, max) {
  if (map.has(key)) map.delete(key)
  map.set(key, value)
  if (map.size > max) map.delete(map.keys().next().value)
}

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

  // Wire dock nav: first icon toggles between feed and collection
  const navLinks = document.querySelectorAll('.portfolio-nav a, #mobile-portfolio-nav a')
  if (navLinks.length >= 1) {
    navLinks[0]?.addEventListener('click', (e) => {
      e.preventDefault()
      const showingCollection = collection.style.display !== 'none'
      feed.style.display = showingCollection ? '' : 'none'
      collection.style.display = showingCollection ? 'none' : ''
    })
  }
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
  _mediaDetails = new Map()
  _domainMap = new Map()
  _albumArtCache = new Map()
  _renderedAlbums = new Set()
  if (_observer) { _observer.disconnect(); _observer = null }
  loadCollectionMasonry(_ownerAddr)
}

async function loadTopArtists() {
  const grid = document.getElementById('top-artists-grid')
  if (!grid) return

  const cards = [...grid.querySelectorAll('.top-artist-card')]
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

    // Fetch media details only for NEW purchases (not already cached)
    const newMediaIds = [...new Set(purchases.map(p => p.mediaId).filter(id => !_mediaDetails.has(id)))]
    if (newMediaIds.length > 0) {
      try {
        const data = await query(`
          query MediaDetails($ids: [BigInt!]!) {
            mediaListings(where: { id_in: $ids }, limit: 100) {
              items { ${F.mediaListingFull} }
            }
          }
        `, { ids: newMediaIds })
        for (const m of (data.mediaListings?.items || [])) {
          lruSet(_mediaDetails, m.id, m, MEDIA_CACHE_MAX)
        }
      } catch (e) {
        console.warn('[supporter-home] media details error:', e)
      }
    }

    // Resolve artist domains only for NEW addresses (not already cached)
    const newArtistAddrs = []
    for (const id of newMediaIds) {
      const m = _mediaDetails.get(id)
      if (m?.artist && !_domainMap.has(m.artist.toLowerCase())) {
        newArtistAddrs.push(m.artist)
      }
    }
    if (newArtistAddrs.length > 0) {
      const newDomains = await resolveAddresses(query, newArtistAddrs)
      for (const [addr, domain] of Object.entries(newDomains)) {
        lruSet(_domainMap, addr, domain, DOMAIN_CACHE_MAX)
      }
    }

    // Group purchases by metadataCid (shared = album/collection)
    const albumGroups = new Map() // metadataCid -> [purchases]
    const singles = []
    for (const purchase of purchases) {
      const media = _mediaDetails.get(purchase.mediaId)
      if (!media) continue
      const mcid = media.metadataCid
      if (mcid) {
        if (!albumGroups.has(mcid)) albumGroups.set(mcid, [])
        albumGroups.get(mcid).push(purchase)
      } else {
        singles.push(purchase)
      }
    }

    // Resolve album art only for NEW groups not already cached
    const albumsToResolve = [...albumGroups.entries()]
      .filter(([mcid, items]) => items.length >= 2 && !_albumArtCache.has(mcid))
    if (albumsToResolve.length > 0) {
      await resolveAlbumArt(albumsToResolve)
    }

    // Render: album groups first (skip already rendered), then singles
    for (const [mcid, items] of albumGroups) {
      if (items.length >= 2) {
        if (_renderedAlbums.has(mcid)) continue // already on page from prior scroll
        _renderedAlbums.add(mcid)
        if (_renderedAlbums.size > 2000) { const first = _renderedAlbums.values().next().value; _renderedAlbums.delete(first) }
        const tile = renderAlbumTile(mcid, items)
        if (tile) grid.insertAdjacentHTML('beforeend', tile)
      } else {
        for (const p of items) {
          const tile = renderMasonryTile(p)
          if (tile) grid.insertAdjacentHTML('beforeend', tile)
        }
      }
    }
    for (const purchase of singles) {
      const tile = renderMasonryTile(purchase)
      if (tile) grid.insertAdjacentHTML('beforeend', tile)
    }

    if (status) status.textContent = ''
    setupInfiniteScroll(grid, ownerAddr)
  } catch (e) {
    console.warn('[supporter-home] collection load error:', e)
    if (status) status.textContent = 'could not load collection'
  }

  _loading = false
}

// Fetch album art + name from artist site.json by matching track titles
async function resolveAlbumArt(albumEntries) {
  const domainItems = new Map() // domain -> [{ mcid, trackTitles }]
  for (const [mcid, items] of albumEntries) {
    if (_albumArtCache.has(mcid)) continue
    const firstMedia = _mediaDetails.get(items[0].mediaId)
    if (!firstMedia) continue
    const domain = _domainMap.get(firstMedia.artist?.toLowerCase())
    if (!domain) continue
    if (!domainItems.has(domain)) domainItems.set(domain, [])
    const trackTitles = new Set(items.map(p => (_mediaDetails.get(p.mediaId)?.title || '').toLowerCase()).filter(Boolean))
    domainItems.get(domain).push({ mcid, trackTitles })
  }

  const entries = [...domainItems.entries()]
  for (let i = 0; i < entries.length; i += 5) {
    const batch = entries.slice(i, i + 5)
    const results = await Promise.all(
      batch.map(([domain]) =>
        fetch(`/api/proxy-site?domain=${encodeURIComponent(domain)}`).then(r => r.json()).catch(() => null)
      )
    )
    for (let j = 0; j < batch.length; j++) {
      const siteData = results[j]
      if (!siteData) continue
      const [domain, mcidEntries] = batch[j]
      for (const { mcid, trackTitles } of mcidEntries) {
        if (_albumArtCache.has(mcid)) continue
        for (const mod of (siteData.modules || [])) {
          if (_albumArtCache.has(mcid)) break
          if (mod.type === 'music') {
            const aliases = mod.data?.aliases || []
            for (let ai = 0; ai < aliases.length; ai++) {
              const alias = aliases[ai]
              const albums = alias.albums || []
              for (let ali = 0; ali < albums.length; ali++) {
                const album = albums[ali]
                const albumTracks = (album.tracks || []).map(t => (t.title || '').toLowerCase()).filter(Boolean)
                const matches = albumTracks.filter(t => trackTitles.has(t)).length
                if (matches >= Math.min(trackTitles.size, albumTracks.length) * 0.5 && matches >= 2) {
                  lruSet(_albumArtCache, mcid, {
                    artUrl: album.art ? `/api/img?url=${encodeURIComponent(album.art)}&w=400` : '',
                    albumName: album.title || '',
                    aliasName: alias.name || '',
                    artistName: alias.name || siteData.name || domain,
                    domain, mediaType: 'album',
                    aliasIdx: ai, albumIdx: ali,
                  }, ALBUM_CACHE_MAX)
                }
              }
            }
          } else if (mod.type === 'gallery') {
            const images = mod.data?.images || []
            const sectionMap = new Map()
            for (const img of images) {
              const key = img.section || img.series || '_all'
              if (!sectionMap.has(key)) sectionMap.set(key, [])
              sectionMap.get(key).push(img)
            }
            for (const [secName, secImages] of sectionMap) {
              const secTitles = secImages.map(i => (i.title || '').toLowerCase()).filter(Boolean)
              const matches = secTitles.filter(t => trackTitles.has(t)).length
              if (matches >= Math.min(trackTitles.size, secTitles.length) * 0.5 && matches >= 2) {
                const firstImg = secImages[0]
                lruSet(_albumArtCache, mcid, {
                  artUrl: firstImg?.src ? `/api/img?url=${encodeURIComponent(firstImg.src)}&w=400` : '',
                  albumName: secName !== '_all' ? secName : (mod.data?.title || 'collection'),
                  artistName: siteData.name || domain,
                  domain, mediaType: 'collection',
                }, ALBUM_CACHE_MAX)
              }
            }
          } else if (mod.type === 'film' || mod.type === 'video') {
            const works = mod.data?.works || mod.data?.videos || []
            const workTitles = works.map(w => (w.title || '').toLowerCase()).filter(Boolean)
            const matches = workTitles.filter(t => trackTitles.has(t)).length
            if (matches >= Math.min(trackTitles.size, workTitles.length) * 0.5 && matches >= 2) {
              const firstWork = works[0]
              lruSet(_albumArtCache, mcid, {
                artUrl: firstWork?.poster ? `/api/img?url=${encodeURIComponent(firstWork.poster)}&w=400` : '',
                albumName: mod.data?.title || 'series',
                artistName: siteData.name || domain,
                domain, mediaType: 'series',
              }, ALBUM_CACHE_MAX)
            }
          }
        }
      }
    }
  }
}

function renderAlbumTile(mcid, items) {
  const cached = _albumArtCache.get(mcid)
  const firstMedia = _mediaDetails.get(items[0].mediaId)
  if (!firstMedia) return ''

  const artistAddr = (firstMedia.artist || '').toLowerCase()
  const domain = cached?.domain || _domainMap.get(artistAddr)
  const artistLink = domain
    ? (cached?.aliasName && cached?.albumName
      ? `https://${escapeHtml(domain)}/music/${slugify(cached.aliasName)}/${slugify(cached.albumName)}`
      : `https://${escapeHtml(domain)}/art?media=${items[0].mediaId}`)
    : '#'
  const albumName = escapeHtml(cached?.albumName || firstMedia.title || 'untitled')
  const artistName = escapeHtml(cached?.artistName || domain || `${artistAddr.slice(0, 6)}...${artistAddr.slice(-4)}`)
  const itemCount = items.length
  const artUrl = cached?.artUrl || ''
  const mtype = cached?.mediaType || 'album'
  const itemLabel = mtype === 'collection' ? `${itemCount} pieces` : mtype === 'series' ? `${itemCount} episodes` : `${itemCount} tracks`

  if (artUrl) {
    return `<a href="${artistLink}" class="masonry-tile" target="_blank" rel="noopener">
      <img src="${artUrl}" loading="lazy" alt="${albumName}">
      <div class="masonry-tile-overlay">
        <span style="position:absolute;top:0.5em;right:0.5em;background:rgba(0,0,0,0.7);color:#fff;font-size:0.7em;padding:0.2em 0.6em;border-radius:2px">${itemLabel}</span>
        <div style="font-size:0.9em;font-weight:600;color:#fff">${albumName}</div>
        <div style="font-size:0.75em;color:#ccc">${artistName}</div>
      </div>
    </a>`
  }

  // No art — use metadataCid as image proxy fallback
  const imgSrc = mcid ? `/api/img?url=${encodeURIComponent(ipfsUrl(mcid))}&w=400` : ''
  if (imgSrc) {
    return `<a href="${artistLink}" class="masonry-tile" target="_blank" rel="noopener">
      <img src="${imgSrc}" loading="lazy" alt="${albumName}" onerror="this.style.display='none'">
      <div class="masonry-tile-overlay">
        <span style="position:absolute;top:0.5em;right:0.5em;background:rgba(0,0,0,0.7);color:#fff;font-size:0.7em;padding:0.2em 0.6em;border-radius:2px">${itemLabel}</span>
        <div style="font-size:0.9em;font-weight:600;color:#fff">${albumName}</div>
        <div style="font-size:0.75em;color:#ccc">${artistName}</div>
      </div>
    </a>`
  }

  return `<a href="${artistLink}" class="masonry-tile" target="_blank" rel="noopener">
    <div style="padding:1.5em;min-height:120px;display:flex;flex-direction:column;justify-content:flex-end;background:var(--surface)">
      <span style="font-size:0.7em;color:var(--dim);margin-bottom:0.5em">${itemLabel}</span>
      <div style="font-size:1.1em;font-weight:600;color:var(--fg)">${albumName}</div>
      <div style="font-size:0.8em;color:var(--muted);margin-top:0.5em">${artistName}</div>
    </div>
  </a>`
}

function renderMasonryTile(purchase) {
  const media = _mediaDetails.get(purchase.mediaId)
  if (!media) return ''

  const artistAddr = (media.artist || '').toLowerCase()
  const domain = _domainMap.get(artistAddr)
  const artistLink = domain ? `https://${escapeHtml(domain)}/art?media=${purchase.mediaId}` : '#'
  const title = escapeHtml(media.title || 'untitled')
  const artistName = domain || `${artistAddr.slice(0, 6)}...${artistAddr.slice(-4)}`
  const ct = (media.contentType || '').toLowerCase()

  let inner = ''

  if (ct.startsWith('audio/') || ct === 'audio') {
    const imgSrc = media.metadataCid
      ? `/api/img?url=${encodeURIComponent(ipfsUrl(media.metadataCid))}&w=400`
      : media.ipfsCid ? `/api/img?url=${encodeURIComponent(ipfsUrl(media.ipfsCid))}&w=400` : ''
    inner = `
      <img src="${imgSrc}" loading="lazy" alt="${title}" onerror="this.style.display='none'">
      <div class="masonry-tile-overlay">
        <div style="font-size:0.9em;font-weight:600;color:#fff">${title}</div>
        <div style="font-size:0.75em;color:#ccc">${escapeHtml(artistName)}</div>
      </div>`
  } else if (ct.startsWith('video/') || ct === 'video') {
    const thumbSrc = media.ipfsCid ? `/api/video-thumb?cid=${media.ipfsCid}&w=400` : ''
    inner = `
      <img src="${thumbSrc}" loading="lazy" alt="${title}">
      <div class="masonry-tile-overlay">
        <i class="ph ph-play-circle" style="font-size:2em;color:#fff"></i>
        <div style="font-size:0.9em;color:#fff;margin-top:0.25em">${title}</div>
      </div>`
  } else if (ct.startsWith('image/') || ct === 'image') {
    const imgSrc = media.ipfsCid ? `/api/img?url=${encodeURIComponent(ipfsUrl(media.ipfsCid))}&w=400` : ''
    inner = `
      <img src="${imgSrc}" loading="lazy" alt="${title}">
      <div class="masonry-tile-overlay">
        <div style="font-size:0.9em;color:#fff">${title}</div>
      </div>`
  } else if (ct.startsWith('text/') || ct === 'writing') {
    inner = `
      <div style="padding:1.5em;min-height:120px;display:flex;flex-direction:column;justify-content:flex-end;background:var(--surface)">
        <div style="font-size:1.1em;font-weight:600;color:var(--fg)">${title}</div>
        <div style="font-size:0.8em;color:var(--muted);margin-top:0.5em">${escapeHtml(artistName)}</div>
      </div>`
  } else {
    // Unknown contentType: try video-thumb for singles, fallback chain
    const coverSrc = media.metadataCid
      ? `/api/img?url=${encodeURIComponent(ipfsUrl(media.metadataCid))}&w=400` : ''
    const thumbSrc = media.ipfsCid ? `/api/video-thumb?cid=${media.ipfsCid}&w=400` : ''
    const imgFallback = media.ipfsCid ? `/api/img?url=${encodeURIComponent(ipfsUrl(media.ipfsCid))}&w=400` : ''
    if (coverSrc) {
      inner = `
        <img src="${coverSrc}" loading="lazy" alt="${title}" onerror="this.style.display='none'">
        <div class="masonry-tile-overlay">
          <div style="font-size:0.9em;font-weight:600;color:#fff">${title}</div>
          <div style="font-size:0.75em;color:#ccc">${escapeHtml(artistName)}</div>
        </div>`
    } else if (thumbSrc) {
      inner = `
        <img src="${thumbSrc}" loading="lazy" alt="${title}" onerror="this.style.display='none'">
        <div class="masonry-tile-overlay" style="position:relative">
          <div style="padding:1.5em;min-height:120px;display:flex;flex-direction:column;justify-content:flex-end;background:var(--surface)">
            <div style="font-size:1.1em;font-weight:600;color:var(--fg)">${title}</div>
            <div style="font-size:0.8em;color:var(--muted);margin-top:0.5em">${escapeHtml(artistName)}</div>
          </div>
        </div>`
    } else {
      inner = `
        <div style="padding:1.5em;min-height:120px;display:flex;flex-direction:column;justify-content:flex-end;background:var(--surface)">
          <div style="font-size:1.1em;font-weight:600;color:var(--fg)">${title}</div>
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
