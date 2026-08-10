// Writing module — publications, reading list, excerpts, chapbooks
// For poets, essayists, novelists, journalists, translators
// data: { publications: [{ title, publication, year, url, type, excerpt, coverImage, src, mediaId, mediaPrice, genre, isbn, translator, publisher, pageCount, language, awards }], reading: [...] }
import { esc } from './shared.js'
const safeUrl = u => {
  if (typeof u !== 'string' || !u) return ''
  const trimmed = u.trim()
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('/')) return esc(trimmed)
  return ''
}
export default {
  type: 'writing',
  label: 'text',
  route: '/text',

  renderSection(data) {
    if (!data) return ''
    let html = ''
    const sections = data.sections || []
    if (data.publications?.length) {
      const pubs = data.publications
      const hasSections = sections.length > 0 && pubs.some(p => p.section)

      function renderPub(p) {
        const hasSrc = !!p.src
        const isPdf = hasSrc && (p.src.toLowerCase().endsWith('.pdf') || p.src.includes('ipfs'))
        const coverHtml = p.coverImage
          ? `<div style="flex-shrink:0;width:120px"><img src="/api/img?url=${encodeURIComponent(p.coverImage)}&w=200" loading="lazy" style="width:100%;border-radius:2px;border:1px solid var(--border)"></div>`
          : ''
        let buyHtml = ''
        if (p.mediaId !== undefined && p.mediaId !== null) {
          const priceEth = p.mediaPrice ? (Number(p.mediaPrice) / 1e18) : 0
          const priceLabel = priceEth > 0 ? `${priceEth} ETH` : 'free'
          buyHtml = `<button class="track-buy-btn" data-media-id="${esc(String(p.mediaId))}" data-price="${esc(String(p.mediaPrice || '0'))}" data-eth-wei="${esc(String(p.mediaPrice || '0'))}" style="background:none;border:1px solid var(--green);color:var(--green);font-family:inherit;font-size:0.7em;padding:0.1em 0.6ch;cursor:pointer">${priceLabel}</button>`
        }
        const badges = []
        if (p.type) badges.push(`<span style="color:var(--muted);font-size:0.7em;border:1px solid var(--border);padding:0.1em 0.4ch;border-radius:2px">${esc(p.type)}</span>`)
        if (p.genre) badges.push(`<span class="writing-genre" style="color:var(--muted);font-size:0.7em;border:1px solid var(--border);padding:0.1em 0.4ch;border-radius:2px">${esc(p.genre)}</span>`)
        if (hasSrc && isPdf) badges.push(`<span style="color:var(--accent);font-size:0.7em;border:1px solid var(--accent);padding:0.1em 0.4ch;border-radius:2px">PDF</span>`)
        const excerptHtml = p.excerpt
          ? `<div style="color:var(--muted);font-size:0.8em;margin-top:0.25em;line-height:1.4">${esc(p.excerpt.length > 100 ? p.excerpt.slice(0, 100) + '...' : p.excerpt)}</div>`
          : ''
        const titleHtml = p.url && !hasSrc
          ? `<a href="${safeUrl(p.url)}" style="color:var(--accent);font-weight:bold;font-size:0.95em;text-decoration:none">${esc(p.title || 'untitled')}</a>`
          : `<span style="color:var(--accent);font-weight:bold;font-size:0.95em">${esc(p.title || 'untitled')}</span>`
        let metaHtml = ''
        if (p.publisher) metaHtml += `<span style="color:var(--muted);font-size:0.8em">${esc(p.publisher)}</span> `
        if (p.translator) metaHtml += `<span class="writing-translator" style="color:var(--dim);font-size:0.8em">trans. ${esc(p.translator)}</span> `
        if (p.pageCount) metaHtml += `<span style="color:var(--dim);font-size:0.75em">${esc(String(p.pageCount))}pp</span> `
        if (p.language) metaHtml += `<span style="color:var(--dim);font-size:0.75em">[${esc(p.language)}]</span> `
        if (p.isbn) metaHtml += `<span class="writing-isbn" style="color:var(--dim);font-size:0.7em">ISBN ${esc(p.isbn)}</span> `
        if (p.awards) metaHtml += `<div class="writing-awards" style="color:var(--green,var(--accent));font-size:0.8em;margin-top:0.15em">${esc(p.awards)}</div>`
        return `<div class="writing-card${hasSrc ? ' writing-card-clickable' : ''}" ${hasSrc ? `data-src="${esc(p.src)}" data-title="${esc(p.title || '')}"` : ''} style="display:flex;gap:1em;padding:0.75em;border:1px solid var(--border);border-radius:4px;${hasSrc ? 'cursor:pointer;' : ''}transition:border-color 0.2s">
          ${coverHtml}
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:0.5ch;flex-wrap:wrap">
              ${titleHtml}
              ${badges.join(' ')}
            </div>
            <div style="color:var(--muted);font-size:0.8em;margin-top:0.15em">
              ${p.publication ? `${esc(p.publication)}` : ''}${p.publication && p.year ? ' -- ' : ''}${p.year || ''}
            </div>
            ${metaHtml ? `<div style="margin-top:0.15em">${metaHtml}</div>` : ''}
            ${excerptHtml}
            ${p.collab ? `<div style="color:var(--muted);font-size:0.85em;margin-top:0.25em">with <a href="https://${esc(p.collab.from)}" style="color:var(--accent);text-decoration:none">${esc(p.collab.from)}</a></div>` : ''}
            ${buyHtml ? `<div style="margin-top:0.5em">${buyHtml}</div>` : ''}
          </div>
        </div>`
      }

      if (hasSections) {
        // Unsectioned publications at top (no header)
        const unsectioned = pubs.filter(p => !p.section)
        if (unsectioned.length) {
          html += '<div class="writing-cards" style="display:flex;flex-direction:column;gap:1em;margin:1em 0">'
          for (const p of unsectioned) html += renderPub(p)
          html += '</div>'
        }
        for (const sec of sections) {
          const sectionPubs = pubs.filter(p => p.section === sec.label)
          if (!sectionPubs.length) continue
          html += `<div style="color:var(--dim);font-size:0.75em;text-transform:uppercase;letter-spacing:0.1em;margin:1.5em 0 0.75em;border-bottom:1px solid var(--border);padding-bottom:0.3em">${esc(sec.label)}</div>`
          html += '<div class="writing-cards" style="display:flex;flex-direction:column;gap:1em;margin:0.5em 0">'
          for (const p of sectionPubs) html += renderPub(p)
          html += '</div>'
        }
      } else {
        html += '<h3>publications</h3><div class="writing-cards" style="display:flex;flex-direction:column;gap:1em;margin:1em 0">'
        for (const p of pubs) html += renderPub(p)
        html += '</div>'
      }
    }
    if (data.reading?.length) {
      html += '<h3>reading</h3><ul class="reading-list">'
      for (const b of data.reading) {
        const title = b.url ? `<a href="${safeUrl(b.url)}" class="book-title">${esc(b.title)}</a>` : `<span class="book-title">${esc(b.title)}</span>`
        html += `<li>${title} <span class="book-author">-- ${esc(b.author)}</span>${b.note ? `<span class="book-note">${esc(b.note)}</span>` : ''}</li>`
      }
      html += '</ul>'
    }

    html += `<script>
    import('/js/media.js').then(m => m.wireMediaBuyButtons?.())
    import('/js/utils.js').then(({ renderMedia }) => {
      if (window._writingDelegated) return
      window._writingDelegated = true
      document.querySelectorAll('.writing-card-clickable').forEach(card => {
        card.addEventListener('mouseenter', () => { card.style.borderColor = 'var(--accent)' })
        card.addEventListener('mouseleave', () => { card.style.borderColor = 'var(--border)' })
        card.addEventListener('click', (e) => {
          if (e.target.closest('.track-buy-btn') || e.target.closest('a')) return
          const src = card.dataset.src
          const title = card.dataset.title || ''
          document.getElementById('writing-sheet')?.remove()
          const sheet = document.createElement('div')
          sheet.id = 'writing-sheet'
          sheet.style.cssText = 'position:fixed;bottom:0;left:0;right:0;top:0;z-index:9000;background:var(--bg,#0a0a0a);overflow-y:auto;transition:transform 0.3s;transform:translateY(100%)'
          const header = '<div style="display:flex;justify-content:space-between;align-items:center;padding:1em 1.5em 0.5em;position:sticky;top:0;background:var(--bg,#0a0a0a);z-index:1">' +
            '<strong style="color:var(--accent)">' + title.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;') + '</strong>' +
            '<button id="writing-sheet-close" style="background:none;border:none;color:var(--muted);font-size:1.5em;cursor:pointer;padding:0.25em">&times;</button></div>'
          sheet.innerHTML = header + '<div id="writing-sheet-media" style="padding:0"><span class="praxis-loader" style="display:block;padding:2em;text-align:center"></span></div>'
          document.body.appendChild(sheet)
          requestAnimationFrame(() => { sheet.style.transform = 'translateY(0)' })
          const container = document.getElementById('writing-sheet-media')
          const filename = src.split('/').pop()
          container.innerHTML = renderMedia(src, filename)
          const iframe = container.querySelector('iframe')
          if (iframe) iframe.style.height = 'calc(100vh - 4em)'
          const closeSheet = () => { sheet.style.transform = 'translateY(100%)'; setTimeout(() => sheet.remove(), 300) }
          document.getElementById('writing-sheet-close').addEventListener('click', closeSheet)
          document.addEventListener('keydown', function esc(ev) { if (ev.key === 'Escape') { closeSheet(); document.removeEventListener('keydown', esc) } })
        })
      })
    })
    </script>`
    return html
  },

  renderHighlights(data) {
    const pubs = data?.publications || []
    if (!pubs.length) return ''
    return pubs.sort((a, b) => (b.year || 0) - (a.year || 0)).slice(0, 3).map(p =>
      `<div class="credit"><span class="credit-title">${esc(p.title)}</span>${p.publication ? ` <span class="credit-detail">-- ${esc(p.publication)}</span>` : ''}${p.year ? ` <span class="credit-detail">(${p.year})</span>` : ''}</div>`
    ).join('\n')
  },

  renderCV(data) {
    if (!data) return ''
    return (data.publications || [])
      .sort((a, b) => (b.year || 0) - (a.year || 0))
      .map(p => `<div class="cv-item"><span class="cv-title">${esc(p.title)}</span> <span class="cv-detail">${p.publication ? `-- ${esc(p.publication)}` : ''}${p.year ? `, ${p.year}` : ''}</span></div>`)
      .join('\n')
  },
}
