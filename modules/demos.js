// Demos module — works in progress, rough cuts, sketches, drafts
// For unfinished/in-progress work across all disciplines
// data: { items: [{ title, description, year, art, coverArt, src, url, status, mediaId, mediaPrice, collaborators, tools, startedDate, estimatedCompletion, notes, medium }] }
import { esc } from './shared.js'

const IMG_RE = /\.(jpe?g|png|gif|webp|svg|avif)$/i
const VID_RE = /\.(mp4|webm|mov)$/i
const PDF_RE = /\.pdf$/i
const AUDIO_EXCLUDED_RE = /\.(mp4|webm|mov|jpe?g|png|gif|webp|svg|avif|pdf)$/i

function detectType(item) {
  // Explicit srcType takes priority (user-set or inferred)
  if (item.srcType) {
    const t = item.srcType.toLowerCase()
    if (t === 'image' || t.startsWith('image/')) return 'image'
    if (t === 'video' || t.startsWith('video/')) return 'video'
    if (t === 'audio' || t.startsWith('audio/')) return 'audio'
    if (t === 'pdf' || t === 'application/pdf' || t === 'document') return 'pdf'
    if (t === 'text' || t.startsWith('text/')) return 'text'
  }
  if (!item.src && !item.video && !item.image) return 'text'
  // Check src extension first — item.image is cover art, not a type signal
  if (item.src) {
    if (IMG_RE.test(item.src)) return 'image'
    if (VID_RE.test(item.src)) return 'video'
    if (PDF_RE.test(item.src)) return 'pdf'
    if (!AUDIO_EXCLUDED_RE.test(item.src) && !item.src.includes('/ipfs-proxy/')) return 'audio'
    // IPFS URLs without extensions: render as unknown, detect client-side
    return 'unknown'
  }
  if (item.video) return 'video'
  if (item.image) return 'image'
  return 'text'
}

function statusBadge(status) {
  if (!status) return ''
  const colors = { 'in-progress': 'var(--green)', shelved: 'var(--muted)', released: 'var(--accent, var(--green))' }
  return ` <span class="demo-status" style="font-size:0.7em;padding:0.1em 0.6ch;border:1px solid ${colors[status] || 'var(--muted)'};color:${colors[status] || 'var(--muted)'}">${esc(status)}</span>`
}

function buyBtnSmall(item) {
  if (item.mediaId === undefined || item.mediaId === null) return ''
  const priceEth = item.mediaPrice ? (Number(item.mediaPrice) / 1e18) : 0
  const priceLabel = priceEth > 0 ? `${priceEth} ETH` : 'free'
  return ` <button class="track-buy-btn" data-media-id="${item.mediaId}" data-price="${item.mediaPrice || '0'}" data-eth-wei="${item.mediaPrice || '0'}" style="background:none;border:1px solid var(--green);color:var(--green);font-family:inherit;font-size:0.7em;padding:0.1em 0.6ch;cursor:pointer;margin-left:0.5ch">${priceLabel}</button>`
}

function metaBlock(item) {
  let m = ''
  if (item.collab) m += `<div style="color:var(--muted);font-size:0.85em;margin:0.15em 0">with <a href="https://${esc(item.collab.from)}" style="color:var(--accent);text-decoration:none">${esc(item.collab.from)}</a></div>`
  else if (item.collaborators) m += `<div style="color:var(--muted);font-size:0.85em;margin:0.15em 0">with ${esc(item.collaborators)}</div>`
  if (item.tools) m += `<div style="margin:0.15em 0">${item.tools.split(',').map(t => `<span style="font-size:0.7em;padding:0.1em 0.4ch;border:1px solid var(--border);color:var(--dim);margin-right:0.3ch">${esc(t.trim())}</span>`).join('')}</div>`
  if (item.startedDate || item.estimatedCompletion) m += `<div style="color:var(--dim);font-size:0.8em;margin:0.15em 0">${item.startedDate ? `started ${esc(item.startedDate)}` : ''}${item.startedDate && item.estimatedCompletion ? ' · ' : ''}${item.estimatedCompletion ? `est. ${esc(item.estimatedCompletion)}` : ''}</div>`
  if (item.description) m += `<div style="color:var(--fg);font-size:0.9em;margin:0.25em 0">${esc(item.description)}</div>`
  if (item.notes) m += `<div style="color:var(--dim);font-size:0.85em;margin:0.25em 0;font-style:italic">${esc(item.notes)}</div>`
  if (item.url) {
    const safeUrl = /^(https?:\/\/|\/)/i.test(item.url) ? esc(item.url) : '#'
    m += `<div style="margin-top:0.25em"><a href="${safeUrl}" style="color:var(--muted);font-size:0.85em">view</a></div>`
  }
  return m
}

