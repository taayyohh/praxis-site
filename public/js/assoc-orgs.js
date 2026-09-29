// Associated-orgs badges — small circle avatars of each org the site
// owner belongs to, shown top-right on artist tenants. Clicking one
// links out to the org's own site (its domain).
//
// Where: on artist sites (data-org-id NOT set). Never on org tenants
// themselves — they're the org and don't display "belongs to" chips.
// Renders inline into the top-bar between the domain link and the
// praxis menu trigger.

import { escapeHtml } from './utils.js'

const IPFS_GATEWAY = '/api/ipfs-proxy/'

async function initAssocOrgs() {
  // Don't render on org tenants — they are the org.
  if (document.body?.dataset?.orgId) return
  const owner = document.body?.dataset?.owner
  if (!owner || !/^0x[0-9a-fA-F]{40}$/.test(owner)) return

  const topBar = document.getElementById('top-bar')
  if (!topBar) return

  let orgs = []
  try {
    const res = await fetch(`/api/orgs/by-member/${owner.toLowerCase()}`)
    if (!res.ok) return
    const data = await res.json()
    orgs = (data.orgs || []).filter(o => o && o.id != null && !o.dissolved)
  } catch { return }
  if (!orgs.length) return

  // Fetch each org's metadata (for profilePic) in parallel. The by-member
  // endpoint gives name + domain + admin but not the IPFS metadata; the
  // /api/org/:id endpoint hydrates it. Miss-tolerant: an org whose
  // metadata fetch fails still renders as an initial-letter fallback.
  const detailed = await Promise.all(orgs.map(async (o) => {
    try {
      const r = await fetch(`/api/org/${encodeURIComponent(o.id)}`)
      if (!r.ok) return o
      const detail = await r.json()
      return { ...o, metadata: detail.metadata || {} }
    } catch { return o }
  }))

  // Build the badges strip. Each avatar is a link to the org's own
  // domain (skipped when the org hasn't attached one yet — no dead
  // link).
  const chips = detailed
    .map(o => {
      const name = o.name || `org #${o.id}`
      const domain = String(o.domain || '').trim()
      const raw = o.metadata?.profilePic || ''
      // Only proxy IPFS/https URLs through the resize proxy; strip
      // anything else since the CMS bio field can be arbitrary text.
      let picUrl = ''
      if (raw.startsWith('http')) picUrl = `/api/img?url=${encodeURIComponent(raw)}&w=64`
      else if (raw.startsWith('ipfs://')) picUrl = IPFS_GATEWAY + raw.slice(7)
      else if (raw && /^[A-Za-z0-9]+$/.test(raw)) picUrl = IPFS_GATEWAY + raw
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
  wrap.className = 'assoc-orgs'
  wrap.innerHTML = chips
  // Insert after site-identity so the chips sit on the left half of
  // the right-hand cluster, before the praxis menu.
  const menuTrigger = topBar.querySelector('#praxis-menu-trigger')
  if (menuTrigger) topBar.insertBefore(wrap, menuTrigger)
  else topBar.appendChild(wrap)
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAssocOrgs)
} else {
  initAssocOrgs()
}
