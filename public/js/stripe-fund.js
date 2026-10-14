// Stripe credit-card → ERC20 project funding orchestrator.
//
// Full flow (per docs/erc20-funding.md §Stripe extension):
//   1. Create Stripe onramp session targeting USDC on Base.
//   2. Mount Stripe widget, await `fulfillment_complete`.
//   3. Bridge USDC Base → Optimism via Relay (reuse relay-bridge.js pattern).
//   4. If project.fundingToken !== USDC_OPTIMISM, swap USDC → funding token
//      on Optimism via Uniswap V3 (swapUsdcToToken in vault.js).
//   5. Call fund-erc20.js:fundProjectTier to execute the on-chain fund call
//      on the Praxis.sol project contract.
//
// Idempotency: Stripe fulfillment can replay. Each step guards against
// re-execution via a localStorage key encoding
//   `praxis-fulfilled-${sessionId}-${projectId}-${tierId}-${quantity}`.
//
// Embedded wallet: if the caller doesn't already have a wallet address,
// the shared `showCreateWalletPrompt` modal (embedded-wallet.js) opens
// to let the user set a password BEFORE Stripe starts — so by the time
// USDC lands on Base the destination address is known. A seamless
// "no-password" flow is a follow-up.

import { USDC_OPTIMISM } from './chains.js'

const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const STRIPE_PK_META = 'stripe-pk'

const STRIPE_FEE_RATE = 0.015   // 1.5% + $0.30 per Stripe Crypto Onramp
const STRIPE_FEE_FLAT = 0.30
const BRIDGE_FEE_FLAT = 0.60    // ~conservative Relay base→optimism estimate
const SWAP_FEE_RATE   = 0.01    // ~1% slippage buffer on BOLD/USDS pools on OP

// Compute the fee breakdown shown to the user BEFORE they confirm Stripe.
// `fiatAmount` is the amount the project tier costs in the user's chosen
// fiat. Returns an object with each line and the total.
export function computeFundingFeeBreakdown(fiatAmount, needsSwap) {
  const amount = Number(fiatAmount) || 0
  const stripeFee = amount * STRIPE_FEE_RATE + STRIPE_FEE_FLAT
  const bridgeFee = BRIDGE_FEE_FLAT
  const swapFee = needsSwap ? amount * SWAP_FEE_RATE : 0
  return {
    tierCost: amount,
    stripeFee,
    bridgeFee,
    swapFee,
    total: amount + stripeFee + bridgeFee + swapFee,
  }
}

// Idempotency key — includes every parameter that would change intent.
function idempotencyKey(sessionId, projectId, tierId, quantity) {
  return `praxis-fulfilled-${sessionId}-${projectId}-${tierId}-${quantity}`
}

function stepDone(key, step) {
  try { return localStorage.getItem(`${key}-${step}`) === '1' } catch { return false }
}

function markStepDone(key, step) {
  try { localStorage.setItem(`${key}-${step}`, '1') } catch { /* private window; proceed */ }
}

// Ensure we have a wallet to receive the USDC. If none exists, open the
// create-wallet prompt. Returns the wallet address or throws if the user
// cancels.
async function ensureWallet() {
  const existing = window.getWalletAddress?.()
  if (existing) return existing
  if (typeof window.showCreateWalletPrompt !== 'function') {
    throw new Error('wallet unavailable — embedded-wallet.js not loaded')
  }
  const addr = await window.showCreateWalletPrompt()
  if (!addr) throw new Error('wallet creation cancelled')
  return addr
}

// Load Stripe's crypto onramp JS exactly once. Idempotent.
async function _loadStripeOnrampSdk() {
  if (window.StripeOnramp && window.Stripe) return
  if (!window.Stripe) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script')
      s.src = 'https://js.stripe.com/v3/'
      s.onload = resolve
      s.onerror = () => reject(new Error('failed to load stripe.js'))
      document.head.appendChild(s)
    })
  }
  if (!window.StripeOnramp) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script')
      s.src = 'https://crypto-js.stripe.com/crypto-onramp-outer.js'
      s.onload = resolve
      s.onerror = () => reject(new Error('failed to load stripe crypto onramp'))
      document.head.appendChild(s)
    })
  }
}

// Mount Stripe's onramp widget inside `containerSelector` and resolve
// once the hosted session reports `fulfillment_complete`. Rejects on
// `rejected` / `canceled` status.
async function mountStripeOnrampAndAwaitFulfillment(clientSecret, containerSelector = '#stripe-container') {
  await _loadStripeOnrampSdk()
  const pk = document.querySelector(`meta[name="${STRIPE_PK_META}"]`)?.content
  if (!pk) throw new Error('Stripe publishable key not found in <meta>')

  const stripeOnramp = window.StripeOnramp(pk)
  const session = stripeOnramp.createSession({ clientSecret, appearance: { theme: 'dark' } })
  session.mount(containerSelector)

  return new Promise((resolve, reject) => {
    session.addEventListener('onramp_session_updated', (e) => {
      const status = e.payload?.session?.status
      if (status === 'fulfillment_complete') resolve()
      else if (status === 'rejected') reject(new Error('card payment rejected'))
      else if (status === 'canceled') reject(new Error('card payment cancelled'))
    })
  })
}

