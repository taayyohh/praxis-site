// Vault — financial hub: balances, earnings, savings, send, swap
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

const BOLD_OPTIMISM = '0xb3f1186ec30a2ecfe665b04d02785ea552cf6186'
const WETH_ADDR = '0x4200000000000000000000000000000000000006'
const VELODROME_ROUTER = '0xa062aE8A9c5e11dEA47203A894fF77F90f4F3343'
const VELODROME_FACTORY = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da'
const ETH_ZERO = '0x0000000000000000000000000000000000000000'

const ERC20_BALANCE_ABI = [
  { name: 'balanceOf', type: 'function', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
]

const ERC20_APPROVE_ABI = [
  { name: 'approve', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }] },
  { name: 'allowance', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }] },
]

const ROUTE_TUPLE = { type: 'tuple[]', components: [
  { name: 'from', type: 'address' },
  { name: 'to', type: 'address' },
  { name: 'stable', type: 'bool' },
  { name: 'factory', type: 'address' },
]}

const VELODROME_ABI = [
  { name: 'getAmountsOut', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'amountIn', type: 'uint256' }, ROUTE_TUPLE],
    outputs: [{ name: 'amounts', type: 'uint256[]' }] },
  { name: 'swapExactETHForTokens', type: 'function', stateMutability: 'payable',
    inputs: [{ name: 'amountOutMin', type: 'uint256' }, ROUTE_TUPLE, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }],
    outputs: [{ name: 'amounts', type: 'uint256[]' }] },
]

const STABILITY_POOL_ABI = [
  { name: 'provideToSP', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: '_topUp', type: 'uint256' }, { name: '_doClaim', type: 'bool' }],
    outputs: [] },
  { name: 'getCompoundedBoldDeposit', type: 'function', stateMutability: 'view',
    inputs: [{ name: '_depositor', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }] },
  { name: 'getDepositorCollGain', type: 'function', stateMutability: 'view',
    inputs: [{ name: '_depositor', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }] },
]

const SWAP_ROUTE = [{ from: WETH_ADDR, to: BOLD_OPTIMISM, stable: false, factory: VELODROME_FACTORY }]
const SLIPPAGE_BPS = 100n // 1%

let _vaultBound = false
let _allHistory = []
let _historyShown = 0
let _ethPrices = null
let _yieldData = null

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
    const [ethBalance, boldBalance, unclaimed, earned, contributed, ticketUnclaimed, ethPrices, yieldData] = await Promise.all([
      getCachedBalance(addr).catch(() => 0n),
      getBoldBalance(addr).catch(() => 0n),
      getPendingWithdrawals(addr),
      fetchEarned(addrLower),
      fetchContributed(addrLower),
      getTicketPendingWithdrawals(addr).catch(() => 0n),
      getEthPrices().catch(() => null),
      fetchBoldYield().catch(() => null),
    ])

    const addressesToResolve = [
      ...earned.mediaSales.map(s => s.buyer),
    ].filter(Boolean)
    const domainMap = await resolveAddresses(query, addressesToResolve).catch(() => ({}))

    const resolve = a => resolveDomain(domainMap, a)
    _ethPrices = ethPrices
    _yieldData = yieldData
    _allHistory = buildHistory(earned, contributed, resolve, ethPrices)
    _historyShown = 0

    renderVault(contentEl, { ethBalance, boldBalance, unclaimed, earned, contributed, addr, mediaAddr, ticketUnclaimed, ethPrices, yieldData })
  } catch (e) {
    console.warn('vault load error:', e)
    contentEl.innerHTML = `<p style="color:var(--muted)">failed to load vault</p>`
  }
}

async function getBoldBalance(addr) {
  const pc = await getPublicClient()
  return pc.readContract({ address: BOLD_OPTIMISM, abi: ERC20_BALANCE_ABI, functionName: 'balanceOf', args: [addr] })
}

async function fetchBoldYield() {
  const res = await fetch('/api/bold/yield')
  if (!res.ok) return null
  return res.json()
}

