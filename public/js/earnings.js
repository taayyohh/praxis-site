// Earnings — unified financial overview: earned, contributed, unclaimed
import { F } from './fragments.js'
import { createWalletClient, custom, formatEther, parseEther } from './vendor.js'
import { optimism } from './vendor.js'
import { query } from './ponder.js'
import { getPublicClient, resolveAddresses, resolveDomain, formatEthAmount, escapeHtml, registerPage, getPendingWithdrawals , getWalletProvider } from './utils.js'
import { t } from './i18n.js'
import { getCached, setCache, TTL } from './cache.js'
import { getTicketPendingWithdrawals, withdrawTicketEarnings, TICKET_MARKET_ADDR } from './tickets.js'
import { getEthPrices, formatPriceSync, formatPriceFiatPrimary } from './fiat.js'

import { PRAXIS_ADDR, PRAXIS_ABI, MEDIA_ABI } from './contracts.js'

const HISTORY_PAGE_SIZE = 20
let _earningsWalletBound = false
let _allHistory = []
let _historyShown = 0
let _ethPrices = null

registerPage('earnings-page', initEarnings)

async function initEarnings() {
  _allHistory = []
  _historyShown = 0

  const contentEl = document.getElementById('earnings-content')
  if (!contentEl) return

  if (!_earningsWalletBound) {
    _earningsWalletBound = true
    window.addEventListener('wallet-connected', initEarnings)
    window.addEventListener('wallet-disconnected', initEarnings)
    window.addEventListener('currency-changed', initEarnings)
  }

  const addr = window.getWalletAddress?.()
  if (!addr) {
    contentEl.innerHTML = `<p style="color:var(--muted)">${t('earnings.connectWallet')}</p>`
    return
  }

  contentEl.innerHTML = `<span class="praxis-loader"></span>`

  const addrLower = addr.toLowerCase()
  const mediaAddr = document.body.dataset.media || ''

  try {
    const [unclaimed, earned, contributed, ticketUnclaimed, ethPrices] = await Promise.all([
      getPendingWithdrawals(addr),
      fetchEarned(addrLower),
      fetchContributed(addrLower),
      getTicketPendingWithdrawals(addr).catch(() => 0n),
      getEthPrices().catch(() => null),
    ])

    // collect all addresses that need domain resolution
    const addressesToResolve = [
      ...earned.mediaSales.map(s => s.buyer),
    ].filter(Boolean)
    const domainMap = await resolveAddresses(query, addressesToResolve).catch(() => ({}))

    const resolve = a => resolveDomain(domainMap, a)
    _ethPrices = ethPrices
    _allHistory = buildHistory(earned, contributed, resolve, ethPrices)
    _historyShown = 0

    renderEarnings(contentEl, unclaimed, earned, contributed, addr, mediaAddr, ticketUnclaimed, ethPrices)
  } catch (e) {
    console.warn('earnings load error:', e)
    contentEl.innerHTML = `<p style="color:var(--muted)">${t('earnings.loadError')}</p>`
  }
}

// --- Data fetching: no N+1, filtered queries, cursor pagination ---

