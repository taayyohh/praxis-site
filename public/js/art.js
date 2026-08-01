// Art detail page — universal portfolio item viewer
// Routes: /art?type=music&alias=0&album=1 (local) or /art?media=0 (on-chain)
import { query } from './ponder.js'
import { ipfsUrl, escapeHtml, resolveAddresses, resolveDomain, formatEthAmount, getPublicClient, registerPage, slugify } from './utils.js'
import { purchaseMedia, getArtistMedia, annotateRelistings } from './media.js'
import { resolveContentTypes, classifyContentType } from './utils.js'
import { formatEther } from './vendor.js'

import { MEDIA_ABI, getMediaAddress } from './contracts.js'
import { t } from './i18n.js'
import './feed-cards.js' // registers global .feed-buy-btn click delegation

let _artAbortController = null
const _VANITY_TYPES = new Set(['music', 'gallery', 'film', 'video', 'audio', 'writing', 'demos'])

registerPage('art-page', initArt)

// Render a reference button for any media item
// opts: { title, artist, art (thumbnail url), src (playable audio url), type (music|gallery|video|audio|writing|film) }
function refButtonHtml(item, opts = {}) {
  if (item.mediaId == null) return ''
  const title = escapeHtml(opts.title || item.title || '')
  const artist = escapeHtml(opts.artist || '')
  const art = escapeHtml(opts.art || item.art || '')
  const src = escapeHtml(opts.src || '')
  const type = opts.type || ''
  return `<button class="media-ref-btn" data-ref-media="${item.mediaId}" data-ref-title="${title}" data-ref-artist="${artist}" data-ref-art="${art}" data-ref-src="${src}" data-ref-type="${type}" title="${t('music.writeAbout')}" style="background:none;border:1px solid var(--border);color:var(--fg);font-size:0.85em;cursor:pointer;padding:0.25em 0.8ch;border-radius:3px;display:inline-flex;align-items:center;gap:0.3ch"><i class="ph ph-note-pencil"></i></button>`
}

// Wire all reference buttons in a container
function wireRefButtons(container) {
  container.querySelectorAll('.media-ref-btn, .track-ref-btn, .album-ref-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const mediaRef = {
        mediaId: btn.dataset.refMedia,
        title: btn.dataset.refTitle || '',
        artist: btn.dataset.refArtist || '',
        art: btn.dataset.refArt || '',
        src: btn.dataset.refSrc || '',
        type: btn.dataset.refType || ''
      }
      const params = new URLSearchParams({ ref: mediaRef.mediaId, refTitle: mediaRef.title, refArtist: mediaRef.artist, refArt: mediaRef.art, refSrc: mediaRef.src, refType: mediaRef.type })
      window.location.href = '/write?' + params.toString()
    })
  })
}

function parseVanityPath() {
  const segs = window.location.pathname.split('/').filter(Boolean)
  if (segs.length >= 2 && _VANITY_TYPES.has(segs[0])) {
    return { type: segs[0], slugs: segs.slice(1).map(decodeURIComponent) }
  }
  return null
}

async function initArt() {
  _artAbortController?.abort()
  _artAbortController = new AbortController()

  const loadingEl = document.getElementById('art-loading')
  const contentEl = document.getElementById('art-content')
  if (!loadingEl || !contentEl) return

  loadingEl.style.display = ''
  loadingEl.innerHTML = '<div class="praxis-loader"></div>'
  contentEl.innerHTML = ''

  const params = new URLSearchParams(window.location.search)
  const mediaId = params.get('media')
  const type = params.get('type')
  const vanity = parseVanityPath()

  try {
    if (mediaId !== null) {
      await renderOnChainMedia(mediaId, loadingEl, contentEl)
    } else if (vanity) {
      await renderVanityItem(vanity, loadingEl, contentEl)
    } else if (type) {
      await renderLocalItem(params, loadingEl, contentEl)
    } else {
      loadingEl.textContent = 'no item specified'
    }
  } catch (e) {
    console.warn('art page error:', e)
    loadingEl.textContent = 'could not load item'
  }
}

// --- Vanity URL: /music/alias-slug/album-slug, /gallery/slug, etc. ---

async function renderVanityItem(vanity, loadingEl, contentEl) {
  let site = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch('/site.json', { signal: _artAbortController?.signal })
      if (!resp.ok) continue
      site = await resp.json()
      break
    } catch (e) {
      if (attempt < 2) await new Promise(r => setTimeout(r, 500 * (attempt + 1)))
    }
  }
  if (!site) { loadingEl.textContent = 'could not load site data'; return }

  const { type, slugs } = vanity
  const modules = site.modules || []
  const mod = modules.find(m => m.type === type)
  if (!mod) { loadingEl.textContent = 'module not found'; return }

  if (type === 'music') {
    const aliasSlug = slugs[0]
    const albumSlug = slugs[1]
    const aliases = mod.data?.aliases || []
    for (let ai = 0; ai < aliases.length; ai++) {
      if (slugify(aliases[ai].name) !== aliasSlug) continue
      const albums = aliases[ai].albums || []
      for (let ali = 0; ali < albums.length; ali++) {
        if (slugify(albums[ali].title) === albumSlug) {
          loadingEl.style.display = 'none'
          return renderMusicAlbum(contentEl, aliases[ai], albums[ali], ai, ali)
        }
      }
    }
    if (!_trySlugRedirect(site)) loadingEl.textContent = 'album not found'
  } else {
    const slug = slugs[0]
    const items = type === 'gallery' ? (mod.data?.images || [])
      : type === 'film' ? (mod.data?.works || [])
      : type === 'writing' ? (mod.data?.publications || [])
      : Array.isArray(mod.data) ? mod.data : (mod.data?.items || [])
    const idx = items.findIndex(it => slugify(it.title) === slug)
    if (idx === -1) { if (!_trySlugRedirect(site)) loadingEl.textContent = 'item not found'; return }
    loadingEl.style.display = 'none'
    if (type === 'gallery') renderGalleryImage(contentEl, items[idx], idx)
    else if (type === 'film') renderFilmWork(contentEl, items[idx])
    else if (type === 'video') renderVideoItem(contentEl, items[idx])
    else if (type === 'audio') renderAudioItem(contentEl, items[idx], idx)
    else if (type === 'writing') renderWritingItem(contentEl, items[idx], idx)
    else loadingEl.textContent = 'unsupported type'
  }
}

