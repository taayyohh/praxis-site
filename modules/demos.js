// Demos module — works in progress, rough cuts, sketches, drafts
// For unfinished/in-progress work across all disciplines
// data: { items: [{ title, description, year, art, coverArt, src, url, status, mediaId, mediaPrice, collaborators, tools, startedDate, estimatedCompletion, notes, medium }] }
function esc(s) {
  if (typeof s !== 'string') return s == null ? '' : String(s)
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
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
      const posterAttr = item.poster ? ` poster="${esc(item.poster)}"` : ''
      const hasVisual = (item.src && (item.src.match(/\.(mp4|webm|mov|jpe?g|png|gif|webp|svg|avif)$/i) || item.srcType === 'image')) || item.video || item.image
      const isAudio = item.src && !item.src.match(/\.(mp4|webm|mov|jpe?g|png|gif|webp|svg|avif|pdf)$/i) && item.srcType !== 'image'
      const mediaStyle = 'max-width:min(300px,100%);max-height:40vh;width:auto;height:auto;object-fit:contain;display:block'

      // Build metadata block
      let meta = ''
      meta += `<div class="credit-title">${esc(item.title)}${item.year ? ` <span style="color:var(--muted);font-size:0.85em">(${esc(item.year)})</span>` : ''}`
      if (item.status) {
        const statusColors = { 'in-progress': 'var(--green)', shelved: 'var(--muted)', released: 'var(--accent, var(--green))' }
        meta += ` <span class="demo-status" style="font-size:0.7em;padding:0.1em 0.6ch;border:1px solid ${statusColors[item.status] || 'var(--muted)'};color:${statusColors[item.status] || 'var(--muted)'}">${esc(item.status)}</span>`
      }
      if (item.mediaId !== undefined && item.mediaId !== null) {
        const priceEth = item.mediaPrice ? (Number(item.mediaPrice) / 1e18) : 0
        const priceLabel = priceEth > 0 ? `${priceEth} ETH` : 'free'
        meta += ` <button class="track-buy-btn" data-media-id="${item.mediaId}" data-price="${item.mediaPrice || '0'}" data-eth-wei="${item.mediaPrice || '0'}" style="background:none;border:1px solid var(--green);color:var(--green);font-family:inherit;font-size:0.7em;padding:0.1em 0.6ch;cursor:pointer;margin-left:0.5ch">${priceLabel}</button>`
      }
      if (item.medium) meta += ` <span style="font-size:0.7em;padding:0.1em 0.4ch;border:1px solid var(--border);color:var(--muted)">${esc(item.medium)}</span>`
      meta += `</div>`
      if (item.collab) meta += `<div style="color:var(--muted);font-size:0.85em;margin:0.15em 0">with <a href="https://${esc(item.collab.from)}" style="color:var(--accent);text-decoration:none">${esc(item.collab.from)}</a></div>`
      else if (item.collaborators) meta += `<div style="color:var(--muted);font-size:0.85em;margin:0.15em 0">with ${esc(item.collaborators)}</div>`
      if (item.tools) meta += `<div style="margin:0.15em 0">${item.tools.split(',').map(t => `<span style="font-size:0.7em;padding:0.1em 0.4ch;border:1px solid var(--border);color:var(--dim);margin-right:0.3ch">${esc(t.trim())}</span>`).join('')}</div>`
      if (item.startedDate || item.estimatedCompletion) meta += `<div style="color:var(--dim);font-size:0.8em;margin:0.15em 0">${item.startedDate ? `started ${esc(item.startedDate)}` : ''}${item.startedDate && item.estimatedCompletion ? ' · ' : ''}${item.estimatedCompletion ? `est. ${esc(item.estimatedCompletion)}` : ''}</div>`
      if (item.description) meta += `<div style="color:var(--fg);font-size:0.9em;margin:0.25em 0">${esc(item.description)}</div>`
      if (item.notes) meta += `<div style="color:var(--dim);font-size:0.85em;margin:0.25em 0;font-style:italic">${esc(item.notes)}</div>`
      if (isAudio) meta += `<button class="track-play-btn" data-track-src="${esc(item.src)}" data-track-title="${esc(item.title || 'demo')}" data-track-artist="" style="background:none;border:1px solid var(--muted);color:var(--fg);font-family:inherit;font-size:0.8em;padding:0.2em 1ch;cursor:pointer;margin-top:0.5em"><i class="ph ph-play"></i> play</button>`
      if (item.url) meta += `<div style="margin-top:0.25em"><a href="${esc(item.url)}" style="color:var(--muted);font-size:0.85em">view</a></div>`

      // Build media block
      let media = ''
      if (item.src && item.src.match(/\.(mp4|webm|mov)$/i)) media += `<video src="${esc(item.src)}"${posterAttr} controls preload="none" playsinline style="${mediaStyle}"></video>`
      else if (item.src && (item.src.match(/\.(jpe?g|png|gif|webp|svg|avif)$/i) || (item.src.includes('/ipfs/') && item.srcType === 'image'))) media += `<img src="${esc(`/api/img?url=${encodeURIComponent(item.src)}&w=600`)}" alt="${esc(item.title || '')}" loading="lazy" style="${mediaStyle}">`
      else if (item.src && item.src.match(/\.pdf$/i)) { const pid = 'demo-pdf-' + Math.random().toString(36).slice(2, 8); media += `<div id="${pid}" class="demo-pdf" data-pdf-src="${esc(item.src)}" style="max-height:40vh;overflow:auto"></div>` }
      if (item.video) media += `<video src="${esc(item.video)}"${posterAttr} controls preload="none" playsinline style="${mediaStyle}"></video>`
      if (item.image && item.image !== item.src && item.image !== (item.coverArt || item.art)) media += `<img src="${esc(`/api/img?url=${encodeURIComponent(item.image)}&w=600`)}" alt="${esc(item.title || '')}" loading="lazy" style="${mediaStyle}">`

      // Assemble: side-by-side if visual media, otherwise just metadata
      let out = `<div class="demo-item" style="margin-bottom:1.5em;padding-bottom:1.5em;border-bottom:1px solid var(--border)">`
      if (hasVisual && media) {
        out += `<div style="display:flex;gap:1.5em;align-items:flex-start;flex-wrap:wrap">`
        out += `<div style="flex:1;min-width:180px">${meta}</div>`
        out += `<div style="flex-shrink:0">${media}</div>`
        out += `</div>`
      } else {
        out += meta
      }
      out += `</div>`
      return out
    }

    if (hasSections) {
      const unsectioned = items.filter(it => !it.section)
      for (const item of unsectioned) html += renderDemoItem(item)
      for (const sec of sections) {
        const sectionItems = items.filter(it => it.section === sec.label)
        if (!sectionItems.length) continue
        html += `<div style="color:var(--dim);font-size:0.75em;text-transform:uppercase;letter-spacing:0.1em;margin:1.5em 0 0.75em;border-bottom:1px solid var(--border);padding-bottom:0.3em">${esc(sec.label)}</div>`
        for (const item of sectionItems) html += renderDemoItem(item)
      }
    } else {
      for (const item of items) html += renderDemoItem(item)
    }

    html += `<script>
    import('/js/media.js').then(m => m.wireMediaBuyButtons?.())
    // PDF viewer (reuse library pattern)
    document.querySelectorAll('.demo-pdf[data-pdf-src]').forEach(async el => {
      const { renderMedia } = await import('/js/utils.js')
      el.innerHTML = renderMedia(el.dataset.pdfSrc, el.dataset.pdfSrc)
    })
    </script>`
    return html
  },

  renderHighlights(data) {
    const items = Array.isArray(data) ? data : data?.items || []
    if (!items.length) return ''
    return items.slice(0, 3).map(item => {
      const isAudio = item.src && !item.src.match(/\.(mp4|webm|mov|jpe?g|png|gif|webp|svg|avif|pdf)$/i) && item.srcType !== 'image'
      let html = `<div class="credit">`
      html += `<span class="credit-title">${esc(item.title || 'untitled')}</span>`
      if (item.status) html += ` <span class="credit-detail">-- ${esc(item.status)}</span>`
      if (item.description) html += ` <span class="credit-detail">-- ${esc(item.description)}</span>`
      if (isAudio) html += ` <button class="track-play-btn" data-track-src="${esc(item.src)}" data-track-title="${esc(item.title || 'demo')}" data-track-artist="" style="background:none;border:1px solid var(--muted);color:var(--fg);font-family:inherit;font-size:0.7em;padding:0.1em 0.6ch;cursor:pointer;margin-left:0.5ch"><i class="ph ph-play"></i> play</button>`
      else if (item.src) html += ` <a href="/demos" style="color:var(--muted);font-size:0.75em;margin-left:0.5ch">view</a>`
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
