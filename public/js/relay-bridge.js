// relay-bridge.js — cross-chain ETH bridging via Relay Protocol
// lazy-loaded only when bridge is needed

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

// Alchemy RPCs per chain — used for balance checks + bridging
const ALCHEMY_KEY = '59H42Trs6xiuI1wp-JppC'
const PUBLIC_RPCS = {
  1: `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  42161: `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  10: `https://opt-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  8453: `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  137: `https://polygon-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  324: `https://zksync-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
}

export async function initRelay() {
  if (_relayClient) return _relayClient
  const { createClient, MAINNET_RELAY_API } = await import('./vendor-relay.js')
  _relayClient = createClient({
    baseApiUrl: MAINNET_RELAY_API,
    source: 'praxis',
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

export async function bridgeToOptimism(fromChainId, address, amountWei, onStatusUpdate) {
  const client = await initRelay()
  const { getQuote, execute } = await import('./vendor-relay.js')

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

  onStatusUpdate?.('confirm in wallet...')

  const walletClient = await _buildBridgeWalletClient(fromChainId)

  return new Promise((resolve, reject) => {
    execute({
      quote,
      wallet: walletClient,
      onProgress: ({ currentStep, currentStepItem, txHashes, error }) => {
        if (error) {
          onStatusUpdate?.('bridge failed')
          reject(new Error(error.message || 'bridge failed'))
          return
        }
        if (currentStepItem?.status === 'complete' && currentStep?.id === 'deposit') {
          onStatusUpdate?.('bridge submitted -- waiting...')
        } else if (currentStepItem?.status === 'complete') {
          onStatusUpdate?.('bridge complete')
          resolve()
        } else if (currentStepItem?.status === 'incomplete') {
          onStatusUpdate?.('bridging...')
        }
      },
    }).then(() => {
      onStatusUpdate?.('bridge complete')
      resolve()
    }).catch(reject)
  })
}

// Build a viem walletClient configured for the source chain.
// Prefers the embedded wallet (Praxis default); falls back to window.ethereum.
//
// Wraps the http transport to stub wallet_getCapabilities — Alchemy returns 400
// for wallet_* methods (not a wallet RPC), and the Relay SDK probes this to check
// for EIP-5792 atomic batch support. Without the stub, we get noisy console errors.
async function _buildBridgeWalletClient(fromChainId) {
  const { createWalletClient, custom, http, mainnet, arbitrum, optimism, base, polygon } = await import('./vendor.js')
  const viemChains = { 1: mainnet, 42161: arbitrum, 10: optimism, 8453: base, 137: polygon }
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

  const embeddedAcct = window.getEmbeddedAccount?.()
  if (embeddedAcct) {
    await window.ensureAuthorized?.()
    return createWalletClient({ chain, account: embeddedAcct, transport: noWalletCaps })
  }

  // LOW-1: route through getWalletProvider() so embedded/praxis provider is
  // preferred when active, falling back to window.ethereum only as a last resort.
  const provider = window.getWalletProvider?.() || window.ethereum
  if (provider) {
    await window.ensureAuthorized?.()
    return createWalletClient({ chain, transport: custom(provider) })
  }

  throw new Error('no wallet available — unlock your embedded wallet first')
}

// Bridge USDC on Base → ETH on Optimism (Relay handles swap + bridge in one tx)
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'

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
