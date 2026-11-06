// Art detail page — universal portfolio item viewer
// Routes: /art?type=music&alias=0&album=1 (local) or /art?media=0 (on-chain)
import { query } from './ponder.js'
import { ipfsUrl, escapeHtml, resolveAddresses, resolveDomain, formatEthAmount, getPublicClient, registerPage, slugify } from './utils.js'
import { purchaseMedia, getArtistMedia, annotateRelistings, renderPublishToOrgPanel } from './media.js'
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

// --- Phase 13 shared helpers for the 5 per-type renderers.
// Promoted "write about this" affordance, hero-first (not buried in
// overflow). Same shape as buy/play so the actions row reads flat.
function writeAboutAction(item, opts = {}) {
  if (item == null || item.mediaId == null) return ''
  const title = escapeHtml(opts.title || item.title || '')
  const artist = escapeHtml(opts.artist || '')
  const art = escapeHtml(opts.art || item.art || '')
  const src = escapeHtml(opts.src || '')
  const type = opts.type || ''
  return `<button class="media-ref-btn art-detail-action art-detail-action--write" type="button" data-ref-media="${escapeHtml(String(item.mediaId))}" data-ref-title="${title}" data-ref-artist="${artist}" data-ref-art="${art}" data-ref-src="${src}" data-ref-type="${escapeHtml(type)}" aria-label="${t('music.writeAbout')}"><i class="ph ph-note-pencil" aria-hidden="true"></i><span>write</span></button>`
}
// Share — navigator.share when available, clipboard fallback, with a
// short "copied" affirmation. Encourages distribution, which the
// network benefits from compounding over time.
function shareAction(title) {
  // draft copy — "share" is lowercase per voice; no new i18n key yet.
  return `<button class="art-detail-action art-detail-action--share" type="button" data-art-share="1" data-share-title="${escapeHtml(title || '')}" aria-label="share"><i class="ph ph-share-fat" aria-hidden="true"></i><span>share</span></button>`
}
function wireShareButtons(container) {
  const signal = _artAbortController?.signal
  container.querySelectorAll('[data-art-share]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault()
      e.stopPropagation()
      const url = window.location.href
      const title = btn.dataset.shareTitle || document.title || ''
      try {
        if (navigator.share) {
          await navigator.share({ title, url })
          return
        }
      } catch {}
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(url)
          const prev = btn.innerHTML
          btn.innerHTML = '<i class="ph ph-check" aria-hidden="true"></i><span>copied</span>'
          setTimeout(() => { if (btn.isConnected) btn.innerHTML = prev }, 1800)
        }
      } catch {}
    }, { signal })
  })
}
// Buy action in the hero shape. Keeps the existing `track-buy-btn`
// class so wireArtDetailBuyButtons picks it up; adds .art-detail-action
// so it inherits the pill height and typography of its sibling
// actions (write / share / primary). The free case keeps `collect
// free` copy from i18n.
function buyAction(item) {
  if (item == null || item.mediaId == null) return ''
  const priceWei = item.mediaPrice || '0'
  const isFree = Number(priceWei) === 0
  const label = isFree ? t('art.collectFree') : t('art.buy')
  const priceSpan = isFree ? '' : ` <span data-eth-wei="${escapeHtml(priceWei)}" data-fiat-primary="true"></span>`
  return `<button class="track-buy-btn art-detail-action art-detail-action--buy" type="button" data-media-id="${escapeHtml(String(item.mediaId))}" data-price="${escapeHtml(priceWei)}" data-eth-wei="${escapeHtml(priceWei)}" data-title="${escapeHtml(item.title || '')}" aria-label="${escapeHtml(label)}"><i class="ph ph-plus" aria-hidden="true"></i><span>${escapeHtml(label)}</span>${priceSpan}</button>`
}
// Space-Mono metadata row — one <span> per piece so .art-detail-meta-row
// can insert whitespace between siblings via ::before. No dot
// separators (phase 10 killed those across the catalog).
function metaRow(pieces) {
  const spans = (pieces || []).filter(Boolean).map(p => `<span>${escapeHtml(p)}</span>`).join('')
  return spans ? `<div class="art-detail-meta-row">${spans}</div>` : ''
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
    // SSR tags the page with a cross-artist hint when a /music/alias/album
    // URL lands on an artist who doesn't own that alias. Dispatch to the
    // same cross-artist path collection cards already use so the album
    // renders inline here (no redirect, no "album not found").
    const crossMeta = document.querySelector('meta[name="praxis-cross-album"]')
    if (artist && album && params.get('alias')) {
      await renderCrossArtistAlbum(params, loadingEl, contentEl)
    } else if (artist && type && params.get('item')) {
      await renderCrossArtistItem(params, loadingEl, contentEl)
    } else if (vanity && vanity.type === 'music' && crossMeta) {
      try {
        const hint = JSON.parse(crossMeta.content)
        const p = new URLSearchParams()
        p.set('artist', hint.domain)
        p.set('alias', hint.aliasName)
        p.set('album', hint.albumTitle)
        await renderCrossArtistAlbum(p, loadingEl, contentEl)
      } catch (e) { console.warn('cross-album hint parse failed:', e); await renderVanityItem(vanity, loadingEl, contentEl) }
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
  // Any match miss falls through to the SSR-hinted /music/<alias>/<album>
  // path so a stale /art?album=… URL (e.g. a bookmark from before
  // collection switched to vanity paths) still lands on the album
  // inline instead of a dead-end "album not found".
  const slugFallback = () => {
    if (!aliasName || !albumName) return false
    try { window.location.replace(`/music/${slugify(aliasName)}/${slugify(albumName)}`); return true } catch { return false }
  }
  const site = await _fetchCrossArtistSite(artistDomain)
  if (!site) { if (!slugFallback()) loadingEl.textContent = 'could not load artist site'; return }
  const mod = (site.modules || []).find(m => m.type === 'music')
  if (!mod) { if (!slugFallback()) loadingEl.textContent = 'this artist has no music module'; return }
  const aliases = mod.data?.aliases || []
  const aliasIdx = aliases.findIndex(a => a.name === aliasName || slugify(a.name) === slugify(aliasName))
  if (aliasIdx === -1) { if (!slugFallback()) loadingEl.textContent = 'artist alias not found'; return }
  const alias = aliases[aliasIdx]
  const albums = alias.albums || []
  const albumIdx = albums.findIndex(al => al.title === albumName || slugify(al.title) === slugify(albumName))
  if (albumIdx === -1) { if (!slugFallback()) loadingEl.textContent = 'album not found'; return }
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
  // Phase 12 — see public/style.css ".art-album" block for the
  // editorial rhythm this renders into. Cover + meta grid at the
  // top, fat tracklist below, collectors strip + external chips at
  // the tail. The write-about-this affordance was promoted out of
  // the ··· overflow because writing about work is the whole
  // platform's fulcrum, not a buried utility.

  const artistLabel = album.artist || alias.name
  const playableTracks = (album.tracks || []).filter(tr => tr.src)
  const validTracks = (album.tracks || []).filter(tr => tr.title || tr.src)
  const firstListedTrack = (album.tracks || []).find(tr => tr.mediaId != null)
  const buyableTracks = (album.tracks || []).filter(tr => tr.mediaId != null && tr.mediaPrice && Number(tr.mediaPrice) > 0)
  const albumQueueData = playableTracks.length > 0
    ? encodeURIComponent(JSON.stringify(playableTracks.map(tr => ({ src: tr.src, title: tr.title, artist: artistLabel, art: album.art || '' }))))
    : ''

  let html = ''

  // ─── Hero: cover + meta column ─────────────────────────────
  html += `<div class="art-album">`

  if (album.art) {
    const artUrl = album.art.includes('/api/') ? album.art : `/api/img?url=${encodeURIComponent(album.art)}&w=640`
    html += `<div class="art-album-cover"><img src="${escapeHtml(artUrl)}" alt="${escapeHtml(album.title || '')}" loading="lazy"></div>`
  } else {
    html += `<div class="art-album-cover" aria-hidden="true"></div>`
  }

  html += `<div class="art-album-meta">`
  html += `<h1 class="art-album-title">${escapeHtml(album.title || '')}</h1>`

  // Byline — artist name + tabular year. The year sits in a mono
  // slot so stacked bylines line up across the collection.
  html += `<div class="art-album-byline">${t('art.by')} <a class="art-album-byline-artist" href="/collection?artist=${encodeURIComponent(artistLabel)}">${escapeHtml(artistLabel)}</a>`
  if (album.year) html += `<span class="art-album-byline-year">${escapeHtml(String(album.year))}</span>`
  html += `</div>`

  // Collab attribution routes through the collection filter so the
  // "with <artist>" link stays on the current tenant.
  if (album.collab && album.collab.from) {
    html += `<div class="art-album-collab">with <a class="art-album-collab-artist" href="/collection?artist=${encodeURIComponent(album.collab.from)}">${escapeHtml(album.collab.from)}</a></div>`
  }

  // Meta strip — genre · tracks · release. Space-Mono register.
  const metaBits = []
  if (album.genre) metaBits.push(`<span>${escapeHtml(album.genre)}</span>`)
  if (validTracks.length) metaBits.push(`<span>${validTracks.length} tracks</span>`)
  if (album.releaseDate || album.released) {
    const rd = album.releaseDate || album.released
    metaBits.push(`<span>released ${escapeHtml(String(rd))}</span>`)
  }
  if (metaBits.length) html += `<div class="art-album-metaline">${metaBits.join('')}</div>`

  // Description — editorial pull-quote. The fade-out mask + "read
  // more" expansion live in CSS + a small wire below.
  if (album.description && String(album.description).trim()) {
    html += `<div class="art-album-description" data-art-album-desc>${escapeHtml(album.description)}</div>`
    html += `<button class="art-album-description-more" type="button" aria-expanded="false" hidden data-art-album-desc-more>read more</button>`
  }

  // ─── Hero CTA row — play, buy, write-about, overflow ───────
  html += `<div class="art-album-actions">`

  if (playableTracks.length > 0) {
    html += `<button class="art-album-play album-play-btn" type="button" data-queue="${albumQueueData}" aria-label="${t('art.play')}"><i class="ph ph-play-fill" aria-hidden="true"></i> ${t('art.play')}</button>`
  }

  // Buy album — sum all track prices from site.json first; if
  // site.json has no on-chain mediaId/mediaPrice (older content),
  // leave an async slot that hydrateAlbumBuyFromChain fills after
  // first paint, same grouping /works uses.
  if (buyableTracks.length > 0) {
    let totalWei = 0n
    for (const tr of buyableTracks) { try { totalWei += BigInt(Math.round(Number(tr.mediaPrice))) } catch {} }
    const allMediaIds = buyableTracks.map(tr => tr.mediaId).join(',')
    html += `<button class="art-album-buy feed-buy-btn" type="button" data-media-id="${escapeHtml(allMediaIds)}" data-price="${escapeHtml(String(totalWei))}" data-title="${escapeHtml(album.title || 'album')} (${buyableTracks.length} tracks)" aria-label="${t('art.buy')}"><i class="ph ph-shopping-bag-open" aria-hidden="true"></i> ${t('art.buy')} <span class="art-album-buy-price" data-eth-wei="${escapeHtml(String(totalWei))}" data-fiat-primary="true"></span></button>`
  } else {
    html += `<span data-album-buy-slot></span>`
  }

  // Write-about — promoted first-class action. When there's a
  // listed track we hand write.js a mediaId ref so the compose
  // editor picks up a rich card; otherwise the button opens /write
  // with a title prefill so writing about an unlisted album still
  // has a path. Keeps .album-ref-btn hook so wireRefButtons sees it.
  if (firstListedTrack) {
    html += `<button class="art-album-write album-ref-btn" type="button" data-ref-media="${firstListedTrack.mediaId}" data-ref-title="${escapeHtml(album.title || '')}" data-ref-artist="${escapeHtml(artistLabel)}" data-ref-art="${escapeHtml(album.art || '')}" data-ref-src="${escapeHtml(playableTracks[0]?.src || '')}" data-ref-type="music" aria-label="${t('music.writeAbout')}"><i class="ph ph-note-pencil" aria-hidden="true"></i> ${t('music.writeAbout')}</button>`
  } else {
    const writeHref = `/write?prefillTitle=${encodeURIComponent('on ' + (album.title || ''))}`
    html += `<a class="art-album-write" href="${escapeHtml(writeHref)}" aria-label="${t('music.writeAbout')}"><i class="ph ph-note-pencil" aria-hidden="true"></i> ${t('music.writeAbout')}</a>`
  }

  // Overflow — now carries only "add to queue" (write-about was
  // promoted out). If there's nothing playable, the overflow is
  // suppressed entirely so the hero stays clean.
  if (albumQueueData) {
    html += `<div class="track-overflow-wrap" style="position:relative;display:inline-flex">`
    html += `<button class="art-album-more track-overflow-btn" type="button" aria-label="more actions" aria-haspopup="menu" aria-expanded="false"><i class="ph ph-dots-three" aria-hidden="true"></i></button>`
    html += `<div class="track-overflow-menu" style="display:none;position:absolute;right:0;bottom:100%;background:color-mix(in srgb, var(--fg) 6%, var(--bg));backdrop-filter:blur(40px);-webkit-backdrop-filter:blur(40px);border:1px solid var(--border);border-radius:12px;padding:0.4em 0;z-index:100;min-width:200px;box-shadow:0 -4px 16px rgba(0,0,0,0.2)">`
    html += `<button class="album-queue-btn track-overflow-item" type="button" data-queue="${albumQueueData}" style="display:flex;align-items:center;gap:0.75ch;width:100%;background:none;border:none;color:var(--fg);font-family:inherit;font-size:0.95em;padding:0.7em 1.2em;cursor:pointer;text-align:left;border-radius:8px"><i class="ph ph-plus"></i> ${t('music.addToQueue')}</button>`
    html += `</div></div>`
  }

  html += `</div>` // close .art-album-actions
  html += `</div>` // close .art-album-meta
  html += `</div>` // close .art-album

  // ─── Tracklist — fat/warm rhythm ───────────────────────────
  if (validTracks.length) {
    html += `<div class="art-album-tracklist">`
    validTracks.forEach((track, i) => {
      html += `<div class="art-album-track">`
      html += `<span class="art-album-track-num">${i + 1}</span>`

      html += `<span class="art-album-track-title-cell">`
      html += track.mediaId != null
        ? `<a class="art-album-track-title" href="/art?media=${track.mediaId}">${escapeHtml(track.title || '')}</a>`
        : `<span class="art-album-track-title">${escapeHtml(track.title || '')}</span>`
      // Inline features/credits — "ft. <artist>" renders in Switzer
      // 400 muted when the track carries a features field.
      const feat = track.features || track.ft || track.feature || ''
      if (feat) html += `<span class="art-album-track-features">, ft. ${escapeHtml(String(feat))}</span>`
      html += `</span>`

      if (track.duration) {
        const m = Math.floor(track.duration / 60)
        const s = String(track.duration % 60).padStart(2, '0')
        html += `<span class="art-album-track-duration">${m}:${s}</span>`
      } else {
        html += `<span class="art-album-track-duration"></span>`
      }

      if (track.src) {
        html += `<button class="art-album-track-play track-play-btn" type="button" data-track-src="${escapeHtml(track.src)}" data-track-title="${escapeHtml(track.title || '')}" data-track-artist="${escapeHtml(artistLabel)}" aria-label="${t('art.play')} ${escapeHtml(track.title || '')}"><i class="ph ph-play" aria-hidden="true"></i></button>`
      } else {
        html += `<span></span>`
      }

      if (track.mediaId !== undefined && track.mediaId !== null) {
        const priceWei = track.mediaPrice || '0'
        html += `<button class="art-album-track-buy track-buy-btn" type="button" data-media-id="${escapeHtml(String(track.mediaId))}" data-price="${escapeHtml(priceWei)}" data-title="${escapeHtml(track.title || '')}" aria-label="${t('art.buy')} ${escapeHtml(track.title || '')}">${t('art.buy')} <span class="art-album-track-buy-price" data-eth-wei="${escapeHtml(priceWei)}" data-fiat-primary="true"></span></button>`
      } else {
        html += `<span></span>`
      }

      // Per-track overflow — stays as the secondary home for
      // queue + write-about-this-track. Only album-level write-
      // about was promoted to a first-class action.
      if (track.src || track.mediaId != null) {
        html += `<div class="track-overflow-wrap" style="position:relative;display:inline-flex">`
        html += `<button class="art-album-track-more track-overflow-btn" type="button" aria-label="more actions" aria-haspopup="menu" aria-expanded="false"><i class="ph ph-dots-three" aria-hidden="true"></i></button>`
        html += `<div class="track-overflow-menu" style="display:none;position:absolute;right:0;bottom:100%;background:color-mix(in srgb, var(--fg) 6%, var(--bg));backdrop-filter:blur(40px);-webkit-backdrop-filter:blur(40px);border:1px solid var(--border);border-radius:12px;padding:0.4em 0;z-index:100;min-width:200px;box-shadow:0 -4px 16px rgba(0,0,0,0.2)">`
        if (track.src) {
          html += `<button class="track-queue-btn track-overflow-item" type="button" data-src="${escapeHtml(track.src)}" data-title="${escapeHtml(track.title || '')}" data-artist="${escapeHtml(artistLabel)}" data-art="${escapeHtml(album.art || '')}" style="display:flex;align-items:center;gap:0.75ch;width:100%;background:none;border:none;color:var(--fg);font-family:inherit;font-size:0.9em;padding:0.6em 1.2em;cursor:pointer;text-align:left;border-radius:8px"><i class="ph ph-plus"></i> ${t('music.addToQueue')}</button>`
        }
        if (track.mediaId != null) {
          html += `<button class="track-ref-btn track-overflow-item" type="button" data-ref-media="${track.mediaId}" data-ref-title="${escapeHtml(track.title || '')}" data-ref-artist="${escapeHtml(artistLabel)}" data-ref-art="${escapeHtml(album.art || '')}" data-ref-src="${escapeHtml(track.src || '')}" data-ref-type="music" style="display:flex;align-items:center;gap:0.75ch;width:100%;background:none;border:none;color:var(--fg);font-family:inherit;font-size:0.9em;padding:0.6em 1.2em;cursor:pointer;text-align:left;border-radius:8px"><i class="ph ph-note-pencil"></i> ${t('music.writeAbout')}</button>`
        }
        html += `</div></div>`
      } else {
        html += `<span></span>`
      }
      html += `</div>`
    })
    html += `</div>`
  }

  // ─── External platform chips — out of the hero ────────────
  if (album.links && Object.keys(album.links).length) {
    const chips = []
    for (const [platform, url] of Object.entries(album.links)) {
      if (url && /^https?:\/\//i.test(url)) {
        chips.push(`<a class="art-album-chip" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"><span>${escapeHtml(platform)}</span><i class="ph ph-arrow-up-right" aria-hidden="true"></i></a>`)
      }
    }
    if (chips.length) html += `<div class="art-album-links">${chips.join('')}</div>`
  }

  el.innerHTML = html
  wireArtDetailBuyButtons(el)
  wireRefButtons(el)
  // If site.json's tracks lack mediaId/mediaPrice, ask on-chain for
  // matching listings and inject a buy-album button after render.
  // The works grid does the same grouping — this brings the detail
  // page in sync with what /works advertises for the same album.
  if (!buyableTracks.length) _hydrateAlbumBuyFromChain(el, album, alias)

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
      btn.setAttribute('aria-expanded', String(!isOpen))
    }, { signal })
  })
  // Close overflow menus on outside click
  document.addEventListener('click', () => {
    el.querySelectorAll('.track-overflow-menu').forEach(m => m.style.display = 'none')
    el.querySelectorAll('.track-overflow-btn').forEach(b => b.setAttribute('aria-expanded', 'false'))
  }, { signal })
  // Close menu after clicking an item
  el.querySelectorAll('.track-overflow-item').forEach(item => {
    item.addEventListener('click', () => {
      const menu = item.closest('.track-overflow-menu')
      menu.style.display = 'none'
      menu.previousElementSibling?.setAttribute?.('aria-expanded', 'false')
    }, { signal })
  })

  // "Read more" — only reveal the toggle when the description
  // actually overflows the 10-line clamp. Measure after paint so
  // the computed height is stable; toggle expands in place.
  const descEl = el.querySelector('[data-art-album-desc]')
  const moreBtn = el.querySelector('[data-art-album-desc-more]')
  if (descEl && moreBtn) {
    requestAnimationFrame(() => {
      if (descEl.scrollHeight > descEl.clientHeight + 2) {
        moreBtn.hidden = false
      }
    })
    moreBtn.addEventListener('click', () => {
      const expanded = descEl.classList.toggle('is-expanded')
      moreBtn.setAttribute('aria-expanded', String(expanded))
      moreBtn.textContent = expanded ? 'read less' : 'read more'
    }, { signal })
  }
}