function _trySlugRedirect(site) {
  const key = window.location.pathname.slice(1)
  const target = site?._slugRedirects?.[key]
  if (target) {
    window.location.replace('/' + target)
    return true
  }
  return false
}

// --- Local portfolio item: /art?type=music&alias=0&album=1 ---

async function renderLocalItem(params, loadingEl, contentEl) {
  const type = params.get('type')

  // Retry site.json fetch — intermittent 5xx from multi-tenant routing or
  // JSON parse failures (stale HTML cache) would otherwise throw through
  // the outer try/catch as a generic "could not load item" message.
  let site = null
  let lastErr = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch('/site.json')
      if (!resp.ok) { lastErr = new Error(`site.json ${resp.status}`); continue }
      site = await resp.json()
      break
    } catch (e) {
      lastErr = e
      if (attempt < 2) await new Promise(r => setTimeout(r, 500 * (attempt + 1)))
    }
  }
  if (!site) {
    console.warn('site.json fetch failed after 3 attempts:', lastErr?.message)
    loadingEl.textContent = 'could not load site data'
    return
  }

  const modules = site.modules || []
  const mod = modules.find(m => m.type === type)
  if (!mod) { loadingEl.textContent = 'module not found'; return }

  if (type === 'music') {
    const aliasIdx = parseInt(params.get('alias'))
    const albumIdx = parseInt(params.get('album'))
    const alias = mod.data?.aliases?.[aliasIdx]
    if (!alias) { loadingEl.textContent = 'alias not found'; return }
    const album = alias.albums?.[albumIdx]
    if (!album) { loadingEl.textContent = 'album not found'; return }
    loadingEl.style.display = 'none'
    renderMusicAlbum(contentEl, alias, album, aliasIdx, albumIdx)
  } else if (type === 'gallery') {
    const imageIdx = parseInt(params.get('image'))
    const images = mod.data?.images || []
    const image = images[imageIdx]
    if (!image) { loadingEl.textContent = 'image not found'; return }
    loadingEl.style.display = 'none'
    renderGalleryImage(contentEl, image, imageIdx)
  } else if (type === 'film') {
    const workIdx = parseInt(params.get('work'))
    const works = mod.data?.works || []
    const work = works[workIdx]
    if (!work) { loadingEl.textContent = 'work not found'; return }
    loadingEl.style.display = 'none'
    renderFilmWork(contentEl, work)
  } else if (type === 'video') {
    const itemIdx = parseInt(params.get('item'))
    if (isNaN(itemIdx)) { loadingEl.textContent = 'video not found'; return }
    const items = Array.isArray(mod.data) ? mod.data : mod.data?.items || []
    const item = items[itemIdx]
    if (!item) { loadingEl.textContent = 'video not found'; return }
    loadingEl.style.display = 'none'
    renderVideoItem(contentEl, item)
  } else if (type === 'audio') {
    const itemIdx = parseInt(params.get('item'))
    const items = Array.isArray(mod.data) ? mod.data : mod.data?.items || []
    const item = items[itemIdx]
    if (!item) { loadingEl.textContent = 'item not found'; return }
    loadingEl.style.display = 'none'
    renderAudioItem(contentEl, item, itemIdx)
  } else if (type === 'writing') {
    const itemIdx = parseInt(params.get('item'))
    const pubs = mod.data?.publications || []
    const item = pubs[itemIdx]
    if (!item) { loadingEl.textContent = 'item not found'; return }
    loadingEl.style.display = 'none'
    renderWritingItem(contentEl, item, itemIdx)
  } else {
    loadingEl.textContent = 'unsupported type'
  }
}

