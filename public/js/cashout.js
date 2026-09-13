// Cash out — real peer.xyz offramp sheet via @zkp2p/cash.
//
// Ships the actual buyer-matching flow: USDC (or ETH) on Optimism →
// Base USDC via Relay → EscrowV2 deposit on Base → Peer taker signals
// intent, sends fiat to the payee handle, submits a TEE-TLS proof →
// escrow releases USDC → USD (or EUR / GBP / JPY / etc.) lands in the
// user's Venmo / PayPal / Cash App / Zelle / Wise / Revolut / Alipay
// / UPI account.
//
// FIAT-PRIMARY UX (per docs/cashout-plan.md Sprint 1):
//   - User types "50" in their fiat of choice; USDC/ETH is a tiny
//     meta line below the input, not the primary label.
//   - Balance shown in fiat: "$47.32 available (0.0181 ETH on Optimism)"
//     — source chain + token surface as secondary detail so the user
//     never has to think in crypto units.
//   - Quote is always in target fiat with delta-aware copy: "you'll
//     get $49.85" — receiveAmount reflects real Relay + spread.
//   - Handle recall + client-side format check + mobile-friendly
//     platform gating (Wise/PayPal need Peer's browser extension →
//     hidden on touch devices).
//
// Design decisions grounded in @zkp2p/cash/dist/createCashClient-*.d.ts.

import { registerPage, escapeHtml, getPublicClient, getWalletProvider, getAuthToken } from './utils.js'
import { t, whenReady as i18nReady } from './i18n.js'
import { getUserCurrency, getEthPrices, formatFiat } from './fiat.js'

// ─── Peer.xyz config ───

// Public integrator key, exposed client-side by SDK design (curator
// calls made from the browser). Rotate via <meta name="peer-cash-api-key">
// OR window.PEER_CASH_API_KEY without a code change.
const PEER_CASH_API_KEY_FALLBACK = 'fwRSnzmXz9BPWt6Dm-h1XdhglpoGV3XWwTjFDyswSso'
function _peerCashApiKey() {
  try {
    const meta = document.querySelector('meta[name="peer-cash-api-key"]')?.content
    if (meta) return meta
  } catch {}
  if (typeof window !== 'undefined' && window.PEER_CASH_API_KEY) return window.PEER_CASH_API_KEY
  return PEER_CASH_API_KEY_FALLBACK
}

const PEER_SUPPORTED_CURRENCIES = new Set([
  'AED','ARS','AUD','BRL','CAD','CHF','CNY','CZK','DKK','EUR','GBP',
  'HKD','HUF','IDR','ILS','INR','JPY','KES','MXN','MYR','NOK','NZD',
  'PHP','PLN','RON','SAR','SEK','SGD','THB','TRY','UGX','USD','VND','ZAR',
])
function _cashoutCurrency() {
  const c = String(getUserCurrency() || 'usd').toUpperCase()
  return PEER_SUPPORTED_CURRENCIES.has(c) ? c : 'USD'
}

registerPage('cashout-page', initCashout)

const OPTIMISM_CHAIN_ID = 10
const BASE_CHAIN_ID = 8453
const OPTIMISM_USDC = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85'
const ETH_NATIVE = '0x0000000000000000000000000000000000000000'
const USDC_DECIMALS = 6
const ETH_DECIMALS = 18
const BOLD_DECIMALS = 18
// Liquity V2 BOLD lives on Ethereum L1. Verified via
// scripts/bold-cashout-dryrun.js that Peer/Relay accepts it as a
// source directly — BOLD → USDC on Base is a normal source route,
// no manual swap needed on our side. The only cashout-specific work
// is unstaking BOLD from the SPs when the user's liquid balance
// doesn't cover the requested amount.
const BOLD_MAINNET = '0x6440f144b7e50d6a8439336510312d2f54beb01d'
const BOLD_SPS = {
  ETH:    '0x5721cbbd64fc7ae3ef44a0a3f9a790a9264cf9bf',
  rETH:   '0xd442e41019b7f5c4dd78f50dc03726c446148695',
  wstETH: '0x9502b7c397e9aa22fe9db7ef7daf21cd2aebe56b',
}
// Withdraw is the same shape as provideToSP in earnings.js — Liquity
// v2 SP surface is deposit/withdraw symmetric. Second arg claims the
// ETH yield along with the withdrawal so the user's yield lands in
// their wallet automatically (their money, no reason to strand it).
const BOLD_SP_ABI = [
  { name: 'getCompoundedBoldDeposit', type: 'function', stateMutability: 'view',
    inputs: [{ name: '_depositor', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'withdrawFromSP', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: '_amount', type: 'uint256' }, { name: '_doClaim', type: 'bool' }], outputs: [] },
]
const RECOMMENDED_MIN_FIAT = 3 // Peer's own floor
const BASE_GAS_MIN_WEI = 200_000_000_000_000n // 0.0002 ETH

// Platform UI hints ONLY — icon, handle-format string, client-side
// validation regex. The `requiresIdentityAttestation` bit is the SDK's
// source of truth (read from `capabilities()` per platform); previous
// versions had a hardcoded `attest` field here that shadowed the SDK
// and mislabeled Alipay as extension-free.
const PLATFORMS = {
  venmo: {
    icon: 'ph-hand-coins',
    hint: '@username',
    validate: /^@?[A-Za-z0-9._-]{3,30}$/,
  },
  cashapp: {
    icon: 'ph-dollar',
    hint: '$cashtag',
    validate: /^\$?[A-Za-z0-9_.-]{1,20}$/,
  },
  zelle: {
    icon: 'ph-bank',
    hint: 'email or phone',
    validate: /^([^@\s]+@[^@\s]+\.[^@\s]+|\+?\d[\d\s\-.()]{6,20})$/,
  },
  revolut: {
    icon: 'ph-credit-card',
    hint: '@revtag',
    validate: /^@?[A-Za-z0-9._]{2,40}$/,
  },
  monzo: {
    icon: 'ph-bank',
    hint: '@username or phone',
    validate: /^(@[A-Za-z0-9._]{2,30}|\+?\d[\d\s\-.()]{6,20})$/,
  },
  chime: {
    icon: 'ph-bank',
    hint: '$ChimeSign',
    validate: /^\$?[A-Za-z0-9._-]{1,30}$/,
  },
  mercadopago: {
    icon: 'ph-credit-card',
    hint: 'CVU / alias / email',
    validate: /.{4,}/,
  },
  upi: {
    icon: 'ph-globe',
    hint: 'handle@bank',
    validate: /^[A-Za-z0-9._-]{2,}@[A-Za-z]{2,}$/,
  },
  wise: {
    icon: 'ph-globe',
    hint: 'email address',
    validate: /^[^@\s]+@[^@\s]+\.[^@\s]+$/,
  },
  paypal: {
    icon: 'ph-paypal-logo',
    hint: 'email address',
    validate: /^[^@\s]+@[^@\s]+\.[^@\s]+$/,
  },
  alipay: {
    icon: 'ph-qr-code',
    hint: 'Alipay ID',
    validate: /.{4,}/,
  },
}

// ─── LocalStorage helpers ───

function _ordersKey(addr) { return `praxis-cashout-orders:${addr.toLowerCase()}` }
function _handleKey(addr, platform) { return `praxis-cashout-handle:${addr.toLowerCase()}:${platform}` }

function _rememberDepositId(addr, depositId) {
  try {
    const key = _ordersKey(addr)
    const set = new Set(JSON.parse(localStorage.getItem(key) || '[]'))
    set.add(depositId)
    const arr = [...set].slice(-10)
    localStorage.setItem(key, JSON.stringify(arr))
  } catch {}
}

// Server-side deposit persistence. Best-effort — a network failure
// here doesn't block the flow (the depositId is already in
// localStorage and on-chain).
async function _syncDepositToServer(record, token) {
  if (!token) return
  try {
    await fetch('/api/cashout/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(record),
    })
  } catch (e) { console.warn('cashout server sync failed:', e?.message) }
}