// Hydrate a buy-album button on an album detail page whose site.json
// tracks predate the on-chain listing wire-up. Reads the artist's
// PraxisMedia listings (same source /works uses), groups by
// metadataCid, picks the group whose album title matches, and swaps
// the empty <span data-album-buy-slot> in the hero for a real button.
// Match strategy (in order): metadataCid == album cover CID; then
// >= half the track titles overlap. Silent no-op if nothing matches
// so albums that were never listed just stay play-only.
async function _hydrateAlbumBuyFromChain(rootEl, album, alias) {
  const slot = rootEl.querySelector('[data-album-buy-slot]')
  if (!slot) return
  const owner = document.body?.dataset?.owner
  if (!owner || !/^0x[0-9a-fA-F]{40}$/.test(owner)) return
  try {
    const { getArtistMedia } = await import('./media.js')
    // Extract the album's cover CID once up front so we can stop
    // paginating as soon as we find a matching group. getArtistMedia
    // returns 50 items per call; artists with >50 listings had the
    // buy button silently miss any album whose tracks fell past the
    // first page. Walk pages until we find a match OR run out.
    const artStr = String(album.art || '')
    const ipfsMatch = artStr.match(/(?:ipfs:\/\/|\/api\/ipfs-proxy\/|\/ipfs\/)([A-Za-z0-9]+)/)
    const albumCid = ipfsMatch?.[1] || ''
    const jsonTitles = new Set((album.tracks || []).map(t => (t.title || '').trim().toLowerCase()).filter(Boolean))

    const groups = new Map()
    let cursor = null
    const MAX_PAGES = 20 // 1000 listings — well past any real artist
    let matched = null
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await getArtistMedia(owner, cursor)
      const items = res?.items || []
      for (const it of items) {
        if (!it.metadataCid) continue
        if (!groups.has(it.metadataCid)) groups.set(it.metadataCid, [])
        groups.get(it.metadataCid).push(it)
      }
      // Early match: exact cover CID (cheapest signal).
      if (albumCid && groups.has(albumCid) && groups.get(albumCid).length >= 2) {
        matched = groups.get(albumCid)
        break
      }
      cursor = res?.cursor || null
      if (!cursor || !res?.hasMore) break
    }
    if (!groups.size) return
    // Fall back to title-overlap match if the cover-CID path didn't
    // pick a group (site.json's `album.art` may be a non-IPFS URL, or
    // the CID is different from the on-chain metadataCid).
    if (!matched && jsonTitles.size) {
      for (const g of groups.values()) {
        if (g.length < 2) continue
        const chainTitles = new Set(g.map(x => (x.title || '').trim().toLowerCase()).filter(Boolean))
        let overlap = 0
        for (const tt of jsonTitles) if (chainTitles.has(tt)) overlap++
        if (overlap * 2 >= jsonTitles.size) { matched = g; break }
      }
    }
    if (!matched || matched.length === 0) return
    // Sum prices, ignoring free/zero-priced tracks (nothing to charge).
    let totalWei = 0n
    const buyIds = []
    for (const m of matched) {
      try {
        const p = BigInt(m.price || 0)
        if (p > 0n) { totalWei += p; buyIds.push(m.mediaId) }
      } catch {}
    }
    if (!buyIds.length) return
    const idsAttr = escapeHtml(buyIds.join(','))
    const priceAttr = escapeHtml(String(totalWei))
    const titleAttr = escapeHtml(`${album.title || 'album'} (${matched.length} tracks)`)
    const btn = document.createElement('button')
    btn.className = 'feed-buy-btn feed-card-btn green'
    btn.setAttribute('data-media-id', idsAttr)
    btn.setAttribute('data-price', priceAttr)
    btn.setAttribute('data-title', titleAttr)
    btn.innerHTML = `${t('art.buy')} <span data-eth-wei="${priceAttr}" data-fiat-primary="true"></span>`
    slot.replaceWith(btn)
    // Re-wire so the newly injected button picks up the buy handler.
    wireArtDetailBuyButtons(rootEl)
    // Nudge the fiat formatter to fill the price span.
    window.dispatchEvent(new CustomEvent('fiat-format-request'))
  } catch (e) {
    console.warn('praxis: album buy hydrate failed:', e?.message)
  }
}

