// Funding widget — client hydration for the funding module rendered
// as the hero on every project site (template: 'project'). Fetches
// live project state from /api/project/:id and wires the fund button
// to Praxis.sol's fundTier via the same code path used by
// project-detail.js.

import { createWalletClient, custom, optimism } from './vendor.js'
import { PRAXIS_ABI } from './contracts.js'
import { getPublicClient, requireUser, getWalletProvider, formatTxError, ensureFundsForPurchase, escapeHtml, registerPage } from './utils.js'
import { getEthPrices, formatPriceSync } from './fiat.js'

const PROPOSED = 0, FUNDED = 1, CONFIRMED = 2, COMPLETING = 3, COMPLETED = 4, CANCELLED = 5
const STATUS_LABELS = ['proposed', 'funded', 'confirmed', 'completing', 'completed', 'cancelled', 'disputed']
const STATUS_COLORS = ['#c0c0c0', '#4ade80', '#60a5fa', '#fbbf24', '#a78bfa', '#666', '#ef4444']

registerPage('project-funding-anchor', () => { initFundingWidget().catch(() => {}) }, 'project-funding-widget')

let _inFlight = null

export async function initFundingWidget() {
  const anchor = document.getElementById('project-funding-anchor')
  if (!anchor) return
  if (anchor.dataset.hydrated === '1') return
  anchor.dataset.hydrated = '1'

  const pid = anchor.dataset.projectId
  if (!pid || !/^[0-9]+$/.test(pid)) return

  const praxisAddr = document.body?.dataset?.registry
  if (!praxisAddr) return

  if (_inFlight) return _inFlight
  _inFlight = (async () => {
    try {
      const [res, ethPrices] = await Promise.all([
        fetch(`/api/project/${pid}`).then(r => r.json()).catch(() => null),
        getEthPrices().catch(() => null),
      ])
      if (!res || res.error || !res.project) {
        _renderMissing(anchor)
        return
      }
      const p = res.project
      const tiers = (res.tiers?.items || res.tiers || []).filter(Boolean)
      const fundings = (res.fundings?.items || res.fundings || []).filter(Boolean)
      _renderState(anchor, p, tiers, fundings, ethPrices)
      _wireActions(anchor, pid, p, praxisAddr)
    } catch (err) {
      console.warn('funding widget hydrate:', err)
      _renderMissing(anchor)
    } finally {
      _inFlight = null
    }
  })()
  return _inFlight
}

function _renderMissing(anchor) {
  const setText = (name, txt) => {
    const el = anchor.querySelector(`[data-hydrate="${name}"]`)
    if (el) el.textContent = txt
  }
  setText('status', 'not open')
  setText('title', '')
  setText('blurb', 'this project is not yet open for funding')
  const cta = anchor.querySelector('[data-hydrate="cta"]')
  if (cta) { cta.textContent = 'not available'; cta.disabled = true }
}

