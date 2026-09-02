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

const BOLD_MAINNET = '0x6440f144b7e50d6a8439336510312d2f54beb01d'
const ETH_ZERO = '0x0000000000000000000000000000000000000000'

const STABILITY_POOLS = {
  ETH: '0x5721cbbd64fc7ae3ef44a0a3f9a790a9264cf9bf',
  wstETH: '0x9502b7c397e9aa22fe9db7ef7daf21cd2aebe56b',
  rETH: '0xd442e41019b7f5c4dd78f50dc03726c446148695',
}

const WETH_MAINNET = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const UNISWAP_QUOTER = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e'
const UNISWAP_ROUTER = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45'

const UNISWAP_QUOTER_ABI = [{
  name: 'quoteExactInputSingle', type: 'function', stateMutability: 'nonpayable',
  inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' },
    { name: 'amountIn', type: 'uint256' }, { name: 'fee', type: 'uint24' },
    { name: 'sqrtPriceLimitX96', type: 'uint160' },
  ]}],
  outputs: [{ name: 'amountOut', type: 'uint256' }, { name: 'sqrtPriceX96After', type: 'uint160' },
    { name: 'initializedTicksCrossed', type: 'uint32' }, { name: 'gasEstimate', type: 'uint256' }],
}]

const UNISWAP_ROUTER_ABI = [{
  name: 'exactInputSingle', type: 'function', stateMutability: 'payable',
  inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' },
    { name: 'fee', type: 'uint24' }, { name: 'recipient', type: 'address' },
    { name: 'amountIn', type: 'uint256' }, { name: 'amountOutMinimum', type: 'uint256' },
    { name: 'sqrtPriceLimitX96', type: 'uint160' },
  ]}],
  outputs: [{ name: 'amountOut', type: 'uint256' }],
}]

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
      getBoldBalanceMainnet(addr).catch(() => 0n),
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

async function getBoldBalanceMainnet(addr) {
  const { createPublicClient, http, mainnet } = await import('./vendor.js')
  const pc = createPublicClient({ chain: { ...mainnet, rpcUrls: { ...mainnet.rpcUrls, default: { http: ['/api/rpc/1'] } } }, transport: http('/api/rpc/1') })
  return pc.readContract({ address: BOLD_MAINNET, abi: ERC20_BALANCE_ABI, functionName: 'balanceOf', args: [addr] })
}

async function fetchBoldYield() {
  const res = await fetch('/api/bold/yield')
  if (!res.ok) return null
  return res.json()
}

let _mainnetPc = null
async function getMainnetClient() {
  if (_mainnetPc) return _mainnetPc
  const { createPublicClient, http, mainnet } = await import('./vendor.js')
  _mainnetPc = createPublicClient({ chain: { ...mainnet, rpcUrls: { ...mainnet.rpcUrls, default: { http: ['/api/rpc/1'] } } }, transport: http('/api/rpc/1') })
  return _mainnetPc
}

async function getUniswapBoldQuote(ethAmountWei) {
  const pc = await getMainnetClient()
  const { encodeFunctionData } = await import('./vendor.js')
  const fees = [3000, 10000, 500]
  for (const fee of fees) {
    try {
      const calldata = encodeFunctionData({
        abi: UNISWAP_QUOTER_ABI, functionName: 'quoteExactInputSingle',
        args: [{ tokenIn: WETH_MAINNET, tokenOut: BOLD_MAINNET, amountIn: ethAmountWei, fee, sqrtPriceLimitX96: 0n }],
      })
      const result = await pc.call({ to: UNISWAP_QUOTER, data: calldata })
      const amountOut = BigInt('0x' + result.data.slice(2, 66))
      if (amountOut > 0n) return { amountOut, fee }
    } catch {}
  }
  throw new Error('no BOLD liquidity')
}

