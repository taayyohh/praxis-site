// Art detail page — universal portfolio item viewer
// Routes: /art?type=music&alias=0&album=1 (local) or /art?media=0 (on-chain)
import { query } from './ponder.js'
import { ipfsUrl, escapeHtml, resolveAddresses, resolveDomain, formatEthAmount, getPublicClient, registerPage } from './utils.js'
import { purchaseMedia, getArtistMedia, annotateRelistings } from './media.js'
import { formatEther } from './vendor.js'

import { MEDIA_ABI, getMediaAddress } from './contracts.js'

registerPage('art-page', initArt)

async function initArt() {
  const loadingEl = document.getElementById('art-loading')
  const contentEl = document.getElementById('art-content')
  if (!loadingEl || !contentEl) return

  loadingEl.style.display = ''
  loadingEl.innerHTML = '<div class="praxis-loader"></div>'
  contentEl.innerHTML = ''

  const params = new URLSearchParams(window.location.search)
  const mediaId = params.get('media')
  const type = params.get('type')

  try {
    if (mediaId !== null) {
      await renderOnChainMedia(mediaId, loadingEl, contentEl)
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
    html += `<div style="flex-shrink:0;width:min(300px, 45%)"><img src="${artUrl}" alt="${escapeHtml(album.title)}" style="width:100%;display:block" loading="lazy"></div>`
  }

  html += `<div style="flex:1;min-width:0">`
  html += `<h1 style="font-size:1.4em;margin:0 0 0.25em">${escapeHtml(album.title)}</h1>`
  html += `<div style="color:var(--muted);margin-bottom:0.75em">by ${escapeHtml(album.artist || alias.name)}${album.year ? ` (${album.year})` : ''}</div>`
  if (album.collab) {
    html += `<div style="color:var(--dim);font-size:0.85em;margin-bottom:0.5em">with <a href="https://${escapeHtml(album.collab.from)}" style="color:var(--accent)">${escapeHtml(album.collab.from)}</a></div>`
  }

  if (album.genre) html += `<div style="color:var(--dim);font-size:0.85em;margin-bottom:0.5em">${escapeHtml(album.genre)}</div>`
  if (album.producer) html += `<div style="color:var(--dim);font-size:0.85em;margin-bottom:0.5em">produced by ${escapeHtml(album.producer)}</div>`

  if (album.description) {
    html += `<div style="color:var(--fg);font-size:0.9em;line-height:1.6;margin-bottom:1em;max-height:12em;overflow-y:auto">${escapeHtml(album.description)}</div>`
  }

  // action buttons
  html += `<div style="display:flex;gap:1ch;align-items:center;flex-wrap:wrap">`
  const playableTracks = (album.tracks || []).filter(t => t.src)
  if (playableTracks.length > 0) {
    const queueData = encodeURIComponent(JSON.stringify(playableTracks.map(t => ({ src: t.src, title: t.title, artist: album.artist || alias.name, art: album.art || '' }))))
    html += `<button class="album-play-btn" data-queue="${queueData}" style="background:none;border:1px solid var(--border);color:var(--fg);font-family:inherit;font-size:0.85em;padding:0.3em 1.5ch;cursor:pointer">play</button>`
    html += `<button class="album-queue-btn" data-queue="${queueData}" style="background:none;border:none;color:var(--dim);font-size:1em;cursor:pointer;padding:0.2em" title="add album to queue"><i class="ph ph-plus"></i></button>`
  }
  if (album.links && Object.keys(album.links).length) {
    for (const [platform, url] of Object.entries(album.links)) {
      if (url) html += `<a href="${url}" target="_blank" rel="noopener" style="color:var(--muted);font-size:0.85em;padding:0.3em 1ch;border:1px solid var(--border);text-decoration:none">${escapeHtml(platform)}</a>`
    }
  }
  html += `</div>`
  html += `</div></div>` // close metadata + hero

  // Mobile stack: CSS for the hero flex
  html += `<style>.art-album-hero { text-align: left; } @media (max-width: 600px) { .art-album-hero { flex-direction: column; align-items: center; text-align: center; } .art-album-hero > div:first-child { width: min(280px, 80%) !important; } }</style>`

  // track list (skip empty/deleted tracks)
  const validTracks = (album.tracks || []).filter(t => t.title || t.src)
  if (validTracks.length) {
    html += `<div class="art-tracklist" style="margin-bottom:1.5em">`
    validTracks.forEach((track, i) => {
      html += `<div class="album-track" style="display:flex;align-items:center;gap:1ch;padding:0.4em 0;border-bottom:1px solid var(--border)">`
      html += `<span style="color:var(--dim);min-width:2ch;text-align:right">${i + 1}.</span>`
      html += `<span class="track-title" style="flex:1">${escapeHtml(track.title)}</span>`
      if (track.duration) {
        const m = Math.floor(track.duration / 60)
        const s = String(track.duration % 60).padStart(2, '0')
        html += `<span style="color:var(--dim);font-size:0.85em">${m}:${s}</span>`
      }
      if (track.src) {
        html += `<button class="track-play-btn" data-track-src="${track.src}" data-track-title="${escapeHtml(track.title)}" data-track-artist="${escapeHtml(album.artist || alias.name)}" style="background:none;border:1px solid var(--border);color:var(--fg);font-family:inherit;font-size:0.8em;padding:0.15em 0.8ch;cursor:pointer"><i class="ph ph-play"></i></button>`
        html += `<button class="track-queue-btn" data-src="${track.src}" data-title="${escapeHtml(track.title)}" data-artist="${escapeHtml(album.artist || alias.name)}" data-art="${escapeHtml(album.art || '')}" style="background:none;border:none;color:var(--dim);font-size:0.85em;cursor:pointer;padding:0.15em 0.4ch" title="add to queue"><i class="ph ph-plus"></i></button>`
      }
      if (track.mediaId !== undefined && track.mediaId !== null) {
        const priceEth = track.mediaPrice ? (Number(track.mediaPrice) / 1e18) : 0
        const priceLabel = priceEth > 0 ? `${priceEth} ETH` : 'free'
        html += `<button class="track-buy-btn" data-media-id="${track.mediaId}" data-price="${track.mediaPrice || '0'}" data-eth-wei="${track.mediaPrice || '0'}" data-title="${escapeHtml(track.title || '')}" style="background:none;border:1px solid var(--green);color:var(--green);font-family:inherit;font-size:0.7em;padding:0.1em 0.6ch;cursor:pointer;margin-left:0.5ch">${priceLabel}</button>`
      }
      html += `</div>`
    })
    html += `</div>`
  }


  el.innerHTML = html
  wireArtDetailBuyButtons(el)
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

  // buy button
  if (image.mediaId !== undefined && image.mediaId !== null) {
    const priceEth = image.mediaPrice ? (Number(image.mediaPrice) / 1e18) : 0
    const priceLabel = priceEth > 0 ? `${priceEth} ETH` : 'collect free'
    html += `<div style="margin-bottom:1.5em"><button class="track-buy-btn" data-media-id="${image.mediaId}" data-price="${image.mediaPrice || '0'}" data-eth-wei="${image.mediaPrice || '0'}" data-title="${escapeHtml(image.title || '')}" style="background:none;border:1px solid var(--green);color:var(--green);font-family:inherit;font-size:0.85em;padding:0.3em 1.5ch;cursor:pointer">${priceLabel}</button></div>`
  }

  el.innerHTML = html
  wireArtDetailBuyButtons(el)
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
    const priceEth = work.mediaPrice ? (Number(work.mediaPrice) / 1e18) : 0
    const priceLabel = priceEth > 0 ? `${priceEth} ETH` : 'collect free'
    html += `<button class="track-buy-btn" data-media-id="${work.mediaId}" data-price="${work.mediaPrice || '0'}" data-eth-wei="${work.mediaPrice || '0'}" data-title="${escapeHtml(work.title || '')}" style="background:none;border:1px solid var(--green);color:var(--green);font-family:inherit;font-size:0.85em;padding:0.3em 1.5ch;cursor:pointer">${priceLabel}</button>`
  }
  html += `</div>`

  if (work.video) {
    html += `<div style="margin-bottom:1.5em"><video src="${work.video}" controls preload="none" style="max-width:100%"></video></div>`
  }

  el.innerHTML = html
  wireArtDetailBuyButtons(el)
}

