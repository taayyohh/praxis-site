// Vault — financial hub: balances, earnings, spending, unclaimed, send, swap
import { F } from './fragments.js'
import { createWalletClient, custom, formatEther, parseEther } from './vendor.js'
import { optimism } from './vendor.js'
import { query } from './ponder.js'
import { getPublicClient, resolveAddresses, resolveDomain, formatEthAmount, escapeHtml, registerPage, getPendingWithdrawals, getWalletProvider, formatTxError, getCachedBalance } from './utils.js'
import { t } from './i18n.js'
import { getCached, setCache, TTL } from './cache.js'
import { getTicketPendingWithdrawals, withdrawTicketEarnings, TICKET_MARKET_ADDR } from './tickets.js'
import { getEthPrices, formatPriceSync, formatPriceFiatPrimary, getUserCurrency, formatFiat } from './fiat.js'

import { PRAXIS_ADDR, PRAXIS_ABI, MEDIA_ABI } from './contracts.js'

const HISTORY_PAGE_SIZE = 20
const USDC_ADDR = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85'
const USDC_ABI = [
  { name: 'balanceOf', type: 'function', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
]

let _vaultBound = false
let _allHistory = []
let _historyShown = 0
let _ethPrices = null

registerPage('vault-page', initVault)
registerPage('earnings-page', initVault)

async function initVault() {
  _allHistory = []
  _historyShown = 0

  const contentEl = document.getElementById('vault-content') || document.getElementById('earnings-content')
  if (!contentEl) return

  if (!_vaultBound) {
    _vaultBound = true
    window.addEventListener('wallet-connected', initVault)
    window.addEventListener('wallet-disconnected', initVault)
    window.addEventListener('currency-changed', initVault)
    window.addEventListener('wallet-balance-changed', initVault)
  }

  const addr = window.getWalletAddress?.()
  if (!addr) {
    contentEl.innerHTML = `<p style="color:var(--muted)">connect wallet to view vault</p>`
    return
  }

  contentEl.innerHTML = `<span class="praxis-loader"></span>`

  const addrLower = addr.toLowerCase()
  const mediaAddr = document.body.dataset.media || ''

  try {
    const [ethBalance, usdcBalance, unclaimed, earned, contributed, ticketUnclaimed, ethPrices] = await Promise.all([
      getCachedBalance(addr).catch(() => 0n),
      getUsdcBalance(addr).catch(() => 0n),
      getPendingWithdrawals(addr),
      fetchEarned(addrLower),
      fetchContributed(addrLower),
      getTicketPendingWithdrawals(addr).catch(() => 0n),
      getEthPrices().catch(() => null),
    ])

    const addressesToResolve = [
      ...earned.mediaSales.map(s => s.buyer),
    ].filter(Boolean)
    const domainMap = await resolveAddresses(query, addressesToResolve).catch(() => ({}))

    const resolve = a => resolveDomain(domainMap, a)
    _ethPrices = ethPrices
    _allHistory = buildHistory(earned, contributed, resolve, ethPrices)
    _historyShown = 0

    renderVault(contentEl, { ethBalance, usdcBalance, unclaimed, earned, contributed, addr, mediaAddr, ticketUnclaimed, ethPrices })
  } catch (e) {
    console.warn('vault load error:', e)
    contentEl.innerHTML = `<p style="color:var(--muted)">failed to load vault</p>`
  }
}

async function getUsdcBalance(addr) {
  const pc = await getPublicClient()
  const result = await pc.readContract({ address: USDC_ADDR, abi: USDC_ABI, functionName: 'balanceOf', args: [addr] })
  return result
}

// --- Data fetching ---

async function fetchEarned(addrLower) {
  let mediaSales = []
  let mediaTotal = 0n
  let projectEarnings = 0n
  let projectItems = []

  const [listingsResult, collabResult, mediaCollabResult] = await Promise.all([
    paginatedQuery(`query($artist: String!, $after: String) {
      mediaListings(where: { artist: $artist }, limit: 100, after: $after) {
        items { ${F.mediaListing} }
        ${F.pageInfo}
      }
    }`, { artist: addrLower }, 'mediaListings'),
    paginatedQuery(`query($artist: String!, $after: String) {
      collaborators(where: { artist: $artist }, limit: 100, after: $after) {
        items { ${F.collaborator} }
        ${F.pageInfo}
      }
    }`, { artist: addrLower }, 'collaborators'),
    paginatedQuery(`query($artist: String!, $after: String) {
      mediaCollaborators(where: { artist: $artist }, limit: 100, after: $after) {
        items { id mediaId artist split }
        ${F.pageInfo}
      }
    }`, { artist: addrLower }, 'mediaCollaborators').catch(() => []),
  ])

  const listings = listingsResult
  const collabs = collabResult

  // Combine own listings + media collaborations (don't double-count)
  const ownMediaIds = new Set(listings.map(l => l.id.toString()))
  const collabMediaIds = mediaCollabResult.filter(mc => !ownMediaIds.has(mc.mediaId.toString())).map(mc => mc.mediaId)
  const collabSplitMap = {}
  for (const mc of mediaCollabResult) collabSplitMap[mc.mediaId.toString()] = BigInt(mc.split)

  const allMediaIds = [...listings.map(l => l.id), ...collabMediaIds]

  if (allMediaIds.length > 0) {
    const titleMap = {}
    for (const l of listings) titleMap[l.id.toString()] = l.title

    // Fetch titles for collab media we don't own
    if (collabMediaIds.length > 0) {
      try {
        const collabMediaData = await query(`query($ids: [BigInt!]!) { mediaListings(where: { id_in: $ids }, limit: 100) { items { ${F.mediaListing} } } }`, { ids: collabMediaIds })
        for (const ml of (collabMediaData.mediaListings?.items || [])) titleMap[ml.id.toString()] = ml.title
      } catch {}
    }

    const purchases = await paginatedQuery(`query($ids: [BigInt!]!, $after: String) {
      mediaPurchases(where: { mediaId_in: $ids }, limit: 100, after: $after, orderBy: "timestamp", orderDirection: "desc") {
        items { ${F.mediaPurchase} }
        ${F.pageInfo}
      }
    }`, { ids: allMediaIds }, 'mediaPurchases')

    for (const p of purchases) {
      const price = BigInt(p.price)
      const mid = p.mediaId.toString()
      const isCollab = !ownMediaIds.has(mid) && collabSplitMap[mid]
      const yourAmount = isCollab ? (price * collabSplitMap[mid] / 10000n) : price
      mediaTotal += yourAmount
      mediaSales.push({
        type: isCollab ? 'media-collab-sale' : 'media-sale',
        title: titleMap[mid] || `media #${p.mediaId}`,
        buyer: p.buyer,
        amount: yourAmount,
        time: Number(p.timestamp) * 1000,
      })
    }
  }

  if (collabs.length > 0) {
    const collabProjectIds = collabs.map(c => c.projectId)
    try {
      const projData = await query(`
        query($ids: [BigInt!]!) {
          projects(where: { id_in: $ids, status_in: [3, 4] }, limit: 100) {
            items { ${F.projectDetail} }
          }
        }
      `, { ids: collabProjectIds })

      for (const proj of (projData.projects?.items || [])) {
        const collab = collabs.find(c => c.projectId.toString() === proj.id.toString())
        if (!collab) continue
        const distributed = Number(proj.status) >= 4 ? BigInt(proj.totalFunded) : 0n
        const yourShare = distributed * BigInt(collab.split) / 10000n
        if (yourShare > 0n) {
          projectEarnings += yourShare
          projectItems.push({
            type: 'project-earning',
            title: proj.title,
            amount: yourShare,
            time: Number(proj.completedAt || 0) * 1000,
          })
        }
      }
    } catch (e) { console.warn('vault: project earnings query failed', e) }
  }

  return { mediaTotal, mediaSales, projectEarnings, projectItems }
}

async function fetchContributed(addrLower) {
  let fundingTotal = 0n
  let fundingItems = []
  let purchaseTotal = 0n
  let purchaseItems = []

  const [fundings, purchases] = await Promise.all([
    paginatedQuery(`query($me: String!, $after: String) {
      fundings(where: { funder: $me }, limit: 100, after: $after, orderBy: "timestamp", orderDirection: "desc") {
        items { ${F.funding} }
        ${F.pageInfo}
      }
    }`, { me: addrLower }, 'fundings').catch(() => []),
    paginatedQuery(`query($me: String!, $after: String) {
      mediaPurchases(where: { buyer: $me }, limit: 100, after: $after, orderBy: "timestamp", orderDirection: "desc") {
        items { ${F.mediaPurchase} }
        ${F.pageInfo}
      }
    }`, { me: addrLower }, 'mediaPurchases').catch(() => []),
  ])

  const projectIds = [...new Set(fundings.map(f => f.projectId))]
  const mediaIds = [...new Set(purchases.map(p => p.mediaId))]

  const [projTitles, mediaTitles] = await Promise.all([
    projectIds.length > 0 ? query(`query($ids: [BigInt!]!) { projects(where: { id_in: $ids }, limit: 100) { items { ${F.projectSummary} } } }`, { ids: projectIds })
      .then(d => { const m = {}; for (const p of (d.projects?.items || [])) m[p.id.toString()] = p.title; return m })
      .catch(() => ({})) : {},
    mediaIds.length > 0 ? query(`query($ids: [BigInt!]!) { mediaListings(where: { id_in: $ids }, limit: 100) { items { ${F.mediaListing} } } }`, { ids: mediaIds })
      .then(d => { const m = {}; for (const ml of (d.mediaListings?.items || [])) m[ml.id.toString()] = ml.title; return m })
      .catch(() => ({})) : {},
  ])

  for (const f of fundings) {
    const amount = BigInt(f.amount)
    fundingTotal += amount
    fundingItems.push({
      type: 'funding',
      title: projTitles[f.projectId.toString()] || `project #${f.projectId}`,
      amount,
      time: Number(f.timestamp) * 1000,
    })
  }

  for (const p of purchases) {
    const price = BigInt(p.price)
    purchaseTotal += price
    purchaseItems.push({
      type: 'purchase',
      title: mediaTitles[p.mediaId.toString()] || `media #${p.mediaId}`,
      amount: price,
      time: Number(p.timestamp) * 1000,
    })
  }

  return { fundingTotal, fundingItems, purchaseTotal, purchaseItems }
}

async function paginatedQuery(gql, variables, rootField, maxPages = 5) {
  const allItems = []
  let cursor = null
  let pages = 0
  while (pages < maxPages) {
    const vars = { ...variables, after: cursor }
    const data = await query(gql, vars)
    const root = data[rootField]
    if (!root) break
    allItems.push(...(root.items || []))
    if (!root.pageInfo?.hasNextPage) break
    cursor = root.pageInfo.endCursor
    pages++
  }
  return allItems
}

// --- UI ---

function buildHistory(earned, contributed, resolve, ethPrices) {
  const items = [
    ...earned.mediaSales.map(s => ({ ...s, label: s.type === 'media-collab-sale' ? 'collab split' : 'media sale', detail: escapeHtml(s.title), sign: '+', icon: s.type === 'media-collab-sale' ? 'ph-users' : 'ph-music-note' })),
    ...earned.projectItems.map(p => ({ ...p, label: 'project payout', detail: escapeHtml(p.title), sign: '+', icon: 'ph-handshake' })),
    ...contributed.fundingItems.map(f => ({ ...f, label: 'funded', detail: escapeHtml(f.title), sign: '-', icon: 'ph-rocket' })),
    ...contributed.purchaseItems.map(p => ({ ...p, label: 'collected', detail: escapeHtml(p.title), sign: '-', icon: 'ph-shopping-cart' })),
  ]
  items.sort((a, b) => b.time - a.time)
  return items
}

function timeAgo(ts) {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  if (diff < 2592000000) return `${Math.floor(diff / 86400000)}d ago`
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function renderHistoryItems(items, ethPrices) {
  return items.map(h => {
    const color = h.sign === '+' ? 'var(--green)' : 'var(--muted)'
    return `<div class="vault-tx">
      <div class="vault-tx-icon" style="color:${color}"><i class="ph ${h.icon}"></i></div>
      <div class="vault-tx-body">
        <span class="vault-tx-label">${h.label}</span>
        <span class="vault-tx-detail">${h.detail}</span>
      </div>
      <div class="vault-tx-right">
        <span class="vault-tx-amount" style="color:${color}">${h.sign}${formatPriceFiatPrimary(h.amount, ethPrices)}</span>
        <span class="vault-tx-time">${timeAgo(h.time)}</span>
      </div>
    </div>`
  }).join('')
}

function renderVault(el, { ethBalance, usdcBalance, unclaimed, earned, contributed, addr, mediaAddr, ticketUnclaimed, ethPrices }) {
  const totalUnclaimed = unclaimed.praxis + unclaimed.media + ticketUnclaimed
  const totalEarned = earned.mediaTotal + earned.projectEarnings
  const totalContributed = contributed.fundingTotal + contributed.purchaseTotal
  const currency = getUserCurrency()
  const ethRate = ethPrices?.[currency] || 0

  const ethFiat = ethRate ? Number(ethBalance) / 1e18 * ethRate : 0
  const usdcFiat = Number(usdcBalance) / 1e6

  let html = ''

  // --- Balance hero ---
  html += `<div class="vault-balance-hero">`
  html += `<div class="vault-balance-main">`
  html += `<div class="vault-balance-label">total balance</div>`
  const totalFiat = ethFiat + usdcFiat
  html += `<div class="vault-balance-value">${formatFiat(totalFiat, currency)}</div>`
  html += `</div>`

  // Token breakdown
  html += `<div class="vault-tokens">`
  html += `<div class="vault-token">`
  html += `<div class="vault-token-icon"><svg width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="10" fill="#627eea"/><path d="M10 3.5v5l4.3 1.9L10 3.5z" fill="#c0cbf6"/><path d="M10 3.5L5.7 10.4 10 8.5V3.5z" fill="#fff"/><path d="M10 12.2v4.3l4.3-6L10 12.2z" fill="#c0cbf6"/><path d="M10 16.5v-4.3l-4.3-1.7L10 16.5z" fill="#fff"/></svg></div>`
  html += `<div class="vault-token-info"><span class="vault-token-name">ETH</span><span class="vault-token-chain">Optimism</span></div>`
  html += `<div class="vault-token-amounts"><span class="vault-token-bal">${formatEthAmount(ethBalance)}</span><span class="vault-token-fiat">${ethRate ? formatFiat(ethFiat, currency) : ''}</span></div>`
  html += `</div>`

  if (usdcBalance > 0n) {
    const usdcFormatted = (Number(usdcBalance) / 1e6).toFixed(2)
    html += `<div class="vault-token">`
    html += `<div class="vault-token-icon"><svg width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="10" fill="#2775ca"/><text x="10" y="14" text-anchor="middle" fill="white" font-size="10" font-weight="bold">$</text></svg></div>`
    html += `<div class="vault-token-info"><span class="vault-token-name">USDC</span><span class="vault-token-chain">Optimism</span></div>`
    html += `<div class="vault-token-amounts"><span class="vault-token-bal">${usdcFormatted}</span><span class="vault-token-fiat">${formatFiat(usdcFiat, currency)}</span></div>`
    html += `</div>`
  }
  html += `</div>`

  // Quick actions
  html += `<div class="vault-actions">`
  html += `<button class="vault-action-btn" id="vault-send-btn"><i class="ph ph-arrow-up-right"></i> send</button>`
  html += `<button class="vault-action-btn" id="vault-receive-btn"><i class="ph ph-arrow-down-left"></i> receive</button>`
  html += `<button class="vault-action-btn" id="vault-swap-btn"><i class="ph ph-arrows-left-right"></i> swap</button>`
  html += `</div>`
  html += `</div>`

  // --- Unclaimed banner ---
  if (totalUnclaimed > 0n) {
    html += `<div class="vault-unclaimed">`
    html += `<div class="vault-unclaimed-header"><i class="ph ph-coins"></i> unclaimed earnings</div>`
    if (unclaimed.media > 0n) {
      html += `<div class="vault-unclaimed-row">
        <span>${formatPriceFiatPrimary(unclaimed.media, ethPrices)} <span style="color:var(--dim)">media sales</span></span>
        <button class="vault-claim-btn earnings-claim-btn" data-source="media">claim</button>
      </div>`
    }
    if (unclaimed.praxis > 0n) {
      html += `<div class="vault-unclaimed-row">
        <span>${formatPriceFiatPrimary(unclaimed.praxis, ethPrices)} <span style="color:var(--dim)">project payouts</span></span>
        <button class="vault-claim-btn earnings-claim-btn" data-source="projects">claim</button>
      </div>`
    }
    if (ticketUnclaimed > 0n) {
      html += `<div class="vault-unclaimed-row">
        <span>${formatPriceFiatPrimary(ticketUnclaimed, ethPrices)} <span style="color:var(--dim)">ticket sales</span></span>
        <button class="vault-claim-btn earnings-claim-btn" data-source="tickets">claim</button>
      </div>`
    }
    html += `<p id="earnings-claim-status" style="color:var(--muted);font-size:0.85em;margin-top:0.5em"></p>`
    html += `</div>`
  }

  // --- Earnings overview ---
  html += `<div class="vault-section">`
  html += `<div class="vault-section-title">overview</div>`
  html += `<div class="vault-stats">`
  html += `<div class="vault-stat"><div class="vault-stat-value" style="color:var(--green)">${formatPriceFiatPrimary(totalEarned, ethPrices)}</div><div class="vault-stat-label">earned</div></div>`
  html += `<div class="vault-stat"><div class="vault-stat-value">${formatPriceFiatPrimary(totalContributed, ethPrices)}</div><div class="vault-stat-label">spent</div></div>`
  html += `</div>`

  html += `<div class="vault-breakdown">`
  const ownMediaTotal = earned.mediaSales.filter(s => s.type !== 'media-collab-sale').reduce((a, s) => a + s.amount, 0n)
  const collabMediaTotal = earned.mediaSales.filter(s => s.type === 'media-collab-sale').reduce((a, s) => a + s.amount, 0n)
  html += `<div class="vault-breakdown-row"><span class="vault-breakdown-label"><i class="ph ph-music-note"></i> media sales</span><span class="vault-breakdown-val" style="color:var(--green)">${formatPriceFiatPrimary(ownMediaTotal, ethPrices)}</span></div>`
  if (collabMediaTotal > 0n) {
    html += `<div class="vault-breakdown-row"><span class="vault-breakdown-label"><i class="ph ph-users"></i> collab splits</span><span class="vault-breakdown-val" style="color:var(--green)">${formatPriceFiatPrimary(collabMediaTotal, ethPrices)}</span></div>`
  }
  html += `<div class="vault-breakdown-row"><span class="vault-breakdown-label"><i class="ph ph-handshake"></i> project payouts</span><span class="vault-breakdown-val" style="color:var(--green)">${formatPriceFiatPrimary(earned.projectEarnings + unclaimed.praxis, ethPrices)}</span></div>`
  html += `<div class="vault-breakdown-row"><span class="vault-breakdown-label"><i class="ph ph-rocket"></i> projects funded</span><span class="vault-breakdown-val">${formatPriceFiatPrimary(contributed.fundingTotal, ethPrices)}</span></div>`
  html += `<div class="vault-breakdown-row"><span class="vault-breakdown-label"><i class="ph ph-shopping-cart"></i> media collected</span><span class="vault-breakdown-val">${formatPriceFiatPrimary(contributed.purchaseTotal, ethPrices)}</span></div>`
  html += `</div>`
  html += `</div>`

  // --- Activity ---
  html += `<div class="vault-section">`
  html += `<div class="vault-section-title">activity</div>`
  if (_allHistory.length > 0) {
    const firstPage = _allHistory.slice(0, HISTORY_PAGE_SIZE)
    _historyShown = firstPage.length
    html += `<div id="vault-history-wrap" class="vault-history"><div id="vault-history">${renderHistoryItems(firstPage, ethPrices)}</div></div>`
  } else {
    html += `<p style="color:var(--muted);font-size:0.9em">no activity yet</p>`
  }
  html += `</div>`

  el.innerHTML = html

  // --- Event handlers ---

  // Infinite scroll for history
  const historyWrap = document.getElementById('vault-history-wrap')
  if (historyWrap && _allHistory.length > HISTORY_PAGE_SIZE) {
    historyWrap.addEventListener('scroll', () => {
      if (historyWrap.scrollTop + historyWrap.clientHeight >= historyWrap.scrollHeight - 50) {
        if (_historyShown >= _allHistory.length) return
        const historyEl = document.getElementById('vault-history')
        const nextPage = _allHistory.slice(_historyShown, _historyShown + HISTORY_PAGE_SIZE)
        _historyShown += nextPage.length
        historyEl.insertAdjacentHTML('beforeend', renderHistoryItems(nextPage, _ethPrices))
      }
    })
  }

  // Send button
  document.getElementById('vault-send-btn')?.addEventListener('click', () => showSendModal(addr))

  // Receive button — show address
  document.getElementById('vault-receive-btn')?.addEventListener('click', () => {
    const existing = document.getElementById('vault-receive-modal')
    if (existing) { existing.remove(); return }
    const overlay = document.createElement('div')
    overlay.id = 'vault-receive-modal'
    overlay.className = 'praxis-modal-overlay'
    overlay.style.zIndex = '10002'
    const dialog = document.createElement('div')
    dialog.className = 'praxis-modal-dialog'
    dialog.style.maxWidth = '400px'
    dialog.innerHTML = `
      <h3 style="color:var(--accent);margin-bottom:0.5em">receive</h3>
      <div style="color:var(--dim);font-size:0.8em;margin-bottom:1em">send ETH or tokens on <strong>Optimism</strong> to this address</div>
      <div style="background:color-mix(in srgb, var(--fg) 5%, transparent);border:1px solid var(--border);border-radius:8px;padding:1em;font-family:monospace;font-size:0.85em;word-break:break-all;color:var(--fg)">${escapeHtml(addr)}</div>
      <button id="vault-copy-addr" style="margin-top:0.75em;width:100%;background:none;border:1px solid var(--border);color:var(--fg);font-family:inherit;font-size:0.85em;padding:0.6em;cursor:pointer;border-radius:6px"><i class="ph ph-copy"></i> copy address</button>
    `
    overlay.appendChild(dialog)
    document.body.appendChild(overlay)
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
    dialog.querySelector('#vault-copy-addr').addEventListener('click', async () => {
      await navigator.clipboard.writeText(addr)
      dialog.querySelector('#vault-copy-addr').innerHTML = '<i class="ph ph-check"></i> copied'
      setTimeout(() => overlay.remove(), 1500)
    })
  })

  // Swap button — coming soon with BOLD integration
  document.getElementById('vault-swap-btn')?.addEventListener('click', () => {
    const existing = document.getElementById('vault-swap-modal')
    if (existing) { existing.remove(); return }
    const overlay = document.createElement('div')
    overlay.id = 'vault-swap-modal'
    overlay.className = 'praxis-modal-overlay'
    overlay.style.zIndex = '10002'
    const dialog = document.createElement('div')
    dialog.className = 'praxis-modal-dialog'
    dialog.style.maxWidth = '400px'
    dialog.innerHTML = `
      <h3 style="color:var(--accent);margin-bottom:0.5em">swap</h3>
      <div style="color:var(--dim);font-size:0.85em;margin-bottom:1.5em">swap ETH for stablecoins on Optimism</div>
      <div style="display:flex;flex-direction:column;gap:0.75em">
        <div>
          <label style="color:var(--muted);font-size:0.75em;text-transform:uppercase;letter-spacing:0.05em">from</label>
          <div style="display:flex;align-items:center;gap:0.5ch;margin-top:0.2em;border:1px solid var(--border);padding:0.6em 1ch;border-radius:6px">
            <span style="color:var(--fg);font-size:0.9em">ETH</span>
            <input id="swap-amount" type="text" inputmode="decimal" placeholder="0.00" style="background:none;border:none;color:var(--fg);font-family:inherit;font-size:0.9em;flex:1;text-align:right;outline:none">
          </div>
          <div style="display:flex;justify-content:space-between;margin-top:0.3em">
            <span id="swap-fiat" style="color:var(--dim);font-size:0.8em"></span>
            <button id="swap-max" style="background:none;border:none;color:var(--accent);font-family:inherit;font-size:0.75em;cursor:pointer;padding:0">max</button>
          </div>
        </div>
        <div style="text-align:center;color:var(--dim)"><i class="ph ph-arrow-down"></i></div>
        <div>
          <label style="color:var(--muted);font-size:0.75em;text-transform:uppercase;letter-spacing:0.05em">to</label>
          <div style="display:flex;align-items:center;gap:0.5ch;margin-top:0.2em;border:1px solid var(--border);padding:0.6em 1ch;border-radius:6px">
            <span style="color:var(--fg);font-size:0.9em">USDC</span>
            <span id="swap-output" style="flex:1;text-align:right;color:var(--dim);font-size:0.9em">—</span>
          </div>
        </div>
        <button id="swap-confirm" class="buy-btn" style="width:100%;text-align:center;margin-top:0.5em" disabled>swap coming soon</button>
        <div style="color:var(--dim);font-size:0.75em;text-align:center">powered by Velodrome on Optimism</div>
      </div>
    `
    overlay.appendChild(dialog)
    document.body.appendChild(overlay)
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })

    const swapInput = dialog.querySelector('#swap-amount')
    const swapFiat = dialog.querySelector('#swap-fiat')
    dialog.querySelector('#swap-max')?.addEventListener('click', () => {
      const maxEth = Math.max(0, Number(ethBalance) / 1e18 - 0.001)
      swapInput.value = maxEth.toFixed(6)
      swapInput.dispatchEvent(new Event('input'))
    })
    swapInput.addEventListener('input', () => {
      const val = parseFloat(swapInput.value)
      if (!val || isNaN(val)) { swapFiat.textContent = ''; return }
      if (ethRate) swapFiat.textContent = `~${formatFiat(val * ethRate, currency)}`
      const outputEl = dialog.querySelector('#swap-output')
      if (outputEl && ethPrices?.usd) outputEl.textContent = `~${(val * ethPrices.usd).toFixed(2)}`
    })
  })

  // Claim buttons
  el.querySelectorAll('.earnings-claim-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const status = document.getElementById('earnings-claim-status')
      btn.textContent = 'claiming...'
      btn.disabled = true
      try {
        const pc = await getPublicClient()
        const claimAccount = await window.ensureAuthorized?.() || addr
        const wc = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })
        if (btn.dataset.source === 'media') {
          const hash = await wc.writeContract({ address: mediaAddr, abi: MEDIA_ABI, functionName: 'withdraw', args: [], account: claimAccount })
          if (status) status.textContent = `tx: ${hash.slice(0, 14)}...`
          await pc.waitForTransactionReceipt({ hash })
        } else if (btn.dataset.source === 'tickets') {
          await withdrawTicketEarnings()
        } else {
          const hash = await wc.writeContract({ address: PRAXIS_ADDR, abi: PRAXIS_ABI, functionName: 'claimFunds', args: [], account: claimAccount })
          if (status) status.textContent = `tx: ${hash.slice(0, 14)}...`
          await pc.waitForTransactionReceipt({ hash })
        }
        btn.textContent = 'claimed'
        btn.style.borderColor = 'var(--green)'
        btn.style.color = 'var(--green)'
        btn.disabled = true
        if (status) status.textContent = 'claimed successfully'
        window.dispatchEvent(new CustomEvent('wallet-balance-changed'))
        setTimeout(initVault, 5000)
      } catch (e) {
        btn.textContent = e.code === 4001 ? 'cancelled' : 'error'
        btn.disabled = false
        setTimeout(() => { btn.textContent = 'claim' }, 2000)
      }
    })
  })
}