async function getRelayBridgeQuote(amountWei, addr) {
  const { initRelay } = await import('./relay-bridge.js')
  const { getQuote } = await import('./vendor-relay.js')
  await initRelay()
  return getQuote({
    chainId: 10,
    toChainId: 1,
    currency: ETH_ZERO,
    toCurrency: ETH_ZERO,
    amount: amountWei.toString(),
    user: addr,
    recipient: addr,
    tradeType: 'EXACT_INPUT',
  })
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

async function executeBridge(addr, amountWei, onStatus) {
  const { initRelay, _buildBridgeWalletClient } = await import('./relay-bridge.js')
  const { getQuote, execute } = await import('./vendor-relay.js')
  await initRelay()

  onStatus?.('getting bridge quote...')
  const quote = await getQuote({
    chainId: 10, toChainId: 1,
    currency: ETH_ZERO, toCurrency: ETH_ZERO,
    amount: amountWei.toString(),
    user: addr, recipient: addr, tradeType: 'EXACT_INPUT',
  })

  onStatus?.('confirm bridge...')
  let walletClient
  try { walletClient = await _buildBridgeWalletClient(10) } catch {
    const { createWalletClient: cwc, custom: cst, optimism: op } = await import('./vendor.js')
    walletClient = cwc({ chain: op, transport: cst(getWalletProvider()), account: addr })
  }

  let lastHash = null
  return new Promise((resolve, reject) => {
    execute({ quote, wallet: walletClient,
      onProgress: ({ currentStepItem, txHashes, error }) => {
        if (txHashes?.length) lastHash = txHashes[txHashes.length - 1]?.txHash || lastHash
        if (currentStepItem?.txHashes?.length) lastHash = currentStepItem.txHashes[currentStepItem.txHashes.length - 1]?.txHash || lastHash
        if (error) { reject(new Error(error.message || 'bridge failed')); return }
        if (currentStepItem?.status === 'complete') { onStatus?.('ETH arrived on Ethereum'); resolve(lastHash) }
        else if (currentStepItem?.status === 'incomplete') onStatus?.('bridging ETH to Ethereum...')
      },
    }).then(() => resolve(lastHash)).catch(err => {
      if (lastHash && (err?.message || '').includes('not found')) { onStatus?.('bridge in flight...'); resolve(lastHash); return }
      reject(err)
    })
  })
}

async function swapEthToBold(addr, feeTier, onStatus) {
  const { _buildBridgeWalletClient } = await import('./relay-bridge.js')
  const pc = await getMainnetClient()

  const mainnetBal = await pc.getBalance({ address: addr })
  const gasReserve = 50000000000000n
  const swapAmount = mainnetBal > gasReserve ? mainnetBal - gasReserve : 0n
  if (swapAmount <= 0n) throw new Error('insufficient ETH on Ethereum after bridge')

  onStatus?.('quoting swap...')
  const { amountOut } = await getUniswapBoldQuote(swapAmount)
  const minOut = amountOut * 97n / 100n

  onStatus?.('confirm swap...')
  let walletClient
  try { walletClient = await _buildBridgeWalletClient(1) } catch {
    const { createWalletClient: cwc, custom: cst, mainnet: mn } = await import('./vendor.js')
    walletClient = cwc({ chain: { ...mn, rpcUrls: { ...mn.rpcUrls, default: { http: ['/api/rpc/1'] } } }, transport: cst(getWalletProvider()), account: addr })
  }

  const hash = await walletClient.writeContract({
    address: UNISWAP_ROUTER, abi: UNISWAP_ROUTER_ABI, functionName: 'exactInputSingle',
    args: [{ tokenIn: WETH_MAINNET, tokenOut: BOLD_MAINNET, fee: feeTier, recipient: addr,
      amountIn: swapAmount, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }],
    value: swapAmount,
  })
  onStatus?.('swap submitted...')
  await pc.waitForTransactionReceipt({ hash, timeout: 120_000 })
  onStatus?.('BOLD received')
  return hash
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
const BOLD_ICON = `<svg width="24" height="24" viewBox="0 0 20 21" fill="none"><rect y="0.5" width="20" height="20" rx="10" fill="#63D77D"/><path fill-rule="evenodd" clip-rule="evenodd" d="M7.28 3.83H5.05V17.17H9.5V16.63C10.17 16.97 10.92 17.17 11.72 17.17C14.42 17.17 16.61 14.98 16.61 12.28C16.61 9.58 14.43 7.39 11.72 7.39C10.93 7.39 10.17 7.58 9.5 7.92V4.41V3.83H7.28ZM9.5 7.92C7.92 8.73 6.83 10.38 6.83 12.28C6.83 14.18 7.93 15.82 9.5 16.63V7.92Z" fill="#1C1D4F"/></svg>`

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
    html += `<div class="vault-token-info"><span class="vault-token-name">BOLD</span><span class="vault-token-chain">Ethereum</span></div>`
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
  html += `<div class="vault-savings-icon">${BOLD_ICON}</div>`
  html += `<div style="flex:1">`
  html += `<div class="vault-savings-title">savings</div>`
  html += `<div class="vault-savings-sub">BOLD stablecoin · Liquity stability pools</div>`
  html += `</div>`
  if (bestApy > 0) {
    html += `<div class="vault-savings-apr"><span class="vault-apr-value">${bestApy.toFixed(1)}%</span><span class="vault-apr-label">APR</span></div>`
  }
  html += `</div>`

  if (boldBalance > 0n) {
    const boldFormatted = (Number(boldBalance) / 1e18).toFixed(2)
    html += `<div class="vault-savings-bal">${boldFormatted} <span style="color:var(--dim)">BOLD</span></div>`
  } else {
    html += `<div class="vault-savings-bal" style="color:var(--dim)">no deposits yet</div>`
  }

  if (pools.length > 0) {
    html += `<div class="vault-pools">`
    for (const pool of pools.slice(0, 4)) {
      const tvlStr = pool.tvl >= 1e6 ? `$${(pool.tvl / 1e6).toFixed(1)}M` : `$${(pool.tvl / 1e3).toFixed(0)}K`
      html += `<div class="vault-pool-row">`
      html += `<div class="vault-pool-info"><span class="vault-pool-name">${escapeHtml(pool.name)}</span><span class="vault-pool-tvl">${tvlStr} TVL</span></div>`
      html += `<div class="vault-pool-rates"><span class="vault-pool-apr">${pool.apy.toFixed(1)}%</span><span class="vault-pool-7d">30d ${pool.apy7d.toFixed(1)}%</span></div>`
      html += `</div>`
    }
    html += `</div>`
  }

  html += `<button class="vault-save-cta" id="vault-save-btn">save ETH to BOLD</button>`
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

async function showReceiveModal(addr) {
  const existing = document.getElementById('vault-receive-modal')
  if (existing) { existing.remove(); return }
  const overlay = document.createElement('div')
  overlay.id = 'vault-receive-modal'
  overlay.className = 'praxis-modal-overlay'
  overlay.style.zIndex = '10002'
  const dialog = document.createElement('div')
  dialog.className = 'praxis-modal-dialog vault-save-dialog'

  let qrHtml = ''
  try {
    const { generateQR } = await import('./qr.js')
    qrHtml = `<div class="vault-qr">${generateQR(addr)}</div>`
  } catch (e) { console.warn('QR generation failed:', e) }

  dialog.innerHTML = `
    <div class="vault-save-head">
      <div class="vault-save-icon">${ETH_ICON}</div>
      <div>
        <div class="vault-save-title">receive</div>
        <div class="vault-save-sub">send ETH or tokens on Optimism to this address</div>
      </div>
    </div>
    ${qrHtml}
    <div class="vault-addr-box">${escapeHtml(addr)}</div>
    <button id="vault-copy-addr" class="vault-save-btn" style="border-color:var(--accent);color:var(--accent)"><i class="ph ph-copy"></i> copy address</button>
  `
  overlay.appendChild(dialog)
  document.body.appendChild(overlay)
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
  dialog.querySelector('#vault-copy-addr').addEventListener('click', async () => {
    await navigator.clipboard.writeText(addr)
    const btn = dialog.querySelector('#vault-copy-addr')
    btn.innerHTML = '<i class="ph ph-check"></i> copied'
    btn.style.borderColor = 'var(--green)'
    btn.style.color = 'var(--green)'
    setTimeout(() => overlay.remove(), 1500)
  })
}

function showSwapModal(addr, ethBalance, ethPrices, currency, yieldData) {
  const existing = document.getElementById('vault-swap-modal')
  if (existing) { existing.remove(); return }
  const ethRate = ethPrices?.[currency] || 0
  const bestApy = yieldData?.bestApy || 0
  const pools = yieldData?.pools || []
  const overlay = document.createElement('div')
  overlay.id = 'vault-swap-modal'
  overlay.className = 'praxis-modal-overlay'
  overlay.style.zIndex = '10002'
  const dialog = document.createElement('div')
  dialog.className = 'praxis-modal-dialog vault-save-dialog'

  const poolCards = pools.slice(0, 3).map((p, i) => {
    const tvlStr = p.tvl >= 1e6 ? `$${(p.tvl / 1e6).toFixed(1)}M` : `$${(p.tvl / 1e3).toFixed(0)}K`
    const spAddr = STABILITY_POOLS[p.collateral] || ''
    return `<label class="vault-pool-card${i === 0 ? ' vault-pool-card-selected' : ''}" data-sp="${spAddr}">
      <input type="radio" name="sp-pool" value="${spAddr}" ${i === 0 ? 'checked' : ''} style="display:none">
      <div class="vault-pool-card-top">
        <span class="vault-pool-card-name">${escapeHtml(p.collateral)} pool</span>
        <span class="vault-pool-card-apy">${p.apy.toFixed(1)}%</span>
      </div>
      <div class="vault-pool-card-bottom">
        <span class="vault-pool-card-tvl">${tvlStr} TVL</span>
        <span class="vault-pool-card-7d">30d avg ${p.apy7d.toFixed(1)}%</span>
      </div>
    </label>`
  }).join('')

  const ethBal = Number(ethBalance) / 1e18
  const ethBalStr = formatEthAmount(ethBalance)
  const ethBalFiat = ethRate ? formatFiat(ethBal * ethRate, currency) : ''

  const presets = [25, 50, 75, 100].map(pct => {
    const amt = Math.max(0, ethBal * pct / 100 - (pct === 100 ? 0.002 : 0))
    return `<button class="vault-preset" data-amount="${amt.toFixed(6)}">${pct === 100 ? 'max' : pct + '%'}</button>`
  }).join('')

  dialog.innerHTML = `
    <div class="vault-save-head">
      <div class="vault-save-icon">${BOLD_ICON}</div>
      <div>
        <div class="vault-save-title">save to BOLD</div>
        <div class="vault-save-sub">ETH on Optimism → BOLD on Ethereum${bestApy > 0 ? ` · ${bestApy.toFixed(1)}% APR` : ''}</div>
      </div>
    </div>
    <div class="vault-save-body">
      <div class="vault-save-field">
        <div class="vault-save-field-head">
          <span class="vault-save-field-label">you send</span>
          <span class="vault-save-bal">${ethBalStr} ETH${ethBalFiat ? ' · ' + ethBalFiat : ''}</span>
        </div>
        <div class="vault-save-input-row">
          <input id="swap-amount" type="text" inputmode="decimal" placeholder="0.00" class="vault-save-input" autocomplete="off">
          <div class="vault-save-token">${ETH_ICON}<span>ETH</span></div>
        </div>
        <div class="vault-save-field-foot">
          <span id="swap-fiat" class="vault-save-fiat"></span>
          <div class="vault-presets">${presets}</div>
        </div>
      </div>
      <div class="vault-save-arrow"><i class="ph ph-arrow-down"></i></div>
      <div class="vault-save-field">
        <span class="vault-save-field-label">you receive</span>
        <div class="vault-save-input-row">
          <span id="swap-output" class="vault-save-output">—</span>
          <div class="vault-save-token">${BOLD_ICON}<span>BOLD</span></div>
        </div>
        <div id="swap-rate" class="vault-save-fiat"></div>
      </div>
      ${poolCards ? `<div class="vault-save-field-label" style="margin-top:0.5em">deposit into</div><div class="vault-pool-cards">${poolCards}</div>` : ''}
      <div class="vault-save-steps" id="swap-steps">
        <div class="vault-save-step" data-step="bridge"><span class="vault-save-step-dot"></span>bridge ETH to Ethereum</div>
        <div class="vault-save-step" data-step="swap"><span class="vault-save-step-dot"></span>swap ETH → BOLD</div>
        <div class="vault-save-step" data-step="deposit"><span class="vault-save-step-dot"></span>deposit into stability pool</div>
      </div>
      <button id="swap-confirm" class="vault-save-btn" disabled>enter amount</button>
      <div id="swap-status" class="vault-save-status"></div>
    </div>
  `
  overlay.appendChild(dialog)
  document.body.appendChild(overlay)
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })

  dialog.querySelectorAll('.vault-pool-card').forEach(card => {
    card.addEventListener('click', () => {
      dialog.querySelectorAll('.vault-pool-card').forEach(c => c.classList.remove('vault-pool-card-selected'))
      card.classList.add('vault-pool-card-selected')
      card.querySelector('input').checked = true
    })
  })

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
    el.className = 'vault-save-step'
    if (state) el.classList.add(`vault-save-step-${state}`)
  }

  dialog.querySelectorAll('.vault-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      swapInput.value = parseFloat(btn.dataset.amount).toFixed(6)
      swapInput.dispatchEvent(new Event('input'))
    })
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
    if (ethRate) swapFiat.textContent = `≈ ${formatFiat(val * ethRate, currency)}`

    clearTimeout(_quoteTimer)
    outputEl.textContent = '...'
    outputEl.style.color = 'var(--dim)'
    rateEl.textContent = ''
    confirmBtn.disabled = true
    confirmBtn.textContent = 'quoting...'

    _quoteTimer = setTimeout(async () => {
      try {
        const amountIn = parseEther(val.toFixed(18))
        const uniQuote = await getUniswapBoldQuote(amountIn)
        const boldOut = Number(uniQuote.amountOut) / 1e18

        _lastQuote = { amountIn, boldOut, fee: uniQuote.fee }
        outputEl.textContent = boldOut.toFixed(2)
        outputEl.style.color = 'var(--fg)'
        const rate = boldOut / val
        rateEl.textContent = `1 ETH ≈ ${rate.toFixed(2)} BOLD`
        confirmBtn.disabled = false
        confirmBtn.textContent = 'save'
      } catch (e) {
        console.warn('quote error:', e)
        if (ethRate) {
          const est = val * ethRate
          _lastQuote = { amountIn: parseEther(val.toFixed(18)), boldOut: est, fee: 3000 }
          outputEl.textContent = `≈ ${est.toFixed(2)}`
          outputEl.style.color = 'var(--dim)'
          rateEl.textContent = 'estimate — pool may vary'
          confirmBtn.disabled = false
          confirmBtn.textContent = 'save'
        } else {
          outputEl.textContent = 'unavailable'
          outputEl.style.color = 'var(--dim)'
          rateEl.textContent = ''
          confirmBtn.disabled = true
          confirmBtn.textContent = 'no liquidity'
          _lastQuote = null
        }
      }
    }, 600)
  })

  confirmBtn.addEventListener('click', async () => {
    if (!_lastQuote) return
    const { amountIn } = _lastQuote
    const selectedPool = dialog.querySelector('input[name="sp-pool"]:checked')?.value
    confirmBtn.disabled = true
    swapInput.disabled = true
    statusEl.textContent = ''
    statusEl.style.color = 'var(--muted)'

    try {
      const fee = _lastQuote.fee || 3000

      // --- Step 1: Bridge ETH from Optimism to Ethereum mainnet ---
      markStep('bridge', 'active')
      confirmBtn.textContent = 'step 1/3: bridging...'
      await executeBridge(addr, amountIn, (msg) => { statusEl.textContent = msg })
      markStep('bridge', 'done')

      // --- Step 2: Swap ETH → BOLD on Uniswap (Ethereum mainnet) ---
      markStep('swap', 'active')
      confirmBtn.textContent = 'step 2/3: swapping...'
      statusEl.textContent = 'waiting for ETH on Ethereum...'
      await new Promise(r => setTimeout(r, 5000))
      await swapEthToBold(addr, fee, (msg) => { statusEl.textContent = msg })
      markStep('swap', 'done')

      // --- Step 3: Deposit into stability pool ---
      if (selectedPool) {
        markStep('deposit', 'active')
        confirmBtn.textContent = 'step 3/3: depositing...'
        const boldBal = await getBoldBalanceMainnet(addr)
        if (boldBal > 0n) {
          await depositToStabilityPool(selectedPool, boldBal, addr, (msg) => { statusEl.textContent = msg })
          markStep('deposit', 'done')
        } else {
          statusEl.textContent = 'BOLD arriving — deposit manually when ready'
          markStep('deposit', 'done')
        }
      } else {
        markStep('deposit', 'done')
      }

      confirmBtn.textContent = 'done'
      confirmBtn.style.borderColor = 'var(--green)'
      confirmBtn.style.color = 'var(--green)'
      statusEl.style.color = 'var(--green)'
      statusEl.textContent = selectedPool ? 'deposited — earning yield' : 'BOLD on Ethereum — ready to deposit'
      window.dispatchEvent(new CustomEvent('wallet-balance-changed'))
      setTimeout(() => overlay.remove(), 4000)
    } catch (e) {
      const failedStep = stepsEl?.querySelector('.vault-save-step-active')
      if (failedStep) {
        failedStep.className = 'vault-save-step vault-save-step-error'
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
  const ethBal = Number(balance) / 1e18
  let prices = await getEthPrices().catch(() => null)
  const currency = getUserCurrency()
  const ethRate = prices?.[currency] || 0
  const balFiat = ethRate ? formatFiat(ethBal * ethRate, currency) : ''

  const presets = [25, 50, 75, 100].map(pct => {
    const amt = Math.max(0, ethBal * pct / 100 - (pct === 100 ? 0.0005 : 0))
    return `<button class="vault-preset" data-amount="${amt.toFixed(6)}">${pct === 100 ? 'max' : pct + '%'}</button>`
  }).join('')

  dialog.innerHTML = `
    <div class="vault-save-head">
      <div class="vault-save-icon">${ETH_ICON}</div>
      <div>
        <div class="vault-save-title">send</div>
        <div class="vault-save-sub">on Optimism</div>
      </div>
    </div>
    <div class="vault-save-body">
      <div class="vault-save-field">
        <span class="vault-save-field-label">to</span>
        <div class="vault-save-input-row">
          <input id="send-to" type="text" placeholder="handle, address, or domain" class="vault-save-input" style="font-size:0.95em;font-weight:400" autocomplete="off">
        </div>
        <div id="send-resolved" class="vault-save-fiat" style="min-height:1em"></div>
      </div>
      <div class="vault-save-field">
        <div class="vault-save-field-head">
          <span class="vault-save-field-label">amount</span>
          <span class="vault-save-bal">${balEth} ETH${balFiat ? ' · ' + balFiat : ''}</span>
        </div>
        <div class="vault-save-input-row">
          <input id="send-amount" type="text" inputmode="decimal" placeholder="0.00" class="vault-save-input" autocomplete="off">
          <div class="vault-save-token">${ETH_ICON}<span>ETH</span></div>
        </div>
        <div class="vault-save-field-foot">
          <span id="send-fiat" class="vault-save-fiat"></span>
          <div class="vault-presets">${presets}</div>
        </div>
      </div>
      <button id="send-confirm" class="vault-save-btn">send</button>
      <div id="send-status" class="vault-save-status"></div>
    </div>
  `
  overlay.appendChild(dialog)
  document.body.appendChild(overlay)

  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })

  const amountInput = dialog.querySelector('#send-amount')
  const fiatEl = dialog.querySelector('#send-fiat')
  const toInput = dialog.querySelector('#send-to')
  const resolvedEl = dialog.querySelector('#send-resolved')

  dialog.querySelectorAll('.vault-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      amountInput.value = parseFloat(btn.dataset.amount).toFixed(6)
      amountInput.dispatchEvent(new Event('input'))
    })
  })

  amountInput.addEventListener('input', () => {
    const val = parseFloat(amountInput.value)
    if (!val || isNaN(val) || !ethRate) { fiatEl.textContent = ''; return }
    fiatEl.textContent = `≈ ${formatFiat(val * ethRate, currency)}`
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
