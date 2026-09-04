// ramp.js — native on/off ramp via zkp2p SDK + Relay bridge
// Fully inline — zero redirects, zero external windows, zero extensions
// Architecture: USD ↔ zkp2p on Base (indexer + contract) ↔ Relay bridge ↔ ETH on Optimism

import { bridgeToOptimism, bridgeUsdcToOptimismEth, initRelay } from './relay-bridge.js'
import { dbg } from './utils.js'

const ZKP2P_API = 'https://api.zkp2p.xyz/v1'
const ZKP2P_INDEXER = 'https://indexer.zkp2p.xyz/v1/graphql'
const BASE_CHAIN_ID = 8453
const BASE_RPC = 'https://mainnet.base.org'
const BASE_CHAIN = { id: BASE_CHAIN_ID, name: 'Base', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [BASE_RPC] } } }
const OPTIMISM_CHAIN_ID = 10
const ETH_ADDRESS = '0x0000000000000000000000000000000000000000'
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const ESCROW_V2 = '0x777777779d229cdF3110e9de47943791c26300Ef'
const ORCHESTRATOR_V2 = '0x888888359E981B5225CA48fbCdCeff702FC3b888'
const SWAP_ROUTER_BASE = '0x2626664c2603336E57B271c5C0b26F421741e481'
const WETH_BASE = '0x4200000000000000000000000000000000000006'
const UNISWAP_FEE_TIER = 500 // 0.05% pool
const SLIPPAGE_BPS = 50 // 0.5%
const PREFERRED_METHOD_KEY = 'praxis-ramp-method'
const QUOTE_POLL_MS = 3000
const INTENT_POLL_MS = 5000
const INTENT_TIMEOUT_MS = 600000 // 10 minutes

// Payment method name → on-chain bytes32 hash (from @zkp2p/contracts-v2)
const PAYMENT_METHOD_HASHES = {
  venmo: '0x90262a3db0edd0be2369c6b28f9e8511ec0bac7136cefbada0880602f87e7268',
  revolut: '0x617f88ab82b5c1b014c539f7e75121427f0bb50a4c58b187a238531e7d58605d',
  cashapp: '0x10940ee67cfb3c6c064569ec92c0ee934cd7afa18dd2ca2d6a2254fcb009c17d',
  wise: '0x554a007c2217df766b977723b276671aee5ebb4adaea0edb6433c88b3e61dac5',
  paypal: '0x3ccc3d4d5e769b1f82dc4988485551dc0cd3c7a3926d7d8a4dde91507199490f',
  zelle: '0x0000000000000000000000000000000000000000000000000000000000000000', // requires bank-specific variant (zelle-citi, zelle-chase, etc.) — disabled
}

// Payment method → fiat currency (Revolut uses EUR, all others USD)
const PAYMENT_METHOD_CURRENCIES = {
  venmo: 'USD',
  wise: 'USD',
  cashapp: 'USD',
  revolut: 'EUR',
  paypal: 'USD',
}

// Currency code → bytes32 hash
const CURRENCY_HASHES = {
  USD: '0xc4ae21aac0c6549d71dd96035b7e0bdb6c79ebdba8891b666115bc976d16a29e',
  EUR: '0xfff16d60be267153303bbfa66e593fb8d06e24ea5ef24b6acca5224c2ca6b907',
  GBP: '0x90832e2dc3221e4d56977c1aa8f6a6706b9ad6542fbbdaac13097d0fa5e42e67',
}

const PAYMENT_METHODS = [
  { id: 'wise', label: 'Wise', icon: 'ph-arrows-left-right' },
  { id: 'revolut', label: 'Revolut', icon: 'ph-currency-circle-dollar' },
  { id: 'cashapp', label: 'Cash App', icon: 'ph-currency-dollar' },
  { id: 'venmo', label: 'Venmo', icon: 'ph-venmo-logo', disabled: true, disabledReason: 'coming soon' },
]

// Status states: idle → quoting → matching → paying → funded → swapping → bridging → done
const STATUS = {
  idle: 'idle',
  quoting: 'quoting',
  matching: 'matching',
  paying: 'paying',
  funded: 'funded',
  swapping: 'swapping',
  bridging: 'bridging',
  approving: 'approving',
  depositing: 'depositing',
  waiting: 'waiting',
  verifying: 'verifying',
  done: 'done',
  error: 'error',
}

// Offramp polling constants
const DEPOSIT_POLL_MS = 5000
const DEPOSIT_TIMEOUT_MS = 1800000 // 30 minutes
const OFFRAMP_SLIPPAGE_BPS = 200 // 2% slippage for ETH → USDC swap

// --- Safe decimal conversion helpers ---
// Avoids floating-point precision bugs when converting USD → USDC 6-decimal units

/** Convert a USD number (e.g. 20.50) to USDC 6-decimal string ("20500000") */
export function usdToUsdc6(amountUSD) {
  // Split into integer + fractional to avoid float * 1e6 precision loss
  const str = String(amountUSD)
  const [intPart, fracPart = ''] = str.split('.')
  // Pad or truncate fractional to 6 digits
  const frac6 = (fracPart + '000000').slice(0, 6)
  const combined = intPart + frac6
  // Remove leading zeros but keep at least '0'
  return combined.replace(/^0+/, '') || '0'
}

/** Format USDC 6-decimal bigint to human-readable string */
export function formatUsdc(amountBigInt) {
  const str = amountBigInt.toString()
  if (str.length <= 6) return (Number(amountBigInt) / 1e6).toFixed(2)
  const whole = str.slice(0, -6)
  const frac = str.slice(-6, -4) // 2 decimal places
  return `${whole}.${frac}`
}

// Payment details placeholder text per method
const PAYMENT_DETAIL_PLACEHOLDERS = {
  venmo: 'your Venmo username (e.g. @your-name)',
  paypal: 'your PayPal email',
  revolut: 'your Revolut tag (e.g. @your-tag)',
  cashapp: 'your Cash App $cashtag',
  wise: 'your email address',
}

// Payment details validation per method
function validatePaymentDetails(method, value) {
  if (!value || !value.trim()) return 'payment details required'
  const v = value.trim()
  switch (method) {
    case 'venmo':
      if (v.length < 2) return 'enter your Venmo username'
      return null
    case 'paypal':
      if (!v.includes('@') || !v.includes('.')) return 'enter a valid PayPal email'
      return null
    case 'revolut':
      if (v.length < 2) return 'enter your Revolut tag'
      return null
    case 'cashapp':
      if (!v.startsWith('$') && !v.startsWith('@')) return 'enter your $cashtag (e.g. $yourname)'
      return null
    case 'wise':
      if (!v.includes('@') || !v.includes('.')) return 'enter a valid email address'
      return null
    default:
      return null
  }
}

function getPreferredMethod() {
  const stored = localStorage.getItem(PREFERRED_METHOD_KEY)
  // If stored method is disabled, fall back to first available
  const method = PAYMENT_METHODS.find(m => m.id === stored && !m.disabled)
  try { return method ? stored : (PAYMENT_METHODS.find(m => !m.disabled)?.id || 'wise') } catch { return 'wise' }
}

function setPreferredMethod(method) {
  try { localStorage.setItem(PREFERRED_METHOD_KEY, method) } catch {}
}

// --- Lazy SDK loader ---

let _zkp2pModule = null
async function loadZkp2pSdk() {
  if (!_zkp2pModule) _zkp2pModule = await import('./vendor-zkp2p.js')
  return _zkp2pModule
}

// --- ERC20 approve + Uniswap SwapRouter ABIs ---

const ERC20_APPROVE_ABI = [{
  inputs: [
    { name: 'spender', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  name: 'approve',
  outputs: [{ name: '', type: 'bool' }],
  stateMutability: 'nonpayable',
  type: 'function',
}]

const ERC20_BALANCE_ABI = [{
  inputs: [{ name: 'account', type: 'address' }],
  name: 'balanceOf',
  outputs: [{ name: '', type: 'uint256' }],
  stateMutability: 'view',
  type: 'function',
}]

const SWAP_ROUTER_ABI = [{
  inputs: [{
    components: [
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOut', type: 'address' },
      { name: 'fee', type: 'uint24' },
      { name: 'recipient', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMinimum', type: 'uint256' },
      { name: 'sqrtPriceLimitX96', type: 'uint160' },
    ],
    name: 'params',
    type: 'tuple',
  }],
  name: 'exactInputSingle',
  outputs: [{ name: 'amountOut', type: 'uint256' }],
  stateMutability: 'payable',
  type: 'function',
}]

const WETH_WITHDRAW_ABI = [{
  inputs: [{ name: 'wad', type: 'uint256' }],
  name: 'withdraw',
  outputs: [],
  stateMutability: 'nonpayable',
  type: 'function',
}]

// --- Swap USDC → ETH on Base via Uniswap V3 ---

export async function swapUsdcToEth(walletClient, amountUsdc, recipientAddress) {
  const { createPublicClient, http } = await import('./vendor.js')
  const baseChain = {
    id: BASE_CHAIN_ID, name: 'Base',
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [BASE_RPC] } },
  }
  const publicClient = createPublicClient({ chain: baseChain, transport: http(BASE_RPC) })

  const amountIn = BigInt(amountUsdc)

  // 1. Approve USDC spend to SwapRouter
  const approveTx = await walletClient.writeContract({
    address: USDC_BASE,
    abi: ERC20_APPROVE_ABI,
    functionName: 'approve',
    args: [SWAP_ROUTER_BASE, amountIn],
    account: recipientAddress,
    chain: baseChain,
  })
  await publicClient.waitForTransactionReceipt({ hash: approveTx })

  // 2. Get quote for minimum output (slippage protection)
  // Fetch current pool price via a static call to estimate output
  let amountOutMinimum
  try {
    const estimatedOut = await publicClient.simulateContract({
      address: SWAP_ROUTER_BASE,
      abi: SWAP_ROUTER_ABI,
      functionName: 'exactInputSingle',
      args: [{
        tokenIn: USDC_BASE,
        tokenOut: WETH_BASE,
        fee: UNISWAP_FEE_TIER,
        recipient: recipientAddress,
        amountIn,
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: 0n,
      }],
      account: recipientAddress,
    })
    const estimated = estimatedOut.result
    // Apply slippage: minOut = estimated * (10000 - slippageBps) / 10000
    amountOutMinimum = (estimated * BigInt(10000 - SLIPPAGE_BPS)) / 10000n
  } catch {
    // Never swap with 0 slippage — vulnerable to sandwich attacks
    throw new Error('swap simulation failed — could not determine safe minimum output. please retry.')
  }

  // 3. Execute swap: USDC → WETH (recipient is this contract for unwrap step)
  //    We send WETH to recipient directly — they can unwrap or we unwrap
  const swapTx = await walletClient.writeContract({
    address: SWAP_ROUTER_BASE,
    abi: SWAP_ROUTER_ABI,
    functionName: 'exactInputSingle',
    args: [{
      tokenIn: USDC_BASE,
      tokenOut: WETH_BASE,
      fee: UNISWAP_FEE_TIER,
      recipient: recipientAddress,
      amountIn,
      amountOutMinimum,
      sqrtPriceLimitX96: 0n,
    }],
    account: recipientAddress,
    chain: baseChain,
  })
  const swapReceipt = await publicClient.waitForTransactionReceipt({ hash: swapTx })

  // 4. Read WETH balance and unwrap to ETH
  const wethBalance = await publicClient.readContract({
    address: WETH_BASE,
    abi: ERC20_BALANCE_ABI,
    functionName: 'balanceOf',
    args: [recipientAddress],
  })

  if (wethBalance > 0n) {
    const unwrapTx = await walletClient.writeContract({
      address: WETH_BASE,
      abi: WETH_WITHDRAW_ABI,
      functionName: 'withdraw',
      args: [wethBalance],
      account: recipientAddress,
      chain: baseChain,
    })
    await publicClient.waitForTransactionReceipt({ hash: unwrapTx })
  }

  return { swapTxHash: swapTx, wethReceived: wethBalance, swapReceipt }
}

// --- Swap ETH → USDC on Base via Uniswap V3 ---

export async function swapEthToUsdc(amountWei, walletClient, recipientAddress) {
  const { createPublicClient, http, parseEther } = await import('./vendor.js')
  const baseChain = {
    id: BASE_CHAIN_ID, name: 'Base',
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [BASE_RPC] } },
  }
  const publicClient = createPublicClient({ chain: baseChain, transport: http(BASE_RPC) })

  const amountIn = BigInt(amountWei)

  // 1. Get quote for minimum USDC output (slippage protection)
  let amountOutMinimum
  try {
    const estimatedOut = await publicClient.simulateContract({
      address: SWAP_ROUTER_BASE,
      abi: SWAP_ROUTER_ABI,
      functionName: 'exactInputSingle',
      args: [{
        tokenIn: WETH_BASE,
        tokenOut: USDC_BASE,
        fee: UNISWAP_FEE_TIER,
        recipient: recipientAddress,
        amountIn,
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: 0n,
      }],
      account: recipientAddress,
      value: amountIn, // ETH sent as msg.value — SwapRouter wraps to WETH
    })
    const estimated = estimatedOut.result
    // Apply 2% slippage: minOut = estimated * (10000 - slippageBps) / 10000
    amountOutMinimum = (estimated * BigInt(10000 - OFFRAMP_SLIPPAGE_BPS)) / 10000n
  } catch {
    // Never swap with 0 slippage — vulnerable to sandwich attacks
    throw new Error('ETH→USDC swap simulation failed — could not determine safe minimum output. please retry.')
  }

  // 2. Execute swap: ETH → USDC (payable — send ETH as value, router wraps to WETH)
  const swapTx = await walletClient.writeContract({
    address: SWAP_ROUTER_BASE,
    abi: SWAP_ROUTER_ABI,
    functionName: 'exactInputSingle',
    args: [{
      tokenIn: WETH_BASE,
      tokenOut: USDC_BASE,
      fee: UNISWAP_FEE_TIER,
      recipient: recipientAddress,
      amountIn,
      amountOutMinimum,
      sqrtPriceLimitX96: 0n,
    }],
    account: recipientAddress,
    chain: baseChain,
    value: amountIn,
  })
  const swapReceipt = await publicClient.waitForTransactionReceipt({ hash: swapTx })

  // 3. Read USDC balance received
  const usdcBalance = await publicClient.readContract({
    address: USDC_BASE,
    abi: ERC20_BALANCE_ABI,
    functionName: 'balanceOf',
    args: [recipientAddress],
  })

  return { swapTxHash: swapTx, usdcReceived: usdcBalance, amountOutMinimum, swapReceipt }
}

// --- Get USDC balance on Base ---

export async function getUsdcBalance(address) {
  const { createPublicClient, http } = await import('./vendor.js')
  const baseChain = {
    id: BASE_CHAIN_ID, name: 'Base',
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [BASE_RPC] } },
  }
  const publicClient = createPublicClient({ chain: baseChain, transport: http(BASE_RPC) })
  const balance = await publicClient.readContract({
    address: USDC_BASE,
    abi: ERC20_BALANCE_ABI,
    functionName: 'balanceOf',
    args: [address],
  })
  return balance
}

// --- Direct indexer quoting (bypasses SDK API, no Privy JWT needed) ---