async function getSwapQuote(amountIn) {
  const pc = await getPublicClient()
  const amounts = await pc.readContract({
    address: VELODROME_ROUTER, abi: VELODROME_ABI, functionName: 'getAmountsOut',
    args: [amountIn, SWAP_ROUTE],
  })
  return amounts[amounts.length - 1]
}

async function getSpDeposit(spAddress, depositor) {
  const { createPublicClient, http, mainnet } = await import('./vendor.js')
  const pc = createPublicClient({ chain: { ...mainnet, rpcUrls: { ...mainnet.rpcUrls, default: { http: ['/api/rpc/1'] } } }, transport: http('/api/rpc/1') })
  const [deposit, collGain] = await Promise.all([
    pc.readContract({ address: spAddress, abi: STABILITY_POOL_ABI, functionName: 'getCompoundedBoldDeposit', args: [depositor] }),
    pc.readContract({ address: spAddress, abi: STABILITY_POOL_ABI, functionName: 'getDepositorCollGain', args: [depositor] }),
  ])
  return { deposit, collGain }
}

async function bridgeBoldToMainnet(addr, boldAmount, onStatus) {
  const { initRelay } = await import('./relay-bridge.js')
  const { getQuote, execute } = await import('./vendor-relay.js')
  await initRelay()

  onStatus?.('getting bridge quote...')
  const boldMainnet = _yieldData?.boldMainnet || ETH_ZERO
  const quote = await getQuote({
    chainId: 10,
    toChainId: 1,
    currency: BOLD_OPTIMISM,
    toCurrency: boldMainnet !== ETH_ZERO ? boldMainnet : BOLD_OPTIMISM,
    amount: boldAmount.toString(),
    user: addr,
    recipient: addr,
    tradeType: 'EXACT_INPUT',
  })

  onStatus?.('confirm bridge in wallet...')

  const { _buildBridgeWalletClient } = await import('./relay-bridge.js')
  let walletClient
  try {
    walletClient = await _buildBridgeWalletClient(10)
  } catch {
    const { createWalletClient, custom, optimism } = await import('./vendor.js')
    walletClient = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()), account: addr })
  }

  let lastHash = null
  return new Promise((resolve, reject) => {
    execute({
      quote,
      wallet: walletClient,
      onProgress: ({ currentStep, currentStepItem, txHashes, error }) => {
        if (txHashes?.length) lastHash = txHashes[txHashes.length - 1]?.txHash || lastHash
        if (currentStepItem?.txHashes?.length) lastHash = currentStepItem.txHashes[currentStepItem.txHashes.length - 1]?.txHash || lastHash
        if (error) { reject(new Error(error.message || 'bridge failed')); return }
        if (currentStep?.id === 'approve') onStatus?.('approving BOLD...')
        else if (currentStepItem?.status === 'complete' && currentStep?.id === 'deposit') onStatus?.('bridge submitted — arriving on Ethereum...')
        else if (currentStepItem?.status === 'complete') { onStatus?.('bridged to Ethereum'); resolve(lastHash) }
        else if (currentStepItem?.status === 'incomplete') onStatus?.('bridging...')
      },
    }).then(() => { resolve(lastHash) }).catch(err => {
      const msg = err?.message || ''
      if (lastHash && (msg.includes('not found') || msg.includes('404'))) {
        onStatus?.('bridge in flight — BOLD arriving on Ethereum in ~2 min')
        resolve(lastHash)
        return
      }
      reject(err)
    })
  })
}

