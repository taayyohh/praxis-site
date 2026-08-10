// Video module — music videos, live performances, reels, visual art videos
// Generic video content for any artist type (distinct from film module which is for filmmakers)
// data: { items: [{ title, year, src, poster, description, collaborators, mediaId, mediaPrice, director, cast, cinematographer, editor, runtime, genre, location }] }
import { esc, batchBuyScript, slugify } from './shared.js'
export default {
  type: 'video',
  label: 'video',
  route: '/video',

  renderSection(data) {
    if (!data) return ''
    const items = Array.isArray(data) ? data : data.items || []
    if (!items.length) return ''
    const sections = (!Array.isArray(data) && data.sections) || []

    // Respect the order from site.json (set by user in settings module editor)
    // First item is featured (full-width)
    const sorted = items

    function renderVideoItem(v, isFeatured, idx) {
      const cls = isFeatured ? 'video-item video-featured' : 'video-item'
      let html = `<div class="${cls}">`
      if (v.src) {
        let posterUrl = v.poster || ''
        if (!posterUrl && v.src) {
          const cidMatch = v.src.match(/\/api\/ipfs-proxy\/([A-Za-z0-9]+)/)
          if (cidMatch) posterUrl = `/api/video-thumb?cid=${cidMatch[1]}&w=${isFeatured ? 960 : 640}`
        }
        html += `<div class="video-player">
          <div class="video-lazy" data-src="${esc(v.src)}" data-poster="${esc(posterUrl)}" data-title="${esc(v.title || '')}">
            ${posterUrl ? `<img src="${esc(posterUrl)}" alt="" loading="lazy" style="cursor:pointer">` : `<div style="background:#111;display:flex;align-items:center;justify-content:center;cursor:pointer;aspect-ratio:16/9"><span style="color:var(--muted)">play</span></div>`}
          </div>

          <button class="track-queue-btn" data-src="${esc(v.src)}" data-title="${esc(v.title || '')}" data-art="${esc(posterUrl || '')}" data-type="video" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:0.9em;padding:0.2em 0.5ch" title="add to queue"><i class="ph ph-plus"></i></button>
        </div>`
      }
      html += `<div class="video-caption">`
      const artUrl = `/video/${slugify(v.title)}`
      html += `<a href="${artUrl}" class="video-detail-link" style="color:inherit;text-decoration:none"><span class="video-title">${esc(v.title)}</span></a>`
      if (v.year) html += ` <span class="video-year">(${esc(v.year)})</span>`
      if (v.runtime) html += ` <span class="video-runtime" style="font-size:0.7em;padding:0.1em 0.6ch;border:1px solid var(--border);color:var(--muted)">${esc(v.runtime)}</span>`
      if (v.genre) html += ` <span class="video-genre" style="font-size:0.7em;padding:0.1em 0.4ch;border:1px solid var(--border);color:var(--muted)">${esc(v.genre)}</span>`
      if (v.director) html += `<br><span class="video-director" style="color:var(--muted);font-size:0.85em">dir. ${esc(v.director)}</span>`
      if (v.cast) html += `<br><span class="video-cast" style="color:var(--muted);font-size:0.85em">starring ${esc(v.cast)}</span>`
      if (v.collaborators) html += ` <span class="video-collabs">${esc(v.collaborators)}</span>`
      if (v.collab) html += `<br><span style="color:var(--muted);font-size:0.85em">with <a href="https://${esc(v.collab.from)}" style="color:var(--accent);text-decoration:none">${esc(v.collab.from)}</a></span>`
      const crewParts = []
      if (v.cinematographer) crewParts.push(`dp. ${esc(v.cinematographer)}`)
      if (v.editor) crewParts.push(`ed. ${esc(v.editor)}`)
      if (crewParts.length) html += `<br><span class="video-crew" style="color:var(--dim);font-size:0.8em">${crewParts.join(' · ')}</span>`
      if (v.location) html += `<br><span style="color:var(--dim);font-size:0.8em">${esc(v.location)}</span>`
      if (v.mediaId !== undefined && v.mediaId !== null) {
        const priceEth = v.mediaPrice ? (Number(v.mediaPrice) / 1e18) : 0
        const priceLabel = priceEth > 0 ? `${priceEth} ETH` : 'free'
        html += ` <button class="track-buy-btn" data-media-id="${esc(v.mediaId)}" data-price="${esc(v.mediaPrice || '0')}" data-eth-wei="${esc(v.mediaPrice || '0')}" style="background:none;border:1px solid var(--green);color:var(--green);font-family:inherit;font-size:0.7em;padding:0.1em 0.6ch;cursor:pointer;margin-left:0.5ch">${priceLabel}</button>`
      }
      html += `</div>`
      if (isFeatured && v.description) html += `<p class="video-desc">${esc(v.description)}</p>`
      html += `</div>`
      return html
    }

    const hasSections = sections.length > 0 && sorted.some(v => v.section)

    let html = ''

    if (hasSections) {
      // Items without a section go at top (no header)
      const unsectioned = sorted.filter(v => !v.section)
      if (unsectioned.length) {
        html += renderVideoItem(unsectioned[0], true, items.indexOf(unsectioned[0]))
        if (unsectioned.length > 1) {
          html += `<div class="video-grid">`
          for (let i = 1; i < unsectioned.length; i++) html += renderVideoItem(unsectioned[i], false, items.indexOf(unsectioned[i]))
          html += `</div>`
        }
      }
      for (const sec of sections) {
        const sectionItems = sorted.filter(v => v.section === sec.label)
        if (!sectionItems.length) continue
        let sectionHeader = `<div style="color:var(--dim);font-size:0.75em;text-transform:uppercase;letter-spacing:0.1em;margin:1.5em 0 0.75em;border-bottom:1px solid var(--border);padding-bottom:0.3em">${esc(sec.label)}`
        // Buy collection button for this section
        const listedInSection = sectionItems.filter(v => v.mediaId !== undefined && v.mediaId !== null)
        if (listedInSection.length >= 2) {
          const totalWei = listedInSection.reduce((sum, v) => sum + BigInt(v.mediaPrice || '0'), 0n)
          const totalEth = Number(totalWei) / 1e18
          const priceLabel = totalEth > 0 ? `${totalEth} ETH` : 'free'
          const idsJson = esc(JSON.stringify(listedInSection.map(v => v.mediaId)))
          sectionHeader += ` <button class="batch-buy-btn" data-media-ids="${idsJson}" data-total-price="${totalWei.toString()}" data-eth-wei="${totalWei.toString()}" style="background:none;border:1px solid var(--green);color:var(--green);font-family:inherit;font-size:0.85em;padding:0.15em 0.8ch;cursor:pointer;text-transform:none;letter-spacing:normal">buy collection (${priceLabel})</button>`
        }
        sectionHeader += `</div>`
        html += sectionHeader
        // First item in section is featured
        html += renderVideoItem(sectionItems[0], true, items.indexOf(sectionItems[0]))
        if (sectionItems.length > 1) {
          html += `<div class="video-grid">`
          for (let i = 1; i < sectionItems.length; i++) html += renderVideoItem(sectionItems[i], false, items.indexOf(sectionItems[i]))
          html += `</div>`
        }
      }
    } else {
      // No sections: render flat (backward compatible)
      // build index map so we can pass original index for art detail links
      const idxMap = sorted.map(s => items.indexOf(s))
      // Buy all videos button (flat layout)
      const allListed = sorted.filter(v => v.mediaId !== undefined && v.mediaId !== null)
      if (allListed.length >= 2) {
        const totalWei = allListed.reduce((sum, v) => sum + BigInt(v.mediaPrice || '0'), 0n)
        const totalEth = Number(totalWei) / 1e18
        const priceLabel = totalEth > 0 ? `${totalEth} ETH` : 'free'
        const idsJson = esc(JSON.stringify(allListed.map(v => v.mediaId)))
        html += `<div style="margin-bottom:1em"><button class="batch-buy-btn" data-media-ids="${idsJson}" data-total-price="${totalWei.toString()}" data-eth-wei="${totalWei.toString()}" style="background:none;border:1px solid var(--green);color:var(--green);font-family:inherit;font-size:0.85em;padding:0.3em 1.2ch;cursor:pointer">buy all videos (${priceLabel})</button></div>`
      }
      // featured: first/latest video full-width
      html += renderVideoItem(sorted[0], true, idxMap[0])
      // additional videos in a 2-column grid
      if (sorted.length > 1) {
        html += `<div class="video-grid">`
        for (let i = 1; i < sorted.length; i++) {
          html += renderVideoItem(sorted[i], false, idxMap[i])
        }
        html += `</div>`
      }
    }

    html += `<script>
      ${batchBuyScript('buy collection ({price})')}
      </script>`
    return html
  },

  renderCV(data) {
    if (!data) return ''
    const items = Array.isArray(data) ? data : data.items || []
    return items
      .sort((a, b) => (b.year || 0) - (a.year || 0))
      .map(v => `<div class="cv-item"><span class="cv-title">${esc(v.title)}</span>${v.year ? ` <span class="cv-detail">-- ${esc(v.year)}</span>` : ''}</div>`)
      .join('\n')
  },

  renderHighlights(data) {
    if (!data) return ''
    const items = Array.isArray(data) ? data : data.items || []
    if (!items.length) return ''
    const recent = [...items].sort((a, b) => (b.year || 0) - (a.year || 0)).slice(0, 3)
    const idxMap = recent.map(r => items.indexOf(r))

    function renderThumb(v, idx) {
      let posterUrl = v.poster || ''
      if (!posterUrl && v.src) {
        const cidMatch = v.src.match(/\/api\/ipfs-proxy\/([A-Za-z0-9]+)/)
        if (cidMatch) posterUrl = `/api/video-thumb?cid=${cidMatch[1]}&w=640`
      }
      const artUrl = `/video/${slugify(v.title)}`
      let html = `<div class="video-item">`
      if (v.src) {
        html += `<div class="video-player">
          <div class="video-lazy" data-src="${esc(v.src)}" data-poster="${esc(posterUrl)}" data-title="${esc(v.title || '')}">
            ${posterUrl ? `<img src="${esc(posterUrl)}" alt="" loading="lazy" style="cursor:pointer">` : `<div style="background:#111;display:flex;align-items:center;justify-content:center;cursor:pointer;aspect-ratio:16/9"><span style="color:var(--muted)">play</span></div>`}
          </div>

          <button class="track-queue-btn" data-src="${esc(v.src)}" data-title="${esc(v.title || '')}" data-art="${esc(posterUrl || '')}" data-type="video" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:0.9em;padding:0.2em 0.5ch" title="add to queue"><i class="ph ph-plus"></i></button>
        </div>`
      }
      html += `<div class="video-caption">`
      html += `<a href="${artUrl}" class="video-detail-link" style="color:inherit;text-decoration:none"><span class="video-title">${esc(v.title)}</span></a>`
      if (v.year) html += ` <span class="video-year">(${esc(v.year)})</span>`
      html += `</div></div>`
      return html
    }

    let html = '<div class="video-grid">'
    for (let i = 0; i < recent.length; i++) {
      html += renderThumb(recent[i], idxMap[i])
    }
    html += '</div>'
    return html
  },
}