function renderGalleryImage(el, image, idx) {
  // EMPHASIZE: visual. The image is the piece — big, uncropped, left.
  // Title + metadata sit right on desktop, below on mobile. Actions row
  // promotes write-about-this + share (both network-benefit moves);
  // buy lands when the piece is priced.
  let html = ''
  const title = image.title || 'untitled'
  html += `<div class="art-detail-hero">`
  if (image.src) {
    const fullUrl = image.src.includes('/api/') ? image.src : `/api/img?url=${encodeURIComponent(image.src)}&w=1200`
    html += `<div class="art-detail-hero-media art-detail-hero-media--gallery"><img src="${escapeHtml(fullUrl)}" alt="${escapeHtml(title)}" loading="lazy"></div>`
  }
  html += `<div class="art-detail-hero-meta">`
  // draft eyebrow — the type label. Reads as THAT type at a glance.
  const eyebrow = image.medium || 'image'
  html += `<div class="art-detail-eyebrow"><i class="ph ph-image" aria-hidden="true"></i><span>${escapeHtml(eyebrow)}</span></div>`
  html += `<h1 class="art-detail-title">${escapeHtml(title)}</h1>`
  if (image.artist) html += `<div class="art-detail-byline">${t('art.by')} ${escapeHtml(image.artist)}</div>`
  const meta = []
  if (image.year) meta.push(String(image.year))
  if (image.dimensions) meta.push(image.dimensions)
  if (image.series) meta.push(image.series)
  if (image.location) meta.push(image.location)
  html += metaRow(meta)
  // Actions row — write first (network editorial depth), share,
  // then buy if priced. Share and write are universal; buy is
  // conditional.
  html += `<div class="art-detail-actions">`
  html += writeAboutAction(image, { art: image.src, type: 'gallery' })
  html += shareAction(title)
  html += buyAction(image)
  html += `</div>`
  html += `</div></div>` // close meta + hero

  if (image.description) html += `<div class="art-detail-description">${escapeHtml(image.description)}</div>`
  if (image.awards) html += `<div class="art-detail-pullquote art-detail-pullquote--awards"><i class="ph ph-trophy" aria-hidden="true"></i><span>${escapeHtml(image.awards)}</span></div>`
  // External view-in-person / gallery link — chip row, small, muted.
  if (image.url && /^https?:\/\//i.test(image.url)) {
    html += `<div class="art-detail-chip-row"><a class="art-detail-chip" href="${escapeHtml(image.url)}" target="_blank" rel="noopener noreferrer"><i class="ph ph-arrow-up-right" aria-hidden="true"></i><span>view in person</span></a></div>`
  }

  el.innerHTML = html
  wireArtDetailBuyButtons(el)
  wireRefButtons(el)
  wireShareButtons(el)
}