async function _readServerOrders(token) {
  if (!token) return []
  try {
    const res = await fetch('/api/cashout/orders', {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data?.orders) ? data.orders : []
  } catch { return [] }
}
function _rememberHandle(addr, platform, handle) {
  try { localStorage.setItem(_handleKey(addr, platform), handle) } catch {}
}
function _recallHandle(addr, platform) {
  try { return localStorage.getItem(_handleKey(addr, platform)) || '' } catch { return '' }
}

// Mobile check — Wise + PayPal require Peer's TEE browser extension,
// which doesn't run on mobile. Cleaner to hide than fail silently.
function _isMobile() {
  try { return matchMedia('(pointer: coarse)').matches } catch { return false }
}

// ─── Init ───

async function initCashout() {
  const el = document.getElementById('cashout-content')
  if (!el) return
  await i18nReady()

  const addr = window.getWalletAddress?.()
  if (!addr) {
    el.innerHTML = `<p style="color:var(--muted);text-align:center;padding:2em">connect wallet to cash out</p>`
    return
  }

  const cashCurrency = _cashoutCurrency()

  // Decide upfront which page this is: pending or entry. The vault
  // design philosophy — one story per page — means we render one or
  // the other. Concurrent cash-outs are legal on peer.xyz; the
  // pending page lists them all and has a "start another" affordance
  // that lands here with ?new=1 to bypass this check.
  const bypassPending = new URL(window.location.href).searchParams.get('new') === '1'
  if (!bypassPending) {
    const pending = await _findPendingCashout(addr, cashCurrency).catch(() => null)
    if (pending) {
      el.innerHTML = _renderPendingShell(pending)
      _wirePendingShell(el, pending)
      return
    }
  }

  el.innerHTML = _renderShell()
  const els = _wireEls(el)

  const userCurrencyRaw = String(getUserCurrency() || 'usd').toUpperCase()
  const currencyMismatch = cashCurrency !== userCurrencyRaw

  // Prices first (need them to compute chain fiat totals), then
  // multi-chain balances + legacy read + Base gas balance in parallel.
  const ethPrices = await getEthPrices().catch(() => null)
  const [chainBalances, legacyBalances] = await Promise.all([
    _readMultiChainBalances(addr, ethPrices, cashCurrency).catch(() => []),
    _readBalances(addr).catch(() => null),
  ])
  const balances = legacyBalances  // for the submit-path auto-bridge check

  // Auto-pick the highest-value chain source. The user can override
  // by tapping a specific chain in the breakdown; that's stored in
  // `selectedSource` which the deposit path reads at submit time.
  let selectedSource = _pickBestSource(chainBalances) || {
    chainId: OPTIMISM_CHAIN_ID, name: 'Optimism', kind: 'usdc',
    amountFiat: 0, amountBase: 0n,
  }
  // Legacy alias into the existing sheet code — sourceKind/currency
  // now derive from selectedSource so quote + submit follow the pick.
  let sourceKind = selectedSource.kind
  let sourceCurrency = _sourceCurrencyFor(selectedSource)
  let sourceDecimals = _sourceDecimalsFor(selectedSource.kind)

  _renderBalanceHero(els, chainBalances, ethPrices, cashCurrency, selectedSource, (picked) => {
    selectedSource = picked
    sourceKind = picked.kind
    sourceCurrency = _sourceCurrencyFor(picked)
    sourceDecimals = _sourceDecimalsFor(picked.kind)
    // Force the quote to re-run for the new source. Firing the input
    // event on the amount input is the least-coupled way — the same
    // listener that runs when the user changes the amount picks this
    // up and re-quotes with the new source.
    try { els.amountInput?.dispatchEvent(new Event('input')) } catch {}
  })
  els.amountCurrency.textContent = _currencySymbol(cashCurrency)

  // SDK
  let sdk
  try {
    sdk = await import('./vendor-cash.js')
  } catch (e) {
    els.status.textContent = "couldn't load the cash-out engine — try again in a minute"
    console.warn('vendor-cash import failed:', e)
    return
  }

  const params = new URL(window.location.href).searchParams
  const env = params.get('env') === 'staging' ? 'staging' : 'production'

  // Build a "bare" Relay client with no `source` (referrer) so
  // Relay's quote endpoint doesn't 401 with UNAUTHORIZED_QUOTE. See
  // vendor-cash-src.js for the full explanation; short version: any
  // named referrer without a Relay-issued API key gets gated, and the
  // SDK's default 'peer-cash' name triggers it. Anonymous quotes are
  // still open. In the browser, RelayClient auto-fills source from
  // location.hostname if we don't pass one — so we set it to a
  // sentinel then wipe the field to force undefined.
  const bareRelay = sdk.createRelayClient({ baseApiUrl: sdk.MAINNET_RELAY_API })
  bareRelay.source = undefined

  const client = sdk.createCashClient({
    environment: env,
    rpcUrl: 'https://mainnet.base.org',
    apiKey: _peerCashApiKey(),
    referrer: 'praxis',
    relay: { client: bareRelay },
  })

  // Capabilities + fill stats in parallel. `includeRelaySources: true`
  // picks up ETH + USDC on our source chains.
  let caps, fillStats
  try {
    [caps, fillStats] = await Promise.all([
      client.capabilities({ includeRelaySources: true }),
      client.fillStats().catch(() => ({})),
    ])
  } catch (e) {
    els.status.textContent = 'cash-out platform list unavailable — try again in a moment'
    console.warn('cashout capabilities failed', e)
    return
  }

  const allPlatforms = caps.platforms || []
  const mobile = _isMobile()
  const rerenderPlatforms = () => {
    const usable = _filterPlatforms(allPlatforms, fillStats, cashCurrency)
    _renderPlatforms(els.platforms, usable, mobile)
    _renderExtToggle(els.platforms, allPlatforms, () => rerenderPlatforms())
  }
  rerenderPlatforms()

  // ─── Interactions ───

  let selectedPlatform = null
  let latestEstimate = null
  let quoteToken = 0
  let handleValidTimer = null

  els.platforms.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.cashout-platform')
    if (!btn || btn.disabled) return
    els.platforms.querySelectorAll('.cashout-platform').forEach(x => x.classList.remove('cashout-platform-active'))
    btn.classList.add('cashout-platform-active')
    selectedPlatform = btn.dataset.platform
    const meta = PLATFORMS[selectedPlatform] || { hint: 'handle' }
    els.payeeLabel.textContent = `your ${_prettyPlatform(selectedPlatform)} ${meta.hint}`
    els.payeeInput.placeholder = meta.hint
    els.payeeField.hidden = false
    // Platform-aware input mode so mobile keyboards do the right thing:
    // email fields → email keyboard (@ + .com row), Zelle → tel keyboard
    // when the hint suggests a phone number (Zelle accepts both, we can't
    // predict — default to text but bias toward the shown hint), Cash App /
    // Venmo / Revolut / UPI stay text since usernames often mix letters +
    // symbols. Autocomplete tokens let iOS / Android surface the right
    // suggestion from Contacts.
    if (selectedPlatform === 'paypal' || selectedPlatform === 'wise') {
      els.payeeInput.setAttribute('inputmode', 'email')
      els.payeeInput.setAttribute('autocomplete', 'email')
      els.payeeInput.setAttribute('type', 'email')
    } else if (selectedPlatform === 'zelle') {
      // Zelle accepts email OR phone — bias to text so we don't force
      // a numeric keyboard on someone typing an email address.
      els.payeeInput.setAttribute('inputmode', 'text')
      els.payeeInput.setAttribute('autocomplete', 'tel')
      els.payeeInput.setAttribute('type', 'text')
    } else {
      els.payeeInput.setAttribute('inputmode', 'text')
      els.payeeInput.setAttribute('autocomplete', 'username')
      els.payeeInput.setAttribute('type', 'text')
    }
    // QR-scan button — only useful when the platform accepts a value
    // someone can encode in a QR (phone + email work). Also gated by
    // BarcodeDetector availability (native on Chrome + Safari iOS 17+).
    const canScan = typeof window !== 'undefined' && 'BarcodeDetector' in window
    const scannable = canScan && (selectedPlatform === 'zelle' || selectedPlatform === 'paypal' || selectedPlatform === 'wise')
    els.payeeScan.hidden = !scannable
    // Prefill from recall.
    const remembered = _recallHandle(addr, selectedPlatform)
    if (remembered && !els.payeeInput.value) {
      els.payeeInput.value = remembered
    }
    _validateHandle()
    if (btn.dataset.attest === '1') {
      els.status.textContent = `${_prettyPlatform(selectedPlatform)} needs a one-time identity check via Peer's browser extension — see peer.xyz`
    } else {
      els.status.textContent = ''
    }
    _refreshQuote()
  })

  // QR scanner — for platforms where the payee handle is a phone or
  // email that someone else already has as a QR (business cards,
  // contact cards, sharing sheets). Chrome + iOS Safari 17+ have
  // BarcodeDetector natively. Uses the same MediaDevices flow the
  // ticket check-in scanner uses in project-detail.js.
  let _cashScanStream = null
  let _cashScanTimer = null
  els.payeeScan?.addEventListener('click', async () => {
    if (!els.payeeScan.hidden) {
      els.scanner.hidden = false
      try {
        _cashScanStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' }, audio: false,
        })
      } catch { els.scanner.hidden = true; els.status.textContent = 'camera access denied — type the handle instead'; return }
      els.scanVideo.srcObject = _cashScanStream
      await els.scanVideo.play().catch(() => {})
      const Detector = window.BarcodeDetector
      const detector = new Detector({ formats: ['qr_code'] })
      const tick = async () => {
        if (!_cashScanStream) return
        try {
          const codes = await detector.detect(els.scanVideo)
          if (codes && codes.length > 0) {
            const raw = String(codes[0].rawValue || '').trim()
            // Extract likely handle: strip common URI prefixes.
            const cleaned = raw.replace(/^mailto:/i, '').replace(/^tel:/i, '').replace(/\?.*$/, '')
            els.payeeInput.value = cleaned
            els.payeeInput.dispatchEvent(new Event('input'))
            _cashScanClose()
            return
          }
        } catch {}
        _cashScanTimer = setTimeout(tick, 250)
      }
      tick()
    }
  })
  function _cashScanClose() {
    if (_cashScanTimer) { clearTimeout(_cashScanTimer); _cashScanTimer = null }
    if (_cashScanStream) { _cashScanStream.getTracks().forEach(t => t.stop()); _cashScanStream = null }
    els.scanner.hidden = true
  }
  els.scanClose?.addEventListener('click', _cashScanClose)

  // Amount is fiat — strip anything that isn't a digit or a single
  // decimal separator (accept both `.` and `,` for locale). Input is
  // type=text (not type=number) so we get consistent mobile UX; that
  // means WE do the sanitization. Preserve caret position when the
  // user pastes junk from a copy/paste.
  els.amountInput.addEventListener('input', (ev) => {
    const raw = ev.target.value
    const cleaned = raw
      .replace(/,/g, '.')
      .replace(/[^\d.]/g, '')
      .replace(/^(\d*\.\d*)\..*$/, '$1')
    if (cleaned !== raw) {
      const caret = ev.target.selectionStart
      ev.target.value = cleaned
      const dropped = raw.length - cleaned.length
      try { ev.target.setSelectionRange(Math.max(0, caret - dropped), Math.max(0, caret - dropped)) } catch {}
    }
    _refreshQuote()
  })
  els.payeeInput.addEventListener('input', () => {
    // Debounce to avoid a green flicker while the user is still typing.
    clearTimeout(handleValidTimer)
    handleValidTimer = setTimeout(_validateHandle, 200)
    _updateSubmitState()
  })

  function _validateHandle() {
    if (!selectedPlatform) return
    const v = els.payeeInput.value.trim()
    const meta = PLATFORMS[selectedPlatform]
    els.payeeCheck.hidden = v.length === 0
    if (!v) return
    const ok = meta?.validate?.test(v) !== false
    els.payeeCheck.textContent = ok ? '✓' : '×'
    els.payeeCheck.style.color = ok ? 'var(--green)' : '#ef4444'
    els.payeeCheck.title = ok ? 'looks like a valid handle' : `expected ${meta?.hint || 'a handle'}`
  }

  async function _refreshQuote() {
    const fiatAmt = _parseFiat(els.amountInput.value)
    _updateSubmitState()
    els.amountConversion.textContent = ''
    if (!fiatAmt || fiatAmt <= 0 || !selectedPlatform) {
      els.quote.hidden = true
      return
    }
    // Convert fiat → source token base units using the ETH price feed.
    const sourceAmt = _fiatToSource(fiatAmt, cashCurrency, sourceKind, ethPrices)
    if (!sourceAmt || sourceAmt <= 0n) {
      els.quote.hidden = true
      return
    }
    // Show the tiny meta line so the user can see the bridge maths
    // without it dominating the UI.
    els.amountConversion.textContent = `≈ ${_sourceDisplay(sourceAmt, sourceKind)} on ${selectedSource.name}`

    const myToken = ++quoteToken
    els.quote.hidden = false
    els.quoteAmount.textContent = 'checking rate…'
    els.quoteEta.textContent = ''
    try {
      const est = await client.estimate({
        amount: sourceAmt,
        currency: cashCurrency,
        platform: selectedPlatform,
        source: {
          chainId: selectedSource.chainId,
          currency: sourceCurrency,
          user: addr,
          recipient: addr,
          tradeType: 'EXACT_INPUT',
        },
      }, { includeEta: true })
      if (myToken !== quoteToken) return
      latestEstimate = est
      els.quoteAmount.textContent = _formatFiat(est.receiveAmount, est.currency || cashCurrency)
      const parts = []
      if (est.eta?.label) parts.push(est.eta.label)
      else if (est.eta?.seconds != null) parts.push(`typically ~${Math.round(est.eta.seconds / 60)} min`)
      if (currencyMismatch) parts.push(`Peer doesn't quote in ${userCurrencyRaw} yet — showing ${cashCurrency}`)
      els.quoteEta.textContent = parts.join(' · ')
    } catch (e) {
      if (myToken !== quoteToken) return
      els.quoteAmount.textContent = '—'
      els.quoteEta.textContent = _humanError(e)
    }
  }

  function _updateSubmitState() {
    const fiatAmt = _parseFiat(els.amountInput.value)
    // Use the selected source's balance for the "only \$X available"
    // check — could be USDC on Base, ETH on Arbitrum, etc.
    const bal = selectedSource.amountBase || 0n
    const balFiat = selectedSource.amountFiat || 0
    const hasPayee = els.payeeInput.value.trim().length > 0
    const meta = selectedPlatform ? PLATFORMS[selectedPlatform] : null
    const handleOk = meta?.validate?.test(els.payeeInput.value.trim()) !== false

    if (!selectedPlatform) { els.submitBtn.textContent = 'pick a payout method'; els.submitBtn.disabled = true; return }
    if (!fiatAmt || fiatAmt <= 0) { els.submitBtn.textContent = 'enter an amount'; els.submitBtn.disabled = true; return }
    if (fiatAmt > balFiat) {
      els.submitBtn.textContent = `only ${_formatFiat(balFiat, cashCurrency)} available`
      els.submitBtn.disabled = true
      return
    }
    if (!hasPayee) { els.submitBtn.textContent = 'add your handle'; els.submitBtn.disabled = true; return }
    if (!handleOk) { els.submitBtn.textContent = `not a valid ${meta?.hint || 'handle'}`; els.submitBtn.disabled = true; return }
    if (latestEstimate?.receiveAmount != null && latestEstimate.receiveAmount < RECOMMENDED_MIN_FIAT) {
      els.submitBtn.textContent = `${_formatFiat(RECOMMENDED_MIN_FIAT, cashCurrency)} minimum`
      els.submitBtn.disabled = true
      return
    }
    els.submitBtn.textContent = `cash out ${_formatFiat(latestEstimate?.receiveAmount || 0, cashCurrency)}`
    els.submitBtn.disabled = false
  }

  // ─── Submit ───

  els.submitBtn.addEventListener('click', async () => {
    const fiatAmt = _parseFiat(els.amountInput.value)
    if (!fiatAmt || !selectedPlatform || !els.payeeInput.value.trim()) return
    const sourceAmt = _fiatToSource(fiatAmt, cashCurrency, sourceKind, ethPrices)
    if (!sourceAmt || sourceAmt <= 0n) return

    els.submitBtn.disabled = true
    els.submitBtn.textContent = 'preparing…'
    els.status.textContent = ''

    // Base ETH gas — silent auto-bridge. Zero-crypto users should
    // never see the words "Base" or "gas". If the Base signer is
    // below the floor, we send a small top-up via Relay before
    // proceeding. The user sees "preparing your Praxis account…" for
    // 30-60s; internally it's a full Relay quote + tx + poll cycle.
    try {
      let baseEth = balances?.baseEth ?? await _readBaseEthBalance(addr)
      if (baseEth < BASE_GAS_MIN_WEI) {
        els.status.textContent = 'preparing your Praxis account…'
        els.submitBtn.textContent = 'setting up…'
        const { bridgeEthOptimismToBase } = await import('./relay-bridge.js')
        // Bridge 3× the gas floor so the user has runway for a retry
        // AND enough left over that a follow-up cash-out doesn't
        // re-trigger this every session. ~$1.80 at $3000/ETH.
        const topUp = BASE_GAS_MIN_WEI * 3n
        baseEth = await bridgeEthOptimismToBase(addr, topUp, (msg) => {
          els.status.textContent = `preparing your Praxis account · ${msg}`
        })
        // Refresh cached balance so a later insufficient-funds check
        // doesn't fire spuriously.
        if (balances) balances.baseEth = baseEth
      }
    } catch (e) {
      console.warn('base gas top-up failed', e)
      els.status.textContent = `we couldn't set up your account for the transfer — ${_humanError(e).slice(0, 140)}`
      els.submitBtn.textContent = 'try again'
      els.submitBtn.disabled = false
      return
    }

    // Remember the handle so next open prefills it.
    _rememberHandle(addr, selectedPlatform, els.payeeInput.value.trim())

    try {
      const { createWalletClient, http, base, optimism, mainnet, arbitrum, polygon } = await import('./vendor.js')
      // Ensure the embedded wallet is unlocked so getEmbeddedAccount
      // returns the viem LocalAccount we sign with. Same helper every
      // other Praxis signing surface uses — pops the password modal
      // when the session's expired.
      if (typeof window.ensureAuthorized === 'function') {
        els.status.textContent = 'unlocking your wallet…'
        try {
          await window.ensureAuthorized(addr)
        } catch (e) {
          els.status.textContent = 'wallet unlock cancelled — try again when ready'
          els.submitBtn.textContent = 'try again'
          els.submitBtn.disabled = false
          return
        }
      }
      const embeddedAcct = window.getEmbeddedAccount?.()
      if (!embeddedAcct) {
        els.status.textContent = 'wallet still locked — enter your password and try again'
        els.submitBtn.textContent = 'try again'
        els.submitBtn.disabled = false
        return
      }
      // Build chain-specific signers with HTTP transports to each
      // chain's real RPC, not the EIP-1193 provider (which reports
      // chainId=10 for everything, tripping the Peer SDK's
      // assertWalletChainId checks). baseSigner always lands on Base
      // (that's where Peer's escrow lives); sourceSigner lands on
      // whatever chain the user picked in the balance breakdown.
      const baseSigner = createWalletClient({ chain: base, account: embeddedAcct, transport: http('/api/rpc/8453') })
      const sourceChainDef = _viemChainFor(selectedSource.chainId, { base, optimism, mainnet, arbitrum, polygon })
      const sourceSigner = createWalletClient({
        chain: sourceChainDef,
        account: embeddedAcct,
        transport: http(`/api/rpc/${selectedSource.chainId}`),
      })

      // BOLD path: if the picked source is BOLD savings, we need to
      // unstake enough from the Liquity V2 SPs to cover `sourceAmt`
      // BEFORE Peer/Relay can pull the tokens. When the user's liquid
      // BOLD covers it, this is a no-op.
      if (selectedSource.kind === 'bold') {
        try {
          await _unstakeBoldIfNeeded({
            addr, sourceAmt,
            liquid: selectedSource.boldLiquid || 0n,
            sps: selectedSource.boldSps || {},
            sourceSigner,
            onStatus: (s) => { els.status.textContent = s },
          })
        } catch (e) {
          console.warn('bold unstake failed', e)
          els.status.textContent = `couldn't unstake your BOLD savings — ${_humanError(e).slice(0, 140)}`
          els.submitBtn.textContent = 'try again'
          els.submitBtn.disabled = false
          return
        }
      }

      els.status.textContent = 'preparing your transfer…'
      const result = await client.cashout({
        amount: sourceAmt,
        source: {
          chainId: selectedSource.chainId,
          currency: sourceCurrency,
          recipient: addr,
          tradeType: 'EXACT_INPUT',
        },
        receive: {
          platform: selectedPlatform,
          currency: cashCurrency,
          payee: els.payeeInput.value.trim(),
        },
      }, {
        signer: baseSigner,
        sourceSigner: sourceSigner,
        onSourceProgress: (data) => {
          if (data?.step) els.status.textContent = `preparing your transfer · ${data.step}`
        },
      })

      _rememberDepositId(addr, result.depositId)
      // Server-side backup so a cleared cache or new device still
      // sees the order on next open.
      const authToken = await getAuthToken?.().catch(() => null)
      _syncDepositToServer({
        depositId: result.depositId,
        platform: selectedPlatform,
        amountFiat: latestEstimate?.receiveAmount || 0,
        currency: cashCurrency,
      }, authToken).catch(() => {})
      // Deposit created. The rendering of pending state lives on the
      // /cashout root page (see initCashout — checks server-side rows,
      // then paints the pending shell). Redirect there so we have a
      // single code path for pending, and the form's local state (amount,
      // payee input) doesn't linger on-screen. Server sync above already
      // wrote the row, so the pending page will pick it up immediately.
      location.href = '/cashout'
      return
    } catch (e) {
      const code = e?.code
      if (code === 'PAYEE_VERIFICATION_REQUIRED') {
        els.status.textContent = `${_prettyPlatform(selectedPlatform)} needs a one-time identity check — install Peer's browser extension at peer.xyz and register your handle there first.`
      } else if (code === 'SIGNER_CHAIN_MISMATCH') {
        els.status.textContent = 'your wallet is on the wrong network — switch to Optimism and try again'
      } else if (code === 'INSUFFICIENT_TOKEN_BALANCE' || code === 'INSUFFICIENT_AVAILABLE_FUNDS') {
        els.status.textContent = "not enough balance to cover the transfer and the tiny bit of Base ETH needed for gas"
      } else {
        els.status.textContent = _humanError(e)
      }
      els.submitBtn.textContent = 'try again'
      els.submitBtn.disabled = false
    }
  })
}

