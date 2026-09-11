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

// Chains where the gas token is ETH. Polygon (137) is skipped because its
// native token is POL/MATIC and we don't price it. zkSync is included but
// often has flaky RPC — treat failures as zero.
const ETH_CHAINS = [
  { chainId: 10, name: 'Optimism' },
  { chainId: 1, name: 'Ethereum' },
  { chainId: 8453, name: 'Base' },
  { chainId: 42161, name: 'Arbitrum' },
  { chainId: 324, name: 'zkSync Era' },
]

// Conservative gas-unit estimates per chain for the tx we're about to send.
// - Ethereum mainnet: multi-hop V3 swap (~250k) with 1.5x buffer.
// - L2s: bridge tx to Ethereum. Arbitrum-flavored chains price L1 calldata
//   so we bump the unit count to reflect real cost, not just execution gas.
const GAS_UNITS = { 1: 300000n, 10: 220000n, 8453: 220000n, 42161: 1200000n, 324: 1200000n }

async function _fetchGasPrice(chainId) {
  try {
    const res = await fetch(`/api/rpc/${chainId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_gasPrice', params: [] }),
    })
    const data = await res.json()
    return data?.result ? BigInt(data.result) : 0n
  } catch { return 0n }
}

// Wei to keep back from a source-chain balance so the tx doesn't fail with
// "total cost exceeds balance". Trusts the live RPC gas price + a 1.5x safety
// buffer as the primary source. Falls back to a small static reserve only
// when the RPC is unreachable — the previous "always floor at 0.008 ETH"
// approach was reserving ~$19 on mainnet at a 1-gwei fee window, which
// crushed usable balance for anyone with under 0.01 ETH.
async function computeGasReserve(chainId) {
  const gasPrice = await _fetchGasPrice(chainId)
  const units = GAS_UNITS[chainId] || 250000n
  if (gasPrice === 0n) {
    return chainId === 1 ? 2500000000000000n /* 0.0025 ETH — RPC-fallback only */ : 100000000000000n /* 0.0001 ETH */
  }
  return (gasPrice * units * 3n) / 2n
}

// Return the raw gas price alongside the reserve — the UI displays both.
async function computeGasBreakdown(chainId) {
  const gasPrice = await _fetchGasPrice(chainId)
  const units = GAS_UNITS[chainId] || 250000n
  if (gasPrice === 0n) {
    const reserve = chainId === 1 ? 2500000000000000n : 100000000000000n
    return { reserve, estimated: reserve, gasPrice: 0n, units }
  }
  const estimated = gasPrice * units
  const reserve = (estimated * 3n) / 2n
  return { reserve, estimated, gasPrice, units }
}

const STABILITY_POOLS = {
  ETH: '0x5721cbbd64fc7ae3ef44a0a3f9a790a9264cf9bf',
  wstETH: '0x9502b7c397e9aa22fe9db7ef7daf21cd2aebe56b',
  rETH: '0xd442e41019b7f5c4dd78f50dc03726c446148695',
}

const WETH_MAINNET = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const USDC_MAINNET = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const UNISWAP_QUOTER = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e'
const UNISWAP_ROUTER = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45'

// Liquity v2 BOLD has no direct WETH/BOLD Uniswap V3 pool — all direct-pair
// liquidity is on V4. On V3 we route ETH -> USDC -> BOLD via QuoterV2/SwapRouter02
// multi-hop. WETH/USDC 0.05% and BOLD/USDC 0.05% both have real V3 depth.
const UNISWAP_QUOTER_ABI = [{
  name: 'quoteExactInput', type: 'function', stateMutability: 'nonpayable',
  inputs: [{ name: 'path', type: 'bytes' }, { name: 'amountIn', type: 'uint256' }],
  outputs: [{ name: 'amountOut', type: 'uint256' }, { name: 'sqrtPriceX96AfterList', type: 'uint160[]' },
    { name: 'initializedTicksCrossedList', type: 'uint32[]' }, { name: 'gasEstimate', type: 'uint256' }],
}]

const UNISWAP_ROUTER_ABI = [{
  name: 'exactInput', type: 'function', stateMutability: 'payable',
  inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'path', type: 'bytes' }, { name: 'recipient', type: 'address' },
    { name: 'amountIn', type: 'uint256' }, { name: 'amountOutMinimum', type: 'uint256' },
  ]}],
  outputs: [{ name: 'amountOut', type: 'uint256' }],
}]

// V3 path: token(20) + fee(3, big-endian uint24) + token(20) + fee(3) + token(20) ...
function encodeV3Path(tokens, fees) {
  if (tokens.length !== fees.length + 1) throw new Error('bad path')
  let out = '0x'
  for (let i = 0; i < fees.length; i++) {
    out += tokens[i].slice(2).toLowerCase()
    out += fees[i].toString(16).padStart(6, '0')
  }
  out += tokens[tokens.length - 1].slice(2).toLowerCase()
  return out
}

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
let _mediaArtMap = {}

// Walk site.json music/audio/video modules and build a lowercase-title →
// cover-art URL lookup. Used by the activity feed so a track sale row
// shows the actual record cover, not a generic music-note icon.
async function _buildArtMap() {
  try {
    const res = await fetch('/site.json')
    if (!res.ok) return {}
    const site = await res.json()
    const map = {}
    const add = (title, art) => {
      if (!title || !art) return
      const key = String(title).trim().toLowerCase()
      if (!map[key]) map[key] = art
    }
    for (const mod of (site.modules || [])) {
      const d = mod.data || {}
      // music: aliases[].albums[] + tracks[]
      if (mod.type === 'music' || mod.type === 'audio') {
        for (const alias of (d.aliases || [d])) {
          for (const album of (alias.albums || [])) {
            add(album.title, album.art)
            for (const track of (album.tracks || [])) add(track.title, track.art || album.art)
          }
          for (const track of (alias.tracks || [])) add(track.title, track.art)
        }
      }
      // video / film / gallery / demos / writing — items[] { title, poster/art/cover }
      const items = d.items || d.works || d.publications || d.images || []
      for (const it of items) add(it.title, it.poster || it.art || it.cover || it.src)
    }
    return map
  } catch { return {} }
}

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
    const [chainBalances, boldBalance, spDeposits, unclaimed, earned, contributed, ticketUnclaimed, ethPrices, yieldData] = await Promise.all([
      fetchChainBalances(addr).catch(() => [{ chainId: 10, name: 'Optimism', balance: 0n }]),
      getBoldBalanceMainnet(addr).catch(() => 0n),
      getStabilityDeposits(addr).catch(() => ({ total: 0n, pools: [] })),
      getPendingWithdrawals(addr),
      fetchEarned(addrLower),
      fetchContributed(addrLower),
      getTicketPendingWithdrawals(addr).catch(() => 0n),
      getEthPrices().catch(() => null),
      fetchBoldYield().catch(() => null),
    ])
    const ethBalance = chainBalances.reduce((s, c) => s + c.balance, 0n)

    const addressesToResolve = [
      ...earned.mediaSales.map(s => s.buyer),
    ].filter(Boolean)
    const domainMap = await resolveAddresses(query, addressesToResolve).catch(() => ({}))

    const resolve = a => resolveDomain(domainMap, a)
    _ethPrices = ethPrices
    _yieldData = yieldData
    // Build a title→cover-art map from the site's music module so the
    // activity feed can show real thumbnails (a track sale reads as
    // "someone bought THAT record", not "an abstract media sale").
    _mediaArtMap = await _buildArtMap().catch(() => ({}))
    _allHistory = buildHistory(earned, contributed, resolve, ethPrices)
    _historyShown = 0

    renderVault(contentEl, { ethBalance, chainBalances, boldBalance, spDeposits, unclaimed, earned, contributed, addr, mediaAddr, ticketUnclaimed, ethPrices, yieldData })
  } catch (e) {
    console.warn('vault load error:', e)
    contentEl.innerHTML = `<p style="color:var(--muted)">failed to load vault</p>`
  }
}

async function fetchChainBalances(addr) {
  const results = await Promise.all(ETH_CHAINS.map(async ({ chainId, name }) => {
    try {
      const res = await fetch(`/api/rpc/${chainId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [addr, 'latest'] }),
      })
      const data = await res.json()
      const balance = data?.result ? BigInt(data.result) : 0n
      return { chainId, name, balance }
    } catch {
      return { chainId, name, balance: 0n }
    }
  }))
  return results
}

async function getBoldBalanceMainnet(addr) {
  const { createPublicClient, http, mainnet } = await import('./vendor.js')
  const pc = createPublicClient({ chain: { ...mainnet, rpcUrls: { ...mainnet.rpcUrls, default: { http: ['/api/rpc/1'] } } }, transport: http('/api/rpc/1') })
  return pc.readContract({ address: BOLD_MAINNET, abi: ERC20_BALANCE_ABI, functionName: 'balanceOf', args: [addr] })
}

// Liquity V2 SP view: current BOLD deposit balance (including yield share).
const SP_DEPOSIT_ABI = [{
  type: 'function', name: 'getCompoundedBoldDeposit', stateMutability: 'view',
  inputs: [{ name: '_depositor', type: 'address' }],
  outputs: [{ name: '', type: 'uint256' }],
}]

