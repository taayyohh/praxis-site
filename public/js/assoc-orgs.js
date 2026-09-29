// Associated-orgs badges — small circle avatars of each org the site
// owner belongs to. Rendered on artist tenants, positioned inside the
// hero header (right-aligned above the divider line), each linked to
// the org's own tenant.
//
// Skipped on org tenants themselves — an org's site doesn't advertise
// its own membership.

import { escapeHtml } from './utils.js'

async function initAssocOrgs() {
  // Don't render on org tenants — they are the org. Some org tenants
  // still have orgId=null in site.json (Safe migration didn't stamp
  // one, or the tenant predates the field) but they always carry
  // data-org-type from the organization template. Match either
  // signal so lucid.haus (orgId=null, template=organization) doesn't
  // slip past this guard and render its own chip.
  const body = document.body
  if (body?.dataset?.orgId) return
  if (body?.dataset?.orgType) return
  const owner = body?.dataset?.owner
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
      // Pick the URL the browser can fetch directly.
      // - Full https URLs → load as-is. <img> is cross-origin by
      //   default so this Just Works (unlike fetch()).
      // - IPFS ipfs:// or bare-CID → local proxy so we get caching.
      // - Tenant-relative ("/uploads/logo.png") → resolve against the
      //   org's own domain. The old code proxied these through
      //   /api/img which rejects external URLs (400) — that's why
      //   Miles's lucidhaus + whatifwe chips kept falling back to
      //   the initial letter instead of showing the actual logo.
      // Any /api/ipfs-proxy or /ipfs path resolves the same content
      // regardless of which tenant serves it — use our own origin so
      // the browser can hit an internal path with no cross-origin
      // round-trip and no dependency on the org tenant being up.
      // That's the case for lucid.haus (profilePic points at
      // /api/ipfs-proxy/<CID>): we can serve that CID from milesxb.bio
      // just fine.
      let picUrl = ''
      if (raw.startsWith('http')) picUrl = raw
      else if (raw.startsWith('/api/ipfs-proxy/') || raw.startsWith('/ipfs/')) picUrl = raw
      else if (raw.startsWith('ipfs://')) picUrl = '/api/ipfs-proxy/' + raw.slice(7)
      else if (raw.startsWith('/') && domain) picUrl = `https://${domain}${raw}`
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