// ─── DOM shell ───

function _renderShell() {
  return `
    <div class="cashout-sheet">
      <header class="cashout-lead">
        <h1>cash out</h1>
        <p class="cashout-sub">Move your earnings into Venmo, PayPal, Zelle, Cash App, Wise, or Revolut. Peer-to-peer — no bank required, no signup.</p>
      </header>

      <div class="cashout-balance-line">
        <span class="cashout-balance-label">available</span>
        <span id="cashout-balance-value" class="cashout-balance-value">…</span>
      </div>
      <div id="cashout-balance-sub" class="cashout-balance-sub"></div>

      <section class="cashout-body">
        <div class="cashout-field">
          <div class="cashout-field-label">amount</div>
          <div class="cashout-amount-row">
            <span id="cashout-amount-currency" class="cashout-amount-currency">$</span>
            <input id="cashout-amount" type="text" inputmode="decimal" placeholder="0" class="cashout-amount-input" autocomplete="off">
          </div>
          <div id="cashout-amount-conversion" class="cashout-amount-conversion"></div>
        </div>

        <div class="cashout-field">
          <div class="cashout-field-label">send to</div>
          <div id="cashout-platforms" class="cashout-platforms">
            <span class="cashout-loading">loading platforms…</span>
          </div>
        </div>

        <div class="cashout-field" id="cashout-payee-field" hidden>
          <div class="cashout-field-label"><span id="cashout-payee-label">your handle</span></div>
          <div class="cashout-payee-row">
            <input id="cashout-payee" type="text" placeholder="" class="cashout-payee-input" autocomplete="off">
            <button id="cashout-payee-scan" type="button" class="cashout-payee-scan" title="scan a QR" hidden><i class="ph ph-qr-code"></i></button>
            <span id="cashout-payee-check" class="cashout-payee-check" hidden></span>
          </div>
          <div id="cashout-payee-scanner" class="cashout-payee-scanner" hidden>
            <video id="cashout-scan-video" playsinline></video>
            <button id="cashout-scan-close" type="button">close</button>
          </div>
        </div>

        <div id="cashout-quote" class="cashout-quote" hidden>
          <div class="cashout-quote-row">
            <span class="cashout-quote-label">you'll get</span>
            <span id="cashout-quote-amount" class="cashout-quote-amount">—</span>
          </div>
          <div id="cashout-quote-eta" class="cashout-quote-eta"></div>
        </div>

        <button id="cashout-submit" type="button" class="cashout-btn" disabled>enter an amount</button>
        <p id="cashout-status" class="cashout-status"></p>
      </section>
    </div>
  `
}