export async function fetchQuoteFromIndexer(amountUSD, paymentMethod = 'venmo', fiatCurrency = 'USD') {
  const methodHash = PAYMENT_METHOD_HASHES[paymentMethod]
  if (!methodHash || methodHash === '0x0000000000000000000000000000000000000000000000000000000000000000') {
    throw new Error(`unsupported payment method for indexer quoting: ${paymentMethod}`)
  }

  const currencyHash = CURRENCY_HASHES[fiatCurrency]
  if (!currencyHash) throw new Error(`unsupported currency: ${fiatCurrency}`)

  // Convert USD amount to USDC 6-decimal units using string math to avoid float precision
  const amountUsdc = usdToUsdc6(amountUSD)

  // Query the QuoteCandidate table — denormalized view optimized for rate-first quoting
  const query = `query GetQuotes($amount: numeric!, $methodHash: String!, $currencyCode: String!, $escrow: String!) {
    QuoteCandidate(
      where: {
        isActive: { _eq: true },
        hasMinLiquidity: { _eq: true },
        escrowAddress: { _eq: $escrow },
        paymentMethodHash: { _eq: $methodHash },
        currencyCode: { _eq: $currencyCode },
        intentAmountMin: { _lte: $amount },
        intentAmountMax: { _gte: $amount },
        maxTokenAvailablePerIntent: { _gte: $amount }
      },
      order_by: { conversionRate: desc },
      limit: 10
    ) {
      id
      depositId
      depositIdOnContract
      escrowAddress
      depositor
      token
      intentAmountMin
      intentAmountMax
      availableTokenAmount
      maxTokenAvailablePerIntent
      maxFiatAvailablePerIntent
      conversionRate
      takerConversionRate
      paymentMethodHash
      payeeDetailsHash
      currencyCode
      successRateBps
      intentGatingService
      whitelistHookAddress
      managerFee
    }
  }`

  const resp = await fetch(ZKP2P_INDEXER, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      variables: {
        amount: amountUsdc,
        methodHash,
        currencyCode: currencyHash,
        escrow: ESCROW_V2.toLowerCase(),
      },
    }),
  })

  if (!resp.ok) throw new Error(`indexer query failed (${resp.status})`)

  const data = await resp.json()
  if (data.errors?.length) throw new Error(`indexer error: ${data.errors[0].message}`)

  const candidates = data.data?.QuoteCandidate || []
  if (candidates.length === 0) return null

  // Score candidates: prefer deposits without gating service (avoids known InvalidSignature bug),
  // then higher conversion rate + higher success rate
  const ZERO_ADDR = '0x0000000000000000000000000000000000000000'
  const scored = candidates.map(c => {
    const rate = BigInt(c.conversionRate || '0')
    const takerRate = BigInt(c.takerConversionRate || c.conversionRate || '0')
    const successBps = c.successRateBps || 0
    const hasGating = c.intentGatingService && c.intentGatingService !== ZERO_ADDR
    return { ...c, rate, takerRate, successBps, hasGating }
  })

  // Sort: ungated first, then highest taker conversion rate, then success rate
  scored.sort((a, b) => {
    // Prefer ungated deposits (no gating service → no InvalidSignature risk)
    if (a.hasGating !== b.hasGating) return a.hasGating ? 1 : -1
    if (b.takerRate > a.takerRate) return 1
    if (b.takerRate < a.takerRate) return -1
    return b.successBps - a.successBps
  })

  const best = scored[0]

  // Conversion rate is 1e18 fixed-point: rate = (fiat_amount * 1e18) / token_amount
  // For USD→USDC (1:1), rate ≈ 1e18. Spread = (rate - 1e18) / 1e18 * 100
  const RATE_BASE = BigInt('1000000000000000000') // 1e18
  const spreadBps = Number(((best.takerRate - RATE_BASE) * 10000n) / RATE_BASE)
  const spreadPct = (spreadBps / 100).toFixed(2)

  // Calculate USDC amount the taker receives after rate
  // tokenAmount = fiatAmount * 1e18 / conversionRate (in 6-decimal USDC)
  const fiatAmountScaled = BigInt(amountUsdc) * RATE_BASE
  const tokenAmount = fiatAmountScaled / best.takerRate
  const tokenFormatted = formatUsdc(tokenAmount)

  return {
    depositId: best.depositId,
    depositIdOnContract: best.depositIdOnContract,
    escrowAddress: best.escrowAddress,
    orchestratorAddress: ORCHESTRATOR_V2,
    depositor: best.depositor,
    amount: tokenAmount.toString(),
    tokenAmountFormatted: tokenFormatted,
    fiatAmount: amountUsdc,
    fiatAmountFormatted: String(amountUSD),
    conversionRate: best.conversionRate,
    takerConversionRate: best.takerConversionRate || best.conversionRate,
    spread: spreadPct,
    paymentMethodHash: best.paymentMethodHash,
    payeeDetailsHash: best.payeeDetailsHash,
    currencyCode: best.currencyCode,
    processorName: paymentMethod,
    fiatCurrencyCode: fiatCurrency,
    intentAmountMax: best.intentAmountMax,
    maxTokenAvailablePerIntent: best.maxTokenAvailablePerIntent,
    intentGatingService: best.intentGatingService,
    whitelistHookAddress: best.whitelistHookAddress,
    successRateBps: best.successRateBps,
    totalCandidates: candidates.length,
    source: 'indexer',
  }
}

// --- Zkp2pClient initialization ---

let _zkp2pClient = null

export async function initZkp2pClient(walletClient) {
  const sdk = await loadZkp2pSdk()
  const initCfg = {
    walletClient,
    chainId: BASE_CHAIN_ID,
    runtimeEnv: 'production',
    baseApiUrl: 'https://api.zkp2p.xyz',
    apiKey: window.PRAXIS_ZKP2P_KEY || '',
    escrowAddresses: [ESCROW_V2, '0x2f121cddca6d652f35e8b3e560f9760898888888'],
  }
  dbg('[ramp] initZkp2pClient config:', JSON.stringify({
    chainId: initCfg.chainId,
    runtimeEnv: initCfg.runtimeEnv,
    baseApiUrl: initCfg.baseApiUrl,
    apiKeyPresent: !!initCfg.apiKey,
    apiKeyPrefix: initCfg.apiKey?.slice(0, 8),
    escrowAddresses: initCfg.escrowAddresses,
    walletAddress: walletClient?.account?.address,
  }))
  _zkp2pClient = new sdk.Zkp2pClient(initCfg)
  dbg('[ramp] zkp2p SDK client initialized successfully')
  return _zkp2pClient
}

export function getZkp2pClient() {
  return _zkp2pClient
}

// --- Quote via SDK (primary) ---

export async function fetchQuote(mode, amount, paymentMethod = 'venmo') {
  // Use SDK directly — the indexer workaround had schema drift issues
  // Initialize SDK client if not already done
  if (!_zkp2pClient) {
    try {
      const { createWalletClient, createPublicClient, http } = await import('./vendor.js')
      // For quoting, we need a walletClient but don't need signing capability yet
      // Try embedded account first, fall back to a public-client-based approach
      let wc
      const embeddedAcct = window.getEmbeddedAccount?.()
      if (embeddedAcct) {
        wc = createWalletClient({ chain: BASE_CHAIN, transport: http(BASE_RPC), account: embeddedAcct })
      } else {
        // No signing account yet — create a minimal walletClient with the user's address
        // getQuote only needs the address, not signing capability
        const addr = window.getWalletAddress?.()
        if (addr) {
          wc = createWalletClient({ chain: BASE_CHAIN, transport: http(BASE_RPC), account: window.getEmbeddedAccount?.() || addr })
        }
      }
      if (wc) await initZkp2pClient(wc)
    } catch (e) { console.warn('praxis: zkp2p client init for quote failed:', e?.message) }
  }
  const userAddr = window.getWalletAddress?.()
  if (_zkp2pClient && userAddr) {
    try {
      // SDK getQuote with isExactFiat expects USDC decimals ("20000000" for $20)
      const amountUsdc = usdToUsdc6(Number(amount))
      const quoteResp = await _zkp2pClient.getQuote({
        paymentPlatforms: [paymentMethod],
        fiatCurrency: PAYMENT_METHOD_CURRENCIES[paymentMethod] || 'USD',
        user: userAddr,
        recipient: userAddr,
        destinationChainId: BASE_CHAIN_ID,
        destinationToken: USDC_BASE,
        amount: amountUsdc,
        isExactFiat: mode === 'onramp',
      })
      if (quoteResp?.success && quoteResp.responseObject?.quotes?.length) {
        const quotes = quoteResp.responseObject.quotes
        const best = quotes[0]
        return {
          amount: best.tokenAmountFormatted || best.intent?.amount || amount,
          fiatAmount: best.fiatAmountFormatted || amount,
          rate: best.conversionRate,
          fee: quoteResp.responseObject?.fees?.totalFee || '0',
          source: 'sdk',
          quotes: quotes.map(q => ({
            tokenAmount: q.tokenAmountFormatted || q.intent?.amount,
            fiatAmount: q.fiatAmountFormatted,
            rate: q.conversionRate,
            depositId: q.intent?.depositId,
            processorName: q.intent?.processorName,
            depositor: q.intent?.depositor || q.depositor || null,
            payeeData: q.payeeData || null,
          })),
        }
      }
      return { amount: '~', fiatAmount: String(amount), rate: null, fee: '0', source: 'none', quotes: [] }
    } catch (e) {
      console.warn('praxis: SDK quote failed, showing estimate:', e?.message)
      return { amount: '~', fiatAmount: String(amount), rate: null, fee: '0', source: 'none' }
    }
  }
  // No SDK client yet — return placeholder (will be refined when SDK inits)
  return { amount: '~', fiatAmount: String(amount), rate: null, fee: '0', source: 'none' }
}

// --- Deposit quote: indexer-first, SDK fallback ---

export async function getDepositQuote(client, amountUSD, paymentMethod, recipientAddress) {
  // 1. Try direct indexer quoting (no auth/JWT needed)
  try {
    const fiatCurrency = PAYMENT_METHOD_CURRENCIES[paymentMethod] || 'USD'
    const indexerQuote = await fetchQuoteFromIndexer(amountUSD, paymentMethod, fiatCurrency)
    if (indexerQuote) {
      const quote = {
        depositId: indexerQuote.depositIdOnContract,
        escrowAddress: indexerQuote.escrowAddress,
        orchestratorAddress: ORCHESTRATOR_V2,
        amount: indexerQuote.amount,
        signalIntentAmount: indexerQuote.amount,
        tokenAmountFormatted: indexerQuote.tokenAmountFormatted,
        fiatAmountFormatted: indexerQuote.fiatAmountFormatted,
        conversionRate: indexerQuote.conversionRate,
        processorName: paymentMethod,
        payeeDetails: indexerQuote.payeeDetailsHash,
        fiatCurrencyCode: indexerQuote.fiatCurrencyCode,
        paymentMethodHash: indexerQuote.paymentMethodHash,
        currencyCode: indexerQuote.currencyCode,
        intentAmountMax: indexerQuote.intentAmountMax,
        maxTokenAvailablePerIntent: indexerQuote.maxTokenAvailablePerIntent,
        payeeData: {},
        fees: {},
        source: 'indexer',
      }
      // Log gating service info for debugging InvalidSignature issues
      if (indexerQuote.intentGatingService && indexerQuote.intentGatingService !== '0x0000000000000000000000000000000000000000') {
        dbg('[ramp] deposit has gating service:', indexerQuote.intentGatingService, '— may hit InvalidSignature bug')
      } else {
        dbg('[ramp] deposit has no gating service — should work without signature issues')
      }
      return quote
    }
  } catch (e) {
    console.warn('praxis: indexer deposit quote failed, trying SDK:', e?.message)
  }

  // 2. Fall back to SDK (needs Privy JWT auth)
  if (!client) throw new Error('no liquidity available for this amount and payment method')

  // SDK getQuote with isExactFiat expects human-readable amount ("20" for $20), NOT micro-units
  const quoteResp = await client.getQuote({
    paymentPlatforms: [paymentMethod],
    fiatCurrency: PAYMENT_METHOD_CURRENCIES[paymentMethod] || 'USD',
    user: recipientAddress,
    recipient: recipientAddress,
    destinationChainId: BASE_CHAIN_ID,
    destinationToken: USDC_BASE,
    amount: String(Number(amountUSD)),
    isExactFiat: true,
  })

  if (!quoteResp.success || !quoteResp.responseObject?.quotes?.length) {
    throw new Error('no liquidity available for this amount and payment method')
  }

  const best = quoteResp.responseObject.quotes[0]
  return {
    depositId: best.intent.depositId,
    escrowAddress: best.intent.escrowAddress,
    orchestratorAddress: best.intent.orchestratorAddress,
    amount: best.intent.amount,
    signalIntentAmount: best.signalIntentAmount || best.intent.amount,
    tokenAmountFormatted: best.tokenAmountFormatted,
    fiatAmountFormatted: best.fiatAmountFormatted,
    conversionRate: best.conversionRate,
    processorName: best.intent.processorName,
    payeeDetails: best.intent.payeeDetails,
    fiatCurrencyCode: best.intent.fiatCurrencyCode,
    payeeData: best.payeeData,
    fees: quoteResp.responseObject.fees,
    source: 'sdk',
  }
}

// --- Intent signaling: direct contract call for indexer quotes, SDK fallback ---

// Minimal OrchestratorV2 ABI for signalIntent
const ORCHESTRATOR_V2_ABI = [{
  inputs: [{
    components: [
      { name: 'escrow', type: 'address' },
      { name: 'depositId', type: 'uint256' },
      { name: 'amount', type: 'uint256' },
      { name: 'to', type: 'address' },
      { name: 'paymentMethod', type: 'bytes32' },
      { name: 'fiatCurrency', type: 'bytes32' },
      { name: 'conversionRate', type: 'uint256' },
      { name: 'referralFees', type: 'tuple[]', components: [
        { name: 'recipient', type: 'address' },
        { name: 'fee', type: 'uint256' },
      ]},
      { name: 'gatingServiceSignature', type: 'bytes' },
      { name: 'signatureExpiration', type: 'uint256' },
      { name: 'postIntentHook', type: 'address' },
      { name: 'preIntentHookData', type: 'bytes' },
      { name: 'data', type: 'bytes' },
    ],
    name: '_params',
    type: 'tuple',
  }],
  name: 'signalIntent',
  outputs: [],
  stateMutability: 'nonpayable',
  type: 'function',
}]

// IntentSignaled event — used to extract intentHash from tx receipt logs
const INTENT_SIGNALED_EVENT_ABI = [{
  type: 'event',
  name: 'IntentSignaled',
  inputs: [
    { name: 'intentHash', type: 'bytes32', indexed: true },
    { name: 'depositId', type: 'uint256', indexed: true },
    { name: 'escrow', type: 'address', indexed: false },
    { name: 'owner', type: 'address', indexed: false },
    { name: 'to', type: 'address', indexed: false },
    { name: 'amount', type: 'uint256', indexed: false },
  ],
}]

/** Extract intentHash from a signalIntent tx receipt by parsing IntentSignaled event logs */
export function extractIntentHash(receipt) {
  if (!receipt?.logs?.length) return null
  // IntentSignaled: intentHash is topic[1] (first indexed param), depositId is topic[2]
  for (const log of receipt.logs) {
    if (log.address?.toLowerCase() === ESCROW_V2.toLowerCase() && log.topics?.length >= 3) {
      return log.topics[1] // intentHash
    }
  }
  // Fallback: first log with 3+ topics (from orchestrator relay)
  for (const log of receipt.logs) {
    if (log.topics?.length >= 3) return log.topics[1]
  }
  return null
}

// --- Debug + capture interceptor for v3/intent API calls ---
// Captures the most-recent depositData (cashtag, username, etc.) so the UI can show
// "Send to: $cashtag". The SDK doesn't expose this; only the v3/intent API response does.
let _intentFetchDebugInstalled = false
let _lastIntentDepositData = null
let _origFetch = null
export function getLastIntentDepositData() { return _lastIntentDepositData }
export function _removeIntentFetchDebug() {
  if (_origFetch) { window.fetch = _origFetch; _origFetch = null }
  _intentFetchDebugInstalled = false
}
function _installIntentFetchDebug() {
  if (_intentFetchDebugInstalled) return
  _intentFetchDebugInstalled = true
  _origFetch = window.fetch
  const origFetch = _origFetch
  window.fetch = async function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url
    const isIntent = url && (url.includes('/v3/intent') || url.includes('/intent'))
    if (isIntent) {
      try {
        const reqBody = args[1]?.body
        const parsed = reqBody ? JSON.parse(reqBody) : null
        dbg('[ramp] fetch intent request:', url, parsed)
        if (parsed?.callerAddress) dbg('[ramp] intent callerAddress sent to API:', parsed.callerAddress)
      } catch { dbg('[ramp] fetch intent request:', url, '(body not parseable)') }
    }
    const resp = await origFetch.apply(this, args)
    if (isIntent) {
      try {
        const clone = resp.clone()
        const body = await clone.json()
        dbg('[ramp] fetch intent response:', resp.status, JSON.stringify(body))
        // Capture depositData for the UI
        const dd = body?.responseObject?.depositData
        if (dd && (dd.cashtag || dd.username || dd.email || dd.phone || dd.handle)) {
          _lastIntentDepositData = dd
        }
      } catch { dbg('[ramp] fetch intent response:', resp.status, '(body not parseable)') }
    }
    return resp
  }
  dbg('[ramp] intent fetch debug interceptor installed')
}

