// Lazy loader for heavy modules: dm.js, pay.js, settings.js
// These are rarely needed on initial page load. Each is imported on first demand.

const _loaded = { dm: null, pay: null, ramp: null, settings: null }

function loadDm() {
  if (!_loaded.dm) _loaded.dm = import('/js/dm.js').catch(e => { console.warn('[lazy] dm.js failed:', e); _loaded.dm = null })
  return _loaded.dm
}

function loadPay() {
  if (!_loaded.pay) _loaded.pay = import('/js/pay.js').catch(e => { console.warn('[lazy] pay.js failed:', e); _loaded.pay = null })
  return _loaded.pay
}

function loadSettings() {
  if (!_loaded.settings) _loaded.settings = import('/js/settings.js').catch(e => { console.warn('[lazy] settings.js failed:', e); _loaded.settings = null })
  return _loaded.settings
}

// --- dm.js triggers ---
// dm.js listens for: open-dm, auto-dm, wallet-connected (ANY signed-in user).
// It also restores unread dot from sessionStorage on load.
// Events are re-dispatched after load so dm.js's own listeners can handle them.

window.addEventListener('open-dm', async (e) => {
  if (_loaded.dm) return // already loaded, dm.js handles it
  await loadDm()
  window.dispatchEvent(new CustomEvent('open-dm', { detail: e.detail }))
})

window.addEventListener('auto-dm', async (e) => {
  if (_loaded.dm) return
  await loadDm()
  window.dispatchEvent(new CustomEvent('auto-dm', { detail: e.detail }))
})

// On wallet-connected, eagerly load dm.js for ANY signed-in user (not just owner).
// dm.js has its own hasRegistered gate — it only runs Client.build if the user has
// previously registered via /messages, so no new installations are ever created.
// Once loaded, it starts streamAllMessages() in the background so incoming DMs
// surface immediately, even before the user ever opens /messages. This fixes the
// "friend DM'd me but I didn't see it until I opened /messages" bug for returning
// users on any page, not only on the user's own artist site.
window.addEventListener('wallet-connected', () => {
  if (window.getWalletAddress?.()) loadDm()
})

// Restore unread dot immediately from sessionStorage (dm.js does this too, but
// we need it visible before dm.js loads)
if (sessionStorage.getItem('praxis-unread-msgs')) {
  setTimeout(() => {
    const dot = document.getElementById('dock-msg-dot')
    if (dot) dot.style.display = ''
  }, 500)
}

// --- ramp.js + pay.js triggers ---
// ramp.js exposes window.peerOnrampOptimism and window.peerOfframpOptimism (native zkp2p + Relay)
// pay.js uses event delegation for .buy-btn[data-id] clicks and imports ramp.js.
// Create stub globals that lazy-load ramp.js then forward the call.

function loadRamp() {
  if (!_loaded.ramp) _loaded.ramp = import('/js/ramp.js').catch(e => { console.warn('[lazy] ramp.js failed:', e); _loaded.ramp = null })
  return _loaded.ramp
}

window.peerOnrampOptimism = async (...args) => {
  await loadRamp()
  // ramp.js overwrites window.peerOnrampOptimism with the real function
  return window.peerOnrampOptimism?.(...args)
}

window.peerOfframpOptimism = async (...args) => {
  await loadRamp()
  return window.peerOfframpOptimism?.(...args)
}

// Pre-load pay.js when buy buttons exist on the page (after SPA navigation or initial load)
// so the delegated click handler in pay.js is ready before the user clicks
if (document.querySelector('.buy-btn[data-id]')) loadPay()

window.addEventListener('spa-navigate', () => {
  if (document.querySelector('.buy-btn[data-id]')) loadPay()
})

// --- settings.js triggers ---
// settings.js listens for: #dock-settings click and 'open-settings' custom event
// Re-dispatch open-settings after load so settings.js's own listener handles it.

window.addEventListener('open-settings', async () => {
  if (_loaded.settings) return // already loaded, settings.js handles it
  await loadSettings()
  window.dispatchEvent(new CustomEvent('open-settings'))
})

document.addEventListener('click', (e) => {
  if (e.target.closest('#dock-settings')) {
    loadSettings()
  }
})