function _wireEls(root) {
  return {
    balanceValue: root.querySelector('#cashout-balance-value'),
    balanceSub: root.querySelector('#cashout-balance-sub'),
    amountInput: root.querySelector('#cashout-amount'),
    amountCurrency: root.querySelector('#cashout-amount-currency'),
    amountConversion: root.querySelector('#cashout-amount-conversion'),
    platforms: root.querySelector('#cashout-platforms'),
    payeeInput: root.querySelector('#cashout-payee'),
    payeeField: root.querySelector('#cashout-payee-field'),
    payeeLabel: root.querySelector('#cashout-payee-label'),
    payeeCheck: root.querySelector('#cashout-payee-check'),
    payeeScan: root.querySelector('#cashout-payee-scan'),
    scanner: root.querySelector('#cashout-payee-scanner'),
    scanVideo: root.querySelector('#cashout-scan-video'),
    scanClose: root.querySelector('#cashout-scan-close'),
    quote: root.querySelector('#cashout-quote'),
    quoteAmount: root.querySelector('#cashout-quote-amount'),
    quoteEta: root.querySelector('#cashout-quote-eta'),
    submitBtn: root.querySelector('#cashout-submit'),
    status: root.querySelector('#cashout-status'),
  }
}

function _renderBalances(els, b, ethPrices, sourceKind, cashCurrency) {
  const opBalFiat = _sourceToFiat(
    sourceKind === 'usdc' ? (b?.opUsdc ?? 0n) : (b?.opEth ?? 0n),
    cashCurrency, sourceKind, ethPrices,
  )
  els.balanceValue.textContent = _formatFiat(opBalFiat, cashCurrency)
  // Sub-line explains WHAT the balance is under the hood, dim + tiny.
  const sourceLabel = sourceKind === 'usdc'
    ? `${(Number(b?.opUsdc ?? 0n) / 10 ** USDC_DECIMALS).toFixed(2)} USDC on Optimism`
    : `${(Number(b?.opEth ?? 0n) / 10 ** ETH_DECIMALS).toFixed(4)} ETH on Optimism`
  // No Base-ETH warning here — the submit path auto-bridges. Surfacing
  // the shortfall on the balance line would just confuse a zero-crypto
  // user (why do I need Base? what is Base?).
  els.balanceSub.textContent = sourceLabel
}

function _renderPlatforms(container, platforms, mobile) {
  if (platforms.length === 0) {
    container.innerHTML = `<span class="cashout-loading" style="color:var(--muted)">no active corridors right now — try again in a few minutes</span>`
    return
  }
  container.innerHTML = platforms.map(p => {
    const meta = PLATFORMS[p.platform] || { icon: 'ph-currency-circle-dollar', hint: 'handle' }
    // Attestation requirement is the SDK's source of truth (not the
    // hardcoded PLATFORMS map). Wise/PayPal/Alipay throw
    // PAYEE_VERIFICATION_REQUIRED on new-payee registration; those
    // three are the only platforms that need Peer's TEE extension
    // for a fresh handle.
    const needsAttest = !!p.requiresIdentityAttestation
    const label = _prettyPlatform(p.platform)
    const disabledOnMobile = mobile && needsAttest
    const note = disabledOnMobile ? '<span style="font-size:0.7em;color:var(--dim);display:block">desktop only</span>' : ''
    const attrs = disabledOnMobile ? 'disabled title="requires Peer\'s browser extension — open on a laptop to use"' : ''
    return `<button type="button" class="cashout-platform" data-platform="${escapeHtml(p.platform)}" data-attest="${needsAttest ? '1' : '0'}" ${attrs}><i class="ph ${meta.icon}"></i><span>${escapeHtml(label)}</span>${note}</button>`
  }).join('')
}