export async function signalOnrampIntent(client, depositQuote, recipientAddress, walletClient = null) {
  // Validate amount against quote limits before signaling (Fix #4)
  const intentAmount = BigInt(depositQuote.signalIntentAmount || depositQuote.amount)
  // Praxis floor: $20 minimum in either direction. Some deposits require higher; we honor that too.
  const PRAXIS_MIN_INTENT = 20_000000n // $20 USDC (6 decimals)
  const minIntent = depositQuote.intentAmountMin ? BigInt(depositQuote.intentAmountMin) : PRAXIS_MIN_INTENT
  const effectiveMin = minIntent > PRAXIS_MIN_INTENT ? minIntent : PRAXIS_MIN_INTENT
  if (intentAmount < effectiveMin) {
    throw new Error(`minimum amount is ${formatUsdc(effectiveMin)} USDC. increase your amount.`)
  }
  if (depositQuote.intentAmountMax) {
    const max = BigInt(depositQuote.intentAmountMax)
    if (intentAmount > max) {
      throw new Error(`amount exceeds maximum per intent (${formatUsdc(max)} USDC). reduce your amount.`)
    }
  }
  if (depositQuote.maxTokenAvailablePerIntent) {
    const maxAvail = BigInt(depositQuote.maxTokenAvailablePerIntent)
    if (intentAmount > maxAvail) {
      throw new Error(`amount exceeds available liquidity (${formatUsdc(maxAvail)} USDC). try a smaller amount.`)
    }
  }

  // Always use SDK signalIntent — it handles gating service signature automatically with API key.
  // Direct contract calls with gatingServiceSignature: '0x' fail on deposits that require valid gating sigs.
  if (!client) throw new Error('zkp2p SDK client required — unlock your wallet first')

  const intentParams = {
    depositId: BigInt(depositQuote.depositId),
    amount: BigInt(depositQuote.signalIntentAmount || depositQuote.amount),
    toAddress: recipientAddress,
    processorName: depositQuote.processorName,
    payeeDetails: depositQuote.payeeDetails || '',
    fiatCurrencyCode: depositQuote.fiatCurrencyCode || 'USD',
    conversionRate: BigInt(depositQuote.conversionRate || '0'),
    escrowAddress: depositQuote.escrowAddress,
    orchestratorAddress: depositQuote.orchestratorAddress || ORCHESTRATOR_V2,
  }
  dbg('[ramp] signalIntent params:', JSON.stringify(intentParams, (k, v) => typeof v === 'bigint' ? v.toString() : v))
  dbg('[ramp] depositQuote details:', JSON.stringify({
    escrowAddress: depositQuote.escrowAddress,
    orchestratorAddress: depositQuote.orchestratorAddress,
    depositId: depositQuote.depositId,
    processorName: depositQuote.processorName,
    payeeDetails: depositQuote.payeeDetails,
    fiatCurrencyCode: depositQuote.fiatCurrencyCode,
    conversionRate: depositQuote.conversionRate,
    amount: depositQuote.amount,
    signalIntentAmount: depositQuote.signalIntentAmount,
    intentAmountMax: depositQuote.intentAmountMax,
    maxTokenAvailablePerIntent: depositQuote.maxTokenAvailablePerIntent,
  }))

  // Install debug fetch interceptor to capture v3/intent API calls
  _installIntentFetchDebug()

  // Simulate first with prepare + eth_call to catch revert before wallet prompt
  let txHash
  try {
    const prepared = await client.signalIntent.prepare(intentParams)
    // Resolve the actual signer address — try the SDK first, fall back to the explicit walletClient passed in
    const sdkWalletAddr = client.config?.getWalletClient?.()?.account?.address
      || client.walletClient?.account?.address
      || walletClient?.account?.address
    dbg('[ramp] signalIntent prepared:', { to: prepared.to, value: String(prepared.value), chainId: prepared.chainId, dataLen: prepared.data?.length })
    // Full calldata for zkp2p team debugging (callerAddress + preIntentHookData verification)
    dbg('[ramp] signalIntent calldata:', prepared.data)
    dbg('[ramp] callerAddress (signer wallet):', sdkWalletAddr)
    dbg('[ramp] tx sender (msg.sender):', sdkWalletAddr, '— must match callerAddress above')
    if (!sdkWalletAddr) console.warn('[ramp] could not resolve signer address — simulation may fail with InvalidSignature')

    // Simulate the transaction via eth_call to detect revert before sending
    try {
      const simResp = await fetch(BASE_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'eth_call',
          params: [{ from: sdkWalletAddr, to: prepared.to, data: prepared.data, value: '0x0' }, 'latest']
        })
      })
      const simResult = await simResp.json()
      if (simResult.error) {
        console.error('[ramp] simulation failed:', simResult.error)
        const errData = simResult.error.data || ''
        if (errData.startsWith('0x')) console.error('[ramp] revert data:', errData)
        if (errData.startsWith('0x8baa579f')) throw new Error('InvalidSignature() — check console for callerAddress vs msg.sender mismatch or preIntentHookData encoding issue.')
        // 0x38fcec43 = MinIntentAmount(uint256 actual, uint256 required) — decode the required amount
        if (errData.startsWith('0x38fcec43') && errData.length >= 138) {
          const required = BigInt('0x' + errData.slice(74, 138))
          throw new Error(`minimum amount for this deposit is ${formatUsdc(required)} USDC. increase your amount.`)
        }
      } else {
        dbg('[ramp] simulation succeeded')
      }
    } catch (simErr) {
      const m = simErr.message || ''
      if (m.includes('InvalidSignature') || m.includes('minimum amount')) throw simErr
      console.warn('[ramp] simulation check failed (non-fatal):', m)
    }

    // Send the actual transaction — prefer the explicit walletClient (matches the one passed to initZkp2pClient)
    const wc = walletClient || client.config?.getWalletClient?.() || client.walletClient
    if (!wc) throw new Error('wallet client not available — pass walletClient to signalOnrampIntent')
    txHash = await wc.sendTransaction({
      to: prepared.to,
      data: prepared.data,
      value: prepared.value || 0n,
      account: wc.account,
      chain: wc.chain,
    })
  } catch (e) {
    const msg = e?.message || ''
    console.error('[ramp] signalIntent error:', msg)
    console.error('[ramp] signalIntent error full:', e)
    if (e?.data) console.error('[ramp] signalIntent error.data (revert):', e.data)
    if (e?.cause) console.error('[ramp] signalIntent error.cause:', e.cause)
    if (e?.error) console.error('[ramp] signalIntent inner error:', e.error)
    // Surface specific errors
    if (msg.includes('EOA wallet required') || msg.includes('401')) {
      throw new Error('Venmo requires taker registration and is not supported — please use Wise, Revolut, or Cash App instead.')
    }
    if (msg.includes('InvalidSignature')) {
      throw new Error('signature validation failed on-chain — open browser console and share the callerAddress + calldata logs with the zkp2p team.')
    }
    if (msg.includes('gatingServiceSignature')) {
      throw new Error('unable to authorize intent — try a smaller amount or different payment method.')
    }
    if (msg.includes('Too many requests') || msg.includes('429')) {
      throw new Error('zkp2p rate limit hit — wait ~30 seconds and try again.')
    }
    // Decode 0x38fcec43 = MinIntentAmount(uint256 actual, uint256 required)
    // Check both top-level error.data and viem's nested cause.data
    const revertData = e?.data || e?.cause?.data || (msg.match(/0x38fcec43[a-f0-9]+/i)?.[0]) || ''
    if (typeof revertData === 'string' && revertData.startsWith('0x38fcec43') && revertData.length >= 138) {
      const required = BigInt('0x' + revertData.slice(74, 138))
      throw new Error(`minimum amount for this deposit is ${formatUsdc(required)} USDC. increase your amount.`)
    }
    // Insufficient gas can be a real issue, but is also a *symptom* of a reverting call
    // (viem falls back to a huge gas estimate when the call would revert).
    // Only surface this when the call actually reaches the wallet rather than during gas estimation.
    if ((msg.includes('insufficient funds for gas') || e?.cause?.name === 'InsufficientFundsError') && !revertData) {
      throw new Error('not enough Base ETH for gas. bridge a tiny amount of ETH to Base via "add funds" first.')
    }
    throw e
  }

  // Extract intentHash from tx receipt
  let intentHash = null
  try {
    const { createPublicClient, http } = await import('./vendor.js')
    const publicClient = createPublicClient({ chain: BASE_CHAIN, transport: http(BASE_RPC) })
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash })
    intentHash = extractIntentHash(receipt)
  } catch (e) {
    console.warn('[ramp] could not extract intentHash from receipt:', e?.message)
  }

  return { txHash, intentHash, source: 'sdk' }
}

// --- Intent status polling via SDK ---

export async function pollIntentFulfillment(client, ownerAddress, onStatus, knownIntentHash = null) {
  const startTime = Date.now()

  while (Date.now() - startTime < INTENT_TIMEOUT_MS) {
    try {
      // If we have the specific intentHash from the tx receipt, poll directly for it
      if (knownIntentHash) {
        try {
          const fulfillments = await client.indexer.getFulfilledIntentEvents([knownIntentHash])
          if (fulfillments.length > 0) {
            onStatus?.('fulfilled')
            return { status: 'fulfilled', intentHash: knownIntentHash }
          }
        } catch {
          // indexer may lag, continue polling
        }
      } else {
        // Fallback: scan account intents (less reliable if user has prior intents)
        const intents = await client.getAccountIntents(ownerAddress)
        if (intents.length > 0) {
          const latest = intents[intents.length - 1]
          const hash = latest.intentHash
          try {
            const fulfillments = await client.indexer.getFulfilledIntentEvents([hash])
            if (fulfillments.length > 0) {
              onStatus?.('fulfilled')
              return { status: 'fulfilled', intentHash: hash }
            }
          } catch {
            // indexer may lag, continue polling
          }
        }
      }
    } catch {
      // transient error, keep polling
    }

    onStatus?.('polling')
    await new Promise(r => setTimeout(r, INTENT_POLL_MS))
  }

  return { status: 'timeout' }
}

// --- Format payment instructions ---

function formatPaymentInstructions(depositQuote) {
  const method = depositQuote.processorName || 'payment app'
  const amount = depositQuote.fiatAmountFormatted || '?'
  const target = formatPayTarget(depositQuote)
  const hasTarget = !!target
  const label = PAYMENT_METHOD_LABEL[method] || (method.charAt(0).toUpperCase() + method.slice(1))
  return {
    method: label,
    methodId: method,
    amount: `$${amount}`,
    amountNum: amount,
    target,
    hasTarget,
    note: hasTarget ? 'send exact amount — proof is verified automatically' : 'payment details unavailable — contact support',
  }
}

// --- Modal rendering ---

function createModal() {
  const overlay = document.createElement('div')
  overlay.className = 'praxis-modal-overlay'
  const dialog = document.createElement('div')
  dialog.className = 'praxis-modal-dialog'
  dialog.style.maxWidth = '420px'
  dialog.style.fontFamily = 'inherit'
  overlay.appendChild(dialog)

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove()
  })

  document.addEventListener('keydown', function escHandler(e) {
    if (e.key === 'Escape') {
      overlay.remove()
      document.removeEventListener('keydown', escHandler)
    }
  })

  return { overlay, dialog }
}

/**
 * Cancel an intent on-chain. The SDK's `client.cancelIntent()` internally calls
 * `wc.sendTransaction()` without `account`, which causes viem to fall back to
 * `eth_sendTransaction` — rejected by Alchemy. We bypass this by preparing the
 * calldata via `prepareCancelIntent` and sending the tx ourselves with an
 * embedded-account walletClient (signs locally → eth_sendRawTransaction).
 */
export async function cancelIntentOnChain(client, intentHash, walletClient = null) {
  if (!intentHash) throw new Error('intentHash required')
  if (!client?.prepareCancelIntent) throw new Error('SDK does not expose prepareCancelIntent')
  const prepared = await client.prepareCancelIntent({ intentHash })
  let wc = walletClient
  if (!wc) {
    const embeddedAcct = window.getEmbeddedAccount?.()
    if (!embeddedAcct) throw new Error('embedded wallet required')
    const { createWalletClient, http } = await import('./vendor.js')
    wc = createWalletClient({ chain: BASE_CHAIN, transport: http(BASE_RPC), account: embeddedAcct })
  }
  return await wc.sendTransaction({
    to: prepared.to,
    data: prepared.data,
    value: prepared.value || 0n,
    account: wc.account,
    chain: wc.chain,
  })
}

// Compact payment-method chip row used by the offramp form
function renderPaymentMethods(selected) {
  return PAYMENT_METHODS.map(m => {
    const active = m.id === selected && !m.disabled
    const dim = m.disabled
    return `<button class="ramp-method-btn" data-method="${m.id}" ${m.disabled ? 'disabled' : ''} title="${m.disabled ? (m.disabledReason || 'unavailable') : ''}" style="display:flex;align-items:center;gap:0.5ch;padding:0.4em 0.8em;background:${active ? 'var(--accent, #a0a0a0)' : 'none'};color:${active ? '#000' : dim ? 'var(--muted, #555)' : 'var(--fg, #c0c0c0)'};border:1px solid ${active ? 'var(--accent, #a0a0a0)' : 'var(--border, #333)'};cursor:${dim ? 'not-allowed' : 'pointer'};font-family:inherit;font-size:0.85em;opacity:${dim ? '0.4' : '1'}"><i class="ph ${m.icon}" style="font-size:1em"></i>${m.label}${dim ? ` <span style="font-size:0.75em">(${m.disabledReason || 'soon'})</span>` : ''}</button>`
  }).join('')
}

// --- Peer-style ramp UI helpers ---

const PAYMENT_METHOD_LABEL = {
  wise: 'Wise', revolut: 'Revolut', cashapp: 'Cash App', venmo: 'Venmo', paypal: 'PayPal',
}

function _stepsHtml(activeStep, doneSteps = []) {
  // activeStep: 'payment' | 'authenticate' | 'verify' | null
  // doneSteps: subset of ['payment','authenticate','verify']
  const steps = [
    { id: 'payment', label: 'Payment', icon: 'ph-paper-plane-tilt' },
    { id: 'authenticate', label: 'Authenticate', icon: 'ph-key' },
    { id: 'verify', label: 'Verify', icon: 'ph-check-circle' },
  ]
  let html = '<div class="ramp-steps">'
  steps.forEach((s, i) => {
    const isDone = doneSteps.includes(s.id)
    const isActive = activeStep === s.id
    const cls = isDone ? 'done' : isActive ? 'active' : ''
    html += `<div class="ramp-step ${cls}"><div class="ramp-step-icon"><i class="ph ${s.icon}"></i></div><div class="ramp-step-label">${s.label}</div></div>`
    if (i < steps.length - 1) {
      const lineDone = isDone || (isActive && doneSteps.includes(steps[i].id))
      html += `<div class="ramp-step-line ${doneSteps.includes(s.id) ? 'done' : ''}"></div>`
    }
  })
  html += '</div>'
  return html
}