async function getStabilityDeposits(addr) {
  const { createPublicClient, http, mainnet } = await import('./vendor.js')
  const pc = createPublicClient({ chain: { ...mainnet, rpcUrls: { ...mainnet.rpcUrls, default: { http: ['/api/rpc/1'] } } }, transport: http('/api/rpc/1') })
  const entries = Object.entries(STABILITY_POOLS)
  const results = await Promise.all(entries.map(async ([name, spAddr]) =>
    pc.readContract({ address: spAddr, abi: SP_DEPOSIT_ABI, functionName: 'getCompoundedBoldDeposit', args: [addr] })
      .then(bal => ({ name, spAddr, balance: bal }))
      .catch(() => ({ name, spAddr, balance: 0n }))
  ))
  const total = results.reduce((s, r) => s + r.balance, 0n)
  return { total, pools: results }
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

// Multi-hop V3 quote for ETH -> USDC -> BOLD. Tries a few fee-tier combos on
// each leg. Returns { amountOut, path } where `path` is the V3 path bytes to
// hand to SwapRouter02.exactInput.
async function getUniswapBoldQuote(ethAmountWei) {
  const pc = await getMainnetClient()
  // Leg 1 (WETH/USDC): 0.05% has the deepest V3 liquidity, then 0.3%.
  // Leg 2 (USDC/BOLD): the live V3 pool is 0.05% (~$1.4M TVL).
  const combos = [
    [500, 500],
    [3000, 500],
    [500, 100],
    [500, 3000],
  ]
  const errors = []
  for (const [fee1, fee2] of combos) {
    const path = encodeV3Path([WETH_MAINNET, USDC_MAINNET, BOLD_MAINNET], [fee1, fee2])
    try {
      // QuoterV2 is nonpayable — viem's simulateContract handles the
      // revert-decode round-trip correctly. Raw pc.call() returned '0x'
      // under simulation and broke every fee-tier probe.
      const { result } = await pc.simulateContract({
        address: UNISWAP_QUOTER, abi: UNISWAP_QUOTER_ABI,
        functionName: 'quoteExactInput', args: [path, ethAmountWei],
      })
      const amountOut = Array.isArray(result) ? BigInt(result[0]) : BigInt(result)
      if (amountOut > 0n) return { amountOut, path }
      errors.push(`${fee1}/${fee2}: amountOut=0`)
    } catch (e) {
      errors.push(`${fee1}/${fee2}: ${e?.shortMessage || e?.message || e}`)
    }
  }
  console.warn('[bold-quote] no route via USDC:', errors)
  throw new Error(`no BOLD liquidity (${errors.join(' | ')})`)
}

async function getRelayBridgeQuote(fromChainId, amountWei, addr) {
  const res = await fetch('/api/relay/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      originChainId: fromChainId, destinationChainId: 1,
      originCurrency: ETH_ZERO, destinationCurrency: ETH_ZERO,
      amount: amountWei.toString(),
      user: addr, recipient: addr, tradeType: 'EXACT_INPUT',
    }),
  })
  const data = await res.json()
  if (!res.ok || data.error) throw new Error(data.error || data.message || 'bridge quote failed')
  return data
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

// Poll mainnet balance after a bridge until the funds arrive. Relay L2->L1
// can take 30s–15min; the previous 5-second sleep guaranteed swapEthToBold
// would throw "insufficient ETH on Ethereum after bridge" for every user
// who picked a non-mainnet source chain. Returns the observed delta.
async function waitForBridgedFunds(addr, expectedMinIncrease, onStatus) {
  const pc = await getMainnetClient()
  const before = await pc.getBalance({ address: addr })
  // Consider the bridge landed when at least 90% of the expected amount
  // arrives (Relay fees + gas eat some) — but never accept less than 50%
  // of expected, which would indicate a partial/failed bridge.
  const target = before + (expectedMinIncrease * 90n) / 100n
  const floor = before + (expectedMinIncrease * 50n) / 100n
  const startedAt = Date.now()
  const TIMEOUT_MS = 15 * 60 * 1000 // 15 minutes
  const POLL_MS = 5000
  let last = before
  while (Date.now() - startedAt < TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, POLL_MS))
    let current = last
    try { current = await pc.getBalance({ address: addr }) } catch {}
    if (current >= target) return current - before
    last = current
    const secs = Math.round((Date.now() - startedAt) / 1000)
    onStatus?.(`bridging to Ethereum — waiting ${secs}s… (typical 30s–15min)`)
  }
  // Final check: accept if partial funds landed, else throw.
  const final = await pc.getBalance({ address: addr }).catch(() => last)
  if (final >= floor) return final - before
  throw new Error('bridge timed out after 15 minutes — check your source chain tx and try the swap step manually')
}

async function executeBridge(fromChainId, addr, amountWei, onStatus) {
  onStatus?.('getting bridge quote...')
  const quote = await getRelayBridgeQuote(fromChainId, amountWei, addr)

  const steps = quote.steps || []
  if (!steps.length || !steps[0]?.items?.length) throw new Error('no bridge steps in quote')
  const txData = steps[0].items[0].data
  if (!txData?.to) throw new Error('invalid bridge quote')

  onStatus?.('confirm bridge...')
  const { _buildBridgeWalletClient } = await import('./relay-bridge.js')
  let walletClient
  try { walletClient = await _buildBridgeWalletClient(fromChainId) } catch {
    const { createWalletClient: cwc, custom: cst, optimism: op, mainnet: mn, base: bs, arbitrum: ar } = await import('./vendor.js')
    const chainMap = { 10: op, 1: mn, 8453: bs, 42161: ar }
    const chain = chainMap[fromChainId] || op
    walletClient = cwc({ chain, transport: cst(getWalletProvider()), account: window.getEmbeddedAccount?.() || addr })
  }

  onStatus?.('bridging ETH to Ethereum...')
  const hash = await walletClient.sendTransaction({
    to: txData.to,
    data: txData.data,
    value: BigInt(txData.value || '0'),
    ...(txData.maxFeePerGas ? { maxFeePerGas: BigInt(txData.maxFeePerGas) } : {}),
    ...(txData.maxPriorityFeePerGas ? { maxPriorityFeePerGas: BigInt(txData.maxPriorityFeePerGas) } : {}),
    ...(txData.gas ? { gas: BigInt(txData.gas) } : {}),
  })
  onStatus?.('bridge submitted — waiting for ETH on Ethereum...')
  return hash
}

// Swap ETH -> BOLD via Uniswap V3 multi-hop (WETH/USDC + USDC/BOLD).
// `bridgedAmount` is what the bridge deposited (0 if source chain was
// already mainnet); it caps the swap amount so pre-existing mainnet ETH
// isn't consumed. Returns { hash, amountOut } — the exact BOLD delta the
// caller should deposit into the SP (don't re-read wallet balance,
// which is subject to RPC read-after-write lag and picks up unrelated
// liquid BOLD the user wanted to keep).
async function swapEthToBold(addr, path, onStatus, bridgedAmount = 0n) {
  const { _buildBridgeWalletClient } = await import('./relay-bridge.js')
  const pc = await getMainnetClient()

  const mainnetBal = await pc.getBalance({ address: addr })
  // Reserve real gas for the mainnet swap — the RPC will reject the tx if
  // value + gas fee > balance. Live gas price with a 1.5x buffer beats the
  // old 0.00005 ETH floor by ~100x during a normal mainnet fee window.
  const gasReserve = await computeGasReserve(1)
  const spendable = mainnetBal > gasReserve ? mainnetBal - gasReserve : 0n
  // Cap by the bridged amount if we bridged — otherwise the swap consumes
  // whatever unrelated ETH sat on mainnet before the flow started.
  const swapAmount = bridgedAmount > 0n
    ? (bridgedAmount < spendable ? bridgedAmount : spendable)
    : spendable
  if (swapAmount <= 0n) throw new Error('insufficient ETH on Ethereum after bridge')

  // Re-quote against the actual mainnet balance (may differ from the modal quote
  // after bridge fees) and pick up a fresh path in case the fallback path is stale.
  onStatus?.('quoting swap...')
  const quote = await getUniswapBoldQuote(swapAmount)
  const quotedOut = quote.amountOut
  const swapPath = quote.path || path || encodeV3Path([WETH_MAINNET, USDC_MAINNET, BOLD_MAINNET], [500, 500])
  // BOLD/USDC 0.05% has ~$1.4M TVL so a $5k swap can move price ≥3%.
  // 5% slippage is friendlier than 3% here — the previous 97/100 was
  // reverting on real depth.
  const minOut = quotedOut * 95n / 100n

  onStatus?.('confirm swap...')
  let walletClient
  try { walletClient = await _buildBridgeWalletClient(1) } catch {
    const { createWalletClient: cwc, custom: cst, mainnet: mn } = await import('./vendor.js')
    walletClient = cwc({ chain: { ...mn, rpcUrls: { ...mn.rpcUrls, default: { http: ['/api/rpc/1'] } } }, transport: cst(getWalletProvider()), account: window.getEmbeddedAccount?.() || addr })
  }

  // Snapshot BOLD balance before + after so we get the exact swap output
  // regardless of any pre-existing BOLD the user held.
  const boldBefore = await pc.readContract({
    address: BOLD_MAINNET, abi: ERC20_BALANCE_ABI, functionName: 'balanceOf', args: [addr],
  }).catch(() => 0n)

  const hash = await walletClient.writeContract({
    address: UNISWAP_ROUTER, abi: UNISWAP_ROUTER_ABI, functionName: 'exactInput',
    args: [{ path: swapPath, recipient: addr, amountIn: swapAmount, amountOutMinimum: minOut }],
    value: swapAmount,
  })
  onStatus?.('swap submitted...')
  await pc.waitForTransactionReceipt({ hash, timeout: 120_000 })

  const boldAfter = await pc.readContract({
    address: BOLD_MAINNET, abi: ERC20_BALANCE_ABI, functionName: 'balanceOf', args: [addr],
  }).catch(() => 0n)
  const amountOut = boldAfter > boldBefore ? boldAfter - boldBefore : 0n
  onStatus?.('BOLD received')
  return { hash, amountOut }
}

