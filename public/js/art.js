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
  return `<button class="media-ref-btn" data-ref-media="${escapeHtml(String(item.mediaId))}" data-ref-title="${title}" data-ref-artist="${artist}" data-ref-art="${art}" data-ref-src="${src}" data-ref-type="${escapeHtml(type)}" title="${t('music.writeAbout')}" style="background:none;border:1px solid var(--border);color:var(--fg);font-size:0.85em;cursor:pointer;padding:0.25em 0.8ch;border-radius:3px;display:inline-flex;align-items:center;gap:0.3ch"><i class="ph ph-note-pencil"></i></button>`
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
  const artist = params.get('artist')
  const album = params.get('album')
  const vanity = parseVanityPath()

  try {
    // Cross-artist item — collection cards link here so they render on
    // the current tenant instead of jumping off to the source artist's
    // site. `?artist=<domain>` names the source; `?album=<name>&alias=`
    // (music) or `?type=<t>&item=<slug>` (everything else) name the
    // item. When neither album nor type context is supplied we still
    // fall through to the on-chain single-media render so a bare
    // `?media=<id>&artist=<domain>` behaves like `?media=<id>` did.
    if (artist && album && params.get('alias')) {
      await renderCrossArtistAlbum(params, loadingEl, contentEl)
    } else if (artist && type && params.get('item')) {
      await renderCrossArtistItem(params, loadingEl, contentEl)
    } else if (mediaId !== null) {
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

// Fetch another artist's public site.json via /api/artist-site. Returns
// `{ modules: [...] }` (same shape as /site.json for module lookup).
// Same 3-attempt retry pattern the local-site fetchers use — the
// multi-tenant proxy occasionally returns a transient 5xx during
// rebuild windows and we don't want a single blip to strand the page.
async function _fetchCrossArtistSite(artistDomain) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(`/api/artist-site?domain=${encodeURIComponent(artistDomain)}`, { signal: _artAbortController?.signal })
      if (!resp.ok) continue
      const data = await resp.json()
      return data
    } catch (e) {
      if (attempt < 2) await new Promise(r => setTimeout(r, 500 * (attempt + 1)))
    }
  }
  return null
}

// Album view for another artist's release. The album lives in the
// source artist's `music` module under aliases[].albums[], keyed by
// alias name + album title. Same render path as the local album view
// (renderMusicAlbum) so it inherits play-all + track list + buy
// buttons for free.
async function renderCrossArtistAlbum(params, loadingEl, contentEl) {
  const artistDomain = params.get('artist')
  const albumName = params.get('album')
  const aliasName = params.get('alias')
  const site = await _fetchCrossArtistSite(artistDomain)
  if (!site) { loadingEl.textContent = 'could not load artist site'; return }
  const mod = (site.modules || []).find(m => m.type === 'music')
  if (!mod) { loadingEl.textContent = 'this artist has no music module'; return }
  const aliases = mod.data?.aliases || []
  const aliasIdx = aliases.findIndex(a => a.name === aliasName || slugify(a.name) === slugify(aliasName))
  if (aliasIdx === -1) { loadingEl.textContent = 'artist alias not found'; return }
  const alias = aliases[aliasIdx]
  const albums = alias.albums || []
  const albumIdx = albums.findIndex(al => al.title === albumName || slugify(al.title) === slugify(albumName))
  if (albumIdx === -1) { loadingEl.textContent = 'album not found'; return }
  loadingEl.style.display = 'none'
  renderMusicAlbum(contentEl, alias, albums[albumIdx], aliasIdx, albumIdx)
}

