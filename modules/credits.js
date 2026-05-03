// Credits module — universal credits with category tags
// Replaces separate theater/film/tv modules
// data: [{ title, role, org, year, category, director, venue, url, characterName, startDate, endDate, productionCompany, choreographer, musicDirector, castingDirector, press, description }]
// category: theater, film, tv, dance, comedy, opera, etc.
function esc(s) {
  if (typeof s !== 'string') return s == null ? '' : String(s)
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
export default {
  type: 'credits',
  label: 'credits',
  route: '/credits',

  renderSection(data) {
    if (!data || !Array.isArray(data)) return ''
    // group by category
    const groups = {}
    for (const c of data) {
      const cat = c.category || 'other'
      if (!groups[cat]) groups[cat] = []
      groups[cat].push(c)
    }
    let html = ''
    for (const [cat, items] of Object.entries(groups)) {
      html += `<h3>${esc(cat)}</h3>`
      for (const c of items.sort((a, b) => (b.year || 0) - (a.year || 0))) {
        // Acting resume format: Title | Role (Character) | Director/Company
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
    const items = Array.isArray(data) ? data : []
    if (!items.length) return ''
    return items.sort((a, b) => (b.year || 0) - (a.year || 0)).slice(0, 3).map(c => {
      const roleCol = [c.role, c.characterName ? `(${c.characterName})` : ''].filter(Boolean).join(' ')
      const dirCol = [c.org, c.director ? `dir. ${c.director}` : ''].filter(Boolean).join(', ')
      return `<div class="credit"><span class="credit-title">${esc(c.title)}</span><span class="credit-role">${esc(roleCol)}</span><span class="credit-dir">${esc(dirCol)}</span></div>`
    }).join('\n')
  },

  renderCV(data) {
    if (!data || !Array.isArray(data)) return ''
    return data
      .sort((a, b) => (b.year || 0) - (a.year || 0))
      .map(c => {
        const roleCol = [c.role, c.characterName ? `(${c.characterName})` : ''].filter(Boolean).join(' ')
        return `<div class="cv-item"><span class="cv-title">${esc(c.title)}</span> <span class="cv-detail">${esc(roleCol)}${c.org ? `, ${esc(c.org)}` : ''}${c.year ? `, ${esc(c.year)}` : ''}</span></div>`
      })
      .join('\n')
  },
}
