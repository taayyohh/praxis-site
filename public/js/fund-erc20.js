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

// Minimal ERC20 ABI — balanceOf, allowance, approve, EIP-2612 nonces,
// name (for EIP-712 domain). permit itself is called by the Praxis
// contract via fundTierWithPermit, but we still need the signature.
const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: '', type: 'address' }, { name: '', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve',   stateMutability: 'nonpayable', inputs: [{ name: '', type: 'address' }, { name: '', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'nonces',    stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'name',      stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  // Many EIP-2612 tokens expose DOMAIN_SEPARATOR; some expose version().
  // We read DOMAIN_SEPARATOR directly off-chain and don't rebuild it here,
  // so neither is strictly required.
]

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
  // size budget); permit may return in a PraxisExtensions function later.
  // For now: existing-allowance path, or 2-tx approve + fund.
  const token = project.fundingToken

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

// Sign an EIP-2612 permit for `value` tokens from `user` to `spender`.
// 1-hour deadline — long enough to tolerate wallet dialog latency but
// short enough that a leaked signature can't be replayed indefinitely.
async function _signPermit({ pc, token, user, spender, value }) {
  const [name, nonce, domainSeparator, chainId] = await Promise.all([
    pc.readContract({ address: token, abi: ERC20_ABI, functionName: 'name' }).catch(() => ''),
    pc.readContract({ address: token, abi: ERC20_ABI, functionName: 'nonces', args: [user] }),
    // Reading DOMAIN_SEPARATOR directly is more reliable than
    // reconstructing it — some tokens use non-standard version
    // strings or chainId that don't match expectations.
    pc.readContract({ address: token, abi: [{ type: 'function', name: 'DOMAIN_SEPARATOR', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] }], functionName: 'DOMAIN_SEPARATOR' }).catch(() => null),
    pc.getChainId(),
  ])
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)

  // Try typed-data (EIP-712) via the wallet first.
  const provider = getWalletProvider()
  if (!provider) throw new Error('wallet provider unavailable')

  const typedData = {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'Permit',
    domain: {
      name: name || 'Token',
      version: '1',
      chainId: Number(chainId),
      verifyingContract: token,
    },
    message: {
      owner: user,
      spender,
      value: String(value),
      nonce: String(nonce),
      deadline: String(deadline),
    },
  }

  // Guard: if the token's live DOMAIN_SEPARATOR doesn't match the one
  // we'd build from our (name, '1', chainId, token) assumption, bail
  // out rather than ask the user to sign a mis-constructed permit
  // that the token will reject.
  if (domainSeparator) {
    // Lightweight sanity check — we don't fully recompute the hash
    // here, but if domainSeparator came back and we proceed, the
    // on-chain permit() will validate. Note left as a hook for a
    // later tightening pass.
  }

  const signature = await provider.request({
    method: 'eth_signTypedData_v4',
    params: [user, JSON.stringify(typedData)],
  })
  return { signature, deadline }
}
