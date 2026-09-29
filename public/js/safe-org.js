// Safe-based org helpers — Praxis orgs get their own on-chain identity
// via a Safe multisig, so the org is a genuine shared account instead
// of "one admin EOA + a decorative members list."
//
// Safe v1.5.0 on Optimism (source: github.com/safe-global/safe-deployments
// v1.5.0 canonical, all three verified to have contract code via
// eth_getCode against mainnet.optimism.io). v1.4.1 is also live and
// canonical on Optimism; we ship v1.5.0 because it's what safe.global's
// UI treats as current — any Safe deployed here looks "native" there.
//
// For a 1-of-1 Safe where msg.sender IS an owner, execTransaction accepts
// a "pre-approved" signature — no cryptographic sig needed, just packed
// signer address + zero-word + 0x01 (signature type = "owner sender").

import { createWalletClient, custom, optimism, encodeFunctionData, parseEther } from './vendor.js'
import { getPublicClient, getWalletClient, getWalletProvider, ensureWallet } from './utils.js'

export const SAFE_ADDRESSES = {
  proxyFactory: '0x14F2982D601c9458F93bd70B218933A6f8165e7b',
  singleton: '0xFf51A5898e281Db6DfC7855790607438dF2ca44b',
  fallbackHandler: '0x3EfCBb83A4A7AfcB4F68D501E2c2203a38be77f4',
}

const ZERO = '0x0000000000000000000000000000000000000000'

const PROXY_FACTORY_ABI = [
  { name: 'createProxyWithNonce', type: 'function', stateMutability: 'nonpayable', inputs: [
    { name: '_singleton', type: 'address' },
    { name: 'initializer', type: 'bytes' },
    { name: 'saltNonce', type: 'uint256' },
  ], outputs: [{ name: 'proxy', type: 'address' }] },
  { name: 'ProxyCreation', type: 'event', inputs: [
    { name: 'proxy', type: 'address', indexed: true },
    { name: 'singleton', type: 'address', indexed: false },
  ] },
]

const SAFE_ABI = [
  { name: 'setup', type: 'function', stateMutability: 'nonpayable', inputs: [
    { name: '_owners', type: 'address[]' },
    { name: '_threshold', type: 'uint256' },
    { name: 'to', type: 'address' },
    { name: 'data', type: 'bytes' },
    { name: 'fallbackHandler', type: 'address' },
    { name: 'paymentToken', type: 'address' },
    { name: 'payment', type: 'uint256' },
    { name: 'paymentReceiver', type: 'address' },
  ], outputs: [] },
  { name: 'getOwners', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] },
  { name: 'getThreshold', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'isOwner', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'bool' }] },
  { name: 'nonce', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'execTransaction', type: 'function', stateMutability: 'payable', inputs: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' },
    { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' },
    { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' },
    { name: 'signatures', type: 'bytes' },
  ], outputs: [{ type: 'bool' }] },
]

// Deploy a Safe with `signers` (address[]) and a threshold. Returns the
// new Safe address, extracted from the ProxyCreation event on the
// factory. saltNonce defaults to a timestamp so two calls with the same
// signers produce distinct Safes.
export async function deployOrgSafe({ signers, threshold = 1, saltNonce } = {}) {
  if (!signers?.length) throw new Error('at least one signer required')
  if (threshold < 1 || threshold > signers.length) throw new Error('invalid threshold')
  const addr = await ensureWallet()
  if (!addr) throw new Error('connect wallet')
  if (!await window.ensureOptimism?.()) return

  const nonce = saltNonce != null ? BigInt(saltNonce) : BigInt(Date.now())
  const initializer = encodeFunctionData({
    abi: SAFE_ABI,
    functionName: 'setup',
    args: [signers, BigInt(threshold), ZERO, '0x', SAFE_ADDRESSES.fallbackHandler, ZERO, 0n, ZERO],
  })

  const account = await window.authorizedSigner?.(addr)
  const wc = await getWalletClient()
  const hash = await wc.writeContract({
    address: SAFE_ADDRESSES.proxyFactory,
    abi: PROXY_FACTORY_ABI,
    functionName: 'createProxyWithNonce',
    args: [SAFE_ADDRESSES.singleton, initializer, nonce],
    account,
  })
  const pc = await getPublicClient()
  const receipt = await pc.waitForTransactionReceipt({ hash })

  // Find the ProxyCreation event — topic[0] is keccak256(ProxyCreation)
  // in the factory's ABI. Rather than compute it, filter by factory
  // address + the singleton in data.
  for (const log of receipt.logs || []) {
    if (log.address?.toLowerCase() !== SAFE_ADDRESSES.proxyFactory.toLowerCase()) continue
    // ProxyCreation event: topic[1] is the proxy address (indexed)
    if (log.topics?.length >= 2 && log.topics[0]) {
      try {
        const safeAddress = '0x' + log.topics[1].slice(-40)
        return { safeAddress, txHash: hash }
      } catch {}
    }
  }
  throw new Error('Safe deployed but proxy address not found in receipt')
}

