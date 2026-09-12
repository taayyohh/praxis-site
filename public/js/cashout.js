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

  el.innerHTML = _renderShell()
  const els = _wireEls(el)

  // Fire the crypto-side reads AND the price feed in parallel.
  const [balances, ethPrices] = await Promise.all([
    _readBalances(addr).catch(() => null),
    getEthPrices().catch(() => null),
  ])

  const cashCurrency = _cashoutCurrency()
  const userCurrencyRaw = String(getUserCurrency() || 'usd').toUpperCase()
  const currencyMismatch = cashCurrency !== userCurrencyRaw

  // Prefer USDC over ETH (no swap fee); fall back if it's the only
  // balance. If both are zero, still open the sheet — user might fund.
  const sourceKind = (balances?.opUsdc ?? 0n) > 0n
    ? 'usdc'
    : (balances?.opEth ?? 0n) > 0n
      ? 'eth'
      : 'usdc' // default label; the amount input will block on zero
  const sourceCurrency = sourceKind === 'usdc' ? OPTIMISM_USDC : ETH_NATIVE
  const sourceDecimals = sourceKind === 'usdc' ? USDC_DECIMALS : ETH_DECIMALS

  _renderBalances(els, balances, ethPrices, sourceKind, cashCurrency)
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

  const usable = _filterPlatforms(caps.platforms || [], fillStats, cashCurrency)
  const mobile = _isMobile()
  _renderPlatforms(els.platforms, usable, mobile)

  // Resume banner — one-tap surface for any in-flight order the wallet
  // still owns. Cheap; skips silently on error.
  _renderResumeBanner(els, client, addr, cashCurrency).catch(() => {})

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
    els.amountConversion.textContent = `≈ ${_sourceDisplay(sourceAmt, sourceKind)} on Optimism`

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
          chainId: OPTIMISM_CHAIN_ID,
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
    const bal = sourceKind === 'usdc' ? (balances?.opUsdc ?? 0n) : (balances?.opEth ?? 0n)
    const balFiat = _sourceToFiat(bal, cashCurrency, sourceKind, ethPrices)
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
      const { createWalletClient, http, base, optimism } = await import('./vendor.js')
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
      // chain's real RPC, not the EIP-1193 provider. The embedded
      // provider is Optimism-only for chainId purposes — asking it
      // "which chain?" always returns 10, which trips the Peer SDK's
      // assertWalletChainId(8453) at the Base-deposit step with
      // SIGNER_CHAIN_MISMATCH. Same pattern relay-bridge.js uses for
      // multi-chain routing: sign locally via the LocalAccount,
      // JSON-RPC via the chain's own endpoint.
      const baseSigner = createWalletClient({ chain: base, account: embeddedAcct, transport: http('/api/rpc/8453') })
      const opSigner = createWalletClient({ chain: optimism, account: embeddedAcct, transport: http('/api/rpc/10') })

      els.status.textContent = 'preparing your transfer…'
      const result = await client.cashout({
        amount: sourceAmt,
        source: {
          chainId: OPTIMISM_CHAIN_ID,
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
        sourceSigner: opSigner,
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
      // Swap into the in-flight surface. The zero-crypto artist needs
      // to see three things without hunting: (1) their money is safe,
      // (2) they can walk away, (3) what happens next in plain terms.
      // The form disappears — a form is not the right thing to look
      // at while something is pending in a background marketplace.
      _showInFlight(els, {
        depositId: result.depositId,
        receiveFiat: latestEstimate?.receiveAmount || 0,
        cashCurrency,
        platform: selectedPlatform,
        payee: els.payeeInput.value.trim(),
        etaLabel: latestEstimate?.eta?.label || 'usually starts within an hour',
      })
      _renderInFlightState(els, { state: 'awaiting-buyer' }, selectedPlatform, els.payeeInput.value.trim(), latestEstimate?.receiveAmount || 0, cashCurrency)

      const iterator = client.watch(result.depositId, { timeoutMs: 60 * 60_000 })
      for await (const order of iterator) {
        _renderInFlightState(els, order, selectedPlatform, els.payeeInput.value.trim(), latestEstimate?.receiveAmount || 0, cashCurrency)
        if (order.state === 'delivered' || order.state === 'returned') {
          _pruneServerOrder(result.depositId, authToken).catch(() => {})
          break
        }
      }
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
      <div id="cashout-entry-wrap" class="cashout-entry-wrap">
        <header class="cashout-lead">
          <h1>cash out</h1>
          <p class="cashout-sub">Move your earnings into Venmo, PayPal, Zelle, Cash App, Wise, or Revolut. Peer-to-peer — no bank required, no signup.</p>
        </header>

        <div id="cashout-resume" class="cashout-resume" hidden></div>

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
      </div><!-- /#cashout-entry-wrap -->

        <div id="cashout-inflight" class="cashout-inflight" hidden>
          <div class="cashout-inflight-head">
            <div id="cashout-inflight-title" class="cashout-inflight-title">waiting for a buyer</div>
            <div id="cashout-inflight-sub" class="cashout-inflight-sub">this usually takes about an hour</div>
          </div>

          <ol class="cashout-inflight-steps" id="cashout-inflight-steps">
            <li data-step="submitted" class="cashout-step is-done">
              <span class="cashout-step-dot"></span>
              <span class="cashout-step-label">deposit submitted</span>
            </li>
            <li data-step="matched" class="cashout-step">
              <span class="cashout-step-dot"></span>
              <span class="cashout-step-label">buyer matched</span>
            </li>
            <li data-step="paid" class="cashout-step">
              <span class="cashout-step-dot"></span>
              <span class="cashout-step-label">payment sent</span>
            </li>
            <li data-step="done" class="cashout-step">
              <span class="cashout-step-dot"></span>
              <span class="cashout-step-label">complete</span>
            </li>
          </ol>

          <div id="cashout-inflight-body" class="cashout-inflight-body"></div>

          <ul class="cashout-inflight-safety">
            <li>your funds are locked in Peer's escrow — safe until a buyer matches</li>
            <li>you can close this tab · we'll notify you when it lands</li>
            <li>if no one matches in 24 h, everything returns to your wallet</li>
          </ul>

          <div class="cashout-inflight-meta">
            <span class="cashout-inflight-meta-label">deposit id</span>
            <code id="cashout-inflight-deposit-id" class="cashout-inflight-deposit-id"></code>
            <button id="cashout-inflight-copy" type="button" class="cashout-inflight-copy" title="copy deposit id"><i class="ph ph-copy"></i></button>
          </div>

          <button id="cashout-inflight-close" type="button" class="cashout-btn cashout-btn-ghost">close — we'll notify you</button>
        </div>
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
    resume: root.querySelector('#cashout-resume'),
    inflight: root.querySelector('#cashout-inflight'),
    inflightTitle: root.querySelector('#cashout-inflight-title'),
    inflightSub: root.querySelector('#cashout-inflight-sub'),
    inflightSteps: root.querySelector('#cashout-inflight-steps'),
    inflightBody: root.querySelector('#cashout-inflight-body'),
    inflightDepositId: root.querySelector('#cashout-inflight-deposit-id'),
    inflightCopy: root.querySelector('#cashout-inflight-copy'),
    inflightClose: root.querySelector('#cashout-inflight-close'),
    entryWrap: root.querySelector('#cashout-entry-wrap'),
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
    container.innerHTML = `<span class="cashout-loading" style="color:var(--muted)">no supported payout platforms right now</span>`
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

async function _renderResumeBanner(els, client, addr, cashCurrency) {
  // Peer's indexer can lag a fresh deposit by a few minutes, so
  // `orders(inFlight:true)` returns [] right after a submit even
  // though the on-chain deposit exists. Belt-and-braces: check
  // both the SDK's view AND our own server-side depositId
  // storage. The server row is written the moment cashout() returns
  // — no indexer lag — and is pruned once we observe a terminal
  // state via watch(). Whichever source gives a live order first
  // becomes the pending state; the other backfills as it catches up.
  let sdkOrders = []
  try { sdkOrders = await client.orders(addr, { inFlight: true, limit: 10 }) } catch {}

  const authToken = await getAuthToken?.().catch(() => null)
  const serverOrders = await _readServerOrders(authToken)
  // Only consider server rows from the last 24 h — Peer auto-returns
  // after 24 h, so anything older is either stale or truly gone.
  const recentServer = serverOrders.filter(o => Date.now() - (o.createdAt || 0) < 24 * 3600_000)

  const sdkFirst = sdkOrders?.[0]
  const serverFirst = recentServer[0]
  if (!sdkFirst && !serverFirst) return

  // Prefer whichever source has an ID we can trust. If both, prefer
  // the SDK's (authoritative on state), but hydrate copy from the
  // server row when possible (more human data).
  const depositId = sdkFirst?.depositId || serverFirst?.depositId
  const serverMatch = recentServer.find(o => o.depositId === depositId) || serverFirst
  let platform = serverMatch?.platform || ''
  let receiveFiat = Number(serverMatch?.amountFiat || 0)
  let currency = serverMatch?.currency || cashCurrency

  if (!platform && sdkFirst) {
    try {
      const full = await client.order(depositId)
      platform = full?.payouts?.[0]?.platform || ''
    } catch {}
  }
  const payee = platform ? _recallHandle(addr, platform) : ''

  _showInFlight(els, { depositId })
  const initial = sdkFirst || { state: 'awaiting-buyer', depositId }
  _renderInFlightState(els, initial, platform, payee, receiveFiat, currency)

  ;(async () => {
    try {
      const iterator = client.watch(depositId, { timeoutMs: 60 * 60_000 })
      for await (const order of iterator) {
        _renderInFlightState(els, order, platform, payee, receiveFiat, currency)
        if (order.state === 'delivered' || order.state === 'returned') {
          _pruneServerOrder(depositId, authToken).catch(() => {})
          break
        }
      }
    } catch {}
  })()
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

function _renderOrderState(els, order, platform) {
  // Legacy — kept as a no-op so any resume-banner code that still
  // calls it doesn't throw. The in-flight surface below is the real
  // renderer for a live cashout.
  void els; void order; void platform
}

function _showInFlight(els, { depositId }) {
  // Swap surfaces. The entry wrap holds the "cash out" header,
  // balance, form; the inflight surface takes the whole page — a
  // single story, per the design philosophy. Scroll back to the top
  // so the user sees the new state header first, not the tail of
  // wherever they left the scroll.
  if (els.entryWrap) els.entryWrap.hidden = true
  els.inflight.hidden = false
  try { els.inflight.scrollIntoView({ behavior: 'auto', block: 'start' }) } catch {}
  els.inflightDepositId.textContent = _shortDepositId(depositId)
  els.inflightDepositId.title = depositId
  els.inflightCopy.onclick = () => {
    try { navigator.clipboard.writeText(depositId) } catch {}
    els.inflightCopy.innerHTML = '<i class="ph ph-check"></i>'
    setTimeout(() => { els.inflightCopy.innerHTML = '<i class="ph ph-copy"></i>' }, 1200)
  }
  els.inflightClose.onclick = () => {
    // The cashout keeps running in the sheet's iterator, but the
    // user asked to leave. Send them home; the vault activity row
    // will pick up the same order via server-side depositId storage.
    location.href = '/earnings'
  }
}

function _renderInFlightState(els, order, platform, payee, receiveFiat, cashCurrency) {
  if (!els.inflight || els.inflight.hidden) return
  const s = order.state
  const prettyPlatform = platform ? _prettyPlatform(platform) : 'your payment method'
  const platformPossessive = platform ? `your ${_prettyPlatform(platform)}` : 'your payment method'
  const knowAmt = Number.isFinite(receiveFiat) && receiveFiat > 0
  const prettyAmt = knowAmt ? _formatFiat(receiveFiat, cashCurrency) : ''
  const amtPhrase = knowAmt ? `<strong>${prettyAmt}</strong>` : 'your cash-out'
  const handlePhrase = payee ? ` <strong>${_escape(payee)}</strong>` : ''
  const stateCopy = {
    'awaiting-buyer': {
      title: 'waiting for a buyer',
      sub: order.eta?.label || 'usually starts within an hour',
      body: `A buyer on the peer marketplace will send ${amtPhrase} to ${platformPossessive}${handlePhrase}. When they do, your deposit auto-releases. You don't need to send anything.`,
      activeStep: 'submitted',
    },
    'matched': {
      title: 'a buyer matched your cash-out',
      sub: 'they are sending your payment now — this can take a few minutes',
      body: `A buyer is sending ${amtPhrase} to ${platformPossessive}${handlePhrase}. Watch that account for the incoming payment.`,
      activeStep: 'matched',
    },
    'delivering': {
      title: 'confirming your payment',
      sub: 'the buyer said they paid — verifying with a cryptographic proof',
      body: `The buyer marked ${amtPhrase} as sent to ${platformPossessive}. Peer is verifying now. This takes about a minute.`,
      activeStep: 'paid',
    },
    'delivered': {
      title: knowAmt ? `${prettyAmt} sent to ${platformPossessive}` : 'payment sent',
      sub: 'check your account for the incoming payment',
      body: `Payment complete. ${amtPhrase} landed in ${platformPossessive}${handlePhrase}.`,
      activeStep: 'done',
    },
    'returned': {
      title: 'no buyer matched in time',
      sub: 'your funds are safely back in your wallet',
      body: 'No buyer matched within the 24 h window, so Peer returned your ETH. Try a smaller amount or a different payment method.',
      activeStep: 'submitted',
    },
  }[s] || {
    title: 'processing…',
    sub: '',
    body: order.explain?.() || 'working on it',
    activeStep: 'submitted',
  }

  els.inflightTitle.textContent = stateCopy.title
  els.inflightSub.textContent = stateCopy.sub
  els.inflightBody.innerHTML = stateCopy.body
  _advanceInFlightSteps(els.inflightSteps, stateCopy.activeStep)

  // For terminal states, swap the close button copy so the user has
  // a clear exit.
  if (s === 'delivered') {
    els.inflightClose.textContent = 'done · back to earnings'
    els.inflightClose.classList.add('cashout-btn-done')
  } else if (s === 'returned') {
    els.inflightClose.textContent = 'back to earnings'
  }
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
  // USDC-primary user typing in local currency.
  const usd = Number(sourceAmt) / 10 ** USDC_DECIMALS
  return usd * (localEthRate / usdEthRate)
}

// ─── Helpers ───

function _filterPlatforms(platforms, fillStats, currency) {
  const gated = platforms.filter(p => {
    const key = `${p.platform}:${currency}`
    const stats = fillStats?.[key]
    if (!stats) return true
    if (stats.fills < 10) return false
    if (stats.medianFillSeconds && stats.medianFillSeconds > 48 * 3600) return false
    return true
  })
  return gated.length > 0 ? gated : platforms
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