function renderMusicAlbum(el, alias, album, aliasIdx, albumIdx) {
  let html = ''

  // Hero: cover art + metadata side-by-side (stacks on mobile)
  html += `<div class="art-album-hero" style="display:flex;gap:2em;align-items:flex-start;margin-bottom:2em">`

  if (album.art) {
    const artUrl = album.art.includes('/api/') ? album.art : `/api/img?url=${encodeURIComponent(album.art)}&w=600`
    html += `<div style="flex-shrink:0;width:min(300px, 45%)"><img src="${artUrl}" alt="${escapeHtml(album.title)}" style="width:100%;display:block;border-radius:6px" loading="lazy"></div>`
  }

  html += `<div style="flex:1;min-width:0">`
  html += `<h1 style="font-size:clamp(1.5em, 4vw, 2.2em);margin:0 0 0.3em;font-weight:700;letter-spacing:-0.02em">${escapeHtml(album.title)}</h1>`
  html += `<div style="color:var(--muted);margin-bottom:1em;font-size:0.95em">${t('art.by')} ${escapeHtml(album.artist || alias.name)}${album.year ? ` (${album.year})` : ''}</div>`
  if (album.collab) {
    html += `<div style="color:var(--dim);font-size:0.85em;margin-bottom:0.5em">with <a href="https://${escapeHtml(album.collab.from)}" style="color:var(--accent)">${escapeHtml(album.collab.from)}</a></div>`
  }

  if (album.genre) html += `<div style="color:var(--dim);font-size:0.85em;margin-bottom:0.5em">${escapeHtml(album.genre)}</div>`

  if (album.description) {
    html += `<div style="color:var(--fg);font-size:0.9em;line-height:1.6;margin-bottom:1em;max-height:12em;overflow-y:auto">${escapeHtml(album.description)}</div>`
  }

  // action buttons
  html += `<div style="display:flex;gap:1ch;align-items:center;flex-wrap:wrap">`
  const playableTracks = (album.tracks || []).filter(t => t.src)
  if (playableTracks.length > 0) {
    const queueData = encodeURIComponent(JSON.stringify(playableTracks.map(t => ({ src: t.src, title: t.title, artist: album.artist || alias.name, art: album.art || '' }))))
    html += `<button class="album-play-btn feed-card-btn" data-queue="${queueData}"><i class="ph ph-play"></i> ${t('art.play')}</button>`
  }
  // Buy album button — sum all track prices
  const buyableTracks = (album.tracks || []).filter(t => t.mediaId != null && t.mediaPrice && Number(t.mediaPrice) > 0)
  if (buyableTracks.length > 0) {
    let totalWei = 0n
    for (const t of buyableTracks) { try { totalWei += BigInt(Math.round(Number(t.mediaPrice))) } catch {} }
    const allMediaIds = buyableTracks.map(t => t.mediaId).join(',')
    html += `<button class="feed-buy-btn feed-card-btn green" data-media-id="${allMediaIds}" data-price="${String(totalWei)}" data-title="${escapeHtml(album.title || 'album')} (${buyableTracks.length} tracks)">${t('art.buy')} <span data-eth-wei="${String(totalWei)}" data-fiat-primary="true"></span></button>`
  }
  // Overflow menu for queue + reference
  const firstListedTrack = (album.tracks || []).find(t => t.mediaId != null)
  if (playableTracks.length > 0 || firstListedTrack) {
    const queueData = playableTracks.length > 0 ? encodeURIComponent(JSON.stringify(playableTracks.map(t => ({ src: t.src, title: t.title, artist: album.artist || alias.name, art: album.art || '' })))) : ''
    html += `<div class="track-overflow-wrap" style="position:relative;display:inline-flex">`
    html += `<button class="track-overflow-btn" style="background:none;border:none;color:var(--dim);font-size:1.1em;cursor:pointer;padding:0.2em 0.35ch;min-width:44px;min-height:44px;display:inline-flex;align-items:center;justify-content:center"><i class="ph ph-dots-three"></i></button>`
    html += `<div class="track-overflow-menu" style="display:none;position:absolute;right:0;bottom:100%;background:color-mix(in srgb, var(--fg) 6%, var(--bg));backdrop-filter:blur(40px);-webkit-backdrop-filter:blur(40px);border:1px solid var(--border);border-radius:12px;padding:0.4em 0;z-index:100;min-width:200px;box-shadow:0 -4px 16px rgba(0,0,0,0.2)">`
    if (queueData) {
      html += `<button class="album-queue-btn track-overflow-item" data-queue="${queueData}" style="display:flex;align-items:center;gap:0.75ch;width:100%;background:none;border:none;color:var(--fg);font-family:inherit;font-size:0.95em;padding:0.7em 1.2em;cursor:pointer;text-align:left;transition:background 0.1s;border-radius:8px" onmouseover="this.style.background='var(--border)'" onmouseout="this.style.background='none'"><i class="ph ph-plus"></i> ${t('music.addToQueue')}</button>`
    }
    if (firstListedTrack) {
      html += `<button class="album-ref-btn track-overflow-item" data-ref-media="${firstListedTrack.mediaId}" data-ref-title="${escapeHtml(album.title)}" data-ref-artist="${escapeHtml(album.artist || alias.name)}" data-ref-art="${escapeHtml(album.art || '')}" data-ref-src="${escapeHtml(playableTracks[0]?.src || '')}" style="display:flex;align-items:center;gap:0.75ch;width:100%;background:none;border:none;color:var(--fg);font-family:inherit;font-size:0.95em;padding:0.7em 1.2em;cursor:pointer;text-align:left;transition:background 0.1s;border-radius:8px" onmouseover="this.style.background='var(--border)'" onmouseout="this.style.background='none'"><i class="ph ph-note-pencil"></i> ${t('music.writeAbout')}</button>`
    }
    html += `</div></div>`
  }
  if (album.links && Object.keys(album.links).length) {
    for (const [platform, url] of Object.entries(album.links)) {
      if (url) html += `<a href="${url}" target="_blank" rel="noopener" style="color:var(--muted);font-size:0.85em;padding:0.3em 1ch;border:1px solid var(--border);text-decoration:none">${escapeHtml(platform)}</a>`
    }
  }
  html += `</div>`
  html += `</div></div>` // close metadata + hero

  // Mobile stack: CSS for the hero flex
  html += `<style>.art-album-hero { text-align: left; } @media (max-width: 600px) { #art-page { margin-top: -2em; } .art-album-hero { flex-direction: column; align-items: flex-start; text-align: left; gap: 1em !important; } .art-album-hero > div:first-child { width: 100% !important; } .art-album-hero > div:first-child img { width: 100%; display: block; } }</style>`

  // track list (skip empty/deleted tracks)
  const validTracks = (album.tracks || []).filter(t => t.title || t.src)
  if (validTracks.length) {
    html += `<div class="art-tracklist" style="margin-bottom:1.5em">`
    validTracks.forEach((track, i) => {
      html += `<div class="album-track" style="display:flex;align-items:center;gap:0.75ch;padding:0.2em 0;border-bottom:1px solid var(--border)">`
      html += `<span style="color:var(--dim);min-width:2ch;text-align:right;font-size:0.9em">${i + 1}.</span>`
      html += track.mediaId != null
        ? `<a href="/art?media=${track.mediaId}" class="track-title" style="flex:1;font-size:0.95em;color:inherit;text-decoration:none">${escapeHtml(track.title)}</a>`
        : `<span class="track-title" style="flex:1;font-size:0.95em">${escapeHtml(track.title)}</span>`
      if (track.duration) {
        const m = Math.floor(track.duration / 60)
        const s = String(track.duration % 60).padStart(2, '0')
        html += `<span style="color:var(--dim);font-size:0.85em">${m}:${s}</span>`
      }
      if (track.src) {
        html += `<button class="track-play-btn" data-track-src="${track.src}" data-track-title="${escapeHtml(track.title)}" data-track-artist="${escapeHtml(album.artist || alias.name)}" style="background:none;border:none;color:var(--fg);cursor:pointer;padding:0.2em 0.35ch;font-size:1.1em;min-width:44px;min-height:44px;display:inline-flex;align-items:center;justify-content:center"><i class="ph ph-play"></i></button>`
      }
      if (track.mediaId !== undefined && track.mediaId !== null) {
        const priceWei = track.mediaPrice || '0'
        html += `<button class="track-buy-btn feed-card-btn green" data-media-id="${track.mediaId}" data-price="${priceWei}" data-title="${escapeHtml(track.title || '')}" style="font-size:0.7em">${t('art.buy')} <span data-eth-wei="${priceWei}" data-fiat-primary="true"></span></button>`
      }
      if (track.src || track.mediaId != null) {
        html += `<div class="track-overflow-wrap" style="position:relative;display:inline-flex">`
        html += `<button class="track-overflow-btn" style="background:none;border:none;color:var(--dim);font-size:1.1em;cursor:pointer;padding:0.2em 0.35ch;min-width:44px;min-height:44px;display:inline-flex;align-items:center;justify-content:center"><i class="ph ph-dots-three"></i></button>`
        html += `<div class="track-overflow-menu" style="display:none;position:absolute;right:0;bottom:100%;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:0.3em 0;z-index:100;min-width:160px;box-shadow:0 -2px 8px rgba(0,0,0,0.3)">`
        if (track.src) {
          html += `<button class="track-queue-btn track-overflow-item" data-src="${track.src}" data-title="${escapeHtml(track.title)}" data-artist="${escapeHtml(album.artist || alias.name)}" data-art="${escapeHtml(album.art || '')}" style="display:flex;align-items:center;gap:0.75ch;width:100%;background:none;border:none;color:var(--fg);font-family:inherit;font-size:0.85em;padding:0.5em 1em;cursor:pointer;text-align:left"><i class="ph ph-plus"></i> ${t('music.addToQueue')}</button>`
        }
        if (track.mediaId != null) {
          html += `<button class="track-ref-btn track-overflow-item" data-ref-media="${track.mediaId}" data-ref-title="${escapeHtml(track.title)}" data-ref-artist="${escapeHtml(album.artist || alias.name)}" data-ref-art="${escapeHtml(album.art || '')}" data-ref-src="${escapeHtml(track.src || '')}" style="display:flex;align-items:center;gap:0.75ch;width:100%;background:none;border:none;color:var(--fg);font-family:inherit;font-size:0.85em;padding:0.5em 1em;cursor:pointer;text-align:left"><i class="ph ph-note-pencil"></i> ${t('music.writeAbout')}</button>`
        }
        html += `</div></div>`
      }
      html += `</div>`
    })
    html += `</div>`
  }


  el.innerHTML = html
  wireArtDetailBuyButtons(el)
  wireRefButtons(el)

  // Wire overflow menus (··· buttons)
  const signal = _artAbortController?.signal
  el.querySelectorAll('.track-overflow-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const menu = btn.nextElementSibling
      const isOpen = menu.style.display !== 'none'
      // close all other menus
      el.querySelectorAll('.track-overflow-menu').forEach(m => m.style.display = 'none')
      menu.style.display = isOpen ? 'none' : 'block'
    }, { signal })
  })
  // Close overflow menus on outside click
  document.addEventListener('click', () => {
    el.querySelectorAll('.track-overflow-menu').forEach(m => m.style.display = 'none')
  }, { signal })
  // Close menu after clicking an item
  el.querySelectorAll('.track-overflow-item').forEach(item => {
    item.addEventListener('click', () => {
      item.closest('.track-overflow-menu').style.display = 'none'
    }, { signal })
  })
}