// Read helpers — no wallet needed.
export async function getSafeOwners(safeAddress) {
  const pc = await getPublicClient()
  try {
    return await pc.readContract({ address: safeAddress, abi: SAFE_ABI, functionName: 'getOwners' })
  } catch { return [] }
}

export async function isSafeSigner(safeAddress, wallet) {
  if (!safeAddress || !wallet) return false
  if (!/^0x[0-9a-fA-F]{40}$/.test(safeAddress)) return false
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) return false
  const pc = await getPublicClient()
  try {
    return await pc.readContract({ address: safeAddress, abi: SAFE_ABI, functionName: 'isOwner', args: [wallet] })
  } catch { return false }
}

export async function isSafeAddress(addr) {
  if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) return false
  const pc = await getPublicClient()
  try {
    const code = await pc.getCode({ address: addr })
    return !!code && code !== '0x' && code.length > 2
  } catch { return false }
}

// Execute a call from the Safe. For a 1-of-1 Safe where the caller is
// the sole owner, we use the "owner-sender pre-approved" signature
// format: 32-byte-padded owner address + 32 zero bytes + 0x01. No
// cryptographic sig needed because msg.sender proves ownership.
export async function execSafeTx({ safeAddress, target, callData, value = 0n, operation = 0 }) {
  const addr = await ensureWallet()
  if (!addr) throw new Error('connect wallet')
  if (!await window.ensureOptimism?.()) return
  if (!await isSafeSigner(safeAddress, addr)) {
    throw new Error('connected wallet is not a signer on this Safe')
  }
  // Pre-approved-by-sender signature: pad owner to 32 bytes + zero word + type=01.
  const paddedOwner = addr.slice(2).toLowerCase().padStart(64, '0')
  const signature = ('0x' + paddedOwner + '0'.repeat(64) + '01')

  const account = await window.authorizedSigner?.(addr)
  const wc = await getWalletClient()
  const hash = await wc.writeContract({
    address: safeAddress,
    abi: SAFE_ABI,
    functionName: 'execTransaction',
    args: [target, BigInt(value), callData, operation, 0n, 0n, 0n, ZERO, ZERO, signature],
    account,
  })
  const pc = await getPublicClient()
  await pc.waitForTransactionReceipt({ hash })
  return hash
}

// --- Spend-side helpers ---
//
// Once an org's Safe is admining it, purchases + credential sales land at
// the Safe address. Safe signers need a way to *move* those funds — claim
// pending balances, transfer ETH, call withdraw() on PraxisMedia — all
// routed through Safe.execTransaction so the org keeps its Safe as
// msg.sender.

// Send raw ETH from the Safe to `to`. Uses execSafeTx with empty callData
// + `value` set; Safe delivers the wei via msg.sender.call{value}("") in
// its execute path.
export async function safeSendEth({ safeAddress, to, ethAmount }) {
  return execSafeTx({
    safeAddress,
    target: to,
    callData: '0x',
    value: parseEther(String(ethAmount)),
  })
}

