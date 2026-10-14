// Fiat currency display system — shows ETH amounts with approximate fiat equivalents
// Uses CoinGecko API (proxied through server) for exchange rates
// 10 supported currencies: USD, EUR, GBP, JPY, CNY, BRL, NGN, KES, INR, KRW

import { getCached, setCache, TTL } from './cache.js'
import { formatEthAmount } from './utils.js'

const CURRENCY_KEY = 'praxis-currency'
const PRICE_CACHE_KEY = 'eth-prices'

let _fiatRateInterval = null

const LOCALE_TO_CURRENCY = {
  'en-US': 'usd', 'en-GB': 'gbp', 'en-NG': 'ngn', 'en-KE': 'kes',
  'ja': 'jpy', 'ja-JP': 'jpy', 'zh': 'cny', 'zh-CN': 'cny',
  'ko': 'krw', 'ko-KR': 'krw', 'pt-BR': 'brl', 'hi': 'inr', 'hi-IN': 'inr',
  'sw': 'kes', 'sw-KE': 'kes', 'de': 'eur', 'fr': 'eur', 'es': 'eur',
  'sv': 'sek', 'sv-SE': 'sek', 'da': 'dkk', 'da-DK': 'dkk',
  'id': 'idr', 'id-ID': 'idr', 'tr': 'try', 'tr-TR': 'try',
  'ru': 'rub', 'ru-RU': 'rub', 'bn': 'bdt', 'bn-BD': 'bdt',
  'vi': 'vnd', 'vi-VN': 'vnd', 'fa': 'irr', 'ur': 'pkr',
}

const SUPPORTED_CURRENCIES = ['usd', 'eur', 'gbp', 'jpy', 'cny', 'brl', 'ngn', 'kes', 'inr', 'krw', 'sek', 'dkk', 'idr', 'try', 'rub', 'bdt', 'vnd', 'pkr']

export function getUserCurrency() {
  return localStorage.getItem(CURRENCY_KEY) || detectCurrency()
}

function detectCurrency() {
  const lang = navigator.language || ''
  return LOCALE_TO_CURRENCY[lang] || LOCALE_TO_CURRENCY[lang.split('-')[0]] || 'usd'
}

export function setUserCurrency(code) {
  localStorage.setItem(CURRENCY_KEY, code)
  window.dispatchEvent(new CustomEvent('currency-changed'))
}

let _priceInflight = null
export async function getEthPrices() {
  const cached = getCached(PRICE_CACHE_KEY)
  if (cached) return cached
  if (_priceInflight) return _priceInflight
  _priceInflight = (async () => {
    try {
      const res = await fetch('/api/eth-price')
      if (!res.ok) return null
      const data = await res.json()
      setCache(PRICE_CACHE_KEY, data, TTL.medium)
      return data
    } catch { return null }
    finally { _priceInflight = null }
  })()
  return _priceInflight
}

export function formatFiat(amount, currency) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase(), maximumFractionDigits: 2 }).format(amount)
  } catch { return `${amount.toFixed(2)} ${currency.toUpperCase()}` }
}

export async function formatPriceWithFiat(wei) {
  const ethStr = formatEthAmount(wei)
  const ethNum = Number(wei) / 1e18
  if (ethNum === 0) return '0 ETH'
  const prices = await getEthPrices()
  if (!prices) return `${ethStr} ETH`
  const currency = getUserCurrency()
  const rate = prices[currency]
  if (!rate) return `${ethStr} ETH`
  const fiatAmount = ethNum * rate
  if (fiatAmount < 0.01) return `${ethStr} ETH (<${formatFiat(0.01, currency)})`
  return `${ethStr} ETH <span style="color:var(--dim)">(~${formatFiat(fiatAmount, currency)})</span>`
}

// Synchronous version — uses pre-fetched prices, for use in render loops
export function formatPriceSync(wei, prices) {
  const ethStr = formatEthAmount(wei)
  const ethNum = Number(wei) / 1e18
  if (ethNum === 0 || !prices) return `${ethStr} ETH`
  const currency = getUserCurrency()
  const rate = prices[currency]
  if (!rate) return `${ethStr} ETH`
  const fiatAmount = ethNum * rate
  if (fiatAmount < 0.01) return `${ethStr} ETH (<${formatFiat(0.01, currency)})`
  return `${ethStr} ETH <span style="color:var(--dim)">(~${formatFiat(fiatAmount, currency)})</span>`
}

