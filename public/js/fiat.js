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
}

const SUPPORTED_CURRENCIES = ['usd', 'eur', 'gbp', 'jpy', 'cny', 'brl', 'ngn', 'kes', 'inr', 'krw']

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

// Post-render enhancement: finds all elements with data-eth-wei="<bigint string>"
// and appends the fiat approximation to their text. Idempotent — re-applies on
// currency-changed event so toggling the switcher re-renders live.
// Usage:
//   html += `<span data-eth-wei="${wei}">${ethStr} ETH</span>`
//   enhanceEthLabels(containerEl)
export async function enhanceEthLabels(rootEl) {
  const root = rootEl || document
  const targets = root.querySelectorAll('[data-eth-wei]:not([data-fiat-applied])')
  if (!targets.length) return
  const prices = await getEthPrices()
  if (!prices) return
  const currency = getUserCurrency()
  const rate = prices[currency]
  if (!rate) return
  for (const el of targets) {
    const wei = el.dataset.ethWei
    if (!wei) continue
    const ethNum = Number(wei) / 1e18
    if (ethNum === 0) { el.dataset.fiatApplied = '1'; continue }
    const fiatAmount = ethNum * rate
    const fiatStr = fiatAmount < 0.01 ? `<${formatFiat(0.01, currency)}` : `~${formatFiat(fiatAmount, currency)}`
    const existing = el.innerHTML.replace(/\s*<span class="fiat-approx">.*?<\/span>\s*$/i, '')
    el.innerHTML = `${existing} <span class="fiat-approx" style="color:var(--dim);font-size:0.85em">(${fiatStr})</span>`
    el.dataset.fiatApplied = '1'
  }
}

// Wire a global listener so the enhancement refreshes when the currency changes,
// and a MutationObserver so newly-rendered [data-eth-wei] elements get enhanced
// automatically without each call site having to import + invoke enhanceEthLabels.
if (typeof window !== 'undefined' && !window._ethFiatEnhanceBound) {
  window._ethFiatEnhanceBound = true
  window.addEventListener('currency-changed', () => {
    document.querySelectorAll('[data-fiat-applied]').forEach(el => { delete el.dataset.fiatApplied })
    enhanceEthLabels()
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