function _formatTimer(ms) {
  if (ms <= 0) return 'expired'
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m left`
  if (m > 0) return `${m}m ${s}s left`
  return `${s}s left`
}

// Deterministic, friendly memo derived from intent hash — avoids triggers like "crypto", "peer"
const MEMO_WORDS = ['Parking', 'Coffee', 'Lunch', 'Dinner', 'Books', 'Snacks', 'Gas', 'Bagels', 'Tickets', 'Pizza', 'Tacos', 'Smoothie', 'Cookies', 'Bills', 'Paint']
function _suggestedMemo(intentHash) {
  if (!intentHash) return MEMO_WORDS[0]
  let h = 0
  for (let i = 0; i < intentHash.length; i++) h = (h * 31 + intentHash.charCodeAt(i)) >>> 0
  return MEMO_WORDS[h % MEMO_WORDS.length]
}

// Build a payment-app deep link for a given processor + recipient + amount.
// Cash App: https://cash.app/$cashtag/AMOUNT (prefills both)
// Venmo:    https://venmo.com/USERNAME?txn=pay&amount=AMOUNT&note=
// Wise/Revolut/PayPal don't have a public deeplink — return the cashtag/email only.
function _buildPaymentDeepLink(instructions, amountUsd) {
  if (!instructions?.target) return ''
  const amt = String(amountUsd || instructions.amountNum || '').replace(/[^0-9.]/g, '')
  switch (instructions.methodId) {
    case 'cashapp': {
      const tag = instructions.target.replace(/^\$/, '')
      return amt ? `https://cash.app/$${tag}/${amt}` : `https://cash.app/$${tag}`
    }
    case 'venmo': {
      const user = instructions.target.replace(/^@/, '')
      return `https://venmo.com/${user}?txn=pay&amount=${amt}&note=`
    }
    default:
      return ''
  }
}

function formatPayTarget(depositQuote) {
  const d = depositQuote?.depositData || depositQuote?.payeeData || {}
  if (d.cashtag) return `$${d.cashtag.replace(/^\$/, '')}`
  if (d.username) return `@${d.username}`
  if (d.email) return d.email
  if (d.phone) return d.phone
  if (d.handle) return d.handle
  if (d.accountId) return d.accountId
  return ''
}

// --- Pending intent persistence (survives page refresh) ---
// Peer keeps the intent visible for 6h after signaling so users can resume mid-flow.
// We mirror that with a localStorage cache keyed by wallet address.
const PENDING_INTENT_KEY = 'praxis-ramp-pending'
const PENDING_INTENT_TTL = 6 * 60 * 60 * 1000 // 6h, matches deposit expiration

function savePendingIntent(wallet, data) {
  if (!wallet) return
  try {
    const payload = { ...data, wallet: wallet.toLowerCase(), savedAt: Date.now() }
    // Strip non-serializable fields (BigInts) by stringifying with a replacer
    const safe = JSON.stringify(payload, (k, v) => typeof v === 'bigint' ? v.toString() : v)
    localStorage.setItem(PENDING_INTENT_KEY, safe)
  } catch (e) { console.warn('[ramp] failed to persist intent:', e?.message) }
}

function loadPendingIntent(wallet) {
  if (!wallet) return null
  try {
    const raw = localStorage.getItem(PENDING_INTENT_KEY)
    if (!raw) return null
    const data = JSON.parse(raw)
    if (data.wallet !== wallet.toLowerCase()) return null
    if (Date.now() - (data.savedAt || 0) > PENDING_INTENT_TTL) {
      localStorage.removeItem(PENDING_INTENT_KEY)
      return null
    }
    return data
  } catch { return null }
}

function clearPendingIntent() {
  try { localStorage.removeItem(PENDING_INTENT_KEY) } catch {}
}

// --- Onramp Modal ---

