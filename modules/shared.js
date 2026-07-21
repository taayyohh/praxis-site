// Shared utilities for content modules

/**
 * Escape HTML special characters to prevent XSS.
 * Used for any string interpolated into innerHTML/template literals.
 */
export function esc(s) {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function artPlaceholder(title, size = 240) {
  const t = (title || 'untitled').slice(0, 30)
  const escaped = esc(t)
  const fs = Math.min(18, Math.max(10, Math.floor(size / (t.length * 0.6))))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="width:100%;height:auto"><rect x="4" y="4" width="${size - 8}" height="${size - 8}" fill="none" stroke="var(--accent, #e0e0e0)" stroke-width="1.5"/><text x="${size / 2}" y="${size / 2}" text-anchor="middle" dominant-baseline="central" fill="var(--fg, #ccc)" font-family="monospace" font-size="${fs}">${escaped}</text></svg>`
}

/**
 * Generate the inline <script> block for batch-buy button delegation.
 * All modules that render batch-buy buttons (.batch-buy-btn) share this
 * identical client-side wiring code. The `errorLabel` parameter controls
 * what text the button resets to on purchase error (e.g. "buy all", "buy album").
 *
 * @param {string} [errorLabel] - label template for error-reset text.
 *   Use the literal `{price}` placeholder for the ETH price.
 *   Default: 'buy all ({price})'
 * @returns {string} HTML <script> block
 */
export function batchBuyScript(errorLabel = 'buy all ({price})') {
  // The error-reset builds the label from the button's data-total-price attr.
  // If the caller uses fiat-primary spans (music module), pass a literal HTML
  // string with no {price} placeholder -- the function detects this and uses
  // innerHTML instead of textContent for the reset.
  const useInnerHTML = !errorLabel.includes('{price}')
  const resetCode = useInnerHTML
    ? `btn.innerHTML = '${errorLabel.replace(/'/g, "\\'")}'.replace('{ethWei}', btn.dataset.totalPrice || '0')`
    : `var totalEth = Number(btn.dataset.totalPrice || '0') / 1e18; btn.textContent = '${errorLabel.replace(/'/g, "\\'")}'.replace('{price}', totalEth > 0 ? totalEth + ' ETH' : 'free')`

  return `
    import('/js/media.js').then(m => m.wireMediaBuyButtons?.())
    if (!window._batchBuyDelegated) {
      window._batchBuyDelegated = true
      document.addEventListener('click', async (e) => {
        const btn = e.target.closest('.batch-buy-btn[data-media-ids]')
        if (!btn || btn.disabled) return
        e.stopPropagation()
        try {
          const ids = JSON.parse(btn.dataset.mediaIds)
          const totalPrice = btn.dataset.totalPrice || '0'
          const addr = window.getWalletAddress?.()
          if (addr) {
            const owned = await window._getOwnedMediaIds?.(addr)
            if (owned) {
              const unownedIds = ids.filter(id => !owned.has(String(id)))
              if (unownedIds.length === 0) { btn.textContent = 'owned'; btn.disabled = true; return }
            }
          }
          btn.textContent = 'confirming...'
          btn.disabled = true
          const { purchaseBatchMedia } = await import('/js/media.js')
          await purchaseBatchMedia(ids, totalPrice)
          btn.textContent = 'owned'
          btn.style.borderColor = 'var(--accent)'
          btn.style.color = 'var(--accent)'
        } catch (err) {
          btn.textContent = err.code === 4001 ? 'cancelled' : 'error'
          btn.disabled = false
          setTimeout(() => {
            ${resetCode}
          }, 2000)
        }
      })
      async function checkBatchOwned() {
        const addr = window.getWalletAddress?.()
        if (!addr) return
        const owned = await window._getOwnedMediaIds?.(addr)
        if (!owned) return
        document.querySelectorAll('.batch-buy-btn[data-media-ids]').forEach(btn => {
          try {
            const ids = JSON.parse(btn.dataset.mediaIds)
            if (ids.every(id => owned.has(String(id)))) {
              btn.textContent = 'owned'
              btn.style.borderColor = 'var(--accent)'
              btn.style.color = 'var(--accent)'
              btn.disabled = true
            }
          } catch {}
        })
      }
      checkBatchOwned()
      window.addEventListener('wallet-connected', checkBatchOwned)
      window.addEventListener('spa-navigate', () => setTimeout(checkBatchOwned, 100))
    }`
}
