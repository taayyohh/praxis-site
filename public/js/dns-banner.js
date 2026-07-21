// dns-banner.js — DNS propagation poll + switch-to-custom-domain banner.
//
// When a user completes signup with a custom domain we redirect them to their
// <handle>.ourpraxis.network subdomain (which always works) and set the flag
// 'praxis-pending-custom-domain'. This module polls the custom domain in the
// background and surfaces a non-blocking banner once DNS + TLS are ready, letting
// the user one-click switch to the permanent custom domain.
//
// The subdomain stays as a permanent fallback so the module re-runs on every
// page load; the user can dismiss the banner but we keep the flag around until
// they explicitly switch.

const FLAG_KEY = 'praxis-pending-custom-domain'
const DISMISSED_UNTIL_KEY = 'praxis-pending-custom-domain-dismissed-until'
const POLL_INTERVAL_MS = 15000
const POLL_MAX_MS = 30 * 60 * 1000 // 30 minutes per page load
const DISMISS_COOLDOWN_MS = 10 * 60 * 1000

// Module-scoped cancel flag so the 10-minute poll chain can abort cleanly on
// dismiss, on switch, or on SPA navigation. Without this the setTimeout chain
// keeps pinging /api/health for up to 10 minutes after the user is gone.
let _cancelled = false

function showPendingBanner(customDomain) {
  if (document.getElementById('praxis-dns-banner')) return
  const banner = document.createElement('div')
  banner.id = 'praxis-dns-banner'
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:10000;padding:0.6em 1em;background:rgba(255,255,255,0.05);border-bottom:1px solid var(--border,#333);color:var(--muted,#999);font-size:0.85em;display:flex;justify-content:center;align-items:center;gap:1ch;flex-wrap:wrap'
  banner.innerHTML = `<span class="praxis-loader" style="width:0.8em;height:0.8em"></span> <span>setting up <strong style="color:var(--fg,#c0c0c0)"></strong> — this usually takes a few minutes</span>`
  banner.querySelector('strong').textContent = customDomain
  document.body.appendChild(banner)
}

function showReadyBanner(customDomain) {
  const existing = document.getElementById('praxis-dns-banner')
  if (existing) existing.remove()
  const banner = document.createElement('div')
  banner.id = 'praxis-dns-banner'
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:10000;padding:0.75em 1em;background:rgba(0,255,65,0.12);border-bottom:1px solid var(--accent,#00ff41);color:var(--fg,#c0c0c0);font-size:0.9em;display:flex;justify-content:center;align-items:center;gap:1ch;flex-wrap:wrap'
  banner.innerHTML = `
    <span>your custom domain <strong style="color:var(--accent,#00ff41)"></strong> is now live</span>
    <button id="praxis-dns-switch" style="background:var(--accent,#00ff41);color:#000;border:none;padding:0.35em 1em;cursor:pointer;font:inherit">switch to it</button>
    <button id="praxis-dns-dismiss" aria-label="dismiss" style="background:transparent;border:1px solid var(--dim,#333);color:var(--dim,#666);padding:0.35em 1ch;cursor:pointer;font:inherit">dismiss</button>
  `
  banner.querySelector('strong').textContent = customDomain
  document.body.appendChild(banner)

  banner.querySelector('#praxis-dns-switch')?.addEventListener('click', () => {
    _cancelled = true
    try { localStorage.removeItem(FLAG_KEY) } catch {}
    try { localStorage.removeItem(DISMISSED_UNTIL_KEY) } catch {}
    const addr = window.getWalletAddress?.()
    const restore = addr ? `?restore=${encodeURIComponent(addr)}` : ''
    window.location = `https://${customDomain}${restore}`
  })

  banner.querySelector('#praxis-dns-dismiss')?.addEventListener('click', () => {
    _cancelled = true
    try {
      localStorage.setItem(DISMISSED_UNTIL_KEY, String(Date.now() + DISMISS_COOLDOWN_MS))
      // Clear the pending flag too so we don't re-init the banner on the next
      // page load — the user explicitly dismissed it.
      localStorage.removeItem(FLAG_KEY)
    } catch {}
    banner.remove()
  })
}

async function checkOnce(customDomain) {
  try {
    const r = await fetch(`https://${customDomain}/api/health`, { method: 'GET', mode: 'no-cors' })
    // mode:no-cors returns opaque — any non-network-error response means the
    // domain is reachable with a valid TLS cert.
    return r.type === 'opaque' || r.ok
  } catch {
    return false
  }
}

export function initDnsBanner() {
  let customDomain
  try { customDomain = localStorage.getItem(FLAG_KEY) } catch { return }
  if (!customDomain) return
  // Safety: if we're already on the custom domain, the flag is stale.
  if (location.hostname === customDomain) {
    try { localStorage.removeItem(FLAG_KEY) } catch {}
    return
  }
  // Respect dismissal cooldown.
  try {
    const until = Number(localStorage.getItem(DISMISSED_UNTIL_KEY) || 0)
    if (until && Date.now() < until) return
    if (until) localStorage.removeItem(DISMISSED_UNTIL_KEY)
  } catch {}

  // Reset the cancel flag for this init (module may be re-entered on SPA nav)
  _cancelled = false
  // An SPA navigation (or wallet teardown) cancels the in-flight poll chain.
  window.addEventListener('spa-navigate', () => { _cancelled = true }, { once: true })

  const start = Date.now()
  const tick = async () => {
    if (_cancelled) return
    if (Date.now() - start > POLL_MAX_MS) {
      const el = document.getElementById('praxis-dns-banner')
      if (el) el.remove()
      return
    }
    const ok = await checkOnce(customDomain)
    if (_cancelled) return
    if (ok) {
      showReadyBanner(customDomain)
      return
    }
    setTimeout(tick, POLL_INTERVAL_MS)
  }
  // Show "setting up" banner immediately, then start polling.
  setTimeout(() => {
    if (_cancelled) return
    showPendingBanner(customDomain)
    tick()
  }, 2000)
}

initDnsBanner()