// Cross-artist singleton (gallery / film / video / audio / writing).
// The item lives in the source artist's module of the given type;
// we match by slug against the module's items array and delegate
// to the same per-type renderer the local site uses.
// Single-source items reader + dispatch helper used by the three
// per-type entry points (renderVanityItem, renderLocalItem,
// renderCrossArtistItem). Music is out — album is not a single-item
// shape. Everything else routes through here so the same
// per-type switch doesn't live in three places.
function _itemsFor(mod, type) {
  if (type === 'gallery') return mod.data?.images || []
  if (type === 'film')    return mod.data?.works || []
  if (type === 'writing') return mod.data?.publications || []
  return Array.isArray(mod.data) ? mod.data : (mod.data?.items || [])
}
function _dispatchRender(type, contentEl, item, idx) {
  if (type === 'gallery') { renderGalleryImage(contentEl, item, idx); return true }
  if (type === 'film')    { renderFilmWork(contentEl, item);           return true }
  if (type === 'video')   { renderVideoItem(contentEl, item);          return true }
  if (type === 'audio')   { renderAudioItem(contentEl, item, idx);     return true }
  if (type === 'writing') { renderWritingItem(contentEl, item, idx);   return true }
  return false
}

async function renderCrossArtistItem(params, loadingEl, contentEl) {
  const artistDomain = params.get('artist')
  const type = params.get('type')
  const itemSlug = params.get('item')
  const site = await _fetchCrossArtistSite(artistDomain)
  if (!site) { loadingEl.textContent = 'could not load artist site'; return }
  const mod = (site.modules || []).find(m => m.type === type)
  if (!mod) { loadingEl.textContent = 'module not found'; return }
  const items = _itemsFor(mod, type)
  const idx = items.findIndex(it => slugify(it.title || '') === itemSlug)
  if (idx === -1) { loadingEl.textContent = 'item not found'; return }
  loadingEl.style.display = 'none'
  if (!_dispatchRender(type, contentEl, items[idx], idx)) loadingEl.textContent = 'unsupported type'
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
    const items = _itemsFor(mod, type)
    const idx = items.findIndex(it => slugify(it.title) === slug)
    if (idx === -1) { if (!_trySlugRedirect(site)) loadingEl.textContent = 'item not found'; return }
    loadingEl.style.display = 'none'
    if (!_dispatchRender(type, contentEl, items[idx], idx)) loadingEl.textContent = 'unsupported type'
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
  } else if (type === 'gallery' || type === 'film' || type === 'video' || type === 'audio' || type === 'writing') {
    // All five single-item types collapse into the shared _itemsFor +
    // _dispatchRender pair. The index param name is legacy per-type
    // (image / work / item) — read whichever one is present.
    const idx = parseInt(params.get('image') || params.get('work') || params.get('item'))
    if (isNaN(idx)) { loadingEl.textContent = `${type} not found`; return }
    const items = _itemsFor(mod, type)
    const item = items[idx]
    if (!item) { loadingEl.textContent = `${type} not found`; return }
    loadingEl.style.display = 'none'
    _dispatchRender(type, contentEl, item, idx)
  } else {
    loadingEl.textContent = 'unsupported type'
  }
}