// Fiat-primary format: shows fiat first, ETH as dim secondary
// e.g. "~$7.97 (0.0035 ETH)" instead of "0.0035 ETH (~$7.97)"
export function formatPriceFiatPrimary(wei, prices) {
  const ethStr = formatEthAmount(wei)
  const ethNum = Number(wei) / 1e18
  if (ethNum === 0) return `0 ETH`
  if (!prices) return `${ethStr} ETH`
  const currency = getUserCurrency()
  const rate = prices[currency]
  if (!rate) return `${ethStr} ETH`
  const fiatAmount = ethNum * rate
  if (fiatAmount < 0.01) return `<${formatFiat(0.01, currency)} <span style="color:var(--dim)">(${ethStr} ETH)</span>`
  return `~${formatFiat(fiatAmount, currency)} <span style="color:var(--dim)">(${ethStr} ETH)</span>`
}

// Fiat-only price display (no ETH shown)
export function formatPriceFiatOnly(wei, prices) {
  const ethNum = Number(wei) / 1e18
  if (ethNum === 0) return 'free'
  if (!prices) return formatEthAmount(wei) + ' ETH'
  const currency = getUserCurrency()
  const rate = prices[currency]
  if (!rate) return formatEthAmount(wei) + ' ETH'
  const fiatAmount = ethNum * rate
  if (fiatAmount < 0.01) return `<${formatFiat(0.01, currency)}`
  return `~${formatFiat(fiatAmount, currency)}`
}

// Post-render enhancement: finds all elements with data-eth-wei="<bigint string>"
// and appends the fiat approximation to their text. Idempotent — re-applies on
// currency-changed event so toggling the switcher re-renders live.
// Usage:
//   html += `<span data-eth-wei="${wei}">${ethStr} ETH</span>`
//   enhanceEthLabels(containerEl)
export async function enhanceEthLabels(rootEl) {
  // Preserves the historical name/behaviour (data-eth-wei) AND picks
  // up the newer ERC20 shape (data-token-amount + data-token-address)
  // in one pass so every call site stops at this one function.
  return enhanceTokenLabels(rootEl)
}

// Token-aware fiat enhancer. Handles two attribute pairs on an
// element:
//   [data-eth-wei]                       — ETH, uses getEthPrices() rate.
//   [data-token-amount] [data-token-address] [data-token-decimals?]
//                                        — any ERC20, uses the server
//                                          token-price oracle (Fork D)
//                                          with a per-token fallback.
// Both honour [data-fiat-primary] to render the fiat as the main
// label instead of a dim trailing (~$X). An ETH value emitted as
// data-eth-wei still works unchanged.
const _tokenRateCache = new Map() // "addr::currency" → { rate, ts }
const _TOKEN_RATE_TTL_MS = 30_000
async function _getTokenRate(addr, currency) {
  const key = `${(addr || '').toLowerCase()}::${currency}`
  const cached = _tokenRateCache.get(key)
  if (cached && Date.now() - cached.ts < _TOKEN_RATE_TTL_MS) return cached.rate
  try {
    const res = await fetch(`/api/token-price?token=${encodeURIComponent(addr)}&currency=${encodeURIComponent(currency)}`)
    if (res.ok) {
      const d = await res.json()
      if (d && Number.isFinite(d.price) && d.price > 0) {
        _tokenRateCache.set(key, { rate: d.price, ts: Date.now() })
        return d.price
      }
    }
  } catch {}
  // Stale fallback for the pre-Fork-D window: BOLD + USDS peg at 1.00
  // in USD. Returns 0 otherwise so the caller leaves the label alone.
  const stableSymbols = new Set(['0x03569cc076654f82679c4ba2124d64774781b01d', '0x4f13a96ec5c4cf34e442b46bbd98a0791f20edc3'])
  if (stableSymbols.has(String(addr || '').toLowerCase()) && currency === 'usd') return 1.0
  return 0
}