function renderGalleryImage(el, image, idx) {
  let html = ''

  if (image.src) {
    const fullUrl = image.src.includes('/api/') ? image.src : `/api/img?url=${encodeURIComponent(image.src)}&w=1200`
    html += `<div class="art-cover" style="margin-bottom:1.5em"><img src="${fullUrl}" alt="${escapeHtml(image.title || '')}" style="max-width:100%" loading="lazy"></div>`
  }

  if (image.title) html += `<h1 style="font-size:1.4em;margin:0 0 0.25em">${escapeHtml(image.title)}</h1>`
  const meta = []
  if (image.medium) meta.push(image.medium)
  if (image.year) meta.push(String(image.year))
  if (image.series) meta.push(image.series)
  if (meta.length) html += `<div style="color:var(--muted);margin-bottom:1em">${escapeHtml(meta.join(' -- '))}</div>`

  // buy + ref buttons
  if (image.mediaId !== undefined && image.mediaId !== null) {
    const priceWei = image.mediaPrice || '0'
    const isFree = Number(priceWei) === 0
    html += `<div style="margin-bottom:1.5em;display:flex;gap:1ch;align-items:center"><button class="track-buy-btn feed-card-btn green" data-media-id="${image.mediaId}" data-price="${priceWei}" data-eth-wei="${priceWei}" data-title="${escapeHtml(image.title || '')}">${isFree ? t('art.collectFree') : t('art.buy')} ${!isFree ? `<span data-eth-wei="${priceWei}" data-fiat-primary="true"></span>` : ''}</button>${refButtonHtml(image, { art: image.src, type: 'gallery' })}</div>`
  }

  el.innerHTML = html
  wireArtDetailBuyButtons(el)
  wireRefButtons(el)
}