async function depositToStabilityPool(spAddress, boldAmount, addr, onStatus) {
  const { createWalletClient, createPublicClient, custom, http, mainnet } = await import('./vendor.js')

  await window.ensureAuthorized?.()
  const embeddedAcct = window.getEmbeddedAccount?.()
  if (!embeddedAcct) throw new Error('wallet not available')

  const rpcUrl = '/api/rpc/1'
  const chainDef = { ...mainnet, rpcUrls: { ...mainnet.rpcUrls, default: { http: [rpcUrl] } } }
  const pc = createPublicClient({ chain: chainDef, transport: http(rpcUrl) })

  // fetchBoldYield catches to null on failure — fall back to the pinned
  // constant so the deposit still works when /api/bold/yield is down.
  const boldMainnet = _yieldData?.boldMainnet || BOLD_MAINNET

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
    // Prefer a real cover thumbnail when we have one for this title.
    // Fallback to the type icon so the row still reads as a media event.
    const title = String(h.title || h.detail || '').trim().toLowerCase()
    const art = _mediaArtMap[title] || h.art || null
    const artUrl = art ? (art.startsWith('http') || art.startsWith('/') ? art : `/api/ipfs-proxy/${art}`) : null
    const thumb = artUrl
      ? `<div class="vault-tx-thumb"><img loading="lazy" src="/api/img?url=${encodeURIComponent(artUrl)}&w=80" alt=""></div>`
      : `<div class="vault-tx-icon" style="color:${color}"><i class="ph ${h.icon}"></i></div>`
    return `<div class="vault-tx">
      ${thumb}
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

// Chain brand marks. Small colored SVGs so each chain reads as a distinct
// place, not just a name. Kept inline (data URI-ish) to avoid an extra
// asset request. Colors match each chain's brand.
const CHAIN_MARKS = {
  Optimism: `<svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="7" fill="#FF0420"/><text x="7" y="9.7" text-anchor="middle" font-size="7.5" font-weight="700" fill="white" font-family="system-ui, sans-serif">O</text></svg>`,
  Ethereum: `<svg width="14" height="14" viewBox="0 0 24 24"><path d="M12 1L4 12.5L12 16L20 12.5L12 1Z" fill="#627EEA" opacity="0.7"/><path d="M12 1L4 12.5L12 12V1Z" fill="#627EEA"/><path d="M12 17L4 14L12 23L20 14L12 17Z" fill="#627EEA" opacity="0.7"/><path d="M12 17L4 14L12 23V17Z" fill="#627EEA"/></svg>`,
  Base: `<svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="7" fill="#0052FF"/><path d="M7 12.25C9.9 12.25 12.25 9.9 12.25 7C12.25 4.1 9.9 1.75 7 1.75C4.25 1.75 2 3.85 1.77 6.54H8.6V7.46H1.77C2 10.15 4.25 12.25 7 12.25Z" fill="white"/></svg>`,
  Arbitrum: `<svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="7" fill="#28A0F0"/><path d="M7.7 2.6L10.5 10.5H9L8.35 8.7H5.65L5 10.5H3.5L6.3 2.6H7.7ZM7 4.4L6.05 7.5H7.95L7 4.4Z" fill="white"/></svg>`,
}
function chainMark(name) { return CHAIN_MARKS[name] || `<span class="vault-chain-dot" style="background:var(--dim)"></span>` }

function renderVault(el, { ethBalance, chainBalances, boldBalance, spDeposits, unclaimed, earned, contributed, addr, mediaAddr, ticketUnclaimed, ethPrices, yieldData }) {
  const totalUnclaimed = unclaimed.praxis + unclaimed.media + ticketUnclaimed
  const totalEarned = earned.mediaTotal + earned.projectEarnings
  const totalContributed = contributed.fundingTotal + contributed.purchaseTotal
  const currency = getUserCurrency()
  const ethRate = ethPrices?.[currency] || 0
  const usdRate = ethPrices?.usd || 0
  // BOLD is USD-pegged (1 BOLD ≈ $1). Convert USD → user currency via
  // ETH price parity: (ETH-in-local / ETH-in-USD) = USD-to-local rate.
  // Falls back to 1 when we can't compute it, which keeps the display
  // sensible for USD users and never displays raw USD as another symbol.
  const usdToLocal = (ethRate > 0 && usdRate > 0) ? ethRate / usdRate : 1

  const ethFiat = ethRate ? Number(ethBalance) / 1e18 * ethRate : 0
  const spTotal = spDeposits?.total || 0n
  const boldUsd = (Number(boldBalance) + Number(spTotal)) / 1e18
  const boldFiat = boldUsd * usdToLocal
  const totalFiat = ethFiat + boldFiat

  const totalEarnedFiat = ethRate ? Number(totalEarned) / 1e18 * ethRate : 0
  const totalSpentFiat = ethRate ? Number(totalContributed) / 1e18 * ethRate : 0
  const netFiat = totalEarnedFiat - totalSpentFiat

  let html = ''
  // BOLD total for the breakdown reveal below the hero number.
  const totalBoldForBreakdown = (spDeposits?.total || 0n) + boldBalance

  // Per docs/design-philosophy.md: the vault is a document, not a
  // dashboard. Reads top to bottom. One story: "here is your money —
  // where it lives, what it's earning, what's moving." Every element
  // earns its size from the number it carries.

  html += `<div class="vault-doc">`

  // --- The number ---
  // The largest number on the page: total balance. Clicking it expands a
  // chain-by-chain breakdown of what it's actually made of, so the user
  // can inspect composition without a separate "where it lives" section
  // competing for weight.
  html += `<section class="vault-lead">`
  html += `<div class="vault-lead-label">total balance</div>`
  html += `<button type="button" class="vault-lead-toggle" id="vault-lead-toggle" aria-expanded="false" aria-controls="vault-lead-breakdown">`
  html += `<span class="vault-lead-value">${formatFiat(totalFiat, currency)}</span>`
  html += `<span class="vault-lead-caret" aria-hidden="true">▾</span>`
  html += `</button>`
  // Inline breakdown of chains — hidden until user clicks the total.
  html += `<div class="vault-lead-breakdown" id="vault-lead-breakdown" hidden>`
  const breakdownRows = (chainBalances || [{ chainId: 10, name: 'Optimism', balance: ethBalance }])
    .filter(c => c.balance > 0n || c.chainId === 10)
  for (const c of breakdownRows) {
    const fiat = ethRate ? Number(c.balance) / 1e18 * ethRate : 0
    html += `<div class="vault-lead-row">`
    html += `<span class="vault-lead-row-name">${escapeHtml(c.name)}</span>`
    html += `<span class="vault-lead-row-bal">${formatEthAmount(c.balance)} <span style="color:var(--dim)">ETH</span></span>`
    html += `<span class="vault-lead-row-fiat">${ethRate ? formatFiat(fiat, currency) : ''}</span>`
    html += `</div>`
  }
  if (totalBoldForBreakdown > 0n) {
    const boldNum = Number(totalBoldForBreakdown) / 1e18
    html += `<div class="vault-lead-row">`
    html += `<span class="vault-lead-row-name">Ethereum <span style="color:var(--dim);font-size:0.9em">· BOLD savings</span></span>`
    html += `<span class="vault-lead-row-bal">${boldNum.toFixed(2)} <span style="color:var(--dim)">BOLD</span></span>`
    html += `<span class="vault-lead-row-fiat">${formatFiat(boldNum * usdToLocal, currency)}</span>`
    html += `</div>`
  }
  html += `</div>`

  if (totalEarned > 0n || totalContributed > 0n) {
    html += `<div class="vault-lead-meta">`
    html += `<span class="vault-lead-chip"><span class="vault-lead-chip-key">earned</span> <span style="color:var(--green)">${formatFiat(totalEarnedFiat, currency)}</span></span>`
    html += `<span class="vault-lead-chip"><span class="vault-lead-chip-key">spent</span> ${formatFiat(totalSpentFiat, currency)}</span>`
    if (Math.abs(netFiat) > 0.01) {
      const netColor = netFiat >= 0 ? 'var(--green)' : 'var(--muted)'
      const netSign = netFiat >= 0 ? '+' : '−'
      html += `<span class="vault-lead-chip"><span class="vault-lead-chip-key">net</span> <span style="color:${netColor}">${netSign}${formatFiat(Math.abs(netFiat), currency)}</span></span>`
    }
    html += `</div>`
  }
  // Actions live with the hero as small text links — subordinate to the
  // number, not competing with it.
  html += `<div class="vault-lead-verbs">`
  html += `<button type="button" class="vault-verb" id="vault-send-btn">send</button>`
  html += `<button type="button" class="vault-verb" id="vault-receive-btn">receive</button>`
  html += `<button type="button" class="vault-verb" id="vault-fund-btn">add funds</button>`
  html += `<button type="button" class="vault-verb" id="vault-cashout-btn">cash out</button>`
  html += `</div>`
  html += `</section>`

  // --- What it's earning ---
  // Savings gets its own act. The "save" action lives HERE, attached to
  // its subject — not repeated in a generic action strip.
  const bestApyHead = yieldData?.bestApy || 0
  const spTotalHead = spDeposits?.total || 0n
  const totalBoldHead = spTotalHead + boldBalance
  html += `<section class="vault-act vault-act-savings">`
  html += `<header class="vault-act-head">`
  html += `<h2 class="vault-act-title">savings</h2>`
  if (bestApyHead > 0) html += `<span class="vault-act-badge">${bestApyHead.toFixed(1)}% APR available</span>`
  html += `</header>`

  // --- BOLD savings card ---
  const bestApy = yieldData?.bestApy || 0
  const pools = yieldData?.pools || []
  const spTotalBold = spDeposits?.total || 0n
  const liquidBold = boldBalance
  const totalBold = spTotalBold + liquidBold

  // Compute the user's actual yield estimate — per-pool APY × their
  // balance in that pool, summed. This turns an abstract APR number
  // into a concrete dollar figure.
  let projectedYearlyYield = 0
  if (spDeposits?.pools?.length) {
    // spDeposits.pools[].name is the collateral key (ETH/rETH/wstETH);
    // yield endpoint exposes matching `collateral` on each pool.
    const poolApyByCollateral = Object.fromEntries((pools || []).map(p => [p.collateral, p.apy || 0]))
    for (const p of spDeposits.pools) {
      const apy = poolApyByCollateral[p.name] ?? bestApy
      const boldAmount = Number(p.balance) / 1e18
      projectedYearlyYield += boldAmount * (apy / 100)
    }
  } else if (spTotalBold > 0n && bestApy > 0) {
    projectedYearlyYield = (Number(spTotalBold) / 1e18) * (bestApy / 100)
  }
  const projectedMonthlyYield = projectedYearlyYield / 12

  // Savings body: give the BOLD balance a real coin identity — the coin
  // glyph inline with the number, so 11.24 BOLD reads as *money* not just
  // "a number labelled BOLD".
  if (totalBold > 0n) {
    const totalBoldNum = Number(totalBold) / 1e18
    const totalStr = totalBoldNum.toFixed(2)
    html += `<div class="vault-act-figure vault-coin-figure">`
    html += `<span class="vault-coin-mark">${BOLD_ICON}</span>`
    html += `<span class="vault-act-figure-main">${totalStr}</span>`
    html += `<span class="vault-act-figure-unit">BOLD</span>`
    // BOLD is a USD-pegged stablecoin — convert to the user's currency
    // via the USD-to-local factor derived from the ETH price parity.
    html += `<span class="vault-act-figure-secondary">${formatFiat(totalBoldNum * usdToLocal, currency)}</span>`
    html += `</div>`
    if (projectedYearlyYield > 0) {
      html += `<div class="vault-act-yield">`
      html += `earning <span style="color:var(--green)">${formatFiat(projectedMonthlyYield * usdToLocal, currency)}/mo</span> · `
      html += `${formatFiat(projectedYearlyYield * usdToLocal, currency)}/yr projected`
      html += `</div>`
    }
    const parts = []
    if (spTotalBold > 0n) parts.push(`${(Number(spTotalBold) / 1e18).toFixed(2)} earning yield`)
    if (liquidBold > 0n) parts.push(`${(Number(liquidBold) / 1e18).toFixed(2)} liquid`)
    if (parts.length > 0) {
      html += `<div class="vault-act-sub">${parts.join(' · ')}</div>`
    }
    const activePools = (spDeposits?.pools || []).filter(p => p.balance > 0n)
    if (activePools.length > 1) {
      const lines = activePools.map(p =>
        `${p.name}: ${(Number(p.balance) / 1e18).toFixed(2)}`
      ).join(' · ')
      html += `<div class="vault-act-sub">${escapeHtml(lines)}</div>`
    }
  } else {
    html += `<div class="vault-act-figure vault-act-figure-empty">no deposits yet</div>`
    if (bestApy > 0) {
      // $100 → APR%/yr, in the user's currency
      html += `<div class="vault-act-yield">save ${formatFiat(100 * usdToLocal, currency)} → earn ~${formatFiat(100 * (bestApy / 100) * usdToLocal, currency)}/yr</div>`
    }
  }

  // Pools rendered inline as a table — no separate box. Highlight the
  // pool(s) the user is in with a "you" pill so they can see at a glance
  // where their money actually lives. Shows current APR + 30-day mean.
  if (pools.length > 0) {
    html += `<div class="vault-pool-table">`
    html += `<div class="vault-pool-table-head vault-pool-table-head-4"><span>pool</span><span>apr</span><span>30d</span><span>size</span></div>`
    for (const pool of pools.slice(0, 4)) {
      const tvlStr = pool.tvl >= 1e6 ? `$${(pool.tvl / 1e6).toFixed(1)}M` : `$${(pool.tvl / 1e3).toFixed(0)}K`
      // spDeposits.pools uses the short collateral key (ETH/wstETH/rETH);
      // yield endpoint gives us `collateral` on each pool to match against.
      const userAmount = (spDeposits?.pools || []).find(p => p.name === pool.collateral)?.balance || 0n
      const active = userAmount > 0n
      const avgStr = pool.apy7d ? `${pool.apy7d.toFixed(1)}%` : '—'
      // For pools the user is in, a small green dot before the name
      // + user amount shown under it. Scales cleanly whether the user
      // is in one pool or all of them — no stacked pills, no crowding.
      const nameCell = active
        ? `<span class="vault-pool-line-name-you"><span class="vault-pool-line-dot"></span><span><span class="vault-pool-line-name-main">${escapeHtml(pool.name)}</span><span class="vault-pool-line-you-sub">you · ${(Number(userAmount) / 1e18).toFixed(2)} BOLD</span></span></span>`
        : `<span class="vault-pool-line-name">${escapeHtml(pool.name)}</span>`
      html += `<div class="vault-pool-line vault-pool-line-4col${active ? ' vault-pool-line-active' : ''}">`
      html += nameCell
      html += `<span class="vault-pool-line-apr">${pool.apy.toFixed(1)}%</span>`
      html += `<span class="vault-pool-line-apr" style="color:var(--dim)">${avgStr}</span>`
      html += `<span class="vault-pool-line-tvl">${tvlStr}</span>`
      html += `</div>`
    }
    // "Rates updated Xm ago · how this works" — small meta strip.
    const yieldTs = yieldData?.timestamp ? Date.now() - yieldData.timestamp : 0
    const updatedStr = yieldTs > 0
      ? (yieldTs < 60000 ? 'just now' : yieldTs < 3600000 ? `${Math.floor(yieldTs / 60000)}m ago` : `${Math.floor(yieldTs / 3600000)}h ago`)
      : ''
    html += `<div class="vault-pool-meta">`
    if (updatedStr) html += `<span>rates updated ${updatedStr}</span>`
    html += `<button type="button" class="vault-pool-meta-toggle" id="savings-how-toggle" aria-expanded="false">how this works ↓</button>`
    html += `</div>`

    // Progressive disclosure: full mechanics revealed on click.
    html += `<div class="vault-savings-how" id="savings-how" hidden>`
    html += `<h3 class="vault-savings-how-title">how BOLD savings work</h3>`
    html += `<div class="vault-savings-how-body">`
    html += `<p><strong>Where the yield comes from.</strong> BOLD is a US-dollar stablecoin issued by Liquity. People borrow BOLD by locking up ETH as collateral, and they pay interest for the privilege. That interest flows to the stability pool depositors — that's you. Higher borrowing demand = higher yield for you.</p>`
    html += `<p><strong>How you actually earn.</strong> Yield accrues to your deposit block-by-block on Ethereum (roughly every 12 seconds). It auto-compounds — you don't need to claim or restake anything. When you withdraw, you receive your original deposit plus everything it earned.</p>`
    html += `<p><strong>Withdrawing.</strong> No lockup. No penalty. You can withdraw any time; the transaction settles in one Ethereum block. Withdrawing to BOLD is normal; occasionally the pool may pay you in ETH from a liquidation instead — you keep the value either way.</p>`
    if (totalBold > 0n && projectedYearlyYield > 0) {
      const nowBold = Number(totalBold) / 1e18
      const y1 = nowBold * (1 + bestApy / 100)
      const y5 = nowBold * Math.pow(1 + bestApy / 100, 5)
      html += `<p><strong>At today's ${bestApy.toFixed(1)}% rate</strong>, your ${nowBold.toFixed(2)} BOLD (~${formatFiat(nowBold * usdToLocal, currency)}) would grow to about ${y1.toFixed(2)} BOLD (~${formatFiat(y1 * usdToLocal, currency)}) in one year, ${y5.toFixed(2)} BOLD (~${formatFiat(y5 * usdToLocal, currency)}) in five years (compounded, assumes rate holds).</p>`
    }
    html += `<p><a href="https://docs.liquity.org/v2-faq/bold-and-stability-pools" target="_blank" rel="noopener" style="color:var(--accent)">Liquity's official docs on stability pools →</a></p>`
    html += `</div>`
    html += `</div>`
  }
  // The 'save' action lives HERE, attached to its subject — not in a
  // generic action strip. Design philosophy: one home per action.
  html += `<button type="button" class="vault-act-cta" id="vault-save-btn">${totalBold > 0n ? 'save more →' : 'save ETH to BOLD →'}</button>`
  html += `</section>`

  // --- Unclaimed callout ---
  // A single line of green attention when there's money to claim.
  if (totalUnclaimed > 0n) {
    html += `<section class="vault-unclaimed vault-unclaimed-inline">`
    html += `<span class="vault-unclaimed-line">you have <strong>${formatPriceFiatPrimary(totalUnclaimed, ethPrices)}</strong> unclaimed`
    const detailParts = []
    if (unclaimed.media > 0n) detailParts.push(`${formatPriceFiatPrimary(unclaimed.media, ethPrices)} media`)
    if (unclaimed.praxis > 0n) detailParts.push(`${formatPriceFiatPrimary(unclaimed.praxis, ethPrices)} projects`)
    if (ticketUnclaimed > 0n) detailParts.push(`${formatPriceFiatPrimary(ticketUnclaimed, ethPrices)} tickets`)
    if (detailParts.length > 0) html += ` <span style="color:var(--dim)">· ${detailParts.join(' · ')}</span>`
    html += `</span>`
    html += `<div class="vault-unclaimed-verbs">`
    if (unclaimed.media > 0n) html += `<button type="button" class="vault-verb earnings-claim-btn" data-source="media">claim media</button>`
    if (unclaimed.praxis > 0n) html += `<button type="button" class="vault-verb earnings-claim-btn" data-source="projects">claim projects</button>`
    if (ticketUnclaimed > 0n) html += `<button type="button" class="vault-verb earnings-claim-btn" data-source="tickets">claim tickets</button>`
    html += `</div>`
    html += `<p id="earnings-claim-status" class="vault-unclaimed-status"></p>`
    html += `</section>`
  }

  // Chains previously lived here as their own "where it lives" section.
  // They've been folded into a click-to-reveal breakdown under the total
  // balance number so composition reads as part of the hero, not as a
  // separate widget the user has to hunt for.

  // --- What's moving — income + outflow + activity ---
  html += `<section class="vault-act">`
  html += `<header class="vault-act-head">`
  html += `<h2 class="vault-act-title">what's moving</h2>`
  html += `</header>`

  // Two-column income/outflow line — real symmetry because the two sides
  // are the same idea.
  html += `<div class="vault-flow">`
  html += `<div class="vault-flow-col">`
  html += `<div class="vault-flow-label">income</div>`
  const ownMediaTotalDoc = earned.mediaSales.filter(s => s.type !== 'media-collab-sale').reduce((a, s) => a + s.amount, 0n)
  const collabMediaTotalDoc = earned.mediaSales.filter(s => s.type === 'media-collab-sale').reduce((a, s) => a + s.amount, 0n)
  html += `<div class="vault-flow-line"><span>media sales</span><span style="color:var(--green)">${formatPriceFiatPrimary(ownMediaTotalDoc, ethPrices)}</span></div>`
  if (collabMediaTotalDoc > 0n) {
    html += `<div class="vault-flow-line"><span>collab splits</span><span style="color:var(--green)">${formatPriceFiatPrimary(collabMediaTotalDoc, ethPrices)}</span></div>`
  }
  html += `<div class="vault-flow-line"><span>project payouts</span><span style="color:var(--green)">${formatPriceFiatPrimary(earned.projectEarnings + unclaimed.praxis, ethPrices)}</span></div>`
  html += `</div>`
  html += `<div class="vault-flow-col">`
  html += `<div class="vault-flow-label">outflow</div>`
  html += `<div class="vault-flow-line"><span>projects funded</span><span>${formatPriceFiatPrimary(contributed.fundingTotal, ethPrices)}</span></div>`
  html += `<div class="vault-flow-line"><span>media collected</span><span>${formatPriceFiatPrimary(contributed.purchaseTotal, ethPrices)}</span></div>`
  html += `</div>`
  html += `</div>`

  // Activity — bounded scroll, borderless. It's a timeline, not a panel.
  if (_allHistory.length > 0) {
    const firstPage = _allHistory.slice(0, HISTORY_PAGE_SIZE)
    _historyShown = firstPage.length
    html += `<div class="vault-activity-label">recent activity</div>`
    html += `<div id="vault-history-wrap" class="vault-history vault-history-inline"><div id="vault-history">${renderHistoryItems(firstPage, ethPrices)}</div></div>`
  }
  html += `</section>`

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
  document.getElementById('vault-fund-btn')?.addEventListener('click', async () => {
    try {
      const { showFundingSheet } = await import('./pay.js')
      await showFundingSheet(addr, 0n)
      window.dispatchEvent(new CustomEvent('wallet-balance-changed'))
    } catch (e) { console.warn('fund sheet error:', e) }
  })
  document.getElementById('vault-cashout-btn')?.addEventListener('click', () => {
    window.location.href = '/cashout'
  })

  // Receive button
  document.getElementById('vault-receive-btn')?.addEventListener('click', () => showReceiveModal(addr))

  // Save/Swap button
  const swapHandler = () => showSwapModal(addr, ethBalance, ethPrices, currency, yieldData, chainBalances)
  document.getElementById('vault-swap-btn')?.addEventListener('click', swapHandler)
  document.getElementById('vault-save-btn')?.addEventListener('click', swapHandler)

  // Total-balance ↔ chain breakdown toggle. Click the big number to
  // expand a small chain-by-chain composition inline.
  document.getElementById('vault-lead-toggle')?.addEventListener('click', (e) => {
    const panel = document.getElementById('vault-lead-breakdown')
    const btn = e.currentTarget
    if (!panel) return
    const open = !panel.hidden
    panel.hidden = open
    btn.setAttribute('aria-expanded', String(!open))
    btn.classList.toggle('vault-lead-toggle-open', !open)
  })

  // "how BOLD savings work" toggle — progressive disclosure of mechanics.
  document.getElementById('savings-how-toggle')?.addEventListener('click', (e) => {
    const panel = document.getElementById('savings-how')
    const btn = e.currentTarget
    if (!panel) return
    const open = !panel.hidden
    panel.hidden = open
    btn.setAttribute('aria-expanded', String(!open))
    btn.textContent = open ? 'how this works ↓' : 'how this works ↑'
  })

  // Claim buttons
  el.querySelectorAll('.earnings-claim-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const status = document.getElementById('earnings-claim-status')
      btn.textContent = 'claiming...'
      btn.disabled = true
      try {
        const pc = await getPublicClient()
        const claimAccount = await window.authorizedSigner?.(addr)
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
  overlay.className = 'praxis-modal-overlay vault-save-overlay'
  overlay.style.zIndex = '10002'

  let qrHtml = ''
  try {
    const { generateQR } = await import('./qr.js')
    qrHtml = `<div class="vault-recv-qr">${generateQR(addr)}</div>`
  } catch (e) { console.warn('QR generation failed:', e) }

  overlay.innerHTML = `
    <button class="wizard-close vault-save-close" aria-label="close">×</button>
    <div class="vault-save-doc">
      <header class="vault-save-lead">
        <div class="vault-save-lead-title"><h1>receive</h1></div>
        <div class="vault-save-lead-apr"><span style="color:var(--fg);font-size:0.95em;font-weight:400;letter-spacing:0;text-transform:none">Optimism</span></div>
      </header>
      <p class="vault-save-lead-sub">Anyone can send ETH or tokens to this address on Optimism. Scan the QR from another wallet or copy the address.</p>

      <section class="vault-save-doc-body">
        ${qrHtml}
        <div>
          <div class="vault-save-field-label">your address</div>
          <div class="vault-recv-addr">${escapeHtml(addr)}</div>
        </div>
        <div class="vault-save-actions">
          <button id="vault-copy-addr" type="button" class="vault-save-btn"><i class="ph ph-copy"></i> copy address</button>
        </div>
      </section>
    </div>
  `
  document.body.appendChild(overlay)
  overlay.querySelector('.vault-save-close')?.addEventListener('click', () => overlay.remove())
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
  overlay.querySelector('#vault-copy-addr').addEventListener('click', async () => {
    await navigator.clipboard.writeText(addr)
    const btn = overlay.querySelector('#vault-copy-addr')
    btn.innerHTML = '<i class="ph ph-check"></i> copied'
    btn.style.borderColor = 'var(--green)'
    btn.style.color = 'var(--green)'
    setTimeout(() => overlay.remove(), 1500)
  })
}

function showSwapModal(addr, ethBalance, ethPrices, currency, yieldData, chainBalances) {
  const existing = document.getElementById('vault-swap-modal')
  if (existing) { existing.remove(); return }
  const ethRate = ethPrices?.[currency] || 0
  const bestApy = yieldData?.bestApy || 0
  const pools = yieldData?.pools || []

  // Source-of-funds accordion. Rank the picker: the chain with the largest
  // balance goes first (highest signal), Optimism is always shown as the
  // home account even when empty, and everything with zero is hidden until
  // it holds funds so the list doesn't grow noisy over time.
  const chains = (chainBalances && chainBalances.length ? chainBalances : [{ chainId: 10, name: 'Optimism', balance: ethBalance }])
  const chainOrder = [...chains].sort((a, b) => {
    if (b.balance !== a.balance) return b.balance > a.balance ? 1 : -1
    return 0
  })
  const visibleChains = chainOrder.filter(c => c.balance > 0n || c.chainId === 10)
  let selectedChainId = (visibleChains.find(c => c.balance > 0n) || visibleChains[0]).chainId

  const overlay = document.createElement('div')
  overlay.id = 'vault-swap-modal'
  overlay.className = 'wizard-overlay vault-save-overlay'

  // Fallback: if /api/bold/yield is down, still offer the ETH pool so the
  // flow works. Uses the pinned STABILITY_POOLS.ETH address + a placeholder
  // APY the user can visually distinguish from a live-data card.
  const poolInput = (pools.length > 0 ? pools : [{
    collateral: 'ETH', apy: 0, apy7d: 0, tvl: 0,
  }])
  // Sort highest-APY first so the default selection is the best current yield.
  const sortedPools = [...poolInput].sort((a, b) => (b.apy || 0) - (a.apy || 0))
  const POOL_TAGLINES = {
    ETH: 'backed by ETH',
    wstETH: 'backed by staked ETH',
    rETH: 'backed by Rocket Pool ETH',
  }
  const poolCards = sortedPools.slice(0, 3).map((p, i) => {
    const spAddr = STABILITY_POOLS[p.collateral] || ''
    if (!spAddr) return ''
    const tvlStr = p.tvl >= 1e6 ? `$${(p.tvl / 1e6).toFixed(1)}M` : (p.tvl > 0 ? `$${(p.tvl / 1e3).toFixed(0)}K` : '—')
    const apyStr = p.apy > 0 ? `${p.apy.toFixed(1)}%` : '—'
    const apy7dStr = p.apy7d > 0 ? `30d avg ${p.apy7d.toFixed(1)}%` : (POOL_TAGLINES[p.collateral] || '')
    return `<label class="vault-pool-card${i === 0 ? ' vault-pool-card-selected' : ''}" data-sp="${spAddr}" data-name="${escapeHtml(p.collateral)} pool">
      <input type="radio" name="sp-pool" value="${spAddr}" ${i === 0 ? 'checked' : ''} style="position:absolute;opacity:0;pointer-events:none">
      <div class="vault-pool-card-top">
        <span class="vault-pool-card-name">${escapeHtml(p.collateral)} pool</span>
        <span class="vault-pool-card-apy">${apyStr}</span>
      </div>
      <div class="vault-pool-card-bottom">
        <span class="vault-pool-card-tvl">${tvlStr}${p.tvl > 0 ? ' TVL' : ''}</span>
        <span class="vault-pool-card-7d">${apy7dStr}</span>
      </div>
    </label>`
  }).filter(Boolean).join('')

  function chainFiat(bal) {
    return ethRate ? formatFiat(Number(bal) / 1e18 * ethRate, currency) : ''
  }
  function chainRowInner(c) {
    const eth = formatEthAmount(c.balance)
    const fiat = chainFiat(c.balance)
    const right = c.balance > 0n
      ? `<span class="vault-chain-bal">${eth} ETH${fiat ? ` · ${fiat}` : ''}</span>`
      : `<span class="vault-chain-bal vault-chain-bal-empty">${t('save.emptyChain') || 'no ETH'}</span>`
    return `<span class="vault-chain-icon">${ETH_ICON}</span><span class="vault-chain-name">${escapeHtml(c.name)}</span>${right}`
  }

  const canPickChain = visibleChains.length > 1
  const caretSvg = `<svg class="vault-caret" width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`
  const earningLine = bestApy > 0
    ? (t('save.earningLine') || 'Currently earning {apr}% APR').replace('{apr}', bestApy.toFixed(1))
    : ''

  overlay.innerHTML = `
    <button class="wizard-close vault-save-close" aria-label="close">×</button>
    <div class="vault-save-doc">
      <header class="vault-save-lead">
        <div class="vault-save-lead-title">
          <span class="vault-save-lead-mark">${BOLD_ICON}</span>
          <h1>${t('save.title') || 'save to BOLD'}</h1>
        </div>
        ${earningLine ? `<div class="vault-save-lead-apr" id="save-lead-apr" title="${earningLine}"><span id="save-lead-apr-value">${bestApy.toFixed(1)}%</span> APR</div>` : ''}
      </header>
      <p class="vault-save-lead-sub">
        ${t('save.explainer') || 'A dollar-stable savings account, backed by ETH. Earns yield when other people borrow against their ETH — Liquity pays the interest to you.'}
        <a class="vault-save-learnmore" href="https://liquity.org" target="_blank" rel="noopener">${t('save.learnMore') || 'learn more'} →</a>
      </p>

      <section class="vault-save-doc-body">
        <!-- FROM: which chain the funds come from -->
        <div class="vault-save-from vault-chain-picker${canPickChain ? '' : ' vault-chain-picker-static'}" id="chain-picker" aria-expanded="false">
          <div class="vault-save-field-label">${t('save.from') || 'from'}</div>
          <button type="button" class="vault-chain-row vault-chain-row-current" id="chain-current" ${canPickChain ? '' : 'disabled aria-disabled="true"'}></button>
          <div class="vault-chain-list" id="chain-list" hidden></div>
        </div>

        <!-- AMOUNT: the primary input, hero-sized -->
        <div class="vault-save-amount">
          <div class="vault-save-amount-head">
            <span class="vault-save-field-label">${t('save.amount') || 'amount'}</span>
            <div class="vault-presets" id="swap-presets"></div>
          </div>
          <div class="vault-save-amount-row">
            <input id="swap-amount" type="text" inputmode="decimal" placeholder="0.00" class="vault-save-amount-input" autocomplete="off">
            <div class="vault-save-amount-token">${ETH_ICON}<span>ETH</span></div>
          </div>
          <div class="vault-save-amount-foot">
            <span id="swap-fiat" class="vault-save-fiat">≈ $0.00</span>
            <span class="vault-save-amount-arrow" aria-hidden="true">→</span>
            <span id="swap-output" class="vault-save-output vault-save-output-empty">0.00</span>
            <span class="vault-save-amount-bold-mark">${BOLD_ICON}</span>
            <span>BOLD</span>
          </div>
          <div id="swap-rate" class="vault-save-rate">&nbsp;</div>
        </div>

        <!-- POOL: which stability pool the deposit goes into -->
        ${poolCards ? `
        <div class="vault-save-pools">
          <div class="vault-save-field-label">${t('save.pool') || 'earning yield in'}</div>
          <div class="vault-pool-cards vault-pool-cards-doc">${poolCards}</div>
        </div>` : ''}

        <!-- WHAT HAPPENS: progressive — only visible when amount > 0 -->
        <div class="vault-save-progress" id="swap-progress" hidden>
          <div class="vault-save-field-label">${t('save.happens') || 'what happens next'}</div>
          <ol class="vault-save-steps" id="swap-steps"></ol>
        </div>

        <!-- SUMMARY: progressive — only visible when amount > 0 -->
        <div class="vault-save-summary" id="swap-summary" hidden>
          <dl class="vault-summary-list">
            <div class="vault-summary-row">
              <dt>${t('save.summaryDeposit') || 'depositing'}</dt>
              <dd id="summary-deposit" class="vault-summary-val">—</dd>
            </div>
            <div class="vault-summary-row">
              <dt>${t('save.summaryGas') || 'network fee'} <span id="summary-gas-detail" class="vault-summary-sub"></span></dt>
              <dd id="summary-gas" class="vault-summary-val">—</dd>
            </div>
            <div class="vault-summary-row vault-summary-total">
              <dt>${t('save.summaryTotal') || 'from your wallet'}</dt>
              <dd id="summary-total" class="vault-summary-val">—</dd>
            </div>
          </dl>
        </div>

        <div class="vault-save-actions">
          <p class="vault-save-withdraw">${t('save.withdraw') || 'withdraw anytime · no lockup · no penalty'}</p>
          <button id="swap-confirm" class="vault-save-btn" disabled>${t('save.ctaNoAmount') || 'enter an amount'}</button>
          <div id="swap-status" class="vault-save-status"></div>
        </div>
      </section>
    </div>
  `
  document.body.appendChild(overlay)
  const dialog = overlay
  overlay.querySelector('.vault-save-close')?.addEventListener('click', () => overlay.remove())

  dialog.querySelectorAll('.vault-pool-card').forEach(card => {
    card.addEventListener('click', () => {
      dialog.querySelectorAll('.vault-pool-card').forEach(c => c.classList.remove('vault-pool-card-selected'))
      card.classList.add('vault-pool-card-selected')
      card.querySelector('input').checked = true
      // Sync the header APR to the pool the user just picked — the
      // number they read at the top matches the rate they'll actually
      // earn on the deposit they're about to make.
      const apyText = card.querySelector('.vault-pool-card-apy')?.textContent?.trim()
      const headerApr = dialog.querySelector('#save-lead-apr-value')
      if (apyText && headerApr) headerApr.textContent = apyText
      renderCta()
    })
  })

  const swapInput = dialog.querySelector('#swap-amount')
  const swapFiat = dialog.querySelector('#swap-fiat')
  const outputEl = dialog.querySelector('#swap-output')
  const rateEl = dialog.querySelector('#swap-rate')
  const confirmBtn = dialog.querySelector('#swap-confirm')
  const statusEl = dialog.querySelector('#swap-status')
  const stepsEl = dialog.querySelector('#swap-steps')
  const presetsEl = dialog.querySelector('#swap-presets')
  const chainCurrent = dialog.querySelector('#chain-current')
  const chainList = dialog.querySelector('#chain-list')
  const chainPicker = dialog.querySelector('#chain-picker')

  function currentChain() {
    return chains.find(c => c.chainId === selectedChainId) || chains[0]
  }
  function renderChainCurrent() {
    const c = currentChain()
    const canExpand = visibleChains.length > 1
    chainCurrent.innerHTML = `${chainRowInner(c)}${canExpand ? `<span class="vault-chain-chev">${caretSvg}</span>` : ''}`
    chainCurrent.disabled = !canExpand
  }
  function renderChainList() {
    chainList.innerHTML = visibleChains.map(c => `
      <button type="button" class="vault-chain-row${c.chainId === selectedChainId ? ' vault-chain-row-selected' : ''}" data-chain="${c.chainId}">
        ${chainRowInner(c)}
        ${c.chainId === selectedChainId ? '<span class="vault-chain-check">✓</span>' : ''}
      </button>
    `).join('')
    chainList.querySelectorAll('[data-chain]').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedChainId = parseInt(btn.dataset.chain)
        collapseChainList()
        renderChainCurrent()
        renderPresets()
        renderSteps()
        renderSummary()
        renderCta()
        // clear any stale quote/amount, then refresh reserve for the new chain
        swapInput.value = ''
        swapInput.dispatchEvent(new Event('input'))
        refreshChainReserve()
      })
    })
  }
  function expandChainList() {
    if (visibleChains.length <= 1) return
    renderChainList()
    chainList.hidden = false
    chainPicker.setAttribute('aria-expanded', 'true')
  }
  function collapseChainList() {
    chainList.hidden = true
    chainPicker.setAttribute('aria-expanded', 'false')
  }
  chainCurrent.addEventListener('click', () => {
    if (chainList.hidden) expandChainList()
    else collapseChainList()
  })
  // Click outside the picker also collapses it — so a chain pick that
  // somehow doesn't fire the row click at least closes cleanly.
  dialog.addEventListener('click', (e) => {
    if (chainList.hidden) return
    if (!chainPicker.contains(e.target)) collapseChainList()
  })

  // Cache gas reserve + breakdown per chain — fetched lazily on first
  // selection and whenever the user picks a new source, so presets, max,
  // and the summary panel always reflect what the network will actually
  // allow the sender to keep.
  const _gasReserves = new Map()
  const _gasBreakdowns = new Map()
  let _pendingReserveChain = null
  async function ensureGasReserve(chainId) {
    if (_gasReserves.has(chainId)) return _gasReserves.get(chainId)
    _pendingReserveChain = chainId
    const bd = await computeGasBreakdown(chainId)
    if (_pendingReserveChain === chainId) {
      _gasReserves.set(chainId, bd.reserve)
      _gasBreakdowns.set(chainId, bd)
    }
    return bd.reserve
  }
  function usableFor(c) {
    const reserve = _gasReserves.get(c.chainId)
    if (reserve == null) return c.balance // optimistic until reserve arrives
    return c.balance > reserve ? c.balance - reserve : 0n
  }
  function renderPresets() {
    const c = currentChain()
    const usable = Number(usableFor(c)) / 1e18
    presetsEl.innerHTML = [25, 50, 75, 100].map(pct => {
      const amt = Math.max(0, usable * pct / 100)
      return `<button type="button" class="vault-preset" data-amount="${amt.toFixed(6)}" ${usable <= 0 ? 'disabled' : ''}>${pct === 100 ? 'max' : pct + '%'}</button>`
    }).join('')
    presetsEl.querySelectorAll('.vault-preset').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.disabled) return
        swapInput.value = parseFloat(btn.dataset.amount).toFixed(6)
        swapInput.dispatchEvent(new Event('input'))
      })
    })
  }
  async function refreshChainReserve() {
    const c = currentChain()
    await ensureGasReserve(c.chainId)
    renderPresets()
    renderSummary()
    // If the current input now exceeds the usable balance, revalidate the CTA.
    renderCta()
  }

  function fiatFor(wei) {
    if (!ethRate || wei == null) return null
    return Number(wei) / 1e18 * ethRate
  }
  function ethStr(wei) {
    return `${formatEthAmount(wei)} ETH`
  }
  function feeStr(wei) {
    const fiat = fiatFor(wei)
    return fiat != null ? `~${formatFiat(fiat, currency)}` : `~${ethStr(wei)}`
  }
  function renderSummary() {
    const summary = dialog.querySelector('#swap-summary')
    const depositEl = summary?.querySelector('#summary-deposit')
    const gasEl = summary?.querySelector('#summary-gas')
    const gasDetailEl = summary?.querySelector('#summary-gas-detail')
    const totalEl = summary?.querySelector('#summary-total')
    if (!depositEl) return
    const c = currentChain()
    const val = parseFloat(swapInput.value) || 0
    let depositWei = 0n
    try { depositWei = val > 0 ? parseEther(val.toFixed(18)) : 0n } catch { depositWei = 0n }
    const reserve = _gasReserves.get(c.chainId) || 0n
    const bd = _gasBreakdowns.get(c.chainId)
    const estFee = bd?.estimated || reserve
    // "Deposit" row — what actually goes into BOLD (may be estimated).
    if (val > 0) {
      const fiatBold = ethRate ? formatFiat(val * ethRate, currency) : ''
      depositEl.textContent = fiatBold ? `${fiatBold} · ${formatEthAmount(depositWei)} ETH` : `${formatEthAmount(depositWei)} ETH`
      depositEl.classList.remove('vault-summary-val-empty')
    } else {
      depositEl.textContent = t('save.summaryPlaceholder') || 'Enter an amount above'
      depositEl.classList.add('vault-summary-val-empty')
    }
    // "Network fee" row + gwei detail
    gasEl.textContent = feeStr(estFee)
    if (bd?.gasPrice && bd.gasPrice > 0n) {
      const gwei = Number(bd.gasPrice) / 1e9
      const gweiStr = gwei >= 1 ? gwei.toFixed(1) : gwei.toFixed(3)
      gasDetailEl.textContent = ` · ${c.name} · ${gweiStr} gwei`
    } else {
      gasDetailEl.textContent = ` · ${c.name}`
    }
    // "From wallet" — deposit + fee
    const total = depositWei + estFee
    totalEl.textContent = val > 0 ? feeStr(total).replace('~', '') : '—'
    if (val <= 0) totalEl.classList.add('vault-summary-val-empty')
    else totalEl.classList.remove('vault-summary-val-empty')
  }

  function renderSteps() {
    const isMainnet = selectedChainId === 1
    const selectedPoolName = dialog.querySelector('.vault-pool-card-selected')?.dataset.name || 'pool'
    const steps = []
    if (!isMainnet) steps.push({ key: 'bridge', label: t('save.stepBridge') || 'Move ETH to Ethereum' })
    steps.push({ key: 'swap', label: t('save.stepSwap') || 'Convert ETH to BOLD' })
    steps.push({ key: 'deposit', label: (t('save.stepDeposit') || 'Deposit into {pool}').replace('{pool}', selectedPoolName) })
    stepsEl.innerHTML = steps.map((s, i) => `
      <li class="vault-save-step" data-step="${s.key}">
        <span class="vault-save-step-idx">${i + 1}</span>
        <span class="vault-save-step-label">${s.label}</span>
      </li>
    `).join('')
  }

  function markStep(step, state) {
    const el = stepsEl?.querySelector(`[data-step="${step}"]`)
    if (!el) return
    el.className = 'vault-save-step'
    if (state) el.classList.add(`vault-save-step-${state}`)
  }

  function renderCta() {
    const val = parseFloat(swapInput.value)
    // Progressive disclosure: reveal steps + summary only once the user
    // has committed to an amount. Empty state = clean.
    const hasAmt = !!val && !isNaN(val) && val > 0
    const progressEl = dialog.querySelector('#swap-progress')
    const summaryEl = dialog.querySelector('#swap-summary')
    if (progressEl) progressEl.hidden = !hasAmt
    if (summaryEl) summaryEl.hidden = !hasAmt
    // Clear any stale inline warning by default; specific branches re-set it.
    statusEl.textContent = ''
    statusEl.style.color = 'var(--muted)'
    if (!hasAmt) {
      confirmBtn.disabled = true
      confirmBtn.textContent = t('save.ctaNoAmount') || 'enter an amount'
      return
    }
    // Guard against amounts that would leave the sender unable to pay gas.
    const c = currentChain()
    const usable = usableFor(c)
    const usableEth = Number(usable) / 1e18
    if (val > usableEth + 1e-9) {
      confirmBtn.disabled = true
      confirmBtn.textContent = t('save.ctaOverBalance') || 'Amount exceeds usable balance'
      const reserve = _gasReserves.get(c.chainId)
      if (reserve != null && reserve > 0n) {
        const reserveEth = Number(reserve) / 1e18
        statusEl.style.color = 'var(--dim)'
        statusEl.textContent = (t('save.gasReserve') || 'Leaving ~{eth} ETH for network fees on {chain}')
          .replace('{eth}', reserveEth.toFixed(6))
          .replace('{chain}', c.name)
      }
      return
    }
    if (!_lastQuote) {
      confirmBtn.disabled = true
      confirmBtn.textContent = t('save.ctaQuoting') || 'Getting rate…'
      return
    }
    const poolName = dialog.querySelector('.vault-pool-card-selected')?.dataset.name || 'pool'
    const fiat = ethRate ? formatFiat(val * ethRate, currency) : `${val} ETH`
    confirmBtn.disabled = false
    confirmBtn.textContent = (t('save.cta') || 'Save {amount} to {pool}')
      .replace('{amount}', fiat)
      .replace('{pool}', poolName)
  }

  let _quoteTimer = null
  let _lastQuote = null

  // Initial paint of dynamic sections
  renderChainCurrent()
  renderPresets()
  renderSteps()
  renderSummary()
  // Kick off a gas-price fetch so presets settle on the real usable balance.
  refreshChainReserve()

  function setOutput(text, empty) {
    outputEl.textContent = text
    outputEl.classList.toggle('vault-save-output-empty', !!empty)
  }
  function setRate(text) {
    rateEl.innerHTML = text || '&nbsp;'
  }

  swapInput.addEventListener('input', () => {
    const val = parseFloat(swapInput.value)
    renderSummary()
    if (!val || isNaN(val) || val <= 0) {
      swapFiat.textContent = ethRate ? `≈ ${formatFiat(0, currency)}` : ''
      setOutput('0.00', true)
      setRate('')
      _lastQuote = null
      renderCta()
      return
    }
    if (ethRate) swapFiat.textContent = `≈ ${formatFiat(val * ethRate, currency)}`

    clearTimeout(_quoteTimer)
    setOutput('…', true)
    setRate('')
    _lastQuote = null
    renderCta()

    _quoteTimer = setTimeout(async () => {
      try {
        const amountIn = parseEther(val.toFixed(18))
        const uniQuote = await getUniswapBoldQuote(amountIn)
        const boldOut = Number(uniQuote.amountOut) / 1e18

        _lastQuote = { amountIn, boldOut, path: uniQuote.path }
        setOutput(boldOut.toFixed(2), false)
        const rate = boldOut / val
        setRate((t('save.rate') || '1 ETH ≈ {amount} BOLD').replace('{amount}', rate.toFixed(2)))
        renderCta()
      } catch (e) {
        console.warn('quote error:', e)
        if (ethRate) {
          const est = val * ethRate
          _lastQuote = { amountIn: parseEther(val.toFixed(18)), boldOut: est, path: null }
          setOutput(`≈ ${est.toFixed(2)}`, false)
          setRate(t('save.estimate') || 'estimate — rate updates each quote')
          renderCta()
        } else {
          setOutput('0.00', true)
          setRate('')
          _lastQuote = null
          confirmBtn.disabled = true
          confirmBtn.textContent = t('save.noRoute') || 'no route available'
        }
      }
    }, 600)
  })

  confirmBtn.addEventListener('click', async () => {
    if (!_lastQuote) return
    const { amountIn } = _lastQuote
    const selectedPool = dialog.querySelector('input[name="sp-pool"]:checked')?.value
    const isMainnet = selectedChainId === 1
    confirmBtn.disabled = true
    swapInput.disabled = true
    chainCurrent.disabled = true
    statusEl.textContent = ''
    statusEl.style.color = 'var(--muted)'
    confirmBtn.textContent = t('save.ctaWorking') || 'Saving…'

    try {
      // Ensure the embedded wallet is unlocked before any funds move —
      // failing mid-flow after the bridge already ran is unrecoverable.
      await window.ensureAuthorized?.()

      let bridgedAmount = 0n
      if (!isMainnet) {
        markStep('bridge', 'active')
        await executeBridge(selectedChainId, addr, amountIn, (msg) => { statusEl.textContent = msg })
        // Poll mainnet balance until the bridge lands (up to 15 min).
        // The old 5-second sleep dropped straight into the swap, which
        // then threw "insufficient ETH on Ethereum after bridge".
        bridgedAmount = await waitForBridgedFunds(addr, amountIn, (msg) => { statusEl.textContent = msg })
        markStep('bridge', 'done')
      } else {
        // Source is already mainnet — the "bridged amount" is just what
        // the user asked to swap; cap swapAmount at that.
        bridgedAmount = amountIn
      }

      markStep('swap', 'active')
      const { amountOut: boldReceived } = await swapEthToBold(
        addr, _lastQuote.path, (msg) => { statusEl.textContent = msg }, bridgedAmount,
      )
      markStep('swap', 'done')

      if (selectedPool) {
        markStep('deposit', 'active')
        if (boldReceived > 0n) {
          // Use the exact swap output, NOT the wallet balance — that
          // would (a) miss the deposit under RPC read-after-write lag
          // and (b) sweep pre-existing liquid BOLD.
          await depositToStabilityPool(selectedPool, boldReceived, addr, (msg) => { statusEl.textContent = msg })
          markStep('deposit', 'done')
        } else {
          statusEl.textContent = 'BOLD arriving — deposit manually when ready'
          markStep('deposit', 'done')
        }
      } else {
        markStep('deposit', 'done')
      }

      confirmBtn.textContent = t('save.done') || 'Deposited — earning yield'
      confirmBtn.classList.add('vault-save-btn-done')
      statusEl.style.color = 'var(--green)'
      statusEl.textContent = selectedPool ? (t('save.done') || 'Deposited — earning yield') : (t('save.doneNoPool') || 'BOLD received — ready to deposit')
      window.dispatchEvent(new CustomEvent('wallet-balance-changed'))
      setTimeout(() => overlay.remove(), 4000)
    } catch (e) {
      const failedStep = stepsEl?.querySelector('.vault-save-step-active')
      if (failedStep) failedStep.className = 'vault-save-step vault-save-step-error'
      swapInput.disabled = false
      chainCurrent.disabled = visibleChains.length <= 1
      confirmBtn.disabled = false
      confirmBtn.textContent = t('save.retry') || 'Try again'
      statusEl.style.color = 'var(--dim)'
      const msg = (e?.message || e?.shortMessage || '').toString()
      if (e?.code === 4001) {
        statusEl.textContent = t('save.cancelled') || 'Cancelled'
      } else if (/exceeds the balance|insufficient funds|gas.*exceeds/i.test(msg)) {
        // Live gas ate more than the sender's balance could cover. Invalidate
        // the cached reserve so the next preset pick reflects the new price,
        // and nudge the user to a smaller amount.
        _gasReserves.delete(selectedChainId)
        refreshChainReserve()
        statusEl.style.color = 'var(--muted)'
        statusEl.textContent = t('save.gasBlown') || 'Network fees have spiked — pick a smaller amount and try again.'
      } else {
        statusEl.textContent = formatTxError(e)
      }
    }
  })
}