// Small toggle appended below the platforms grid. If the wallet has
// Peer's browser extension installed, the user opts in once and we
// stop hiding Wise/PayPal/Alipay. localStorage-persisted, so this is
// a one-time affordance per browser profile.
function _renderExtToggle(container, allPlatforms, onChange) {
  const hasAttest = allPlatforms.some(p => p.requiresIdentityAttestation)
  if (!hasAttest) return
  const existing = container.parentElement?.querySelector('.cashout-ext-toggle')
  if (existing) existing.remove()
  const shown = _shouldRevealExtensionPlatforms()
  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'cashout-ext-toggle'
  toggle.textContent = shown
    ? 'hide extension-only platforms (Wise, PayPal, Alipay)'
    : "I have Peer's extension → show Wise, PayPal, Alipay"
  toggle.addEventListener('click', () => {
    _setRevealExtensionPlatforms(!shown)
    onChange()
  })
  container.after(toggle)
}

// Find any live cash-outs the wallet still owns. Merges server-side
// depositId rows (no indexer lag) with the SDK's authoritative view.
// Returns a list — peer.xyz supports concurrent cash-outs, and we
// surface all of them, not just the first.
async function _findPendingCashout(addr, cashCurrency) {
  const authToken = await getAuthToken?.().catch(() => null)
  const serverOrders = await _readServerOrders(authToken)
  const recent = serverOrders.filter(o => Date.now() - (o.createdAt || 0) < 24 * 3600_000)

  let sdkOrders = []
  try {
    const sdk = await import('./vendor-cash.js')
    const env = new URL(window.location.href).searchParams.get('env') === 'staging' ? 'staging' : 'production'
    const bareRelay = sdk.createRelayClient({ baseApiUrl: sdk.MAINNET_RELAY_API })
    bareRelay.source = undefined
    const client = sdk.createCashClient({
      environment: env, rpcUrl: 'https://mainnet.base.org',
      apiKey: _peerCashApiKey(), referrer: 'praxis', relay: { client: bareRelay },
    })
    sdkOrders = await client.orders(addr, { inFlight: true, limit: 10 }).catch(() => [])
  } catch {}

  const byId = new Map()
  for (const o of sdkOrders || []) {
    if (!o?.depositId) continue
    byId.set(o.depositId, { depositId: o.depositId, sdk: o, server: null })
  }
  for (const o of recent) {
    if (!o?.depositId) continue
    const existing = byId.get(o.depositId)
    if (existing) existing.server = o
    else byId.set(o.depositId, { depositId: o.depositId, sdk: null, server: o })
  }
  if (byId.size === 0) return null

  // Drift-check server-only rows against the SDK's authoritative
  // per-order view. Peer's indexer is source of truth for state —
  // if this order actually settled (delivered/returned) while our
  // server row lingered, prune it and drop it from the render set
  // so we don't show a "pending" state that's already over.
  const drifted = []
  try {
    const sdk = await import('./vendor-cash.js')
    const env = new URL(window.location.href).searchParams.get('env') === 'staging' ? 'staging' : 'production'
    const bareRelay = sdk.createRelayClient({ baseApiUrl: sdk.MAINNET_RELAY_API })
    bareRelay.source = undefined
    const client = sdk.createCashClient({
      environment: env, rpcUrl: 'https://mainnet.base.org',
      apiKey: _peerCashApiKey(), referrer: 'praxis', relay: { client: bareRelay },
    })
    await Promise.all([...byId.values()]
      .filter(x => !x.sdk)  // sdk already told us they're inFlight
      .map(async (x) => {
        try {
          const full = await client.order(x.depositId)
          if (full?.state === 'delivered' || full?.state === 'returned') {
            drifted.push(x.depositId)
            byId.delete(x.depositId)
          } else if (full) {
            x.sdk = full  // hydrate for initial paint
          }
        } catch { /* keep the server row as-is; render optimistically */ }
      }))
  } catch { /* SDK unavailable — best-effort */ }

  // Prune drifted server rows so we don't repeat the drift check
  // on every visit.
  for (const id of drifted) _pruneServerOrder(id, authToken).catch(() => {})

  if (byId.size === 0) return null

  const items = [...byId.values()].map(({ depositId, sdk, server }) => {
    const platform = server?.platform || ''
    const receiveFiat = Number(server?.amountFiat || 0)
    const currency = server?.currency || cashCurrency
    const payee = platform ? _recallHandle(addr, platform) : ''
    return {
      depositId, platform, payee, receiveFiat, currency,
      initialOrder: sdk || null,
      initialState: sdk?.state || 'awaiting-buyer',
    }
  })
  return { addr, cashCurrency, authToken, items }
}

// Big number owns the page (per artist's weight); each pending item
// is a card with its own state + steps + safety block. A "start
// another cash-out" link stays visible so concurrent deposits work.
function _renderPendingShell(p) {
  const totalFiat = p.items.reduce((s, i) => s + (i.receiveFiat || 0), 0)
  const currency = p.items[0]?.currency || p.cashCurrency
  const heroItem = p.items[0]
  const heroLabel = p.items.length > 1
    ? `${p.items.length} cash-outs in flight`
    : (heroItem?.payee
        ? `sending to ${_escape(_prettyPlatform(heroItem.platform).toLowerCase())} · ${_escape(heroItem.payee)}`
        : `sending to ${_escape(heroItem?.platform ? _prettyPlatform(heroItem.platform).toLowerCase() : 'your payment method')}`)
  const heroValue = totalFiat > 0 ? _formatFiat(totalFiat, currency) : 'cash-out'
  const cards = p.items.map(item => _renderPendingCard(item)).join('')
  return `
    <div class="cashout-doc">
      <section class="cashout-pending-hero">
        <div class="cashout-pending-hero-label">${heroLabel}</div>
        <div class="cashout-pending-hero-value">${_escape(heroValue)}</div>
      </section>
      <div class="cashout-pending-list">${cards}</div>
      <section class="cashout-pending-actions">
        <button id="cashout-start-another" type="button" class="cashout-link">start another cash-out →</button>
        <button id="cashout-back-earnings" type="button" class="cashout-link cashout-link-muted">back to earnings</button>
      </section>
    </div>
  `
}

function _renderPendingCard(item) {
  const prettyPlatform = item.platform ? _prettyPlatform(item.platform).toLowerCase() : 'your payment method'
  const knowAmt = item.receiveFiat > 0
  const amtHtml = knowAmt ? `<strong>${_escape(_formatFiat(item.receiveFiat, item.currency))}</strong>` : 'your cash-out'
  const handleHtml = item.payee ? ` <strong>${_escape(item.payee)}</strong>` : ''
  return `
    <article class="cashout-pending-card" data-deposit="${_escape(item.depositId)}">
      <header class="cashout-pending-card-head">
        <div class="cashout-pending-card-title" data-slot="title">waiting for a buyer</div>
        <div class="cashout-pending-card-sub" data-slot="sub">this usually takes about an hour</div>
      </header>
      <ol class="cashout-inflight-steps" data-slot="steps">
        <li data-step="submitted" class="cashout-step is-done"><span class="cashout-step-dot"></span><span class="cashout-step-label">deposit submitted</span></li>
        <li data-step="matched" class="cashout-step"><span class="cashout-step-dot"></span><span class="cashout-step-label">buyer matched</span></li>
        <li data-step="paid" class="cashout-step"><span class="cashout-step-dot"></span><span class="cashout-step-label">payment sent</span></li>
        <li data-step="done" class="cashout-step"><span class="cashout-step-dot"></span><span class="cashout-step-label">complete</span></li>
      </ol>
      <p class="cashout-pending-card-body" data-slot="body">A buyer will send ${amtHtml} to ${_escape(prettyPlatform)}${handleHtml}. Your deposit auto-releases when they do.</p>
      <ul class="cashout-pending-card-safety">
        <li>funds locked in Peer's escrow — safe until match</li>
        <li>close this tab · we'll notify you</li>
        <li>returns to your wallet if no match in 24 h</li>
      </ul>
      <footer class="cashout-pending-card-foot">
        <span class="cashout-pending-meta-key">deposit id</span>
        <code class="cashout-pending-meta-val" title="${_escape(item.depositId)}">${_escape(_shortDepositId(item.depositId))}</code>
        <button type="button" class="cashout-pending-copy" data-copy="${_escape(item.depositId)}" title="copy deposit id"><i class="ph ph-copy"></i></button>
      </footer>
      <div class="cashout-pending-card-cancel">
        <button type="button" class="cashout-link cashout-link-muted" data-cancel="${_escape(item.depositId)}">cancel · pull funds back to my wallet</button>
        <p class="cashout-pending-card-cancel-status" data-cancel-status="${_escape(item.depositId)}"></p>
      </div>
    </article>
  `
}