function renderFilmWork(el, work) {
  let html = ''
  html += `<h1 style="font-size:1.4em;margin:0 0 0.25em">${escapeHtml(work.title)}</h1>`
  const meta = []
  if (work.role) meta.push(work.role)
  if (work.director) meta.push(`dir. ${work.director}`)
  if (work.year) meta.push(String(work.year))
  if (meta.length) html += `<div style="color:var(--muted);margin-bottom:1em">${escapeHtml(meta.join(' -- '))}</div>`

  // action buttons
  html += `<div style="display:flex;gap:1ch;align-items:center;margin-bottom:1.5em;flex-wrap:wrap">`
  if (work.mediaId !== undefined && work.mediaId !== null) {
    const priceWei = work.mediaPrice || '0'
    const isFree = Number(priceWei) === 0
    html += `<button class="track-buy-btn feed-card-btn green" data-media-id="${work.mediaId}" data-price="${priceWei}" data-eth-wei="${priceWei}" data-title="${escapeHtml(work.title || '')}">${isFree ? t('art.collectFree') : t('art.buy')} ${!isFree ? `<span data-eth-wei="${priceWei}" data-fiat-primary="true"></span>` : ''}</button>`
  }
  html += refButtonHtml(work, { src: work.video || '', type: 'film' })
  html += `</div>`

  if (work.video) {
    html += `<div style="margin-bottom:1.5em"><video src="${work.video}" controls preload="none" style="max-width:100%"></video></div>`
  }

  el.innerHTML = html
  wireArtDetailBuyButtons(el)
  wireRefButtons(el)
}

function renderVideoItem(el, item) {
  let html = ''
  html += `<h1 style="font-size:1.4em;margin:0 0 0.25em">${escapeHtml(item.title)}</h1>`
  const meta = []
  if (item.year) meta.push(String(item.year))
  if (item.collaborators) meta.push(item.collaborators)
  if (meta.length) html += `<div style="color:var(--muted);margin-bottom:0.5em">${escapeHtml(meta.join(' -- '))}</div>`
  if (item.description) html += `<p style="margin-bottom:1em">${escapeHtml(item.description)}</p>`

  // buy + ref buttons (before video so it's visible without scrolling)
  if (item.mediaId !== undefined && item.mediaId !== null) {
    const priceWei = item.mediaPrice || '0'
    const isFree = Number(priceWei) === 0
    html += `<div style="margin-bottom:1em;display:flex;gap:1ch;align-items:center"><button class="track-buy-btn feed-card-btn green" data-media-id="${item.mediaId}" data-price="${priceWei}" data-eth-wei="${priceWei}" data-title="${escapeHtml(item.title || '')}">${isFree ? t('art.collectFree') : t('art.buy')} ${!isFree ? `<span data-eth-wei="${priceWei}" data-fiat-primary="true"></span>` : ''}</button>${refButtonHtml(item, { art: item.poster || item.thumbnail || '', type: 'video' })}</div>`
  }

  // video player — same lazy pattern as /video page with auto-generated thumbnail
  if (item.src) {
    let posterUrl = item.poster || item.thumbnail || ''
    if (!posterUrl) {
      const cidMatch = item.src.match(/\/api\/ipfs-proxy\/([A-Za-z0-9]+)/)
      if (cidMatch) posterUrl = `/api/video-thumb?cid=${cidMatch[1]}&w=960`
    }
    html += `<div style="margin-bottom:1.5em">
      <div class="video-lazy" data-src="${item.src}" data-poster="${posterUrl}" data-title="${escapeHtml(item.title || '')}">
        ${posterUrl ? `<img src="${posterUrl}" alt="" loading="lazy" style="width:100%;cursor:pointer">` : `<div style="background:#111;display:flex;align-items:center;justify-content:center;cursor:pointer;aspect-ratio:16/9"><span style="color:var(--muted)">play</span></div>`}
      </div>
    </div>`
  }

  el.innerHTML = html
  wireArtDetailBuyButtons(el)
  wireRefButtons(el)
}

function renderAudioItem(el, item, idx) {
  let html = ''
  html += `<h1 style="font-size:1.4em;margin:0 0 0.25em">${escapeHtml(item.title || 'untitled')}</h1>`
  if (item.description) html += `<p style="color:var(--fg);margin-bottom:1em">${escapeHtml(item.description)}</p>`
  if (item.year) html += `<div style="color:var(--muted);margin-bottom:1em">${item.year}</div>`
  if (item.src) html += `<audio src="${item.src}" controls preload="none" style="width:100%;margin-bottom:1.5em"></audio>`

  if (item.mediaId !== undefined && item.mediaId !== null) {
    const priceWei = item.mediaPrice || '0'
    const isFree = Number(priceWei) === 0
    html += `<div style="margin-bottom:1.5em;display:flex;gap:1ch;align-items:center"><button class="track-buy-btn feed-card-btn green" data-media-id="${item.mediaId}" data-price="${priceWei}" data-eth-wei="${priceWei}" data-title="${escapeHtml(item.title || '')}">${isFree ? t('art.collectFree') : t('art.buy')} ${!isFree ? `<span data-eth-wei="${priceWei}" data-fiat-primary="true"></span>` : ''}</button>${refButtonHtml(item, { src: item.src || '', type: 'audio' })}</div>`
  }

  if (item.url) html += `<div style="margin-bottom:1.5em"><a href="${item.url}" target="_blank" rel="noopener" style="color:var(--muted);font-size:0.9em">listen</a></div>`

  el.innerHTML = html
  wireArtDetailBuyButtons(el)
  wireRefButtons(el)
}