export default {
  type: 'demos',
  label: 'works in progress',
  route: '/demos',

  renderSection(data) {
    if (!data) return ''
    let html = ''
    const items = Array.isArray(data) ? data : data.items || []
    const sections = (!Array.isArray(data) && data.sections) || []
    const hasSections = sections.length > 0 && items.some(it => it.section)

    function renderDemoItem(item) {
      const type = detectType(item)
      const artSrc = item.coverArt || item.art || (type !== 'image' ? item.image : '') || ''
      const imgProxy = artSrc ? `/api/img?url=${encodeURIComponent(artSrc)}&w=400` : ''

      // Card art area
      let artHtml = ''
      let artOverlay = ''
      if (type === 'video') {
        const videoSrc = esc(item.video || item.src)
        const rawVideoUrl = item.video || item.src || ''
        const vidCidMatch = rawVideoUrl.match(/ipfs-proxy\/([A-Za-z0-9]+)/)
        const videoThumb = vidCidMatch ? `/api/video-thumb?cid=${vidCidMatch[1]}&w=400` : ''
        const poster = item.poster || imgProxy || videoThumb
        artHtml = poster ? `<img src="${esc(poster)}" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover" onerror="this.style.display='none'">` : ''
        artOverlay = `<div class="video-lazy" data-src="${videoSrc}" data-title="${esc(item.title || '')}" style="position:absolute;inset:0;cursor:pointer;display:flex;align-items:center;justify-content:center"><button class="media-play-overlay media-play-overlay--video" style="position:relative;top:auto;left:auto;transform:none"><i class="ph ph-play"></i></button></div>`
      } else if (type === 'image') {
        const imgSrc = item.image || item.src
        const fullImgSrc = esc(imgSrc.startsWith('/') || imgSrc.startsWith('http') ? imgSrc : `/api/img?url=${encodeURIComponent(imgSrc)}&w=1200`)
        artHtml = `<img src="${esc(`/api/img?url=${encodeURIComponent(imgSrc)}&w=400`)}" alt="${esc(item.title || '')}" loading="lazy" style="width:100%;height:100%;object-fit:cover">`
        artOverlay = `<button class="demo-img-view media-play-overlay" data-full-src="${fullImgSrc}" data-title="${esc(item.title || '')}"><i class="ph ph-arrows-out-simple"></i></button>`
      } else if (type === 'audio') {
        if (imgProxy) {
          artHtml = `<img src="${esc(imgProxy)}" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover">`
          artOverlay = `<button class="track-play-btn media-play-overlay" data-track-src="${esc(item.src)}" data-track-title="${esc(item.title || 'demo')}" data-track-artist=""><i class="ph ph-play"></i></button>`
        } else {
          artHtml = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:var(--surface)"><i class="ph ph-music-notes" style="font-size:2em;color:var(--dim)"></i></div>`
          artOverlay = `<button class="track-play-btn media-play-overlay" data-track-src="${esc(item.src)}" data-track-title="${esc(item.title || 'demo')}" data-track-artist=""><i class="ph ph-play"></i></button>`
        }
      } else if (type === 'pdf') {
        // PDF: render first-page thumbnail via canvas (client-side)
        const pdfUid = 'demo-pdf-art-' + Math.random().toString(36).slice(2, 8)
        artHtml = `<div id="${pdfUid}" class="demo-pdf-thumb" data-pdf-src="${esc(item.src)}" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:var(--surface)"><i class="ph ph-file-pdf" style="font-size:2.5em;color:var(--muted)"></i></div>`
        artOverlay = `<button class="media-play-overlay" data-pdf-open="${esc(item.src)}" data-pdf-title="${esc(item.title || '')}" style="z-index:2"><i class="ph ph-book-open"></i></button>`
      } else if (type === 'unknown' && item.src) {
        if (imgProxy) {
          artHtml = `<img src="${esc(imgProxy)}" alt="${esc(item.title || '')}" loading="lazy" style="width:100%;height:100%;object-fit:cover">`
        } else {
          artHtml = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:var(--surface)"><i class="ph ph-file" style="font-size:2em;color:var(--dim)"></i></div>`
        }
        artHtml = `<div class="demo-unknown" data-src="${esc(item.src)}" data-title="${esc(item.title || '')}" style="width:100%;height:100%">${artHtml}</div>`
      } else {
        artHtml = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:var(--surface)"><i class="ph ph-note-pencil" style="font-size:2em;color:var(--dim)"></i></div>`
      }

      // Card info
      let info = `<div class="works-card-title">${esc(item.title || 'untitled')}${item.year ? ` <span style="color:var(--muted);font-size:0.85em">(${esc(item.year)})</span>` : ''}</div>`
      if (item.status || item.description || item.medium) {
        info += `<div class="works-card-meta">`
        if (item.status) info += `${statusBadge(item.status)} `
        if (item.medium) info += `<span style="font-size:0.85em;padding:0.1em 0.4ch;border:1px solid var(--border);color:var(--muted)">${esc(item.medium)}</span> `
        if (item.description) info += `<span>${esc(item.description)}</span>`
        info += `</div>`
      }
      info += metaBlock(item)
      // Action buttons
      let actions = ''
      if (type === 'pdf') actions += `<button data-pdf-open="${esc(item.src)}" data-pdf-title="${esc(item.title || '')}" class="feed-card-btn" style="font-size:0.8em;padding:0.3em 1ch"><i class="ph ph-book-open"></i> read</button>`
      if (item.url) {
        const safeActionUrl = /^(https?:\/\/|\/)/i.test(item.url) ? esc(item.url) : '#'
        actions += `<a href="${safeActionUrl}" class="feed-card-btn" style="text-decoration:none;font-size:0.8em;padding:0.3em 1ch">view</a>`
      }
      actions += buyBtnSmall(item)

      return `<div class="works-card demo-card" data-type="${type}">
        <div class="works-card-art">${artHtml}${artOverlay}</div>
        <div class="works-card-info">
          ${info}
          ${actions ? `<div class="works-card-actions" style="display:flex;gap:0.4em;align-items:center;margin-top:0.4em">${actions}</div>` : ''}
        </div>
      </div>`
    }

    if (hasSections) {
      const unsectioned = items.filter(it => !it.section)
      if (unsectioned.length) {
        html += `<div class="works-grid" style="grid-template-columns:repeat(2,1fr)">`
        for (const item of unsectioned) html += renderDemoItem(item)
        html += `</div>`
      }
      for (const sec of sections) {
        const sectionItems = items.filter(it => it.section === sec.label)
        if (!sectionItems.length) continue
        html += `<div style="color:var(--dim);font-size:0.75em;text-transform:uppercase;letter-spacing:0.1em;margin:1.5em 0 0.75em;border-bottom:1px solid var(--border);padding-bottom:0.3em">${esc(sec.label)}</div>`
        html += `<div class="works-grid" style="grid-template-columns:repeat(2,1fr)">`
        for (const item of sectionItems) html += renderDemoItem(item)
        html += `</div>`
      }
    } else {
      html += `<div class="works-grid" style="grid-template-columns:repeat(2,1fr)">`
      for (const item of items) html += renderDemoItem(item)
      html += `</div>`
    }

    html += `<script>
    import('/js/media.js').then(m => m.wireMediaBuyButtons?.())

    // Detect unknown IPFS content types and upgrade card art areas
    ;(async () => {
      const unknowns = [...document.querySelectorAll('.demo-unknown[data-src]')]
      if (!unknowns.length) return
      const cidMap = {}
      for (const el of unknowns) {
        const m = el.dataset.src.match(/ipfs-proxy\\/([A-Za-z0-9]+)/)
        if (m) cidMap[m[1]] = { el, src: el.dataset.src, title: el.dataset.title || '' }
      }
      const cids = Object.keys(cidMap)
      if (!cids.length) return
      const { resolveContentTypes } = await import('/js/utils.js')
      const types = await resolveContentTypes(cids)
      for (const [cid, ct] of Object.entries(types)) {
        const { el, src, title } = cidMap[cid] || {}
        if (!el || !ct) continue
        const cardArt = el.closest('.works-card-art')
        if (!cardArt) continue
        // Check if card already has a cover art image to preserve
        const hasArt = !!el.querySelector('img')
        if (ct.startsWith('audio/')) {
          if (!hasArt) el.innerHTML = '<i class="ph ph-music-notes" style="font-size:2em;color:var(--dim)"></i>'
          const playBtn = document.createElement('button')
          playBtn.className = 'track-play-btn media-play-overlay'
          playBtn.dataset.trackSrc = src
          playBtn.dataset.trackTitle = title
          playBtn.dataset.trackArtist = ''
          playBtn.innerHTML = '<i class="ph ph-play"></i>'
          cardArt.appendChild(playBtn)
        } else if (ct === 'application/pdf') {
          if (!hasArt) {
            el.innerHTML = '<i class="ph ph-file-pdf" style="font-size:2.5em;color:var(--muted)"></i>'
            renderPdfThumb(el, src)
          }
          const readBtn = document.createElement('button')
          readBtn.className = 'media-play-overlay'
          readBtn.dataset.pdfOpen = src
          readBtn.dataset.pdfTitle = title
          readBtn.innerHTML = '<i class="ph ph-book-open"></i>'
          cardArt.appendChild(readBtn)
        } else if (ct.startsWith('video/')) {
          if (!hasArt) el.innerHTML = ''
          const overlay = document.createElement('div')
          overlay.className = 'video-lazy'
          overlay.dataset.src = src
          overlay.dataset.title = title
          overlay.style.cssText = 'position:absolute;inset:0;cursor:pointer;display:flex;align-items:center;justify-content:center'
          overlay.innerHTML = '<button class="media-play-overlay media-play-overlay--video" style="position:relative;top:auto;left:auto;transform:none"><i class="ph ph-play"></i></button>'
          cardArt.appendChild(overlay)
        } else if (ct.startsWith('image/')) {
          if (!hasArt) el.innerHTML = '<img src="/api/img?url=' + encodeURIComponent(src) + '&w=400" style="width:100%;height:100%;object-fit:cover">'
          const viewBtn = document.createElement('button')
          viewBtn.className = 'demo-img-view media-play-overlay'
          viewBtn.dataset.fullSrc = src
          viewBtn.dataset.title = title
          viewBtn.innerHTML = '<i class="ph ph-arrows-out-simple"></i>'
          cardArt.appendChild(viewBtn)
        }
      }
    })()

    // Render PDF first-page thumbnails
    async function renderPdfThumb(container, src) {
      try {
        // TODO: vendor-bundle pdfjs-dist to remove CDN dependency (esm.sh)
        const pdfjsLib = await import('https://esm.sh/pdfjs-dist@4.0.379/build/pdf.mjs')
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://esm.sh/pdfjs-dist@4.0.379/build/pdf.worker.mjs'
        const pdf = await pdfjsLib.getDocument(src).promise
        const page = await pdf.getPage(1)
        const viewport = page.getViewport({ scale: 1 })
        const scale = Math.min(400 / viewport.width, 400 / viewport.height)
        const sv = page.getViewport({ scale })
        const canvas = document.createElement('canvas')
        canvas.width = sv.width
        canvas.height = sv.height
        canvas.style.cssText = 'width:100%;height:100%;object-fit:contain'
        const ctx = canvas.getContext('2d')
        await page.render({ canvasContext: ctx, viewport: sv }).promise
        container.innerHTML = ''
        container.appendChild(canvas)
      } catch {}
    }
    document.querySelectorAll('.demo-pdf-thumb[data-pdf-src]').forEach(el => {
      renderPdfThumb(el, el.dataset.pdfSrc)
    })

    // PDF viewer: use library's openMediaSheet (same as library items)
    document.addEventListener('click', async (e) => {
      const el = e.target.closest('[data-pdf-open]')
      if (!el) return
      e.preventDefault()
      const { openMediaSheet } = await import('/js/utils.js')
      openMediaSheet({ url: el.dataset.pdfOpen, title: el.dataset.pdfTitle || 'document' })
    })

    // Image lightbox for demo image cards
    ;(function() {
      let lb = document.getElementById('demo-lightbox')
      function openLb(src, title) {
        if (!lb) {
          lb = document.createElement('div')
          lb.id = 'demo-lightbox'
          lb.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.92);display:flex;align-items:center;justify-content:center;cursor:zoom-out'
          lb.innerHTML = '<button style="position:absolute;top:1em;right:1em;background:none;border:none;color:#fff;font-size:1.5em;cursor:pointer;z-index:1">&times;</button><img style="max-width:92vw;max-height:92vh;object-fit:contain"><div style="position:absolute;bottom:1em;left:50%;transform:translateX(-50%);color:#fff;font-size:0.9em;opacity:0.8"></div>'
          document.body.appendChild(lb)
          lb.addEventListener('click', closeLb)
          lb.querySelector('img').addEventListener('click', function(ev) { ev.stopPropagation() })
        }
        lb.querySelector('img').src = src
        lb.querySelector('div').textContent = title
        lb.style.display = 'flex'
        document.addEventListener('keydown', lbKey)
      }
      function closeLb() {
        if (lb) lb.style.display = 'none'
        document.removeEventListener('keydown', lbKey)
      }
      function lbKey(e) { if (e.key === 'Escape') closeLb() }
      document.addEventListener('click', function(e) {
        var btn = e.target.closest('.demo-img-view[data-full-src]')
        if (!btn) return
        e.preventDefault()
        e.stopPropagation()
        openLb(btn.dataset.fullSrc, btn.dataset.title || '')
      })
      window.addEventListener('spa-navigate', closeLb)
    })()
    </script>`
    return html
  },

  renderHighlights(data) {
    const items = Array.isArray(data) ? data : data?.items || []
    if (!items.length) return ''
    return items.slice(0, 3).map(item => {
      const type = detectType(item)
      const artSrc = item.coverArt || item.art || (type !== 'image' ? item.image : '') || ''
      const imgProxy = artSrc ? `/api/img?url=${encodeURIComponent(artSrc)}&w=80` : ''
      let html = `<div class="credit" style="display:flex;align-items:center;gap:0.75em">`

      // Thumbnail based on type
      if (type === 'audio' && item.src) {
        if (imgProxy) {
          html += `<div style="flex-shrink:0;width:40px;height:40px;position:relative;border-radius:3px;overflow:hidden"><img src="${esc(imgProxy)}" alt="" style="width:100%;height:100%;object-fit:cover"><button class="track-play-btn" data-track-src="${esc(item.src)}" data-track-title="${esc(item.title || 'demo')}" data-track-artist="" style="position:absolute;inset:0;background:rgba(0,0,0,0.3);border:none;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:0.7em"><i class="ph ph-play"></i></button></div>`
        } else {
          html += `<button class="track-play-btn" data-track-src="${esc(item.src)}" data-track-title="${esc(item.title || 'demo')}" data-track-artist="" style="flex-shrink:0;width:32px;height:32px;background:var(--surface);border:1px solid var(--border);border-radius:50%;color:var(--fg);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:0.65em"><i class="ph ph-play"></i></button>`
        }
      } else if (type === 'video') {
        html += `<div style="flex-shrink:0;width:40px;height:40px;background:var(--surface);border:1px solid var(--border);border-radius:3px;display:flex;align-items:center;justify-content:center"><i class="ph ph-film-strip" style="color:var(--muted)"></i></div>`
      } else if (type === 'pdf') {
        html += `<div style="flex-shrink:0;width:40px;height:40px;background:var(--surface);border:1px solid var(--border);border-radius:3px;display:flex;align-items:center;justify-content:center"><i class="ph ph-file-pdf" style="color:var(--muted)"></i></div>`
      } else if (type === 'image' && (item.image || item.src)) {
        const src = item.image || item.src
        html += `<div style="flex-shrink:0;width:40px;height:40px;border-radius:3px;overflow:hidden"><img src="${esc(`/api/img?url=${encodeURIComponent(src)}&w=80`)}" alt="" style="width:100%;height:100%;object-fit:cover"></div>`
      } else if (type === 'unknown' || (item.src && type !== 'text')) {
        html += `<div class="demo-highlight-unk" data-src="${esc(item.src)}" style="flex-shrink:0;width:40px;height:40px;background:var(--surface);border:1px solid var(--border);border-radius:3px;display:flex;align-items:center;justify-content:center"><i class="ph ph-file" style="color:var(--muted)"></i></div>`
      }

      // Title + metadata
      html += `<div style="flex:1;min-width:0">`
      html += `<span class="credit-title" style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(item.title || 'untitled')}</span>`
      if (item.status || item.description) {
        html += `<span class="credit-detail" style="display:block;font-size:0.8em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">`
        if (item.status) html += esc(item.status)
        if (item.status && item.description) html += ' · '
        if (item.description) html += esc(item.description)
        html += `</span>`
      }
      html += `</div>`
      html += `</div>`
      return html
    }).join('\n')
  },

  renderCV(data) {
    if (!data) return ''
    const items = Array.isArray(data) ? data : data.items || []
    return items
      .map(item => `<div class="cv-item"><span class="cv-title">${esc(item.title)}</span>${item.year ? ` <span class="cv-detail">-- ${esc(item.year)}</span>` : ''}${item.status ? ` <span class="cv-detail">[${esc(item.status)}]</span>` : ''}</div>`)
      .join('\n')
  },
}
