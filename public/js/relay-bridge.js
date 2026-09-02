// relay-bridge.js — cross-chain ETH bridging via Relay Protocol
// lazy-loaded only when bridge is needed
import { USDC_BASE } from './contracts.js'

let _relayClient = null
// H8: module-level publicClient cache keyed by chainId
const _relayClientCache = new Map()

const OPTIMISM_CHAIN_ID = 10

const CHAINS = [
  { chainId: 1, chainName: 'Ethereum', viemKey: 'mainnet' },
  { chainId: 42161, chainName: 'Arbitrum', viemKey: 'arbitrum' },
  { chainId: 10, chainName: 'Optimism', viemKey: 'optimism' },
  { chainId: 8453, chainName: 'Base', viemKey: 'base' },
  { chainId: 137, chainName: 'Polygon', viemKey: 'polygon' },
  { chainId: 324, chainName: 'zkSync Era', viemKey: null },
]

// minimum balance to show a chain (0.001 ETH)
const MIN_DISPLAY_BALANCE = 1000000000000000n // 0.001 * 1e18

// RPC calls proxied through server to keep API keys secure
const PUBLIC_RPCS = {
  1: '/api/rpc/1',
  42161: '/api/rpc/42161',
  10: '/api/rpc/10',
  8453: '/api/rpc/8453',
  137: '/api/rpc/137',
  324: '/api/rpc/324',
}

export async function initRelay() {
  if (_relayClient) return _relayClient
  const { createClient, MAINNET_RELAY_API } = await import('./vendor-relay.js')
  const { mainnet, arbitrum, optimism, base, polygon } = await import('./vendor.js')

  // Override chain RPC URLs to use our proxy (avoids eth.merkle.io CORS issues)
  const proxyChain = (c) => ({ ...c, rpcUrls: { ...c.rpcUrls, default: { http: [`/api/rpc/${c.id}`] } } })
  const toRelayChain = (c) => ({
    id: c.id, name: c.name.replace(' ', '-'), displayName: c.name,
    httpRpcUrl: `/api/rpc/${c.id}`, wsRpcUrl: '',
    currency: { address: '0x0000000000000000000000000000000000000000', ...c.nativeCurrency },
    explorerUrl: c.blockExplorers?.default?.url || '', vmType: 'evm', depositEnabled: true,
    viemChain: proxyChain(c),
  })

  _relayClient = createClient({
    baseApiUrl: MAINNET_RELAY_API,
    source: 'praxis',
    chains: [toRelayChain(mainnet), toRelayChain(optimism), toRelayChain(arbitrum), toRelayChain(base), toRelayChain(polygon)],
  })
  return _relayClient
}

export async function getMultichainBalances(address) {
  // check sessionStorage cache (60s TTL)
  const cacheKey = `praxis-multichain-${address.toLowerCase()}`
  try {
    const cached = sessionStorage.getItem(cacheKey)
    if (cached) {
      const { balances, ts } = JSON.parse(cached)
      if (Date.now() - ts < 60000) {
        return balances.map(b => ({ ...b, balance: BigInt(b.balance) }))
      }
    }
  } catch {}

  const { createPublicClient, http, mainnet, arbitrum, optimism, base, polygon } = await import('./vendor.js')

  const viemChains = { mainnet, arbitrum, optimism, base, polygon }

  // fetch balance via raw JSON-RPC (used for chains without viem definition)
  async function rawBalance(rpcUrl, addr) {
    const resp = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [addr, 'latest'] }),
    })
    const json = await resp.json()
    return BigInt(json.result)
  }

  const results = await Promise.allSettled(
    CHAINS.map(async (chain) => {
      let balance
      if (chain.viemKey && viemChains[chain.viemKey]) {
        let client = _relayClientCache.get(chain.chainId)
        if (!client) {
          client = createPublicClient({
            chain: viemChains[chain.viemKey],
            transport: http(PUBLIC_RPCS[chain.chainId]),
          })
          _relayClientCache.set(chain.chainId, client)
        }
        balance = await client.getBalance({ address })
      } else {
        balance = await rawBalance(PUBLIC_RPCS[chain.chainId], address)
      }
      return { chainId: chain.chainId, chainName: chain.chainName, balance }
    })
  )

  const balances = results
    .filter(r => r.status === 'fulfilled' && r.value.balance >= MIN_DISPLAY_BALANCE)
    .map(r => r.value)
    .sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0))

  // cache — store balance as string for serialization
  try {
    sessionStorage.setItem(cacheKey, JSON.stringify({
      balances: balances.map(b => ({ ...b, balance: b.balance.toString() })),
      ts: Date.now(),
    }))
  } catch {}

  return balances
}

