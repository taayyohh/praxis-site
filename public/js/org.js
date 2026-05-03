// Organization profile page — displays org info, roster, metadata
import { escapeHtml, registerPage, ipfsUrl, resolveAddresses } from './utils.js'
import { query } from './ponder.js'
import { t } from './i18n.js'

registerPage('org-page', initOrg)

async function initOrg() {
  const container = document.getElementById('org-page')
  if (!container) return

  // Get org ID from URL: /org?id=0
  const params = new URLSearchParams(location.search)
  const orgId = params.get('id')
  if (!orgId && orgId !== '0') {
    container.innerHTML = `<p style="color:var(--muted)">no organization specified. <a href="/org?id=0" style="color:var(--accent)">browse orgs</a></p>`
    return
  }

  container.innerHTML = '<span class="praxis-loader"></span>'

  try {
    const res = await fetch(`/api/org/${encodeURIComponent(orgId)}`)
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      container.innerHTML = `<p style="color:var(--muted)">${escapeHtml(err.error || 'organization not found')}</p>`
      return
    }
    const org = await res.json()
    renderOrg(container, org)
  } catch (e) {
    container.innerHTML = `<p style="color:var(--muted)">failed to load organization</p>`
  }
}

async function renderOrg(container, org) {
  const meta = org.metadata || {}
  const name = escapeHtml(org.name || 'unnamed')
  const bio = escapeHtml(meta.bio || meta.description || '')
  const domain = escapeHtml(org.domain || '')
  const adminAddr = escapeHtml(org.admin || '')
  const memberCount = org.members?.length || 0
  const dissolved = org.dissolved

  // Resolve member domains
  let memberDomains = {}
  if (org.members?.length) {
    const addrs = org.members.map(m => m.wallet || m)
    try {
      memberDomains = await resolveAddresses(query, addrs)
    } catch {}
  }

  container.innerHTML = `
    <div style="max-width:680px;margin:0 auto">
      <div style="margin-bottom:2em">
        <h1 style="font-size:1.6em;margin:0 0 0.3em">${name}</h1>
        ${dissolved ? '<span style="color:var(--red,#a44);font-size:0.85em">dissolved</span>' : ''}
        ${bio ? `<p class="bio" style="color:var(--muted);line-height:1.6;margin:0.5em 0">${bio}</p>` : ''}
        ${domain ? `<p style="font-size:0.85em;color:var(--dim);margin:0.3em 0">domain: <a href="https://${escapeHtml(org.domain)}" style="color:var(--accent)">${domain}</a></p>` : ''}
        <p style="font-size:0.8em;color:var(--dim);margin:0.3em 0">admin: <span style="font-family:monospace;font-size:0.9em">${adminAddr.slice(0, 6)}...${adminAddr.slice(-4)}</span></p>
        <p style="font-size:0.8em;color:var(--dim);margin:0.3em 0">${memberCount} member${memberCount !== 1 ? 's' : ''}</p>
      </div>

      <div>
        <h2 style="font-size:1.1em;margin:0 0 1em;border-bottom:1px solid var(--border);padding-bottom:0.5em">roster</h2>
        <div id="org-roster" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:1em">
          ${renderRoster(org.members || [], memberDomains)}
        </div>
      </div>

      ${meta.content ? `
      <div style="margin-top:2em">
        <h2 style="font-size:1.1em;margin:0 0 1em;border-bottom:1px solid var(--border);padding-bottom:0.5em">curated</h2>
        <div style="color:var(--muted);font-size:0.9em;line-height:1.6">${escapeHtml(meta.content)}</div>
      </div>` : ''}
    </div>
  `
}

function renderRoster(members, domainMap) {
  if (!members.length) return '<p style="color:var(--dim);font-size:0.85em">no members yet</p>'
  return members.map(m => {
    const wallet = (m.wallet || m).toLowerCase()
    const domain = domainMap[wallet]
    const display = domain ? escapeHtml(domain) : `${wallet.slice(0, 6)}...${wallet.slice(-4)}`
    const href = domain ? `https://${escapeHtml(domain)}` : '#'
    return `
      <a href="${href}" style="display:block;padding:0.8em;border:1px solid var(--border);text-decoration:none;color:var(--fg)">
        <div style="font-size:0.95em;font-weight:500">${display}</div>
        <div style="font-size:0.75em;color:var(--dim);margin-top:0.3em;font-family:monospace">${wallet.slice(0, 10)}...</div>
      </a>
    `
  }).join('')
}
