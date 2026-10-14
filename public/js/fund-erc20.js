// ERC20 project funding — client flow.
//
// Dispatches fundTier() against Praxis.sol based on the project's
// chosen fundingToken (address(0) = ETH, else an ERC20). Picks the
// cheapest signing path available:
//
//   1. ETH project         → one tx, msg.value = cost.
//   2. ERC20 w/ EIP-2612   → one tx, permit + fundTierWithPermit.
//   3. ERC20 w/o permit    → two tx, approve + fundTier.
//
// The whitelist here mirrors docs/erc20-funding.md §Launch whitelist.
// Server-side token metadata (/api/token-metadata, /api/token-price)
// is used for display and conversion; this file only cares about the
// write path.

import { PRAXIS_ABI, PRAXIS_ADDR } from './contracts.js'
import { getWalletClient, getPublicClient, getWalletProvider, ensureWallet } from './utils.js'

// Day-1 whitelist. Launch tokens live on Optimism (chain 10). To add
// a token here you also need (a) server token-metadata to recognise
// it and (b) a Stripe fulfillment path (Fork E) that can swap USDC
// into it. Not expected to grow without coordinated change.
export const FUNDING_TOKENS = [
  // supportsPermit is false everywhere until PraxisExtensions grows a
  // permit-based fund wrapper (v2). v1 contract has no fundTierWithPermit.
  { address: '0x03569CC076654F82679C4BA2124D64774781B01D', symbol: 'BOLD', decimals: 18, chain: 10, supportsPermit: false, recommended: true  },
  { address: '0x0000000000000000000000000000000000000000', symbol: 'ETH',  decimals: 18, chain: 10, supportsPermit: false, recommended: false },
  { address: '0x4F13a96EC5C4Cf34e442b46Bbd98a0791F20edC3', symbol: 'USDS', decimals: 18, chain: 10, supportsPermit: false, recommended: false },
]

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

// Minimal ERC20 ABI — balanceOf, allowance, approve.
const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: '', type: 'address' }, { name: '', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve',   stateMutability: 'nonpayable', inputs: [{ name: '', type: 'address' }, { name: '', type: 'uint256' }], outputs: [{ type: 'bool' }] },
]

// Optimism Uniswap V3 for ETH→token top-up swaps. SwapRouter02 and QuoterV2
// are deterministic across EVM chains, so the same addresses that work on
// mainnet work here. WETH on Optimism is the canonical pre-deployed wrapper.
const WETH_OPTIMISM = '0x4200000000000000000000000000000000000006'
const USDC_OPTIMISM = '0x0b2c639c533813f4aa9d7837caf62653d097ff85'
const UNISWAP_ROUTER_OP = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45' // SwapRouter02
const UNISWAP_QUOTER_OP = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e' // QuoterV2
const UNISWAP_FEE_TIERS = [500, 3000, 10000]
const UNISWAP_ROUTER_ABI = [{
  type: 'function', name: 'exactInput', stateMutability: 'payable',
  inputs: [{ type: 'tuple', components: [
    { name: 'path', type: 'bytes' },
    { name: 'recipient', type: 'address' },
    { name: 'amountIn', type: 'uint256' },
    { name: 'amountOutMinimum', type: 'uint256' },
  ]}], outputs: [{ type: 'uint256' }],
}]
const UNISWAP_QUOTER_ABI = [{
  type: 'function', name: 'quoteExactInput', stateMutability: 'nonpayable',
  inputs: [{ name: 'path', type: 'bytes' }, { name: 'amountIn', type: 'uint256' }],
  outputs: [
    { name: 'amountOut', type: 'uint256' },
    { name: 'sqrtPriceX96AfterList', type: 'uint160[]' },
    { name: 'initializedTicksCrossedList', type: 'uint32[]' },
    { name: 'gasEstimate', type: 'uint256' },
  ],
}]

function _encodeV3Path(tokens, fees) {
  if (tokens.length !== fees.length + 1) throw new Error('v3 path mismatch')
  let p = '0x'
  for (let i = 0; i < fees.length; i++) {
    p += tokens[i].slice(2).padStart(40, '0').toLowerCase()
    p += fees[i].toString(16).padStart(6, '0')
  }
  p += tokens[tokens.length - 1].slice(2).padStart(40, '0').toLowerCase()
  return p
}