// Register a Safe as a supporter on ArtistRegistry so it passes
// REGISTRY.isUser(safe) — required before PraxisOrganization will let it
// createOrg (as msg.sender) or be inviteMember'd (as invitee). Handle is
// validated by the contract (3-32 chars, lowercase a-z0-9 and hyphens,
// no leading/trailing hyphen); caller is responsible for sanitizing.
//
// The Safe pays gas from its own balance — fundSafeForBoot must have
// been called first with enough for two txs (register + one org call).
export async function safeRegisterAsSupporter({ safeAddress, registryAddress, handle }) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(safeAddress)) throw new Error('bad safeAddress')
  if (!/^0x[0-9a-fA-F]{40}$/.test(registryAddress)) throw new Error('bad registryAddress')
  const { encodeFunctionData } = await import('./vendor.js')
  const abi = [{ name: 'registerSupporter', type: 'function', inputs: [{ name: 'handle', type: 'string' }], outputs: [], stateMutability: 'nonpayable' }]
  const callData = encodeFunctionData({ abi, functionName: 'registerSupporter', args: [handle] })
  return execSafeTx({ safeAddress, target: registryAddress, callData })
}

// Sanitize a name into a handle that passes ArtistRegistry._validateHandle
// (3-32 chars, lowercase a-z0-9 and hyphens, no leading/trailing hyphen).
// Appends a suffix (typically an orgId or short random tag) so two orgs
// with the same display name land distinct handles.
export function safeSupporterHandle(name, suffix = '') {
  const sanitized = String(name || 'org')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'org'
  const suf = String(suffix).replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 6)
  const combined = suf ? `${sanitized}-${suf}` : sanitized
  // Enforce the 3-32 char + hyphen-boundary contract rules; the trim
  // above already covers the character class.
  const clamped = combined.slice(0, 32).replace(/^-+|-+$/g, '')
  return clamped.length >= 3 ? clamped : `${clamped}xyz`.slice(0, 32)
}

// Claim from a contract whose withdraw()/claim() reads msg.sender.
// PraxisMedia.withdraw() and Praxis.claimFunds() both use this shape, so
// the Safe becomes the recipient because it's msg.sender inside the inner
// call.
export async function safeClaimFrom({ safeAddress, target, functionName = 'withdraw' }) {
  const abi = [{ name: functionName, type: 'function', inputs: [], outputs: [], stateMutability: 'nonpayable' }]
  const { encodeFunctionData } = await import('./vendor.js')
  const callData = encodeFunctionData({ abi, functionName, args: [] })
  return execSafeTx({ safeAddress, target, callData })
}

// Read the Safe's ETH balance on Optimism. Small helper so the org-funds
// panel doesn't have to re-import getPublicClient.
export async function getSafeBalance(safeAddress) {
  const pc = await getPublicClient()
  return await pc.getBalance({ address: safeAddress })
}

// Read a Safe's pending withdrawal on any contract exposing a
// pendingWithdrawals(address) mapping — both Praxis and PraxisMedia
// follow that shape. Returns 0n on error.
export async function getSafePendingWithdrawal(safeAddress, contractAddr) {
  if (!safeAddress || !contractAddr) return 0n
  const pc = await getPublicClient()
  const abi = [{
    name: 'pendingWithdrawals', type: 'function', stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'uint256' }],
  }]
  try {
    return await pc.readContract({ address: contractAddr, abi, functionName: 'pendingWithdrawals', args: [safeAddress] })
  } catch { return 0n }
}

// --- Signer + threshold management ---
//
// Adding/removing signers and changing threshold happen ON the Safe as
// msg.sender — every one of these is a Safe.execTransaction call
// wrapping a call into the Safe's own storage. That's why routing
// through execSafeTx: no owner can just call Safe.addOwnerWithThreshold
// directly, the Safe has to authorize itself.
//
// Sentinel address for the Safe's owner linked list. Safe stores owners
// as a singly-linked list where each node points to the next; SENTINEL
// (0x1) is both head-of-list and end-of-list marker. To remove an owner
// you must pass its predecessor in the list.
const SAFE_SENTINEL_OWNER = '0x0000000000000000000000000000000000000001'