// Broadcast a signed tx via JSON-RPC, returns hash or null on failure
async function _broadcastRawTx(rpcUrl, signedTx) {
  try {
    const resp = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [signedTx] }),
    })
    const data = await resp.json()
    if (data.result) return data.result
    console.warn('[bridge] broadcast error from', rpcUrl, ':', data.error?.message || JSON.stringify(data.error))
    // "already known" means the tx is already in the mempool — that's a success
    if (data.error?.message?.includes('already known')) return null // let caller retry
    if (data.error?.message?.includes('nonce too low')) throw new Error('nonce too low — a previous bridge tx may have succeeded. Check your Optimism balance.')
    return null
  } catch (e) {
    if (e.message?.includes('nonce too low')) throw e
    console.warn('[bridge] broadcast fetch error:', rpcUrl, e.message)
    return null
  }
}

// Check if a tx hash exists in the mempool or chain
async function _checkTxExists(rpcUrl, hash) {
  try {
    const resp = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionByHash', params: [hash] }),
    })
    const data = await resp.json()
    return data.result != null
  } catch { return false }
}

export async function bridgeToOptimism(fromChainId, address, amountWei, onStatusUpdate) {
  const client = await initRelay()
  const { getQuote } = await import('./vendor-relay.js')

  onStatusUpdate?.('getting quote...')

  const quote = await getQuote({
    chainId: fromChainId,
    toChainId: OPTIMISM_CHAIN_ID,
    currency: '0x0000000000000000000000000000000000000000',
    toCurrency: '0x0000000000000000000000000000000000000000',
    amount: amountWei.toString(),
    user: address,
    recipient: address,
    tradeType: 'EXACT_INPUT',
  })

  onStatusUpdate?.('sending bridge transaction...')

  // Skip the Relay SDK execute entirely — send the tx directly using our wallet + RPC proxy.
  // The SDK's adapted wallet has transport issues that prevent actual broadcast.
  const steps = quote.steps || []
  if (!steps.length || !steps[0]?.items?.length) throw new Error('no bridge steps in quote')

  const txData = steps[0].items[0].data
  if (!txData?.to) throw new Error('no tx data in quote')

  const { createPublicClient, http, keccak256, mainnet, arbitrum, optimism, base, polygon } = await import('./vendor.js')

  // Get embedded account and send directly through chain-specific RPC
  await window.ensureAuthorized?.()
  const embeddedAcct = window.getEmbeddedAccount?.()
  if (!embeddedAcct) throw new Error('wallet not available')

  const rpcUrl = PUBLIC_RPCS[fromChainId]
  // Use proper viem chain definitions (with full EIP-1559/type config) + our RPC proxy
  const viemChains = { 1: mainnet, 42161: arbitrum, 10: optimism, 8453: base, 137: polygon }
  const baseChain = viemChains[fromChainId]
  if (!baseChain) throw new Error(`unsupported chain ${fromChainId}`)
  const chainDef = { ...baseChain, rpcUrls: { ...baseChain.rpcUrls, default: { http: [rpcUrl] } } }
  const pc = createPublicClient({ chain: chainDef, transport: http(rpcUrl) })

  // Fetch confirmed nonce and fresh gas prices from chain — avoids stale pending pool state
  // after previous failed broadcast attempts that may have polluted Alchemy's mempool.
  const [nonce, block] = await Promise.all([
    pc.getTransactionCount({ address, blockTag: 'latest' }),
    pc.getBlock({ blockTag: 'latest' }),
  ])
  const baseFee = block.baseFeePerGas || 0n
  // 2x base fee + generous priority to survive 2-3 blocks of fee fluctuation
  const maxPriority = 3000000000n // 3 gwei
  const maxFee = baseFee * 2n + maxPriority

  // Sign the transaction ourselves so we can inspect the raw bytes before broadcast
  // and retry via multiple RPCs if the primary one drops it.
  const gasEstimate = txData.gas ? BigInt(txData.gas) : await pc.estimateGas({
    account: embeddedAcct,
    to: txData.to,
    data: txData.data,
    value: txData.value ? BigInt(txData.value) : 0n,
  })
  const txRequest = {
    to: txData.to,
    data: txData.data,
    value: txData.value ? BigInt(txData.value) : 0n,
    nonce,
    maxFeePerGas: maxFee,
    maxPriorityFeePerGas: maxPriority,
    gas: gasEstimate,
    chainId: fromChainId,
    type: 'eip1559',
  }

  // Check balance is sufficient before signing
  const balance = await pc.getBalance({ address })
  const maxCost = txRequest.value + gasEstimate * maxFee
  if (balance < maxCost) throw new Error(`insufficient balance: have ${balance} wei, need ${maxCost} wei (value + gas)`)

  // Sign with the embedded account
  const serializedTx = await embeddedAcct.signTransaction(txRequest)
  const expectedHash = keccak256(serializedTx)

  // Broadcast via our proxy — server-side broadcasts to Alchemy + public RPCs in parallel
  let hash = await _broadcastRawTx(rpcUrl, serializedTx)
  // Even if proxy returned no hash, we know the expected hash from the signed tx
  if (!hash) hash = expectedHash

  // Verify the tx actually reached a mempool
  await new Promise(r => setTimeout(r, 3000))
  let found = await _checkTxExists(rpcUrl, hash)
  if (!found) {
    console.warn('[bridge] tx', hash, 'not found in mempool after 3s, retrying broadcast')
    await _broadcastRawTx(rpcUrl, serializedTx)
    await new Promise(r => setTimeout(r, 3000))
    found = await _checkTxExists(rpcUrl, hash)
    if (!found) throw new Error('bridge tx not accepted by any node — the Relay contract may have a deadline. Try again for a fresh quote.')
  }

  onStatusUpdate?.('bridge submitted — waiting for confirmation...')

  // Wait for mainnet confirmation (timeout after 5 minutes to avoid hanging forever)
  const receipt = await Promise.race([
    pc.waitForTransactionReceipt({ hash }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('bridge confirmation timed out after 5 minutes — check Etherscan for tx ' + hash.slice(0, 10) + '...')), 5 * 60 * 1000)),
  ])
  if (receipt.status === 'reverted') throw new Error('bridge transaction reverted on-chain')
  onStatusUpdate?.('bridge confirmed — waiting for funds on Optimism...')

  // Poll Optimism balance
  const opClient = createPublicClient({ chain: { id: 10, name: 'Optimism', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['/api/rpc/10'] } } }, transport: http('/api/rpc/10') })
  const initialOpBal = await opClient.getBalance({ address }).catch(() => 0n)
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000))
    const newBal = await opClient.getBalance({ address }).catch(() => 0n)
    if (newBal > initialOpBal) break
    onStatusUpdate?.(`waiting for bridge... (${(i + 1) * 2}s)`)
  }

  onStatusUpdate?.('bridge complete')
  window.dispatchEvent(new CustomEvent('wallet-balance-changed'))
}