export async function showOnrampModal(recipientAddress, amountUSD = 20) {
  const { overlay, dialog } = createModal()
  dialog.classList.add('ramp-dialog')
  dialog.style.maxWidth = '460px'
  let currentMethod = getPreferredMethod()
  let currentAmount = amountUSD
  let quoteData = null
  let depositQuote = null
  let paymentInstructions = null
  let intentHash = null
  let confirmChecked = false
  let paymentExpiresAt = 0
  let _timerInterval = null
  let status = STATUS.idle
  let errorMessage = ''
  let successMessage = ''
  let _pollTimer = null
  let _destroyed = false
  // Hoisted out of render() so debounce survives re-renders. Otherwise every render
  // recreates the local timer var → previous keystroke's pending fetch never gets cancelled
  // and rapid typing fires N requests, hitting zkp2p's rate limit.
  let _quoteDebounce = null
  let _quoteSeq = 0 // monotonic seq — only the latest fetch's result is applied
  // Shared "I've sent the payment" deferred — resolves whether the click happens during
  // the original runOnramp() flow or after a restore from localStorage.
  let _paidClicked = false
  let _paidResolver = null
  let _postPayRunning = false
  function _markPaid() {
    if (_paidClicked) return
    _paidClicked = true
    if (_paidResolver) { _paidResolver(); _paidResolver = null }
  }

  // Restore any pending intent from a previous session (survives page refresh)
  const pending = loadPendingIntent(recipientAddress)
  if (pending) {
    intentHash = pending.intentHash
    depositQuote = pending.depositQuote
    paymentInstructions = pending.paymentInstructions
    paymentExpiresAt = pending.paymentExpiresAt
    currentAmount = pending.currentAmount || amountUSD
    currentMethod = pending.currentMethod || currentMethod
    status = STATUS.paying
    dbg('[ramp] restored pending intent:', intentHash)
  }

  function cleanup() {
    _destroyed = true
    if (_pollTimer) clearTimeout(_pollTimer)
    if (_timerInterval) clearInterval(_timerInterval)
    _removeIntentFetchDebug()
  }

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) { cleanup(); overlay.remove() }
  })

  // Determine which view to show based on status + state
  function currentView() {
    if (status === STATUS.done) return 'done'
    if (status === STATUS.bridging || status === STATUS.swapping || status === STATUS.funded) return 'verify'
    if (status === STATUS.paying && paymentInstructions) return 'pay'
    // matching/quoting/idle/error
    return 'buy'
  }

  function render() {
    const view = currentView()
    const canEdit = status === STATUS.idle || status === STATUS.quoting || status === STATUS.error

    // Header
    let headerTitle = 'BUY'
    if (view === 'pay') headerTitle = 'COMPLETE PAYMENT'
    else if (view === 'verify') headerTitle = 'VERIFY PAYMENT'
    else if (view === 'done') headerTitle = 'COMPLETE'

    let html = ''
    html += `<div class="ramp-header">
      <button class="ramp-header-back" id="ramp-cancel" title="close"><i class="ph ph-arrow-left"></i></button>
      <div class="ramp-header-title">${headerTitle}</div>
      <div class="ramp-header-spacer"></div>
    </div>`

    // Buy view
    if (view === 'buy') {
      const tokenAmount = (quoteData && quoteData.amount !== '~') ? quoteData.amount : currentAmount
      const rate = (quoteData && quoteData.rate)
        ? (Number(quoteData.rate) / 1e18).toFixed(3).replace(/\.?0+$/, '')
        : '1'
      const fiatCcy = PAYMENT_METHOD_CURRENCIES[currentMethod] || 'USD'
      const methodLabel = PAYMENT_METHOD_LABEL[currentMethod] || currentMethod
      const methodIcon = PAYMENT_METHODS.find(p => p.id === currentMethod)?.icon || 'ph-currency-circle-dollar'
      const quoteCount = quoteData?.quotes?.length || 0

      html += `<div class="ramp-tabs">
        <button class="ramp-tab active" data-tab="buy">BUY</button>
        <button class="ramp-tab" data-tab="sell">SELL</button>
      </div>`

      html += `<div class="ramp-body">`

      // If a stale pending intent exists (from localStorage or on-chain) but we ended up on the Buy view,
      // surface a banner so the user can resume or discard it without having to navigate around.
      const stalePending = loadPendingIntent(recipientAddress)
      if (stalePending && status !== STATUS.paying) {
        const stub = stalePending.depositQuote || {}
        const stubMethod = PAYMENT_METHOD_LABEL[stub.processorName] || stub.processorName || 'Cash App'
        const stubAmount = stub.fiatAmountFormatted || stalePending.currentAmount || '?'
        html += `<div class="ramp-status-msg" style="display:flex;align-items:center;gap:0.6em;flex-wrap:wrap">
          <i class="ph ph-clock" style="font-size:1em;color:var(--accent)"></i>
          <span style="flex:1">pending order: $${stubAmount} via ${stubMethod}</span>
          <button class="ramp-method-pill" id="ramp-resume-pending" style="font-size:0.75em;padding:0.25em 0.7ch">resume</button>
          <button class="ramp-method-pill" id="ramp-discard-pending" style="font-size:0.75em;padding:0.25em 0.7ch;border-color:var(--red,#a44);color:var(--red,#a44)">discard</button>
        </div>`
      }
      html += `<div class="ramp-input-card">
        <div class="ramp-input-label">You send</div>
        <div class="ramp-input-row">
          <input id="ramp-amount" class="ramp-amount-input" type="number" min="1" step="1" value="${currentAmount}" ${canEdit ? '' : 'disabled'} />
          <span class="ramp-currency-pill"><i class="ph ph-flag" style="font-size:0.95em"></i>${fiatCcy}</span>
        </div>
      </div>`

      html += `<div class="ramp-input-card">
        <div class="ramp-input-label">Paying using</div>
        <div class="ramp-input-row">
          <button id="ramp-method-picker" class="ramp-method-pill"><i class="ph ${methodIcon}"></i>${methodLabel}<i class="ph ph-caret-down" style="font-size:0.75em"></i></button>
        </div>
      </div>`

      html += `<div class="ramp-input-card">
        <div class="ramp-input-label">You receive</div>
        <div class="ramp-input-row">
          <div class="ramp-amount-input" style="pointer-events:none">${tokenAmount}</div>
          <span class="ramp-currency-pill"><i class="ph ph-coin" style="font-size:0.95em"></i>USDC</span>
        </div>
        <div class="ramp-receive-meta"><span>≈ $${currentAmount}</span><span>auto-bridged to Optimism</span></div>
      </div>`

      if (status === STATUS.quoting) {
        html += `<div class="ramp-status-msg"><i class="ph ph-spinner" style="animation:spin 1s linear infinite"></i> fetching best rate…</div>`
      } else if (quoteData && quoteData.amount !== '~') {
        const bestQuote = quoteData.quotes?.[0]
        const depShort = bestQuote?.depositor ? `${bestQuote.depositor.slice(0, 6)}…${bestQuote.depositor.slice(-4)}` : ''
        const appLabel = PAYMENT_METHOD_LABEL[bestQuote?.processorName || currentMethod] || methodLabel
        html += `<div class="ramp-rate-row" id="ramp-view-quotes">
          <div style="flex:1">
            <div class="ramp-rate-info">
              <span class="ramp-rate-text">1 USDC = ${rate} ${fiatCcy}</span>
              <span class="ramp-rate-best">BEST</span>
            </div>
            <div class="ramp-rate-meta">
              ${depShort ? `<span>${depShort}</span><span>·</span>` : ''}
              <span>${appLabel}</span>
              ${quoteCount > 1 ? `<span>·</span><span style="color:var(--accent)">${quoteCount} quotes</span>` : ''}
            </div>
          </div>
          ${quoteCount > 1 ? `<span class="ramp-rate-arrow">›</span>` : ''}
        </div>`
      }

      if (status === STATUS.error && errorMessage) {
        html += `<div class="ramp-status-msg error">${escapeHtml(errorMessage)}</div>`
      }
      if (status === STATUS.matching) {
        html += `<div class="ramp-status-msg"><i class="ph ph-spinner" style="animation:spin 1s linear infinite"></i> finding liquidity…</div>`
      }

      html += `<button id="ramp-confirm" class="ramp-primary-btn" ${canEdit ? '' : 'disabled'}>${status === STATUS.matching ? 'STARTING…' : 'START ORDER'}</button>`
      html += `</div>` // ramp-body
    }

    // Payment view
    else if (view === 'pay') {
      html += _stepsHtml('payment', [])
      html += `<div class="ramp-body">`

      const remaining = paymentExpiresAt - Date.now()
      html += `<div class="ramp-timer" id="ramp-timer"><i class="ph ph-clock"></i> Order expires in ${_formatTimer(remaining)}</div>`

      if (paymentInstructions.hasTarget) {
        const payUrl = _buildPaymentDeepLink(paymentInstructions, currentAmount)
        html += `<div class="ramp-target">
          <div class="ramp-target-label">Send to</div>
          <div class="ramp-target-value">${escapeHtml(paymentInstructions.target)}</div>
          ${payUrl ? `<div class="ramp-qr-wrap"><div id="ramp-qr"></div></div>
          <a href="${escapeHtml(payUrl)}" target="_blank" rel="noopener" class="ramp-target-link">open ${escapeHtml(paymentInstructions.method)} ↗</a>` : ''}
        </div>`
      }

      html += `<div class="ramp-instructions">
        <h4>Instructions</h4>
        <ul>
          <li><i class="ph ph-check"></i><span>Send <strong>exactly ${escapeHtml(paymentInstructions.amount)} ${PAYMENT_METHOD_CURRENCIES[paymentInstructions.methodId] || 'USD'}</strong> in a <strong>single</strong> payment</span></li>
          <li><i class="ph ph-check"></i><span>Use your <strong>${escapeHtml(paymentInstructions.method)}</strong> app to pay</span></li>
          <li><i class="ph ph-check"></i><span><strong>Double-check</strong> the recipient before confirming</span></li>
          <li><i class="ph ph-x"></i><span>Do <strong>not</strong> include Peer, PeerAuth, crypto, or related terms in the memo</span></li>
        </ul>
      </div>`

      const memo = _suggestedMemo(intentHash)
      html += `<div class="ramp-memo-row">
        <span class="ramp-memo-label">Suggested memo:</span>
        <span class="ramp-memo-value" id="ramp-memo-value">${memo}</span>
        <button class="ramp-memo-btn" id="ramp-memo-copy" title="copy"><i class="ph ph-copy"></i></button>
      </div>`

      html += `<label class="ramp-confirm-row">
        <input type="checkbox" id="ramp-confirm-check" ${confirmChecked ? 'checked' : ''}>
        <span>I understand that not following the instructions above may lead to permanent loss of funds.</span>
      </label>`

      html += `<button id="ramp-paid-btn" class="ramp-primary-btn" ${confirmChecked ? '' : 'disabled'}>I'VE SENT THE PAYMENT</button>`
      html += `<button id="ramp-discard-btn" class="ramp-secondary-btn">discard this order</button>`
      html += `<div id="ramp-status" class="ramp-status-msg" style="display:none"></div>`
      html += `</div>` // body
    }

    // Verify view
    else if (view === 'verify') {
      html += _stepsHtml('verify', ['payment', 'authenticate'])
      html += `<div class="ramp-body">`
      html += `<div class="ramp-verify-list">
        <div class="ramp-verify-item">
          <div class="ramp-verify-item-icon done"><i class="ph ph-check"></i></div>
          <div class="ramp-verify-item-content">
            <div class="ramp-verify-item-title">Transfer sent</div>
            <div class="ramp-verify-item-sub">on ${paymentInstructions?.method || 'payment app'}</div>
          </div>
        </div>
        <div class="ramp-verify-item">
          <div class="ramp-verify-item-icon active"><i class="ph ph-lock"></i></div>
          <div class="ramp-verify-item-content">
            <div class="ramp-verify-item-title">Verifying payment</div>
            <div class="ramp-verify-item-sub">generating ZK proof via PeerAuth…</div>
          </div>
        </div>
        <div class="ramp-verify-item">
          <div class="ramp-verify-item-icon"><i class="ph ph-circle"></i></div>
          <div class="ramp-verify-item-content">
            <div class="ramp-verify-item-title">Receive USDC on Base</div>
            <div class="ramp-verify-item-sub">then bridge to Optimism</div>
          </div>
        </div>
      </div>`
      html += `<div id="ramp-status" class="ramp-status-msg"><i class="ph ph-spinner" style="animation:spin 1s linear infinite"></i> waiting for verification…</div>`
      // PeerAuth deep link
      // Peer doesn't expose a per-intent verify URL — they detect it from the connected wallet.
      // Send the user to peer.xyz and tell them to connect the same wallet they used here.
      html += `<a href="https://peer.xyz" target="_blank" rel="noopener" class="ramp-primary-btn" style="text-decoration:none;text-align:center;display:block">VERIFY WITH PEERAUTH ↗</a>`
      html += `<div class="ramp-help" style="text-align:center;margin-top:0.5em">embedded wallet users: export your private key from settings → account, import to MetaMask, then verify on peer.xyz</div>`
      // Manual escape hatch: if USDC is already on Base (e.g. verified externally), bridge it directly
      html += `<button id="ramp-manual-bridge" class="ramp-secondary-btn" style="margin-top:1em">already received USDC? bridge to Optimism →</button>`
      html += `</div>`
    }

    // Done view
    else if (view === 'done') {
      html += _stepsHtml(null, ['payment', 'authenticate', 'verify'])
      html += `<div class="ramp-body">`
      html += `<div class="ramp-verify-list">
        <div class="ramp-verify-item">
          <div class="ramp-verify-item-icon done"><i class="ph ph-check"></i></div>
          <div class="ramp-verify-item-content"><div class="ramp-verify-item-title">Transfer sent</div></div>
        </div>
        <div class="ramp-verify-item">
          <div class="ramp-verify-item-icon done"><i class="ph ph-check"></i></div>
          <div class="ramp-verify-item-content"><div class="ramp-verify-item-title">Payment verified</div></div>
        </div>
        <div class="ramp-verify-item">
          <div class="ramp-verify-item-icon done"><i class="ph ph-check"></i></div>
          <div class="ramp-verify-item-content"><div class="ramp-verify-item-title">Received USDC on Base</div><div class="ramp-verify-item-sub">bridged to Optimism</div></div>
        </div>
      </div>`
      html += `<div class="ramp-status-msg success">${escapeHtml(successMessage) || `Received ~${escapeHtml(String(quoteData?.amount || currentAmount))} USDC`}</div>`
      html += `<button id="ramp-cancel" class="ramp-primary-btn">DONE</button>`
      html += `</div>`
    }

    dialog.innerHTML = html
    _bindEvents(view)
    _renderQrCode(view)

    // Timer tick
    if (view === 'pay' && paymentExpiresAt > 0) {
      if (_timerInterval) clearInterval(_timerInterval)
      _timerInterval = setInterval(() => {
        const el = dialog.querySelector('#ramp-timer')
        if (!el) { clearInterval(_timerInterval); return }
        const r = paymentExpiresAt - Date.now()
        el.innerHTML = `<i class="ph ph-clock"></i> Order expires in ${_formatTimer(r)}`
        if (r <= 0) clearInterval(_timerInterval)
      }, 1000)
    }
  }

  // Render a QR code into #ramp-qr if one is present in the current view
  async function _renderQrCode(view) {
    if (view !== 'pay') return
    const target = dialog.querySelector('#ramp-qr')
    if (!target || !paymentInstructions?.target) return
    const url = _buildPaymentDeepLink(paymentInstructions, currentAmount)
    if (!url) return
    try {
      const { qrcode } = await import('./vendor.js')
      // Type 0 = auto, error correction L = ~7% recovery, sufficient for short URLs
      const qr = qrcode(0, 'L')
      qr.addData(url)
      qr.make()
      // 4px per module, 8px margin, dark on light for max scanner compatibility
      target.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 8, scalable: true })
      const svg = target.querySelector('svg')
      if (svg) {
        svg.style.width = '180px'
        svg.style.height = '180px'
        svg.style.display = 'block'
      }
    } catch (e) {
      console.warn('[ramp] QR render failed:', e?.message)
    }
  }

  function _bindEvents(view) {
    // Universal cancel / back
    dialog.querySelectorAll('#ramp-cancel').forEach(btn => {
      btn.addEventListener('click', () => { cleanup(); overlay.remove() })
    })

    // Manual "bridge USDC to Optimism" escape hatch — used when verification happened externally
    // (e.g. on peer.xyz with an exported wallet) so the indexer never told us about it.
    dialog.querySelector('#ramp-manual-bridge')?.addEventListener('click', async () => {
      const btn = dialog.querySelector('#ramp-manual-bridge')
      if (!btn || btn.disabled) return
      btn.disabled = true
      btn.textContent = 'checking USDC balance…'
      try {
        // Make sure wallet is unlocked
        const acct = window.getEmbeddedAccount?.()
        if (!acct) {
          const unlocked = await window.showUnlockPrompt?.()
          if (!unlocked) throw new Error('wallet not unlocked')
        }
        const bal = await _getBaseUsdcBalance(recipientAddress)
        if (bal === 0n) {
          btn.textContent = 'no USDC found on Base yet'
          setTimeout(() => { btn.disabled = false; btn.textContent = 'already received USDC? bridge to Optimism →' }, 2500)
          return
        }
        dbg('[ramp] manual bridge — found', bal.toString(), 'USDC on Base')
        status = STATUS.bridging
        render()
        const txHash = await bridgeUsdcToOptimismEth(recipientAddress, bal, (msg) => {
          const statusEl = dialog.querySelector('#ramp-status')
          if (statusEl) { statusEl.style.display = ''; statusEl.textContent = msg }
        })
        clearPendingIntent()
        status = STATUS.done
        const usdcDisplay = (Number(bal) / 1e6).toFixed(2)
        successMessage = txHash
          ? `Bridged ${usdcDisplay} USDC to Optimism. ETH will arrive in ~2 min. <a href="https://basescan.org/tx/${txHash}" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline">view tx ↗</a>`
          : `Bridged ${usdcDisplay} USDC to Optimism. ETH will arrive in ~2 min.`
        render()
        _scheduleBalanceRefresh()
      } catch (e) {
        console.error('[ramp] manual bridge failed:', e)
        status = STATUS.error
        errorMessage = e?.shortMessage || e?.message || 'manual bridge failed'
        render()
      }
    })

    if (view === 'buy') {
      // Tab switching
      dialog.querySelectorAll('.ramp-tab').forEach(t => {
        t.addEventListener('click', () => {
          if (t.dataset.tab === 'sell') {
            cleanup()
            overlay.remove()
            // Open the offramp modal
            showOfframpModal(recipientAddress).catch(e => console.warn('[ramp] failed to open offramp:', e?.message))
          }
        })
      })

      // Resume pending banner
      dialog.querySelector('#ramp-resume-pending')?.addEventListener('click', () => {
        const p = loadPendingIntent(recipientAddress)
        if (!p) return
        intentHash = p.intentHash
        depositQuote = p.depositQuote
        paymentInstructions = p.paymentInstructions
        paymentExpiresAt = p.paymentExpiresAt
        currentAmount = p.currentAmount || currentAmount
        currentMethod = p.currentMethod || currentMethod
        status = STATUS.paying
        render()
      })

      // Discard pending banner — also cancel on-chain
      dialog.querySelector('#ramp-discard-pending')?.addEventListener('click', async () => {
        const p = loadPendingIntent(recipientAddress)
        const hashToCancel = p?.intentHash || intentHash
        const btn = dialog.querySelector('#ramp-discard-pending')
        if (btn) { btn.disabled = true; btn.textContent = 'cancelling…' }
        try {
          if (_zkp2pClient && hashToCancel) {
            await cancelIntentOnChain(_zkp2pClient, hashToCancel)
            dbg('[ramp] cancelled stale intent on-chain:', hashToCancel)
          }
        } catch (e) {
          console.warn('[ramp] cancel stale intent failed:', e?.message)
        }
        clearPendingIntent()
        intentHash = null
        depositQuote = null
        paymentInstructions = null
        render()
      })

      const amountInput = dialog.querySelector('#ramp-amount')
      if (amountInput) {
        amountInput.addEventListener('input', () => {
          currentAmount = Number(amountInput.value)
          if (_quoteDebounce) clearTimeout(_quoteDebounce)
          _quoteDebounce = setTimeout(async () => {
            if (currentAmount <= 0 || _destroyed) return
            const seq = ++_quoteSeq
            status = STATUS.quoting
            render()
            try {
              const result = await fetchQuote('onramp', currentAmount, currentMethod)
              if (seq !== _quoteSeq) return // stale — a newer request already started
              quoteData = result
            } catch (e) {
              if (seq !== _quoteSeq) return
              quoteData = null
              if (e?.message?.includes('Too many requests') || e?.message?.includes('429')) {
                errorMessage = 'too many quote requests — wait a few seconds'
                status = STATUS.error
                if (!_destroyed) render()
                return
              }
            }
            status = STATUS.idle
            if (!_destroyed) render()
          }, 700)
        })
        amountInput.focus()
      }

      dialog.querySelector('#ramp-method-picker')?.addEventListener('click', () => {
        _showMethodPicker()
      })

      dialog.querySelector('#ramp-view-quotes')?.addEventListener('click', () => {
        if (quoteData?.quotes?.length > 1) _showQuoteSelector()
      })

      dialog.querySelector('#ramp-confirm')?.addEventListener('click', async () => {
        if (status !== STATUS.idle && status !== STATUS.error) return
        await runOnramp()
      })
    }

    if (view === 'pay') {
      dialog.querySelector('#ramp-confirm-check')?.addEventListener('change', (e) => {
        confirmChecked = e.target.checked
        const btn = dialog.querySelector('#ramp-paid-btn')
        if (btn) btn.disabled = !confirmChecked
      })
      // I've sent the payment — works for both fresh (runOnramp awaiting) and restored intents
      dialog.querySelector('#ramp-paid-btn')?.addEventListener('click', () => {
        if (!confirmChecked || _paidClicked) return
        _markPaid()
        // If runOnramp is currently awaiting, _markPaid resolved its promise — nothing more to do.
        // If we're on a restored intent (no active runOnramp), kick off the post-payment flow.
        if (!_postPayRunning) resumePostPayFromRestore()
      })
      dialog.querySelector('#ramp-discard-btn')?.addEventListener('click', async () => {
        const btn = dialog.querySelector('#ramp-discard-btn')
        if (!btn || btn.disabled) return
        const hashToCancel = intentHash
        btn.disabled = true
        btn.textContent = 'cancelling on-chain…'
        try {
          if (_zkp2pClient && hashToCancel) {
            // Cancel on-chain so the deposit liquidity is released and we can start fresh
            await cancelIntentOnChain(_zkp2pClient, hashToCancel)
            dbg('[ramp] cancelled intent on-chain:', hashToCancel)
          }
        } catch (e) {
          console.warn('[ramp] cancelIntent failed (clearing local state anyway):', e?.message)
          // Surface to the user — they may need to wait for natural expiry
          const statusEl = dialog.querySelector('#ramp-status')
          if (statusEl) {
            statusEl.style.display = ''
            statusEl.classList.add('error')
            statusEl.textContent = `couldn't cancel on-chain: ${e?.shortMessage || e?.message || 'unknown error'} — local state cleared, on-chain intent will expire in 6h`
          }
        }
        clearPendingIntent()
        intentHash = null
        depositQuote = null
        paymentInstructions = null
        confirmChecked = false
        paymentExpiresAt = 0
        status = STATUS.idle
        render()
      })
      dialog.querySelector('#ramp-memo-copy')?.addEventListener('click', async () => {
        const val = dialog.querySelector('#ramp-memo-value')?.textContent || ''
        try {
          await navigator.clipboard.writeText(val)
          const btn = dialog.querySelector('#ramp-memo-copy')
          if (btn) { btn.innerHTML = '<i class="ph ph-check"></i>'; setTimeout(() => { btn.innerHTML = '<i class="ph ph-copy"></i>' }, 1200) }
        } catch {}
      })
      // ramp-paid-btn click handler is wired up by runOnramp via the `await new Promise` loop below
    }
  }

  // Sub-modal: method picker (pill dropdown)
  function _showMethodPicker() {
    const pickerOverlay = document.createElement('div')
    pickerOverlay.className = 'praxis-modal-overlay'
    pickerOverlay.style.zIndex = '10002'
    const pickerDialog = document.createElement('div')
    pickerDialog.className = 'praxis-modal-dialog ramp-dialog'
    pickerDialog.style.maxWidth = '360px'
    pickerDialog.innerHTML = `<div class="ramp-header"><button class="ramp-header-back" id="picker-close"><i class="ph ph-x"></i></button><div class="ramp-header-title">PAY WITH</div><div class="ramp-header-spacer"></div></div>
      <div class="ramp-body">
        ${PAYMENT_METHODS.map(m => `<button class="ramp-rate-row" data-method="${m.id}" style="width:100%;text-align:left" ${m.disabled ? 'disabled' : ''}>
          <div class="ramp-rate-info">
            <i class="ph ${m.icon}" style="font-size:1.1em"></i>
            <span class="ramp-rate-text">${m.label}${m.disabled ? ` <span style="color:var(--dim);font-size:0.75em">(${m.disabledReason || 'soon'})</span>` : ''}</span>
            ${m.id === currentMethod ? '<span class="ramp-rate-best">ACTIVE</span>' : ''}
          </div>
        </button>`).join('')}
      </div>`
    pickerOverlay.appendChild(pickerDialog)
    document.body.appendChild(pickerOverlay)
    pickerOverlay.addEventListener('click', (e) => { if (e.target === pickerOverlay) pickerOverlay.remove() })
    pickerDialog.querySelector('#picker-close')?.addEventListener('click', () => pickerOverlay.remove())
    pickerDialog.querySelectorAll('[data-method]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.disabled) return
        currentMethod = btn.dataset.method
        setPreferredMethod(currentMethod)
        quoteData = null
        pickerOverlay.remove()
        render()
        if (currentAmount > 0) {
          status = STATUS.quoting
          render()
          fetchQuote('onramp', currentAmount, currentMethod).then(q => { quoteData = q; status = STATUS.idle; if (!_destroyed) render() }).catch(() => { status = STATUS.idle; if (!_destroyed) render() })
        }
      })
    })
  }

  // Sub-modal: multi-quote selector
  function _showQuoteSelector() {
    if (!quoteData?.quotes?.length) return
    const qOverlay = document.createElement('div')
    qOverlay.className = 'praxis-modal-overlay'
    qOverlay.style.zIndex = '10002'
    const qDialog = document.createElement('div')
    qDialog.className = 'praxis-modal-dialog ramp-dialog'
    qDialog.style.maxWidth = '420px'
    let activeFilter = 'all'
    const methodsInQuotes = [...new Set(quoteData.quotes.map(q => q.processorName).filter(Boolean))]

    function renderList() {
      const filtered = activeFilter === 'all' ? quoteData.quotes : quoteData.quotes.filter(q => q.processorName === activeFilter)
      const bestAmount = quoteData.quotes[0]?.tokenAmount
      qDialog.innerHTML = `<div class="ramp-header"><button class="ramp-header-back" id="q-close"><i class="ph ph-x"></i></button><div class="ramp-header-title">SELECT A QUOTE (${filtered.length})</div><div class="ramp-header-spacer"></div></div>
        <div class="ramp-body">
          ${methodsInQuotes.length > 1 ? `<div class="ramp-method-filters">
            <button class="ramp-method-filter ${activeFilter === 'all' ? 'active' : ''}" data-f="all">All</button>
            ${methodsInQuotes.map(m => `<button class="ramp-method-filter ${activeFilter === m ? 'active' : ''}" data-f="${m}">${PAYMENT_METHOD_LABEL[m] || m}</button>`).join('')}
          </div>` : ''}
          <div class="ramp-quote-list">
            ${filtered.map((q, i) => {
              const isBest = q.tokenAmount === bestAmount
              const discount = bestAmount && q.tokenAmount ? ((Number(q.tokenAmount) - Number(bestAmount)) / Number(bestAmount) * 100) : 0
              const depShort = q.depositor ? `${q.depositor.slice(0, 6)}…${q.depositor.slice(-4)}` : ''
              const appLabel = PAYMENT_METHOD_LABEL[q.processorName] || q.processorName || '—'
              return `<div class="ramp-quote-row ${isBest ? 'selected' : ''}" data-idx="${quoteData.quotes.indexOf(q)}">
                <div>
                  <div class="ramp-quote-amount">${q.tokenAmount} USDC</div>
                  <div class="ramp-quote-rate">≈ $${q.fiatAmount} · ${(Number(q.rate || '1000000000000000000') / 1e18).toFixed(3).replace(/\.?0+$/, '')} ${PAYMENT_METHOD_CURRENCIES[q.processorName] || 'USD'} / USDC</div>
                </div>
                <div class="ramp-quote-right">
                  ${isBest ? '<span class="ramp-rate-best">BEST</span>' : `<span class="ramp-quote-discount ${discount < 0 ? 'negative' : ''}">${discount > 0 ? '+' : ''}${discount.toFixed(2)}%</span>`}
                  ${depShort ? `<span class="ramp-quote-handle">${depShort}</span>` : ''}
                  <span class="ramp-quote-method">${appLabel}</span>
                </div>
              </div>`
            }).join('')}
          </div>
        </div>`
      qDialog.querySelector('#q-close')?.addEventListener('click', () => qOverlay.remove())
      qDialog.querySelectorAll('.ramp-method-filter').forEach(b => b.addEventListener('click', () => { activeFilter = b.dataset.f; renderList() }))
      qDialog.querySelectorAll('[data-idx]').forEach(b => b.addEventListener('click', () => { qOverlay.remove() }))
    }
    qOverlay.appendChild(qDialog)
    document.body.appendChild(qOverlay)
    qOverlay.addEventListener('click', (e) => { if (e.target === qOverlay) qOverlay.remove() })
    renderList()
  }

  async function runOnramp() {
    try {
      // 1. Get wallet client for Base chain using embedded account + Alchemy RPC
      // The embedded wallet provider only proxies Optimism RPC, so we use http(BASE_RPC)
      // with the embedded wallet's viem PrivateKeyAccount for signing Base transactions
      const { createWalletClient, http } = await import('./vendor.js')
      await window.ensureAuthorized?.()
      const embeddedAccount = window.getEmbeddedAccount?.()
      if (!embeddedAccount) throw new Error('unlock your embedded wallet first')
      const walletClient = createWalletClient({
        account: embeddedAccount,
        chain: BASE_CHAIN,
        transport: http(BASE_RPC),
      })

      // 1b. Ensure user has Base ETH for gas — drip from Praxis treasury if empty
      // (chicken-and-egg: fiat onramp users start with $0 crypto)
      try {
        const { createPublicClient } = await import('./vendor.js')
        const basePc = createPublicClient({ chain: BASE_CHAIN, transport: http(BASE_RPC) })
        const baseBal = await basePc.getBalance({ address: embeddedAccount.address })
        if (baseBal < 100000000000000n) { // < 0.0001 ETH
          dbg('[ramp] base balance low, requesting gas sponsorship')
          const sponsorResp = await fetch('/orchestrator/sponsor-base-gas', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ wallet: embeddedAccount.address }),
          })
          const sponsorData = await sponsorResp.json().catch(() => ({}))
          if (sponsorData.sponsored && sponsorData.txHash) {
            dbg('[ramp] base gas sponsored, waiting for confirmation:', sponsorData.txHash)
            await basePc.waitForTransactionReceipt({ hash: sponsorData.txHash, timeout: 30000 })
            dbg('[ramp] base gas sponsorship confirmed')
          } else if (sponsorData.error) {
            console.warn('[ramp] base gas sponsor refused:', sponsorData.error)
          }
        }
      } catch (e) {
        console.warn('[ramp] base gas sponsorship check failed (non-fatal):', e?.message)
      }

      // 2. Initialize SDK client with Base-configured walletClient
      status = STATUS.matching
      render()
      const client = await initZkp2pClient(walletClient)

      // 3. Get deposit quote (find liquidity)
      depositQuote = await getDepositQuote(client, currentAmount, currentMethod, recipientAddress)

      // 4. Signal intent on-chain (pass walletClient explicitly so the signer used for tx matches the API callerAddress)
      const signalRes = await signalOnrampIntent(client, depositQuote, recipientAddress, walletClient)
      const txHash = signalRes.txHash
      intentHash = signalRes.intentHash // assign to outer scope so render() can use it
      dbg('[ramp] signalIntent tx:', txHash, 'intentHash:', intentHash)

      // Pull cashtag/handle from the captured v3/intent response (SDK doesn't expose it)
      const captured = getLastIntentDepositData()
      if (captured) depositQuote.depositData = captured

      // 5. Show payment instructions and wait for user to confirm they've paid
      paymentInstructions = formatPaymentInstructions(depositQuote)
      paymentExpiresAt = Date.now() + 6 * 60 * 60 * 1000 // 6h, matches Peer
      confirmChecked = false
      status = STATUS.paying
      // Persist so a refresh resumes the same intent
      savePendingIntent(recipientAddress, {
        intentHash, depositQuote, paymentInstructions, paymentExpiresAt, currentAmount, currentMethod,
      })
      render()

      // Wait for user to click "I've sent the payment" — the button is disabled until they
      // tick the confirm checkbox. The click handler is bound in _bindEvents() so it survives
      // re-renders and works for both fresh and restored intents.
      if (paymentInstructions.hasTarget && !_paidClicked) {
        await new Promise(resolve => { _paidResolver = resolve })
      }

      // Run the post-payment flow (poll fulfillment + bridge to Optimism)
      await runPostPayment(client)
    } catch (e) {
      console.warn('[ramp] onramp error:', e)
      status = STATUS.error
      errorMessage = e?.message || 'onramp failed — try again'
      paymentInstructions = null
      render()
    }
  }

  // Post-payment flow: wait for USDC to land on Base, then swap+bridge to Optimism.
  // We poll TWO sources in parallel and trigger on whichever fires first:
  //   1. The zkp2p indexer for an IntentFulfilled event (canonical, but lags)
  //   2. The wallet's Base USDC balance directly (faster, works even if PeerAuth or
  //      a third party submitted fulfillIntent so the indexer hasn't caught up)
  async function runPostPayment(client) {
    if (_postPayRunning) return
    _postPayRunning = true
    try {
      status = STATUS.funded
      render()

      const baselineUsdc = await _getBaseUsdcBalance(recipientAddress).catch(() => 0n)
      dbg('[ramp] post-pay starting, baseline USDC on Base:', baselineUsdc.toString())

      // Recovery shortcut: if there's already a meaningful USDC balance on Base,
      // skip the wait and go straight to bridge. This handles the case where the
      // user verified externally (e.g. on peer.xyz) before reopening the modal.
      const MIN_USDC_FOR_BRIDGE = 100000n // 0.10 USDC
      const skipWait = baselineUsdc >= MIN_USDC_FOR_BRIDGE

      let fulfilled
      if (skipWait) {
        dbg('[ramp] USDC already on Base — skipping verification wait')
        fulfilled = { status: 'fulfilled', source: 'pre-existing' }
      } else {
        fulfilled = await _waitForFulfillmentOrUsdc(client, baselineUsdc)
      }
      if (_destroyed) return

      if (fulfilled.status === 'timeout') {
        status = STATUS.error
        errorMessage = 'verification timed out — your USDC may still arrive shortly. Check your wallet on Base, or open "add funds" to bridge it manually.'
        render()
        return
      }

      // 7. Swap USDC → ETH + Bridge to Optimism (Relay handles both in one tx)
      status = STATUS.bridging
      render()

      // Use the actual received USDC balance (more accurate than the original quote amount)
      const currentUsdc = await _getBaseUsdcBalance(recipientAddress).catch(() => 0n)
      const usdcAmount = currentUsdc > 0n ? currentUsdc : (depositQuote.amount || depositQuote.signalIntentAmount)
      let bridgeTxHash = null
      try {
        bridgeTxHash = await bridgeUsdcToOptimismEth(recipientAddress, usdcAmount, (msg) => {
          const statusEl = dialog.querySelector('#ramp-status')
          if (statusEl) { statusEl.style.display = ''; statusEl.textContent = msg }
        })
      } catch (bridgeErr) {
        console.warn('[ramp] swap+bridge failed:', bridgeErr)
        status = STATUS.error
        errorMessage = 'swap+bridge failed — your USDC is safe on Base. retry from "add funds" using the manual bridge.'
        render()
        return
      }

      // 8. Done — clear the pending intent so a fresh modal starts at Buy
      clearPendingIntent()
      status = STATUS.done
      const usdcDisplay = (Number(usdcAmount) / 1e6).toFixed(2)
      successMessage = bridgeTxHash
        ? `Bridged ${usdcDisplay} USDC to Optimism. ETH will arrive in ~2 min. <a href="https://basescan.org/tx/${bridgeTxHash}" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline">view tx ↗</a>`
        : `Bridged ${usdcDisplay} USDC to Optimism. ETH will arrive in ~2 min.`
      render()
      // Refresh the dock balance display — poll a few times since Optimism arrival lags
      _scheduleBalanceRefresh()
    } finally {
      _postPayRunning = false
    }
  }

  // Fire wallet-balance-changed events for ~5 minutes after a bridge so the dock catches the
  // ETH arriving on Optimism (Relay typically takes 30s–2 min). The event invalidates the
  // 60s sessionStorage cache and re-fetches.
  function _scheduleBalanceRefresh() {
    const intervals = [5_000, 15_000, 30_000, 60_000, 120_000, 180_000, 240_000, 300_000]
    intervals.forEach(ms => setTimeout(() => {
      window.dispatchEvent(new CustomEvent('wallet-balance-changed'))
    }, ms))
  }

  // Read USDC balance on Base directly via Alchemy (no SDK needed)
  async function _getBaseUsdcBalance(addr) {
    const { createPublicClient, http } = await import('./vendor.js')
    const pc = createPublicClient({ chain: BASE_CHAIN, transport: http(BASE_RPC) })
    const ERC20_BALANCE_ABI = [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: 'b', type: 'uint256' }] }]
    return await pc.readContract({ address: USDC_BASE, abi: ERC20_BALANCE_ABI, functionName: 'balanceOf', args: [addr] })
  }

  // Race two signals: indexer-based intent fulfillment vs direct USDC balance check.
  // First one wins. Both have a 10-min timeout.
  async function _waitForFulfillmentOrUsdc(client, baselineUsdc) {
    const TIMEOUT_MS = 10 * 60 * 1000
    const POLL_INTERVAL = 5000
    const start = Date.now()

    return new Promise((resolve) => {
      let settled = false
      const finish = (result) => { if (!settled) { settled = true; resolve(result) } }

      // Track 1: indexer
      pollIntentFulfillment(client, recipientAddress, (msg) => {
        if (_destroyed || settled) return
        const statusEl = dialog.querySelector('#ramp-status')
        if (statusEl && msg === 'polling') {
          statusEl.style.display = ''
          statusEl.textContent = 'waiting for payment verification… (indexer)'
        }
      }, intentHash).then((res) => {
        if (res.status === 'fulfilled') finish({ status: 'fulfilled', source: 'indexer' })
      }).catch(() => {})

      // Track 2: direct balance polling
      const tick = async () => {
        if (settled || _destroyed) return
        if (Date.now() - start > TIMEOUT_MS) return finish({ status: 'timeout' })
        try {
          const bal = await _getBaseUsdcBalance(recipientAddress)
          if (bal > baselineUsdc) {
            dbg('[ramp] USDC delta detected on Base:', (bal - baselineUsdc).toString())
            return finish({ status: 'fulfilled', source: 'balance' })
          }
        } catch (e) {
          console.warn('[ramp] USDC balance poll failed:', e?.message)
        }
        setTimeout(tick, POLL_INTERVAL)
      }
      tick()
    })
  }

  // Resume entry point: called when the user clicks "I've sent the payment" on a
  // restored intent (no active runOnramp). Initializes the SDK if needed, then
  // runs the post-payment flow directly.
  async function resumePostPayFromRestore() {
    try {
      const embeddedAcct = window.getEmbeddedAccount?.()
      if (!embeddedAcct) {
        const unlocked = await window.showUnlockPrompt?.()
        if (!unlocked) throw new Error('wallet not unlocked')
      }
      const acct = window.getEmbeddedAccount?.()
      if (!acct) throw new Error('embedded wallet still locked')
      let client = _zkp2pClient
      if (!client) {
        const { createWalletClient, http } = await import('./vendor.js')
        const wc = createWalletClient({ chain: BASE_CHAIN, transport: http(BASE_RPC), account: acct })
        client = await initZkp2pClient(wc)
      }
      await runPostPayment(client)
    } catch (e) {
      console.warn('[ramp] resume post-pay failed:', e)
      status = STATUS.error
      errorMessage = e?.message || 'failed to verify payment — try again'
      render()
    }
  }

  // Initial render
  document.body.appendChild(overlay)
  render()

  // Initialize SDK client (needs signing wallet for auth tokens)
  if (!_zkp2pClient) {
    try {
      // Ensure embedded wallet is unlocked (needed for SDK auth)
      const addr = window.getWalletAddress?.()
      if (!addr) {
        const unlocked = await window.showUnlockPrompt?.()
        if (!unlocked) throw new Error('wallet not unlocked')
      }
      // Use embedded account + Alchemy Base RPC (embedded wallet provider only proxies Optimism)
      const embeddedAcct = window.getEmbeddedAccount?.()
      if (!embeddedAcct) throw new Error('embedded wallet not unlocked')
      const { createWalletClient, http } = await import('./vendor.js')
      const wc = createWalletClient({ chain: BASE_CHAIN, transport: http(BASE_RPC), account: embeddedAcct })
      await initZkp2pClient(wc)
    } catch (e) { console.warn('praxis: zkp2p SDK init failed:', e?.message) }
  }

  // On-chain recovery: if no localStorage cache hit, query the orchestrator for an active intent
  // Lets users resume a Pay flow that was created on a different device or before persistence shipped.
  if (!pending && _zkp2pClient && status === STATUS.idle) {
    try {
      const accountIntents = await _zkp2pClient.getAccountIntents(recipientAddress)
      const active = (accountIntents || []).filter(it => !it.isFulfilled && !it.fulfilledAt && !it.cancelledAt)
      if (active.length > 0 && !_destroyed) {
        const latest = active[active.length - 1]
        const recoveredHash = latest.intentHash || latest.hash || latest.id
        dbg('[ramp] recovered active intent on-chain:', recoveredHash, latest)
        // Best-effort reconstruction — cashtag is unavailable since the SDK only exposes it via v3/intent
        intentHash = recoveredHash
        depositQuote = {
          processorName: latest.processorName || latest.intent?.processorName || currentMethod,
          fiatAmountFormatted: latest.fiatAmount || String(currentAmount),
          amount: latest.amount,
          signalIntentAmount: latest.amount,
          depositData: {},
        }
        paymentInstructions = formatPaymentInstructions(depositQuote)
        // intent expires after 6h on zkp2p; if we know the timestamp use it, else assume now
        const signalledAt = latest.timestamp ? Number(latest.timestamp) * 1000 : Date.now()
        paymentExpiresAt = signalledAt + 6 * 60 * 60 * 1000
        status = STATUS.paying
        // Persist for future refreshes
        savePendingIntent(recipientAddress, { intentHash, depositQuote, paymentInstructions, paymentExpiresAt, currentAmount, currentMethod })
        render()
      }
    } catch (e) {
      console.warn('[ramp] on-chain intent recovery failed (non-fatal):', e?.message)
    }
  }

  // Auto-fetch quote via SDK
  if (currentAmount > 0 && status === STATUS.idle) {
    status = STATUS.quoting
    render()
    try {
      quoteData = await fetchQuote('onramp', currentAmount, currentMethod)
      status = STATUS.idle
    } catch {
      status = STATUS.idle
    }
    if (!_destroyed) render()
  }

  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (!document.body.contains(overlay)) {
        observer.disconnect()
        cleanup()
        resolve(status === STATUS.done)
      }
    })
    observer.observe(document.body, { childList: true })
  })
}

