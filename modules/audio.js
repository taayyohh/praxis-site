// Audio module — podcasts, sound design, voiceover, audio essays
// For podcasters, sound designers, voice actors, audio engineers
import { esc, batchBuyScript, slugify } from './shared.js'
function safeUrl(u) {
  if (!u || typeof u !== 'string') return '#'
  try {
    const parsed = new URL(u, 'https://placeholder.invalid')
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return '#'
    return esc(u)
  } catch { return '#' }
}
export default {
  type: 'audio',
  label: 'audio',
  route: '/audio',

  renderSection(data) {
    if (!data) return ''
    let html = ''
    const items = Array.isArray(data) ? data : data.items || []
    const sections = (!Array.isArray(data) && data.sections) || []
    const hasSections = sections.length > 0 && items.some(it => it.section)

    function renderAudioItem(item) {
      let out = ''
      out += `<div class="audio-item" style="margin-bottom:1.5em">`
      if (item.coverArt || item.art) {
        const artSrc = `/audio/${slugify(item.title)}`
        const cover = `/api/img?url=${encodeURIComponent(item.coverArt || item.art)}&w=120`
        out += `<div style="display:flex;gap:0.75em;align-items:flex-start">`
        out += `<img src="${esc(cover)}" alt="" loading="lazy" style="width:60px;height:60px;object-fit:cover;flex-shrink:0">`
        out += `<div style="flex:1;min-width:0">`
      }
      out += `<div class="credit-title">`
      if (item.series) out += `<span class="audio-series" style="color:var(--muted);font-size:0.8em">${esc(item.series)}</span> `
      if (item.episodeNumber) out += `<span class="audio-episode" style="color:var(--muted);font-size:0.8em">#${esc(item.episodeNumber)}</span> `
      out += `${esc(item.title)}${item.year ? ` <span style="color:var(--muted);font-size:0.85em">(${esc(item.year)})</span>` : ''}`
      if (item.mediaId !== undefined && item.mediaId !== null) {
        const priceEth = item.mediaPrice ? (Number(item.mediaPrice) / 1e18) : 0
        const priceLabel = priceEth > 0 ? `${priceEth} ETH` : 'free'
        out += ` <button class="track-buy-btn" data-media-id="${esc(item.mediaId)}" data-price="${esc(item.mediaPrice || '0')}" data-eth-wei="${esc(item.mediaPrice || '0')}" style="background:none;border:1px solid var(--green);color:var(--green);font-family:inherit;font-size:0.7em;padding:0.1em 0.6ch;cursor:pointer;margin-left:0.5ch">${priceLabel}</button>`
      }
      out += `</div>`
      if (item.guests) out += `<div class="audio-guests" style="color:var(--muted);font-size:0.85em;margin:0.15em 0">with ${esc(item.guests)}</div>`
      if (item.description) out += `<div style="color:var(--fg);font-size:0.9em;margin:0.25em 0">${esc(item.description)}</div>`
      if (item.collab) out += `<div style="color:var(--muted);font-size:0.85em">with <a href="https://${esc(item.collab.from)}" style="color:var(--accent);text-decoration:none">${esc(item.collab.from)}</a></div>`
      if (item.src) out += `<button class="track-play-btn" data-track-src="${esc(item.src)}" data-track-title="${esc(item.title || 'untitled')}" data-track-artist="${esc(item.guests || '')}" style="background:none;border:1px solid var(--accent);color:var(--accent);font-family:inherit;font-size:0.8em;padding:0.2em 0.8ch;cursor:pointer;margin-top:0.5em">play</button>`
      if (item.url) out += `<a href="${safeUrl(item.url)}" style="color:var(--muted);font-size:0.85em">listen</a>`
      if (item.coverArt || item.art) {
        out += `</div></div>`
      }
      out += `</div>`
      return out
    }

    if (hasSections) {
      const unsectioned = items.filter(it => !it.section)
      for (const item of unsectioned) html += renderAudioItem(item)
      for (const sec of sections) {
        const sectionItems = items.filter(it => it.section === sec.label)
        if (!sectionItems.length) continue
        let secHeader = `<div style="color:var(--dim);font-size:0.75em;text-transform:uppercase;letter-spacing:0.1em;margin:1.5em 0 0.75em;border-bottom:1px solid var(--border);padding-bottom:0.3em">${esc(sec.label)}`
        // Buy collection button for this section
        const listedInSection = sectionItems.filter(it => it.mediaId !== undefined && it.mediaId !== null)
        if (listedInSection.length >= 2) {
          const totalWei = listedInSection.reduce((sum, it) => sum + BigInt(it.mediaPrice || '0'), 0n)
          const totalEth = Number(totalWei) / 1e18
          const priceLabel = totalEth > 0 ? `${totalEth} ETH` : 'free'
          const idsJson = esc(JSON.stringify(listedInSection.map(it => it.mediaId)))
          secHeader += ` <button class="batch-buy-btn" data-media-ids="${idsJson}" data-total-price="${totalWei.toString()}" data-eth-wei="${totalWei.toString()}" style="background:none;border:1px solid var(--green);color:var(--green);font-family:inherit;font-size:0.85em;padding:0.15em 0.8ch;cursor:pointer;text-transform:none;letter-spacing:normal">buy collection (${priceLabel})</button>`
        }
        secHeader += `</div>`
        html += secHeader
        for (const item of sectionItems) html += renderAudioItem(item)
      }
    } else {
      // Buy all button for flat layout
      const allListed = items.filter(it => it.mediaId !== undefined && it.mediaId !== null)
      if (allListed.length >= 2) {
        const totalWei = allListed.reduce((sum, it) => sum + BigInt(it.mediaPrice || '0'), 0n)
        const totalEth = Number(totalWei) / 1e18
        const priceLabel = totalEth > 0 ? `${totalEth} ETH` : 'free'
        const idsJson = esc(JSON.stringify(allListed.map(it => it.mediaId)))
        html += `<div style="margin-bottom:1em"><button class="batch-buy-btn" data-media-ids="${idsJson}" data-total-price="${totalWei.toString()}" data-eth-wei="${totalWei.toString()}" style="background:none;border:1px solid var(--green);color:var(--green);font-family:inherit;font-size:0.85em;padding:0.3em 1.2ch;cursor:pointer">buy all (${priceLabel})</button></div>`
      }
      for (const item of items) html += renderAudioItem(item)
    }

    html += `<script>${batchBuyScript('buy all ({price})')}</script>`
    return html
  },

  renderHighlights(data) {
    const items = Array.isArray(data) ? data : data?.items || []
    if (!items.length) return ''
    return items.slice(0, 3).map(item => {
      let html = `<div class="credit">`
      html += `<span class="credit-title">${esc(item.title || 'untitled')}</span>`
      if (item.description) html += ` <span class="credit-detail">-- ${esc(item.description)}</span>`
      html += `</div>`
      return html
    }).join('\n')
  },

  renderCV(data) {
    if (!data) return ''
    const items = Array.isArray(data) ? data : data.items || []
    return items
      .map(item => `<div class="cv-item"><span class="cv-title">${esc(item.title)}</span>${item.year ? ` <span class="cv-detail">-- ${esc(item.year)}</span>` : ''}</div>`)
      .join('\n')
  },
}