export async function showSendModal(fromAddress) {
  const existing = document.getElementById('send-modal-overlay')
  if (existing) { existing.remove(); return }

  const overlay = document.createElement('div')
  overlay.id = 'send-modal-overlay'
  overlay.className = 'praxis-modal-overlay'
  overlay.style.zIndex = '10002'

  const dialog = document.createElement('div')
  dialog.className = 'praxis-modal-dialog'
  dialog.style.maxWidth = '400px'

  const balance = await getCachedBalance(fromAddress).catch(() => 0n)
  const balEth = formatEthAmount(balance)
  let prices = await getEthPrices().catch(() => null)
  const currency = getUserCurrency()

  dialog.innerHTML = `
    <h3 style="color:var(--accent);margin-bottom:0.5em">send</h3>
    <div style="color:var(--dim);font-size:0.8em;margin-bottom:1em">on Optimism &middot; balance: ${balEth} ETH</div>
    <div style="display:flex;flex-direction:column;gap:0.75em">
      <div>
        <label style="color:var(--muted);font-size:0.75em;text-transform:uppercase;letter-spacing:0.05em">to</label>
        <input id="send-to" type="text" placeholder="handle, address, or domain" style="background:none;border:1px solid var(--border);color:var(--fg);font-family:inherit;font-size:0.9em;padding:0.6em 1ch;width:100%;box-sizing:border-box;margin-top:0.2em">
        <div id="send-resolved" style="color:var(--dim);font-size:0.8em;min-height:1.2em"></div>
      </div>
      <div>
        <label style="color:var(--muted);font-size:0.75em;text-transform:uppercase;letter-spacing:0.05em">amount</label>
        <div style="display:flex;gap:0.5ch;align-items:center;margin-top:0.2em">
          <input id="send-amount" type="text" inputmode="decimal" placeholder="0.00" style="background:none;border:1px solid var(--border);color:var(--fg);font-family:inherit;font-size:0.9em;padding:0.6em 1ch;flex:1;box-sizing:border-box">
          <span style="color:var(--muted);font-size:0.9em">ETH</span>
        </div>
        <div style="display:flex;justify-content:space-between;margin-top:0.3em">
          <div id="send-fiat" style="color:var(--dim);font-size:0.8em;min-height:1.2em"></div>
          <button id="send-max" style="background:none;border:none;color:var(--accent);font-family:inherit;font-size:0.75em;cursor:pointer;padding:0">max</button>
        </div>
      </div>
      <button id="send-confirm" class="buy-btn" style="width:100%;text-align:center;margin-top:0.5em">send on Optimism</button>
      <div id="send-status" style="color:var(--muted);font-size:0.85em;text-align:center;min-height:1.2em"></div>
    </div>
  `
  overlay.appendChild(dialog)
  document.body.appendChild(overlay)

  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })

  const amountInput = dialog.querySelector('#send-amount')
  const fiatEl = dialog.querySelector('#send-fiat')
  const toInput = dialog.querySelector('#send-to')
  const resolvedEl = dialog.querySelector('#send-resolved')

  dialog.querySelector('#send-max').addEventListener('click', () => {
    const maxEth = Math.max(0, Number(balance) / 1e18 - 0.0005)
    amountInput.value = maxEth.toFixed(6)
    amountInput.dispatchEvent(new Event('input'))
  })

  amountInput.addEventListener('input', () => {
    const val = parseFloat(amountInput.value)
    if (!val || isNaN(val) || !prices) { fiatEl.textContent = ''; return }
    const rate = prices?.[currency]
    if (rate) fiatEl.textContent = `~${formatFiat(val * rate, currency)}`
  })

  let resolvedAddress = null
  let resolveTimer = null
  toInput.addEventListener('input', () => {
    resolvedAddress = null
    resolvedEl.textContent = ''
    clearTimeout(resolveTimer)
    const val = toInput.value.trim()
    if (val.startsWith('0x') && val.length === 42) {
      resolvedAddress = val
      resolvedEl.textContent = ''
      return
    }
    if (val.length < 2) return
    resolveTimer = setTimeout(async () => {
      resolvedEl.style.color = 'var(--dim)'
      resolvedEl.textContent = 'looking up...'
      try {
        const res = await fetch(`/api/network/search?q=${encodeURIComponent(val)}&limit=1`)
        const data = await res.json()
        const match = data.results?.[0]
        if (match && match.address) {
          resolvedAddress = match.address
          resolvedEl.style.color = 'var(--muted)'
          resolvedEl.textContent = `${match.name || match.domain} — ${match.address.slice(0,6)}...${match.address.slice(-4)}`
        } else {
          resolvedEl.style.color = 'var(--dim)'
          resolvedEl.textContent = 'not found'
        }
      } catch {
        resolvedEl.textContent = ''
      }
    }, 400)
  })

  dialog.querySelector('#send-confirm').addEventListener('click', async () => {
    const amountStr = amountInput.value.trim()
    const status = dialog.querySelector('#send-status')
    const btn = dialog.querySelector('#send-confirm')

    const toAddr = resolvedAddress || toInput.value.trim()
    if (!toAddr || !toAddr.startsWith('0x') || toAddr.length !== 42) {
      status.textContent = 'enter a valid address or handle'
      return
    }
    if (!amountStr) { status.textContent = 'enter an amount'; return }
    const amount = parseFloat(amountStr)
    if (isNaN(amount) || amount <= 0) { status.textContent = 'invalid amount'; return }

    btn.disabled = true
    btn.textContent = 'sending...'
    status.textContent = ''
    status.style.color = 'var(--muted)'

    try {
      const provider = await getWalletProvider()
      const wc = createWalletClient({ chain: optimism, transport: custom(provider) })
      await wc.sendTransaction({
        to: toAddr,
        value: parseEther(amountStr),
        account: fromAddress,
      })

      status.style.color = 'var(--green)'
      status.textContent = 'sent!'
      btn.textContent = 'done'
      window.dispatchEvent(new CustomEvent('wallet-balance-changed'))
      setTimeout(() => overlay.remove(), 2000)
    } catch (e) {
      btn.disabled = false
      btn.textContent = 'send on Optimism'
      status.style.color = 'var(--dim)'
      status.textContent = formatTxError(e)
    }
  })
}
