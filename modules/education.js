// Education module — workshops, events, curricula, community projects
// For teaching artists, organizers, workshop facilitators
// data: { events: [{ title, role, org, year, description, url, type }] }
import { esc } from './shared.js'
function safeUrl(u) {
  if (!u || typeof u !== 'string') return '#'
  try {
    const parsed = new URL(u, 'https://placeholder.invalid')
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return '#'
    return esc(u)
  } catch { return '#' }
}
export default {
  type: 'education',
  label: 'education',
  route: '/education',

  renderSection(data) {
    if (!data) return ''
    const items = Array.isArray(data) ? data : data.events || []
    return items
      .sort((a, b) => (b.year || 0) - (a.year || 0))
      .map(e => {
        const titleText = e.url ? `<a href="${safeUrl(e.url)}" style="color:inherit">${esc(e.title)}</a>` : esc(e.title)
        let html = `<div class="credit">`
        if (e.type) html += `<span style="color:var(--muted);font-size:0.75em;border:1px solid var(--border);padding:0.1em 0.4ch;margin-right:0.5ch">${esc(e.type)}</span>`
        html += `<span class="credit-title">${titleText}</span>`
        if (e.degree && e.field) html += ` <span class="credit-detail">-- ${esc(e.degree)} in ${esc(e.field)}</span>`
        else if (e.degree) html += ` <span class="credit-detail">-- ${esc(e.degree)}</span>`
        else if (e.field) html += ` <span class="credit-detail">-- ${esc(e.field)}</span>`
        else if (e.role) html += ` <span class="credit-detail">-- ${esc(e.role)}</span>`
        if (e.org) html += ` <span class="credit-detail">, ${esc(e.org)}</span>`
        if (e.startYear && e.endYear) html += ` <span class="credit-detail">, ${esc(e.startYear)}-${esc(e.endYear)}</span>`
        else if (e.startYear) html += ` <span class="credit-detail">, ${esc(e.startYear)}-present</span>`
        else if (e.year) html += ` <span class="credit-detail">, ${esc(e.year)}</span>`
        if (e.description) html += `<br><span style="color:var(--fg);font-size:0.9em">${esc(e.description)}</span>`
        html += `</div>`
        return html
      })
      .join('\n')
  },

  renderCV(data) {
    if (!data) return ''
    const items = Array.isArray(data) ? data : data.events || []
    return items
      .sort((a, b) => (b.year || 0) - (a.year || 0))
      .map(e => {
        const detail = e.degree && e.field ? `${e.degree} in ${e.field}` : e.degree || e.field || e.role || ''
        const yearStr = e.startYear && e.endYear ? `${e.startYear}-${e.endYear}` : e.startYear ? `${e.startYear}-present` : e.year ? `${e.year}` : ''
        return `<div class="cv-item"><span class="cv-title">${esc(e.title)}</span> <span class="cv-detail">-- ${esc(detail)}${e.org ? `, ${esc(e.org)}` : ''}${yearStr ? `, ${esc(yearStr)}` : ''}</span></div>`
      })
      .join('\n')
  },
}