function renderWritingItem(el, item, idx) {
  let html = ''
  html += `<h1 style="font-size:1.4em;margin:0 0 0.25em">${escapeHtml(item.title)}</h1>`
  const meta = []
  if (item.publication) meta.push(item.publication)
  if (item.year) meta.push(String(item.year))
  if (meta.length) html += `<div style="color:var(--muted);margin-bottom:1em">${escapeHtml(meta.join(' -- '))}</div>`

  if (item.url) html += `<div style="margin-bottom:1.5em"><a href="${item.url}" target="_blank" rel="noopener" style="background:none;border:1px solid var(--border);color:var(--fg);font-family:inherit;font-size:0.85em;padding:0.3em 1.5ch;text-decoration:none;display:inline-block">read</a></div>`
  if (item.excerpt) html += `<div style="margin-bottom:1.5em;color:var(--fg);line-height:1.6">${escapeHtml(item.excerpt)}</div>`

  if (item.mediaId !== undefined && item.mediaId !== null) {
    const priceWei = item.mediaPrice || '0'
    const isFree = Number(priceWei) === 0
    html += `<div style="margin-bottom:1.5em;display:flex;gap:1ch;align-items:center"><button class="track-buy-btn feed-card-btn green" data-media-id="${item.mediaId}" data-price="${priceWei}" data-eth-wei="${priceWei}" data-title="${escapeHtml(item.title || '')}">${isFree ? t('art.collectFree') : t('art.buy')} ${!isFree ? `<span data-eth-wei="${priceWei}" data-fiat-primary="true"></span>` : ''}</button>${refButtonHtml(item, { type: 'writing' })}</div>`
  }

  el.innerHTML = html
  wireArtDetailBuyButtons(el)
  wireRefButtons(el)
}

// --- On-chain media: /art?media=0 ---