function renderVideoItem(el, item) {
  let html = ''
  html += `<h1 style="font-size:1.4em;margin:0 0 0.25em">${escapeHtml(item.title)}</h1>`
  const meta = []
  if (item.year) meta.push(String(item.year))
  if (item.collaborators) meta.push(item.collaborators)
  if (meta.length) html += `<div style="color:var(--muted);margin-bottom:0.5em">${escapeHtml(meta.join(' -- '))}</div>`
  if (item.description) html += `<p style="margin-bottom:1em">${escapeHtml(item.description)}</p>`

  // buy button (before video so it's visible without scrolling)
  if (item.mediaId !== undefined && item.mediaId !== null) {
    const priceEth = item.mediaPrice ? (Number(item.mediaPrice) / 1e18) : 0
    const priceLabel = priceEth > 0 ? `${priceEth} ETH` : 'collect free'
    html += `<div style="margin-bottom:1em"><button class="track-buy-btn" data-media-id="${item.mediaId}" data-price="${item.mediaPrice || '0'}" data-eth-wei="${item.mediaPrice || '0'}" data-title="${escapeHtml(item.title || '')}" style="background:none;border:1px solid var(--green);color:var(--green);font-family:inherit;font-size:0.85em;padding:0.3em 1.5ch;cursor:pointer">${priceLabel}</button></div>`
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
}

function renderAudioItem(el, item, idx) {
  let html = ''
  html += `<h1 style="font-size:1.4em;margin:0 0 0.25em">${escapeHtml(item.title || 'untitled')}</h1>`
  if (item.description) html += `<p style="color:var(--fg);margin-bottom:1em">${escapeHtml(item.description)}</p>`
  if (item.year) html += `<div style="color:var(--muted);margin-bottom:1em">${item.year}</div>`
  if (item.src) html += `<audio src="${item.src}" controls preload="none" style="width:100%;margin-bottom:1.5em"></audio>`

  if (item.mediaId !== undefined && item.mediaId !== null) {
    const priceEth = item.mediaPrice ? (Number(item.mediaPrice) / 1e18) : 0
    const priceLabel = priceEth > 0 ? `${priceEth} ETH` : 'collect free'
    html += `<div style="margin-bottom:1.5em"><button class="track-buy-btn" data-media-id="${item.mediaId}" data-price="${item.mediaPrice || '0'}" data-eth-wei="${item.mediaPrice || '0'}" data-title="${escapeHtml(item.title || '')}" style="background:none;border:1px solid var(--green);color:var(--green);font-family:inherit;font-size:0.85em;padding:0.3em 1.5ch;cursor:pointer">${priceLabel}</button></div>`
  }

  if (item.url) html += `<div style="margin-bottom:1.5em"><a href="${item.url}" target="_blank" rel="noopener" style="color:var(--muted);font-size:0.9em">listen</a></div>`

  el.innerHTML = html
  wireArtDetailBuyButtons(el)
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
    const priceEth = item.mediaPrice ? (Number(item.mediaPrice) / 1e18) : 0
    const priceLabel = priceEth > 0 ? `${priceEth} ETH` : 'collect free'
    html += `<div style="margin-bottom:1.5em"><button class="track-buy-btn" data-media-id="${item.mediaId}" data-price="${item.mediaPrice || '0'}" data-eth-wei="${item.mediaPrice || '0'}" data-title="${escapeHtml(item.title || '')}" style="background:none;border:1px solid var(--green);color:var(--green);font-family:inherit;font-size:0.85em;padding:0.3em 1.5ch;cursor:pointer">${priceLabel}</button></div>`
  }

  el.innerHTML = html
  wireArtDetailBuyButtons(el)
}