// --- Offramp Modal ---

export async function showOfframpModal(senderAddress, amountETH = '0.01') {
  const { overlay, dialog } = createModal()
  dialog.classList.add('ramp-dialog')
  dialog.style.maxWidth = '460px'
  let currentMethod = getPreferredMethod()
  let currentAmount = amountETH
  let paymentDetails = ''
  let quoteData = null
  let status = STATUS.idle
  let statusDetail = ''
  let _pollTimer = null
  let _destroyed = false
  let _waitStartTime = null
  let _waitIntervalId = null
  let _lastError = null
  let _retryStep = null // tracks which step failed for retry
  let _offrampQuoteDebounce = null // hoisted so re-renders don't orphan timers
  let _walletBalance = null // bigint wei (Optimism ETH)
  let _baseUsdcBalance = null // bigint USDC (Base, 6 decimals)
  let _ethPriceUsd = null
  let _myDeposits = [] // active deposits for this wallet
  let _depositsLoading = true
  let _lastCreatedDepositId = null
  let _intentPollTimer = null // periodic poll for buyer intents on user's deposits
  let _activeIntents = [] // intents currently signaled against user's deposits

  function cleanup() {
    _destroyed = true
    if (_pollTimer) clearTimeout(_pollTimer)
    if (_offrampQuoteDebounce) clearTimeout(_offrampQuoteDebounce)
    if (_waitIntervalId) clearInterval(_waitIntervalId)
    if (_intentPollTimer) clearInterval(_intentPollTimer)
  }

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) cleanup()
  })

  function getOfframpStatusMessage() {
    switch (status) {
      case STATUS.idle: return ''
      case STATUS.quoting: return 'fetching rate...'
      case STATUS.bridging: return 'bridging ETH to Base...'
      case STATUS.swapping: return 'swapping ETH → USDC...'
      case STATUS.approving: return 'approving USDC...'
      case STATUS.depositing: return 'creating sell order...'
      case STATUS.waiting: {
        if (_waitStartTime) {
          const elapsed = Math.floor((Date.now() - _waitStartTime) / 1000)
          const mins = Math.floor(elapsed / 60)
          const secs = elapsed % 60
          return `waiting for buyer... (${mins}:${secs.toString().padStart(2, '0')} elapsed)`
        }
        return 'waiting for buyer...'
      }
      case STATUS.verifying: return 'buyer found — verifying payment...'
      case STATUS.done: return `complete! check your ${currentMethod} for payment`
      case STATUS.error: return statusDetail || 'something went wrong'
      default: return statusDetail || status
    }
  }

  function getOfframpStatusColor() {
    if (status === STATUS.done) return 'var(--green, #4a4)'
    if (status === STATUS.error) return 'var(--red, #a44)'
    if (status === STATUS.waiting) return 'var(--accent, #a0a0a0)'
    return 'var(--muted, #888)'
  }

  function renderPaymentDetailsInput() {
    const placeholder = PAYMENT_DETAIL_PLACEHOLDERS[currentMethod] || 'your payment handle or email'
    const disabled = status !== STATUS.idle && status !== STATUS.error
    return `
      <div style="margin-bottom:1em">
        <label style="color:var(--dim);font-size:0.8em;display:block;margin-bottom:0.3em">your ${currentMethod} details</label>
        <input id="ramp-payment-details" type="text" value="${paymentDetails.replace(/"/g, '&quot;')}"
          placeholder="${placeholder}"
          style="width:100%;padding:0.5em;background:var(--bg, #0a0a0a);color:var(--fg, #c0c0c0);
          border:1px solid var(--border, #333);font-family:inherit;font-size:0.9em;box-sizing:border-box"
          ${disabled ? 'disabled' : ''} />
      </div>
    `
  }

  function render() {
    const isProcessing = status !== STATUS.idle && status !== STATUS.error
    const showRetry = status === STATUS.error && _retryStep
    const statusMsg = getOfframpStatusMessage()
    const statusColor = getOfframpStatusColor()
    const isDone = status === STATUS.done && _lastCreatedDepositId

    // ETH balance (for "amount to sell" max button)
    const ethBalDisplay = (() => {
      if (_walletBalance === null) return '<span style="color:var(--dim)">checking…</span>'
      const eth = (Number(_walletBalance) / 1e18).toFixed(4).replace(/\.?0+$/, '')
      const usd = _ethPriceUsd ? `≈ $${(Number(_walletBalance) / 1e18 * _ethPriceUsd).toFixed(2)}` : ''
      return `${eth} ETH ${usd ? `<span style="color:var(--dim);font-size:0.8em">${usd}</span>` : ''}`
    })()

    // Approximate USD value of the entered ETH amount using cached price
    const usdEstimate = (parseFloat(currentAmount) > 0 && _ethPriceUsd)
      ? `≈ $${(parseFloat(currentAmount) * _ethPriceUsd).toFixed(2)} ${PAYMENT_METHOD_CURRENCIES[currentMethod] || 'USD'}`
      : ''

    // --- Active deposits dashboard rows ---
    let depositsHtml = ''
    if (_depositsLoading) {
      depositsHtml = `<div class="ramp-help" style="text-align:center;padding:0.5em">checking your active listings…</div>`
    } else if (_myDeposits.length === 0) {
      depositsHtml = `<div class="ramp-help" style="text-align:center;padding:0.5em;color:var(--dim)">no active listings</div>`
    } else {
      depositsHtml = _myDeposits.map(d => {
        const remaining = (Number(d.remainingDepositAmount || d.deposit?.remainingDepositAmount || 0n) / 1e6).toFixed(2)
        const method = d.processorName || d.verifiers?.[0]?.methodHash?.slice(0, 8) || '—'
        const intentsCount = (d.intentHashes?.length || d.deposit?.intentHashes?.length || 0)
        const id = String(d.depositId || d.id || '')
        return `<div class="ramp-rate-row" style="cursor:default">
          <div style="flex:1">
            <div class="ramp-rate-text">$${remaining} USDC remaining</div>
            <div class="ramp-rate-meta">
              <span>${PAYMENT_METHOD_LABEL[method] || method}</span>
              <span>·</span>
              <span>id #${id.slice(-6)}</span>
              ${intentsCount > 0 ? `<span>·</span><span style="color:var(--accent)">${intentsCount} pending</span>` : ''}
            </div>
          </div>
          <button class="ramp-method-pill ramp-withdraw-btn" data-deposit-id="${id}" style="font-size:0.75em;padding:0.3em 0.8ch;border-color:var(--red,#a44);color:var(--red,#a44)">withdraw</button>
        </div>`
      }).join('')
    }

    dialog.innerHTML = `
      <div class="ramp-header">
        <button class="ramp-header-back" id="ramp-cancel"><i class="ph ph-arrow-left"></i></button>
        <div class="ramp-header-title">SELL</div>
        <div class="ramp-header-spacer"></div>
      </div>
      <div class="ramp-tabs">
        <button class="ramp-tab" data-tab="buy">BUY</button>
        <button class="ramp-tab active" data-tab="sell">SELL</button>
      </div>
      <div class="ramp-body">

        ${isDone ? `
          <div class="ramp-status-msg success" style="margin-bottom:1em">
            ✓ your listing is live (#${String(_lastCreatedDepositId).slice(-6)}). buyers can now match it and pay you on ${PAYMENT_METHOD_LABEL[currentMethod] || currentMethod}. you can close this and we'll show pending sales below when buyers signal.
          </div>
        ` : ''}

        <div class="ramp-input-card">
          <div class="ramp-input-label">You sell</div>
          <div class="ramp-input-row">
            <input id="ramp-amount" type="number" min="0.001" step="0.001" value="${currentAmount}" class="ramp-amount-input" ${isProcessing ? 'disabled' : ''} />
            <span class="ramp-currency-pill"><i class="ph ph-currency-eth"></i>ETH</span>
          </div>
          <div class="ramp-receive-meta">
            <span>${usdEstimate || '&nbsp;'}</span>
            <span>${ethBalDisplay} on Optimism <button id="ramp-max" class="ramp-method-pill" style="font-size:0.7em;padding:0.15em 0.5ch;margin-left:0.4ch" ${_walletBalance === null || _walletBalance === 0n ? 'disabled' : ''}>max</button></span>
          </div>
        </div>

        <div class="ramp-input-card">
          <div class="ramp-input-label">Receive via</div>
          <div class="ramp-input-row">
            <button id="ramp-method-picker" class="ramp-method-pill"><i class="ph ${PAYMENT_METHODS.find(p=>p.id===currentMethod)?.icon || 'ph-currency-circle-dollar'}"></i>${PAYMENT_METHOD_LABEL[currentMethod] || currentMethod}<i class="ph ph-caret-down" style="font-size:0.75em"></i></button>
          </div>
          <div style="margin-top:0.5em">
            <input id="ramp-payment-details" type="text" value="${paymentDetails.replace(/"/g, '&quot;')}"
              placeholder="${PAYMENT_DETAIL_PLACEHOLDERS[currentMethod] || 'your handle / cashtag / email'}"
              style="width:100%;padding:0.5em;background:var(--bg, #0a0a0a);color:var(--fg, #c0c0c0);border:1px solid var(--border, #333);font-family:inherit;font-size:0.9em;box-sizing:border-box"
              ${isProcessing ? 'disabled' : ''} />
          </div>
        </div>

        <div class="ramp-help" style="margin:0.6em 0">
          You'll create a P2P listing with $${parseFloat(currentAmount || '0') > 0 && _ethPriceUsd ? (parseFloat(currentAmount) * _ethPriceUsd).toFixed(2) : '—'} USDC at 1:1 rate. Buyers send you ${PAYMENT_METHOD_CURRENCIES[currentMethod] || 'USD'} via ${PAYMENT_METHOD_LABEL[currentMethod] || currentMethod}. Match time depends on demand.
        </div>

        <div id="ramp-status" class="ramp-status-msg" style="${statusMsg ? '' : 'display:none'};color:${statusColor}">${statusMsg}</div>

        ${showRetry
          ? `<button id="ramp-retry" class="ramp-primary-btn">retry</button>`
          : `<button id="ramp-confirm" class="ramp-primary-btn" ${isProcessing || !paymentDetails.trim() ? 'disabled' : ''}>${isProcessing ? 'PROCESSING…' : 'LIST FOR SALE'}</button>`
        }

        ${_activeIntents.length > 0 ? `
          <div class="ramp-input-label" style="margin-top:1.5em">Buyers waiting (${_activeIntents.length})</div>
          ${_activeIntents.map(it => {
            const amt = (Number(it.amount || it.intent?.amount || 0) / 1e6).toFixed(2)
            const buyer = (it.owner || it.intent?.owner || '').slice(0, 6) + '…' + (it.owner || it.intent?.owner || '').slice(-4)
            return `<div class="ramp-rate-row" style="cursor:default;border-color:var(--accent)">
              <div style="flex:1">
                <div class="ramp-rate-text">${buyer} wants $${amt}</div>
                <div class="ramp-rate-meta">
                  <span style="color:var(--accent)">payment incoming</span>
                  <span>·</span>
                  <span>watch your ${PAYMENT_METHOD_LABEL[currentMethod] || 'app'}</span>
                </div>
              </div>
            </div>`
          }).join('')}
        ` : ''}

        <div class="ramp-input-label" style="margin-top:1.5em">Your active listings</div>
        ${depositsHtml}

      </div>
    `

    // bind events
    const amountInput = dialog.querySelector('#ramp-amount')
    if (amountInput) {
      amountInput.addEventListener('input', () => {
        currentAmount = amountInput.value
        // Show a 1:1 USD estimate based on the live ETH price (no SDK call — v2 quote endpoint is deprecated)
        if (_ethPriceUsd && parseFloat(currentAmount) > 0) {
          quoteData = { amount: (parseFloat(currentAmount) * _ethPriceUsd).toFixed(2) }
          render()
        }
      })
    }
    dialog.querySelector('#ramp-max')?.addEventListener('click', () => {
      if (_walletBalance === null || _walletBalance === 0n) return
      // Reserve a tiny bit of ETH for gas
      const reserve = 200000000000000n // 0.0002 ETH
      const sellable = _walletBalance > reserve ? _walletBalance - reserve : 0n
      currentAmount = (Number(sellable) / 1e18).toFixed(6).replace(/\.?0+$/, '')
      render()
    })

    const detailsInput = dialog.querySelector('#ramp-payment-details')
    if (detailsInput) {
      detailsInput.addEventListener('input', () => {
        paymentDetails = detailsInput.value
        // Re-render to enable the LIST FOR SALE button once a handle is entered
        const btn = dialog.querySelector('#ramp-confirm')
        if (btn) btn.disabled = !paymentDetails.trim() || (status !== STATUS.idle && status !== STATUS.error)
      })
    }

    // BUY tab → switch back to onramp modal
    dialog.querySelectorAll('.ramp-tab').forEach(t => {
      t.addEventListener('click', () => {
        if (t.dataset.tab === 'buy') {
          cleanup()
          overlay.remove()
          showOnrampModal(senderAddress).catch(e => console.warn('[ramp] failed to open onramp:', e?.message))
        }
      })
    })

    // Method picker — reuse the same sub-modal pattern as onramp
    dialog.querySelector('#ramp-method-picker')?.addEventListener('click', () => {
      _showOfframpMethodPicker()
    })

    // Withdraw buttons on each active deposit
    dialog.querySelectorAll('.ramp-withdraw-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.depositId
        if (!id) return
        btn.disabled = true
        btn.textContent = 'withdrawing…'
        try {
          await _withdrawDeposit(id)
          await _loadDeposits() // refresh list
        } catch (e) {
          console.error('[ramp] withdraw failed:', e)
          btn.textContent = 'failed'
          setTimeout(() => { btn.disabled = false; btn.textContent = 'withdraw' }, 2500)
        }
      })
    })

    dialog.querySelector('#ramp-cancel')?.addEventListener('click', () => {
      cleanup()
      overlay.remove()
    })

    dialog.querySelector('#ramp-confirm')?.addEventListener('click', async () => {
      if (status !== STATUS.idle && status !== STATUS.error) return
      _retryStep = null
      await runOfframp()
    })

    dialog.querySelector('#ramp-retry')?.addEventListener('click', async () => {
      await runOfframp(_retryStep)
    })
  }

  // Method picker sub-modal (mirrors the onramp picker)
  function _showOfframpMethodPicker() {
    const pickerOverlay = document.createElement('div')
    pickerOverlay.className = 'praxis-modal-overlay'
    pickerOverlay.style.zIndex = '10002'
    const pickerDialog = document.createElement('div')
    pickerDialog.className = 'praxis-modal-dialog ramp-dialog'
    pickerDialog.style.maxWidth = '360px'
    pickerDialog.innerHTML = `<div class="ramp-header"><button class="ramp-header-back" id="picker-close"><i class="ph ph-x"></i></button><div class="ramp-header-title">RECEIVE VIA</div><div class="ramp-header-spacer"></div></div>
      <div class="ramp-body">
        ${PAYMENT_METHODS.map(m => `<button class="ramp-rate-row" data-method="${m.id}" style="width:100%;text-align:left" ${m.disabled ? 'disabled' : ''}>
          <div class="ramp-rate-info">
            <i class="ph ${m.icon}" style="font-size:1.1em"></i>
            <span class="ramp-rate-text">${m.label}${m.disabled ? ` <span style="color:var(--dim);font-size:0.75em">(${m.disabledReason || 'soon'})</span>` : ''}</span>
            ${m.id === currentMethod ? '<span class="ramp-rate-best">ACTIVE</span>' : ''}
          </div>
        </button>`).join('')}
      </div>`
    pickerOverlay.appendChild(pickerDialog)
    document.body.appendChild(pickerOverlay)
    pickerOverlay.addEventListener('click', (e) => { if (e.target === pickerOverlay) pickerOverlay.remove() })
    pickerDialog.querySelector('#picker-close')?.addEventListener('click', () => pickerOverlay.remove())
    pickerDialog.querySelectorAll('[data-method]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.disabled) return
        currentMethod = btn.dataset.method
        setPreferredMethod(currentMethod)
        pickerOverlay.remove()
        render()
      })
    })
  }

  // Load the user's active deposits from the SDK indexer
  async function _loadDeposits() {
    _depositsLoading = true
    render()
    try {
      // SDK requires init for getAccountDeposits
      let client = _zkp2pClient
      if (!client) {
        const acct = window.getEmbeddedAccount?.()
        if (acct) {
          const { createWalletClient, http } = await import('./vendor.js')
          const wc = createWalletClient({ chain: BASE_CHAIN, transport: http(BASE_RPC), account: acct })
          client = await initZkp2pClient(wc)
        }
      }
      if (client) {
        const deposits = await client.getAccountDeposits(senderAddress)
        // Filter to active, non-empty deposits
        _myDeposits = (deposits || []).filter(d => {
          const remaining = d.deposit?.remainingDepositAmount ?? d.remainingDepositAmount ?? 0n
          return BigInt(remaining) > 0n
        }).map(d => ({
          depositId: String(d.depositId || d.id || ''),
          remainingDepositAmount: d.deposit?.remainingDepositAmount ?? d.remainingDepositAmount,
          processorName: d.verifiers?.[0] && _resolveProcessorName(d.verifiers[0].methodHash),
          intentHashes: d.deposit?.intentHashes ?? d.intentHashes ?? [],
          raw: d,
        }))
        dbg('[ramp] loaded', _myDeposits.length, 'active deposits')
        // Phase 3: kick off intent polling once we know what deposits exist
        if (_myDeposits.length > 0 && !_intentPollTimer) _startIntentPolling()
      }
    } catch (e) {
      console.warn('[ramp] loadDeposits failed:', e?.message)
      _myDeposits = []
    }
    _depositsLoading = false
    if (!_destroyed) render()
  }

  // Phase 3: poll the indexer every 30s for buyer intents signaled against user's deposits.
  // Surfaces "buyer waiting" alerts; refetches deposits when we detect IntentFulfilled.
  function _startIntentPolling() {
    if (_intentPollTimer) clearInterval(_intentPollTimer)
    const tick = async () => {
      if (_destroyed || _myDeposits.length === 0) return
      try {
        const client = _zkp2pClient
        if (!client?.indexer?.getIntentsForDeposits) return
        const depositIds = _myDeposits.map(d => d.depositId).filter(Boolean)
        if (depositIds.length === 0) return
        const intents = await client.indexer.getIntentsForDeposits(depositIds, ['SIGNALED'])
        const newCount = (intents || []).length
        const prevCount = _activeIntents.length
        _activeIntents = intents || []
        if (newCount > prevCount) {
          dbg('[ramp] new buyer intent signaled against your deposit:', newCount - prevCount)
        }
        // If a previously-active intent has disappeared, it was either fulfilled or cancelled
        // → refetch deposits to update remaining balance + clear it from the dashboard.
        if (newCount < prevCount) {
          dbg('[ramp] intent count dropped — refetching deposits')
          _loadDeposits()
          return
        }
        if (!_destroyed && newCount !== prevCount) render()
      } catch (e) {
        console.warn('[ramp] intent poll failed:', e?.message)
      }
    }
    tick()
    _intentPollTimer = setInterval(tick, 30000)
  }

  function _resolveProcessorName(methodHash) {
    if (!methodHash) return null
    const lc = methodHash.toLowerCase()
    for (const [name, hash] of Object.entries(PAYMENT_METHOD_HASHES)) {
      if (hash.toLowerCase() === lc) return name
    }
    return null
  }

  async function _withdrawDeposit(depositId) {
    const acct = window.getEmbeddedAccount?.()
    if (!acct) throw new Error('embedded wallet locked')
    const { createWalletClient, http } = await import('./vendor.js')
    const wc = createWalletClient({ chain: BASE_CHAIN, transport: http(BASE_RPC), account: acct })
    const client = _zkp2pClient || await initZkp2pClient(wc)
    // SDK exposes withdrawDeposit on the escrow contract
    const prepared = await client.withdrawDeposit.prepare({ depositId: BigInt(depositId) })
    return await wc.sendTransaction({
      to: prepared.to,
      data: prepared.data,
      value: prepared.value || 0n,
      account: wc.account,
      chain: wc.chain,
    })
  }

  async function runOfframp(resumeFrom = null) {
    try {
      // Validate payment details
      const validationError = validatePaymentDetails(currentMethod, paymentDetails)
      if (validationError) {
        status = STATUS.error
        statusDetail = validationError
        _retryStep = null
        render()
        return
      }

      const { createWalletClient, http, parseEther } = await import('./vendor.js')
      // Unlock embedded wallet if locked
      const acct = window.getEmbeddedAccount?.()
      if (!acct) {
        const unlocked = await window.showUnlockPrompt?.()
        if (!unlocked) throw new Error('wallet not unlocked')
      }
      const account = window.getEmbeddedAccount?.()
      if (!account) throw new Error('embedded wallet still locked')

      const amountWei = parseEther(currentAmount.toString())

      // --- Step 0: Check existing Base USDC. If we already have enough, skip bridge+swap. ---
      const expectedUsdc = _ethPriceUsd ? BigInt(Math.floor(parseFloat(currentAmount) * _ethPriceUsd * 1e6)) : 0n
      const existingUsdc = await getUsdcBalance(senderAddress).catch(() => 0n)
      const hasEnoughUsdc = existingUsdc > 0n && expectedUsdc > 0n && existingUsdc >= expectedUsdc * 95n / 100n // 5% slippage tolerance
      if (hasEnoughUsdc && !resumeFrom) {
        dbg('[ramp] sufficient Base USDC already exists — skipping bridge+swap')
        // Jump straight to approve+deposit using existing USDC
        return await _depositExistingUsdc(existingUsdc < expectedUsdc * 105n / 100n ? existingUsdc : expectedUsdc, account)
      }

      // --- Step 1: Bridge ETH from Optimism to Base via Relay ---
      if (!resumeFrom || resumeFrom === 'bridge') {
        status = STATUS.bridging
        statusDetail = ''
        _retryStep = null
        render()

        try {
          const { initRelay } = await import('./relay-bridge.js')
          await initRelay()
          const { getQuote, execute } = await import('./vendor-relay.js')

          const quote = await getQuote({
            chainId: OPTIMISM_CHAIN_ID,
            toChainId: BASE_CHAIN_ID,
            currency: ETH_ADDRESS,
            toCurrency: ETH_ADDRESS,
            amount: amountWei.toString(),
            user: senderAddress,
            recipient: senderAddress,
            tradeType: 'EXACT_INPUT',
          })

          const opWalletClient = createWalletClient({
            account, // embedded
            chain: { id: OPTIMISM_CHAIN_ID, name: 'Optimism', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['https://mainnet.optimism.io'] } } },
            transport: http('https://mainnet.optimism.io'),
          })

          await new Promise((resolve, reject) => {
            execute({
              quote,
              wallet: opWalletClient,
              onProgress: ({ currentStep, currentStepItem, error }) => {
                if (_destroyed) return
                if (error) {
                  reject(new Error(error.message || 'bridge failed'))
                  return
                }
                const statusEl = dialog.querySelector('#ramp-status')
                if (currentStepItem?.status === 'complete' && currentStep?.id === 'deposit') {
                  if (statusEl) statusEl.textContent = 'bridge submitted — waiting for confirmation...'
                } else if (currentStepItem?.status === 'complete') {
                  if (statusEl) statusEl.textContent = 'bridge complete'
                  resolve()
                } else if (currentStepItem?.status === 'incomplete') {
                  if (statusEl) statusEl.textContent = 'bridging ETH to Base...'
                }
              },
            }).then(resolve).catch(reject)
          })
        } catch (e) {
          console.warn('[ramp] bridge failed:', e)
          status = STATUS.error
          statusDetail = `bridge failed: ${e.message || 'unknown error'}. your ETH is still on Optimism.`
          _retryStep = 'bridge'
          render()
          return
        }
      }

      // --- Step 2: Swap ETH → USDC on Base ---
      let usdcAmount
      if (!resumeFrom || resumeFrom === 'bridge' || resumeFrom === 'swap') {
        status = STATUS.swapping
        statusDetail = ''
        render()

        try {
          const baseWalletClient = createWalletClient({
            account, // embedded
            chain: BASE_CHAIN,
            transport: http(BASE_RPC),
          })

          const swapResult = await swapEthToUsdc(amountWei, baseWalletClient, senderAddress)
          usdcAmount = swapResult.usdcReceived
          dbg('[ramp] swapped ETH → USDC:', usdcAmount.toString(), '(6 decimals)')
        } catch (e) {
          console.warn('[ramp] swap failed:', e)
          status = STATUS.error
          statusDetail = `swap failed: ${e.message || 'unknown error'}. your ETH is on Base — retry to swap.`
          _retryStep = 'swap'
          render()
          return
        }
      }

      // If resuming from approve/deposit, read current USDC balance
      if (resumeFrom === 'approve' || resumeFrom === 'deposit') {
        usdcAmount = await getUsdcBalance(senderAddress)
        if (usdcAmount === 0n) {
          status = STATUS.error
          statusDetail = 'no USDC balance on Base — swap may have failed'
          _retryStep = 'swap'
          render()
          return
        }
      }

      // --- Step 3: Approve USDC spend for zkp2p escrow ---
      if (!resumeFrom || resumeFrom !== 'deposit') {
        status = STATUS.approving
        statusDetail = ''
        render()

        try {
          const baseWalletClient = createWalletClient({
            account, // embedded
            chain: BASE_CHAIN,
            transport: http(BASE_RPC),
          })

          // Initialize SDK client
          const client = await initZkp2pClient(baseWalletClient)

          // Use SDK ensureAllowance for max approve
          await client.ensureAllowance({
            token: USDC_BASE,
            amount: usdcAmount,
            maxApprove: true,
          })
        } catch (e) {
          console.warn('[ramp] approve failed:', e)
          status = STATUS.error
          statusDetail = `approval failed: ${e.message || 'unknown error'}. your USDC is safe — retry to approve.`
          _retryStep = 'approve'
          render()
          return
        }
      }

      // --- Step 4: Create deposit on zkp2p ---
      status = STATUS.depositing
      statusDetail = ''
      render()

      let depositHash
      try {
        const baseWalletClient = createWalletClient({
          account, // embedded
          chain: BASE_CHAIN,
          transport: http(BASE_RPC),
        })

        const client = _zkp2pClient || await initZkp2pClient(baseWalletClient)
        const details = paymentDetails.trim()

        // If resuming from deposit, re-read USDC balance
        if (resumeFrom === 'deposit') {
          usdcAmount = await getUsdcBalance(senderAddress)
        }

        const depositResult = await client.createDeposit({
          token: USDC_BASE,
          amount: usdcAmount,
          intentAmountRange: { min: 20_000000n, max: usdcAmount }, // $20 min, full balance max
          processorNames: [currentMethod],
          depositData: [{ [currentMethod === 'cashapp' ? 'cashtag' : currentMethod === 'venmo' ? 'username' : 'email']: details.replace(/^[$@]/, '') }],
          conversionRates: [[{ currency: PAYMENT_METHOD_CURRENCIES[currentMethod] || 'USD', conversionRate: '1000000000000000000' }]],
        })
        depositHash = depositResult.hash
        _lastCreatedDepositId = depositHash // tx hash placeholder; dashboard fetches canonical id
        dbg('[ramp] createDeposit tx:', depositHash)
      } catch (e) {
        console.warn('[ramp] createDeposit failed:', e)
        status = STATUS.error
        statusDetail = `deposit failed: ${e.message || 'unknown error'}. your USDC is approved — retry to create deposit.`
        _retryStep = 'deposit'
        render()
        return
      }

      // --- Done: deposit is live. Don't block the modal waiting for buyers — let user close it. ---
      status = STATUS.done
      statusDetail = ''
      // Refresh deposits dashboard so the new listing appears
      _loadDeposits()
      _scheduleBalanceRefresh()
      render()
    } catch (e) {
      console.warn('[ramp] offramp error:', e)
      status = STATUS.error
      statusDetail = e.message || 'something went wrong'
      render()
    }
  }

  // Fast path: user already has Base USDC (e.g. just bought via onramp). Skip bridge+swap.
  async function _depositExistingUsdc(usdcAmount, account) {
    try {
      const { createWalletClient, http } = await import('./vendor.js')
      const wc = createWalletClient({ chain: BASE_CHAIN, transport: http(BASE_RPC), account })
      const client = _zkp2pClient || await initZkp2pClient(wc)

      // Approve USDC for escrow
      status = STATUS.approving
      render()
      await client.ensureAllowance({ token: USDC_BASE, amount: usdcAmount, maxApprove: true })

      // Create deposit
      status = STATUS.depositing
      render()
      const details = paymentDetails.trim()
      const depositResult = await client.createDeposit({
        token: USDC_BASE,
        amount: usdcAmount,
        intentAmountRange: { min: 5_000000n, max: usdcAmount }, // $5 min, full balance max
        processorNames: [currentMethod],
        depositData: [{ [currentMethod === 'cashapp' ? 'cashtag' : currentMethod === 'venmo' ? 'username' : 'email']: details.replace(/^[$@]/, '') }],
        conversionRates: [[{ currency: PAYMENT_METHOD_CURRENCIES[currentMethod] || 'USD', conversionRate: '1000000000000000000' }]],
      })
      dbg('[ramp] createDeposit tx:', depositResult.hash)
      // Try to extract depositId from receipt logs (TBD — for now use a placeholder so dashboard re-fetches)
      _lastCreatedDepositId = depositResult.hash // fallback to tx hash; dashboard re-fetches for canonical id

      status = STATUS.done
      _loadDeposits()
      _scheduleBalanceRefresh()
      render()
    } catch (e) {
      console.warn('[ramp] _depositExistingUsdc failed:', e)
      status = STATUS.error
      statusDetail = e?.message || 'failed to create deposit'
      render()
    }
  }

  // Mirror of the onramp version — refreshes the dock balance after a tx
  function _scheduleBalanceRefresh() {
    const intervals = [5_000, 15_000, 30_000, 60_000, 120_000, 180_000]
    intervals.forEach(ms => setTimeout(() => {
      window.dispatchEvent(new CustomEvent('wallet-balance-changed'))
    }, ms))
  }

  // Initial render
  document.body.appendChild(overlay)
  render()

  // Load wallet balance + ETH price in parallel; re-render when ready
  Promise.all([
    import('./utils.js').then(({ getCachedBalance }) => getCachedBalance(senderAddress)).catch(() => 0n),
    import('./fiat.js').then(({ getEthPrices }) => getEthPrices()).catch(() => null),
  ]).then(([bal, prices]) => {
    if (_destroyed) return
    _walletBalance = bal
    _ethPriceUsd = prices?.usd || null
    render()
  })

  // Load active deposits in parallel (don't block initial render)
  _loadDeposits()

  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (!document.body.contains(overlay)) {
        observer.disconnect()
        cleanup()
        resolve(status === STATUS.done)
      }
    })
    observer.observe(document.body, { childList: true })
  })
}