async function depositToStabilityPool(spAddress, boldAmount, addr, onStatus) {
  const { createWalletClient, createPublicClient, custom, http, mainnet } = await import('./vendor.js')

  await window.ensureAuthorized?.()
  const embeddedAcct = window.getEmbeddedAccount?.()
  if (!embeddedAcct) throw new Error('wallet not available')

  const rpcUrl = '/api/rpc/1'
  const chainDef = { ...mainnet, rpcUrls: { ...mainnet.rpcUrls, default: { http: [rpcUrl] } } }
  const pc = createPublicClient({ chain: chainDef, transport: http(rpcUrl) })

  const boldMainnet = _yieldData?.boldMainnet
  if (!boldMainnet) throw new Error('BOLD mainnet address not found')

  onStatus?.('checking approval...')
  const allowance = await pc.readContract({
    address: boldMainnet, abi: ERC20_APPROVE_ABI, functionName: 'allowance',
    args: [addr, spAddress],
  })

  const wc = createWalletClient({ chain: chainDef, account: embeddedAcct, transport: http(rpcUrl) })

  if (allowance < boldAmount) {
    onStatus?.('approving BOLD for stability pool...')
    const approveTx = await wc.writeContract({
      address: boldMainnet, abi: ERC20_APPROVE_ABI, functionName: 'approve',
      args: [spAddress, boldAmount], account: embeddedAcct,
    })
    await pc.waitForTransactionReceipt({ hash: approveTx })
  }

  onStatus?.('depositing into stability pool...')
  const depositTx = await wc.writeContract({
    address: spAddress, abi: STABILITY_POOL_ABI, functionName: 'provideToSP',
    args: [boldAmount, false], account: embeddedAcct,
  })
  await pc.waitForTransactionReceipt({ hash: depositTx })
  onStatus?.('deposited!')
  return depositTx
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

  const ownMediaIds = new Set(listings.map(l => l.id.toString()))
  const collabMediaIds = mediaCollabResult.filter(mc => !ownMediaIds.has(mc.mediaId.toString())).map(mc => mc.mediaId)
  const collabSplitMap = {}
  for (const mc of mediaCollabResult) collabSplitMap[mc.mediaId.toString()] = BigInt(mc.split)

  const allMediaIds = [...listings.map(l => l.id), ...collabMediaIds]

  if (allMediaIds.length > 0) {
    const titleMap = {}
    for (const l of listings) titleMap[l.id.toString()] = l.title

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

const ETH_ICON = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M12 2L4 12.5L12 16.5L20 12.5L12 2Z" fill="var(--accent)" opacity="0.7"/><path d="M12 2L4 12.5L12 10.5V2Z" fill="var(--accent)"/><path d="M12 18L4 14L12 22L20 14L12 18Z" fill="var(--accent)" opacity="0.7"/><path d="M12 18L4 14L12 22V18Z" fill="var(--accent)"/></svg>`
const BOLD_ICON = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="18" rx="4" fill="var(--green)" opacity="0.15"/><text x="12" y="16.5" text-anchor="middle" fill="var(--green)" font-size="13" font-weight="800" font-family="inherit">B</text></svg>`

function renderVault(el, { ethBalance, boldBalance, unclaimed, earned, contributed, addr, mediaAddr, ticketUnclaimed, ethPrices, yieldData }) {
  const totalUnclaimed = unclaimed.praxis + unclaimed.media + ticketUnclaimed
  const totalEarned = earned.mediaTotal + earned.projectEarnings
  const totalContributed = contributed.fundingTotal + contributed.purchaseTotal
  const currency = getUserCurrency()
  const ethRate = ethPrices?.[currency] || 0

  const ethFiat = ethRate ? Number(ethBalance) / 1e18 * ethRate : 0
  const boldFiat = Number(boldBalance) / 1e18
  const totalFiat = ethFiat + boldFiat

  let html = ''

  // --- Balance hero ---
  html += `<div class="vault-hero">`
  html += `<div class="vault-total-label">total balance</div>`
  html += `<div class="vault-total-value">${formatFiat(totalFiat, currency)}</div>`

  // Token rows
  html += `<div class="vault-tokens">`
  html += `<div class="vault-token">`
  html += `<div class="vault-token-icon">${ETH_ICON}</div>`
  html += `<div class="vault-token-info"><span class="vault-token-name">ETH</span><span class="vault-token-chain">Optimism</span></div>`
  html += `<div class="vault-token-amounts"><span class="vault-token-bal">${formatEthAmount(ethBalance)}</span><span class="vault-token-fiat">${ethRate ? formatFiat(ethFiat, currency) : ''}</span></div>`
  html += `</div>`

  if (boldBalance > 0n) {
    const boldFormatted = (Number(boldBalance) / 1e18).toFixed(2)
    html += `<div class="vault-token">`
    html += `<div class="vault-token-icon">${BOLD_ICON}</div>`
    html += `<div class="vault-token-info"><span class="vault-token-name">BOLD</span><span class="vault-token-chain">savings</span></div>`
    html += `<div class="vault-token-amounts"><span class="vault-token-bal">${boldFormatted}</span><span class="vault-token-fiat">${formatFiat(boldFiat, currency)}</span></div>`
    html += `</div>`
  }
  html += `</div>`

  // Action buttons
  html += `<div class="vault-actions">`
  html += `<button class="vault-action-btn" id="vault-send-btn"><i class="ph ph-arrow-up-right"></i><span>send</span></button>`
  html += `<button class="vault-action-btn" id="vault-receive-btn"><i class="ph ph-arrow-down-left"></i><span>receive</span></button>`
  html += `<button class="vault-action-btn" id="vault-swap-btn"><i class="ph ph-swap"></i><span>save</span></button>`
  html += `</div>`
  html += `</div>`

  // --- BOLD savings card ---
  const bestApy = yieldData?.bestApy || 0
  const pools = yieldData?.pools || []

  html += `<div class="vault-savings">`
  html += `<div class="vault-savings-header">`
  html += `<div>${BOLD_ICON}</div>`
  html += `<div style="flex:1">`
  html += `<div class="vault-savings-title">savings account</div>`
  html += `<div class="vault-savings-sub">BOLD stablecoin &middot; Liquity stability pools</div>`
  html += `</div>`
  if (bestApy > 0) {
    html += `<div class="vault-savings-apr"><span class="vault-apr-value">${bestApy.toFixed(1)}%</span><span class="vault-apr-label">APR</span></div>`
  }
  html += `</div>`

  if (boldBalance > 0n) {
    const boldFormatted = (Number(boldBalance) / 1e18).toFixed(2)
    html += `<div class="vault-savings-bal">${boldFormatted} <span style="color:var(--dim)">BOLD</span></div>`
  } else {
    html += `<div class="vault-savings-bal" style="color:var(--dim)">no BOLD yet</div>`
  }

  if (pools.length > 0) {
    html += `<div class="vault-pools">`
    for (const pool of pools.slice(0, 4)) {
      const tvlStr = pool.tvl >= 1e6 ? `$${(pool.tvl / 1e6).toFixed(1)}M` : `$${(pool.tvl / 1e3).toFixed(0)}K`
      html += `<div class="vault-pool-row">`
      html += `<div class="vault-pool-info"><span class="vault-pool-name">${escapeHtml(pool.name)}</span><span class="vault-pool-tvl">TVL ${tvlStr}</span></div>`
      html += `<div class="vault-pool-rates"><span class="vault-pool-apr">${pool.apy.toFixed(1)}%</span><span class="vault-pool-7d">7d ${pool.apy7d.toFixed(1)}%</span></div>`
      html += `</div>`
    }
    html += `</div>`
  }

  html += `<button class="vault-save-cta" id="vault-save-btn">swap ETH to BOLD</button>`
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

  // --- Overview ---
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
    html += `<p style="color:var(--dim);font-size:0.9em">no activity yet</p>`
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

  // Receive button
  document.getElementById('vault-receive-btn')?.addEventListener('click', () => showReceiveModal(addr))

  // Save/Swap button
  const swapHandler = () => showSwapModal(addr, ethBalance, ethPrices, currency, yieldData)
  document.getElementById('vault-swap-btn')?.addEventListener('click', swapHandler)
  document.getElementById('vault-save-btn')?.addEventListener('click', swapHandler)

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

// --- Modals ---

function showReceiveModal(addr) {
  const existing = document.getElementById('vault-receive-modal')
  if (existing) { existing.remove(); return }
  const overlay = document.createElement('div')
  overlay.id = 'vault-receive-modal'
  overlay.className = 'praxis-modal-overlay'
  overlay.style.zIndex = '10002'
  const dialog = document.createElement('div')
  dialog.className = 'praxis-modal-dialog'
  dialog.style.maxWidth = '420px'
  dialog.innerHTML = `
    <h3 class="vault-modal-title">receive</h3>
    <p class="vault-modal-sub">send ETH or tokens on <strong>Optimism</strong> to this address</p>
    <div class="vault-addr-box">${escapeHtml(addr)}</div>
    <button id="vault-copy-addr" class="vault-modal-btn"><i class="ph ph-copy"></i> copy address</button>
  `
  overlay.appendChild(dialog)
  document.body.appendChild(overlay)
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
  dialog.querySelector('#vault-copy-addr').addEventListener('click', async () => {
    await navigator.clipboard.writeText(addr)
    dialog.querySelector('#vault-copy-addr').innerHTML = '<i class="ph ph-check"></i> copied'
    setTimeout(() => overlay.remove(), 1500)
  })
}

function showSwapModal(addr, ethBalance, ethPrices, currency, yieldData) {
  const existing = document.getElementById('vault-swap-modal')
  if (existing) { existing.remove(); return }
  const ethRate = ethPrices?.[currency] || 0
  const bestApy = yieldData?.bestApy || 0
  const pools = yieldData?.pools || []
  const topPool = pools[0]
  const overlay = document.createElement('div')
  overlay.id = 'vault-swap-modal'
  overlay.className = 'praxis-modal-overlay'
  overlay.style.zIndex = '10002'
  const dialog = document.createElement('div')
  dialog.className = 'praxis-modal-dialog'
  dialog.style.maxWidth = '440px'

  let aprLine = ''
  if (bestApy > 0) aprLine = ` &middot; up to ${bestApy.toFixed(1)}% APR`

  let poolSelect = ''
  if (pools.length > 0) {
    const opts = pools.filter(p => p.address).slice(0, 5).map((p, i) =>
      `<option value="${escapeHtml(p.address)}" ${i === 0 ? 'selected' : ''}>${escapeHtml(p.name)} — ${p.apy.toFixed(1)}% APR</option>`
    ).join('')
    poolSelect = `
      <div>
        <label class="vault-field-label">stability pool</label>
        <select id="swap-pool" class="vault-field-input vault-field-input-full" style="text-align:left">${opts}</select>
      </div>`
  }

  dialog.innerHTML = `
    <h3 class="vault-modal-title">save</h3>
    <p class="vault-modal-sub">ETH → BOLD → stability pool${aprLine}</p>
    <div class="vault-swap-fields">
      <div>
        <label class="vault-field-label">amount (ETH on Optimism)</label>
        <div class="vault-field-row">
          <span class="vault-field-token">${ETH_ICON} ETH</span>
          <input id="swap-amount" type="text" inputmode="decimal" placeholder="0.00" class="vault-field-input">
        </div>
        <div class="vault-field-meta">
          <span id="swap-fiat" class="vault-field-fiat"></span>
          <button id="swap-max" class="vault-field-max">max</button>
        </div>
      </div>
      <div style="text-align:center;color:var(--dim);padding:0.25em 0"><i class="ph ph-arrow-down" style="font-size:1.1em"></i></div>
      <div>
        <label class="vault-field-label">receive (estimated BOLD)</label>
        <div class="vault-field-row">
          <span class="vault-field-token">${BOLD_ICON} BOLD</span>
          <span id="swap-output" class="vault-field-output">—</span>
        </div>
        <div id="swap-rate" style="font-size:0.7em;color:var(--dim);margin-top:0.15em"></div>
      </div>
      ${poolSelect}
      <div class="vault-steps" id="swap-steps">
        <div class="vault-step" data-step="swap"><span class="vault-step-num">1</span> swap ETH → BOLD on Optimism</div>
        <div class="vault-step" data-step="bridge"><span class="vault-step-num">2</span> bridge BOLD to Ethereum via Relay</div>
        <div class="vault-step" data-step="deposit"><span class="vault-step-num">3</span> deposit into stability pool</div>
      </div>
      <button id="swap-confirm" class="vault-modal-btn vault-modal-btn-primary" disabled>enter amount</button>
      <div id="swap-status" style="color:var(--muted);font-size:0.8em;text-align:center;min-height:1.2em"></div>
    </div>
  `
  overlay.appendChild(dialog)
  document.body.appendChild(overlay)
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })

  const swapInput = dialog.querySelector('#swap-amount')
  const swapFiat = dialog.querySelector('#swap-fiat')
  const outputEl = dialog.querySelector('#swap-output')
  const rateEl = dialog.querySelector('#swap-rate')
  const confirmBtn = dialog.querySelector('#swap-confirm')
  const statusEl = dialog.querySelector('#swap-status')
  const stepsEl = dialog.querySelector('#swap-steps')

  let _quoteTimer = null
  let _lastQuote = null

  function markStep(step, state) {
    const el = stepsEl?.querySelector(`[data-step="${step}"]`)
    if (!el) return
    el.classList.remove('vault-step-active', 'vault-step-done', 'vault-step-error')
    if (state) el.classList.add(`vault-step-${state}`)
  }

  dialog.querySelector('#swap-max')?.addEventListener('click', () => {
    const maxEth = Math.max(0, Number(ethBalance) / 1e18 - 0.002)
    swapInput.value = maxEth.toFixed(6)
    swapInput.dispatchEvent(new Event('input'))
  })

  swapInput.addEventListener('input', () => {
    const val = parseFloat(swapInput.value)
    if (!val || isNaN(val) || val <= 0) {
      swapFiat.textContent = ''
      outputEl.textContent = '—'
      rateEl.textContent = ''
      confirmBtn.disabled = true
      confirmBtn.textContent = 'enter amount'
      _lastQuote = null
      return
    }
    if (ethRate) swapFiat.textContent = `~${formatFiat(val * ethRate, currency)}`

    clearTimeout(_quoteTimer)
    outputEl.textContent = '...'
    outputEl.style.color = 'var(--dim)'
    rateEl.textContent = ''
    confirmBtn.disabled = true
    confirmBtn.textContent = 'getting quote...'

    _quoteTimer = setTimeout(async () => {
      try {
        const amountIn = parseEther(val.toFixed(18))
        const amountOut = await getSwapQuote(amountIn)
        _lastQuote = { amountIn, amountOut }
        const boldOut = Number(amountOut) / 1e18
        outputEl.textContent = boldOut.toFixed(2)
        outputEl.style.color = 'var(--fg)'
        const rate = boldOut / val
        rateEl.textContent = `1 ETH = ${rate.toFixed(2)} BOLD`
        confirmBtn.disabled = false
        confirmBtn.textContent = 'swap + bridge + deposit'
      } catch (e) {
        outputEl.textContent = 'no route'
        outputEl.style.color = 'var(--dim)'
        rateEl.textContent = ''
        confirmBtn.disabled = true
        confirmBtn.textContent = 'no liquidity'
        _lastQuote = null
      }
    }, 500)
  })

  confirmBtn.addEventListener('click', async () => {
    if (!_lastQuote) return
    const { amountIn, amountOut } = _lastQuote
    const spAddress = dialog.querySelector('#swap-pool')?.value || topPool?.address
    confirmBtn.disabled = true
    swapInput.disabled = true
    statusEl.textContent = ''
    statusEl.style.color = 'var(--muted)'

    try {
      // --- Step 1: Swap ETH → BOLD on Optimism ---
      markStep('swap', 'active')
      confirmBtn.textContent = 'step 1/3: swapping...'
      statusEl.textContent = 'confirm swap in wallet'

      const account = await window.ensureAuthorized?.() || addr
      const provider = getWalletProvider()
      const wc = createWalletClient({ chain: optimism, transport: custom(provider) })

      const minOut = amountOut - (amountOut * SLIPPAGE_BPS / 10000n)
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200)

      const swapHash = await wc.writeContract({
        address: VELODROME_ROUTER,
        abi: VELODROME_ABI,
        functionName: 'swapExactETHForTokens',
        args: [minOut, SWAP_ROUTE, addr, deadline],
        value: amountIn,
        account,
      })

      statusEl.textContent = `swap tx: ${swapHash.slice(0, 14)}...`
      const pc = await getPublicClient()
      await pc.waitForTransactionReceipt({ hash: swapHash })
      markStep('swap', 'done')

      // Read actual BOLD balance received
      const boldReceived = await pc.readContract({
        address: BOLD_OPTIMISM, abi: ERC20_BALANCE_ABI, functionName: 'balanceOf', args: [addr],
      })

      if (boldReceived === 0n) {
        throw new Error('swap succeeded but no BOLD received — check Velodrome liquidity')
      }

      // --- Step 2: Bridge BOLD to Ethereum mainnet ---
      markStep('bridge', 'active')
      confirmBtn.textContent = 'step 2/3: bridging...'

      await bridgeBoldToMainnet(addr, boldReceived, (msg) => { statusEl.textContent = msg })
      markStep('bridge', 'done')

      // --- Step 3: Deposit into stability pool ---
      if (spAddress) {
        markStep('deposit', 'active')
        confirmBtn.textContent = 'step 3/3: depositing...'

        // Wait a moment for bridge to settle
        statusEl.textContent = 'waiting for BOLD on Ethereum...'
        await new Promise(r => setTimeout(r, 15000))

        await depositToStabilityPool(spAddress, boldReceived, addr, (msg) => { statusEl.textContent = msg })
        markStep('deposit', 'done')
      } else {
        markStep('deposit', 'done')
        statusEl.textContent = 'BOLD bridged — deposit into a stability pool at liquity.app/earn'
      }

      // --- Done ---
      confirmBtn.textContent = 'done!'
      confirmBtn.style.borderColor = 'var(--green)'
      confirmBtn.style.color = 'var(--green)'
      statusEl.style.color = 'var(--green)'
      statusEl.textContent = spAddress ? 'deposited into stability pool — earning yield' : 'BOLD on Ethereum — ready to deposit'
      window.dispatchEvent(new CustomEvent('wallet-balance-changed'))
      setTimeout(() => overlay.remove(), 4000)
    } catch (e) {
      const failedStep = stepsEl?.querySelector('.vault-step-active')
      if (failedStep) {
        failedStep.classList.remove('vault-step-active')
        failedStep.classList.add('vault-step-error')
      }
      confirmBtn.disabled = false
      swapInput.disabled = false
      confirmBtn.textContent = 'retry'
      statusEl.style.color = 'var(--dim)'
      statusEl.textContent = e.code === 4001 ? 'cancelled' : formatTxError(e)
    }
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
  dialog.style.maxWidth = '420px'

  const balance = await getCachedBalance(fromAddress).catch(() => 0n)
  const balEth = formatEthAmount(balance)
  let prices = await getEthPrices().catch(() => null)
  const currency = getUserCurrency()

  dialog.innerHTML = `
    <h3 class="vault-modal-title">send</h3>
    <p class="vault-modal-sub">on Optimism &middot; balance: ${balEth} ETH</p>
    <div class="vault-swap-fields">
      <div>
        <label class="vault-field-label">to</label>
        <input id="send-to" type="text" placeholder="handle, address, or domain" class="vault-field-input vault-field-input-full">
        <div id="send-resolved" class="vault-field-fiat" style="min-height:1.2em"></div>
      </div>
      <div>
        <label class="vault-field-label">amount</label>
        <div class="vault-field-row">
          <input id="send-amount" type="text" inputmode="decimal" placeholder="0.00" class="vault-field-input">
          <span style="color:var(--muted);font-size:0.9em;flex-shrink:0">ETH</span>
        </div>
        <div class="vault-field-meta">
          <span id="send-fiat" class="vault-field-fiat" style="min-height:1.2em"></span>
          <button id="send-max" class="vault-field-max">max</button>
        </div>
      </div>
      <button id="send-confirm" class="vault-modal-btn vault-modal-btn-primary">send</button>
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
      btn.textContent = 'send'
      status.style.color = 'var(--dim)'
      status.textContent = formatTxError(e)
    }
  })
}