// Build a viem walletClient configured for the source chain.
// Prefers the embedded wallet (Praxis default); falls back to window.ethereum.
//
// Wraps the http transport to stub wallet_getCapabilities — Alchemy returns 400
// for wallet_* methods (not a wallet RPC), and the Relay SDK probes this to check
// for EIP-5792 atomic batch support. Without the stub, we get noisy console errors.
export async function _buildBridgeWalletClient(fromChainId) {
  const { createWalletClient, custom, http, mainnet, arbitrum, optimism, base, polygon } = await import('./vendor.js')
  // Override default RPC URLs to use our proxy (avoids eth.merkle.io CORS issues)
  const proxyRpc = (c) => ({ ...c, rpcUrls: { ...c.rpcUrls, default: { http: [`/api/rpc/${c.id}`] } } })
  const viemChains = { 1: proxyRpc(mainnet), 42161: proxyRpc(arbitrum), 10: proxyRpc(optimism), 8453: proxyRpc(base), 137: proxyRpc(polygon) }
  const chain = viemChains[fromChainId]
  if (!chain) throw new Error(`bridging from chainId ${fromChainId} not supported`)

  // Custom transport: intercept wallet_* methods that Alchemy doesn't support
  const baseHttp = http(PUBLIC_RPCS[fromChainId])
  const noWalletCaps = (cfg) => {
    const t = baseHttp(cfg)
    return {
      ...t,
      request: async ({ method, params }) => {
        if (method === 'wallet_getCapabilities') return {} // no capabilities, no atomic batch
        return t.request({ method, params })
      },
    }
  }

  // Ensure wallet is unlocked FIRST so getEmbeddedAccount returns the account
  await window.ensureAuthorized?.()

  const embeddedAcct = window.getEmbeddedAccount?.()
  if (embeddedAcct) {
    // Use embedded account directly with chain-specific RPC (NOT the EIP-1193 provider which is Optimism-only)
    return createWalletClient({ chain, account: embeddedAcct, transport: noWalletCaps })
  }

  throw new Error('no wallet available — unlock your embedded wallet first')
}