async function fetchEarned(addrLower) {
  let mediaSales = []
  let mediaTotal = 0n
  let projectEarnings = 0n
  let projectItems = []

  // 1. Get my media listings (paginated)
  // 2. Get purchases filtered by MY media IDs (not all purchases)
  // 3. Get my collaborator records → filter completed projects by those IDs
  const [listingsResult, collabResult] = await Promise.all([
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
  ])

  const listings = listingsResult
  const collabs = collabResult

  // Fetch purchases for MY media IDs only (server-filtered, paginated)
  if (listings.length > 0) {
    const mediaIds = listings.map(l => l.id)
    const titleMap = {}
    for (const l of listings) titleMap[l.id.toString()] = l.title

    const purchases = await paginatedQuery(`query($ids: [BigInt!]!, $after: String) {
      mediaPurchases(where: { mediaId_in: $ids }, limit: 100, after: $after, orderBy: "timestamp", orderDirection: "desc") {
        items { ${F.mediaPurchase} }
        ${F.pageInfo}
      }
    }`, { ids: mediaIds }, 'mediaPurchases')

    for (const p of purchases) {
      const price = BigInt(p.price)
      mediaTotal += price
      mediaSales.push({
        type: 'media-sale',
        title: titleMap[p.mediaId.toString()] || `media #${p.mediaId}`,
        buyer: p.buyer,
        amount: price,
        time: Number(p.timestamp) * 1000,
      })
    }
  }

  // Fetch only completed projects I collaborated on (filtered by my collab project IDs)
  if (collabs.length > 0) {
    const collabProjectIds = collabs.map(c => c.projectId)
    try {
      const projData = await query(`
        query($ids: [BigInt!]!) {
          projects(where: { id_in: $ids, status: 3 }, limit: 100) {
            items { ${F.projectDetail} }
          }
        }
      `, { ids: collabProjectIds })

      for (const proj of (projData.projects?.items || [])) {
        const collab = collabs.find(c => c.projectId.toString() === proj.id.toString())
        if (!collab) continue
        const yourShare = BigInt(proj.totalFunded) * BigInt(collab.split) / 10000n
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
    } catch (e) { console.warn('earnings: project earnings query failed', e) }
  }

  return { mediaTotal, mediaSales, projectEarnings, projectItems }
}

async function fetchContributed(addrLower) {
  let fundingTotal = 0n
  let fundingItems = []
  let purchaseTotal = 0n
  let purchaseItems = []

  // Parallel: my fundings + my purchases (both paginated)
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

  // Batch-fetch titles using id_in (only the IDs we need)
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

// Generic paginated query helper — fetches all pages up to a cap
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
    ...earned.mediaSales.map(s => ({ ...s, label: t('earnings.mediaSale'), detail: s.mediaId ? `<a href="/art?media=${s.mediaId}" style="color:var(--accent);text-decoration:none">${escapeHtml(s.title)}</a>` : escapeHtml(s.title), sign: '+' })),
    ...earned.projectItems.map(p => ({ ...p, label: t('earnings.projectEarning'), detail: p.projectId ? `<a href="/project?id=${p.projectId}" style="color:var(--accent);text-decoration:none">${escapeHtml(p.title)}</a>` : escapeHtml(p.title), sign: '+' })),
    ...contributed.fundingItems.map(f => ({ ...f, label: t('earnings.funded'), detail: f.projectId ? `<a href="/project?id=${f.projectId}" style="color:var(--accent);text-decoration:none">${escapeHtml(f.title)}</a>` : escapeHtml(f.title), sign: '-' })),
    ...contributed.purchaseItems.map(p => ({ ...p, label: t('earnings.purchased'), detail: p.mediaId ? `<a href="/art?media=${p.mediaId}" style="color:var(--accent);text-decoration:none">${escapeHtml(p.title)}</a>` : escapeHtml(p.title), sign: '-' })),
  ]
  items.sort((a, b) => b.time - a.time)
  return items
}

function timeAgo(ts) {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60000) return t('earnings.justNow')
  if (diff < 3600000) return t('earnings.minutesAgo', { m: Math.floor(diff / 60000) })
  if (diff < 86400000) return t('earnings.hoursAgo', { h: Math.floor(diff / 3600000) })
  return t('earnings.daysAgo', { d: Math.floor(diff / 86400000) })
}

function renderHistoryItems(items, ethPrices) {
  return items.map(h => {
    const color = h.sign === '+' ? 'var(--green)' : 'var(--fg)'
    return `<div style="display:flex;align-items:center;gap:1ch;padding:0.5em 0;border-bottom:1px solid var(--border)">
      <span style="color:${color};min-width:1ch">${h.sign}</span>
      <span style="flex:1">${h.label} <span style="color:var(--dim)">${h.detail}</span></span>
      <span style="color:${color};white-space:nowrap">${formatPriceFiatPrimary(h.amount, ethPrices)}</span>
      <span style="color:var(--dim);font-size:0.8em;white-space:nowrap">${timeAgo(h.time)}</span>
    </div>`
  }).join('')
}

