// Technology module — engineering, design, repos, case studies, product work
// For engineers, designers, creative technologists, game devs
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
  type: 'technology',
  label: 'technology',
  route: '/technology',

  renderSection(data) {
    if (!data) return ''
    const items = Array.isArray(data) ? data : data.projects || []
    return items
      .map(p => {
        const link = p.url ? `<a href="${safeUrl(p.url)}">${esc(p.name)}</a>` : esc(p.name)
        let extra = ''
        if (p.status) extra += `<span class="project-status" style="font-size:0.75em;border:1px solid var(--border);padding:0.1em 0.4ch;margin-left:0.5ch;color:var(--muted)">${esc(p.status)}</span>`
        let below = ''
        if (p.stack) below += `<div class="project-stack" style="margin-top:0.25em">${p.stack.split(',').map(s => `<span style="font-size:0.75em;border:1px solid var(--border);padding:0.1em 0.4ch;margin-right:0.3ch;color:var(--muted)">${esc(s.trim())}</span>`).join('')}</div>`
        if (p.repo) below += `<div style="margin-top:0.15em"><a href="${safeUrl(p.repo)}" target="_blank" rel="noopener" style="color:var(--muted);font-size:0.8em">${esc(p.repo)}</a></div>`
        return `<div class="project"><span class="project-name">${link}</span> <span class="project-role">-- ${esc(p.role)}</span>${p.year ? ` <span class="project-role">(${esc(p.year)})</span>` : ''}${extra}${p.description ? `<br>${esc(p.description)}` : ''}${below}</div>`
      })
      .join('\n')
  },

  renderCV(data) {
    if (!data) return ''
    const items = Array.isArray(data) ? data : data.projects || []
    return items
      .map(p => `<div class="cv-item"><span class="cv-title">${esc(p.name)}</span> <span class="cv-detail">-- ${esc(p.role)}${p.description ? `. ${esc(p.description)}` : ''}</span></div>`)
      .join('\n')
  },
}