function _renderState(anchor, p, tiers, fundings, ethPrices) {
  const esc = escapeHtml
  const setText = (name, txt) => {
    const el = anchor.querySelector(`[data-hydrate="${name}"]`)
    if (el) el.textContent = txt
  }
  const setHtml = (name, html) => {
    const el = anchor.querySelector(`[data-hydrate="${name}"]`)
    if (el) el.innerHTML = html
  }

  const goalEth = formatPriceSync(p.fundingGoal, ethPrices)
  const raisedEth = formatPriceSync(p.totalFunded, ethPrices)
  const pct = Number(p.fundingGoal) > 0
    ? Math.min(100, Math.round(Number(p.totalFunded) * 100 / Number(p.fundingGoal)))
    : 0

  const statusLabel = STATUS_LABELS[p.status] || 'unknown'
  const statusColor = STATUS_COLORS[p.status] || '#666'
  const pillEl = anchor.querySelector('[data-hydrate="status"]')
  if (pillEl) {
    pillEl.textContent = statusLabel
    pillEl.style.color = statusColor
    pillEl.style.borderColor = statusColor
  }

  setText('title', p.title || '')
  setText('blurb', p.description || '')
  setText('raised', raisedEth)
  setText('goal', goalEth)
  setText('pct', pct + '%')

  const bar = anchor.querySelector('[data-hydrate="bar"]')
  if (bar) bar.style.width = pct + '%'

  setText('backers', `${fundings.length} backer${fundings.length === 1 ? '' : 's'}`)

  const deadlineSec = Number(p.deadline || 0)
  if (deadlineSec > 0) {
    const daysLeft = Math.max(0, Math.ceil((deadlineSec * 1000 - Date.now()) / 86400000))
    setText('deadline', p.status >= COMPLETED
      ? new Date(deadlineSec * 1000).toLocaleDateString()
      : `${daysLeft} day${daysLeft === 1 ? '' : 's'} left`)
  } else {
    setText('deadline', 'no deadline')
  }

  // tiers — compact list, click a tier to fund
  const availTiers = tiers.filter(t => Number(t.sold || 0) < Number(t.supply || 0))
  if (availTiers.length && p.status <= FUNDED) {
    setHtml('tiers', availTiers.map(t => {
      const price = formatPriceSync(String(t.price || '0'), ethPrices)
      const sold = Number(t.sold || 0), supply = Number(t.supply || 0)
      const remaining = Math.max(0, supply - sold)
      return `<button type="button" class="funding-tier-btn" data-tier-id="${esc(String(t.id))}" data-price="${esc(String(t.price || '0'))}" data-tier-name="${esc(t.name || 'tier')}">
        <span class="tier-name">${esc(t.name || 'tier')}</span>
        <span class="tier-price">${esc(price)}</span>
        <span class="tier-remaining">${remaining}/${supply} left</span>
      </button>`
    }).join(''))
  } else {
    setHtml('tiers', '')
  }

  const cta = anchor.querySelector('[data-hydrate="cta"]')
  if (cta) {
    if (p.status <= FUNDED && (availTiers.length || Number(p.fundingGoal) > 0)) {
      cta.textContent = availTiers.length ? 'choose a tier' : 'fund this project'
      cta.disabled = !availTiers.length
    } else if (p.status === COMPLETED) {
      cta.textContent = 'funded'
      cta.disabled = true
    } else if (p.status === CANCELLED) {
      cta.textContent = 'cancelled'
      cta.disabled = true
    } else {
      cta.textContent = statusLabel
      cta.disabled = true
    }
  }
}

function _wireActions(anchor, projectId, project, praxisAddr) {
  const statusEl = anchor.querySelector('[data-hydrate="action-status"]')

  async function fundTier(tierId, tierName, priceWei) {
    const userAddr = await requireUser('fund this project')
    if (!userAddr) return
    if (statusEl) { statusEl.style.display = ''; statusEl.textContent = 'preparing funds…' }
    const funded = await ensureFundsForPurchase(BigInt(priceWei), statusEl)
    if (!funded) return

    if (statusEl) statusEl.textContent = 'confirm in wallet…'
    try {
      const currentAccount = await window.authorizedSigner?.(userAddr)
      const walletClient = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })
      const hash = await walletClient.writeContract({
        address: praxisAddr, abi: PRAXIS_ABI,
        functionName: 'fundTier', args: [BigInt(projectId), BigInt(tierId), 1n],
        account: currentAccount, value: BigInt(priceWei),
      })
      if (statusEl) statusEl.textContent = `tx: ${hash.slice(0, 14)}…`
      const publicClient = await getPublicClient()
      await publicClient.waitForTransactionReceipt({ hash })
      if (statusEl) statusEl.textContent = `funded ${tierName} — reloading…`
      setTimeout(() => location.reload(), 1800)
    } catch (e) {
      if (statusEl) statusEl.textContent = formatTxError(e)
    }
  }

  anchor.addEventListener('click', (e) => {
    const tierBtn = e.target.closest('.funding-tier-btn')
    if (tierBtn) {
      const id = tierBtn.dataset.tierId
      const name = tierBtn.dataset.tierName || 'tier'
      const price = tierBtn.dataset.price || '0'
      fundTier(id, name, price)
      return
    }
    const cta = e.target.closest('[data-hydrate="cta"]')
    if (cta && !cta.disabled) {
      const tiersEl = anchor.querySelector('[data-hydrate="tiers"]')
      if (tiersEl?.firstElementChild) tiersEl.firstElementChild.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  })
}
