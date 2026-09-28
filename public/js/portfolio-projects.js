// Portfolio "projects" strip — the wide-card row that sits directly below
// the identity divider on any tenant whose wallet is proposer or
// collaborator on at least one on-chain project. Fully automatic — no
// module to enable in the CMS. If the wallet has zero projects the
// section renders nothing (server returns { items: [] }).
//
// Position and shape are locked by docs/project-sites-design.md:
//   header (profile pic + name + bio + more + works count)
//   <hr divider>
//   → this strip
//   CREDITS
//   GALLERY
//   ...
//
// Cards are rendered by renderProjectSummary in feed-cards.js so the
// same visual is reusable elsewhere (feed, discovery, org catalogs).
//
// Owner affordance: when the viewer's wallet matches the tenant wallet,
// each card exposes a "hide from my portfolio" button. Confirm + POST
// to /api/portfolio-hide, then fade the card out. The server row lives
// in project_portfolio_hide and is applied on the next /api/projects/
// by-wallet response for the same tenant.

import { renderProjectSummary } from './feed-cards.js'
import { registerPage, getWalletProvider, requireUser } from './utils.js'
import { createWalletClient, custom, optimism } from './vendor.js'

registerPage('portfolio-projects', initPortfolioProjects)

async function initPortfolioProjects() {
  const el = document.getElementById('portfolio-projects')
  if (!el) return
  const wallet = String(el.dataset.wallet || '').toLowerCase()
  if (!wallet || !/^0x[0-9a-f]{40}$/.test(wallet)) return

  try {
    const res = await fetch(`/api/projects/by-wallet/${wallet}`)
    if (!res.ok) return
    const data = await res.json()
    const items = data?.items || []
    if (!items.length) return

    const domainMap = items[0]?.domainMap || {}
    const resolve = (addr) => {
      const a = String(addr || '').toLowerCase()
      return domainMap[a] || `${a.slice(0, 6)}…${a.slice(-4)}`
    }

    const cards = items.map(p => renderProjectSummary(p, resolve)).join('')
    el.innerHTML = `<div class="portfolio-projects-grid">${cards}</div>`
    el.classList.add('is-populated')

    _applyOwnerMode(el, wallet)
    _wireHideButtons(el, wallet)
  } catch (e) {
    console.warn('portfolio projects load failed:', e?.message)
  }
}

function _isOwner(tenantWallet) {
  const viewer = window.getWalletAddress?.()
  if (!viewer) return false
  return viewer.toLowerCase() === tenantWallet
}

function _applyOwnerMode(el, tenantWallet) {
  const apply = () => el.classList.toggle('is-owner', _isOwner(tenantWallet))
  apply()
  // Owner status can flip after initial render (e.g. wallet unlock)
  window.addEventListener('wallet-connected', apply)
  window.addEventListener('wallet-disconnected', apply)
}

function _wireHideButtons(el, tenantWallet) {
  el.addEventListener('click', async (e) => {
    const btn = e.target.closest('.project-summary-hide-btn')
    if (!btn) return
    // Eat the click before the card's <a> navigation fires.
    e.preventDefault()
    e.stopPropagation()
    if (!_isOwner(tenantWallet)) return
    const projectId = btn.dataset.projectId
    if (!projectId) return

    const card = btn.closest('.project-summary-card')
    if (!confirm('Hide this project from your portfolio? You can bring it back from settings → hidden projects.')) return

    btn.disabled = true
    try {
      const addr = await requireUser('hide this project')
      if (!addr) { btn.disabled = false; return }
      const message = `praxis-portfolio-hide:${addr.toLowerCase()}:${projectId}:hide:${Date.now()}`
      const account = await window.authorizedSigner?.(addr)
      const walletClient = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })
      const signature = await walletClient.signMessage({ account, message })

      const res = await fetch('/api/portfolio-hide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: addr, projectId: Number(projectId), action: 'hide', signature, message }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)

      if (card) {
        card.style.transition = 'opacity 0.25s ease, transform 0.25s ease'
        card.style.opacity = '0'
        card.style.transform = 'scale(0.98)'
        setTimeout(() => card.remove(), 260)
      }
    } catch (err) {
      console.warn('hide failed:', err?.message)
      btn.disabled = false
      alert(`Could not hide: ${err?.message || 'unknown error'}`)
    }
  })
}