// --- On-chain media: /art?media=0 ---

async function renderOnChainMedia(mediaId, loadingEl, contentEl) {
  const mediaAddr = getMediaAddress()
  if (!mediaAddr) { loadingEl.textContent = 'media contract not configured'; return }

  const pc = await getPublicClient()

  // read media data + collaborators in parallel
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

  // cover art / media preview
  if (coverUrl) {
    html += `<div class="art-cover" style="margin-bottom:1.5em"><img src="/api/img?url=${encodeURIComponent(coverUrl)}&w=600" alt="${escapeHtml(title)}" style="max-width:100%;max-height:400px" loading="lazy"></div>`
  }

  // title + artist
  html += `<h1 style="font-size:1.4em;margin:0 0 0.25em">${escapeHtml(title)}</h1>`
  html += `<div style="color:var(--muted);margin-bottom:1em">by <a href="https://${escapeHtml(artistDomain)}" style="color:var(--muted)">${escapeHtml(artistDomain)}</a></div>`

  // action row: play, buy, download
  html += `<div style="display:flex;gap:1ch;align-items:center;margin-bottom:1.5em;flex-wrap:wrap">`

  if (mediaUrl) {
    if (contentType.startsWith('audio/') || contentType === 'application/ogg') {
      html += `<button class="track-play-btn" data-track-src="${mediaUrl}" data-track-title="${escapeHtml(title)}" data-track-artist="${escapeHtml(artistDomain)}" style="background:none;border:1px solid var(--border);color:var(--fg);font-family:inherit;font-size:0.85em;padding:0.3em 1.5ch;cursor:pointer">play</button>`
    }
    // video: no separate play button — poster click starts inline player, PiP button hands off to global player
  }

  // buy button (or superseded notice)
  if (isSuperseded) {
    html += `<span style="color:var(--muted);font-size:0.85em">this listing has been updated</span>`
    html += `<a href="/art?media=${activeListingId}" style="color:var(--accent);font-size:0.85em;margin-left:1ch">view current listing</a>`
  } else {
    const priceLabel = priceNum > 0 ? `buy ${priceEth} ETH` : 'collect free'
    html += `<button id="art-buy-btn" data-media-id="${mediaId}" data-price="${price.toString()}" style="background:none;border:1px solid var(--green);color:var(--green);font-family:inherit;font-size:0.85em;padding:0.3em 1.5ch;cursor:pointer">${priceLabel}</button>`
  }

  if (mediaUrl) {
    html += `<a href="${mediaUrl}" download="${escapeHtml(title)}" style="color:var(--dim);font-size:0.85em">download</a>`
  }

  html += `</div>`

  // inline media player for video/image
  if (mediaUrl && contentType.startsWith('video/')) {
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

  contentEl.innerHTML = html

  // attach buy button handler
  const buyBtn = document.getElementById('art-buy-btn')
  if (buyBtn) {
    // check ownership
    checkOwnership(mediaId, buyBtn)

    buyBtn.addEventListener('click', async () => {
      if (buyBtn.disabled) return
      const priceLabel = buyBtn.textContent
      buyBtn.textContent = 'confirming...'
      buyBtn.disabled = true
      try {
        await purchaseMedia(parseInt(mediaId), price.toString())
        buyBtn.textContent = 'owned'
        buyBtn.style.borderColor = 'var(--accent)'
        buyBtn.style.color = 'var(--accent)'
      } catch (err) {
        buyBtn.textContent = err.code === 4001 ? 'cancelled' : (err.shortMessage || 'could not complete purchase')
        setTimeout(() => { buyBtn.textContent = priceLabel }, 2000)
      } finally {
        if (buyBtn.textContent !== 'owned') buyBtn.disabled = false
      }
    })
  }

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
  container.querySelectorAll('.track-buy-btn[data-media-id]').forEach(buyBtn => {
    const mediaId = buyBtn.dataset.mediaId
    const price = buyBtn.dataset.price || '0'

    // check ownership
    checkOwnership(mediaId, buyBtn)

    buyBtn.addEventListener('click', async () => {
      if (buyBtn.disabled) return
      const priceLabel = buyBtn.textContent
      buyBtn.textContent = 'confirming...'
      buyBtn.disabled = true
      try {
        await purchaseMedia(parseInt(mediaId), price)
        buyBtn.textContent = 'owned'
        buyBtn.style.borderColor = 'var(--accent)'
        buyBtn.style.color = 'var(--accent)'
      } catch (err) {
        buyBtn.textContent = err.code === 4001 ? 'cancelled' : (err.shortMessage || 'could not complete purchase')
        setTimeout(() => { buyBtn.textContent = priceLabel }, 2000)
      } finally {
        if (buyBtn.textContent !== 'owned') buyBtn.disabled = false
      }
    })
  })
}

async function checkOwnership(mediaId, buyBtn) {
  const addr = window.getWalletAddress?.()
  if (!addr) return
  const mediaAddr = getMediaAddress()
  if (!mediaAddr) return
  try {
    const pc = await getPublicClient()
    const balance = await pc.readContract({ address: mediaAddr, abi: MEDIA_ABI, functionName: 'balanceOf', args: [addr, BigInt(mediaId)] })
    if (balance > 0n) {
      buyBtn.textContent = 'owned'
      buyBtn.style.borderColor = 'var(--accent)'
      buyBtn.style.color = 'var(--accent)'
      buyBtn.disabled = true
    }
  } catch {}
}