// Quote ETH-in → amount-out of destToken via Uniswap V3 on Optimism.
// Tries direct WETH/destToken at each fee tier, then WETH→USDC→destToken
// multi-hop. Returns {amountOut, path} for the best quote, or null if
// no route exists.
async function _quoteEthToToken(pc, ethAmount, destToken) {
  let best = null
  const tryQuote = async (path) => {
    try {
      const { result } = await pc.simulateContract({
        address: UNISWAP_QUOTER_OP, abi: UNISWAP_QUOTER_ABI,
        functionName: 'quoteExactInput', args: [path, ethAmount],
      })
      const amountOut = result[0]
      if (amountOut > 0n && (!best || amountOut > best.amountOut)) {
        best = { amountOut, path }
      }
    } catch { /* no pool at this fee tier */ }
  }
  // Direct WETH→destToken
  for (const fee of UNISWAP_FEE_TIERS) {
    await tryQuote(_encodeV3Path([WETH_OPTIMISM, destToken], [fee]))
  }
  // Multi-hop WETH→USDC→destToken (common for BOLD/USDS which pair with USDC)
  for (const fee1 of UNISWAP_FEE_TIERS) {
    for (const fee2 of UNISWAP_FEE_TIERS) {
      await tryQuote(_encodeV3Path([WETH_OPTIMISM, USDC_OPTIMISM, destToken], [fee1, fee2]))
    }
  }
  return best
}

// Swap ETH on Optimism for `destToken`, aiming to produce at least
// `tokenNeeded` of it after a 5% slippage buffer. Returns the actual
// tokenOut delta (snapshot before/after balanceOf) so the caller can
// confirm the top-up produced enough to fund.
async function _swapEthToTokenOptimism(user, tokenNeeded, destToken, onStatus) {
  const wallet = await getWalletClient()
  const pc = await getPublicClient()

  // Reverse-estimate: start from a generous ETH amount (user's balance minus gas)
  // and quote forward. Keep raising until the quote covers tokenNeeded + slippage.
  const ethBal = await pc.getBalance({ address: user })
  const gasReserve = 500_000n * 10n ** 6n // 500k gas @ 1 gwei L2 ≈ cheap on OP
  const maxSpendable = ethBal > gasReserve ? ethBal - gasReserve : 0n
  if (maxSpendable === 0n) throw new Error('insufficient ETH on Optimism for gas')

  await _onStatus(onStatus, 'quoting swap…')
  // Try the full spendable amount first; the resulting quote tells us how
  // much destToken we'd get. If it's much more than tokenNeeded, scale down
  // proportionally. One re-quote is enough because Uniswap v3 is close to
  // linear for small-to-moderate swaps against the current tick.
  let quote = await _quoteEthToToken(pc, maxSpendable, destToken)
  if (!quote) throw new Error('no Uniswap V3 route for ETH→token on Optimism')

  const neededWithBuffer = tokenNeeded * 105n / 100n // 5% slippage headroom
  if (quote.amountOut < neededWithBuffer) {
    throw new Error(`insufficient ETH to swap for ${tokenNeeded} token (quote: ${quote.amountOut}, need: ${neededWithBuffer})`)
  }

  // Scale ETH-in down to roughly what's required (plus 5% headroom).
  const ethIn = (maxSpendable * neededWithBuffer) / quote.amountOut
  const requote = await _quoteEthToToken(pc, ethIn, destToken)
  const effective = requote || quote
  const minOut = effective.amountOut * 95n / 100n

  await _onStatus(onStatus, 'confirm swap…')
  const hash = await wallet.writeContract({
    address: UNISWAP_ROUTER_OP, abi: UNISWAP_ROUTER_ABI, functionName: 'exactInput',
    args: [{ path: effective.path, recipient: user, amountIn: ethIn, amountOutMinimum: minOut }],
    value: ethIn,
  })
  await _onStatus(onStatus, 'swap submitted…')
  await pc.waitForTransactionReceipt({ hash, timeout: 180_000 })
  await _onStatus(onStatus, 'swap complete')
  return { hash }
}