// --- Deposit fulfillment polling (offramp) ---

async function pollDepositFulfillment(client, ownerAddress, onStatus) {
  const startTime = Date.now()

  while (Date.now() - startTime < DEPOSIT_TIMEOUT_MS) {
    try {
      // Check deposits for this address
      const deposits = await client.getAccountDeposits(ownerAddress)
      if (deposits && deposits.length > 0) {
        const latest = deposits[deposits.length - 1]

        // Check if any intents have been created against this deposit
        try {
          const intents = await client.indexer.getIntentsForDeposits([latest.depositId || latest.id])
          if (intents && intents.length > 0) {
            onStatus?.('intent_found')

            // Check if intent is fulfilled
            for (const intent of intents) {
              const intentHash = intent.intentHash || intent.id
              try {
                const fulfillments = await client.indexer.getFulfilledIntentEvents([intentHash])
                if (fulfillments && fulfillments.length > 0) {
                  onStatus?.('fulfilled')
                  return { status: 'fulfilled', intentHash }
                }
              } catch {
                // indexer may lag
              }
            }
          }
        } catch {
          // indexer may lag, continue polling
        }
      }
    } catch {
      // transient error, keep polling
    }

    onStatus?.('polling')
    await new Promise(r => setTimeout(r, DEPOSIT_POLL_MS))
  }

  return { status: 'timeout' }
}

// --- Global exposure for lazy loading ---

window.peerOnrampOptimism = async (address, amountUsd) => {
  return showOnrampModal(address, amountUsd)
}

window.peerOfframpOptimism = async (address, amountEth) => {
  return showOfframpModal(address, amountEth)
}
