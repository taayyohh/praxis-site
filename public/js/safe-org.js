// Safe-based org helpers — Praxis orgs get their own on-chain identity
// via a Safe multisig, so the org is a genuine shared account instead
// of "one admin EOA + a decorative members list."
//
// Safe v1.4.1 on Optimism:
//   SafeProxyFactory: 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67
//   SafeSingleton:    0x41675C099F32341bf84BFc5382aF534df5C7461a
//   CompatibilityFallbackHandler: 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99
//
// For a 1-of-1 Safe where msg.sender IS an owner, execTransaction accepts
// a "pre-approved" signature — no cryptographic sig needed, just packed
// signer address + zero-word + 0x01 (signature type = "owner sender").

import { createWalletClient, custom, optimism, encodeFunctionData, parseEther } from './vendor.js'
import { getPublicClient, getWalletClient, getWalletProvider, ensureWallet } from './utils.js'

export const SAFE_ADDRESSES = {
  proxyFactory: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67',
  singleton: '0x41675C099F32341bf84BFc5382aF534df5C7461a',
  fallbackHandler: '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99',
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
  const wc = getWalletClient()
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
  const wc = getWalletClient()
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
