// Credits module — universal credits with category tags
// data: { items: [{ title, role, org, year, category, director, ... }], categoryOrder: [], resumePdf: '', resumeLabel: '' }
// backward-compat: data can also be a flat array (old format)
import { esc } from './shared.js'

function normalizeData(data) {
  if (Array.isArray(data)) return { items: data, categoryOrder: [], resumePdf: '', resumeLabel: '', resumeFilename: '' }
  return { items: data?.items || [], categoryOrder: data?.categoryOrder || [], resumePdf: data?.resumePdf || '', resumeLabel: data?.resumeLabel || '', resumeFilename: data?.resumeFilename || '' }
}

export default {
  type: 'credits',
  label: 'credits',
  route: '/credits',

  renderSection(data) {
    const d = normalizeData(data)
    if (!d.items.length) return ''
    // group by category, respect categoryOrder
    const groups = {}
    for (const c of d.items) {
      const cat = c.category || 'other'
      if (!groups[cat]) groups[cat] = []
      groups[cat].push(c)
    }
    const orderedCats = [...(d.categoryOrder || [])].filter(c => groups[c])
    for (const cat of Object.keys(groups)) { if (!orderedCats.includes(cat)) orderedCats.push(cat) }

    let html = ''

    if (d.resumePdf) {
      const label = d.resumeLabel || 'download resume'
      const dlName = d.resumeFilename || `${label.replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '-').toLowerCase()}.pdf`
      html += `<div style="margin-bottom:1.5em"><a href="${esc(d.resumePdf)}" download="${esc(dlName)}" class="buy-btn" style="display:inline-block;text-decoration:none">${esc(label)}</a></div>`
    }

    for (const cat of orderedCats) {
      const items = groups[cat]
      html += `<h3>${esc(cat)}</h3>`
      for (const c of items.sort((a, b) => (b.year || 0) - (a.year || 0))) {
        const roleCol = [c.role, c.characterName ? `(${c.characterName})` : ''].filter(Boolean).join(' ')
        const dirCol = [c.director ? `dir. ${c.director}` : '', c.org, c.productionCompany, c.venue].filter(Boolean).join(', ')
        html += `<div class="credit">`
        html += `<span class="credit-title">${esc(c.title)}${c.year ? ` <span class="credit-year">(${esc(c.year)})</span>` : ''}</span>`
        html += `<span class="credit-role">${esc(roleCol)}</span>`
        html += `<span class="credit-dir">${esc(dirCol)}</span>`
        if (c.collab) html += `<span style="color:var(--muted);font-size:0.85em;display:block">with <a href="https://${esc(c.collab.from)}" style="color:var(--accent);text-decoration:none">${esc(c.collab.from)}</a></span>`
        html += `</div>`
      }
    }

    return html
  },

  renderHighlights(data) {
    const d = normalizeData(data)
    if (!d.items.length) return ''
    return d.items.sort((a, b) => (b.year || 0) - (a.year || 0)).slice(0, 3).map(c => {
      const roleCol = [c.role, c.characterName ? `(${c.characterName})` : ''].filter(Boolean).join(' ')
      const dirCol = [c.org, c.director ? `dir. ${c.director}` : ''].filter(Boolean).join(', ')
      return `<div class="credit"><span class="credit-title">${esc(c.title)}</span><span class="credit-role">${esc(roleCol)}</span><span class="credit-dir">${esc(dirCol)}</span></div>`
    }).join('\n')
  },

  renderCV(data) {
    const d = normalizeData(data)
    if (!d.items.length) return ''
    return d.items
      .sort((a, b) => (b.year || 0) - (a.year || 0))
      .map(c => {
        const roleCol = [c.role, c.characterName ? `(${c.characterName})` : ''].filter(Boolean).join(' ')
        return `<div class="cv-item"><span class="cv-title">${esc(c.title)}</span> <span class="cv-detail">${esc(roleCol)}${c.org ? `, ${esc(c.org)}` : ''}${c.year ? `, ${esc(c.year)}` : ''}</span></div>`
      })
      .join('\n')
  },
}