function renderFilmWork(el, work) {
  // EMPHASIZE: narrative. Poster left (2:3, max-height 480), credits
  // right. "dir. <director>" reads as a film credit at a glance; the
  // role (actor/writer/producer) sits as a separate line when the
  // viewer's relationship to the piece is other than director. Watch
  // is the primary action when a stream is attached; write + share
  // cover the network-benefit moves beyond the buy.
  let html = ''
  const title = work.title || 'untitled'
  html += `<div class="art-detail-hero">`
  if (work.poster) {
    const posterUrl = work.poster.includes('/api/') ? work.poster : `/api/img?url=${encodeURIComponent(work.poster)}&w=800`
    html += `<div class="art-detail-hero-media art-detail-hero-media--poster"><img src="${escapeHtml(posterUrl)}" alt="${escapeHtml(title)}" loading="lazy"></div>`
  }
  html += `<div class="art-detail-hero-meta">`
  html += `<div class="art-detail-eyebrow"><i class="ph ph-film-slate" aria-hidden="true"></i><span>film</span></div>`
  html += `<h1 class="art-detail-title">${escapeHtml(title)}</h1>`
  // Byline — "dir. <director>" is the canonical film-credit shape.
  // Year sits on the same line, dot-free, for the Apple-calm cadence.
  const bylineParts = []
  if (work.director) bylineParts.push(`dir. ${work.director}`)
  if (work.year) bylineParts.push(String(work.year))
  if (bylineParts.length) html += `<div class="art-detail-byline">${escapeHtml(bylineParts.join('  '))}</div>`
  // Role — Switzer 500 1rem — reads "miles plays X" quickly.
  if (work.role) html += `<div class="art-detail-role">${escapeHtml(work.role)}</div>`
  const meta = []
  if (work.runtime) meta.push(work.runtime)
  if (work.language) meta.push(work.language)
  if (work.venue) meta.push(work.venue)
  html += metaRow(meta)
  // Actions — watch (primary when a URL/video is attached), write,
  // share, buy. Watch URL opens external (festival page, Vimeo,
  // YouTube) in a new tab; the inline <video> player still lives
  // below for embedded streams.
  html += `<div class="art-detail-actions">`
  const watchHref = (work.watchUrl && /^https?:\/\//i.test(work.watchUrl)) ? work.watchUrl
                   : (work.url && /^https?:\/\//i.test(work.url)) ? work.url : ''
  if (watchHref) {
    html += `<a class="art-detail-action art-detail-action--primary" href="${escapeHtml(watchHref)}" target="_blank" rel="noopener noreferrer"><i class="ph ph-play-fill" aria-hidden="true"></i><span>watch</span></a>`
  }
  html += writeAboutAction(work, { art: work.poster || '', src: work.video || '', type: 'film' })
  html += shareAction(title)
  html += buyAction(work)
  html += `</div>`
  html += `</div></div>` // close meta + hero

  if (work.description) html += `<div class="art-detail-description">${escapeHtml(work.description)}</div>`

  if (work.awards) html += `<div class="art-detail-pullquote art-detail-pullquote--awards"><i class="ph ph-trophy" aria-hidden="true"></i><span>${escapeHtml(work.awards)}</span></div>`

  // Cast — editorial section, labeled. Comma-separated the way a
  // festival program renders it.
  if (work.cast) {
    html += `<div class="art-detail-section">`
    html += `<div class="art-detail-section-label">with</div>`
    html += `<div class="art-detail-section-body">${escapeHtml(work.cast)}</div>`
    html += `</div>`
  }

  // Inline video — kept when the piece embeds a stream directly.
  // playsinline per CLAUDE.md.
  if (work.video) {
    html += `<div class="art-video-lazy-frame" style="margin-top:1.5em"><video src="${escapeHtml(work.video)}" controls preload="none" playsinline style="max-width:100%;height:100%"></video></div>`
  }

  el.innerHTML = html
  wireArtDetailBuyButtons(el)
  wireRefButtons(el)
  wireShareButtons(el)
}

function renderVideoItem(el, item) {
  // EMPHASIZE: motion (short-form). Video LEADS — the piece plays
  // first. Title, byline, duration, type sit below. Lazy poster
  // keeps TTI low; swap to real <video> on click is handled by the
  // mini-player's IntersectionObserver in the existing wire-up.
  let html = ''
  const title = item.title || 'untitled'
  // Video hero — full-width lazy frame that swaps to <video> on click.
  if (item.src) {
    let posterUrl = item.poster || item.thumbnail || ''
    if (!posterUrl) {
      const cidMatch = item.src.match(/\/api\/ipfs-proxy\/([A-Za-z0-9]+)/)
      if (cidMatch) posterUrl = `/api/video-thumb?cid=${cidMatch[1]}&w=960`
    }
    html += `<div class="art-detail-hero" style="margin-bottom:1.25rem">`
    html += `<div class="art-detail-hero-media art-detail-hero-media--video">`
    html += `<div class="video-lazy art-video-lazy-frame" data-src="${escapeHtml(item.src)}" data-poster="${escapeHtml(posterUrl)}" data-title="${escapeHtml(title)}" style="border-radius:16px">`
    html += posterUrl
      ? `<img src="${escapeHtml(posterUrl)}" alt="${escapeHtml(title)}" loading="lazy" style="width:100%;height:100%;object-fit:cover;cursor:pointer">`
      : `<div style="display:flex;align-items:center;justify-content:center;cursor:pointer;width:100%;height:100%"><i class="ph ph-play-fill" aria-hidden="true" style="color:var(--muted);font-size:2em"></i></div>`
    html += `</div></div></div>`
  }
  // Title + metadata + actions — read as a video page at a glance.
  // Type pulled from `item.type` if present (music video, short film,
  // documentary); eyebrow falls back to a plain "video" badge.
  const kind = item.type || item.form || 'video'
  html += `<div class="art-detail-eyebrow"><i class="ph ph-video" aria-hidden="true"></i><span>${escapeHtml(kind)}</span></div>`
  html += `<h1 class="art-detail-title">${escapeHtml(title)}</h1>`
  if (item.artist || item.director || item.collaborators) {
    const by = item.artist || item.director || ''
    const withText = item.collaborators && by ? `${by}  with ${item.collaborators}` : (by || `with ${item.collaborators || ''}`)
    html += `<div class="art-detail-byline">${escapeHtml(withText)}</div>`
  }
  const meta = []
  if (item.duration) {
    // duration — accept seconds-number or already-formatted "mm:ss"
    const d = Number(item.duration)
    if (!isNaN(d) && d > 0) meta.push(`${Math.floor(d / 60)}:${String(d % 60).padStart(2, '0')}`)
    else meta.push(String(item.duration))
  }
  if (item.year) meta.push(String(item.year))
  if (item.language) meta.push(item.language)
  html += metaRow(meta)
  html += `<div class="art-detail-actions">`
  html += writeAboutAction(item, { art: item.poster || item.thumbnail || '', src: item.src || '', type: 'video' })
  html += shareAction(title)
  html += buyAction(item)
  // External "watch external" — Vimeo / YouTube / festival. Ghost
  // action so it sits alongside write + share without stealing focus
  // from the primary buy.
  if (item.url && /^https?:\/\//i.test(item.url)) {
    html += `<a class="art-detail-action art-detail-action--ghost" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer"><i class="ph ph-arrow-up-right" aria-hidden="true"></i><span>watch external</span></a>`
  }
  html += `</div>`

  if (item.description) html += `<div class="art-detail-description">${escapeHtml(item.description)}</div>`

  el.innerHTML = html
  wireArtDetailBuyButtons(el)
  wireRefButtons(el)
  wireShareButtons(el)
}

function renderAudioItem(el, item, idx) {
  // EMPHASIZE: sonic. Cover-left-at-320px-square if the piece has
  // cover art, otherwise a full-width type-centered hero. Play is the
  // primary action (not just a tiny inline pill under the title),
  // then add-to-queue + write + buy. Uses the track-play-btn pattern
  // from CLAUDE.md so the persistent player picks up the piece.
  let html = ''
  const title = item.title || 'untitled'
  const artist = item.artist || item.credit || ''
  const kind = item.form || item.type || 'audio'
  const cover = item.cover || item.art || ''
  const hasCover = !!cover

  html += `<div class="art-detail-hero">`
  if (hasCover) {
    const coverUrl = cover.includes('/api/') ? cover : `/api/img?url=${encodeURIComponent(cover)}&w=600`
    html += `<div class="art-detail-hero-media art-detail-hero-media--cover-sq"><img src="${escapeHtml(coverUrl)}" alt="${escapeHtml(title)}" loading="lazy"></div>`
  }
  html += `<div class="art-detail-hero-meta">`
  html += `<div class="art-detail-eyebrow"><i class="ph ph-waveform" aria-hidden="true"></i><span>${escapeHtml(kind)}</span></div>`
  html += `<h1 class="art-detail-title">${escapeHtml(title)}</h1>`
  if (artist) html += `<div class="art-detail-byline">${t('art.by')} ${escapeHtml(artist)}</div>`
  if (item.series) html += `<div class="art-detail-publisher">${escapeHtml(item.series)}${item.episode ? `  ep. ${escapeHtml(String(item.episode))}` : ''}</div>`
  const meta = []
  if (item.duration) {
    const d = Number(item.duration)
    if (!isNaN(d) && d > 0) meta.push(`${Math.floor(d / 60)}:${String(d % 60).padStart(2, '0')}`)
    else meta.push(String(item.duration))
  }
  if (item.year) meta.push(String(item.year))
  if (item.language) meta.push(item.language)
  html += metaRow(meta)
  html += `<div class="art-detail-actions">`
  if (item.src) {
    // Primary play — uses .track-play-btn so player.js's global
    // delegation handles it (Media Session API, queue, prev/next).
    html += `<button class="track-play-btn art-detail-action art-detail-action--primary" data-track-src="${escapeHtml(item.src)}" data-track-title="${escapeHtml(title)}" data-track-artist="${escapeHtml(artist)}" data-track-art="${escapeHtml(cover)}" aria-label="${t('art.play')}"><i class="ph ph-play-fill" aria-hidden="true"></i><span>${t('art.play')}</span></button>`
    // Add-to-queue — uses .track-queue-btn so the global player
    // handler picks it up via event delegation.
    html += `<button class="track-queue-btn art-detail-action" data-src="${escapeHtml(item.src)}" data-title="${escapeHtml(title)}" data-artist="${escapeHtml(artist)}" data-art="${escapeHtml(cover)}" aria-label="${t('music.addToQueue')}"><i class="ph ph-plus" aria-hidden="true"></i><span>queue</span></button>`
  }
  html += writeAboutAction(item, { art: cover, src: item.src || '', artist, type: 'audio' })
  html += shareAction(title)
  html += buyAction(item)
  if (item.url && /^https?:\/\//i.test(item.url)) {
    html += `<a class="art-detail-action art-detail-action--ghost" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer"><i class="ph ph-arrow-up-right" aria-hidden="true"></i><span>listen external</span></a>`
  }
  html += `</div>`
  html += `</div></div>` // close meta + hero

  if (item.description) html += `<div class="art-detail-description">${escapeHtml(item.description)}</div>`

  el.innerHTML = html
  wireArtDetailBuyButtons(el)
  wireRefButtons(el)
  wireShareButtons(el)
}

function renderWritingItem(el, item, idx) {
  // EMPHASIZE: text, reference weight. Cover LEFT (3:4, book cover
  // aspect) when present; title block RIGHT. Chillax title, Switzer
  // byline, Space Mono publisher and ISBN carry the reference
  // register. Read is the primary action when a URL is attached;
  // write-about-this is promoted because writing is the type most
  // likely to be referenced in /write.
  let html = ''
  const title = item.title || 'untitled'
  const author = item.author || item.credit || ''
  const kind = item.form || 'writing'

  html += `<div class="art-detail-hero">`
  if (item.cover) {
    const coverUrl = item.cover.includes('/api/') ? item.cover : `/api/img?url=${encodeURIComponent(item.cover)}&w=600`
    html += `<div class="art-detail-hero-media art-detail-hero-media--cover-tall"><img src="${escapeHtml(coverUrl)}" alt="${escapeHtml(title)}" loading="lazy"></div>`
  }
  html += `<div class="art-detail-hero-meta">`
  html += `<div class="art-detail-eyebrow"><i class="ph ph-book-open" aria-hidden="true"></i><span>${escapeHtml(kind)}</span></div>`
  html += `<h1 class="art-detail-title">${escapeHtml(title)}</h1>`
  if (author) html += `<div class="art-detail-byline">${t('art.by')} ${escapeHtml(author)}</div>`
  // Publisher / publication — Space Mono small. Reads as reference.
  const pubParts = []
  if (item.publication) pubParts.push(item.publication)
  if (item.publisher && item.publisher !== item.publication) pubParts.push(item.publisher)
  if (pubParts.length) html += `<div class="art-detail-publisher">${escapeHtml(pubParts.join('  '))}</div>`
  // Meta row — form, language, ISBN, pages. Space Mono tabular.
  const meta = []
  if (item.year) meta.push(String(item.year))
  if (item.language) meta.push(item.language)
  if (item.isbn) meta.push(`ISBN ${item.isbn}`)
  if (item.pages) meta.push(`${item.pages} pages`)
  html += metaRow(meta)
  html += `<div class="art-detail-actions">`
  // Read is primary — opens the hosted read URL in a new tab. Falls
  // back to a scroll-to-excerpt when the piece is embedded. Writing
  // is the one type where "read" earns the primary slot across the
  // five renderers.
  const readHref = (item.readUrl && /^https?:\/\//i.test(item.readUrl)) ? item.readUrl
                 : (item.url && /^https?:\/\//i.test(item.url)) ? item.url : ''
  if (readHref) {
    html += `<a class="art-detail-action art-detail-action--primary" href="${escapeHtml(readHref)}" target="_blank" rel="noopener noreferrer"><i class="ph ph-book-open" aria-hidden="true"></i><span>read</span></a>`
  }
  // Write-about — the highest-leverage move on writing (editorial
  // chain, discovery, SEO). Promoted next to read + buy.
  html += writeAboutAction(item, { art: item.cover || '', artist: author, type: 'writing' })
  html += shareAction(title)
  html += buyAction(item)
  html += `</div>`
  html += `</div></div>` // close meta + hero

  // Excerpt — pullquote with leading quotation mark. Reads as a
  // reader's preview, not just inline italics.
  if (item.excerpt) html += `<div class="art-detail-pullquote art-detail-pullquote--excerpt">${escapeHtml(item.excerpt)}</div>`

  if (item.description) html += `<div class="art-detail-description">${escapeHtml(item.description)}</div>`

  if (item.awards) html += `<div class="art-detail-pullquote art-detail-pullquote--awards"><i class="ph ph-trophy" aria-hidden="true"></i><span>${escapeHtml(item.awards)}</span></div>`

  el.innerHTML = html
  wireArtDetailBuyButtons(el)
  wireRefButtons(el)
  wireShareButtons(el)
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
  // Owner-only: "publish to org" panel. Rendered async after paint so
  // we don't block first-paint on the orgs-by-member + isWorkTagged
  // multicall. Panel self-hides if the connected wallet isn't the
  // media artist or belongs to no orgs.
  html += `<div id="art-publish-to-org" class="art-publish-to-org-slot"></div>`

  contentEl.innerHTML = html

  // Hydrate the "publish to org" panel — self-hides for non-owners /
  // non-members. Also re-run on wallet-connect so a mid-page unlock
  // reveals the panel without a reload.
  const publishEl = document.getElementById('art-publish-to-org')
  const _publishHydrate = () => { renderPublishToOrgPanel(publishEl, { mediaContract: mediaAddr, mediaId: String(mediaId) }).catch(() => {}) }
  _publishHydrate()
  window.addEventListener('wallet-connected', _publishHydrate, { once: false })

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