async function renderOnChainMedia(mediaId, loadingEl, contentEl) {
  const mediaAddr = getMediaAddress()
  if (!mediaAddr) { loadingEl.textContent = 'media contract not configured'; return }

  const pc = await getPublicClient()

  const [mediaResult, collabResult] = await Promise.all([
    pc.readContract({ address: mediaAddr, abi: MEDIA_ABI, functionName: 'media', args: [BigInt(mediaId)] }),
    pc.readContract({ address: mediaAddr, abi: MEDIA_ABI, functionName: 'getCollaborators', args: [BigInt(mediaId)] }).catch(() => [[], []]),
  ])

  const [artist, title, ipfsCid, metadataCid, price, maxSupply, totalMinted] = mediaResult
  const [collabAddrs, collabSplits] = collabResult

  if (!title && !ipfsCid) { loadingEl.textContent = 'media not found'; return }

  loadingEl.style.display = 'none'

  // resolve domains, check superseded status, detect content type, and fetch registry fallback in parallel
  const addressesToResolve = [artist, ...collabAddrs].filter(Boolean)
  let domainMap = {}
  let isSuperseded = false
  let activeListingId = null
  let contentType = ''

  const registryAddr = document.body.dataset.registry
  const ARTISTS_ABI = [{ name: 'artists', type: 'function', inputs: [{ type: 'address' }], outputs: [{ name: 'domain', type: 'string' }, { name: 'registeredAt', type: 'uint256' }], stateMutability: 'view' }]

  const [domainResult, supersededResult, headResult, registryResult] = await Promise.all([
    resolveAddresses(query, addressesToResolve).catch(() => ({})),
    ipfsCid ? getArtistMedia(artist).then(artistMedia => {
      if (artistMedia.items.length > 0) {
        annotateRelistings(artistMedia.items)
        const thisItem = artistMedia.items.find(m => String(m.id) === String(mediaId))
        if (thisItem?.superseded) return { isSuperseded: true, activeListingId: thisItem.activeListingId }
      }
      return { isSuperseded: false, activeListingId: null }
    }).catch(() => ({ isSuperseded: false, activeListingId: null })) : Promise.resolve({ isSuperseded: false, activeListingId: null }),
    ipfsCid ? fetch(ipfsUrl(ipfsCid), { method: 'HEAD' }).then(resp =>
      (resp.headers.get('content-type') || '').split(';')[0].trim()
    ).catch(() => '') : Promise.resolve(''),
    registryAddr ? pc.readContract({ address: registryAddr, abi: ARTISTS_ABI, functionName: 'artists', args: [artist] }).then(([d]) => d || null).catch(() => null) : Promise.resolve(null),
  ])

  domainMap = domainResult
  isSuperseded = supersededResult.isSuperseded
  activeListingId = supersededResult.activeListingId
  contentType = headResult

  // fallback: if resolveAddresses didn't find the artist, use the registry result
  if (!domainMap[artist.toLowerCase()] && registryResult) {
    domainMap[artist.toLowerCase()] = registryResult
  }

  const artistDomain = resolveDomain(domainMap, artist)

  const priceEth = formatEther(price)
  const priceNum = parseFloat(priceEth)
  const mediaUrl = ipfsCid ? ipfsUrl(ipfsCid) : ''
  let coverUrl = metadataCid ? ipfsUrl(metadataCid) : ''

  // fallback: try to find cover art from artist's site.json
  if (!coverUrl && ipfsCid && artistDomain) {
    try {
      const siteResp = await fetch(`https://${artistDomain}/api/site`)
      if (siteResp.ok) {
        const siteData = await siteResp.json()
        for (const mod of (siteData.modules || [])) {
          if (mod.type !== 'music') continue
          for (const alias of (mod.data?.aliases || [])) {
            for (const album of (alias.albums || [])) {
              for (const track of (album.tracks || [])) {
                if (track.src?.includes(ipfsCid)) {
                  const artMatch = album.art?.match(/ipfs-proxy\/([A-Za-z0-9]+)/)
                  if (artMatch) coverUrl = ipfsUrl(artMatch[1])
                }
              }
            }
          }
        }
      }
    } catch {}
  }

  let html = ''

  // cover art / media preview — with play overlay for audio
  const isAudioContent = contentType.startsWith('audio/') || contentType === 'application/ogg'
  if (coverUrl) {
    html += `<div class="art-cover" style="margin-bottom:1.5em;position:relative;display:inline-block">
      <img src="/api/img?url=${encodeURIComponent(coverUrl)}&w=600" alt="${escapeHtml(title)}" style="max-width:100%;max-height:400px;display:block" loading="lazy">
      ${isAudioContent && mediaUrl ? `<button class="track-play-btn feed-collected-play-overlay" data-track-src="${mediaUrl}" data-track-title="${escapeHtml(title)}" data-track-artist="${escapeHtml(artistDomain)}" style="width:56px;height:56px;font-size:20px"><i class="ph ph-play"></i></button>` : ''}
    </div>`
  }

  // title + artist + price
  html += `<h1 style="font-size:1.4em;margin:0 0 0.25em">${escapeHtml(title)}</h1>`
  html += `<div style="color:var(--muted);margin-bottom:0.75em">${t('art.by')} <a href="https://${escapeHtml(artistDomain)}" style="color:var(--muted)">${escapeHtml(artistDomain)}</a>${priceNum > 0 ? ` — <span data-eth-wei="${price.toString()}" data-fiat-primary="true" style="color:var(--fg)"></span>` : ''}</div>`

  // action row
  html += `<div style="display:flex;gap:0.6em;align-items:center;margin-bottom:1.5em;flex-wrap:wrap">`

  // Audio play is now on the cover art overlay; video uses poster click

  // buy button (or superseded notice)
  if (isSuperseded) {
    html += `<span style="color:var(--muted);font-size:0.85em">this listing has been updated</span>`
    html += `<a href="/art?media=${activeListingId}" style="color:var(--accent);font-size:0.85em;margin-left:1ch">view current listing</a>`
  } else {
    html += `<button id="art-buy-btn" class="feed-card-btn green" data-media-id="${mediaId}" data-price="${price.toString()}">${priceNum > 0 ? t('art.buy') : t('art.collectFree')}</button>`
  }

  if (mediaUrl) {
    html += `<a href="${mediaUrl}" download="${escapeHtml(title)}" class="feed-card-btn" style="text-decoration:none"><i class="ph ph-download-simple"></i> download</a>`
  }

  html += `</div>`

  // inline media player for PDF/video/image
  let pendingPdf = false
  if (mediaUrl && contentType === 'application/pdf') {
    html += `<div id="art-pdf-embed" style="margin-bottom:1.5em"></div>`
    pendingPdf = true
  } else if (mediaUrl && contentType.startsWith('video/')) {
    const cidMatch = mediaUrl.match(/ipfs-proxy\/([A-Za-z0-9]+)/)
    const posterUrl = cidMatch ? `/api/video-thumb?cid=${cidMatch[1]}&w=960` : ''
    html += `<div style="margin-bottom:1.5em">
      <div class="video-player" style="max-width:100%">
        <div class="video-lazy" data-src="${mediaUrl}" data-poster="${posterUrl}" data-title="${escapeHtml(title)}">
          ${posterUrl
            ? `<img src="${posterUrl}" alt="" loading="lazy" style="cursor:pointer;width:100%;aspect-ratio:16/9;object-fit:cover">`
            : `<div style="background:#111;display:flex;align-items:center;justify-content:center;cursor:pointer;aspect-ratio:16/9"><span style="color:var(--muted)">play</span></div>`}
        </div>
        <button class="track-queue-btn" data-src="${mediaUrl}" data-title="${escapeHtml(title)}" data-type="video" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:0.9em;padding:0.2em 0.5ch;margin-top:0.25em" title="add to queue"><i class="ph ph-plus"></i> queue</button>
      </div>
    </div>`
  } else if (mediaUrl && contentType.startsWith('image/')) {
    const imgSrc = mediaUrl.includes('/api/ipfs-proxy/') ? `/api/img?url=${encodeURIComponent(mediaUrl)}&w=1200` : mediaUrl
    html += `<div style="margin-bottom:1.5em"><img src="${imgSrc}" alt="${escapeHtml(title)}" style="max-width:100%" loading="lazy"></div>`
  }

  // collaborators + splits
  if (collabAddrs.length > 0) {
    html += `<div style="margin-bottom:1.5em"><span style="color:var(--dim)">collaborators: </span>`
    const totalSplit = collabSplits.reduce((a, b) => a + b, 0n)
    const parts = []
    for (let i = 0; i < collabAddrs.length; i++) {
      const dom = resolveDomain(domainMap, collabAddrs[i])
      const pct = totalSplit > 0n ? Number((collabSplits[i] * 10000n) / totalSplit) / 100 : 0
      parts.push(`<a href="https://${escapeHtml(dom)}" style="color:var(--fg)">${escapeHtml(dom)}</a> (${pct}%)`)
    }
    html += parts.join(` <span style="color:var(--dim)">&middot;</span> `)
    html += `</div>`
  }

  // supply info
  const supplyStr = maxSupply > 0n ? `${totalMinted.toString()} / ${maxSupply.toString()}` : `${totalMinted.toString()}`
  html += `<div style="color:var(--dim);font-size:0.85em">${supplyStr} collected</div>`

  // collectors section — loaded async after initial render
  html += `<div id="art-collectors" style="margin-top:1.5em"></div>`

  contentEl.innerHTML = html

  if (pendingPdf) {
    const { renderMedia } = await import('./utils.js')
    const el = document.getElementById('art-pdf-embed')
    if (el) el.innerHTML = renderMedia(mediaUrl, title)
  }

  // Load collectors list
  if (totalMinted > 0n) {
    query(`query Collectors($id: BigInt!) { mediaPurchases(where: { mediaId: $id }, limit: 50, orderBy: "timestamp", orderDirection: "desc") { items { buyer timestamp } } }`, { id: String(mediaId) })
      .then(async data => {
        const purchases = data.mediaPurchases?.items || []
        if (!purchases.length) return
        const buyers = [...new Set(purchases.map(p => p.buyer))]
        const domains = await resolveAddresses(query, buyers).catch(() => ({}))
        const collectorsEl = document.getElementById('art-collectors')
        if (!collectorsEl) return
        const names = buyers.map(addr => {
          const domain = domains[addr.toLowerCase()]
          return domain
            ? `<a href="https://${escapeHtml(domain)}" style="color:var(--muted);text-decoration:none" target="_blank">${escapeHtml(domain)}</a>`
            : `<span style="color:var(--dim)">${escapeHtml(addr.slice(0, 6) + '...' + addr.slice(-4))}</span>`
        })
        collectorsEl.innerHTML = `<div style="border-top:1px solid var(--border);padding-top:1em"><span style="color:var(--dim);font-size:0.8em;text-transform:uppercase;letter-spacing:0.05em">collectors</span><div style="margin-top:0.5em;color:var(--muted);font-size:0.85em;line-height:1.8">${names.join(' · ')}</div></div>`
      }).catch(() => {})
  }

  // attach buy button handler
  const buyBtn = document.getElementById('art-buy-btn')
  if (buyBtn) {
    // check ownership
    checkOwnership(mediaId, buyBtn)

    buyBtn.addEventListener('click', async () => {
      if (buyBtn.disabled) return
      const { showPurchaseConfirmation } = await import('./pay.js')
      showPurchaseConfirmation(mediaId, price.toString(), title || 'untitled')
    })
  }

  // Sync playing state on track buttons
  function syncPlayState() {
    const src = window._playerCurrentSrc?.() || ''
    const playing = window.isPlaying?.() || false
    contentEl.querySelectorAll('.track-play-btn[data-track-src]').forEach(btn => {
      const icon = btn.querySelector('i')
      if (!icon) return
      icon.className = (playing && src && btn.dataset.trackSrc === src) ? 'ph ph-pause' : 'ph ph-play'
    })
  }
  syncPlayState()
  const signal = _artAbortController?.signal
  window.addEventListener('player-play', syncPlayState, { signal })
  window.addEventListener('player-pause', syncPlayState, { signal })
  window.addEventListener('player-ended', syncPlayState, { signal })

  // wire lazy video player (click poster to play inline)
  contentEl.querySelectorAll('.video-lazy').forEach(lazy => {
    const clickTarget = lazy.querySelector('img, div')
    if (clickTarget) {
      clickTarget.addEventListener('click', (e) => {
        e.stopPropagation() // prevent player.js document-level .video-lazy handler from also firing
        if (window.pauseTrack) window.pauseTrack() // stop any active audio before inline video starts
        const src = lazy.dataset.src
        const videoTitle = lazy.dataset.title || ''
        const video = document.createElement('video')
        video.src = src
        video.controls = true
        video.autoplay = true
        video.preload = 'metadata'
        video.playsinline = true
        video.style.cssText = 'width:100%;aspect-ratio:16/9;background:#000'
        lazy.replaceWith(video)
      })
    }
  })

  // Mini-player handles floating video overlay via IntersectionObserver (mini-player.js)
}