// Create the Stripe onramp session via the orchestrator. The session
// targets USDC on Base so Praxis can bridge + swap afterward without
// any user interaction.
async function createOnrampSession(wallet, amountUsd) {
  const res = await fetch('/orchestrator/create-onramp-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      wallet,
      amount_usd: amountUsd,
      token: 'USDC',
      chain: 'base',
    }),
  })
  const data = await res.json().catch(() => ({}))
  const clientSecret = data.clientSecret || data.client_secret
  if (!clientSecret) throw new Error(data.error || 'onramp session failed')
  return { clientSecret, sessionId: data.sessionId || data.session_id || data.id || clientSecret }
}

// Bridge USDC Base → USDC Optimism via Relay. Mirrors
// bridgeUsdcToOptimismEth's shape but keeps the destination currency as
// USDC on Optimism (we handle the token swap in a separate step via
// Uniswap V3 so slippage/path is visible and auditable).
async function bridgeUsdcBaseToOptimism(address, amountUsd, onStatus) {
  const { initRelay } = await import('./relay-bridge.js')
  await initRelay()
  const { execute } = await import('./vendor-relay.js')

  // USDC on both sides is 6 decimals.
  const amountUsdcBase = BigInt(Math.round(amountUsd * 1_000_000))

  onStatus?.('getting bridge quote...')
  const quoteRes = await fetch('/api/relay/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      originChainId: 8453,
      destinationChainId: 10,
      originCurrency: USDC_BASE,
      destinationCurrency: USDC_OPTIMISM,
      tradeType: 'EXACT_INPUT',
      amount: amountUsdcBase.toString(),
      user: address,
      recipient: address,
    }),
  })
  const quote = await quoteRes.json().catch(() => ({}))
  if (!quoteRes.ok) throw new Error(quote?.error || quote?.message || `bridge quote HTTP ${quoteRes.status}`)

  onStatus?.('confirm bridge in wallet...')
  const { _buildBridgeWalletClient } = await import('./relay-bridge.js')
  const walletClient = await _buildBridgeWalletClient(8453)

  let lastTxHash = null
  return new Promise((resolve, reject) => {
    execute({
      quote,
      wallet: walletClient,
      onProgress: ({ currentStep, currentStepItem, txHashes, error }) => {
        if (txHashes?.length) lastTxHash = txHashes[txHashes.length - 1]?.txHash || lastTxHash
        if (currentStepItem?.txHashes?.length) {
          lastTxHash = currentStepItem.txHashes[currentStepItem.txHashes.length - 1]?.txHash || lastTxHash
        }
        if (error) return reject(new Error(error.message || 'bridge failed'))
        if (currentStep?.id === 'approve') onStatus?.('approving USDC on Base...')
        else if (currentStepItem?.status === 'complete' && currentStep?.id === 'deposit') {
          onStatus?.('bridge submitted — USDC arriving on Optimism...')
        } else if (currentStepItem?.status === 'complete') {
          onStatus?.('bridge complete')
          resolve(lastTxHash)
        }
      },
    }).then(() => {
      onStatus?.('bridge complete')
      resolve(lastTxHash)
    }).catch((err) => {
      const msg = err?.message || ''
      // Same indexer-lag workaround as the ETH bridge: Relay's /transactions/index
      // sometimes 404s immediately after submission while Base finalizes. Treat as
      // in-flight success — the destination balance polling (next step) will
      // confirm arrival.
      if (lastTxHash && (msg.includes('Transaction receipt not found') || msg.includes('not found') || msg.includes('404'))) {
        onStatus?.('bridge in flight — USDC will arrive on Optimism in ~2 min')
        return resolve(lastTxHash)
      }
      reject(err)
    })
  })
}