async function _wirePendingShell(el, p) {
  el.querySelector('#cashout-back-earnings')?.addEventListener('click', () => { location.href = '/earnings' })
  el.querySelector('#cashout-start-another')?.addEventListener('click', () => { location.href = '/cashout?new=1' })
  el.querySelectorAll('.cashout-pending-copy').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-copy') || ''
      try { navigator.clipboard.writeText(id) } catch {}
      btn.innerHTML = '<i class="ph ph-check"></i>'
      setTimeout(() => { btn.innerHTML = '<i class="ph ph-copy"></i>' }, 1200)
    })
  })
  el.querySelectorAll('[data-cancel]').forEach(btn => {
    btn.addEventListener('click', () => _handleCancel(el, btn, p))
  })

  // Build one SDK client for all watchers so we don't spin up N of
  // them and so we can also use it for tab-focus refreshes.
  let client = null
  try {
    const sdk = await import('./vendor-cash.js')
    const env = new URL(window.location.href).searchParams.get('env') === 'staging' ? 'staging' : 'production'
    const bareRelay = sdk.createRelayClient({ baseApiUrl: sdk.MAINNET_RELAY_API })
    bareRelay.source = undefined
    client = sdk.createCashClient({
      environment: env, rpcUrl: 'https://mainnet.base.org',
      apiKey: _peerCashApiKey(), referrer: 'praxis', relay: { client: bareRelay },
    })
  } catch {}

  // Terminal states we treat as "done" — any further action gets
  // suppressed once we know an item has settled.
  const terminalStates = new Set(['delivered', 'returned'])
  const settled = new Set()

  // Per-item paint + watch. `paint` is closed over the item, so a
  // focus-refresh handler below can re-fetch and repaint any card.
  const painters = new Map()
  for (const item of p.items) {
    const card = el.querySelector(`.cashout-pending-card[data-deposit="${item.depositId}"]`)
    if (!card) continue
    const paint = (order) => {
      _paintPendingCard(card, order, item)
      if (terminalStates.has(order.state)) {
        settled.add(item.depositId)
        _pruneServerOrder(item.depositId, p.authToken).catch(() => {})
      }
    }
    painters.set(item.depositId, paint)
    if (item.initialOrder) paint(item.initialOrder)

    if (!client) continue
    ;(async () => {
      try {
        const iterator = client.watch(item.depositId, { timeoutMs: 60 * 60_000 })
        for await (const order of iterator) {
          paint(order)
          if (terminalStates.has(order.state)) break
        }
      } catch { /* network hiccup — focus-refresh below covers it */ }
    })()
  }

  // Refresh authoritative state whenever the tab comes back to focus.
  // Fixes the classic "watch() polled while the tab was backgrounded
  // or the net was down, so state's stuck at 'delivering' even
  // though Peer already marked delivered." One targeted client.order()
  // per non-settled item and we repaint from that.
  const refresh = async () => {
    if (!client) return
    await Promise.all([...painters.entries()].map(async ([depositId, paint]) => {
      if (settled.has(depositId)) return
      try {
        const fresh = await client.order(depositId)
        if (fresh) paint(fresh)
      } catch {}
    }))
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh()
  })
  window.addEventListener('focus', refresh)
  window.addEventListener('online', refresh)
}

function _paintPendingCard(card, order, item) {
  const copy = _pendingStateCopy(order, item)
  const titleEl = card.querySelector('[data-slot="title"]')
  const subEl = card.querySelector('[data-slot="sub"]')
  const bodyEl = card.querySelector('[data-slot="body"]')
  const stepsEl = card.querySelector('[data-slot="steps"]')
  if (titleEl) titleEl.textContent = copy.title
  if (subEl) subEl.textContent = copy.sub
  if (bodyEl) bodyEl.innerHTML = copy.body
  _advanceInFlightSteps(stepsEl, copy.activeStep)
  card.classList.toggle('is-done', order.state === 'delivered')
  card.classList.toggle('is-returned', order.state === 'returned')
}

async function _handleCancel(root, btn, p) {
  const depositId = btn.getAttribute('data-cancel')
  if (!depositId) return
  const statusEl = root.querySelector(`[data-cancel-status="${depositId}"]`)
  const setStatus = (s) => { if (statusEl) statusEl.textContent = s }
  if (!confirm("Cancel this cash-out and pull the funds back to your wallet? This costs a small gas fee on Base.")) return

  btn.disabled = true
  btn.style.opacity = '0.6'
  setStatus('unlocking your wallet…')

  try {
    if (typeof window.ensureAuthorized === 'function') {
      try { await window.ensureAuthorized(p.addr) } catch {
        setStatus('cancel aborted — wallet unlock cancelled')
        btn.disabled = false; btn.style.opacity = '1'
        return
      }
    }
    const embeddedAcct = window.getEmbeddedAccount?.()
    if (!embeddedAcct) {
      setStatus('wallet still locked — unlock and try again')
      btn.disabled = false; btn.style.opacity = '1'
      return
    }

    const { createWalletClient, http, base } = await import('./vendor.js')
    const sdk = await import('./vendor-cash.js')
    const env = new URL(window.location.href).searchParams.get('env') === 'staging' ? 'staging' : 'production'
    const bareRelay = sdk.createRelayClient({ baseApiUrl: sdk.MAINNET_RELAY_API })
    bareRelay.source = undefined
    const client = sdk.createCashClient({
      environment: env, rpcUrl: 'https://mainnet.base.org',
      apiKey: _peerCashApiKey(), referrer: 'praxis', relay: { client: bareRelay },
    })
    const baseSigner = createWalletClient({ chain: base, account: embeddedAcct, transport: http('/api/rpc/8453') })

    setStatus('sending withdraw transaction…')
    await client.withdraw(depositId, { signer: baseSigner })

    setStatus('withdrew — your funds are back in your wallet on Base.')
    _pruneServerOrder(depositId, p.authToken).catch(() => {})
    // Reload so the pending shell recomputes — the card should now be
    // gone (or moved to a done/returned terminal state via watch()).
    setTimeout(() => { location.href = '/earnings' }, 1200)
  } catch (e) {
    console.warn('cashout cancel failed:', e)
    const msg = e?.remediation || e?.message || 'try again in a moment'
    setStatus(`couldn't cancel — ${String(msg).slice(0, 160)}`)
    btn.disabled = false; btn.style.opacity = '1'
  }
}

function _pendingStateCopy(order, item) {
  const s = order.state
  const prettyPlatform = item.platform ? _prettyPlatform(item.platform).toLowerCase() : 'your payment method'
  const knowAmt = Number.isFinite(item.receiveFiat) && item.receiveFiat > 0
  const prettyAmt = knowAmt ? _formatFiat(item.receiveFiat, item.currency) : ''
  const amtPhrase = knowAmt ? `<strong>${_escape(prettyAmt)}</strong>` : 'your cash-out'
  const handlePhrase = item.payee ? ` <strong>${_escape(item.payee)}</strong>` : ''
  return {
    'awaiting-buyer': {
      title: 'waiting for a buyer',
      sub: order.eta?.label || 'this usually takes about an hour',
      body: `A buyer will send ${amtPhrase} to ${prettyPlatform}${handlePhrase}. Your deposit auto-releases when they do.`,
      activeStep: 'submitted',
    },
    'matched': {
      title: 'a buyer matched',
      sub: 'they are sending your payment now',
      body: `A buyer is sending ${amtPhrase} to ${prettyPlatform}${handlePhrase}. Watch that account for the incoming payment.`,
      activeStep: 'matched',
    },
    'delivering': {
      title: 'confirming your payment',
      sub: 'verifying with a cryptographic proof',
      body: `The buyer marked ${amtPhrase} as sent. Peer is verifying now — takes about a minute.`,
      activeStep: 'paid',
    },
    'delivered': {
      title: knowAmt ? `${prettyAmt} sent` : 'payment sent',
      sub: 'check your account for the incoming payment',
      body: `Payment complete. ${amtPhrase} landed in ${prettyPlatform}${handlePhrase}.`,
      activeStep: 'done',
    },
    'returned': {
      title: 'no buyer matched in time',
      sub: 'funds returned to your wallet',
      body: 'No buyer matched within the 24 h window, so Peer returned your ETH.',
      activeStep: 'submitted',
    },
  }[s] || {
    title: 'processing…',
    sub: '',
    body: order.explain?.() || 'working on it',
    activeStep: 'submitted',
  }
}

async function _pruneServerOrder(depositId, token) {
  if (!token || !depositId) return
  try {
    await fetch('/api/cashout/orders', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ depositId }),
    })
  } catch {}
}



function _advanceInFlightSteps(root, active) {
  if (!root) return
  const order = ['submitted', 'matched', 'paid', 'done']
  const idx = Math.max(0, order.indexOf(active))
  for (const li of root.querySelectorAll('.cashout-step')) {
    const step = li.getAttribute('data-step')
    const pos = order.indexOf(step)
    li.classList.toggle('is-done', pos < idx)
    li.classList.toggle('is-active', pos === idx)
  }
}

function _shortDepositId(id) {
  if (!id) return ''
  if (id.length < 14) return id
  return `${id.slice(0, 6)}…${id.slice(-4)}`
}