function renderEarnings(el, unclaimed, earned, contributed, addr, mediaAddr, ticketUnclaimed = 0n, ethPrices = null) {
  const totalUnclaimed = unclaimed.praxis + unclaimed.media + ticketUnclaimed
  // Don't add unclaimed — it's already included in mediaTotal/projectEarnings (unclaimed = unsettled portion)
  const totalEarned = earned.mediaTotal + earned.projectEarnings
  const totalContributed = contributed.fundingTotal + contributed.purchaseTotal

  let html = ''

  // unclaimed banner
  if (totalUnclaimed > 0n) {
    html += `<div style="margin-bottom:2em;padding:1em;border:1px solid var(--green)">`
    html += `<div style="color:var(--green);font-size:0.8em;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:0.75em">${t('earnings.unclaimed')}</div>`
    if (unclaimed.media > 0n) {
      html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5em">
        <span>${formatPriceFiatPrimary(unclaimed.media, ethPrices)} <span style="color:var(--dim)">${t('earnings.fromMedia')}</span></span>
        <button class="buy-btn earnings-claim-btn" data-source="media" style="font-size:0.8em;padding:0.2em 1ch">${t('earnings.claim')}</button>
      </div>`
    }
    if (unclaimed.praxis > 0n) {
      html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5em">
        <span>${formatPriceFiatPrimary(unclaimed.praxis, ethPrices)} <span style="color:var(--dim)">${t('earnings.fromProjects')}</span></span>
        <button class="buy-btn earnings-claim-btn" data-source="projects" style="font-size:0.8em;padding:0.2em 1ch">${t('earnings.claim')}</button>
      </div>`
    }
    if (ticketUnclaimed > 0n) {
      html += `<div style="display:flex;justify-content:space-between;align-items:center">
        <span>${formatPriceFiatPrimary(ticketUnclaimed, ethPrices)} <span style="color:var(--dim)">${t('earnings.fromTickets') || 'from ticket sales'}</span></span>
        <button class="buy-btn earnings-claim-btn" data-source="tickets" style="font-size:0.8em;padding:0.2em 1ch">${t('earnings.claim')}</button>
      </div>`
    }
    html += `<p id="earnings-claim-status" style="color:var(--muted);font-size:0.85em;margin-top:0.5em"></p>`
    html += `</div>`
  }

  // summary row
  html += `<div style="display:flex;gap:2em;margin-bottom:2em;padding-bottom:1.5em;border-bottom:1px solid var(--border);flex-wrap:wrap">`
  html += `<div><span style="font-size:1.2em">${formatPriceFiatPrimary(totalEarned, ethPrices)}</span> <span style="color:var(--dim)">${t('earnings.earned')}</span></div>`
  html += `<div><span style="font-size:1.2em">${formatPriceFiatPrimary(totalContributed, ethPrices)}</span> <span style="color:var(--dim)">${t('earnings.contributed')}</span></div>`
  html += `</div>`

  // breakdown grid
  html += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:1em 3em;margin-bottom:2em;font-size:0.9em">`
  html += `<div>${formatPriceFiatPrimary(earned.mediaTotal, ethPrices)} <span style="color:var(--dim)">${t('earnings.media')}</span></div>`
  html += `<div>${formatPriceFiatPrimary(contributed.fundingTotal, ethPrices)} <span style="color:var(--dim)">${t('earnings.projectsFunded')}</span></div>`
  html += `<div>${formatPriceFiatPrimary(earned.projectEarnings + unclaimed.praxis, ethPrices)} <span style="color:var(--dim)">${t('earnings.projects')}</span></div>`
  html += `<div>${formatPriceFiatPrimary(contributed.purchaseTotal, ethPrices)} <span style="color:var(--dim)">${t('earnings.mediaPurchased')}</span></div>`
  html += `</div>`

  // history — scrollable container with infinite scroll
  if (_allHistory.length > 0) {
    html += `<div style="color:var(--dim);font-size:0.8em;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:0.75em">${t('earnings.history')}</div>`
    const firstPage = _allHistory.slice(0, HISTORY_PAGE_SIZE)
    _historyShown = firstPage.length
    html += `<div id="earnings-history-wrap" style="max-height:60vh;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:0.5em"><div id="earnings-history">${renderHistoryItems(firstPage, ethPrices)}</div></div>`
  } else {
    html += `<p style="color:var(--muted)">${t('earnings.noHistory')}</p>`
  }

  el.innerHTML = html

  // infinite scroll for history
  const historyWrap = document.getElementById('earnings-history-wrap')
  if (historyWrap && _allHistory.length > HISTORY_PAGE_SIZE) {
    historyWrap.addEventListener('scroll', () => {
      if (historyWrap.scrollTop + historyWrap.clientHeight >= historyWrap.scrollHeight - 50) {
        if (_historyShown >= _allHistory.length) return
        const historyEl = document.getElementById('earnings-history')
        const nextPage = _allHistory.slice(_historyShown, _historyShown + HISTORY_PAGE_SIZE)
        _historyShown += nextPage.length
        historyEl.insertAdjacentHTML('beforeend', renderHistoryItems(nextPage, _ethPrices))
      }
    })
  }

  // claim buttons
  el.querySelectorAll('.earnings-claim-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const status = document.getElementById('earnings-claim-status')
      btn.textContent = t('earnings.claiming')
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
        btn.textContent = t('earnings.claimed')
        btn.style.borderColor = 'var(--accent)'
        btn.style.color = 'var(--accent)'
        btn.style.opacity = '0.5'
        btn.style.cursor = 'default'
        // Keep button disabled permanently — don't re-enable on reload
        btn.disabled = true
        if (status) status.textContent = t('earnings.claimedSuccess')
        window.dispatchEvent(new CustomEvent('wallet-balance-changed'))
        // Delay reload longer to let Ponder index the withdrawal
        setTimeout(initEarnings, 5000)
      } catch (e) {
        btn.textContent = e.code === 4001 ? t('earnings.cancelled') : t('earnings.error')
        btn.disabled = false
        setTimeout(() => { btn.textContent = t('earnings.claim') }, 2000)
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

  const { getCachedBalance } = await import('./utils.js')
  const { getUserCurrency, formatFiat } = await import('./fiat.js')
  const balance = await getCachedBalance(fromAddress).catch(() => 0n)
  const balEth = (Number(balance) / 1e18).toFixed(4)
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
      status.textContent = e.code === 4001 ? 'cancelled' : (e.shortMessage || e.message || 'error')
    }
  })
}