export async function showSendModal(fromAddress) {
  const existing = document.getElementById('send-modal-overlay')
  if (existing) { existing.remove(); return }

  // Full-screen doc modal — matches save-to-BOLD. Same pattern across the
  // app for every money action: the modal IS a page, not a floating card,
  // so mobile keyboards + focus don't fight it.
  const overlay = document.createElement('div')
  overlay.id = 'send-modal-overlay'
  overlay.className = 'praxis-modal-overlay vault-save-overlay'
  overlay.style.zIndex = '10002'

  const balance = await getCachedBalance(fromAddress).catch(() => 0n)
  const balEth = formatEthAmount(balance)
  const ethBal = Number(balance) / 1e18
  let prices = await getEthPrices().catch(() => null)
  const currency = getUserCurrency()
  const ethRate = prices?.[currency] || 0
  const balFiat = ethRate ? formatFiat(ethBal * ethRate, currency) : ''

  const presets = [25, 50, 75, 100].map(pct => {
    const amt = Math.max(0, ethBal * pct / 100 - (pct === 100 ? 0.0005 : 0))
    return `<button type="button" class="vault-preset" data-amount="${amt.toFixed(6)}">${pct === 100 ? 'max' : pct + '%'}</button>`
  }).join('')

  overlay.innerHTML = `
    <button class="wizard-close vault-save-close" aria-label="close">×</button>
    <div class="vault-save-doc">
      <header class="vault-save-lead">
        <div class="vault-save-lead-title">
          <h1>send</h1>
        </div>
        <div class="vault-save-lead-apr" style="color:var(--dim);text-transform:uppercase;letter-spacing:0.14em;font-size:0.72em"><span style="color:var(--fg);font-size:0.95em;font-weight:400;letter-spacing:0;text-transform:none">Optimism</span></div>
      </header>
      <p class="vault-save-lead-sub">Send ETH to another wallet — by handle, ENS-style domain, or 0x address. Sends over Optimism (fast + cheap).</p>

      <section class="vault-save-doc-body">
        <div>
          <div class="vault-save-field-label">to</div>
          <input id="send-to" type="text" placeholder="handle, ourpraxis.network domain, or 0x…" class="vault-save-to-input" autocomplete="off">
          <div id="send-resolved" class="vault-save-rate">&nbsp;</div>
        </div>

        <div class="vault-save-amount">
          <div class="vault-save-amount-head">
            <span class="vault-save-field-label">amount</span>
            <span class="vault-save-bal">${balEth} ETH${balFiat ? ' · ' + balFiat : ''}</span>
          </div>
          <div class="vault-save-amount-row">
            <input id="send-amount" type="text" inputmode="decimal" placeholder="0.00" class="vault-save-amount-input" autocomplete="off">
            <div class="vault-save-amount-token">${ETH_ICON}<span>ETH</span></div>
          </div>
          <div class="vault-save-amount-foot">
            <span id="send-fiat" class="vault-save-fiat">≈ ${ethRate ? formatFiat(0, currency) : '$0.00'}</span>
            <span style="flex:1"></span>
            <div class="vault-presets">${presets}</div>
          </div>
        </div>

        <div class="vault-save-actions">
          <button id="send-confirm" class="vault-save-btn">send</button>
          <div id="send-status" class="vault-save-status"></div>
        </div>
      </section>
    </div>
  `
  document.body.appendChild(overlay)
  const dialog = overlay
  overlay.querySelector('.vault-save-close')?.addEventListener('click', () => overlay.remove())
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
        account: window.getEmbeddedAccount?.() || fromAddress,
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