// Bridge USDC on Base → ETH on Optimism (Relay handles swap + bridge in one tx)

export async function bridgeUsdcToOptimismEth(address, amountUsdc, onStatusUpdate) {
  const client = await initRelay()
  const { getQuote, execute } = await import('./vendor-relay.js')

  onStatusUpdate?.('getting swap + bridge quote...')

  // SDK uses the old field names (chainId/toChainId/currency/toCurrency).
  // originChainId/destinationChainId are silently dropped → API returns 400.
  const quote = await getQuote({
    chainId: 8453,
    toChainId: OPTIMISM_CHAIN_ID,
    currency: USDC_BASE,
    toCurrency: '0x0000000000000000000000000000000000000000',
    amount: amountUsdc.toString(),
    user: address,
    recipient: address,
    tradeType: 'EXACT_INPUT',
  })

  onStatusUpdate?.('confirm in wallet...')

  // Use the embedded wallet (configured for Base) — same pattern as bridgeToOptimism
  const walletClient = await _buildBridgeWalletClient(8453)

  // Capture txHashes from progress callbacks so we can return them even if the
  // Relay indexer 404s on /transactions/index (common for fresh Base txs).
  let lastTxHash = null
  return new Promise((resolve, reject) => {
    execute({
      quote,
      wallet: walletClient,
      onProgress: ({ currentStep, currentStepItem, txHashes, error }) => {
        // Track tx hashes from any step
        if (txHashes && txHashes.length > 0) {
          lastTxHash = txHashes[txHashes.length - 1]?.txHash || lastTxHash
        }
        if (currentStepItem?.txHashes?.length) {
          lastTxHash = currentStepItem.txHashes[currentStepItem.txHashes.length - 1]?.txHash || lastTxHash
        }
        if (error) {
          onStatusUpdate?.('swap + bridge failed')
          reject(new Error(error.message || 'swap + bridge failed'))
          return
        }
        if (currentStep?.id === 'approve') {
          onStatusUpdate?.('approving USDC...')
        } else if (currentStepItem?.status === 'complete' && currentStep?.id === 'deposit') {
          onStatusUpdate?.('swap submitted — bridging to Optimism...')
        } else if (currentStepItem?.status === 'complete') {
          onStatusUpdate?.('complete — ETH on Optimism')
          resolve(lastTxHash)
        } else if (currentStepItem?.status === 'incomplete') {
          onStatusUpdate?.('processing...')
        }
      },
    }).then(() => {
      onStatusUpdate?.('complete — ETH on Optimism')
      resolve(lastTxHash)
    }).catch((err) => {
      // The tx may have actually been submitted but Relay's /transactions/index 404'd
      // because Base finality + their indexer lag. Treat as "in flight" success.
      const msg = err?.message || ''
      if (lastTxHash && (msg.includes('Transaction receipt not found') || msg.includes('not found') || msg.includes('404'))) {
        console.log('[relay] indexer lag — tx', lastTxHash, 'submitted but not yet indexed; treating as in-flight success')
        onStatusUpdate?.('bridge in flight — ETH will arrive on Optimism in ~2 min')
        resolve(lastTxHash)
        return
      }
      reject(err)
    })
  })
}
