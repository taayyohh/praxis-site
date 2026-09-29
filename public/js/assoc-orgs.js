// Associated-orgs badges — small circle avatars of each org the site
// owner belongs to. Rendered on artist tenants, positioned inside the
// hero header (right-aligned above the divider line), each linked to
// the org's own tenant.
//
// Skipped on org tenants themselves — an org's site doesn't advertise
// its own membership.

import { escapeHtml } from './utils.js'

async function initAssocOrgs() {
  // Don't render on org tenants — they are the org.
  if (document.body?.dataset?.orgId) return
  const owner = document.body?.dataset?.owner
  if (!owner || !/^0x[0-9a-fA-F]{40}$/.test(owner)) return

  // Anchor inside the hero <header>. Every template's index.html
  // starts with a plain <header> containing the profile pic + name;
  // the layout wraps it inside a `<header id="top-bar">` navigation
  // strip. Selecting <header> without qualification picks the top-bar
  // (first in DOM) and drops the chips in the wrong place — bit us
  // once already. Explicitly exclude the top bars.
  const heroHeader = document.querySelector('header:not(#top-bar):not(#project-top-bar)')
  if (!heroHeader) return

  let orgs = []
  try {
    const res = await fetch(`/api/orgs/by-member/${owner.toLowerCase()}`)
    if (!res.ok) return
    const data = await res.json()
    orgs = (data.orgs || []).filter(o => o && o.id != null && !o.dissolved)
  } catch { return }
  if (!orgs.length) return

  // Pic source priority:
  // 1. profilePic on the by-member row (server-enriched from the
  //    org tenant's site.json — the same file the org's CMS updates
  //    when uploading a logo).
  // 2. Fall back to the org's IPFS metadata if by-member didn't
  //    stamp a pic (e.g. an org that hasn't attached a tenant yet).
  // 3. Otherwise render an initial-letter fallback.
  const detailed = await Promise.all(orgs.map(async (o) => {
    if (o.profilePic) return o
    try {
      const r = await fetch(`/api/org/${encodeURIComponent(o.id)}`)
      if (!r.ok) return o
      const detail = await r.json()
      const fromMeta = detail.metadata?.profilePic
      return fromMeta ? { ...o, profilePic: fromMeta } : o
    } catch { return o }
  }))

  const chips = detailed
    .map(o => {
      const name = o.name || `org #${o.id}`
      const domain = String(o.domain || '').trim()
      const raw = o.profilePic || ''
      // Only proxy HTTP(S) or IPFS URLs — bare strings from settings
      // may already be full URLs served by the org's own tenant. A
      // path that starts with "/" is a tenant-relative upload that
      // lives on the ORG's tenant server, not on the current site's
      // origin — always resolve those against the org's own domain
      // so the browser fetches the right host.
      let picUrl = ''
      if (raw.startsWith('http')) picUrl = `/api/img?url=${encodeURIComponent(raw)}&w=80`
      else if (raw.startsWith('ipfs://')) picUrl = '/api/ipfs-proxy/' + raw.slice(7)
      else if (raw.startsWith('/') && domain) picUrl = `/api/img?url=${encodeURIComponent(`https://${domain}${raw}`)}&w=80`
      else if (raw.startsWith('/')) picUrl = raw
      else if (raw && /^[A-Za-z0-9]+$/.test(raw)) picUrl = '/api/ipfs-proxy/' + raw
      const initial = escapeHtml((name.trim()[0] || 'O').toUpperCase())
      const inner = picUrl
        ? `<img src="${escapeHtml(picUrl)}" alt="" class="assoc-org-pic" onerror="this.replaceWith(Object.assign(document.createElement('span'), {className:'assoc-org-pic assoc-org-pic--fallback', textContent:'${initial}'}))">`
        : `<span class="assoc-org-pic assoc-org-pic--fallback">${initial}</span>`
      const href = domain ? `https://${escapeHtml(domain)}` : `/org?id=${escapeHtml(String(o.id))}`
      const target = domain ? ' target="_blank" rel="noopener"' : ''
      return `<a class="assoc-org-chip" href="${href}"${target} title="${escapeHtml(name)}">${inner}</a>`
    })
    .join('')

  const wrap = document.createElement('div')
  wrap.id = 'assoc-orgs'
  wrap.className = 'assoc-orgs assoc-orgs-hero'
  // "orgs" heading + optional works count on the same row so signers
  // see the org chips as an anchored side widget, not floating icons.
  // Works count is picked up from the .header-count element already
  // rendered in the hero on artist templates; if there is none we just
  // skip the works line.
  const worksEl = heroHeader.querySelector('.header-count, [data-works-count]')
  const worksText = worksEl?.textContent?.trim() || ''
  const worksLine = worksText ? `<span class="assoc-orgs-works">${escapeHtml(worksText)}</span>` : ''
  // Detach the original inline "N works" so it doesn't duplicate.
  if (worksEl && worksText) worksEl.style.display = 'none'
  wrap.innerHTML = `
    <div class="assoc-orgs-heading">
      <span class="assoc-orgs-label">orgs</span>
      ${worksLine}
    </div>
    <div class="assoc-orgs-chips">${chips}</div>
  `
  heroHeader.appendChild(wrap)
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAssocOrgs)
} else {
  initAssocOrgs()
}