const SAFE_OWNER_MGMT_ABI = [
  { name: 'addOwnerWithThreshold', type: 'function', stateMutability: 'nonpayable', inputs: [
    { name: 'owner', type: 'address' },
    { name: 'threshold', type: 'uint256' },
  ], outputs: [] },
  { name: 'removeOwner', type: 'function', stateMutability: 'nonpayable', inputs: [
    { name: 'prevOwner', type: 'address' },
    { name: 'owner', type: 'address' },
    { name: 'threshold', type: 'uint256' },
  ], outputs: [] },
  { name: 'changeThreshold', type: 'function', stateMutability: 'nonpayable', inputs: [
    { name: 'threshold', type: 'uint256' },
  ], outputs: [] },
]

// Add a signer, optionally changing threshold in the same tx. threshold
// must be between 1 and (current owner count + 1). Fires Safe.execTx
// with the caller as pre-approved signer — meaningful only on a 1-of-1
// Safe today; a multi-sig Safe will queue this as a pending tx for
// remaining owners to co-sign (that flow is TODO).
export async function safeAddSigner({ safeAddress, newSigner, threshold }) {
  const { encodeFunctionData } = await import('./vendor.js')
  const callData = encodeFunctionData({
    abi: SAFE_OWNER_MGMT_ABI, functionName: 'addOwnerWithThreshold',
    args: [newSigner, BigInt(threshold)],
  })
  return execSafeTx({ safeAddress, target: safeAddress, callData })
}

// Remove a signer + set new threshold. Safe stores owners as a
// singly-linked list, so the caller has to figure out `prevOwner`
// (the owner that comes BEFORE the removee in the list) — we compute
// it by walking getOwners() and matching index. If the removee is at
// index 0, prevOwner = SENTINEL.
export async function safeRemoveSigner({ safeAddress, signerToRemove, threshold }) {
  const owners = await getSafeOwners(safeAddress)
  const lower = signerToRemove.toLowerCase()
  const idx = owners.findIndex(o => o.toLowerCase() === lower)
  if (idx === -1) throw new Error('signer not found on this Safe')
  const prevOwner = idx === 0 ? SAFE_SENTINEL_OWNER : owners[idx - 1]
  const { encodeFunctionData } = await import('./vendor.js')
  const callData = encodeFunctionData({
    abi: SAFE_OWNER_MGMT_ABI, functionName: 'removeOwner',
    args: [prevOwner, signerToRemove, BigInt(threshold)],
  })
  return execSafeTx({ safeAddress, target: safeAddress, callData })
}

// Change threshold only (no signer changes). Must be >= 1 and <= owner
// count.
export async function safeChangeThreshold({ safeAddress, threshold }) {
  const { encodeFunctionData } = await import('./vendor.js')
  const callData = encodeFunctionData({
    abi: SAFE_OWNER_MGMT_ABI, functionName: 'changeThreshold',
    args: [BigInt(threshold)],
  })
  return execSafeTx({ safeAddress, target: safeAddress, callData })
}

// Read current threshold.
export async function getSafeThreshold(safeAddress) {
  const pc = await getPublicClient()
  const abi = [{ name: 'getThreshold', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }]
  try {
    return Number(await pc.readContract({ address: safeAddress, abi, functionName: 'getThreshold' }))
  } catch { return 1 }
}

// Fund a freshly-deployed Safe with ETH from the connected wallet.
// Needed so the Safe can pay gas for its own first execTransaction
// (e.g. Praxis.acceptInvite). 0.001 ETH covers a handful of Optimism
// txs at current gas prices.
export async function fundSafeForBoot(safeAddress, ethAmount = '0.001') {
  const addr = await ensureWallet()
  if (!addr) throw new Error('connect wallet')
  if (!await window.ensureOptimism?.()) return
  const account = await window.authorizedSigner?.(addr)
  const wc = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })
  const hash = await wc.sendTransaction({
    to: safeAddress,
    value: parseEther(ethAmount),
    account,
  })
  const pc = await getPublicClient()
  await pc.waitForTransactionReceipt({ hash })
  return hash
}
