// Film module — video uploads, reels, festival credits, shorts
// For filmmakers, directors, cinematographers, editors, animators
// data: { works: [{ title, role, director, year, video, poster, description, cast, genre, runtime, mediaId, mediaPrice, cinematographer, composer, editor, writer, productionCompany, synopsis, distributor, trailer }], festivals: [{ festival, film, year, result }] }
function esc(s) {
  if (typeof s !== 'string') return s == null ? '' : String(s)
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
function safeUrl(u) {
  if (typeof u !== 'string' || !u) return ''
  const trimmed = u.trim()
  if (/^(javascript|data|vbscript):/i.test(trimmed)) return ''
  return esc(trimmed)
}
export default {
  type: 'film',
  label: 'film',
  route: '/film',

  renderSection(data) {
    if (!data) return ''
    let html = ''
    const works = data.works || []
    const sections = data.sections || []
    const hasSections = sections.length > 0 && works.some(w => w.section)

    function renderWork(w) {
      let out = ''
      const workIdx = works.indexOf(w)
      const artUrl = `/art?type=film&amp;work=${workIdx}`
      out += `<div class="credit"><a href="${artUrl}" style="color:inherit;text-decoration:none"><span class="credit-title">${esc(w.title)}</span></a> <span class="credit-detail">-- ${esc(w.role)}${w.director ? `, dir. ${esc(w.director)}` : ''}${w.year ? `, ${esc(w.year)}` : ''}</span>`
      if (w.runtime) out += ` <span class="film-runtime" style="font-size:0.7em;padding:0.1em 0.6ch;border:1px solid var(--border);color:var(--muted)">${esc(w.runtime)}</span>`
      if (w.productionCompany) out += `<br><span style="color:var(--muted);font-size:0.85em">${esc(w.productionCompany)}</span>`
      if (w.description) out += `<br><span style="color:var(--fg);font-size:0.9em">${esc(w.description)}</span>`
      if (w.synopsis) out += `<br><span class="film-synopsis" style="color:var(--fg);font-size:0.9em">${esc(w.synopsis)}</span>`
      if (w.cast) out += `<br><span style="color:var(--muted);font-size:0.85em">starring ${esc(Array.isArray(w.cast) ? w.cast.join(', ') : w.cast)}</span>`
      const crewParts = []
      if (w.cinematographer) crewParts.push(`dp. ${esc(w.cinematographer)}`)
      if (w.composer) crewParts.push(`music ${esc(w.composer)}`)
      if (w.editor) crewParts.push(`ed. ${esc(w.editor)}`)
      if (w.writer) crewParts.push(`written by ${esc(w.writer)}`)
      if (crewParts.length) out += `<br><span class="film-crew" style="color:var(--dim);font-size:0.8em">${crewParts.join(' · ')}</span>`
      if (w.distributor) out += `<br><span style="color:var(--dim);font-size:0.8em">distributed by ${esc(w.distributor)}</span>`
      if (w.collab) out += `<br><span style="color:var(--muted);font-size:0.85em">with <a href="https://${esc(w.collab.from)}" style="color:var(--accent);text-decoration:none">${esc(w.collab.from)}</a></span>`
      if (w.trailer) out += ` <a href="${safeUrl(w.trailer)}" target="_blank" rel="noopener" style="color:var(--muted);font-size:0.75em;text-decoration:none;border-bottom:1px solid var(--border)">trailer</a>`
      if (w.mediaId !== undefined && w.mediaId !== null) {
        const priceEth = w.mediaPrice ? (Number(w.mediaPrice) / 1e18) : 0
        const priceLabel = priceEth > 0 ? `${priceEth} ETH` : 'free'
        out += ` <button class="track-buy-btn" data-media-id="${esc(w.mediaId)}" data-price="${esc(w.mediaPrice || '0')}" data-eth-wei="${esc(w.mediaPrice || '0')}" style="background:none;border:1px solid var(--green);color:var(--green);font-family:inherit;font-size:0.7em;padding:0.1em 0.6ch;cursor:pointer;margin-left:0.5ch">${priceLabel}</button>`
      }
      if (w.video) {
        const posterUrl = w.poster ? `/api/img?url=${encodeURIComponent(w.poster)}&w=960` : ''
        out += `<div style="margin-top:0.5em"><div class="video-lazy" data-src="${esc(w.video)}" data-poster="${esc(posterUrl)}" data-title="${esc(w.title || '')}">${posterUrl ? `<img src="${esc(posterUrl)}" alt="" loading="lazy" style="max-width:100%;cursor:pointer">` : `<div style="background:#111;display:flex;align-items:center;justify-content:center;cursor:pointer;aspect-ratio:16/9"><span style="color:var(--muted)">play</span></div>`}</div></div>`
      }
      out += `</div>`
      return out
    }

    if (works.length) {
      const sorted = [...works].sort((a, b) => (b.year || 0) - (a.year || 0))
      if (hasSections) {
        const unsectioned = sorted.filter(w => !w.section)
        for (const w of unsectioned) html += renderWork(w)
        for (const sec of sections) {
          const sectionWorks = sorted.filter(w => w.section === sec.label)
          if (!sectionWorks.length) continue
          let secHeader = `<div style="color:var(--dim);font-size:0.75em;text-transform:uppercase;letter-spacing:0.1em;margin:1.5em 0 0.75em;border-bottom:1px solid var(--border);padding-bottom:0.3em">${esc(sec.label)}`
          const listedInSection = sectionWorks.filter(w => w.mediaId !== undefined && w.mediaId !== null)
          if (listedInSection.length >= 2) {
            const totalWei = listedInSection.reduce((sum, w) => sum + BigInt(w.mediaPrice || '0'), 0n)
            const totalEth = Number(totalWei) / 1e18
            const priceLabel = totalEth > 0 ? `${totalEth} ETH` : 'free'
            const idsJson = esc(JSON.stringify(listedInSection.map(w => w.mediaId)))
            secHeader += ` <button class="batch-buy-btn" data-media-ids="${idsJson}" data-total-price="${totalWei.toString()}" data-eth-wei="${totalWei.toString()}" style="background:none;border:1px solid var(--green);color:var(--green);font-family:inherit;font-size:0.85em;padding:0.15em 0.8ch;cursor:pointer;text-transform:none;letter-spacing:normal">buy collection (${priceLabel})</button>`
          }
          secHeader += `</div>`
          html += secHeader
          for (const w of sectionWorks) html += renderWork(w)
        }
      } else {
        // Buy all button for flat layout
        const allListed = sorted.filter(w => w.mediaId !== undefined && w.mediaId !== null)
        if (allListed.length >= 2) {
          const totalWei = allListed.reduce((sum, w) => sum + BigInt(w.mediaPrice || '0'), 0n)
          const totalEth = Number(totalWei) / 1e18
          const priceLabel = totalEth > 0 ? `${totalEth} ETH` : 'free'
          const idsJson = esc(JSON.stringify(allListed.map(w => w.mediaId)))
          html += `<div style="margin-bottom:1em"><button class="batch-buy-btn" data-media-ids="${idsJson}" data-total-price="${totalWei.toString()}" data-eth-wei="${totalWei.toString()}" style="background:none;border:1px solid var(--green);color:var(--green);font-family:inherit;font-size:0.85em;padding:0.3em 1.2ch;cursor:pointer">buy all films (${priceLabel})</button></div>`
        }
        for (const w of sorted) html += renderWork(w)
      }
    }
    if (data.festivals?.length) {
      html += '<h3>festivals</h3>'
      for (const f of data.festivals) {
        html += `<div class="credit"><span class="credit-title">${esc(f.festival)}</span> <span class="credit-detail">-- ${esc(f.film)}, ${esc(f.year)}</span>${f.result ? ` <span style="color:var(--green);font-size:0.85em">${esc(f.result)}</span>` : ''}</div>`
      }
    }

    html += `<script>
    import('/js/media.js').then(m => m.wireMediaBuyButtons?.())
    // Wire batch buy buttons
    if (!window._batchBuyDelegated) {
      window._batchBuyDelegated = true
      document.addEventListener('click', async (e) => {
        const btn = e.target.closest('.batch-buy-btn[data-media-ids]')
        if (!btn || btn.disabled) return
        e.stopPropagation()
        try {
          const ids = JSON.parse(btn.dataset.mediaIds)
          const totalPrice = btn.dataset.totalPrice || '0'
          const addr = window.getWalletAddress?.()
          if (addr) {
            const owned = await window._getOwnedMediaIds?.(addr)
            if (owned) {
              const unownedIds = ids.filter(id => !owned.has(String(id)))
              if (unownedIds.length === 0) { btn.textContent = 'owned'; btn.disabled = true; return }
            }
          }
          btn.textContent = 'confirming...'
          btn.disabled = true
          const { purchaseBatchMedia } = await import('/js/media.js')
          await purchaseBatchMedia(ids, totalPrice)
          btn.textContent = 'owned'
          btn.style.borderColor = 'var(--accent)'
          btn.style.color = 'var(--accent)'
        } catch (err) {
          btn.textContent = err.code === 4001 ? 'cancelled' : 'error'
          btn.disabled = false
          setTimeout(() => {
            const totalEth = Number(btn.dataset.totalPrice || '0') / 1e18
            btn.textContent = 'buy all films (' + (totalEth > 0 ? totalEth + ' ETH' : 'free') + ')'
          }, 2000)
        }
      })
      async function checkBatchOwned() {
        const addr = window.getWalletAddress?.()
        if (!addr) return
        const owned = await window._getOwnedMediaIds?.(addr)
        if (!owned) return
        document.querySelectorAll('.batch-buy-btn[data-media-ids]').forEach(btn => {
          try {
            const ids = JSON.parse(btn.dataset.mediaIds)
            if (ids.every(id => owned.has(String(id)))) {
              btn.textContent = 'owned'
              btn.style.borderColor = 'var(--accent)'
              btn.style.color = 'var(--accent)'
              btn.disabled = true
            }
          } catch {}
        })
      }
      checkBatchOwned()
      window.addEventListener('wallet-connected', checkBatchOwned)
      window.addEventListener('spa-navigate', () => setTimeout(checkBatchOwned, 100))
    }
    </script>`
    return html
  },

  renderHighlights(data) {
    const works = data?.works || []
    if (!works.length) return ''
    return works.sort((a, b) => (b.year || 0) - (a.year || 0)).slice(0, 3).map(w =>
      `<div class="credit"><span class="credit-title">${esc(w.title)}</span> <span class="credit-detail">-- ${esc(w.role || '')}${w.director ? `, dir. ${esc(w.director)}` : ''}${w.year ? `, ${esc(w.year)}` : ''}</span></div>`
    ).join('\n')
  },

  renderCV(data) {
    if (!data) return ''
    return (data.works || [])
      .sort((a, b) => (b.year || 0) - (a.year || 0))
      .map(w => `<div class="cv-item"><span class="cv-title">${esc(w.title)}</span> <span class="cv-detail">-- ${esc(w.role)}${w.year ? `, ${esc(w.year)}` : ''}</span></div>`)
      .join('\n')
  },
}