export async function enhanceTokenLabels(rootEl) {
  const root = rootEl || document
  const ethTargets = root.querySelectorAll('[data-eth-wei]:not([data-fiat-applied])')
  const tokenTargets = root.querySelectorAll('[data-token-amount]:not([data-fiat-applied])')
  if (!ethTargets.length && !tokenTargets.length) return
  const currency = getUserCurrency()

  // ETH path — unchanged behaviour.
  if (ethTargets.length) {
    const prices = await getEthPrices()
    const ethRate = prices?.[currency]
    if (ethRate) {
      for (const el of ethTargets) {
        const wei = el.dataset.ethWei
        if (!wei) continue
        const ethNum = Number(wei) / 1e18
        if (ethNum === 0) { el.dataset.fiatApplied = '1'; continue }
        const fiatAmount = ethNum * ethRate
        _writeFiatLabel(el, fiatAmount, currency)
      }
    }
  }

  // ERC20 path.
  for (const el of tokenTargets) {
    const amountStr = el.dataset.tokenAmount
    const addr = el.dataset.tokenAddress
    const decimals = parseInt(el.dataset.tokenDecimals || '18', 10)
    if (!amountStr || !addr) continue
    const rate = await _getTokenRate(addr, currency)
    if (!rate) continue
    let tokenNum
    try { tokenNum = Number(BigInt(amountStr)) / (10 ** decimals) } catch { tokenNum = 0 }
    if (!Number.isFinite(tokenNum) || tokenNum === 0) { el.dataset.fiatApplied = '1'; continue }
    const fiatAmount = tokenNum * rate
    _writeFiatLabel(el, fiatAmount, currency)
  }
}

function _writeFiatLabel(el, fiatAmount, currency) {
  const fiatStr = fiatAmount < 0.01 ? `<${formatFiat(0.01, currency)}` : `~${formatFiat(fiatAmount, currency)}`
  if (el.dataset.fiatPrimary) {
    el.innerHTML = fiatStr.replace(/^~/, '')
  } else {
    const existing = el.innerHTML.replace(/\s*<span class="fiat-approx">.*?<\/span>\s*$/i, '')
    el.innerHTML = `${existing} <span class="fiat-approx" style="color:var(--dim);font-size:0.85em">(${fiatStr})</span>`
  }
  el.dataset.fiatApplied = '1'
}

// Wire a global listener so the enhancement refreshes when the currency changes,
// and a MutationObserver so newly-rendered [data-eth-wei] elements get enhanced
// automatically without each call site having to import + invoke enhanceEthLabels.
if (typeof window !== 'undefined' && !window._ethFiatEnhanceBound) {
  window._ethFiatEnhanceBound = true
  window.addEventListener('currency-changed', () => {
    document.querySelectorAll('[data-fiat-applied]').forEach(el => { delete el.dataset.fiatApplied })
    enhanceTokenLabels()
  })
  // Debounced MutationObserver — batches node additions per animation frame.
  let _enhanceQueued = false
  const observer = new MutationObserver(() => {
    if (_enhanceQueued) return
    _enhanceQueued = true
    requestAnimationFrame(() => { _enhanceQueued = false; enhanceEthLabels() })
  })
  if (document.body) observer.observe(document.body, { childList: true, subtree: true })
  else document.addEventListener('DOMContentLoaded', () => observer.observe(document.body, { childList: true, subtree: true }))
  // Initial pass for server-rendered content
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => enhanceEthLabels())
  else enhanceEthLabels()
}

// Footer conversion line: "1 ETH = ~$3,500"
export function getConversionLine(prices) {
  if (!prices) return ''
  const currency = getUserCurrency()
  const rate = prices[currency]
  if (!rate) return ''
  return `1 ETH = ~${formatFiat(rate, currency)}`
}

// Initialize fiat system: currency switcher + footer rate display
export async function initFiat() {
  // set up currency switcher
  const switcher = document.getElementById('currency-switcher')
  if (switcher) {
    const current = getUserCurrency()
    switcher.value = current
    switcher.addEventListener('change', (e) => {
      setUserCurrency(e.target.value)
      updateFooterRate()
    })
  }

  // listen for currency changes from other sources
  window.addEventListener('currency-changed', () => {
    const switcher = document.getElementById('currency-switcher')
    if (switcher) switcher.value = getUserCurrency()
    updateFooterRate()
  })

  // initial footer rate
  await updateFooterRate()

  // refresh every 5 minutes
  if (_fiatRateInterval) clearInterval(_fiatRateInterval)
  _fiatRateInterval = setInterval(updateFooterRate, 5 * 60 * 1000)
}

// cleanup on SPA navigation
window.addEventListener('spa-navigate', () => {
  if (_fiatRateInterval) { clearInterval(_fiatRateInterval); _fiatRateInterval = null }
})

async function updateFooterRate() {
  const el = document.getElementById('eth-rate')
  if (!el) return
  const prices = await getEthPrices()
  el.textContent = getConversionLine(prices)
}

// auto-init when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initFiat)
} else {
  initFiat()
}