function renderMusicAlbum(el, alias, album, aliasIdx, albumIdx) {
  let html = ''

  // Hero: cover art + metadata side-by-side (stacks on mobile).
  // Layout lives in .art-album-hero (public/style.css) — the inline
  // <style> block the render function used to emit at the bottom
  // has been moved to CSS with the rest of the primitives.
  html += `<div class="art-album-hero">`

  if (album.art) {
    const artUrl = album.art.includes('/api/') ? album.art : `/api/img?url=${encodeURIComponent(album.art)}&w=600`
    html += `<div class="art-album-hero-cover"><img src="${escapeHtml(artUrl)}" alt="${escapeHtml(album.title)}" loading="lazy"></div>`
  }

  html += `<div class="art-album-hero-meta">`
  html += `<h1 style="font-size:clamp(1.5em, 4vw, 2.2em);margin:0 0 0.3em;font-weight:700;letter-spacing:-0.02em">${escapeHtml(album.title)}</h1>`
  html += `<div style="color:var(--muted);margin-bottom:1em;font-size:0.95em">${t('art.by')} ${escapeHtml(album.artist || alias.name)}${album.year ? ` (${album.year})` : ''}</div>`
  if (album.collab) {
    // Collab attribution routes through the collection filter so the
    // "with <artist>" link stays on the current tenant rather than
    // jumping off to the collaborator's own site — matches the ask
    // that everything a collection item touches renders locally.
    const collabDomain = escapeHtml(album.collab.from || '')
    html += `<div style="color:var(--dim);font-size:0.85em;margin-bottom:0.5em">with <a href="/collection?artist=${encodeURIComponent(album.collab.from || '')}" style="color:var(--accent)">${collabDomain}</a></div>`
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
    html += `<button class="feed-buy-btn feed-card-btn green" data-media-id="${escapeHtml(allMediaIds)}" data-price="${escapeHtml(String(totalWei))}" data-title="${escapeHtml(album.title || 'album')} (${buyableTracks.length} tracks)">${t('art.buy')} <span data-eth-wei="${escapeHtml(String(totalWei))}" data-fiat-primary="true"></span></button>`
  }
  // Overflow menu for queue + reference
  const firstListedTrack = (album.tracks || []).find(t => t.mediaId != null)
  if (playableTracks.length > 0 || firstListedTrack) {
    const queueData = playableTracks.length > 0 ? encodeURIComponent(JSON.stringify(playableTracks.map(t => ({ src: t.src, title: t.title, artist: album.artist || alias.name, art: album.art || '' })))) : ''
    html += `<div class="track-overflow-wrap" style="position:relative;display:inline-flex">`
    html += `<button class="track-overflow-btn" style="background:none;border:none;color:var(--dim);font-size:1.1em;cursor:pointer;padding:0.2em 0.35ch;min-width:44px;min-height:44px;display:inline-flex;align-items:center;justify-content:center"><i class="ph ph-dots-three"></i></button>`
    html += `<div class="track-overflow-menu" style="display:none;position:absolute;right:0;bottom:100%;background:color-mix(in srgb, var(--fg) 6%, var(--bg));backdrop-filter:blur(40px);-webkit-backdrop-filter:blur(40px);border:1px solid var(--border);border-radius:12px;padding:0.4em 0;z-index:100;min-width:200px;box-shadow:0 -4px 16px rgba(0,0,0,0.2)">`
    if (queueData) {
      html += `<button class="album-queue-btn track-overflow-item" data-queue="${queueData}" style="display:flex;align-items:center;gap:0.75ch;width:100%;background:none;border:none;color:var(--fg);font-family:inherit;font-size:0.95em;padding:0.7em 1.2em;cursor:pointer;text-align:left;border-radius:8px"><i class="ph ph-plus"></i> ${t('music.addToQueue')}</button>`
    }
    if (firstListedTrack) {
      html += `<button class="album-ref-btn track-overflow-item" data-ref-media="${firstListedTrack.mediaId}" data-ref-title="${escapeHtml(album.title)}" data-ref-artist="${escapeHtml(album.artist || alias.name)}" data-ref-art="${escapeHtml(album.art || '')}" data-ref-src="${escapeHtml(playableTracks[0]?.src || '')}" style="display:flex;align-items:center;gap:0.75ch;width:100%;background:none;border:none;color:var(--fg);font-family:inherit;font-size:0.95em;padding:0.7em 1.2em;cursor:pointer;text-align:left;border-radius:8px"><i class="ph ph-note-pencil"></i> ${t('music.writeAbout')}</button>`
    }
    html += `</div></div>`
  }
  if (album.links && Object.keys(album.links).length) {
    for (const [platform, url] of Object.entries(album.links)) {
      if (url && /^https?:\/\//i.test(url)) html += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="art-external">${escapeHtml(platform)}</a>`
    }
  }
  html += `</div>`
  html += `</div></div>` // close metadata + hero

  // track list (skip empty/deleted tracks)
  const validTracks = (album.tracks || []).filter(t => t.title || t.src)
  if (validTracks.length) {
    html += `<div class="art-tracklist" style="margin-bottom:1.5em">`
    validTracks.forEach((track, i) => {
      html += `<div class="album-track">`
      html += `<span class="art-num" style="color:var(--dim);min-width:2ch;text-align:right;font-size:0.9em">${i + 1}.</span>`
      html += track.mediaId != null
        ? `<a href="/art?media=${track.mediaId}" class="track-title art-detail-link" style="flex:1;font-size:0.95em;color:inherit">${escapeHtml(track.title)}</a>`
        : `<span class="track-title" style="flex:1;font-size:0.95em">${escapeHtml(track.title)}</span>`
      if (track.duration) {
        const m = Math.floor(track.duration / 60)
        const s = String(track.duration % 60).padStart(2, '0')
        html += `<span class="art-num" style="color:var(--dim);font-size:0.85em">${m}:${s}</span>`
      }
      if (track.src) {
        html += `<button class="track-play-btn" data-track-src="${escapeHtml(track.src)}" data-track-title="${escapeHtml(track.title)}" data-track-artist="${escapeHtml(album.artist || alias.name)}" style="background:none;border:none;color:var(--fg);cursor:pointer;padding:0.2em 0.35ch;font-size:1.1em;min-width:44px;min-height:44px;display:inline-flex;align-items:center;justify-content:center"><i class="ph ph-play"></i></button>`
      }
      if (track.mediaId !== undefined && track.mediaId !== null) {
        const priceWei = track.mediaPrice || '0'
        html += `<button class="track-buy-btn feed-card-btn green track-buy-btn-compact" data-media-id="${escapeHtml(String(track.mediaId))}" data-price="${escapeHtml(priceWei)}" data-title="${escapeHtml(track.title || '')}">${t('art.buy')} <span data-eth-wei="${escapeHtml(priceWei)}" data-fiat-primary="true"></span></button>`
      }
      if (track.src || track.mediaId != null) {
        html += `<div class="track-overflow-wrap" style="position:relative;display:inline-flex">`
        html += `<button class="track-overflow-btn" style="background:none;border:none;color:var(--dim);font-size:1.1em;cursor:pointer;padding:0.2em 0.35ch;min-width:44px;min-height:44px;display:inline-flex;align-items:center;justify-content:center"><i class="ph ph-dots-three"></i></button>`
        html += `<div class="track-overflow-menu" style="display:none;position:absolute;right:0;bottom:100%;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:0.3em 0;z-index:100;min-width:160px;box-shadow:0 -2px 8px rgba(0,0,0,0.3)">`
        if (track.src) {
          html += `<button class="track-queue-btn track-overflow-item" data-src="${escapeHtml(track.src)}" data-title="${escapeHtml(track.title)}" data-artist="${escapeHtml(album.artist || alias.name)}" data-art="${escapeHtml(album.art || '')}" style="display:flex;align-items:center;gap:0.75ch;width:100%;background:none;border:none;color:var(--fg);font-family:inherit;font-size:0.85em;padding:0.5em 1em;cursor:pointer;text-align:left"><i class="ph ph-plus"></i> ${t('music.addToQueue')}</button>`
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
    // Gallery is the exception to the 400px cover cap — the image IS
    // the piece, no crop. `.art-cover-full` disables the max-height.
    html += `<div class="art-cover art-cover-full"><img src="${escapeHtml(fullUrl)}" alt="${escapeHtml(image.title || '')}" loading="lazy"></div>`
  }

  if (image.title) html += `<h1 class="art-title">${escapeHtml(image.title)}</h1>`
  const meta = []
  if (image.medium) meta.push(image.medium)
  if (image.year) meta.push(String(image.year))
  if (image.series) meta.push(image.series)
  if (image.dimensions) meta.push(image.dimensions)
  if (image.location) meta.push(image.location)
  if (meta.length) html += `<div class="art-meta">${escapeHtml(meta.join(' -- '))}</div>`

  if (image.description) html += `<div class="art-description">${escapeHtml(image.description)}</div>`
  if (image.awards) html += `<div class="art-awards">${escapeHtml(image.awards)}</div>`

  // buy + ref buttons
  if (image.mediaId !== undefined && image.mediaId !== null) {
    const priceWei = image.mediaPrice || '0'
    const isFree = Number(priceWei) === 0
    html += `<div class="art-action-row"><button class="track-buy-btn feed-card-btn green" data-media-id="${escapeHtml(String(image.mediaId))}" data-price="${escapeHtml(priceWei)}" data-eth-wei="${escapeHtml(priceWei)}" data-title="${escapeHtml(image.title || '')}">${isFree ? t('art.collectFree') : t('art.buy')} ${!isFree ? `<span data-eth-wei="${escapeHtml(priceWei)}" data-fiat-primary="true"></span>` : ''}</button>${refButtonHtml(image, { art: image.src, type: 'gallery' })}</div>`
  }

  if (image.url && /^https?:\/\//i.test(image.url)) {
    html += `<div style="margin-bottom:1.5em"><a href="${escapeHtml(image.url)}" target="_blank" rel="noopener noreferrer" class="art-external">view external</a></div>`
  }

  el.innerHTML = html
  wireArtDetailBuyButtons(el)
  wireRefButtons(el)
}

function renderFilmWork(el, work) {
  let html = ''

  if (work.poster) {
    const posterUrl = work.poster.includes('/api/') ? work.poster : `/api/img?url=${encodeURIComponent(work.poster)}&w=800`
    html += `<div class="art-cover"><img src="${escapeHtml(posterUrl)}" alt="${escapeHtml(work.title || '')}" loading="lazy"></div>`
  }

  html += `<h1 class="art-title">${escapeHtml(work.title)}</h1>`
  const meta = []
  if (work.role) meta.push(work.role)
  if (work.director) meta.push(`dir. ${work.director}`)
  if (work.year) meta.push(String(work.year))
  if (work.runtime) meta.push(work.runtime)
  if (work.venue) meta.push(work.venue)
  if (meta.length) html += `<div class="art-meta">${escapeHtml(meta.join(' -- '))}</div>`

  if (work.description) html += `<div class="art-description">${escapeHtml(work.description)}</div>`
  if (work.awards) html += `<div class="art-awards">${escapeHtml(work.awards)}</div>`
  if (work.cast) html += `<div class="art-meta-secondary">cast: ${escapeHtml(work.cast)}</div>`

  // action buttons
  html += `<div style="display:flex;gap:1ch;align-items:center;margin-bottom:1.5em;flex-wrap:wrap">`
  if (work.mediaId !== undefined && work.mediaId !== null) {
    const priceWei = work.mediaPrice || '0'
    const isFree = Number(priceWei) === 0
    html += `<button class="track-buy-btn feed-card-btn green" data-media-id="${escapeHtml(String(work.mediaId))}" data-price="${escapeHtml(priceWei)}" data-eth-wei="${escapeHtml(priceWei)}" data-title="${escapeHtml(work.title || '')}">${isFree ? t('art.collectFree') : t('art.buy')} ${!isFree ? `<span data-eth-wei="${escapeHtml(priceWei)}" data-fiat-primary="true"></span>` : ''}</button>`
  }
  html += refButtonHtml(work, { src: work.video || '', type: 'film' })
  html += `</div>`

  if (work.video) {
    html += `<div class="art-video-lazy-frame" style="margin-bottom:1.5em"><video src="${escapeHtml(work.video)}" controls preload="none" playsinline style="max-width:100%;height:100%"></video></div>`
  }

  if (work.url && /^https?:\/\//i.test(work.url)) {
    html += `<div style="margin-bottom:1.5em"><a href="${escapeHtml(work.url)}" target="_blank" rel="noopener noreferrer" class="art-external">watch external</a></div>`
  }

  el.innerHTML = html
  wireArtDetailBuyButtons(el)
  wireRefButtons(el)
}

function renderVideoItem(el, item) {
  let html = ''
  html += `<h1 class="art-title">${escapeHtml(item.title)}</h1>`
  const meta = []
  if (item.year) meta.push(String(item.year))
  if (item.collaborators) meta.push(item.collaborators)
  if (meta.length) html += `<div class="art-meta">${escapeHtml(meta.join(' -- '))}</div>`
  if (item.description) html += `<div class="art-description">${escapeHtml(item.description)}</div>`

  // buy + ref buttons (before video so it's visible without scrolling)
  if (item.mediaId !== undefined && item.mediaId !== null) {
    const priceWei = item.mediaPrice || '0'
    const isFree = Number(priceWei) === 0
    html += `<div class="art-action-row"><button class="track-buy-btn feed-card-btn green" data-media-id="${escapeHtml(String(item.mediaId))}" data-price="${escapeHtml(priceWei)}" data-eth-wei="${escapeHtml(priceWei)}" data-title="${escapeHtml(item.title || '')}">${isFree ? t('art.collectFree') : t('art.buy')} ${!isFree ? `<span data-eth-wei="${escapeHtml(priceWei)}" data-fiat-primary="true"></span>` : ''}</button>${refButtonHtml(item, { art: item.poster || item.thumbnail || '', type: 'video' })}</div>`
  }

  // video player — same lazy pattern as /video page with auto-generated
  // thumbnail. Reserve 16:9 on the poster wrapper so a non-16:9 poster
  // doesn't shift the layout when mini-player.js swaps it for the real
  // <video> element on click (principle 9).
  if (item.src) {
    let posterUrl = item.poster || item.thumbnail || ''
    if (!posterUrl) {
      const cidMatch = item.src.match(/\/api\/ipfs-proxy\/([A-Za-z0-9]+)/)
      if (cidMatch) posterUrl = `/api/video-thumb?cid=${cidMatch[1]}&w=960`
    }
    html += `<div style="margin-bottom:1.5em">
      <div class="video-lazy art-video-lazy-frame" data-src="${escapeHtml(item.src)}" data-poster="${escapeHtml(posterUrl)}" data-title="${escapeHtml(item.title || '')}">
        ${posterUrl ? `<img src="${escapeHtml(posterUrl)}" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover;cursor:pointer">` : `<div style="display:flex;align-items:center;justify-content:center;cursor:pointer;width:100%;height:100%"><span style="color:var(--muted)">play</span></div>`}
      </div>
    </div>`
  }

  // Outbound link — external hosting (Vimeo, YouTube, festival page).
  if (item.url && /^https?:\/\//i.test(item.url)) {
    html += `<div style="margin-bottom:1.5em"><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" class="art-external">watch external</a></div>`
  }

  el.innerHTML = html
  wireArtDetailBuyButtons(el)
  wireRefButtons(el)
}

function renderAudioItem(el, item, idx) {
  let html = ''
  html += `<h1 class="art-title">${escapeHtml(item.title || 'untitled')}</h1>`
  const meta = []
  if (item.year) meta.push(String(item.year))
  if (item.artist || item.credit) meta.push(item.artist || item.credit)
  if (meta.length) html += `<div class="art-meta">${escapeHtml(meta.join(' -- '))}</div>`
  if (item.description) html += `<div class="art-description">${escapeHtml(item.description)}</div>`
  if (item.src) html += `<div style="margin-bottom:1.5em"><button class="track-play-btn" data-track-src="${escapeHtml(item.src)}" data-track-title="${escapeHtml(item.title || '')}" data-track-artist="${escapeHtml(item.artist || item.credit || '')}">play</button></div>`

  if (item.mediaId !== undefined && item.mediaId !== null) {
    const priceWei = item.mediaPrice || '0'
    const isFree = Number(priceWei) === 0
    html += `<div class="art-action-row"><button class="track-buy-btn feed-card-btn green" data-media-id="${escapeHtml(String(item.mediaId))}" data-price="${escapeHtml(priceWei)}" data-eth-wei="${escapeHtml(priceWei)}" data-title="${escapeHtml(item.title || '')}">${isFree ? t('art.collectFree') : t('art.buy')} ${!isFree ? `<span data-eth-wei="${escapeHtml(priceWei)}" data-fiat-primary="true"></span>` : ''}</button>${refButtonHtml(item, { src: item.src || '', type: 'audio' })}</div>`
  }

  if (item.url && /^https?:\/\//i.test(item.url)) html += `<div style="margin-bottom:1.5em"><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" class="art-external">listen external</a></div>`

  el.innerHTML = html
  wireArtDetailBuyButtons(el)
  wireRefButtons(el)
}

function renderWritingItem(el, item, idx) {
  let html = ''

  if (item.cover) {
    const coverUrl = item.cover.includes('/api/') ? item.cover : `/api/img?url=${encodeURIComponent(item.cover)}&w=600`
    html += `<div class="art-cover"><img src="${escapeHtml(coverUrl)}" alt="${escapeHtml(item.title || '')}" loading="lazy"></div>`
  }

  html += `<h1 class="art-title">${escapeHtml(item.title)}</h1>`
  const meta = []
  if (item.publication) meta.push(item.publication)
  if (item.publisher) meta.push(item.publisher)
  if (item.year) meta.push(String(item.year))
  if (item.language) meta.push(`[${item.language}]`)
  if (meta.length) html += `<div class="art-meta">${escapeHtml(meta.join(' -- '))}</div>`

  const meta2 = []
  if (item.isbn) meta2.push(`ISBN ${item.isbn}`)
  if (item.pages) meta2.push(`${item.pages} pages`)
  if (item.form) meta2.push(item.form)
  if (meta2.length) html += `<div class="art-meta-secondary">${escapeHtml(meta2.join(' -- '))}</div>`
  if (item.awards) html += `<div class="art-awards">${escapeHtml(item.awards)}</div>`

  if (item.description) html += `<div class="art-description">${escapeHtml(item.description)}</div>`

  // Standardized external link chrome — plain muted text, matches
  // gallery / film / video / audio. The old "read" pill was a
  // one-off box that violated principle 3 across the renderer set.
  if (item.url && /^https?:\/\//i.test(item.url)) html += `<div style="margin-bottom:1.5em"><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" class="art-external">read external</a></div>`
  if (item.excerpt) html += `<div class="art-excerpt">${escapeHtml(item.excerpt)}</div>`

  if (item.mediaId !== undefined && item.mediaId !== null) {
    const priceWei = item.mediaPrice || '0'
    const isFree = Number(priceWei) === 0
    html += `<div class="art-action-row"><button class="track-buy-btn feed-card-btn green" data-media-id="${escapeHtml(String(item.mediaId))}" data-price="${escapeHtml(priceWei)}" data-eth-wei="${escapeHtml(priceWei)}" data-title="${escapeHtml(item.title || '')}">${isFree ? t('art.collectFree') : t('art.buy')} ${!isFree ? `<span data-eth-wei="${escapeHtml(priceWei)}" data-fiat-primary="true"></span>` : ''}</button>${refButtonHtml(item, { type: 'writing' })}</div>`
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
    html += `<div class="art-cover">
      <img src="/api/img?url=${encodeURIComponent(coverUrl)}&w=600" alt="${escapeHtml(title)}" loading="lazy">
      ${isAudioContent && mediaUrl ? `<button class="track-play-btn feed-collected-play-overlay" data-track-src="${escapeHtml(mediaUrl)}" data-track-title="${escapeHtml(title)}" data-track-artist="${escapeHtml(artistDomain)}" style="width:56px;height:56px;font-size:20px"><i class="ph ph-play"></i></button>` : ''}
    </div>`
  }

  // title + artist + price
  // Artist attribution routes to /collection?artist=<domain> — same
  // on-tenant destination the collection card and collab attribution
  // use, so clicking the artist stays on this Praxis instance rather
  // than jumping off to the artist's own site.
  html += `<h1 class="art-onchain-title">${escapeHtml(title)}</h1>`
  html += `<div class="art-meta" style="margin-bottom:0.75em">${t('art.by')} <a href="/collection?artist=${encodeURIComponent(artistDomain)}" class="art-detail-link">${escapeHtml(artistDomain)}</a>${priceNum > 0 ? ` — <span data-eth-wei="${escapeHtml(price.toString())}" data-fiat-primary="true" style="color:var(--fg)"></span>` : ''}</div>`

  // action row
  html += `<div class="art-action-row">`

  // Audio play is now on the cover art overlay; video uses poster click

  // buy button (or superseded notice)
  if (isSuperseded) {
    html += `<span style="color:var(--muted);font-size:0.85em">this listing has been updated</span>`
    html += `<a href="/art?media=${activeListingId}" style="color:var(--accent);font-size:0.85em;margin-left:1ch">view current listing</a>`
  } else {
    html += `<button id="art-buy-btn" class="feed-card-btn green" data-media-id="${escapeHtml(String(mediaId))}" data-price="${escapeHtml(price.toString())}">${priceNum > 0 ? t('art.buy') : t('art.collectFree')}</button>`
  }

  if (mediaUrl) {
    html += `<a href="${escapeHtml(mediaUrl)}" download="${escapeHtml(title)}" class="art-action-ghost"><i class="ph ph-download-simple"></i> download</a>`
  }

  html += `</div>`

  // inline media player for PDF/video/image
  let pendingPdf = false
  if (mediaUrl && contentType === 'application/pdf') {
    // Reserve the PDF viewer's vertical space so the async
    // `renderMedia` fill (setTimeout in the finally block below)
    // doesn't push the collectors + supply blocks down after paint.
    html += `<div id="art-pdf-embed" class="art-pdf-slot"></div>`
    pendingPdf = true
  } else if (mediaUrl && contentType.startsWith('video/')) {
    const cidMatch = mediaUrl.match(/ipfs-proxy\/([A-Za-z0-9]+)/)
    const posterUrl = cidMatch ? `/api/video-thumb?cid=${cidMatch[1]}&w=960` : ''
    html += `<div style="margin-bottom:1.5em">
      <div class="video-player" style="max-width:100%">
        <div class="video-lazy" data-src="${escapeHtml(mediaUrl)}" data-poster="${escapeHtml(posterUrl)}" data-title="${escapeHtml(title)}">
          ${posterUrl
            ? `<img src="${escapeHtml(posterUrl)}" alt="" loading="lazy" style="cursor:pointer;width:100%;aspect-ratio:16/9;object-fit:cover">`
            : `<div style="background:#111;display:flex;align-items:center;justify-content:center;cursor:pointer;aspect-ratio:16/9"><span style="color:var(--muted)">play</span></div>`}
        </div>
        <button class="track-queue-btn" data-src="${escapeHtml(mediaUrl)}" data-title="${escapeHtml(title)}" data-type="video" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:0.9em;padding:0.2em 0.5ch;margin-top:0.25em" title="add to queue"><i class="ph ph-plus"></i> queue</button>
      </div>
    </div>`
  } else if (mediaUrl && contentType.startsWith('image/')) {
    const imgSrc = mediaUrl.includes('/api/ipfs-proxy/') ? `/api/img?url=${encodeURIComponent(mediaUrl)}&w=1200` : mediaUrl
    html += `<div style="margin-bottom:1.5em"><img src="${escapeHtml(imgSrc)}" alt="${escapeHtml(title)}" style="max-width:100%" loading="lazy"></div>`
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
  html += `<div class="art-onchain-supply">${supplyStr} collected</div>`

  // Collectors section — loaded async after initial render; the
  // reserved slot holds ~one line of vertical space so its fill
  // doesn't reflow the layout below (there is nothing below on
  // this page today, but the reserved slot keeps principle 9
  // honest as more sections get appended in the future).
  html += `<div id="art-collectors" class="art-collectors-slot"></div>`

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
            ? `<a href="/collection?artist=${encodeURIComponent(domain)}" class="art-detail-link">${escapeHtml(domain)}</a>`
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
        video.playsInline = true
        video.setAttribute('playsinline', '')
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