// Ensure the user holds at least `cost` of `token` on Optimism. If not,
// tries to top up by swapping ETH→token on Optimism; if ETH is also
// insufficient, throws a NEEDS_STRIPE error so the caller can route the
// user through the card onramp. Returns silently when the balance is
// adequate (either already or after the swap).
export async function ensureTokenBalance(user, token, cost, onStatus) {
  if (isEthFunding(token)) return // handled by the ETH ensureFundsForPurchase path

  const pc = await getPublicClient()
  const bal = await pc.readContract({
    address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [user],
  }).catch(() => 0n)
  if (bal >= cost) return

  const needed = cost - bal
  await _onStatus(onStatus, `topping up ${needed} token units…`)
  try {
    await _swapEthToTokenOptimism(user, needed, token, onStatus)
  } catch (e) {
    // Mark the error so the caller can decide whether to open the Stripe flow.
    const err = new Error(`NEEDS_STRIPE: ${e.message || e}`)
    err.code = 'NEEDS_STRIPE'
    err.shortfall = needed
    throw err
  }

  // Verify the swap actually produced enough.
  const after = await pc.readContract({
    address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [user],
  }).catch(() => 0n)
  if (after < cost) {
    const err = new Error(`NEEDS_STRIPE: swap produced ${after - bal}, needed ${needed}`)
    err.code = 'NEEDS_STRIPE'
    err.shortfall = cost - after
    throw err
  }
}

export function findFundingToken(address) {
  const lower = String(address || '').toLowerCase()
  return FUNDING_TOKENS.find(t => t.address.toLowerCase() === lower) || null
}

export function isEthFunding(address) {
  return !address || String(address).toLowerCase() === ZERO_ADDRESS
}

// Fetch cached token metadata from the server. Falls back to a
// whitelist lookup if the endpoint is unreachable — the whitelist
// carries decimals + symbol for every token we support at launch.
export async function getTokenMetadata(address) {
  if (isEthFunding(address)) return { symbol: 'ETH', decimals: 18, name: 'Ether' }
  try {
    const res = await fetch(`/api/token-metadata?address=${encodeURIComponent(address)}`)
    if (res.ok) {
      const d = await res.json()
      if (d && d.symbol && Number.isFinite(d.decimals)) return d
    }
  } catch {}
  const wl = findFundingToken(address)
  if (wl) return { symbol: wl.symbol, decimals: wl.decimals, name: wl.symbol }
  return { symbol: '???', decimals: 18, name: 'unknown token' }
}

// Fetch the token→fiat conversion rate the propose form uses to
// translate the user's fiat-typed tier price into on-chain base
// units. Shape mirrors Fork D's upcoming /api/token-price endpoint;
// until that lands this is a soft fallback: stable tokens round to
// 1.00 in the user's currency, ETH goes through the existing
// getEthPrices path.
export async function getTokenFiatRate(address, currency) {
  const cur = (currency || 'usd').toLowerCase()
  try {
    const res = await fetch(`/api/token-price?token=${encodeURIComponent(address || ZERO_ADDRESS)}&currency=${encodeURIComponent(cur)}`)
    if (res.ok) {
      const d = await res.json()
      if (d && Number.isFinite(d.price) && d.price > 0) return d.price
    }
  } catch {}
  // Fallback while /api/token-price doesn't exist yet
  if (isEthFunding(address)) {
    const { getEthPrices } = await import('./fiat.js')
    const p = await getEthPrices()
    return p?.[cur] || 0
  }
  // BOLD + USDS: approximate to 1.00 in USD for USD users; non-USD
  // users will get stale rates until Fork D ships.
  const wl = findFundingToken(address)
  if (wl && (wl.symbol === 'BOLD' || wl.symbol === 'USDS') && cur === 'usd') return 1.0
  return 0
}