function _escape(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ─── Reads ───

async function _readBalances(addr) {
  const pc = await getPublicClient()
  const ERC20_BAL = [{ name: 'balanceOf', type: 'function', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }]
  const [opEth, opUsdc, baseEth] = await Promise.all([
    pc.getBalance({ address: addr }).catch(() => 0n),
    pc.readContract({ address: OPTIMISM_USDC, abi: ERC20_BAL, functionName: 'balanceOf', args: [addr] }).catch(() => 0n),
    _readBaseEthBalance(addr).catch(() => 0n),
  ])
  return { opEth, opUsdc, baseEth }
}

// Multi-chain source read — ETH + USDC on every chain Peer's Relay
// SDK can bridge from. Runs in parallel so the sheet doesn't stall
// on one slow RPC. Each row carries native ETH + USDC amounts +
// pre-computed fiat totals so the picker can rank by value without
// re-doing the math.
const SOURCE_CHAINS = [
  { chainId: 10,    name: 'Optimism', usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85' },
  { chainId: 8453,  name: 'Base',     usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  { chainId: 42161, name: 'Arbitrum', usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' },
  { chainId: 1,     name: 'Ethereum', usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
  { chainId: 137,   name: 'Polygon',  usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' },
]
const ERC20_BAL_ABI = [{ name: 'balanceOf', type: 'function', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }]

async function _readMultiChainBalances(addr, ethPrices, cashCurrency) {
  const { createPublicClient, http } = await import('./vendor.js')
  const ethRate = ethPrices?.[cashCurrency.toUpperCase()] || ethPrices?.USD || 0
  const results = await Promise.all(SOURCE_CHAINS.map(async ({ chainId, name, usdc }) => {
    const rpcUrl = `/api/rpc/${chainId}`
    const pc = createPublicClient({
      chain: { id: chainId, name, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } },
      transport: http(rpcUrl),
    })
    const [ethWei, usdcUnits, boldPos] = await Promise.all([
      chainId === 137 ? Promise.resolve(0n) : pc.getBalance({ address: addr }).catch(() => 0n),  // Polygon: MATIC not ETH; skip native
      pc.readContract({ address: usdc, abi: ERC20_BAL_ABI, functionName: 'balanceOf', args: [addr] }).catch(() => 0n),
      chainId === 1 ? _readBoldPosition(pc, addr) : Promise.resolve({ liquid: 0n, sps: {}, total: 0n }),
    ])
    const ethNum = Number(ethWei) / 1e18
    const usdcNum = Number(usdcUnits) / 1e6
    const boldNum = Number(boldPos.total) / 1e18
    const ethFiat = ethRate ? ethNum * ethRate : 0
    const usdcFiat = usdcNum
    // BOLD is roughly USD-pegged (Liquity V2 debt token); if we get a
    // live rate later, plug it here. Use the same fiat scale as USDC.
    const boldFiat = boldNum
    return {
      chainId, name,
      ethWei, usdcUnits,
      boldWei: boldPos.total, boldLiquid: boldPos.liquid, boldSps: boldPos.sps,
      ethNum, usdcNum, boldNum,
      ethFiat, usdcFiat, boldFiat,
      totalFiat: ethFiat + usdcFiat + boldFiat,
    }
  }))
  return results
}

// Withdraw enough BOLD from the Liquity V2 SPs to cover the requested
// amount. Order: ETH SP first (most yield, most liquid), then rETH,
// then wstETH. `sourceSigner` is expected to be on chainId=1.
// Passes `_doClaim=true` so any ETH yield accrued in the SP position
// lands in the user's wallet at the same time — it's theirs, no
// reason to leave it stranded.
async function _unstakeBoldIfNeeded({ addr, sourceAmt, liquid, sps, sourceSigner, onStatus }) {
  if (liquid >= sourceAmt) return  // enough liquid BOLD already
  const needed = sourceAmt - liquid
  const order = ['ETH', 'rETH', 'wstETH']
  let remaining = needed
  const withdraws = []
  for (const name of order) {
    if (remaining <= 0n) break
    const bal = sps[name] || 0n
    if (bal <= 0n) continue
    const take = bal >= remaining ? remaining : bal
    withdraws.push({ name, spAddr: BOLD_SPS[name], amount: take })
    remaining -= take
  }
  if (remaining > 0n) {
    const shortBold = Number(remaining) / 10 ** BOLD_DECIMALS
    throw new Error(`not enough BOLD in savings — short by ${shortBold.toFixed(2)} BOLD`)
  }
  const { createPublicClient, http, mainnet } = await import('./vendor.js')
  const pc = createPublicClient({
    chain: { ...mainnet, rpcUrls: { ...mainnet.rpcUrls, default: { http: ['/api/rpc/1'] } } },
    transport: http('/api/rpc/1'),
  })
  for (let i = 0; i < withdraws.length; i++) {
    const w = withdraws[i]
    const boldAmt = Number(w.amount) / 10 ** BOLD_DECIMALS
    onStatus?.(`unstaking ${boldAmt.toFixed(2)} BOLD from ${w.name} savings…${withdraws.length > 1 ? ` (${i + 1}/${withdraws.length})` : ''}`)
    const hash = await sourceSigner.writeContract({
      address: w.spAddr, abi: BOLD_SP_ABI, functionName: 'withdrawFromSP',
      args: [w.amount, true], account: sourceSigner.account,
    })
    await pc.waitForTransactionReceipt({ hash, timeout: 180_000 })
  }
}

async function _readBoldPosition(pc, addr) {
  const [liquid, ...spBalances] = await Promise.all([
    pc.readContract({ address: BOLD_MAINNET, abi: ERC20_BAL_ABI, functionName: 'balanceOf', args: [addr] }).catch(() => 0n),
    ...Object.values(BOLD_SPS).map(spAddr =>
      pc.readContract({ address: spAddr, abi: BOLD_SP_ABI, functionName: 'getCompoundedBoldDeposit', args: [addr] }).catch(() => 0n)),
  ])
  const spNames = Object.keys(BOLD_SPS)
  const sps = {}
  for (let i = 0; i < spNames.length; i++) sps[spNames[i]] = spBalances[i]
  const spTotal = spBalances.reduce((s, b) => s + b, 0n)
  return { liquid, sps, total: liquid + spTotal }
}

// Given the multi-chain read + a chosen currency, pick the best
// single source for the deposit. Prefer USDC over ETH (no swap fee
// through Relay) when USDC is >= 90% of the chain's total value;
// otherwise take the chain's higher-value asset. Return null if
// every chain is empty.
function _usdcAddressForChain(chainId) {
  const row = SOURCE_CHAINS.find(c => c.chainId === chainId)
  return row?.usdc || OPTIMISM_USDC
}

function _sourceCurrencyFor(sel) {
  if (sel.kind === 'usdc') return _usdcAddressForChain(sel.chainId)
  if (sel.kind === 'bold') return BOLD_MAINNET
  return ETH_NATIVE
}

function _sourceDecimalsFor(kind) {
  if (kind === 'usdc') return USDC_DECIMALS
  if (kind === 'bold') return BOLD_DECIMALS
  return ETH_DECIMALS
}

function _viemChainFor(chainId, chains) {
  const { base, optimism, mainnet, arbitrum, polygon } = chains
  const map = { 1: mainnet, 10: optimism, 137: polygon, 8453: base, 42161: arbitrum }
  return map[chainId] || optimism
}

function _chainDisplay(chain, cashCurrency) {
  const parts = []
  if (chain.ethNum > 0) parts.push(`${chain.ethNum.toFixed(4)} ETH`)
  if (chain.usdcNum > 0) parts.push(`${chain.usdcNum.toFixed(2)} USDC`)
  const fiat = _formatFiat(chain.totalFiat, cashCurrency)
  return { parts, fiat }
}

// Vault-lead-style hero: one big fiat number on the balance line
// with an expandable breakdown of per-chain balances. Clicking a
// chain row selects that chain as the deposit source.
function _renderBalanceHero(els, chainBalances, ethPrices, cashCurrency, initialPick, onSelect) {
  const totalFiat = chainBalances.reduce((s, c) => s + c.totalFiat, 0)
  els.balanceValue.textContent = _formatFiat(totalFiat, cashCurrency)

  const active = chainBalances.filter(c => c.totalFiat > 0.01)
  if (active.length === 0) {
    els.balanceSub.textContent = 'no funds detected yet — add some to your wallet first'
    return
  }
  if (active.length === 1) {
    const only = active[0]
    els.balanceSub.textContent = `${_chainDisplay(only, cashCurrency).parts.join(' · ')} on ${only.name}`
    return
  }

  // Multi-chain — show the picked chain's short label on the sub-
  // line, and a toggle to expand the full breakdown for override.
  const renderSub = (pick) => {
    const chain = chainBalances.find(c => c.chainId === pick.chainId) || active[0]
    let asset
    if (pick.kind === 'usdc') asset = `${chain.usdcNum.toFixed(2)} USDC`
    else if (pick.kind === 'eth') asset = `${chain.ethNum.toFixed(4)} ETH`
    else if (pick.kind === 'bold') asset = `${chain.boldNum.toFixed(2)} BOLD (savings)`
    else asset = ''
    els.balanceSub.innerHTML = `<span>${asset} on ${chain.name}</span> <button type="button" class="cashout-source-toggle" aria-expanded="false">change</button>`
    els.balanceSub.querySelector('.cashout-source-toggle')?.addEventListener('click', (ev) => {
      const btn = ev.currentTarget
      const expanded = btn.getAttribute('aria-expanded') === 'true'
      btn.setAttribute('aria-expanded', String(!expanded))
      renderBreakdown(!expanded)
    })
  }

  // Breakdown lives after the sub-line — one row per chain-asset
  // that has value. Click selects.
  let breakdownEl = null
  const renderBreakdown = (show) => {
    if (!breakdownEl) {
      breakdownEl = document.createElement('div')
      breakdownEl.className = 'cashout-source-breakdown'
      els.balanceSub.after(breakdownEl)
    }
    if (!show) { breakdownEl.hidden = true; return }
    breakdownEl.hidden = false
    const rows = []
    for (const c of active) {
      if (c.usdcNum > 0) rows.push({ chainId: c.chainId, name: c.name, kind: 'usdc', asset: `${c.usdcNum.toFixed(2)} USDC`, fiat: c.usdcFiat, base: c.usdcUnits, tag: '' })
      if (c.ethNum > 0)  rows.push({ chainId: c.chainId, name: c.name, kind: 'eth',  asset: `${c.ethNum.toFixed(4)} ETH`,   fiat: c.ethFiat,  base: c.ethWei, tag: '' })
      if (c.boldNum > 0) rows.push({ chainId: c.chainId, name: c.name, kind: 'bold', asset: `${c.boldNum.toFixed(2)} BOLD`,  fiat: c.boldFiat, base: c.boldWei, tag: 'savings', boldLiquid: c.boldLiquid, boldSps: c.boldSps })
    }
    rows.sort((a, b) => b.fiat - a.fiat)
    breakdownEl.innerHTML = rows.map(r => {
      const isPicked = r.chainId === (currentPick?.chainId) && r.kind === currentPick?.kind
      const tag = r.tag ? ` <span class="cashout-source-row-tag">${_escape(r.tag)}</span>` : ''
      return `<button type="button" class="cashout-source-row${isPicked ? ' is-picked' : ''}" data-chain="${r.chainId}" data-kind="${r.kind}">
        <span class="cashout-source-row-name">${_escape(r.asset)}${tag} <span class="cashout-source-row-chain">on ${_escape(r.name)}</span></span>
        <span class="cashout-source-row-fiat">${_escape(_formatFiat(r.fiat, cashCurrency))}</span>
      </button>`
    }).join('')
    breakdownEl.querySelectorAll('.cashout-source-row').forEach(btn => {
      btn.addEventListener('click', () => {
        const chainId = Number(btn.getAttribute('data-chain'))
        const kind = btn.getAttribute('data-kind')
        const row = rows.find(r => r.chainId === chainId && r.kind === kind)
        if (!row) return
        currentPick = { chainId: row.chainId, name: row.name, kind: row.kind, amountFiat: row.fiat, amountBase: row.base, boldLiquid: row.boldLiquid, boldSps: row.boldSps }
        onSelect(currentPick)
        renderSub(currentPick)
        renderBreakdown(true)  // re-render so is-picked reflects the new selection
      })
    })
  }

  let currentPick = initialPick
  renderSub(currentPick)
}

function _pickBestSource(chains) {
  // Rank assets, not chains — the biggest single asset wins. Prefers
  // USDC first when it's the biggest (no Relay swap fee), then falls
  // back to whatever asset (ETH, BOLD) has the highest fiat value.
  // BOLD is intentionally treated as a first-class asset here so a
  // user whose only funds are in Liquity savings still lands on a
  // real, workable source pick.
  const assets = []
  for (const c of chains) {
    if (c.usdcFiat > 0) assets.push({ chainId: c.chainId, name: c.name, kind: 'usdc', amountFiat: c.usdcFiat, amountBase: c.usdcUnits })
    if (c.ethFiat > 0)  assets.push({ chainId: c.chainId, name: c.name, kind: 'eth',  amountFiat: c.ethFiat,  amountBase: c.ethWei })
    if (c.boldFiat > 0) assets.push({ chainId: c.chainId, name: c.name, kind: 'bold', amountFiat: c.boldFiat, amountBase: c.boldWei, boldLiquid: c.boldLiquid, boldSps: c.boldSps })
  }
  if (assets.length === 0) return null
  assets.sort((a, b) => (b.kind === 'usdc' ? 0.01 : 0) + b.amountFiat - a.amountFiat - (a.kind === 'usdc' ? 0.01 : 0))
  return assets[0]
}

async function _readBaseEthBalance(addr) {
  const res = await fetch('https://mainnet.base.org', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [addr, 'latest'] }),
  })
  const data = await res.json()
  if (data.error) throw new Error(data.error.message)
  return BigInt(data.result)
}

// ─── Conversions (fiat ↔ source token) ───

// User's fiat amount → source token base units.
// - USDC source: fiatAmt / (localRate / usdRate) * 10^6 → USDC is
//   dollar-pegged, so for USD user this is basically fiatAmt * 10^6.
// - ETH source: fiatAmt / ethRateForCurrency * 10^18.
function _fiatToSource(fiatAmt, cashCurrency, sourceKind, ethPrices) {
  const cur = String(cashCurrency).toLowerCase()
  const localEthRate = ethPrices?.[cur]
  const usdEthRate = ethPrices?.usd
  if (!localEthRate || !usdEthRate) return 0n
  if (sourceKind === 'eth') {
    const eth = fiatAmt / localEthRate
    return BigInt(Math.round(eth * 10 ** ETH_DECIMALS))
  }
  if (sourceKind === 'bold') {
    // BOLD ≈ 1 USD, 18 decimals. Convert fiat → USD → BOLD base units.
    const usd = fiatAmt * (usdEthRate / localEthRate)
    return BigInt(Math.round(usd * 10 ** BOLD_DECIMALS))
  }
  // USDC ≈ 1 USD. Convert fiat → USD → USDC.
  const usd = fiatAmt * (usdEthRate / localEthRate)
  return BigInt(Math.round(usd * 10 ** USDC_DECIMALS))
}

function _sourceToFiat(sourceAmt, cashCurrency, sourceKind, ethPrices) {
  const cur = String(cashCurrency).toLowerCase()
  const localEthRate = ethPrices?.[cur]
  const usdEthRate = ethPrices?.usd
  if (!localEthRate || !usdEthRate || sourceAmt <= 0n) return 0
  if (sourceKind === 'eth') {
    return (Number(sourceAmt) / 10 ** ETH_DECIMALS) * localEthRate
  }
  if (sourceKind === 'bold') {
    const usd = Number(sourceAmt) / 10 ** BOLD_DECIMALS
    return usd * (localEthRate / usdEthRate)
  }
  // USDC-primary user typing in local currency.
  const usd = Number(sourceAmt) / 10 ** USDC_DECIMALS
  return usd * (localEthRate / usdEthRate)
}

// ─── Helpers ───

function _filterPlatforms(platforms, fillStats, currency) {
  // Two guards run here:
  //
  // 1. Extension gate. Wise/PayPal/Alipay throw PAYEE_VERIFICATION_
  //    REQUIRED unless the user has Peer's browser extension. We
  //    don't have a reliable extension probe yet, so default to
  //    hiding them; users who have the extension can reveal them via
  //    the "show advanced" toggle (localStorage-persisted) so they
  //    only opt in once.
  // 2. Fill stats. Corridors with no recent activity would work in
  //    theory but leave the user waiting indefinitely. Filter them
  //    out; if every corridor fails the check, return the EMPTY set
  //    and let the caller show a "no active corridors" message rather
  //    than fall back to the unfiltered list.
  const revealExt = _shouldRevealExtensionPlatforms()
  const withoutAttest = platforms.filter(p => revealExt || !p.requiresIdentityAttestation)
  return withoutAttest.filter(p => {
    const key = `${p.platform}:${currency}`
    const stats = fillStats?.[key]
    if (!stats) return true  // unknown corridor — optimistic, but not a hard block
    if (stats.fills < 10) return false
    if (stats.medianFillSeconds && stats.medianFillSeconds > 48 * 3600) return false
    return true
  })
}

const EXT_REVEAL_KEY = 'praxis-cashout-reveal-ext'
function _shouldRevealExtensionPlatforms() {
  try { return localStorage.getItem(EXT_REVEAL_KEY) === '1' } catch { return false }
}
function _setRevealExtensionPlatforms(v) {
  try { localStorage.setItem(EXT_REVEAL_KEY, v ? '1' : '0') } catch {}
}

function _parseFiat(s) {
  const clean = String(s || '').replace(/[^0-9.]/g, '')
  if (!clean || clean === '.') return 0
  const n = parseFloat(clean)
  return Number.isFinite(n) ? n : 0
}

function _formatFiat(n, code) {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: code, maximumFractionDigits: 2 }).format(Number(n || 0)) }
  catch { return `${Number(n || 0).toFixed(2)} ${code}` }
}