// Wire buy buttons for local portfolio items on art detail pages
function wireArtDetailBuyButtons(container) {
  const signal = _artAbortController?.signal
  const buyBtns = [...container.querySelectorAll('.track-buy-btn[data-media-id]')]

  buyBtns.forEach(buyBtn => {
    buyBtn.addEventListener('click', async () => {
      if (buyBtn.disabled) return
      const title = buyBtn.dataset.title || 'untitled'
      const { showPurchaseConfirmation } = await import('./pay.js')
      showPurchaseConfirmation(buyBtn.dataset.mediaId, buyBtn.dataset.price || '0', title)
    }, { signal })
  })

  batchCheckOwnership(buyBtns)

  window.addEventListener('wallet-connected', () => {
    const unchecked = buyBtns.filter(b => !b.disabled)
    if (unchecked.length) batchCheckOwnership(unchecked)
  }, { signal })
}

async function batchCheckOwnership(buyBtns) {
  if (!buyBtns.length) return
  const addr = window.getWalletAddress?.()
  if (!addr) return
  const mediaAddr = getMediaAddress()
  if (!mediaAddr) return
  try {
    const pc = await getPublicClient()
    const calls = buyBtns.map(btn => ({
      address: mediaAddr, abi: MEDIA_ABI, functionName: 'balanceOf', args: [addr, BigInt(btn.dataset.mediaId)],
    }))
    const results = await pc.multicall({ contracts: calls })
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'success' && results[i].result > 0n) {
        buyBtns[i].textContent = t('art.owned')
        buyBtns[i].style.borderColor = 'var(--accent)'
        buyBtns[i].style.color = 'var(--accent)'
        buyBtns[i].disabled = true
      }
    }
  } catch {}
}