// Convert a fiat amount (as number, in user currency) to the token's
// smallest unit (bigint). Rounds to half-away-from-zero to avoid the
// 1-wei dust parseEther creates on repeating decimals.
export function fiatToTokenBaseUnit(fiatAmount, rate, decimals) {
  if (!rate || !Number.isFinite(rate) || rate <= 0) throw new Error('invalid rate')
  if (!Number.isFinite(fiatAmount) || fiatAmount < 0) throw new Error('invalid fiat amount')
  const tokenAmount = fiatAmount / rate // e.g. 100 USD / 2500 ETH-per-USD = 0.04 ETH
  const factor = 10 ** decimals
  return BigInt(Math.round(tokenAmount * factor))
}

// --- Fund path ---------------------------------------------------

async function _getPraxisAddress() {
  // PRAXIS_ADDR is the exported constant on Optimism. If a tenant
  // overrides it (test/local) we honour the override; otherwise fall
  // back to the compiled constant.
  return (globalThis.PRAXIS_HUB_OVERRIDE || PRAXIS_ADDR)
}

async function _onStatus(cb, msg) { try { cb && cb(msg) } catch {} }

/**
 * Fund one tier of a project.
 *
 * project: { id, fundingToken, tierPrice (bigint, token base units) }
 * tierId: number
 * quantity: number
 * onStatus(msg): optional progress callback — 'approving…', 'confirming…', 'bridging…'
 *
 * Returns the fundTier/fundTierWithPermit tx hash.
 */
export async function fundProjectTier(project, tierId, quantity, onStatus) {
  if (!project || !Number.isFinite(Number(tierId)) || Number(quantity) <= 0) {
    throw new Error('fundProjectTier: bad args')
  }
  await ensureWallet()
  const wallet = await getWalletClient()
  const pc = await getPublicClient()
  const user = window.getWalletAddress?.()
  if (!user) throw new Error('wallet not connected')

  const hub = await _getPraxisAddress()
  const quantityBig = BigInt(quantity)
  const totalCost = BigInt(project.tierPrice) * quantityBig

  // ETH path — the one we had before.
  if (isEthFunding(project.fundingToken)) {
    await _onStatus(onStatus, 'confirming…')
    return wallet.writeContract({
      address: hub, abi: PRAXIS_ABI, functionName: 'fundTier',
      args: [BigInt(project.id), BigInt(tierId), quantityBig],
      value: totalCost,
    })
  }

  // ERC20 path. v1 contract has no fundTierWithPermit (removed for EIP-170
  // size budget). Flow: top up balance if needed (ETH→token swap, or hand
  // off to Stripe), then approve + fund (or just fund if allowance covers).
  const token = project.fundingToken

  // 0. Make sure the wallet actually holds enough of the funding token.
  //    ensureTokenBalance quietly swaps ETH→token on Optimism when needed;
  //    if ETH is also short it throws with code === 'NEEDS_STRIPE' so the
  //    caller can route to the card onramp.
  await ensureTokenBalance(user, token, totalCost, onStatus)

  // 1. Existing allowance covers us → one tx.
  const allowance = await pc.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [user, hub] }).catch(() => 0n)
  if (allowance >= totalCost) {
    await _onStatus(onStatus, 'confirming…')
    return wallet.writeContract({
      address: hub, abi: PRAXIS_ABI, functionName: 'fundTier',
      args: [BigInt(project.id), BigInt(tierId), quantityBig],
    })
  }

  // 2. Approve + fund — two tx.
  await _onStatus(onStatus, 'approving…')
  const approveHash = await wallet.writeContract({
    address: token, abi: ERC20_ABI, functionName: 'approve',
    args: [hub, totalCost],
  })
  await pc.waitForTransactionReceipt({ hash: approveHash, timeout: 120_000 })
  await _onStatus(onStatus, 'confirming…')
  return wallet.writeContract({
    address: hub, abi: PRAXIS_ABI, functionName: 'fundTier',
    args: [BigInt(project.id), BigInt(tierId), quantityBig],
  })
}

// _signPermit removed — fundTierWithPermit was dropped from the v1 contract
// for the EIP-170 size budget. Permit returns in a PraxisExtensions
// wrapper later; this file sticks to the 2-tx approve + fund path.