function _currencySymbol(code) {
  try {
    const parts = new Intl.NumberFormat(undefined, { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' }).formatToParts(0)
    const cur = parts.find(p => p.type === 'currency')
    return cur?.value || '$'
  } catch { return '$' }
}

function _sourceDisplay(amt, sourceKind) {
  if (sourceKind === 'eth') {
    const eth = Number(amt) / 10 ** ETH_DECIMALS
    return eth < 0.001 ? `${(eth * 1000).toFixed(3)} mETH` : `${eth.toFixed(6)} ETH`
  }
  if (sourceKind === 'bold') {
    return `${(Number(amt) / 10 ** BOLD_DECIMALS).toFixed(2)} BOLD`
  }
  return `${(Number(amt) / 10 ** USDC_DECIMALS).toFixed(2)} USDC`
}

function _ethDisplay(wei) {
  const n = Number(wei) / 1e18
  if (n < 0.0001) return `${(n * 1e6).toFixed(0)} µETH`
  return `${n.toFixed(4)} ETH`
}

function _prettyPlatform(id) {
  return id === 'cashapp' ? 'Cash App'
    : id === 'paypal' ? 'PayPal'
    : id === 'upi' ? 'UPI'
    : id.charAt(0).toUpperCase() + id.slice(1)
}

function _humanError(e) {
  return e?.remediation || e?.shortMessage || e?.message || 'unavailable'
}