// Wait up to `timeoutMs` for the USDC balance on Optimism at `addr` to
// reach `expectedAmount`. Polls every 5s. Used after the bridge call so
// subsequent steps (swap, fund) have real tokens to spend.
async function waitForUsdcOnOptimism(addr, expectedAmount, onStatus, timeoutMs = 180_000) {
  const { createPublicClient, http, optimism } = await import('./vendor.js')
  const { rpcUrlFor } = await import('./chains.js')
  const rpcUrl = rpcUrlFor(10)
  const chainDef = { ...optimism, rpcUrls: { ...optimism.rpcUrls, default: { http: [rpcUrl] } } }
  const pc = createPublicClient({ chain: chainDef, transport: http(rpcUrl) })
  const ERC20_BALANCE_ABI = [{
    name: 'balanceOf', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  }]
  // 10% tolerance — Relay fees eat a small slice; we don't want to spin
  // forever waiting for the exact amount.
  const minArrival = (expectedAmount * 90n) / 100n
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const bal = await pc.readContract({
      address: USDC_OPTIMISM, abi: ERC20_BALANCE_ABI, functionName: 'balanceOf', args: [addr],
    }).catch(() => 0n)
    if (bal >= minArrival) {
      onStatus?.('USDC on Optimism confirmed')
      return bal
    }
    await new Promise(r => setTimeout(r, 5000))
  }
  throw new Error('timed out waiting for USDC on Optimism')
}

// Main entry point. Executes the full Stripe → bridge → swap → fund flow
// for a project. Each phase emits a human-readable status via onStatus.
//
// Params:
//   project      — { id, fundingToken, fundingTokenSymbol, fundingTokenDecimals, tierPrice, ... }
//                  tierPrice is the matching tier's wei price; the caller merges it in
//                  from the project's tiers[] before calling. fund-erc20 reads it to size
//                  the approve + fundTier arguments.
//   tierId       — numeric tier index on the project
//   quantity     — number of units of this tier to purchase
//   fiatAmount   — USD amount to charge the card for (should equal tier price × quantity + fees)
//   opts         — { onStatus, stripeContainerSelector }
//
// Returns the fund() tx hash on success.
export async function stripeToFundingToken(project, tierId, quantity, fiatAmount, opts = {}) {
  const onStatus = opts.onStatus || (() => {})
  const stripeContainerSelector = opts.stripeContainerSelector || '#stripe-container'

  if (!project || !project.id) throw new Error('stripeToFundingToken: project.id required')
  if (!project.fundingToken) throw new Error('stripeToFundingToken: project.fundingToken required')
  if (!project.tierPrice) throw new Error('stripeToFundingToken: project.tierPrice required (merge the matching tier.price in)')
  if (!fiatAmount || fiatAmount <= 0) throw new Error('stripeToFundingToken: fiatAmount must be > 0')

  onStatus('preparing wallet...')
  const wallet = await ensureWallet()

  onStatus('creating payment session...')
  const { clientSecret, sessionId } = await createOnrampSession(wallet, fiatAmount)

  const idemKey = idempotencyKey(sessionId, project.id, tierId, quantity)

  onStatus('awaiting card payment...')
  if (!stepDone(idemKey, 'stripe')) {
    await mountStripeOnrampAndAwaitFulfillment(clientSecret, stripeContainerSelector)
    markStepDone(idemKey, 'stripe')
  }

  onStatus('bridging USDC to Optimism...')
  if (!stepDone(idemKey, 'bridge')) {
    await bridgeUsdcBaseToOptimism(wallet, fiatAmount, onStatus)
    markStepDone(idemKey, 'bridge')
  }

  // USDC on OP uses 6 decimals.
  const amountUsdcOp = BigInt(Math.round(fiatAmount * 1_000_000))
  const arrivedBal = await waitForUsdcOnOptimism(wallet, amountUsdcOp, onStatus)

  const needsSwap = project.fundingToken.toLowerCase() !== USDC_OPTIMISM.toLowerCase()
  if (needsSwap) {
    onStatus(`swapping to ${project.fundingTokenSymbol || 'funding token'}...`)
    if (!stepDone(idemKey, 'swap')) {
      const { swapUsdcToToken } = await import('./vault.js')
      // Use `arrivedBal` (actual balance) not amountUsdcOp (expected) so a
      // slightly-reduced bridge delivery still swaps everything that landed.
      await swapUsdcToToken(wallet, arrivedBal, project.fundingToken, onStatus)
      markStepDone(idemKey, 'swap')
    }
  }

  onStatus('funding project...')
  const { fundProjectTier } = await import('./fund-erc20.js')
  // fund-erc20 wants the project object (reads id, fundingToken, tierPrice)
  // and the status callback as a bare function (not {onStatus} wrapper).
  const txHash = await fundProjectTier(project, tierId, quantity, onStatus)
  markStepDone(idemKey, 'fund')

  onStatus('funding complete')
  return txHash
}

// Named exports for the fund.html inliner — keep the single-purpose helpers
// callable in case the modal flow wants to show partial progress or retry
// an individual step.
export {
  USDC_BASE,
  mountStripeOnrampAndAwaitFulfillment,
  createOnrampSession,
  bridgeUsdcBaseToOptimism,
  waitForUsdcOnOptimism,
  idempotencyKey,
}
