// Settings panel — CMS for editing site content
// Gear icon in dock opens full-screen slide-up panel with tabs

import { t } from './i18n.js'
import { contrastRatio, deriveFullPalette, hexToHsl } from './contrast.js'
import { getWalletProvider, escapeHtml, prettifyFilename, resizeImageFile, uploadToIpfs, uploadToIpfsXhr } from './utils.js'
import { parseEther } from './vendor.js'

let settingsToken = ''
let siteData = null


// --- Sub-page navigation state ---
let _activeSubpage = null // { type: 'music', mod: <module obj> } or null

// --- Collapsible editor state ---
const _editorExpandedItems = new Set()

let _editorCSSInjected = false
function _injectEditorCSS() {
  if (_editorCSSInjected) return
  _editorCSSInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .editor-collapse-header {
      display: flex; align-items: center; gap: 0.5ch; cursor: pointer;
      padding: 0.3em 0; user-select: none;
    }
    .editor-collapse-header .drag-handle {
      cursor: grab; font-size: 1.1em; color: var(--dim); padding: 0 0.3ch;
      touch-action: none;
    }
    .editor-collapse-header .drag-handle:active { cursor: grabbing; }
    .editor-collapse-header .collapse-title {
      flex: 1; font-size: 0.85em; color: var(--fg); white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis;
    }
    .editor-collapse-header .collapse-chevron {
      font-size: 0.8em; color: var(--dim); transition: transform 0.15s;
      flex-shrink: 0;
    }
    .editor-collapse-header .collapse-chevron.expanded { transform: rotate(90deg); }
    .editor-collapse-body { display: none; }
    .editor-collapse-body.expanded { display: block; }
    .editor-item.drag-over { border-top: 2px solid var(--accent) !important; }
    .editor-item.dragging { opacity: 0.4; }
  `
  document.head.appendChild(style)
}

function _wireDragDrop(container, itemSelector, onReorder) {
  let dragIdx = null
  container.querySelectorAll(itemSelector).forEach(item => {
    const handle = item.querySelector('.drag-handle')
    if (!handle) return
    item.setAttribute('draggable', 'false')
    handle.addEventListener('mousedown', () => { item.setAttribute('draggable', 'true') })
    handle.addEventListener('touchstart', () => { item.setAttribute('draggable', 'true') }, { passive: true })
    item.addEventListener('dragend', () => { item.setAttribute('draggable', 'false') })
    item.addEventListener('dragstart', (e) => {
      dragIdx = parseInt(item.dataset.dragIdx)
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', dragIdx)
      requestAnimationFrame(() => item.classList.add('dragging'))
    })
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging')
      container.querySelectorAll(itemSelector).forEach(el => el.classList.remove('drag-over'))
      dragIdx = null
    })
    item.addEventListener('dragover', (e) => {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      const targetIdx = parseInt(item.dataset.dragIdx)
      container.querySelectorAll(itemSelector).forEach(el => el.classList.remove('drag-over'))
      if (targetIdx !== dragIdx) item.classList.add('drag-over')
    })
    item.addEventListener('dragleave', () => { item.classList.remove('drag-over') })
    item.addEventListener('drop', (e) => {
      e.preventDefault()
      item.classList.remove('drag-over')
      const fromIdx = dragIdx
      const toIdx = parseInt(item.dataset.dragIdx)
      if (fromIdx !== null && fromIdx !== toIdx) onReorder(fromIdx, toIdx)
      dragIdx = null
    })
  })
}

function _arrayMove(arr, fromIdx, toIdx) {
  const [item] = arr.splice(fromIdx, 1)
  arr.splice(toIdx, 0, item)
}

function _remapExpandedKeys(prefix, from, to) {
  const newExpanded = new Set()
  _editorExpandedItems.forEach(k => {
    if (k.startsWith(prefix + '-')) {
      const idx = parseInt(k.slice(prefix.length + 1))
      if (isNaN(idx)) { newExpanded.add(k); return }
      let newIdx = idx
      if (idx === from) newIdx = to
      else if (from < to && idx > from && idx <= to) newIdx = idx - 1
      else if (from > to && idx >= to && idx < from) newIdx = idx + 1
      newExpanded.add(`${prefix}-${newIdx}`)
    } else {
      newExpanded.add(k)
    }
  })
  _editorExpandedItems.clear()
  newExpanded.forEach(k => _editorExpandedItems.add(k))
}

function _wireCollapseToggles(el, prefix) {
  el.querySelectorAll(`.editor-collapse-header[data-toggle-prefix="${prefix}"]`).forEach(header => {
    header.addEventListener('click', (e) => {
      if (e.target.closest('.drag-handle')) return
      const idx = parseInt(header.dataset.toggleIdx)
      const key = `${prefix}-${idx}`
      if (_editorExpandedItems.has(key)) _editorExpandedItems.delete(key)
      else _editorExpandedItems.add(key)
      const body = header.nextElementSibling
      const chevron = header.querySelector('.collapse-chevron')
      body.classList.toggle('expanded')
      chevron.classList.toggle('expanded')
    })
  })
}

function _wireCollapseAndDrag(el, prefix, arr, mod) {
  _wireCollapseToggles(el, prefix)
  _wireDragDrop(el, '.editor-item[data-drag-idx]', (from, to) => {
    _remapExpandedKeys(prefix, from, to)
    _arrayMove(arr, from, to)
    mod.data = Array.isArray(mod.data) ? arr : mod.data
    renderModuleEditor(el, mod)
  })
}

// Mirror of build.js TEMPLATE_LABELS so the modules tab can show the
// effective placeholder for the module's display name (e.g. switching to
// the "performer" template makes the demos module render as "rehearsals",
// and the input placeholder needs to reflect that, otherwise users have no
// way to discover where the new label is coming from).
const TEMPLATE_LABELS = {
  musician:  { music: 'discography', audio: 'discography', demos: 'demos' },
  filmmaker: { video: 'films', gallery: 'portfolio', demos: 'dailies' },
  visual:    { gallery: 'portfolio', demos: 'sketches' },
  writer:    { writing: 'writing', gallery: 'gallery', demos: 'drafts' },
  performer: { demos: 'rehearsals' },
}

function effectiveModuleLabel(moduleType) {
  const tpl = siteData?.template || 'default'
  const overrides = TEMPLATE_LABELS[tpl] || {}
  return overrides[moduleType] || t('settings.modules.' + moduleType)
}

// clear cached auth token on wallet switch so next save re-authenticates
window.addEventListener('wallet-connected', () => { settingsToken = '' })
window.addEventListener('wallet-disconnected', () => { settingsToken = '' })

// Generic confirm modal for destructive actions (replaces native confirm()).
// Use this for typical removes (album, track, gallery image, exhibition,
// project, etc.) where a single click on a confirm button is enough friction.
// For the most destructive actions (removing an entire module with on-chain
// content), use showRemoveModuleModal() which requires typing "i confirm".
//
// Usage:  const ok = await confirmModal({ title, body, confirmLabel, danger })
function confirmModal({ title, body = '', confirmLabel = 'remove', cancelLabel = 'cancel', danger = true } = {}) {
  return new Promise(resolve => {
    const overlay = document.createElement('div')
    overlay.className = 'praxis-modal-overlay'
    const dialog = document.createElement('div')
    dialog.className = 'praxis-modal-dialog'
    dialog.style.maxWidth = '380px'
    dialog.style.fontFamily = 'inherit'
    const titleHtml = title ? `<div style="color:var(--fg, #c0c0c0);margin-bottom:0.5em;font-size:0.95em">${escapeHtml(title)}</div>` : ''
    const bodyHtml = body ? `<div style="color:var(--dim, #888);font-size:0.85em;margin-bottom:1em;line-height:1.4">${escapeHtml(body)}</div>` : ''
    const confirmColor = danger ? 'var(--accent)' : 'var(--fg, #c0c0c0)'
    dialog.innerHTML = `
      ${titleHtml}
      ${bodyHtml}
      <div style="display:flex;gap:1ch;justify-content:flex-end">
        <button id="cm-cancel" style="background:none;border:none;color:var(--dim, #444);font-family:inherit;font-size:0.85em;cursor:pointer">${cancelLabel}</button>
        <button id="cm-confirm" style="background:none;border:1px solid ${confirmColor};color:${confirmColor};font-family:inherit;font-size:0.85em;padding:0.4em 1.5ch;cursor:pointer">${confirmLabel}</button>
      </div>
    `
    overlay.appendChild(dialog)
    document.body.appendChild(overlay)
    const cleanup = (result) => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(result) }
    const onKey = (e) => { if (e.key === 'Escape') cleanup(false) }
    document.addEventListener('keydown', onKey)
    dialog.querySelector('#cm-confirm').addEventListener('click', () => cleanup(true))
    dialog.querySelector('#cm-cancel').addEventListener('click', () => cleanup(false))
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false) })
    dialog.querySelector('#cm-confirm').focus()
  })
}

// Prompt modal — like confirmModal but with a text input + autocomplete from Praxis artists.
function promptModal({ title, placeholder = '', confirmLabel = 'ok', cancelLabel = 'cancel' } = {}) {
  return new Promise(resolve => {
    const overlay = document.createElement('div')
    overlay.className = 'praxis-modal-overlay'
    const dialog = document.createElement('div')
    dialog.className = 'praxis-modal-dialog'
    dialog.style.maxWidth = '380px'
    dialog.innerHTML = `
      <div style="color:var(--fg);margin-bottom:0.75em;font-size:0.95em">${escapeHtml(title || '')}</div>
      <div style="position:relative">
        <input id="pm-input" type="text" placeholder="${placeholder}" autocomplete="off" style="width:100%;background:var(--bg,#111);border:1px solid var(--border);color:var(--fg);font-family:inherit;font-size:0.9em;padding:0.5em 1ch;box-sizing:border-box">
        <div id="pm-suggestions" style="position:absolute;top:100%;left:0;right:0;background:var(--bg,#111);border:1px solid var(--border);border-top:none;max-height:150px;overflow-y:auto;display:none;z-index:10"></div>
      </div>
      <div style="margin-top:0.75em;display:flex;gap:1ch;justify-content:flex-end">
        <button id="pm-cancel" style="background:none;border:none;color:var(--dim);font-family:inherit;font-size:0.85em;cursor:pointer">${cancelLabel}</button>
        <button id="pm-confirm" style="background:none;border:1px solid var(--accent);color:var(--accent);font-family:inherit;font-size:0.85em;padding:0.4em 1.5ch;cursor:pointer">${confirmLabel}</button>
      </div>
    `
    overlay.appendChild(dialog)
    document.body.appendChild(overlay)
    const input = dialog.querySelector('#pm-input')
    const suggestions = dialog.querySelector('#pm-suggestions')
    let debounceTimer = null

    // Autocomplete from /api/network/search
    input.addEventListener('input', () => {
      clearTimeout(debounceTimer)
      const q = input.value.trim()
      if (q.length < 2) { suggestions.style.display = 'none'; return }
      debounceTimer = setTimeout(async () => {
        try {
          const resp = await fetch(`/api/network/search?q=${encodeURIComponent(q)}&limit=5`)
          if (!resp.ok) return
          const data = await resp.json()
          const results = (data.results || []).filter(r => r.type === 'artist')
          if (!results.length) { suggestions.style.display = 'none'; return }
          suggestions.innerHTML = results.map(a =>
            `<div class="pm-suggestion" data-domain="${escapeHtml(a.name)}" style="padding:0.4em 1ch;cursor:pointer;font-size:0.85em;color:var(--fg);border-bottom:1px solid var(--border)">${escapeHtml(a.name)}</div>`
          ).join('')
          suggestions.style.display = 'block'
          suggestions.querySelectorAll('.pm-suggestion').forEach(el => {
            el.addEventListener('click', () => { input.value = el.dataset.domain; suggestions.style.display = 'none' })
            el.addEventListener('mouseenter', () => { el.style.background = 'var(--surface,#1a1a1a)' })
            el.addEventListener('mouseleave', () => { el.style.background = '' })
          })
        } catch {}
      }, 200)
    })

    const cleanup = (val) => { clearTimeout(debounceTimer); overlay.remove(); document.removeEventListener('keydown', onKey); resolve(val) }
    const onKey = (e) => { if (e.key === 'Escape') cleanup(null); if (e.key === 'Enter') cleanup(input.value.trim() || null) }
    document.addEventListener('keydown', onKey)
    dialog.querySelector('#pm-confirm').addEventListener('click', () => cleanup(input.value.trim() || null))
    dialog.querySelector('#pm-cancel').addEventListener('click', () => cleanup(null))
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(null) })
    input.focus()
  })
}

// custom modal to confirm module removal (replaces native prompt)
function showRemoveModuleModal(moduleName) {
  return new Promise(resolve => {
    const overlay = document.createElement('div')
    overlay.className = 'praxis-modal-overlay'
    const dialog = document.createElement('div')
    dialog.className = 'praxis-modal-dialog'
    dialog.style.maxWidth = '380px'
    dialog.style.fontFamily = 'inherit'
    dialog.innerHTML = `
      <div style="color:var(--fg, #c0c0c0);margin-bottom:0.5em;font-size:0.95em">remove ${escapeHtml(moduleName)}</div>
      <div style="color:var(--dim, #444);font-size:0.85em;margin-bottom:1em">this module has content that may be linked on-chain. removing it hides the section from your site but does not delete on-chain data. type 'i confirm' to continue:</div>
      <input id="remove-mod-input" type="text" autocomplete="off" spellcheck="false"
        placeholder="i confirm"
        style="background:none;border:1px solid var(--border, #333);color:var(--fg, #c0c0c0);font-family:inherit;font-size:0.9em;padding:0.4em 0.75ch;width:100%;box-sizing:border-box;margin-bottom:1em">
      <div style="display:flex;gap:1ch">
        <button id="remove-mod-confirm" disabled style="background:none;border:1px solid var(--border, #333);color:var(--fg, #c0c0c0);font-family:inherit;font-size:0.85em;padding:0.4em 1.5ch;cursor:pointer;opacity:0.4">confirm</button>
        <button id="remove-mod-cancel" style="background:none;border:none;color:var(--dim, #444);font-family:inherit;font-size:0.85em;cursor:pointer">cancel</button>
      </div>
    `
    overlay.appendChild(dialog)
    document.body.appendChild(overlay)
    const input = document.getElementById('remove-mod-input')
    const confirmBtn = document.getElementById('remove-mod-confirm')
    const cancelBtn = document.getElementById('remove-mod-cancel')
    input.addEventListener('input', () => {
      const match = input.value.trim().toLowerCase() === 'i confirm'
      confirmBtn.disabled = !match
      confirmBtn.style.opacity = match ? '1' : '0.4'
    })
    const cleanup = (result) => { overlay.remove(); resolve(result) }
    confirmBtn.addEventListener('click', () => cleanup(true))
    cancelBtn.addEventListener('click', () => cleanup(false))
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false) })
    input.focus()
  })
}

// get auth token for API calls
let _settingsTokenTs = 0
async function getSettingsToken() {
  // Refresh token if older than 20 min (server may have restarted via deploy)
  if (settingsToken && Date.now() - _settingsTokenTs > 20 * 60 * 1000) settingsToken = ''
  if (settingsToken) return settingsToken
  // ensure embedded wallet is unlocked before signing
  // For embedded wallets, this will prompt the password dialog if session expired
  let authorizedAddr
  try {
    authorizedAddr = await window.ensureAuthorized?.()
  } catch {
    // If ensureAuthorized fails (user cancelled unlock), return empty
    return ''
  }
  const addr = authorizedAddr || window.getWalletAddress?.()
  if (!addr || !getWalletProvider()) return ''
  try {
    const msg = `admin:${location.hostname}:${Date.now()}`
    const sig = await getWalletProvider().request({ method: 'personal_sign', params: [msg, addr] })
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: addr, signature: sig, message: msg }),
    })
    const data = await res.json()
    if (data.token) { settingsToken = data.token; _settingsTokenTs = Date.now() }
    return settingsToken
  } catch (e) {
    // If personal_sign fails (session expired), try re-authorizing once
    if (e?.message?.includes('session expired') || e?.code === 4100) {
      try {
        const retryAddr = await window.ensureAuthorized?.()
        if (!retryAddr) return ''
        const msg = `admin:${location.hostname}:${Date.now()}`
        const sig = await getWalletProvider().request({ method: 'personal_sign', params: [msg, retryAddr] })
        const res = await fetch('/api/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: retryAddr, signature: sig, message: msg }),
        })
        const data = await res.json()
        if (data.token) { settingsToken = data.token; _settingsTokenTs = Date.now() }
        return settingsToken
      } catch { return '' }
    }
    return ''
  }
}

async function api(path, opts = {}) {
  // GET /api/site is public — no auth needed for reading
  if (!opts.method || opts.method === 'GET') {
    const res = await fetch(path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...opts.headers },
    })
    return res.json()
  }
  // writes require auth
  const token = await getSettingsToken()
  if (!token) return null
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...opts.headers },
  })
  // if 401, clear cached token and retry once (session may have expired after deploy)
  if (res.status === 401) {
    console.warn('settings 401 — re-authenticating...')
    settingsToken = ''
    const freshToken = await getSettingsToken()
    if (!freshToken) { console.warn('re-auth failed — no token'); return null }
    const retry = await fetch(path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${freshToken}`, ...opts.headers },
    })
    return retry.json()
  }
  return res.json()
}

let _settingsAnimating = false

function _showSettingsGate(msg) {
  const panel = document.createElement('div')
  panel.id = 'settings-panel'
  panel.className = 'settings-panel'
  panel.innerHTML = `
    <div class="settings-inner">
      <div class="settings-header">
        <button id="settings-close" class="compose-close-btn" aria-label="close settings"><i class="ph ph-x"></i></button>
        <span class="compose-label">${t('settings.title')}</span>
      </div>
      <div class="settings-content" id="settings-content">
        <p style="color:var(--muted);padding:2em 1em;text-align:center">${msg}</p>
      </div>
    </div>
  `
  document.body.appendChild(panel)
  document.body.style.overflow = 'hidden'
  requestAnimationFrame(() => panel.classList.add('settings-open'))
  document.getElementById('settings-close').addEventListener('click', closeSettings)
}

// listen for settings open (from wallet dropdown or dock)
window.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('click', (e) => {
    if (e.target.closest('#dock-settings')) openSettings()
  })
})
window.addEventListener('open-settings', openSettings)

// Treasury dock button dispatches this after 'open-settings' — scroll
// straight to the shared-account section under identity → orgs.
window.addEventListener('open-settings-section', (e) => {
  const which = e?.detail?.section
  const targetId = which === 'orgs' ? 's-org-content' : null
  if (!targetId) return
  // Retry a few times because the panel + its content render
  // asynchronously after openSettings resolves.
  let tries = 0
  const tick = () => {
    tries += 1
    const el = document.getElementById(targetId)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return
    }
    if (tries < 20) setTimeout(tick, 100)
  }
  tick()
})

async function openSettings() {
  if (_settingsAnimating) return
  document.getElementById('settings-panel')?.remove()

  // gate: only the site owner may access settings. Route through
  // isSiteOwner so Safe signers on an org tenant pass — a bare
  // string compare would only recognize the Safe address itself,
  // which nobody can actually connect a wallet as.
  const connectedAddr = window.getWalletAddress?.()
  const ownerAddr = document.body.dataset.owner
  // t() returns the raw key when no translation is loaded, so a plain
  // `t(...) || fallback` never picks the fallback. Detect the key-echo
  // case explicitly.
  const _msg = (key, fallback) => {
    const s = t(key)
    return (s && s !== key) ? s : fallback
  }
  if (!connectedAddr) {
    _showSettingsGate(_msg('settings.connectWallet', 'Connect wallet to access settings'))
    return
  }
  const { isSiteOwner } = await import('./utils.js')
  if (!ownerAddr || !(await isSiteOwner(connectedAddr, ownerAddr))) {
    _showSettingsGate(_msg('settings.ownerOnly', 'Settings are only available to the site owner'))
    return
  }

  const panel = document.createElement('div')
  panel.id = 'settings-panel'
  panel.className = 'settings-panel'
  panel.innerHTML = `
    <div class="settings-inner">
      <div class="settings-header">
        <button id="settings-close" class="compose-close-btn" aria-label="close settings"><i class="ph ph-x"></i></button>
        <span class="compose-label">${t('settings.title')}</span>
        <span id="settings-status" style="font-size:0.75em;color:var(--muted)"></span>
      </div>
      <div class="settings-tabs" id="settings-tabs">
        <button class="settings-tab active" data-tab="identity">${t('settings.tab.identity')}</button>
        <button class="settings-tab" data-tab="modules">${t('settings.tab.modules')}</button>
        <!-- homepage config moved into modules tab -->
        <button class="settings-tab" data-tab="theme">${t('settings.tab.theme')}</button>
      </div>
      <div class="settings-content" id="settings-content">
        <span class="praxis-loader"></span>
      </div>
    </div>
  `
  document.body.appendChild(panel)
  document.body.style.overflow = 'hidden'
  _settingsAnimating = true
  requestAnimationFrame(() => {
    panel.classList.add('settings-open')
    setTimeout(() => { _settingsAnimating = false }, 300)
  })

  // close
  document.getElementById('settings-close').addEventListener('click', closeSettings)

  // tabs
  panel.querySelectorAll('.settings-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      panel.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'))
      tab.classList.add('active')
      renderTab(tab.dataset.tab)
    })
  })

  // Pre-fetch auth token in background (so autosave doesn't trigger wallet prompt mid-edit)
  // Don't block — site data loads via public GET, no auth needed for reading
  getSettingsToken().catch(() => {})

  // autosave: debounced on any input change within settings panel
  let _autosaveTimer = null
  let _saving = false
  panel.addEventListener('input', () => {
    if (_autosaveTimer) clearTimeout(_autosaveTimer)
    const statusEl = document.getElementById('settings-status')
    if (statusEl) statusEl.textContent = 'unsaved'
    _autosaveTimer = setTimeout(() => saveSettings(), 1500)
  })
  // also autosave on checkbox/select change (these don't always fire 'input')
  panel.addEventListener('change', () => {
    if (_autosaveTimer) clearTimeout(_autosaveTimer)
    _autosaveTimer = setTimeout(() => saveSettings(), 800)
  })
  // autosave on reorder/remove button clicks (move-up, move-down, remove, add)
  panel.addEventListener('click', (e) => {
    const btn = e.target.closest('[class*="-move-"], [class*="ed-remove"], [class*="ed-rm-"], .add-img, .add-ex, .add-pub, .add-track, .add-gen')
    if (!btn) return
    if (_autosaveTimer) clearTimeout(_autosaveTimer)
    const statusEl = document.getElementById('settings-status')
    if (statusEl) statusEl.textContent = 'unsaved'
    _autosaveTimer = setTimeout(() => saveSettings(), 800)
  })

  // Token pre-fetch is fire-and-forget on line 226 — don't block rendering here

  // load site data
  siteData = await api('/api/site')
  if (siteData && !Array.isArray(siteData.modules)) siteData.modules = []
  if (!siteData) {
    document.getElementById('settings-content').innerHTML = `<p style="color:var(--muted)">${t('settings.signIn')}</p>`
    return
  }

  // supporters don't have modules or highlights — hide those tabs
  if (siteData.supporter) {
    panel.querySelectorAll('.settings-tab').forEach(tab => {
      if (tab.dataset.tab === 'modules' || tab.dataset.tab === 'homepage') {
        tab.style.display = 'none'
      }
    })
  }

  renderTab('identity')
}

let _savingInFlight = false

async function closeSettings() {
  // Don't bail if openSettings' opening animation flag is still latched —
  // that leaves the close button feeling broken if the user clicks it fast.
  // if there's an unsaved autosave pending, flush it now
  if (_savingInFlight) {
    const statusEl = document.getElementById('settings-status')
    if (statusEl) statusEl.textContent = 'saving...'
    // wait for save to complete (max 5s)
    for (let i = 0; i < 50 && _savingInFlight; i++) await new Promise(r => setTimeout(r, 100))
  }
  const panel = document.getElementById('settings-panel')
  if (!panel) return
  _settingsAnimating = true
  panel.classList.remove('settings-open')
  document.body.style.overflow = ''
  setTimeout(() => { panel.remove(); _settingsAnimating = false }, 300)
}

// Renders the biometric security card. Glowing green dot when enabled,
// dim outline dot when disabled. Title + description + single action button.
function renderBiometricCard(enabled) {
  if (enabled) {
    return `
      <div class="settings-status-card">
        <div class="status-body">
          <div class="status-title"><span class="status-dot on"></span>biometric confirmation <strong style="color:#4ade80;font-weight:normal;margin-left:0.4em">on</strong></div>
          <div class="status-desc">Face ID / fingerprint required to confirm transactions and unlock your wallet on this device.</div>
        </div>
        <div class="status-action">
          <button id="settings-bio-disable" class="buy-btn" style="font-size:0.8em;padding:0.4em 1.2ch;color:#a44;border-color:#a44">disable</button>
        </div>
      </div>
    `
  }
  return `
    <div class="settings-status-card">
      <div class="status-body">
        <div class="status-title"><span class="status-dot off"></span>biometric confirmation <span style="color:var(--muted);margin-left:0.4em">off</span></div>
        <div class="status-desc">Add Face ID / fingerprint as a second factor before any transaction or unlock. Recommended.</div>
      </div>
      <div class="status-action">
        <button id="settings-bio-enable" class="buy-btn" style="font-size:0.8em;padding:0.4em 1.2ch">enable</button>
      </div>
    </div>
  `
}

function renderTab(tab) {
  const el = document.getElementById('settings-content')
  if (!el || !siteData) return

  if (tab === 'identity') renderIdentityTab(el)
  else if (tab === 'modules') renderModulesTab(el)
  else if (tab === 'theme') renderThemeTab(el)
  // ai tab removed — local Ollama too slow, revisit with cloud API
}

// --- Identity Tab ---

function renderIdentityTab(el) {
  const esc = escapeHtml
  el.innerHTML = `
    <div style="max-width:500px">
      <div class="settings-field">
        <label class="settings-label">${t('settings.identity.name')}</label>
        <input type="text" id="s-name" class="project-input" value="${esc(siteData.name)}">
      </div>
      <div class="settings-field">
        <label class="settings-label">profile picture</label>
        <div style="display:flex;align-items:center;gap:1em">
          <div id="s-pfp-preview" style="width:64px;height:64px;border-radius:50%;border:1px solid var(--border);overflow:hidden;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:var(--bg2,#1a1a1a)">
            ${siteData.profilePic ? `<img src="${esc(siteData.profilePic)}" style="width:100%;height:100%;object-fit:cover">` : `<span style="font-size:0.7em;color:var(--dim)">none</span>`}
          </div>
          <div style="display:flex;gap:0.5em;flex-wrap:wrap">
            <button type="button" id="s-pfp-upload" class="btn-small" style="font-size:0.8em">upload</button>
            ${siteData.profilePic ? `<button type="button" id="s-pfp-remove" class="btn-small" style="font-size:0.8em;opacity:0.6">remove</button>` : ''}
          </div>
        </div>
      </div>
      <div class="settings-field">
        <label class="settings-label">site logo</label>
        <div style="display:flex;align-items:center;gap:1em">
          <div id="s-logo-preview" style="width:120px;height:36px;border:1px solid var(--border);display:flex;align-items:center;justify-content:center;background:var(--bg2,#1a1a1a);padding:0.2em 0.5ch;flex-shrink:0">
            ${siteData.logo ? `<img src="${esc(siteData.logo)}" style="max-height:100%;max-width:100%;object-fit:contain">` : `<span style="font-size:0.7em;color:var(--dim)">${esc(siteData.domain || 'domain')}</span>`}
          </div>
          <div style="display:flex;gap:0.5em;flex-wrap:wrap">
            <button type="button" id="s-logo-upload" class="btn-small" style="font-size:0.8em">upload</button>
            ${siteData.logo ? `<button type="button" id="s-logo-remove" class="btn-small" style="font-size:0.8em;opacity:0.6">remove</button>` : ''}
          </div>
        </div>
        <p style="font-size:0.75em;color:var(--dim);margin:0.4em 0 0;line-height:1.5">replaces your domain name in the top-left of every page. wide horizontal images work best (transparent PNG or SVG). auto-shrunk to fit — max 28px tall, 200px wide.</p>
      </div>
      <div class="settings-field">
        <label class="settings-label">short bio</label>
        <textarea id="s-short-bio" class="project-input" rows="2" maxlength="140" style="resize:vertical" placeholder="one or two sentences">${esc(siteData.shortBio)}</textarea>
        <div style="display:flex;justify-content:space-between;gap:1ch;margin-top:0.25em">
          <span style="font-size:0.75em;color:var(--dim)">shown on cards, graph nodes, search results, social previews</span>
          <span id="s-short-bio-count" style="font-size:0.75em;color:var(--dim)">${(siteData.shortBio || '').length}/140</span>
        </div>
      </div>
      <div class="settings-field">
        <label class="settings-label">${t('settings.identity.bio')}</label>
        <textarea id="s-bio" class="project-input" rows="4" style="resize:vertical" autocomplete="off" data-1p-ignore data-lpignore="true">${esc(siteData.bio)}</textarea>
      </div>
      <div class="settings-field">
        <label class="settings-label">${t('settings.identity.template')}</label>
        <input type="hidden" id="s-template" value="${siteData.template || 'default'}">
        <div id="s-template-cards" style="display:grid;grid-template-columns:1fr 1fr;gap:0.75em;margin-top:0.5em">
          ${siteData.template === 'organization'
            ? ['collective', 'label', 'gallery', 'company', 'publisher'].map(tp => {
                const info = {
                  collective: { desc: 'shared practice, flat structure', style: 'equal roster, collaborative' },
                  label: { desc: 'roster + catalog', style: 'artist roster, releases, discography' },
                  gallery: { desc: 'exhibitions + represented artists', style: 'curated shows, collection' },
                  company: { desc: 'productions + cast/crew', style: 'theatre, dance, film productions' },
                  publisher: { desc: 'publications + authors', style: 'books, journals, literary catalog' },
                }[tp]
                const orgType = siteData.orgType || 'collective'
                return `<div class="template-card ${orgType === tp ? 'active' : ''}" data-org-type="${tp}">
                  <span class="template-card-name">${tp}</span>
                  <span class="template-card-desc">${info.desc}</span>
                  <span class="template-card-style">${info.style}</span>
                </div>`
              }).join('')
            : ['default', 'musician', 'visual', 'writer', 'performer', 'filmmaker'].map(tp => {
                const info = {
                  default: { desc: 'minimal text-only layout', style: 'clean lines, text-forward' },
                  musician: { desc: 'album art, discography', style: 'cover art, track listings' },
                  visual: { desc: 'image grid, portfolio', style: 'masonry gallery, exhibitions' },
                  writer: { desc: 'large type, long-form', style: 'serif headings, reading-optimized' },
                  performer: { desc: 'stage + event-oriented', style: 'credits, headshot, resume' },
                  filmmaker: { desc: 'video-forward, cinematic', style: 'video hero, film credits' },
                }[tp]
                return `<div class="template-card ${siteData.template === tp ? 'active' : ''}" data-template="${tp}">
                  <span class="template-card-name">${t('settings.template.' + tp)}</span>
                  <span class="template-card-desc">${info.desc}</span>
                  <span class="template-card-style">${info.style}</span>
                </div>`
              }).join('')
          }
        </div>
      </div>
      <div class="settings-field">
        <label class="settings-label">${t('settings.identity.domain')}</label>
        <div style="display:flex;align-items:center;gap:1ch">
          <span id="s-domain-current" style="font-size:0.95em;color:var(--fg)">${esc(siteData.domain || '')}</span>
          <button id="s-domain-change" class="buy-btn" style="font-size:0.75em;padding:0.2em 1ch">change domain</button>
        </div>
        <div id="s-domain-panel" style="display:none;margin-top:1em">
          <input type="text" id="s-domain-search" class="project-input" placeholder="search for a new domain...">
          <div id="s-domain-results" style="margin-top:0.5em;max-height:200px;overflow-y:auto"></div>
          <div id="s-domain-own" style="margin-top:0.75em">
            <label style="font-size:0.8em;color:var(--muted)">or enter your own domain</label>
            <div style="font-size:0.75em;color:var(--dim);margin:0.4em 0 0.6em;line-height:1.6;border:1px solid var(--border);padding:0.6em 1ch;background:rgba(255,255,255,0.02)">point DNS to our server first:<br><b>@</b> (root) → A record → <code style="user-select:all">5.161.199.120</code><br><b>www</b> → A record → <code style="user-select:all">5.161.199.120</code></div>
            <div style="display:flex;gap:0.5ch;margin-top:0.25em">
              <input type="text" id="s-domain-custom" class="project-input" placeholder="yourdomain.com" style="flex:1">
              <button id="s-domain-custom-btn" class="buy-btn" style="font-size:0.75em;padding:0.2em 1ch">use</button>
            </div>
          </div>
          <div id="s-domain-status" style="margin-top:0.5em;font-size:0.85em;color:var(--muted)"></div>
        </div>
      </div>
      <div id="s-org-section" style="margin-top:3em;padding-top:1.5em;border-top:1px solid var(--border)">
        <label class="settings-label">organization</label>
        <div id="s-org-content"><span class="praxis-loader"></span></div>
      </div>
      <div style="margin-top:3em;padding-top:1.5em;border-top:1px solid var(--border)">
        <label class="settings-label">${t('settings.wallet') || 'account'}</label>
        <div style="display:flex;flex-wrap:wrap;gap:0.75ch;margin-top:0.5em">
          <button id="settings-change-password" class="buy-btn" style="font-size:0.85em;padding:0.4em 1.5ch">change password</button>
          <button id="settings-export-key" class="buy-btn" style="font-size:0.85em;padding:0.4em 1.5ch">export private key</button>
        </div>
        <div style="font-size:0.75em;color:var(--dim);margin-top:0.5em;line-height:1.5">Use this to import your wallet into MetaMask, Rabby, or another wallet. <strong style="color:var(--red,#a44)">Anyone with this key can drain your funds. Never paste it into a website.</strong></div>
      </div>
      ${window.PublicKeyCredential ? `<div style="margin-top:3em;padding-top:1.5em;border-top:1px solid var(--border)">
        <label class="settings-label">security</label>
        <div id="settings-biometric-row">
          ${renderBiometricCard(!!localStorage.getItem('praxis-webauthn-cred'))}
        </div>
      </div>` : ''}
      <div style="margin-top:3em;padding-top:1.5em;border-top:1px solid var(--border)">
        <label class="settings-label">self-host</label>
        <p style="color:var(--dim);font-size:0.8em;margin:0.3em 0 0.75em">download your site as a standalone package. run it on your own server.</p>
        <button id="settings-export-site" class="buy-btn" style="font-size:0.85em;padding:0.4em 1.5ch">export site</button>
      </div>
      <div style="margin-top:3em;padding-top:1.5em;border-top:1px solid var(--border)">
        <label class="settings-label" style="color:#8b3a3a">${t('settings.dangerZone') || 'danger zone'}</label>
        <button id="settings-delete-account" style="background:none;border:1px solid #8b3a3a;color:#8b3a3a;font-family:inherit;font-size:0.85em;padding:0.4em 1.5ch;cursor:pointer;margin-top:0.5em">${t('wallet.unregister')}</button>
      </div>
    </div>
  `
  document.getElementById('settings-export-site')?.addEventListener('click', async () => {
    const btn = document.getElementById('settings-export-site')
    btn.disabled = true
    btn.textContent = 'preparing...'
    try {
      const addr = await window.ensureAuthorized?.()
      const res = await fetch('/api/export-site', { headers: { 'x-wallet': addr || '' } })
      if (!res.ok) throw new Error((await res.json()).error || 'export failed')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = res.headers.get('Content-Disposition')?.match(/filename="(.+)"/)?.[1] || 'praxis-site.tar.gz'
      a.click()
      URL.revokeObjectURL(url)
      btn.textContent = 'downloaded'
      setTimeout(() => { btn.textContent = 'export site'; btn.disabled = false }, 3000)
    } catch (e) {
      btn.textContent = e.message || 'failed'
      setTimeout(() => { btn.textContent = 'export site'; btn.disabled = false }, 3000)
    }
  })

  document.getElementById('settings-change-password')?.addEventListener('click', async () => {
    closeSettings()
    setTimeout(async () => { await window.showChangePasswordPrompt?.() }, 300)
  })
  document.getElementById('settings-export-key')?.addEventListener('click', async () => {
    // Custom modal: warn → password → reveal
    const overlay = document.createElement('div')
    overlay.className = 'praxis-modal-overlay'
    overlay.style.zIndex = '10010'
    const dialog = document.createElement('div')
    dialog.className = 'praxis-modal-dialog'
    dialog.style.maxWidth = '440px'
    dialog.innerHTML = `
      <h3 style="margin:0 0 0.6em;font-size:1em;color:var(--red,#a44)">⚠ Export private key</h3>
      <div style="font-size:0.85em;color:var(--fg);line-height:1.5;margin-bottom:0.8em">
        Your private key controls your wallet. <strong>Anyone who has it can drain your funds.</strong>
      </div>
      <ul style="font-size:0.8em;color:var(--muted);margin:0 0 1em 0;padding-left:1.2em;line-height:1.6">
        <li>Never paste it into a website or chat.</li>
        <li>Only use it to import into a trusted wallet app (MetaMask, Rabby, Frame).</li>
        <li>Wipe your clipboard after pasting.</li>
      </ul>
      <input type="password" id="export-pw" placeholder="enter your wallet password" style="width:100%;padding:0.6em;background:#0a0a0a;border:1px solid var(--border);color:var(--fg);font-family:inherit;font-size:0.9em;box-sizing:border-box;margin-bottom:0.8em">
      <div id="export-result" style="display:none;margin-bottom:0.8em">
        <div style="font-size:0.75em;color:var(--dim);margin-bottom:0.3em">your private key:</div>
        <textarea id="export-key-value" readonly style="width:100%;height:5em;padding:0.6em;background:#0a0a0a;border:1px solid var(--accent);color:var(--accent);font-family:monospace;font-size:0.75em;box-sizing:border-box;word-break:break-all;resize:none"></textarea>
        <button id="export-copy" class="buy-btn" style="font-size:0.8em;padding:0.4em 1ch;margin-top:0.4em;width:100%">copy to clipboard</button>
      </div>
      <div id="export-error" style="font-size:0.8em;color:var(--red,#a44);margin-bottom:0.6em;min-height:1em"></div>
      <div style="display:flex;gap:0.5em">
        <button id="export-reveal" class="buy-btn" style="flex:1;font-size:0.85em;padding:0.5em">reveal key</button>
        <button id="export-cancel" class="buy-btn" style="flex:1;font-size:0.85em;padding:0.5em;border-color:var(--dim);color:var(--dim)">close</button>
      </div>
    `
    overlay.appendChild(dialog)
    document.body.appendChild(overlay)
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
    const pwInput = dialog.querySelector('#export-pw')
    pwInput?.focus()
    dialog.querySelector('#export-cancel')?.addEventListener('click', () => overlay.remove())
    dialog.querySelector('#export-reveal')?.addEventListener('click', async () => {
      const pw = pwInput?.value || ''
      if (!pw) { dialog.querySelector('#export-error').textContent = 'enter your password'; return }
      try {
        const pk = await window.exportPrivateKey?.(pw)
        if (!pk) throw new Error('no private key returned')
        dialog.querySelector('#export-error').textContent = ''
        dialog.querySelector('#export-result').style.display = ''
        dialog.querySelector('#export-key-value').value = pk
        dialog.querySelector('#export-reveal').style.display = 'none'
        pwInput.style.display = 'none'
        // Auto-clear after 60s as a safety net
        setTimeout(() => overlay.remove(), 60000)
      } catch (e) {
        dialog.querySelector('#export-error').textContent = e?.message || 'failed to decrypt — wrong password?'
      }
    })
    dialog.addEventListener('click', async (e) => {
      if (e.target?.id === 'export-copy') {
        const v = dialog.querySelector('#export-key-value')?.value || ''
        try { await navigator.clipboard.writeText(v); e.target.textContent = 'copied ✓'; setTimeout(() => { e.target.textContent = 'copy to clipboard' }, 1500) }
        catch { e.target.textContent = 'copy failed' }
      }
    })
  })
  // Biometric card uses event delegation on the wrapper so the click handlers
  // survive a re-render of the inner HTML when toggling enable/disable.
  const bioRow = document.getElementById('settings-biometric-row')
  bioRow?.addEventListener('click', async (e) => {
    const t = e.target
    if (t?.id === 'settings-bio-enable') {
      const ok = await window.setupBiometric?.()
      if (ok) bioRow.innerHTML = renderBiometricCard(true)
    } else if (t?.id === 'settings-bio-disable') {
      localStorage.removeItem('praxis-webauthn-cred')
      bioRow.innerHTML = renderBiometricCard(false)
    }
  })
  document.getElementById('settings-delete-account')?.addEventListener('click', async () => {
    const addr = window.getWalletAddress?.()
    if (!addr) return
    // require wallet unlock or signature before showing danger zone dialog
    const authed = await window.ensureAuthorized?.()
    if (!authed) return
    closeSettings()
    setTimeout(() => window.showUnregisterConfirmation?.(addr), 300)
  })
  // domain change
  document.getElementById('s-domain-change')?.addEventListener('click', () => {
    const panel = document.getElementById('s-domain-panel')
    if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none'
  })

  // domain search (debounced)
  let domainSearchTimer
  document.getElementById('s-domain-search')?.addEventListener('input', (e) => {
    clearTimeout(domainSearchTimer)
    domainSearchTimer = setTimeout(() => searchDomains(e.target.value.trim()), 500)
  })

  async function searchDomains(query) {
    const resultsEl = document.getElementById('s-domain-results')
    if (!resultsEl || !query) { if (resultsEl) resultsEl.innerHTML = ''; return }
    resultsEl.innerHTML = '<span style="color:var(--muted);font-size:0.85em">searching...</span>'
    try {
      const res = await fetch(`/orchestrator/domains/search?handle=${encodeURIComponent(query)}`)
      const data = await res.json()
      // Orchestrator returns { domains: [{domain, available, premium, pricePerYear}], ethPrice }
      // Filter the same way landing.js does: available, non-premium, under $25/yr
      const MAX_DOMAIN_PRICE = 25
      const available = (data.domains || []).filter(x =>
        x.available && !x.premium && (!x.pricePerYear || x.pricePerYear <= MAX_DOMAIN_PRICE)
      )
      if (!available.length) { resultsEl.innerHTML = '<span style="color:var(--muted);font-size:0.85em">no domains available</span>'; return }
      // Sort cheapest first (matches landing.js sort behavior)
      available.sort((a, b) => (a.pricePerYear || 99) - (b.pricePerYear || 99))
      resultsEl.innerHTML = available.map(d => `
        <div class="domain-change-pick" data-domain="${esc(d.domain)}" data-purchase="1" style="display:flex;justify-content:space-between;align-items:center;padding:0.4em 0.5ch;border-bottom:1px solid var(--border);cursor:pointer;font-size:0.9em">
          <span>${esc(d.domain)}</span>
          <span style="color:var(--muted);font-size:0.85em">${d.pricePerYear ? '$' + esc(String(d.pricePerYear)) + ' / yr' : ''}</span>
        </div>
      `).join('')
      resultsEl.querySelectorAll('.domain-change-pick').forEach(el => {
        el.addEventListener('click', () => startDomainChange(el.dataset.domain, el.dataset.purchase === '1'))
      })
    } catch (e) {
      resultsEl.innerHTML = `<span style="color:#ef4444;font-size:0.85em">search failed: ${esc(e.message)}</span>`
    }
  }

  // custom domain
  document.getElementById('s-domain-custom-btn')?.addEventListener('click', () => {
    const input = document.getElementById('s-domain-custom')
    if (input?.value.trim()) startDomainChange(input.value.trim(), false)
  })

  async function startDomainChange(newDomain, purchase) {
    const statusEl = document.getElementById('s-domain-status')
    if (!statusEl) return
    const wallet = window.getWalletAddress?.()
    if (!wallet) { statusEl.textContent = 'connect wallet first'; return }

    statusEl.textContent = 'sign to confirm domain change...'
    try {
      const currentAccount = await window.authorizedSigner?.(wallet)
          const { createWalletClient, custom } = await import('./vendor.js')
      const { optimism } = await import('./vendor.js')
      const wc = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })

      // sign a message proving wallet ownership
      // H5: include timestamp + nonce in the signed payload so the server can
      // reject replayed signatures. Format must match the orchestrator check:
      //     domain-update:<wallet>:<newDomain>:<ts>:<nonce>
      const ts = Date.now()
      const nonce = (crypto.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36))
      const message = `domain-update:${wallet.toLowerCase()}:${newDomain}:${ts}:${nonce}`
      // Re-audit N1: 'domain-update:' is no longer in the provider's auto-allow
      // list (XSS regression fix). Set the one-shot bypass so the legitimate
      // settings flow — triggered by an explicit user button click with its own
      // status UI — still signs without an extra modal prompt. Uses the
      // function-style helper (N3) when available, with a legacy fallback.
      try {
        if (typeof window.suppressNextSignPrompt === 'function') window.suppressNextSignPrompt()
      } catch {}
      const signature = await wc.signMessage({ account: currentAccount, message })

      statusEl.textContent = purchase ? 'purchasing domain + updating...' : 'updating domain...'

      // call orchestrator
      const res = await fetch('/orchestrator/domain-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet, newDomain, purchaseDomain: purchase, signature, message }),
      })
      const data = await res.json()
      if (data.error) { statusEl.textContent = data.error; return }

      // call updateDomain on-chain with orchestrator signature
      statusEl.textContent = 'confirm on-chain update in wallet...'
      const { REGISTRY_ABI, getRegistryAddress } = await import('./contracts.js')
      const registryAddr = getRegistryAddress()
      const hash = await wc.writeContract({
        address: registryAddr,
        abi: REGISTRY_ABI,
        functionName: 'updateDomain',
        args: [newDomain, data.orchSignature],
        account: currentAccount,
      })

      statusEl.textContent = 'waiting for confirmation...'
      const { getPublicClient } = await import('./utils.js')
      const pc = await getPublicClient()
      await pc.waitForTransactionReceipt({ hash })

      // update local state
      siteData.domain = newDomain
      document.getElementById('s-domain-current').textContent = newDomain
      document.getElementById('s-domain-panel').style.display = 'none'
      statusEl.textContent = ''
      statusEl.style.color = 'var(--green)'
      statusEl.textContent = `domain updated to ${newDomain}`

      // save to server
      try { await api('/api/site', { method: 'PUT', body: JSON.stringify(siteData) }) } catch {}
    } catch (e) {
      statusEl.style.color = '#ef4444'
      statusEl.textContent = e.code === 4001 ? 'cancelled' : `error: ${(e.shortMessage || e.message || '').slice(0, 80)}`
    }
  }

  // template card selection
  const tplInput = document.getElementById('s-template')
  el.querySelectorAll('.template-card').forEach(card => {
    card.addEventListener('click', () => {
      el.querySelectorAll('.template-card').forEach(c => c.classList.remove('active'))
      card.classList.add('active')
      if (card.dataset.orgType) {
        siteData.orgType = card.dataset.orgType
      } else if (tplInput) {
        tplInput.value = card.dataset.template
      }
      tplInput?.dispatchEvent(new Event('change', { bubbles: true }))
    })
  })

  // profile picture upload — downsize client-side before upload. A profile
  // pic only ever renders at 64-256px on screen, so uploading a 6MB raw
  // camera JPEG is wasted bandwidth (and on flaky home networks a big
  // burst is exactly what triggers a mid-upload connection reset).
  const pfpBtn = document.getElementById('s-pfp-upload')
  if (pfpBtn) {
    pfpBtn.addEventListener('click', () => uploadFile(pfpBtn, (url) => {
      siteData.profilePic = url
      const preview = document.getElementById('s-pfp-preview')
      if (preview) preview.innerHTML = `<img src="${escapeHtml(url)}" style="width:100%;height:100%;object-fit:cover">`
      saveSettings()
    }, 'image/*', { transformFile: (f) => resizeImageFile(f, 512, 0.88) }))
  }
  const pfpRemoveBtn = document.getElementById('s-pfp-remove')
  if (pfpRemoveBtn) {
    pfpRemoveBtn.addEventListener('click', () => {
      delete siteData.profilePic
      const preview = document.getElementById('s-pfp-preview')
      if (preview) preview.innerHTML = '<span style="font-size:0.7em;color:var(--dim)">none</span>'
      pfpRemoveBtn.remove()
      saveSettings()
    })
  }

  // Site logo upload — wide horizontal wordmark that replaces the plain
  // domain text in every page's top-left. Downsized to 400px wide so
  // the 200px display slot has 2x for retina without wasting bandwidth.
  // Aspect ratio preserved; SVG files pass through untouched by
  // resizeImageFile.
  const logoBtn = document.getElementById('s-logo-upload')
  if (logoBtn) {
    logoBtn.addEventListener('click', () => uploadFile(logoBtn, (url) => {
      siteData.logo = url
      const preview = document.getElementById('s-logo-preview')
      if (preview) preview.innerHTML = `<img src="${escapeHtml(url)}" style="max-height:100%;max-width:100%;object-fit:contain">`
      saveSettings()
      renderIdentityTab(el)
    }, 'image/*', { transformFile: (f) => resizeImageFile(f, 400, 0.9) }))
  }
  const logoRemoveBtn = document.getElementById('s-logo-remove')
  if (logoRemoveBtn) {
    logoRemoveBtn.addEventListener('click', () => {
      delete siteData.logo
      const preview = document.getElementById('s-logo-preview')
      if (preview) preview.innerHTML = `<span style="font-size:0.7em;color:var(--dim)">${escapeHtml(siteData.domain || 'domain')}</span>`
      logoRemoveBtn.remove()
      saveSettings()
    })
  }

  // short bio character counter
  const shortBioEl = document.getElementById('s-short-bio')
  const shortBioCount = document.getElementById('s-short-bio-count')
  if (shortBioEl && shortBioCount) {
    shortBioEl.addEventListener('input', () => {
      const n = shortBioEl.value.length
      shortBioCount.textContent = `${n}/140`
      shortBioCount.style.color = n > 120 ? '#da3' : 'var(--dim)'
    })
  }

  // --- Organization section ---
  loadOrgSection()
}

async function loadOrgSection() {
  const orgContent = document.getElementById('s-org-content')
  if (!orgContent) return
  const addr = window.getWalletAddress?.()
  if (!addr) {
    orgContent.innerHTML = '<p style="color:var(--dim);font-size:0.85em">connect wallet to manage organizations</p>'
    return
  }

  try {
    const [memberRes, inviteRes] = await Promise.all([
      fetch(`/api/orgs/by-member/${addr}`),
      fetch(`/api/orgs/invites/${addr}`),
    ])
    const data = await memberRes.json()
    const inviteData = await inviteRes.json().catch(() => ({ invites: [] }))
    const orgs = data.orgs || []
    const pendingInvites = (inviteData.invites || []).filter(i => i.status === 'pending')
    const esc = escapeHtml
    const siteFlaggedAsOrg = siteData?.template === 'organization'
    const siteDomain = (siteData?.domain || location.hostname || '').toLowerCase()
    // If the current site is claimed as an org locally, prefer the on-chain
    // record whose domain matches THIS site. That way settings inline the
    // roster/invite UI for the right org even if the admin owns several.
    const siteOrg = orgs.find(o => (o.domain || '').toLowerCase() === siteDomain)
    const otherOrgs = orgs.filter(o => o !== siteOrg)

    let html = ''

    // Pending invites
    if (pendingInvites.length) {
      html += `<div style="margin-bottom:1.5em">
        <p style="font-size:0.85em;color:var(--accent);margin-bottom:0.5em">${pendingInvites.length} pending invite${pendingInvites.length > 1 ? 's' : ''}</p>
        ${pendingInvites.map(inv => `
          <div class="org-invite-row" style="display:flex;justify-content:space-between;align-items:center;padding:0.5em 0;border-bottom:1px solid var(--border)" data-org-id="${esc(String(inv.orgId))}">
            <span style="font-size:0.9em">${esc(inv.orgName || `org #${inv.orgId}`)}</span>
            <span style="display:flex;gap:0.5em">
              <button class="buy-btn org-accept-btn" style="font-size:0.8em;padding:0.3em 1ch" data-org-id="${esc(String(inv.orgId))}">accept</button>
              <button class="buy-btn org-decline-btn" style="font-size:0.8em;padding:0.3em 1ch;border-color:var(--dim);color:var(--dim)" data-org-id="${esc(String(inv.orgId))}">decline</button>
            </span>
          </div>
        `).join('')}
      </div>`
    }

    // Case 1 — this site is flagged as an org locally but there is NO
    // matching on-chain org for it. Usually a past contract redeploy
    // cleared the previous org record. Route through the same
    // Safe-based create flow — deploys a Safe as admin from scratch.
    if (siteFlaggedAsOrg && !siteOrg) {
      html += `<div style="border:1px solid var(--border);padding:1em;margin-bottom:1em">
        <p style="font-size:0.9em;color:var(--fg);margin:0 0 0.5em">this site doesn't have a shared account yet.</p>
        <p style="font-size:0.8em;color:var(--muted);margin:0 0 0.75em;line-height:1.5">set one up so the org can post, collect, and hold funds as a group. you'll be the sole owner to start — add collaborators any time.</p>
        <button id="s-org-create" class="buy-btn" style="font-size:0.85em;padding:0.4em 1.5ch">set up shared account</button>
      </div>`
    }

    // Case 2 — the site IS an org and we found the matching on-chain record.
    // Render inline: name/admin/member list + admin actions if this wallet
    // is the admin. Avoids a hidden trip to /org?id=X to invite members.
    if (siteOrg) {
      const isAdminHere = siteOrg.admin?.toLowerCase() === addr.toLowerCase()
      html += await _renderInlineOrgAdmin(siteOrg, isAdminHere, esc)
    }

    // Case 3 — other orgs the wallet belongs to that aren't this site.
    if (otherOrgs.length) {
      html += `<div style="margin-bottom:1em;margin-top:${(siteOrg || siteFlaggedAsOrg) ? '1.5em' : '0'}">
        <p style="font-size:0.75em;color:var(--muted);margin:0 0 0.5em;text-transform:uppercase;letter-spacing:0.05em">other organizations</p>
        ${otherOrgs.map(o => {
          const isAdminHere = o.admin?.toLowerCase() === addr.toLowerCase()
          const roleTag = isAdminHere
            ? '<span style="font-size:0.7em;color:var(--dim);border:1px solid var(--border);padding:0.1em 0.5ch;border-radius:3px">admin</span>'
            : '<span style="font-size:0.7em;color:var(--dim)">member</span>'
          // When admin + on-chain org has no domain yet → surface the
          // "attach a site" affordance right here. Skips createOrg
          // entirely — one row on the ledger, one site to sign in to.
          const hasSite = !!(o.domain && o.domain.trim())
          const attachBtn = (isAdminHere && !hasSite)
            ? `<button class="buy-btn org-attach-site" data-org-id="${esc(String(o.id))}" data-org-name="${esc(o.name)}" style="font-size:0.75em;padding:0.2em 1ch">attach a site</button>`
            : ''
          // "upgrade to shared org (Safe)" — offered when the wallet is
          // admin AND the org is still owned by an EOA (not yet a Safe).
          // isSafe check happens client-side in the click handler; here
          // we always render the button for admins and hide it live if
          // it's already a Safe.
          const isEoaAdmin = isAdminHere && /^0x[0-9a-fA-F]{40}$/.test(o.admin) && !o.admin?.startsWith('0x0000')
          const upgradeBtn = isEoaAdmin
            ? `<button class="buy-btn org-upgrade-safe" data-org-id="${esc(String(o.id))}" data-org-name="${esc(o.name)}" data-org-domain="${esc(o.domain || '')}" style="font-size:0.75em;padding:0.2em 1ch;border-color:var(--dim);color:var(--dim)" title="turn this into a shared account so the org has its own posts, notifications, and treasury — separate from your personal account. you can add co-owners later.">make it shared</button>`
            : ''
          const actionLabel = hasSite
            ? `<a href="https://${esc(o.domain)}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none;font-size:0.85em">${esc(o.domain)} →</a>`
            : `<a href="/org?id=${esc(String(o.id))}" style="color:var(--accent);text-decoration:none;font-size:0.85em">${isAdminHere ? 'manage' : 'view'} →</a>`
          return `<div style="display:flex;justify-content:space-between;align-items:center;padding:0.5em 0;border-bottom:1px solid var(--border);gap:0.75em">
            <a href="/org?id=${esc(String(o.id))}" style="color:var(--fg);text-decoration:none;font-size:0.95em;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(o.name)}</a>
            <span style="display:flex;align-items:center;gap:0.75em;flex-shrink:0">
              ${roleTag}
              ${attachBtn}
              ${upgradeBtn}
              ${actionLabel}
            </span>
          </div>`
        }).join('')}
      </div>`
    }

    // Case 4 — no org yet. Offer to create one (Safe-based, own domain).
    // Convert-this-artist-site-to-org used to live here; removed
    // because Safe-based orgs have their own on-chain identity + Safe
    // signers — pretending an artist's EOA is now "an org" was the
    // fake-shared-account pattern Miles flagged.
    if (!siteOrg && !siteFlaggedAsOrg && !otherOrgs.length) {
      html += `
        <p style="color:var(--dim);font-size:0.85em;margin-bottom:0.75em">you are not a member of any organization</p>
        <button id="s-org-create" class="buy-btn" style="font-size:0.85em;padding:0.4em 1.5ch">create an organization</button>`
    } else if (!siteOrg && !siteFlaggedAsOrg && otherOrgs.length) {
      html += `<button id="s-org-create" class="buy-btn" style="font-size:0.85em;padding:0.4em 1.5ch;margin-top:0.75em">create another organization</button>`
    } else if (siteOrg && !otherOrgs.length) {
      html += `<button id="s-org-create" class="buy-btn" style="font-size:0.85em;padding:0.4em 1.5ch;margin-top:1em;border-color:var(--dim);color:var(--dim)">create another organization</button>`
    }

    orgContent.innerHTML = html

    // Wire accept/decline buttons
    orgContent.querySelectorAll('.org-accept-btn').forEach(btn => {
      btn.addEventListener('click', () => handleOrgInvite(btn, 'acceptInvite', btn.dataset.orgId))
    })
    orgContent.querySelectorAll('.org-decline-btn').forEach(btn => {
      btn.addEventListener('click', () => handleOrgInvite(btn, 'declineInvite', btn.dataset.orgId))
    })

    document.getElementById('s-org-create')?.addEventListener('click', showCreateOrgModal)
    orgContent.querySelectorAll('.org-attach-site').forEach(btn => {
      btn.addEventListener('click', () => {
        const org = orgs.find(o => String(o.id) === btn.dataset.orgId)
        if (org) showAttachOrgSiteModal(org)
      })
    })
    orgContent.querySelectorAll('.org-upgrade-safe').forEach(btn => {
      btn.addEventListener('click', () => showUpgradeToSafeModal({
        orgId: btn.dataset.orgId,
        orgName: btn.dataset.orgName,
        orgDomain: btn.dataset.orgDomain,
      }))
    })

    if (siteOrg) {
      _wireInlineOrgAdmin(siteOrg, addr)
      _wireOrgSafePanel(siteOrg)
    }
  } catch {
    orgContent.innerHTML = '<p style="color:var(--dim);font-size:0.85em">failed to load organizations</p>'
  }
}

async function handleOrgInvite(btn, fnName, orgId) {
  const row = btn.closest('.org-invite-row')
  try {
    btn.textContent = '...'
    if (!await window.ensureOptimism?.()) { btn.textContent = fnName === 'acceptInvite' ? 'accept' : 'decline'; return }
    const { createWalletClient, custom, optimism } = await import('./vendor.js')
    const { ORG_ADDRESS, ORG_ABI } = await import('./contracts.js')
    const addr = window.getWalletAddress?.()
    const wc = createWalletClient({ chain: optimism, transport: custom(window.getWalletProvider()) })
    const hash = await wc.writeContract({
      address: ORG_ADDRESS,
      abi: ORG_ABI,
      functionName: fnName,
      args: [BigInt(orgId)],
      account: window.getEmbeddedAccount?.() || addr,
    })
    const { getPublicClient } = await import('./utils.js')
    const pc = await getPublicClient()
    await pc.waitForTransactionReceipt({ hash })
    if (row) row.remove()
    if (fnName === 'acceptInvite') setTimeout(() => loadOrgSection(), 1000)
  } catch (e) {
    btn.textContent = fnName === 'acceptInvite' ? 'accept' : 'decline'
    if (e.code !== 4001) btn.textContent = 'failed'
  }
}

// Inline org admin card for settings — deliberately compact. Full roster,
// remove-member, and dissolve stay at /org?id=X to avoid duplicating that
// UX here. Fetches full org detail (members + metadata) via /api/org/:id
// so we can show a real count and offer a quick invite-by-domain/wallet
// with typeahead + a pending-invite list (with revoke) so an admin can
// see and manage outgoing invites without leaving settings.
async function _renderInlineOrgAdmin(siteOrg, isAdmin, esc) {
  const orgId = String(siteOrg.id)
  let detail = null
  try {
    const r = await fetch(`/api/org/${encodeURIComponent(orgId)}`)
    detail = await r.json()
  } catch {}
  const members = detail?.members || []
  // The admin is auto-added to _members on createOrg, but they're already
  // shown as "admin" — counting them again as a member reads as double.
  // Subtract them so "you are the admin" doesn't come with "2 members"
  // when the admin is actually the only wallet on the org.
  const adminAddr = String(siteOrg.admin || '').toLowerCase()
  const otherMembers = members.filter(m => String(m.wallet || m).toLowerCase() !== adminAddr)
  const memberCount = otherMembers.length
  const roleTag = isAdmin
    ? '<span style="font-size:0.7em;color:var(--dim);border:1px solid var(--border);padding:0.1em 0.5ch;border-radius:3px">admin</span>'
    : '<span style="font-size:0.7em;color:var(--dim)">member</span>'

  // The invite input has a relative wrapper so the absolute suggestion
  // dropdown anchors to it (matches the /org page's invite affordance).
  // A separate `s-org-pending-list` panel is populated once
  // _wireInlineOrgAdmin fetches the outgoing pending invites for this org.
  const inviteBlock = isAdmin ? `
    <div id="s-org-pending" style="margin-top:1em;display:none">
      <p style="font-size:0.75em;color:var(--muted);margin:0 0 0.4em;text-transform:uppercase;letter-spacing:0.05em">pending invites</p>
      <div id="s-org-pending-list"></div>
    </div>
    <div style="margin-top:1em">
      <p style="font-size:0.75em;color:var(--muted);margin:0 0 0.4em;text-transform:uppercase;letter-spacing:0.05em">invite an artist</p>
      <div style="display:flex;gap:0.5em;align-items:flex-start">
        <div style="position:relative;flex:1">
          <input type="text" id="s-org-invite-input" class="project-input" placeholder="domain (e.g. milesxb.bio) or 0x wallet" autocomplete="off" style="width:100%;box-sizing:border-box;font-size:0.85em">
          <div id="s-org-invite-suggest" style="display:none;position:absolute;top:100%;left:0;right:0;background:var(--bg,#0a0a0a);border:1px solid var(--border);border-top:none;max-height:200px;overflow-y:auto;z-index:10"></div>
        </div>
        <button id="s-org-invite-btn" class="buy-btn" style="font-size:0.85em;padding:0.4em 1.5ch;white-space:nowrap">invite</button>
      </div>
      <p id="s-org-invite-status" style="font-size:0.8em;color:var(--muted);min-height:1em;margin:0.4em 0 0"></p>
      <p style="font-size:0.75em;color:var(--dim);margin:0.3em 0 0;line-height:1.5">the artist has to accept from their own site's settings before they show up as a member.</p>
    </div>
  ` : ''

  // Shared-account panel. When the org's admin is a Safe (contract
  // address) the org has its own on-Ethereum identity — purchases and
  // credential sales pay into the Safe, not into any personal wallet.
  // Show current balance + affordances for the viewer to claim + send
  // from the Safe, gated by isOwner() on the Safe itself so
  // non-signers only see the balance.
  const safePanel = await _renderOrgSafePanel(siteOrg).catch(() => '')

  return `<div style="border:1px solid var(--border);padding:1em;margin-bottom:1em">
    <div style="display:flex;justify-content:space-between;align-items:baseline;gap:0.5em;margin-bottom:0.4em">
      <a href="/org?id=${esc(orgId)}" style="color:var(--accent);text-decoration:none;font-size:1em;font-weight:500">${esc(siteOrg.name)}</a>
      ${roleTag}
    </div>
    <p style="font-size:0.8em;color:var(--muted);margin:0 0 0.5em">${memberCount} member${memberCount === 1 ? '' : 's'}${isAdmin ? ' · you are the admin' : ''}</p>
    <a href="/org?id=${esc(orgId)}" style="color:var(--muted);font-size:0.85em">manage organization →</a>
    ${safePanel}
    ${inviteBlock}
  </div>`
}

// Render the shared-account (Safe) funds panel for `siteOrg`. Only
// appears when siteOrg.admin is a Safe (contract with code) — a plain
// EOA-admined org doesn't need it. Signers see claim + send buttons;
// non-signers see only the balance. Returns '' if the panel shouldn't
// render (EOA admin, wallet not connected, read errors).
async function _renderOrgSafePanel(siteOrg) {
  const admin = String(siteOrg?.admin || '').trim()
  if (!/^0x[0-9a-fA-F]{40}$/.test(admin)) return ''
  const viewer = window.getWalletAddress?.()
  if (!viewer) return ''
  try {
    const [{ isSafeAddress, isSafeSigner, getSafeBalance, getSafePendingWithdrawal }, { PRAXIS_ADDR, getMediaAddress }, { getEthPrices, formatPriceFiatPrimary }] = await Promise.all([
      import('./safe-org.js'),
      import('./contracts.js'),
      import('./fiat.js'),
    ])
    if (!await isSafeAddress(admin)) return ''
    const { getSafeOwners, getSafeThreshold } = await import('./safe-org.js')
    const [amSigner, safeBal, pendingPraxis, pendingMedia, prices, owners, threshold] = await Promise.all([
      isSafeSigner(admin, viewer),
      getSafeBalance(admin),
      getSafePendingWithdrawal(admin, PRAXIS_ADDR),
      getMediaAddress() ? getSafePendingWithdrawal(admin, getMediaAddress()) : Promise.resolve(0n),
      getEthPrices().catch(() => null),
      getSafeOwners(admin),
      getSafeThreshold(admin),
    ])
    const totalPending = (pendingPraxis || 0n) + (pendingMedia || 0n)
    const bal = formatPriceFiatPrimary(safeBal, prices)
    const claimRow = totalPending > 0n
      ? `<div style="margin-top:0.6em;display:flex;justify-content:space-between;align-items:baseline;gap:0.5em">
          <span style="font-size:0.8em;color:var(--muted)">pending earnings</span>
          <span style="font-size:0.85em">${formatPriceFiatPrimary(totalPending, prices)}</span>
        </div>`
      : ''
    const actionRow = amSigner ? `
      <div style="margin-top:0.7em;display:flex;gap:0.5em;flex-wrap:wrap">
        ${totalPending > 0n ? `<button class="buy-btn" data-org-safe-action="claim" data-safe="${admin}" style="font-size:0.8em;padding:0.3em 1ch">claim earnings</button>` : ''}
        ${safeBal > 0n ? `<button class="buy-btn" data-org-safe-action="send" data-safe="${admin}" style="font-size:0.8em;padding:0.3em 1ch;border-color:var(--dim);color:var(--dim)">send</button>` : ''}
      </div>
      <p data-org-safe-status style="font-size:0.75em;color:var(--muted);min-height:1em;margin:0.4em 0 0"></p>
    ` : `<p style="font-size:0.75em;color:var(--dim);margin:0.5em 0 0">only signers can move funds from this account</p>`
    // Signer list + threshold controls. Every signer sees the roster
    // (so it's transparent who has spending authority); only signers
    // can add/remove others or change the threshold. On a 1-of-1 Safe
    // the "co-owners" section reads as "you are the sole owner" until
    // a second signer is added.
    const signersPanel = amSigner ? _renderSignersPanel({ owners, threshold, viewer, admin }) : ''

    return `
      <div style="margin-top:1em;padding-top:0.75em;border-top:1px dashed var(--border)">
        <p style="font-size:0.75em;color:var(--muted);margin:0 0 0.5em;text-transform:uppercase;letter-spacing:0.05em">shared account</p>
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:0.5em">
          <span style="font-size:0.85em;color:var(--fg)">balance</span>
          <span style="font-size:0.95em">${bal}</span>
        </div>
        ${claimRow}
        ${actionRow}
        ${signersPanel}
      </div>
    `
  } catch { return '' }
}

// Co-owners + threshold sub-panel. Rendered under the shared-account
// panel when the viewer is a Safe signer. Shows current owners with
// remove buttons (except self on a 1-of-1 — you can't lock yourself
// out), the threshold ("N of M"), and an "add co-owner" form.
function _renderSignersPanel({ owners, threshold, viewer, admin }) {
  const esc = escapeHtml
  const rows = (owners || []).map(o => {
    const isMe = String(o).toLowerCase() === String(viewer).toLowerCase()
    const short = `${o.slice(0, 6)}…${o.slice(-4)}`
    const canRemove = owners.length > 1 && !(isMe && owners.length === 1)
    const removeBtn = canRemove
      ? `<button class="buy-btn" data-org-signer-action="remove" data-signer="${esc(o)}" data-safe="${esc(admin)}" style="font-size:0.7em;padding:0.15em 0.9ch;border-color:var(--dim);color:var(--dim)">remove</button>`
      : ''
    const meTag = isMe ? '<span style="font-size:0.7em;color:var(--dim)">you</span>' : ''
    return `<div style="display:flex;justify-content:space-between;align-items:center;gap:0.5em;padding:0.35em 0;border-bottom:1px solid color-mix(in srgb, var(--fg) 5%, transparent)">
      <span style="font-family:'SF Mono',monospace;font-size:0.8em;color:var(--fg)">${esc(short)}</span>
      <span style="display:flex;align-items:center;gap:0.75ch">${meTag}${removeBtn}</span>
    </div>`
  }).join('')

  // Threshold slider bounds: 1 to owner count. Disabled if only one
  // owner (only meaningful value is 1).
  const maxThresh = owners.length
  const threshLine = maxThresh > 1
    ? `<div style="display:flex;justify-content:space-between;align-items:center;gap:0.5em;margin-top:0.75em">
        <label style="font-size:0.8em;color:var(--muted)">signatures required</label>
        <span style="display:flex;align-items:center;gap:0.5ch">
          <input type="number" id="s-org-threshold" data-safe="${esc(admin)}" min="1" max="${maxThresh}" value="${threshold}" style="width:4ch;font-size:0.85em;padding:0.15em 0.4ch;background:transparent;border:1px solid var(--border);color:var(--fg);text-align:center">
          <span style="font-size:0.8em;color:var(--dim)">of ${maxThresh}</span>
          <button class="buy-btn" data-org-signer-action="threshold" data-safe="${esc(admin)}" style="font-size:0.7em;padding:0.15em 0.9ch">save</button>
        </span>
      </div>`
    : `<p style="font-size:0.75em;color:var(--dim);margin:0.6em 0 0">any single signature moves funds. add a co-owner to require more.</p>`

  return `
    <div style="margin-top:1em;padding-top:0.75em;border-top:1px dashed var(--border)">
      <p style="font-size:0.75em;color:var(--muted);margin:0 0 0.5em;text-transform:uppercase;letter-spacing:0.05em">co-owners</p>
      ${rows}
      ${threshLine}
      <div style="margin-top:0.75em">
        <label style="font-size:0.75em;color:var(--muted);display:block;margin-bottom:0.25em">add co-owner</label>
        <div style="display:flex;gap:0.5ch;align-items:center">
          <input type="text" id="s-org-add-signer" data-safe="${esc(admin)}" class="project-input" placeholder="0x…" style="flex:1;font-size:0.85em;font-family:'SF Mono',monospace" autocomplete="off">
          <button class="buy-btn" data-org-signer-action="add" data-safe="${esc(admin)}" style="font-size:0.75em;padding:0.25em 1ch">add</button>
        </div>
      </div>
      <p data-org-signer-status style="font-size:0.75em;color:var(--muted);min-height:1em;margin:0.5em 0 0"></p>
      <p style="font-size:0.7em;color:var(--dim);margin:0.3em 0 0;line-height:1.5">changes take effect after your wallet confirms. on a Safe requiring more than one signature, other co-owners will need to co-sign before the change goes live.</p>
    </div>
  `
}

// Wire the shared-account panel actions once markup is in DOM. Idempotent
// so re-renders don't double-bind. Runs after loadOrgSection injects the
// panel via _renderInlineOrgAdmin.
function _wireOrgSafePanel(siteOrg) {
  const container = document.getElementById('s-org-content')
  if (!container) return
  const buttons = container.querySelectorAll('[data-org-safe-action]')
  buttons.forEach(btn => {
    if (btn.dataset.wired === '1') return
    btn.dataset.wired = '1'
    btn.addEventListener('click', async () => {
      const action = btn.dataset.orgSafeAction
      const safeAddress = btn.dataset.safe
      const statusEl = container.querySelector('[data-org-safe-status]')
      if (!safeAddress) return
      if (action === 'claim') {
        await _handleOrgSafeClaim(safeAddress, statusEl, btn)
      } else if (action === 'send') {
        await _showOrgSafeSendModal(safeAddress)
      }
    })
  })

  // Signer management buttons — add / remove / threshold. Each button
  // wraps a Safe.execTransaction targeting the Safe itself; on 1-of-1
  // Safes the caller's pre-approved signature is enough, on multi-sig
  // the tx queues as pending for other owners to co-sign (that flow
  // requires the Safe UI at safe.global today).
  const signerButtons = container.querySelectorAll('[data-org-signer-action]')
  signerButtons.forEach(btn => {
    if (btn.dataset.wired === '1') return
    btn.dataset.wired = '1'
    btn.addEventListener('click', async () => {
      const action = btn.dataset.orgSignerAction
      const safeAddress = btn.dataset.safe
      const signer = btn.dataset.signer || ''
      const statusEl = container.querySelector('[data-org-signer-status]')
      if (!safeAddress) return
      if (action === 'add') await _handleOrgSignerAdd(safeAddress, statusEl, btn, container)
      else if (action === 'remove') await _handleOrgSignerRemove(safeAddress, signer, statusEl, btn)
      else if (action === 'threshold') await _handleOrgSignerThreshold(safeAddress, statusEl, btn, container)
    })
  })
}

async function _handleOrgSignerAdd(safeAddress, statusEl, btn, container) {
  const setStatus = (msg, color) => { if (statusEl) { statusEl.style.color = color || 'var(--muted)'; statusEl.textContent = msg } }
  const input = container.querySelector('#s-org-add-signer')
  const newSigner = String(input?.value || '').trim()
  if (!/^0x[0-9a-fA-F]{40}$/.test(newSigner)) { setStatus('enter a valid 0x address', 'var(--dim)'); return }
  btn.disabled = true
  setStatus('confirm in wallet…')
  try {
    const { safeAddSigner, getSafeOwners, getSafeThreshold } = await import('./safe-org.js')
    const owners = await getSafeOwners(safeAddress)
    if (owners.some(o => o.toLowerCase() === newSigner.toLowerCase())) {
      setStatus('already a co-owner', 'var(--dim)')
      btn.disabled = false
      return
    }
    // Keep existing threshold — user changes it separately with the
    // slider. Safe requires threshold <= new owner count; adding an
    // owner grows the count so any current threshold stays valid.
    const threshold = await getSafeThreshold(safeAddress)
    await safeAddSigner({ safeAddress, newSigner, threshold })
    setStatus('added ✓', 'var(--green)')
    if (input) input.value = ''
    setTimeout(() => loadOrgSection(), 1200)
  } catch (e) {
    setStatus(e.code === 4001 ? 'cancelled' : (e.shortMessage || e.message || 'add failed').slice(0, 140), 'var(--dim)')
    btn.disabled = false
  }
}

async function _handleOrgSignerRemove(safeAddress, signerToRemove, statusEl, btn) {
  const setStatus = (msg, color) => { if (statusEl) { statusEl.style.color = color || 'var(--muted)'; statusEl.textContent = msg } }
  if (!/^0x[0-9a-fA-F]{40}$/.test(signerToRemove)) return
  if (!confirm(`Remove ${signerToRemove.slice(0, 6)}… as a co-owner? They will lose all access to this shared account.`)) return
  btn.disabled = true
  setStatus('confirm in wallet…')
  try {
    const { safeRemoveSigner, getSafeOwners, getSafeThreshold } = await import('./safe-org.js')
    const owners = await getSafeOwners(safeAddress)
    // If threshold would exceed remaining owners (e.g. 2-of-2 → remove 1
    // → 2-of-1 is impossible) drop threshold to remaining count. Safe
    // reverts otherwise.
    const currentThresh = await getSafeThreshold(safeAddress)
    const newOwnerCount = owners.length - 1
    const newThresh = Math.min(currentThresh, Math.max(1, newOwnerCount))
    await safeRemoveSigner({ safeAddress, signerToRemove, threshold: newThresh })
    setStatus('removed ✓', 'var(--green)')
    setTimeout(() => loadOrgSection(), 1200)
  } catch (e) {
    setStatus(e.code === 4001 ? 'cancelled' : (e.shortMessage || e.message || 'remove failed').slice(0, 140), 'var(--dim)')
    btn.disabled = false
  }
}

async function _handleOrgSignerThreshold(safeAddress, statusEl, btn, container) {
  const setStatus = (msg, color) => { if (statusEl) { statusEl.style.color = color || 'var(--muted)'; statusEl.textContent = msg } }
  const input = container.querySelector('#s-org-threshold')
  const value = Number(input?.value || 0)
  if (!Number.isInteger(value) || value < 1) { setStatus('threshold must be at least 1', 'var(--dim)'); return }
  btn.disabled = true
  setStatus('confirm in wallet…')
  try {
    const { safeChangeThreshold, getSafeOwners, getSafeThreshold } = await import('./safe-org.js')
    const [owners, current] = await Promise.all([getSafeOwners(safeAddress), getSafeThreshold(safeAddress)])
    if (value > owners.length) { setStatus(`can't require more signatures than co-owners (${owners.length})`, 'var(--dim)'); btn.disabled = false; return }
    if (value === current) { setStatus('no change', 'var(--dim)'); btn.disabled = false; return }
    await safeChangeThreshold({ safeAddress, threshold: value })
    setStatus('threshold updated ✓', 'var(--green)')
    setTimeout(() => loadOrgSection(), 1200)
  } catch (e) {
    setStatus(e.code === 4001 ? 'cancelled' : (e.shortMessage || e.message || 'update failed').slice(0, 140), 'var(--dim)')
    btn.disabled = false
  }
}

async function _handleOrgSafeClaim(safeAddress, statusEl, btn) {
  const setStatus = (msg, color) => { if (statusEl) { statusEl.style.color = color || 'var(--muted)'; statusEl.textContent = msg } }
  btn.disabled = true
  try {
    const [{ safeClaimFrom, getSafePendingWithdrawal }, { PRAXIS_ADDR, getMediaAddress }] = await Promise.all([
      import('./safe-org.js'),
      import('./contracts.js'),
    ])
    const mediaAddr = getMediaAddress()
    const [praxisPending, mediaPending] = await Promise.all([
      getSafePendingWithdrawal(safeAddress, PRAXIS_ADDR),
      mediaAddr ? getSafePendingWithdrawal(safeAddress, mediaAddr) : Promise.resolve(0n),
    ])
    if (praxisPending > 0n) {
      setStatus('claiming from Praxis…')
      await safeClaimFrom({ safeAddress, target: PRAXIS_ADDR, functionName: 'claimFunds' })
    }
    if (mediaPending > 0n && mediaAddr) {
      setStatus('claiming from media sales…')
      await safeClaimFrom({ safeAddress, target: mediaAddr, functionName: 'withdraw' })
    }
    setStatus('done', 'var(--green)')
    setTimeout(() => loadOrgSection(), 1200)
  } catch (e) {
    setStatus(e.code === 4001 ? 'cancelled' : (e.shortMessage || e.message || 'claim failed').slice(0, 120), 'var(--dim)')
    btn.disabled = false
  }
}

async function _showOrgSafeSendModal(safeAddress) {
  const overlay = document.createElement('div')
  overlay.className = 'praxis-modal-overlay'
  overlay.style.zIndex = '10015'
  const dialog = document.createElement('div')
  dialog.className = 'praxis-modal-dialog'
  dialog.style.maxWidth = '440px'

  let bal = 0n
  let prices = null
  try {
    const [{ getSafeBalance }, { getEthPrices }] = await Promise.all([
      import('./safe-org.js'),
      import('./fiat.js'),
    ])
    ;[bal, prices] = await Promise.all([getSafeBalance(safeAddress), getEthPrices().catch(() => null)])
  } catch {}
  const balEth = Number(bal) / 1e18

  dialog.innerHTML = `
    <h3 style="margin:0 0 0.5em;font-size:1.05em">send from shared account</h3>
    <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em;line-height:1.5">Move ETH out of the org's account. You'll confirm from your personal wallet — the org's account moves the funds because you're a signer.</p>
    <label style="font-size:0.75em;color:var(--muted)">to</label>
    <input id="org-safe-send-to" type="text" placeholder="0x…" class="project-input" style="width:100%;box-sizing:border-box;margin:0.2em 0 0.75em">
    <div style="display:flex;justify-content:space-between;align-items:baseline;gap:0.5em;margin-bottom:0.2em">
      <label style="font-size:0.75em;color:var(--muted)">amount (ETH)</label>
      <span style="font-size:0.75em;color:var(--dim)">available: ${balEth.toFixed(6)} ETH</span>
    </div>
    <input id="org-safe-send-amt" type="text" inputmode="decimal" placeholder="0.001" class="project-input" style="width:100%;box-sizing:border-box;margin:0.2em 0 0.75em">
    <p id="org-safe-send-status" style="color:var(--muted);font-size:0.8em;min-height:1em;margin:0.5em 0"></p>
    <div style="display:flex;gap:0.5em">
      <button class="buy-btn" id="org-safe-send-submit" style="flex:1;font-size:0.85em;padding:0.5em">send</button>
      <button class="buy-btn" id="org-safe-send-cancel" style="flex:0 0 auto;font-size:0.85em;padding:0.5em 1.25ch;border-color:var(--dim);color:var(--dim)">cancel</button>
    </div>
  `
  overlay.appendChild(dialog)
  document.body.appendChild(overlay)
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
  dialog.querySelector('#org-safe-send-cancel').addEventListener('click', () => overlay.remove())

  const statusEl = dialog.querySelector('#org-safe-send-status')
  dialog.querySelector('#org-safe-send-submit').addEventListener('click', async () => {
    const to = dialog.querySelector('#org-safe-send-to').value.trim()
    const amt = dialog.querySelector('#org-safe-send-amt').value.trim()
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) { statusEl.textContent = 'enter a valid 0x address'; return }
    const amtNum = parseFloat(amt)
    if (!(amtNum > 0)) { statusEl.textContent = 'enter an amount'; return }
    if (amtNum > balEth) { statusEl.textContent = `only ${balEth.toFixed(6)} ETH available`; return }
    dialog.querySelector('#org-safe-send-submit').disabled = true
    statusEl.style.color = 'var(--muted)'; statusEl.textContent = 'confirm in wallet…'
    try {
      const { safeSendEth } = await import('./safe-org.js')
      const hash = await safeSendEth({ safeAddress, to, ethAmount: amt })
      statusEl.style.color = 'var(--green)'
      statusEl.textContent = `sent ✓ ${hash.slice(0, 10)}…`
      setTimeout(() => { overlay.remove(); loadOrgSection() }, 1500)
    } catch (e) {
      statusEl.style.color = 'var(--dim)'
      statusEl.textContent = e.code === 4001 ? 'cancelled' : (e.shortMessage || e.message || 'send failed').slice(0, 120)
      dialog.querySelector('#org-safe-send-submit').disabled = false
    }
  })
}

function _wireInlineOrgAdmin(siteOrg, myAddr) {
  const btn = document.getElementById('s-org-invite-btn')
  const input = document.getElementById('s-org-invite-input')
  const statusEl = document.getElementById('s-org-invite-status')
  const suggest = document.getElementById('s-org-invite-suggest')
  if (!btn || !input) return
  const orgId = String(siteOrg.id)

  // ── Outgoing pending invites for THIS org ─────────────────────────────
  // Renders once at wire time, and again after every successful invite /
  // revoke so the admin sees the live state without a page reload.
  async function refreshPending() {
    const pendingWrap = document.getElementById('s-org-pending')
    const pendingList = document.getElementById('s-org-pending-list')
    if (!pendingWrap || !pendingList) return
    let items = []
    try {
      // orgInvites is exposed through the /api/feed whitelist. Ask for the
      // pending rows for this org (admin scope; the endpoint is read-only).
      const gql = `query ($id: BigInt!) { orgInvites(where: { orgId: $id, status: "pending" }, orderBy: "invitedAt", orderDirection: "desc", limit: 100) { items { id wallet invitedAt } } }`
      const res = await fetch(`/api/feed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: gql, variables: { id: orgId } }),
      })
      const data = await res.json()
      items = data?.data?.orgInvites?.items || []
    } catch {}
    if (!items.length) { pendingWrap.style.display = 'none'; pendingList.innerHTML = ''; return }
    // Resolve wallet → domain + profile pic so pending rows read as
    // "milesxb.bio [avatar] revoke" instead of a raw 0x address.
    // /api/artists/resolve responds with { addresses: {...}, profilePics: {...} }.
    let domainMap = {}
    let picMap = {}
    try {
      const r = await fetch('/api/artists/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addresses: items.map(i => String(i.wallet)) }),
      })
      const data = await r.json()
      domainMap = data?.addresses || {}
      picMap = data?.profilePics || {}
    } catch {}
    pendingWrap.style.display = 'block'
    const esc = escapeHtml
    pendingList.innerHTML = items.map(i => {
      const w = String(i.wallet).toLowerCase()
      const domain = domainMap[w] || domainMap[String(i.wallet)] || ''
      const label = domain || `${w.slice(0, 6)}…${w.slice(-4)}`
      const picRaw = picMap[w] || picMap[String(i.wallet)] || ''
      const picSafe = /^(https?:\/\/|\/api\/ipfs-proxy\/|\/ipfs\/)/i.test(String(picRaw)) ? String(picRaw) : ''
      const avatar = picSafe
        ? `<img src="${esc(picSafe)}" alt="" style="width:22px;height:22px;object-fit:cover;border:1px solid var(--border);flex-shrink:0">`
        : `<span style="width:22px;height:22px;border:1px solid var(--border);display:inline-flex;align-items:center;justify-content:center;font-size:0.7em;color:var(--dim);flex-shrink:0">${esc(label[0] || '·').toUpperCase()}</span>`
      return `<div class="s-org-pending-row" style="display:flex;justify-content:space-between;align-items:center;gap:0.6em;padding:0.4em 0;border-bottom:1px solid var(--border)" data-wallet="${esc(w)}">
        <span style="display:flex;align-items:center;gap:0.6em;min-width:0">
          ${avatar}
          <span style="font-size:0.9em;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(label)}</span>
        </span>
        <button class="s-org-revoke-btn" data-wallet="${esc(w)}" style="background:none;border:1px solid var(--border);color:var(--dim);font-family:inherit;font-size:0.75em;padding:0.2em 0.8ch;cursor:pointer;flex-shrink:0">revoke</button>
      </div>`
    }).join('')
    pendingList.querySelectorAll('.s-org-revoke-btn').forEach(b => {
      b.addEventListener('click', () => revokeInvite(b))
    })
  }

  async function revokeInvite(revBtn) {
    const target = revBtn.dataset.wallet
    if (!/^0x[0-9a-fA-F]{40}$/.test(target)) return
    const originalLabel = revBtn.textContent
    try {
      revBtn.disabled = true
      revBtn.textContent = 'revoking…'
      if (!await window.ensureOptimism?.()) { revBtn.textContent = originalLabel; revBtn.disabled = false; return }
      const { createWalletClient, custom, optimism } = await import('./vendor.js')
      const { ORG_ADDRESS, ORG_ABI } = await import('./contracts.js')
      const { getPublicClient } = await import('./utils.js')
      const wc = createWalletClient({ chain: optimism, transport: custom(window.getWalletProvider()) })
      const hash = await wc.writeContract({
        address: ORG_ADDRESS, abi: ORG_ABI, functionName: 'revokeInvite',
        args: [BigInt(orgId), target], account: myAddr,
      })
      const pc = await getPublicClient()
      await pc.waitForTransactionReceipt({ hash })
      refreshPending()
    } catch (e) {
      revBtn.disabled = false
      revBtn.textContent = originalLabel
      if (e.code !== 4001) console.warn('revokeInvite error', e)
    }
  }

  // ── Typeahead ─────────────────────────────────────────────────────────
  // Matches the /org page's invite UX: debounced /api/network/search →
  // clickable rows; clicking picks the row's wallet without further
  // lookup at submit time. Empty / short / 0x inputs skip the search.
  let _debounce = null
  let _selectedWallet = null
  const closeSuggest = () => { if (suggest) suggest.style.display = 'none' }

  input.addEventListener('input', () => {
    _selectedWallet = null
    clearTimeout(_debounce)
    const q = input.value.trim()
    if (!suggest) return
    if (q.length < 2 || q.startsWith('0x')) { closeSuggest(); return }
    _debounce = setTimeout(async () => {
      try {
        const r = await fetch(`/api/network/search?q=${encodeURIComponent(q)}&limit=6`)
        const data = await r.json()
        const items = (data.results || data.items || data || []).filter(a =>
          a.id?.toLowerCase() !== String(myAddr).toLowerCase()
        )
        if (!items.length) { closeSuggest(); return }
        const esc = escapeHtml
        suggest.innerHTML = items.map(a => {
          const domain = esc(a.domain || a.name || '')
          const short = a.id ? `${a.id.slice(0, 6)}…${a.id.slice(-4)}` : ''
          return `<div class="s-org-suggest-item" data-wallet="${esc(a.id || '')}" data-domain="${domain}" style="padding:0.5em 0.8em;cursor:pointer;display:flex;justify-content:space-between;align-items:center;font-size:0.85em;border-bottom:1px solid var(--border)">
            <span style="color:var(--fg)">${domain}</span>
            <span style="color:var(--dim);font-size:0.8em">${esc(short)}</span>
          </div>`
        }).join('')
        suggest.style.display = 'block'
        suggest.querySelectorAll('.s-org-suggest-item').forEach(row => {
          row.addEventListener('mousedown', (e) => {
            // mousedown so the input's blur (below) doesn't hide the
            // dropdown before the click lands.
            e.preventDefault()
            input.value = row.dataset.domain
            _selectedWallet = row.dataset.wallet
            closeSuggest()
          })
          row.addEventListener('mouseenter', () => { row.style.background = 'rgba(255,255,255,0.05)' })
          row.addEventListener('mouseleave', () => { row.style.background = '' })
        })
      } catch { closeSuggest() }
    }, 250)
  })
  input.addEventListener('blur', () => setTimeout(closeSuggest, 150))
  document.addEventListener('click', (e) => {
    if (suggest && !suggest.contains(e.target) && e.target !== input) closeSuggest()
  })

  // ── Invite ────────────────────────────────────────────────────────────
  const invite = async () => {
    closeSuggest()
    const raw = input.value.trim()
    if (!raw) { statusEl.textContent = 'enter a domain or wallet'; return }
    let targetWallet = _selectedWallet || null
    if (!targetWallet) {
      if (/^0x[0-9a-fA-F]{40}$/.test(raw)) {
        targetWallet = raw
      } else {
        statusEl.style.color = ''
        statusEl.textContent = 'resolving…'
        try {
          const r = await fetch(`/api/network/search?q=${encodeURIComponent(raw)}&limit=5`)
          const data = await r.json()
          const items = data.results || data.items || data || []
          const match = items.find(a =>
            (a.domain || a.name || '').toLowerCase() === raw.toLowerCase() ||
            (a.handle || '').toLowerCase() === raw.toLowerCase().replace(/\.[a-z]+$/, '')
          ) || items[0]
          if (!match?.id) { statusEl.style.color = '#ef4444'; statusEl.textContent = `couldn't find "${raw}"`; return }
          targetWallet = match.id
        } catch { statusEl.style.color = '#ef4444'; statusEl.textContent = 'lookup failed'; return }
      }
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(targetWallet)) { statusEl.style.color = '#ef4444'; statusEl.textContent = 'invalid wallet'; return }
    const originalBtn = btn.textContent
    try {
      btn.disabled = true
      btn.textContent = 'inviting…'
      statusEl.style.color = ''
      statusEl.textContent = 'confirm in wallet…'
      if (!await window.ensureOptimism?.()) { statusEl.textContent = 'wallet not connected'; return }
      const { createWalletClient, custom, optimism } = await import('./vendor.js')
      const { ORG_ADDRESS, ORG_ABI } = await import('./contracts.js')
      const { getPublicClient } = await import('./utils.js')
      const wc = createWalletClient({ chain: optimism, transport: custom(window.getWalletProvider()) })
      const hash = await wc.writeContract({
        address: ORG_ADDRESS, abi: ORG_ABI, functionName: 'inviteMember',
        args: [BigInt(orgId), targetWallet], account: myAddr,
      })
      statusEl.textContent = 'sending invite…'
      const pc = await getPublicClient()
      await pc.waitForTransactionReceipt({ hash })
      statusEl.style.color = 'var(--green,#4a4)'
      statusEl.textContent = 'invite sent — they must accept it from their own settings'
      input.value = ''
      _selectedWallet = null
      refreshPending()
    } catch (e) {
      statusEl.style.color = '#ef4444'
      statusEl.textContent = e.code === 4001 ? 'cancelled' : `error: ${(e.shortMessage || e.message || '').slice(0, 100)}`
    } finally {
      btn.disabled = false
      btn.textContent = originalBtn
    }
  }

  btn.addEventListener('click', invite)
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); invite() } })

  refreshPending()
}

// Create a separate organization AND spin up its own site (name +
// type + domain). Sequence:
//   1. upload org metadata to IPFS
//   2. Praxis.createOrg(name, metadataCid) — signer becomes admin
//   3. extract orgId from the OrgCreated event
//   4. Praxis.updateDomain(orgId, domain) — links the domain on-chain
//   5. wallet-sign praxis-org-attach:<orgId>:<domain>:<ts>
//   6. POST /orchestrator/org-site/attach → deployOrgMultiTenant
// The signing wallet ends up as both the on-chain admin AND the tenant
// site's owner. Non-admin viewers can't touch the site because the
// wallet is written into site.json.wallet.
async function showCreateOrgModal() {
  const overlay = document.createElement('div')
  overlay.className = 'praxis-modal-overlay'
  overlay.style.zIndex = '10010'
  const dialog = document.createElement('div')
  dialog.className = 'praxis-modal-dialog'
  dialog.style.maxWidth = '520px'

  const ORG_TYPES = [
    { key: 'collective', label: 'collective', desc: 'shared practice, flat structure' },
    { key: 'label', label: 'label', desc: 'roster + catalog / releases' },
    { key: 'gallery', label: 'gallery', desc: 'exhibitions + represented artists' },
    { key: 'company', label: 'company', desc: 'productions + cast/crew (theatre, dance, film)' },
    { key: 'publisher', label: 'publisher', desc: 'publications + authors' },
  ]

  dialog.innerHTML = `
    <h3 style="margin:0 0 0.5em;font-size:1.05em">create organization</h3>
    <p style="color:var(--muted);font-size:0.85em;margin:0 0 1em">Set up a shared account for your studio, label, collective, or company — with its own site, posts, credentials, and treasury. You'll be the sole owner to start; invite co-owners any time.</p>

    <label style="font-size:0.8em;color:var(--muted)">name</label>
    <input type="text" id="org-create-name" class="project-input" placeholder="e.g. whatifwe pictures" maxlength="80" style="width:100%;box-sizing:border-box;margin:0.25em 0 0.75em">

    <label style="font-size:0.8em;color:var(--muted)">description</label>
    <textarea id="org-create-desc" class="project-input" rows="2" placeholder="what is this organization about?" maxlength="500" style="width:100%;box-sizing:border-box;resize:vertical;margin:0.25em 0 0.75em"></textarea>

    <label style="font-size:0.8em;color:var(--muted)">type</label>
    <div id="org-type-cards" style="display:grid;grid-template-columns:1fr 1fr;gap:0.5em;margin:0.4em 0 0.75em">
      ${ORG_TYPES.map(t => `
        <div class="template-card${t.key === 'collective' ? ' active' : ''}" data-org-type="${t.key}" style="padding:0.5em 0.75em;cursor:pointer">
          <span class="template-card-name" style="font-size:0.85em">${t.label}</span>
          <span class="template-card-desc" style="font-size:0.7em">${escapeHtml(t.desc)}</span>
        </div>
      `).join('')}
    </div>

    <label style="font-size:0.8em;color:var(--muted)">domain</label>
    <div style="display:flex;gap:0;border-bottom:1px solid var(--border);margin:0.4em 0 0.5em">
      <button type="button" class="org-domain-tab active" data-tab="byo" style="background:none;border:0;color:var(--fg);font:inherit;font-size:0.85em;padding:0.4em 1ch;border-bottom:2px solid var(--accent);margin-bottom:-1px;cursor:pointer">use a domain I own</button>
      <button type="button" class="org-domain-tab" data-tab="buy" style="background:none;border:0;color:var(--muted);font:inherit;font-size:0.85em;padding:0.4em 1ch;border-bottom:2px solid transparent;margin-bottom:-1px;cursor:pointer">buy a new one</button>
    </div>
    <section id="org-domain-byo">
      <p style="color:var(--muted);font-size:0.75em;margin:0 0 0.5em">Point an A record for your domain at <code style="background:color-mix(in srgb, var(--fg) 8%, transparent);padding:0.1em 0.4ch;border-radius:3px">5.161.199.120</code>, then paste it.</p>
      <input type="text" id="org-byo-domain" class="project-input" placeholder="whatifwe.nyc" style="width:100%;box-sizing:border-box">
    </section>
    <section id="org-domain-buy" hidden>
      <div style="display:flex;gap:0.5em">
        <input type="text" id="org-buy-handle" class="project-input" placeholder="whatifwe" style="flex:1">
        <button type="button" class="buy-btn" id="org-buy-search" style="font-size:0.85em;padding:0.25em 1ch">search</button>
      </div>
      <div id="org-buy-results" style="margin-top:0.5em;max-height:180px;overflow-y:auto"></div>
      <div id="org-buy-contact" hidden style="margin-top:0.75em;padding-top:0.75em;border-top:1px dashed var(--border)"></div>
    </section>

    <p id="org-create-status" style="color:var(--muted);font-size:0.8em;min-height:1.2em;margin:0.75em 0 0.5em"></p>
    <div style="display:flex;gap:0.5em;margin-top:0.5em">
      <button id="org-create-submit" class="buy-btn" style="flex:1;font-size:0.85em;padding:0.5em">create + attach</button>
      <button id="org-create-cancel" class="buy-btn" style="flex:0 0 auto;font-size:0.85em;padding:0.5em 1.25ch;border-color:var(--dim);color:var(--dim)">cancel</button>
    </div>
  `
  overlay.appendChild(dialog)
  document.body.appendChild(overlay)
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
  dialog.querySelector('#org-create-cancel')?.addEventListener('click', () => overlay.remove())
  dialog.querySelector('#org-create-name')?.focus()

  // Local state — orgType default, domain tab, and NameSilo picks.
  let orgType = 'collective'
  let domainMode = 'byo'
  let selectedDomain = null
  let selectedPriceEth = 0
  const statusEl = dialog.querySelector('#org-create-status')

  dialog.querySelectorAll('#org-type-cards .template-card').forEach(card => {
    card.addEventListener('click', () => {
      dialog.querySelectorAll('#org-type-cards .template-card').forEach(c => c.classList.remove('active'))
      card.classList.add('active')
      orgType = card.dataset.orgType
    })
  })
  dialog.querySelectorAll('.org-domain-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      dialog.querySelectorAll('.org-domain-tab').forEach(t => {
        t.classList.toggle('active', t === tab)
        t.style.color = t === tab ? 'var(--fg)' : 'var(--muted)'
        t.style.borderBottomColor = t === tab ? 'var(--accent)' : 'transparent'
      })
      domainMode = tab.dataset.tab
      dialog.querySelector('#org-domain-byo').hidden = domainMode !== 'byo'
      dialog.querySelector('#org-domain-buy').hidden = domainMode !== 'buy'
    })
  })

  // NameSilo search — reuses /orchestrator/domains/search from artist flow.
  dialog.querySelector('#org-buy-search')?.addEventListener('click', async () => {
    const handle = dialog.querySelector('#org-buy-handle').value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '')
    if (!handle) { statusEl.textContent = 'enter a handle'; return }
    statusEl.textContent = 'searching…'
    const resultsEl = dialog.querySelector('#org-buy-results')
    resultsEl.innerHTML = ''
    try {
      const res = await fetch(`/orchestrator/domains/search?handle=${encodeURIComponent(handle)}`)
      const data = await res.json()
      const domains = (data.domains || []).filter(d => d.available && !d.premium && !d.tooExpensive)
      if (!domains.length) { statusEl.textContent = 'no available domains'; return }
      statusEl.textContent = 'pick one below.'
      resultsEl.innerHTML = domains.map(d => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:0.4em 0.75ch;border:1px solid var(--border);border-radius:6px;margin-bottom:0.3em">
          <span><span style="color:var(--accent)">${escapeHtml(d.domain)}</span>
            ${d.priceUsd ? `<span style="color:var(--dim);font-size:0.8em;margin-left:1ch">$${Number(d.priceUsd).toFixed(2)} / 2yr</span>` : ''}</span>
          <button class="buy-btn org-domain-pick" data-domain="${escapeHtml(d.domain)}" data-price-eth="${d.priceEth || '0'}" style="font-size:0.75em;padding:0.2em 1ch">pick</button>
        </div>
      `).join('')
      resultsEl.querySelectorAll('.org-domain-pick').forEach(btn => {
        btn.addEventListener('click', () => {
          selectedDomain = btn.dataset.domain
          selectedPriceEth = parseFloat(btn.dataset.priceEth || '0')
          resultsEl.querySelectorAll('.org-domain-pick').forEach(b => { b.textContent = 'pick'; b.style.borderColor = '' })
          btn.textContent = 'picked'
          btn.style.borderColor = 'var(--accent)'
          // Contact form (ICANN requirement).
          const contactEl = dialog.querySelector('#org-buy-contact')
          contactEl.hidden = false
          contactEl.innerHTML = `
            <p style="color:var(--muted);font-size:0.75em;margin:0 0 0.5em">ICANN needs contact info for <span style="color:var(--accent)">${escapeHtml(selectedDomain)}</span>.</p>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.4em">
              <input class="project-input" id="oc-first" placeholder="first name">
              <input class="project-input" id="oc-last" placeholder="last name">
              <input class="project-input" id="oc-email" placeholder="email" style="grid-column:1/-1">
              <input class="project-input" id="oc-address" placeholder="address" style="grid-column:1/-1">
              <input class="project-input" id="oc-city" placeholder="city">
              <input class="project-input" id="oc-state" placeholder="state">
              <input class="project-input" id="oc-zip" placeholder="zip">
              <input class="project-input" id="oc-country" placeholder="country" value="US">
            </div>
          `
        })
      })
    } catch (e) { statusEl.textContent = `search failed: ${(e.message || '').slice(0, 80)}` }
  })

  dialog.querySelector('#org-create-submit')?.addEventListener('click', async () => {
    statusEl.style.color = 'var(--muted)'
    const submitBtn = dialog.querySelector('#org-create-submit')
    const name = dialog.querySelector('#org-create-name').value.trim()
    const desc = dialog.querySelector('#org-create-desc').value.trim()
    if (!name) { statusEl.textContent = 'name is required'; return }

    // Resolve chosen domain up-front.
    let domain = null
    let contactInfo = null
    if (domainMode === 'byo') {
      domain = dialog.querySelector('#org-byo-domain').value.trim().toLowerCase()
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) { statusEl.textContent = 'enter a valid domain'; return }
    } else {
      domain = selectedDomain
      if (!domain) { statusEl.textContent = 'pick a domain from the search results'; return }
      contactInfo = {
        firstName: dialog.querySelector('#oc-first').value.trim(),
        lastName: dialog.querySelector('#oc-last').value.trim(),
        email: dialog.querySelector('#oc-email').value.trim(),
        address: dialog.querySelector('#oc-address').value.trim(),
        city: dialog.querySelector('#oc-city').value.trim(),
        state: dialog.querySelector('#oc-state').value.trim(),
        zip: dialog.querySelector('#oc-zip').value.trim(),
        country: dialog.querySelector('#oc-country').value.trim() || 'US',
      }
      if (!contactInfo.firstName || !contactInfo.lastName || !contactInfo.email) {
        statusEl.textContent = 'first/last/email required for NameSilo'
        return
      }
    }
    submitBtn.disabled = true

    try {
      // 1. Metadata → IPFS.
      statusEl.textContent = 'uploading org metadata…'
      const token = await getSettingsToken()
      if (!token) throw new Error('wallet auth required')
      const metaBlob = new Blob([JSON.stringify({ name, bio: desc, type: orgType })], { type: 'application/json' })
      const uploadData = await uploadToIpfs('org-metadata.json', await metaBlob.arrayBuffer(), token)
      let metadataCid = uploadData.cid || ''
      if (!metadataCid && uploadData.jobId) {
        for (let i = 0; i < 60; i++) {
          await new Promise(r => setTimeout(r, 2000))
          const sres = await fetch(`/api/ipfs/status/${uploadData.jobId}`).then(r => r.json())
          if (sres.status === 'done' && sres.cid) { metadataCid = sres.cid; break }
          if (sres.status === 'error') throw new Error(sres.error || 'upload failed')
        }
      }
      if (!metadataCid) throw new Error('org metadata upload timed out')

      // 2. Deploy a Safe multisig with the caller as sole 1-of-1
      // signer. Safe becomes the org admin from msg.sender of
      // createOrg — no post-hoc transferAdmin needed.
      const { ensureWallet, getWalletClient, getPublicClient, getWalletProvider } = await import('./utils.js')
      const { ORG_ADDRESS, ORG_ABI, TREASURY_ADMIN_ADDR, getRegistryAddress } = await import('./contracts.js')
      const { createWalletClient, custom, optimism, encodeFunctionData } = await import('./vendor.js')
      const { deployOrgSafe, fundSafeForBoot, execSafeTx, safeRegisterAsSupporter, safeSupporterHandle } = await import('./safe-org.js')
      const addr = await ensureWallet()
      if (!addr) throw new Error('wallet required')
      const account = window.getEmbeddedAccount?.() || addr
      const wc = await getWalletClient()
      const pc = await getPublicClient()
      const registryAddress = getRegistryAddress()
      if (!registryAddress) throw new Error('registry unavailable — reload')

      statusEl.textContent = 'setting up the org account…'
      const { safeAddress } = await deployOrgSafe({ signers: [addr], threshold: 1 })
      // Three Safe txs coming: registerSupporter + createOrg +
      // updateDomain. 0.003 keeps a comfortable margin at current
      // Optimism gas prices.
      statusEl.textContent = 'funding it (small gas float)…'
      await fundSafeForBoot(safeAddress, '0.003')

      // 2b. Register Safe as a supporter so it passes REGISTRY.isUser
      // — createOrg reverts with NotUser without this.
      statusEl.textContent = 'preparing the org account…'
      const supHandle = safeSupporterHandle(name, String(Date.now()).slice(-4))
      try {
        await safeRegisterAsSupporter({ safeAddress, registryAddress, handle: supHandle })
      } catch (e) {
        const msg = e?.shortMessage || e?.message || ''
        if (/handle taken|already registered/i.test(msg)) {
          const retryHandle = safeSupporterHandle(name, String(Date.now()).slice(-4) + Math.random().toString(36).slice(2, 4))
          await safeRegisterAsSupporter({ safeAddress, registryAddress, handle: retryHandle })
        } else {
          throw e
        }
      }

      // 3. Safe.execTx(createOrg) — Safe becomes admin.
      statusEl.textContent = 'registering the org…'
      const createData = encodeFunctionData({ abi: ORG_ABI, functionName: 'createOrg', args: [name, metadataCid] })
      const createHash = await execSafeTx({ safeAddress, target: ORG_ADDRESS, callData: createData })
      const createReceipt = await pc.waitForTransactionReceipt({ hash: createHash })

      // 4. Extract orgId from OrgCreated(uint256 indexed orgId, ...)
      // The event still fires from Praxis.sol during the inner call —
      // logs appear in the outer Safe.execTransaction receipt.
      const ORG_CREATED_TOPIC = '0xd78a3321fe7d2b183580459478e5563faf4fb5fae376030d1c606eebccd87918'
      let orgId = null
      for (const log of createReceipt.logs || []) {
        if (log.address?.toLowerCase() !== ORG_ADDRESS.toLowerCase()) continue
        if (String(log.topics?.[0]).toLowerCase() !== ORG_CREATED_TOPIC) continue
        try { orgId = BigInt(log.topics[1]); break } catch {}
      }
      if (orgId == null) throw new Error('could not read orgId from receipt')
      const orgIdNum = Number(orgId)

      // 5. Safe.execTx(updateDomain) — Safe as admin links its domain.
      statusEl.textContent = 'linking the domain…'
      const linkData = encodeFunctionData({ abi: ORG_ABI, functionName: 'updateDomain', args: [orgId, domain] })
      await execSafeTx({ safeAddress, target: ORG_ADDRESS, callData: linkData })

      // 6. Sign attach with caller's EOA. Orchestrator recognizes
      // Safe signers as valid attach signers (verifyOrgAttach checks
      // Safe.isOwner when the on-chain admin is a contract).
      const message = `praxis-org-attach:${orgIdNum}:${domain}:${Date.now()}`
      statusEl.textContent = 'confirm ownership…'
      const dwc = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })
      const signature = await dwc.signMessage({ account, message })

      let endpoint = '/orchestrator/org-site/attach'
      // Pass the Safe address so the orchestrator writes it as
      // site.json.wallet (instead of the signing EOA). That way the
      // org site's on-chain identity matches its site.json owner.
      const payload = { orgId: orgIdNum, domain, wallet: addr, safeAddress, name, bio: desc, orgType, signature, message }

      // Org attach fee — $10 in ETH, matching the artist deploy fee.
      // Goes to TREASURY_ADMIN_ADDR (sweeps to EtherFi Cash later).
      // BYO: single tx = ORG_ATTACH_FEE_ETH. Buy: single tx =
      // ORG_ATTACH_FEE_ETH + domainPriceEth (both to same recipient).
      const ORG_ATTACH_FEE_ETH = 0.003 // ~$10 at $3300/ETH
      const totalFeeEth = domainMode === 'buy'
        ? Math.max(0.003, selectedPriceEth) + ORG_ATTACH_FEE_ETH
        : ORG_ATTACH_FEE_ETH
      statusEl.textContent = `confirm ${totalFeeEth.toFixed(4)} ETH payment (org fee${domainMode === 'buy' ? ' + domain' : ''})…`
      const totalWei = parseEther(totalFeeEth.toFixed(6))
      const feeTxHash = await dwc.sendTransaction({ to: TREASURY_ADMIN_ADDR, value: totalWei, account })
      statusEl.textContent = `payment sent (${feeTxHash.slice(0, 10)}…) — waiting…`
      await pc.waitForTransactionReceipt({ hash: feeTxHash })
      payload.txHash = feeTxHash

      if (domainMode === 'buy') {
        endpoint = '/orchestrator/org-site/register'
        payload.contactInfo = contactInfo
      }

      statusEl.textContent = 'provisioning site…'
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)

      statusEl.style.color = 'var(--green,#4a4)'
      statusEl.innerHTML = `organization created — <a href="https://${escapeHtml(domain)}" target="_blank" rel="noopener" style="color:var(--accent)">visit ${escapeHtml(domain)}</a>`
      setTimeout(() => { overlay.remove(); if (typeof loadOrgSection === 'function') loadOrgSection() }, 3000)
    } catch (e) {
      statusEl.style.color = '#ef4444'
      statusEl.textContent = e.code === 4001 ? 'cancelled' : `error: ${(e.shortMessage || e.message || '').slice(0, 100)}`
      submitBtn.disabled = false
    }
  })
}

// Attach a site to an org you already admin. This is the path for
// existing on-chain orgs (like whatifwe pictures, org #1 after the
// migration) — skips createOrg + metadata upload, just:
//   1. optional Praxis.updateDomain if the on-chain domain is empty or
//      differs from the one being attached
//   2. wallet-sign praxis-org-attach
//   3. POST /orchestrator/org-site/attach or /register
// One row on the ledger, one site. No double entry.
async function showAttachOrgSiteModal(org) {
  const overlay = document.createElement('div')
  overlay.className = 'praxis-modal-overlay'
  overlay.style.zIndex = '10010'
  const dialog = document.createElement('div')
  dialog.className = 'praxis-modal-dialog'
  dialog.style.maxWidth = '520px'

  const ORG_TYPES = [
    { key: 'collective', label: 'collective', desc: 'shared practice, flat structure' },
    { key: 'label', label: 'label', desc: 'roster + catalog / releases' },
    { key: 'gallery', label: 'gallery', desc: 'exhibitions + represented artists' },
    { key: 'company', label: 'company', desc: 'productions + cast/crew (theatre, dance, film)' },
    { key: 'publisher', label: 'publisher', desc: 'publications + authors' },
  ]

  const currentOnChainDomain = String(org.domain || '').trim().toLowerCase()

  dialog.innerHTML = `
    <h3 style="margin:0 0 0.5em;font-size:1.05em">attach a site to <span style="color:var(--accent)">${escapeHtml(org.name)}</span></h3>
    <p style="color:var(--muted);font-size:0.85em;margin:0 0 1em">Give this existing org a site at your own domain. Sign in on the attached domain with the same account to manage it.</p>

    <label style="font-size:0.8em;color:var(--muted)">type</label>
    <div id="oa-type-cards" style="display:grid;grid-template-columns:1fr 1fr;gap:0.5em;margin:0.4em 0 0.75em">
      ${ORG_TYPES.map(t => `
        <div class="template-card${t.key === 'collective' ? ' active' : ''}" data-org-type="${t.key}" style="padding:0.5em 0.75em;cursor:pointer">
          <span class="template-card-name" style="font-size:0.85em">${t.label}</span>
          <span class="template-card-desc" style="font-size:0.7em">${escapeHtml(t.desc)}</span>
        </div>
      `).join('')}
    </div>

    <label style="font-size:0.8em;color:var(--muted)">domain</label>
    <div style="display:flex;gap:0;border-bottom:1px solid var(--border);margin:0.4em 0 0.5em">
      <button type="button" class="oa-domain-tab active" data-tab="byo" style="background:none;border:0;color:var(--fg);font:inherit;font-size:0.85em;padding:0.4em 1ch;border-bottom:2px solid var(--accent);margin-bottom:-1px;cursor:pointer">use a domain I own</button>
      <button type="button" class="oa-domain-tab" data-tab="buy" style="background:none;border:0;color:var(--muted);font:inherit;font-size:0.85em;padding:0.4em 1ch;border-bottom:2px solid transparent;margin-bottom:-1px;cursor:pointer">buy a new one</button>
    </div>
    <section id="oa-domain-byo">
      <p style="color:var(--muted);font-size:0.75em;margin:0 0 0.5em">Two records at your registrar: an <strong>A</strong> record → <code style="background:color-mix(in srgb, var(--fg) 8%, transparent);padding:0.1em 0.4ch;border-radius:3px">5.161.199.120</code>, and a <strong>TXT</strong> at <code>_praxis-verify.&lt;domain&gt;</code> shown after you enter the domain.</p>
      <input type="text" id="oa-byo-domain" class="project-input" placeholder="whatifwe.nyc" value="${escapeHtml(currentOnChainDomain)}" style="width:100%;box-sizing:border-box">
      ${currentOnChainDomain ? `<p style="color:var(--dim);font-size:0.7em;margin:0.25em 0 0">on-chain record already points here — no updateDomain tx needed.</p>` : ''}
      <div style="margin-top:0.5em">
        <button type="button" class="buy-btn" id="oa-byo-check" style="font-size:0.8em;padding:0.25em 1ch">show TXT record</button>
      </div>
      <div id="oa-byo-txt" hidden style="margin-top:0.75em;padding:0.75em;border:1px solid var(--border);border-radius:6px;background:color-mix(in srgb, var(--fg) 3%, transparent)">
        <div style="display:flex;gap:0.5em;align-items:baseline;font-size:0.8em"><span style="color:var(--muted);width:6ch">record</span><code id="oa-byo-txt-name" style="word-break:break-all"></code></div>
        <div style="display:flex;gap:0.5em;align-items:baseline;font-size:0.8em;margin-top:0.3em"><span style="color:var(--muted);width:6ch">value</span><code id="oa-byo-txt-value" style="word-break:break-all"></code></div>
        <div style="display:flex;gap:0.75em;align-items:center;margin-top:0.5em">
          <button type="button" class="buy-btn" id="oa-byo-txt-copy" style="font-size:0.75em;padding:0.15em 1ch">copy value</button>
          <span id="oa-byo-verify-state" style="font-size:0.75em;color:var(--muted)">not verified</span>
        </div>
      </div>
    </section>
    <section id="oa-domain-buy" hidden>
      <div style="display:flex;gap:0.5em">
        <input type="text" id="oa-buy-handle" class="project-input" placeholder="whatifwe" style="flex:1">
        <button type="button" class="buy-btn" id="oa-buy-search" style="font-size:0.85em;padding:0.25em 1ch">search</button>
      </div>
      <div id="oa-buy-results" style="margin-top:0.5em;max-height:180px;overflow-y:auto"></div>
      <div id="oa-buy-contact" hidden style="margin-top:0.75em;padding-top:0.75em;border-top:1px dashed var(--border)"></div>
    </section>

    <p id="oa-status" style="color:var(--muted);font-size:0.8em;min-height:1.2em;margin:0.75em 0 0.5em"></p>
    <div style="display:flex;gap:0.5em;margin-top:0.5em">
      <button id="oa-submit" class="buy-btn" style="flex:1;font-size:0.85em;padding:0.5em">attach site</button>
      <button id="oa-cancel" class="buy-btn" style="flex:0 0 auto;font-size:0.85em;padding:0.5em 1.25ch;border-color:var(--dim);color:var(--dim)">cancel</button>
    </div>
  `
  overlay.appendChild(dialog)
  document.body.appendChild(overlay)
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
  dialog.querySelector('#oa-cancel')?.addEventListener('click', () => overlay.remove())

  let orgType = 'collective'
  let domainMode = 'byo'
  let selectedDomain = null
  let selectedPriceEth = 0
  let byoTxtVerified = false
  let byoPollTimer = null
  const statusEl = dialog.querySelector('#oa-status')

  function stopPoll() { if (byoPollTimer) { clearInterval(byoPollTimer); byoPollTimer = null } }
  overlay.addEventListener('click', (e) => { if (e.target === overlay) { stopPoll(); overlay.remove() } })

  async function verifyTxt(domain, silent) {
    try {
      const res = await fetch('/orchestrator/verify-txt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'org', id: Number(org.id), wallet: org.admin, domain }),
      })
      const data = await res.json()
      const stateEl = dialog.querySelector('#oa-byo-verify-state')
      if (data.error) { if (stateEl) stateEl.textContent = `error: ${data.error}`; return null }
      if (data.verified) {
        byoTxtVerified = true
        stopPoll()
        if (stateEl) { stateEl.textContent = 'verified ✓'; stateEl.style.color = '#4ade80' }
        return data
      }
      if (!silent && stateEl) stateEl.textContent = 'not verified — add the record at your registrar'
      return data
    } catch { return null }
  }

  dialog.querySelector('#oa-byo-check')?.addEventListener('click', async () => {
    const domain = dialog.querySelector('#oa-byo-domain').value.trim().toLowerCase()
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) { statusEl.textContent = 'enter a valid domain first'; return }
    statusEl.textContent = ''
    const data = await verifyTxt(domain, false)
    if (!data) return
    dialog.querySelector('#oa-byo-txt-name').textContent = data.recordName
    dialog.querySelector('#oa-byo-txt-value').textContent = data.expectedValue
    dialog.querySelector('#oa-byo-txt').hidden = false
    if (!data.verified) {
      stopPoll()
      byoPollTimer = setInterval(() => verifyTxt(domain, true), 10000)
    }
  })
  dialog.querySelector('#oa-byo-txt-copy')?.addEventListener('click', () => {
    const val = dialog.querySelector('#oa-byo-txt-value').textContent
    navigator.clipboard?.writeText(val).catch(() => {})
    dialog.querySelector('#oa-byo-txt-copy').textContent = 'copied'
    setTimeout(() => { dialog.querySelector('#oa-byo-txt-copy').textContent = 'copy value' }, 1500)
  })

  dialog.querySelectorAll('#oa-type-cards .template-card').forEach(card => {
    card.addEventListener('click', () => {
      dialog.querySelectorAll('#oa-type-cards .template-card').forEach(c => c.classList.remove('active'))
      card.classList.add('active')
      orgType = card.dataset.orgType
    })
  })
  dialog.querySelectorAll('.oa-domain-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      dialog.querySelectorAll('.oa-domain-tab').forEach(t => {
        t.classList.toggle('active', t === tab)
        t.style.color = t === tab ? 'var(--fg)' : 'var(--muted)'
        t.style.borderBottomColor = t === tab ? 'var(--accent)' : 'transparent'
      })
      domainMode = tab.dataset.tab
      dialog.querySelector('#oa-domain-byo').hidden = domainMode !== 'byo'
      dialog.querySelector('#oa-domain-buy').hidden = domainMode !== 'buy'
    })
  })

  dialog.querySelector('#oa-buy-search')?.addEventListener('click', async () => {
    const handle = dialog.querySelector('#oa-buy-handle').value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '')
    if (!handle) { statusEl.textContent = 'enter a handle'; return }
    statusEl.textContent = 'searching…'
    const resultsEl = dialog.querySelector('#oa-buy-results')
    resultsEl.innerHTML = ''
    try {
      const res = await fetch(`/orchestrator/domains/search?handle=${encodeURIComponent(handle)}`)
      const data = await res.json()
      const domains = (data.domains || []).filter(d => d.available && !d.premium && !d.tooExpensive)
      if (!domains.length) { statusEl.textContent = 'no available domains'; return }
      statusEl.textContent = 'pick one below.'
      resultsEl.innerHTML = domains.map(d => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:0.4em 0.75ch;border:1px solid var(--border);border-radius:6px;margin-bottom:0.3em">
          <span><span style="color:var(--accent)">${escapeHtml(d.domain)}</span>
            ${d.priceUsd ? `<span style="color:var(--dim);font-size:0.8em;margin-left:1ch">$${Number(d.priceUsd).toFixed(2)} / 2yr</span>` : ''}</span>
          <button class="buy-btn oa-domain-pick" data-domain="${escapeHtml(d.domain)}" data-price-eth="${d.priceEth || '0'}" style="font-size:0.75em;padding:0.2em 1ch">pick</button>
        </div>
      `).join('')
      resultsEl.querySelectorAll('.oa-domain-pick').forEach(btn => {
        btn.addEventListener('click', () => {
          selectedDomain = btn.dataset.domain
          selectedPriceEth = parseFloat(btn.dataset.priceEth || '0')
          resultsEl.querySelectorAll('.oa-domain-pick').forEach(b => { b.textContent = 'pick'; b.style.borderColor = '' })
          btn.textContent = 'picked'
          btn.style.borderColor = 'var(--accent)'
          const contactEl = dialog.querySelector('#oa-buy-contact')
          contactEl.hidden = false
          contactEl.innerHTML = `
            <p style="color:var(--muted);font-size:0.75em;margin:0 0 0.5em">ICANN needs contact info for <span style="color:var(--accent)">${escapeHtml(selectedDomain)}</span>.</p>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.4em">
              <input class="project-input" id="oac-first" placeholder="first name">
              <input class="project-input" id="oac-last" placeholder="last name">
              <input class="project-input" id="oac-email" placeholder="email" style="grid-column:1/-1">
              <input class="project-input" id="oac-address" placeholder="address" style="grid-column:1/-1">
              <input class="project-input" id="oac-city" placeholder="city">
              <input class="project-input" id="oac-state" placeholder="state">
              <input class="project-input" id="oac-zip" placeholder="zip">
              <input class="project-input" id="oac-country" placeholder="country" value="US">
            </div>
          `
        })
      })
    } catch (e) { statusEl.textContent = `search failed: ${(e.message || '').slice(0, 80)}` }
  })

  dialog.querySelector('#oa-submit')?.addEventListener('click', async () => {
    statusEl.style.color = 'var(--muted)'
    const submitBtn = dialog.querySelector('#oa-submit')
    let domain = null
    let contactInfo = null
    if (domainMode === 'byo') {
      domain = dialog.querySelector('#oa-byo-domain').value.trim().toLowerCase()
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) { statusEl.textContent = 'enter a valid domain'; return }
      // Force a final TXT check right before the tx flurry — a stale
      // "verified" flag from 5 min ago isn't good enough if the record
      // was removed. Silent poll; error if not verified now.
      const check = await verifyTxt(domain, true)
      if (!check?.verified) { statusEl.textContent = 'TXT record not verified — click "show TXT record" first'; return }
    } else {
      domain = selectedDomain
      if (!domain) { statusEl.textContent = 'pick a domain from the search results'; return }
      contactInfo = {
        firstName: dialog.querySelector('#oac-first').value.trim(),
        lastName: dialog.querySelector('#oac-last').value.trim(),
        email: dialog.querySelector('#oac-email').value.trim(),
        address: dialog.querySelector('#oac-address').value.trim(),
        city: dialog.querySelector('#oac-city').value.trim(),
        state: dialog.querySelector('#oac-state').value.trim(),
        zip: dialog.querySelector('#oac-zip').value.trim(),
        country: dialog.querySelector('#oac-country').value.trim() || 'US',
      }
      if (!contactInfo.firstName || !contactInfo.lastName || !contactInfo.email) {
        statusEl.textContent = 'first/last/email required for NameSilo'
        return
      }
    }
    submitBtn.disabled = true

    try {
      const { ensureWallet, getWalletClient, getPublicClient, getWalletProvider } = await import('./utils.js')
      const { ORG_ADDRESS, ORG_ABI, TREASURY_ADMIN_ADDR } = await import('./contracts.js')
      const { createWalletClient, custom, optimism } = await import('./vendor.js')
      const addr = await ensureWallet()
      if (!addr) throw new Error('wallet required')
      if (addr.toLowerCase() !== org.admin.toLowerCase()) {
        throw new Error('only the org admin can attach a site')
      }
      const account = window.getEmbeddedAccount?.() || addr
      const wc = await getWalletClient()
      const pc = await getPublicClient()

      // Only call updateDomain if the on-chain domain doesn't already
      // match. Skips an extra signature + tx when the record is already
      // pointed at this domain (common on migrated orgs).
      if (currentOnChainDomain !== domain) {
        statusEl.textContent = 'linking domain on Ethereum…'
        const linkHash = await wc.writeContract({ address: ORG_ADDRESS, abi: ORG_ABI, functionName: 'updateDomain', args: [BigInt(org.id), domain], account })
        await pc.waitForTransactionReceipt({ hash: linkHash })
      }

      statusEl.textContent = 'sign attach…'
      const message = `praxis-org-attach:${Number(org.id)}:${domain}:${Date.now()}`
      const dwc = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })
      const signature = await dwc.signMessage({ account, message })

      let endpoint = '/orchestrator/org-site/attach'
      const payload = { orgId: Number(org.id), domain, wallet: addr, name: org.name, bio: org.bio || '', orgType, signature, message }

      // Org attach fee — same $10 as the create flow.
      const ORG_ATTACH_FEE_ETH_A = 0.003
      const totalFeeEth = domainMode === 'buy'
        ? Math.max(0.003, selectedPriceEth) + ORG_ATTACH_FEE_ETH_A
        : ORG_ATTACH_FEE_ETH_A
      statusEl.textContent = `confirm ${totalFeeEth.toFixed(4)} ETH payment (org fee${domainMode === 'buy' ? ' + domain' : ''})…`
      const totalWei = parseEther(totalFeeEth.toFixed(6))
      const feeTxHash = await dwc.sendTransaction({ to: TREASURY_ADMIN_ADDR, value: totalWei, account })
      statusEl.textContent = `payment sent (${feeTxHash.slice(0, 10)}…) — waiting…`
      await pc.waitForTransactionReceipt({ hash: feeTxHash })
      payload.txHash = feeTxHash

      if (domainMode === 'buy') {
        endpoint = '/orchestrator/org-site/register'
        payload.contactInfo = contactInfo
      }

      statusEl.textContent = 'provisioning site…'
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)

      statusEl.style.color = 'var(--green,#4a4)'
      statusEl.innerHTML = `attached — <a href="https://${escapeHtml(domain)}" target="_blank" rel="noopener" style="color:var(--accent)">visit ${escapeHtml(domain)}</a>`
      setTimeout(() => { overlay.remove(); if (typeof loadOrgSection === 'function') loadOrgSection() }, 3000)
    } catch (e) {
      statusEl.style.color = '#ef4444'
      statusEl.textContent = e.code === 4001 ? 'cancelled' : `error: ${(e.shortMessage || e.message || '').slice(0, 100)}`
      submitBtn.disabled = false
    }
  })
}

// Upgrade an EOA-admined org to a Safe multisig. Deploys a 1-of-1
// Safe with the current admin as sole signer, funds it enough for
// its first tx, then runs the on-chain dance:
//   1. admin.inviteMember(orgId, safeAddress)
//   2. safe.execTransaction(Praxis.acceptInvite(orgId))
//   3. admin.transferAdmin(orgId, safeAddress)
//   4. server updates /data/artists/<handle>/site.json.wallet to safe
//
// After this, the org has its own on-chain identity — notifications
// targeting the Safe are org-scoped (not admin-scoped), additional
// signers can be added later via Safe.addOwnerWithThreshold, and
// treasury flows go through the Safe.
async function showUpgradeToSafeModal({ orgId, orgName, orgDomain }) {
  const overlay = document.createElement('div')
  overlay.className = 'praxis-modal-overlay'
  overlay.style.zIndex = '10010'
  const dialog = document.createElement('div')
  dialog.className = 'praxis-modal-dialog'
  dialog.style.maxWidth = '520px'
  dialog.innerHTML = `
    <h3 style="margin:0 0 0.5em;font-size:1.05em">turn <span style="color:var(--accent)">${escapeHtml(orgName)}</span> into a shared account</h3>
    <p style="color:var(--muted);font-size:0.85em;margin:0 0 0.75em;line-height:1.55">
      Right now this org runs off your personal account. Setting it up as a shared account gives the org its own identity — its own posts, notifications, credentials, and treasury, separate from you.
      You'll be the sole owner to start. Add co-owners any time to share control (2-of-3, 3-of-5 — whatever fits).
    </p>
    <p style="color:var(--dim);font-size:0.8em;margin:0 0 1em;line-height:1.5">
      Takes 4 confirmations + about $2 in gas. When you're done, sign in on ${escapeHtml(orgDomain || 'the org domain')} with your own password — you'll unlock the org because you own it.
    </p>

    <ol id="upgrade-steps" style="list-style:none;padding:0;margin:0 0 1em;color:var(--dim);font-size:0.85em;line-height:1.7">
      <li data-step="1"><span class="step-dot">○</span> set up shared account</li>
      <li data-step="2"><span class="step-dot">○</span> fund it (small gas float)</li>
      <li data-step="3"><span class="step-dot">○</span> add it as a member</li>
      <li data-step="4"><span class="step-dot">○</span> accept the invite</li>
      <li data-step="5"><span class="step-dot">○</span> hand ownership to the shared account</li>
      <li data-step="6"><span class="step-dot">○</span> update site config</li>
    </ol>

    <p id="upgrade-status" style="color:var(--muted);font-size:0.85em;min-height:1.2em;margin:0.5em 0"></p>
    <div style="display:flex;gap:0.5em;margin-top:0.5em">
      <button class="buy-btn" id="upgrade-submit" style="flex:1;font-size:0.85em;padding:0.5em">make it shared</button>
      <button class="buy-btn" id="upgrade-cancel" style="flex:0 0 auto;font-size:0.85em;padding:0.5em 1.25ch;border-color:var(--dim);color:var(--dim)">cancel</button>
    </div>
  `
  overlay.appendChild(dialog)
  document.body.appendChild(overlay)
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
  dialog.querySelector('#upgrade-cancel').addEventListener('click', () => overlay.remove())

  const statusEl = dialog.querySelector('#upgrade-status')
  const markStep = (n, state) => {
    const li = dialog.querySelector(`#upgrade-steps li[data-step="${n}"]`)
    if (!li) return
    const dot = li.querySelector('.step-dot')
    if (state === 'active') { dot.textContent = '●'; li.style.color = 'var(--fg)' }
    else if (state === 'done') { dot.textContent = '✓'; li.style.color = 'var(--accent)' }
    else if (state === 'error') { dot.textContent = '✗'; li.style.color = '#ef4444' }
  }

  dialog.querySelector('#upgrade-submit').addEventListener('click', async () => {
    statusEl.style.color = 'var(--muted)'
    dialog.querySelector('#upgrade-submit').disabled = true

    try {
      const [{ deployOrgSafe, fundSafeForBoot, execSafeTx, safeRegisterAsSupporter, safeSupporterHandle }, { ensureWallet, getWalletClient, getPublicClient }, { ORG_ADDRESS, ORG_ABI, getRegistryAddress }, { createWalletClient, custom, optimism, encodeFunctionData }] = await Promise.all([
        import('./safe-org.js'),
        import('./utils.js'),
        import('./contracts.js'),
        import('./vendor.js'),
      ])

      const addr = await ensureWallet()
      if (!addr) throw new Error('connect wallet')
      const account = window.getEmbeddedAccount?.() || addr
      const wc = await getWalletClient()
      const pc = await getPublicClient()
      const registryAddress = getRegistryAddress()
      if (!registryAddress) throw new Error('registry address unavailable — reload the page')

      // 1. Deploy Safe with current admin as 1-of-1 signer.
      markStep(1, 'active'); statusEl.textContent = 'setting up shared account (confirm in wallet)…'
      const { safeAddress } = await deployOrgSafe({ signers: [addr], threshold: 1 })
      markStep(1, 'done'); statusEl.textContent = `shared account created`

      // 2. Fund Safe with a bit of ETH — Safe pays gas for its own
      //    txs from here on (registerSupporter + acceptInvite + one
      //    more if we add anything). Bumped to 0.0015 so all three fit
      //    at current Optimism gas prices.
      markStep(2, 'active'); statusEl.textContent = 'funding it (small gas float)…'
      await fundSafeForBoot(safeAddress, '0.0015')
      markStep(2, 'done')

      // 3. Register the Safe as a supporter on ArtistRegistry so it
      //    passes REGISTRY.isUser(safe) — otherwise inviteMember +
      //    createOrg both revert with NotUser. Then the admin invites
      //    the Safe as a member.
      markStep(3, 'active'); statusEl.textContent = 'adding it as a member…'
      const supporterHandle = safeSupporterHandle(orgName, String(orgId))
      try {
        await safeRegisterAsSupporter({ safeAddress, registryAddress, handle: supporterHandle })
      } catch (e) {
        // If the handle collides or the Safe is already a supporter,
        // retry once with a random suffix. Anything else re-throws.
        const msg = e?.shortMessage || e?.message || ''
        if (/handle taken|already registered/i.test(msg)) {
          const retryHandle = safeSupporterHandle(orgName, String(orgId) + Math.random().toString(36).slice(2, 5))
          await safeRegisterAsSupporter({ safeAddress, registryAddress, handle: retryHandle })
        } else if (!/already registered/i.test(msg)) {
          throw e
        }
      }
      const inviteHash = await wc.writeContract({
        address: ORG_ADDRESS, abi: ORG_ABI, functionName: 'inviteMember',
        args: [BigInt(orgId), safeAddress], account,
      })
      await pc.waitForTransactionReceipt({ hash: inviteHash })
      markStep(3, 'done')

      // 4. Safe accepts the invite. execTransaction from Safe with
      //    owner-sender pre-approved signature.
      markStep(4, 'active'); statusEl.textContent = 'accepting the invite…'
      const acceptData = encodeFunctionData({ abi: ORG_ABI, functionName: 'acceptInvite', args: [BigInt(orgId)] })
      await execSafeTx({ safeAddress, target: ORG_ADDRESS, callData: acceptData })
      markStep(4, 'done')

      // 5. Admin transfers admin to Safe.
      markStep(5, 'active'); statusEl.textContent = 'handing ownership to the shared account…'
      const xferHash = await wc.writeContract({
        address: ORG_ADDRESS, abi: ORG_ABI, functionName: 'transferAdmin',
        args: [BigInt(orgId), safeAddress], account,
      })
      await pc.waitForTransactionReceipt({ hash: xferHash })
      markStep(5, 'done')

      // 6. Tell the server to update site.json.wallet on the org's
      //    tenant. Server verifies the transfer already happened on-chain
      //    before writing.
      if (orgDomain) {
        markStep(6, 'active'); statusEl.textContent = 'updating site config…'
        const res = await fetch('/api/org-site/rewire-safe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orgId: Number(orgId), safeAddress, callerWallet: addr }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok || data.error) throw new Error(data.error || 'site rewire failed')
        markStep(6, 'done')
      } else {
        markStep(6, 'done')
      }

      statusEl.style.color = 'var(--green,#4a4)'
      statusEl.innerHTML = `done ✓ &nbsp; this org is now a shared account${orgDomain ? ` &nbsp; <a href="https://${escapeHtml(orgDomain)}" target="_blank" rel="noopener" style="color:var(--accent)">visit ${escapeHtml(orgDomain)}</a>` : ''}`
      setTimeout(() => { overlay.remove(); if (typeof loadOrgSection === 'function') loadOrgSection() }, 5000)
    } catch (e) {
      const activeLi = dialog.querySelector('#upgrade-steps li .step-dot')
      // Mark the first active step as errored so the user can see where it broke.
      dialog.querySelectorAll('#upgrade-steps li').forEach(li => {
        if (li.querySelector('.step-dot').textContent === '●') {
          markStep(li.dataset.step, 'error')
        }
      })
      statusEl.style.color = '#ef4444'
      statusEl.textContent = e.code === 4001 ? 'cancelled' : (e.shortMessage || e.message || 'upgrade failed').slice(0, 200)
      dialog.querySelector('#upgrade-submit').disabled = false
    }
  })
}

// --- Modules Tab ---

// --- Blog collections UI ---

function renderBlogCollectionsSection() {
  const collections = siteData.blogCollections || []
  const postCollections = siteData.blogPostCollections || {}

  let html = `<div style="margin-top:2em;padding-top:1.5em;border-top:1px solid var(--border)">
    <label class="settings-label">blog collections</label>
    <div style="color:var(--dim);font-size:0.8em;margin-bottom:1em">organize on-chain posts into named categories</div>`

  // List existing collections with drag handles
  if (collections.length > 0) {
    _injectEditorCSS()
    html += '<div id="blog-collections-list">'
    for (let i = 0; i < collections.length; i++) {
      const col = collections[i]
      const expanded = _editorExpandedItems.has(`blogcol-${i}`)
      html += `<div class="editor-item" data-drag-idx="${i}" style="border-bottom:1px solid var(--border);padding:0.3em 0">
        <div class="editor-collapse-header" data-toggle-prefix="blogcol" data-toggle-idx="${i}">
          <span class="drag-handle">\u2261</span>
          <span class="collapse-title">${escapeHtml(col.name)}</span>
          <span class="collapse-chevron${expanded ? ' expanded' : ''}">\u25b6</span>
        </div>
        <div class="editor-collapse-body${expanded ? ' expanded' : ''}">
          <div style="padding:0.5em 0 0.5em 1.5em">
            <div style="display:flex;gap:0.5ch;align-items:center;margin-bottom:0.5em">
              <label style="color:var(--dim);font-size:0.8em;width:5ch">name</label>
              <input type="text" class="blogcol-name project-input" data-idx="${i}" value="${escapeHtml(col.name)}" style="flex:1;font-size:0.85em;padding:0.3em 0.5ch">
            </div>
            <div style="display:flex;gap:0.5ch;align-items:center;margin-bottom:0.5em">
              <label style="color:var(--dim);font-size:0.8em;width:5ch">slug</label>
              <input type="text" class="blogcol-slug project-input" data-idx="${i}" value="${escapeHtml(col.slug || '')}" placeholder="auto" style="flex:1;font-size:0.85em;padding:0.3em 0.5ch">
            </div>
            <div style="display:flex;gap:0.5ch;align-items:center;margin-bottom:0.5em">
              <label style="color:var(--dim);font-size:0.8em;width:5ch">desc</label>
              <input type="text" class="blogcol-desc project-input" data-idx="${i}" value="${escapeHtml(col.description || '')}" placeholder="optional" style="flex:1;font-size:0.85em;padding:0.3em 0.5ch">
            </div>
            <button class="buy-btn blogcol-remove" data-idx="${i}" style="font-size:0.75em;padding:0.2em 0.8ch;border-color:var(--dim);color:var(--dim)">remove</button>
          </div>
        </div>
      </div>`
    }
    html += '</div>'
  }

  // Add new collection
  html += `<div style="display:flex;gap:0.5ch;align-items:center;margin-top:0.75em">
    <input type="text" id="blogcol-new-name" class="project-input" placeholder="collection name" style="flex:1;font-size:0.85em;padding:0.3em 0.5ch">
    <button class="buy-btn" id="blogcol-add-btn" style="font-size:0.8em;padding:0.2em 0.8ch">add</button>
  </div>`

  // Post-to-collection assignment
  // This uses on-chain post IDs. We show a mapping UI where the user types a post ID
  // and assigns it to a collection. In practice, this gets populated from the blog index.
  if (collections.length > 0) {
    const assignments = Object.entries(postCollections)
    html += `<div style="margin-top:1.5em;padding-top:1em;border-top:1px solid var(--border)">
      <label class="settings-label">post assignments</label>
      <div style="color:var(--dim);font-size:0.8em;margin-bottom:0.75em">assign on-chain posts to collections by post ID</div>
      <div id="blogcol-assignments">`
    for (const [postId, colSlug] of assignments) {
      html += `<div class="blogcol-assignment" style="display:flex;gap:0.5ch;align-items:center;margin-bottom:0.4em">
        <input type="text" class="blogcol-assign-id project-input" value="${escapeHtml(postId)}" style="width:8ch;font-size:0.8em;padding:0.2em 0.5ch" readonly>
        <select class="blogcol-assign-col project-input" data-post-id="${escapeHtml(postId)}" style="flex:1;font-size:0.8em;padding:0.2em 0.5ch">
          <option value="">uncategorized</option>
          ${collections.map(c => {
            const slug = c.slug || c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
            return `<option value="${slug}" ${slug === colSlug ? 'selected' : ''}>${escapeHtml(c.name)}</option>`
          }).join('')}
        </select>
        <button class="buy-btn blogcol-unassign" data-post-id="${escapeHtml(postId)}" style="font-size:0.75em;padding:0.2em 0.6ch;border-color:var(--dim);color:var(--dim)">x</button>
      </div>`
    }
    html += `</div>
      <div style="display:flex;gap:0.5ch;align-items:center;margin-top:0.5em">
        <input type="text" id="blogcol-assign-new-id" class="project-input" placeholder="post ID" style="width:8ch;font-size:0.8em;padding:0.2em 0.5ch">
        <select id="blogcol-assign-new-col" class="project-input" style="flex:1;font-size:0.8em;padding:0.2em 0.5ch">
          ${collections.map(c => {
            const slug = c.slug || c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
            return `<option value="${slug}">${escapeHtml(c.name)}</option>`
          }).join('')}
        </select>
        <button class="buy-btn" id="blogcol-assign-add-btn" style="font-size:0.8em;padding:0.2em 0.8ch">assign</button>
      </div>
    </div>`
  }

  html += '</div>'
  return html
}

// Hydrate the "hidden projects" panel with the wallet's current hides.
// Renders one row per hidden project id with a "show" button that
// wallet-signs an unhide message and POSTs to /api/portfolio-hide.
async function wireHiddenProjectsHandlers(el) {
  const section = el.querySelector('#hidden-projects-section')
  const listEl = el.querySelector('#hidden-projects-list')
  if (!section || !listEl) return
  const wallet = String(siteData.wallet || '').toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(wallet)) return

  try {
    const res = await fetch(`/api/portfolio-hide/${wallet}`)
    if (!res.ok) return
    const data = await res.json()
    const hidden = data?.hidden || []
    if (!hidden.length) return
    section.style.display = ''
    listEl.innerHTML = hidden.map(h => `
      <div class="hidden-project-row" data-project-id="${escapeHtml(String(h.projectId))}" style="display:flex;justify-content:space-between;align-items:center;padding:0.5em 0.75ch;border:1px solid var(--border);border-radius:6px;margin-bottom:0.4em">
        <span style="color:var(--fg);font-size:0.9em">
          <a href="/project?id=${escapeHtml(String(h.projectId))}" style="color:var(--fg);text-decoration:none">project #${escapeHtml(String(h.projectId))}</a>
          <span style="color:var(--dim);font-size:0.8em;margin-left:0.75ch">hidden ${_relativeTime(h.hiddenAt)}</span>
        </span>
        <button type="button" class="buy-btn hidden-project-show" data-project-id="${escapeHtml(String(h.projectId))}" style="font-size:0.8em;padding:0.2em 1ch">show</button>
      </div>
    `).join('')

    listEl.querySelectorAll('.hidden-project-show').forEach(btn => {
      btn.addEventListener('click', async () => {
        const projectId = Number(btn.dataset.projectId)
        btn.disabled = true
        btn.textContent = 'signing…'
        try {
          const { createWalletClient, custom, optimism } = await import('/js/vendor.js')
          const { getWalletProvider, requireUser } = await import('/js/utils.js')
          const addr = await requireUser('show this project')
          if (!addr) { btn.disabled = false; btn.textContent = 'show'; return }
          const message = `praxis-portfolio-hide:${addr.toLowerCase()}:${projectId}:show:${Date.now()}`
          const account = await window.authorizedSigner?.(addr)
          const walletClient = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })
          const signature = await walletClient.signMessage({ account, message })
          const res = await fetch('/api/portfolio-hide', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ wallet: addr, projectId, action: 'show', signature, message }),
          })
          const data = await res.json()
          if (data.error) throw new Error(data.error)
          btn.closest('.hidden-project-row')?.remove()
          if (!listEl.children.length) section.style.display = 'none'
        } catch (e) {
          btn.disabled = false
          btn.textContent = 'show'
          alert(`could not show: ${e?.message || 'unknown error'}`)
        }
      })
    })
  } catch (e) { console.warn('hidden-projects load failed:', e?.message) }
}

function _relativeTime(unixSec) {
  const diff = Date.now() / 1000 - Number(unixSec || 0)
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

function wireBlogCollectionsHandlers(el) {
  if (!siteData.blogCollections) siteData.blogCollections = []
  if (!siteData.blogPostCollections) siteData.blogPostCollections = {}

  // Wire collapse toggles and drag-drop for collections list
  const listEl = el.querySelector('#blog-collections-list')
  if (listEl) {
    _wireCollapseToggles(listEl, 'blogcol')
    _wireDragDrop(listEl, '.editor-item[data-drag-idx]', (from, to) => {
      _remapExpandedKeys('blogcol', from, to)
      _arrayMove(siteData.blogCollections, from, to)
      renderModulesTab(el)
    })
  }

  // Collection name/slug/desc input handlers
  el.querySelectorAll('.blogcol-name').forEach(input => {
    input.addEventListener('input', () => {
      const idx = parseInt(input.dataset.idx)
      if (siteData.blogCollections[idx]) {
        siteData.blogCollections[idx].name = input.value.trim()
        // auto-update slug if it was auto-generated
        const slugInput = el.querySelector(`.blogcol-slug[data-idx="${idx}"]`)
        if (slugInput && !slugInput.value.trim()) {
          // slug is auto — will be derived from name at build time
        }
      }
    })
  })
  el.querySelectorAll('.blogcol-slug').forEach(input => {
    input.addEventListener('input', () => {
      const idx = parseInt(input.dataset.idx)
      if (siteData.blogCollections[idx]) {
        siteData.blogCollections[idx].slug = input.value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-')
      }
    })
  })
  el.querySelectorAll('.blogcol-desc').forEach(input => {
    input.addEventListener('input', () => {
      const idx = parseInt(input.dataset.idx)
      if (siteData.blogCollections[idx]) {
        siteData.blogCollections[idx].description = input.value.trim()
      }
    })
  })

  // Remove collection
  el.querySelectorAll('.blogcol-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.idx)
      const col = siteData.blogCollections[idx]
      if (!col) return
      const ok = await confirmModal({ title: `remove collection "${col.name}"?`, body: 'posts assigned to this collection will become uncategorized.' })
      if (!ok) return
      const slug = col.slug || col.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
      // Remove all post assignments to this collection
      for (const [postId, colSlug] of Object.entries(siteData.blogPostCollections)) {
        if (colSlug === slug) delete siteData.blogPostCollections[postId]
      }
      siteData.blogCollections.splice(idx, 1)
      renderModulesTab(el)
    })
  })

  // Add new collection
  el.querySelector('#blogcol-add-btn')?.addEventListener('click', () => {
    const nameInput = el.querySelector('#blogcol-new-name')
    const name = nameInput?.value.trim()
    if (!name) return
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    // Check for duplicate slug
    const existing = siteData.blogCollections.find(c => (c.slug || c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')) === slug)
    if (existing) { nameInput.style.borderColor = 'var(--accent)'; return }
    siteData.blogCollections.push({ name, slug, description: '' })
    renderModulesTab(el)
  })

  // Post assignment change
  el.querySelectorAll('.blogcol-assign-col').forEach(sel => {
    sel.addEventListener('change', () => {
      const postId = sel.dataset.postId
      const colSlug = sel.value
      if (colSlug) {
        siteData.blogPostCollections[postId] = colSlug
      } else {
        delete siteData.blogPostCollections[postId]
      }
    })
  })

  // Remove post assignment
  el.querySelectorAll('.blogcol-unassign').forEach(btn => {
    btn.addEventListener('click', () => {
      const postId = btn.dataset.postId
      delete siteData.blogPostCollections[postId]
      renderModulesTab(el)
    })
  })

  // Add new post assignment
  el.querySelector('#blogcol-assign-add-btn')?.addEventListener('click', () => {
    const idInput = el.querySelector('#blogcol-assign-new-id')
    const colSelect = el.querySelector('#blogcol-assign-new-col')
    const postId = idInput?.value.trim()
    const colSlug = colSelect?.value
    if (!postId || !colSlug) return
    siteData.blogPostCollections[postId] = colSlug
    renderModulesTab(el)
  })
}

function renderModulesTab(el) {
  const modules = siteData.modules || []
  const allTypes = ['music', 'audio', 'credits', 'gallery', 'writing', 'film', 'video', 'technology', 'education', 'demos']

  let html = '<div style="max-width:600px">'

  // ensure modules are sorted by order before rendering
  modules.sort((a, b) => (a.order || 99) - (b.order || 99))

  // enabled modules
  for (let i = 0; i < modules.length; i++) {
    const mod = modules[i]
    const isFirst = i === 0
    const isLast = i === modules.length - 1
    const placeholderLabel = effectiveModuleLabel(mod.type)
    const safeType = escapeHtml(mod.type)
    html += `
      <div class="settings-module" data-type="${safeType}">
        <div class="settings-module-header">
          <label>
            <input type="checkbox" class="module-toggle" data-type="${safeType}" ${mod.enabled ? 'checked' : ''}>
            <span style="color:${mod.enabled ? 'var(--accent)' : 'var(--dim)'}">${t('settings.modules.' + mod.type)}</span>
          </label>
          <div class="module-actions">
            <button class="module-move-up" data-type="${safeType}" ${isFirst ? 'disabled style="opacity:0.3"' : ''}><i class="ph ph-caret-up"></i></button>
            <button class="module-move-down" data-type="${safeType}" ${isLast ? 'disabled style="opacity:0.3"' : ''}><i class="ph ph-caret-down"></i></button>
            <button class="module-edit-btn" data-type="${safeType}">${t('settings.modules.edit')}</button>
            <button class="module-remove-btn" data-type="${safeType}" title="${t('settings.modules.remove')}">x</button>
          </div>
        </div>
        <div class="module-label-row">
          <label style="display:flex;align-items:center;gap:0.5ch;cursor:pointer;margin-right:1.5ch">
            <input type="checkbox" class="module-homepage-toggle" data-idx="${i}" ${mod.showOnHomepage !== false ? 'checked' : ''}>
            <span style="color:var(--dim);font-size:0.75em">homepage</span>
          </label>
          <label for="module-label-${i}" style="color:var(--dim);font-size:0.75em;white-space:nowrap">display name</label>
          <input id="module-label-${i}" type="text" class="module-label-input module-custom-label" data-idx="${i}"
            placeholder="${escapeHtml(placeholderLabel)}"
            value="${escapeHtml(mod.customLabel || '')}">
        </div>
      </div>
    `
  }

  // add new modules
  const enabledTypes = modules.map(m => m.type)
  const available = allTypes.filter(tp => !enabledTypes.includes(tp))
  if (available.length) {
    html += `<div style="margin-top:1.5em;padding-top:1em;border-top:1px solid var(--border)">
      <label class="settings-label">${t('settings.modules.addModule')}</label>
      <select id="add-module-select" class="project-input" style="max-width:200px">
        <option value="">${t('settings.modules.choose')}</option>
        ${available.map(tp => `<option value="${tp}">${t('settings.modules.' + tp)}</option>`).join('')}
      </select>
      <button class="buy-btn" id="add-module-btn" style="font-size:0.8em;padding:0.2em 0.8ch;margin-left:0.5ch">${t('settings.modules.add')}</button>
    </div>`
  }

  // --- Blog collections section ---
  html += renderBlogCollectionsSection()

  // --- Hidden projects section ---
  // Owner-only surface to un-hide project cards previously removed from
  // the portfolio strip. Container hydrates async in wireHiddenProjectsHandlers.
  html += `<div id="hidden-projects-section" style="margin-top:2em;padding-top:1.5em;border-top:1px solid var(--border);display:none">
    <label class="settings-label">hidden projects</label>
    <div style="color:var(--dim);font-size:0.8em;margin-bottom:1em">projects you removed from your portfolio strip. bring one back with "show".</div>
    <div id="hidden-projects-list"></div>
  </div>`

  html += '</div>'
  el.innerHTML = html

  // Wire blog collections handlers
  wireBlogCollectionsHandlers(el)
  wireHiddenProjectsHandlers(el)

  // toggle handlers — checkbox enables/disables the module (doesn't remove it)
  el.querySelectorAll('.module-toggle').forEach(cb => {
    cb.addEventListener('change', () => {
      const mod = siteData.modules.find(m => m.type === cb.dataset.type)
      if (mod) mod.enabled = cb.checked
    })
  })

  el.querySelectorAll('.module-homepage-toggle').forEach(cb => {
    cb.addEventListener('change', () => {
      const idx = parseInt(cb.dataset.idx, 10)
      if (siteData.modules[idx]) siteData.modules[idx].showOnHomepage = cb.checked
    })
  })

  // custom label handlers — store customLabel on each module entry
  el.querySelectorAll('.module-custom-label').forEach(input => {
    input.addEventListener('input', () => {
      const idx = parseInt(input.dataset.idx, 10)
      if (siteData.modules[idx]) {
        const val = input.value.trim()
        if (val) {
          siteData.modules[idx].customLabel = val
        } else {
          delete siteData.modules[idx].customLabel
        }
      }
    })
  })

  // remove button handlers — requires typed confirmation via modal
  el.querySelectorAll('.module-remove-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const modType = btn.dataset.type
      const mod = siteData.modules.find(m => m.type === modType)
      const hasData = mod?.data && (Array.isArray(mod.data) ? mod.data.length > 0 : Object.keys(mod.data).length > 0)
      if (hasData) {
        const confirmed = await showRemoveModuleModal(modType)
        if (!confirmed) return
      }
      siteData.modules = siteData.modules.filter(m => m.type !== modType)
      renderModulesTab(el)
    })
  })

  // edit handlers
  el.querySelectorAll('.module-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mod = siteData.modules.find(m => m.type === btn.dataset.type)
      if (mod) _openModuleSubpage(mod)
    })
  })

  // reorder handlers — move module up or down
  el.querySelectorAll('.module-move-up').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.type
      const idx = siteData.modules.findIndex(m => m.type === type)
      if (idx <= 0) return
      // swap order values with the previous module
      const prev = siteData.modules[idx - 1]
      const curr = siteData.modules[idx]
      const tmpOrder = prev.order
      prev.order = curr.order
      curr.order = tmpOrder
      // also swap positions in the array to keep in sync
      siteData.modules[idx - 1] = curr
      siteData.modules[idx] = prev
      renderModulesTab(el)
    })
  })

  el.querySelectorAll('.module-move-down').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.type
      const idx = siteData.modules.findIndex(m => m.type === type)
      if (idx < 0 || idx >= siteData.modules.length - 1) return
      // swap order values with the next module
      const next = siteData.modules[idx + 1]
      const curr = siteData.modules[idx]
      const tmpOrder = next.order
      next.order = curr.order
      curr.order = tmpOrder
      // also swap positions in the array to keep in sync
      siteData.modules[idx + 1] = curr
      siteData.modules[idx] = next
      renderModulesTab(el)
    })
  })

  // add module
  document.getElementById('add-module-btn')?.addEventListener('click', () => {
    const type = document.getElementById('add-module-select')?.value
    if (!type) return
    siteData.modules.push({ type, enabled: true, order: siteData.modules.length + 1, data: type === 'credits' ? { items: [], categoryOrder: [], resumePdf: '', resumeLabel: '' } : type === 'demos' ? { items: [] } : {} })
    renderModulesTab(el)
  })
}

// "list for sale" widget — shows on any media item with an IPFS file
function renderSellWidget(item, id) {
  // only show if item has media content (src, art, video, or ipfsCid)
  const hasMedia = item.src || item.art || item.video || item.ipfsCid
  if (!hasMedia) return ''

  if (item.mediaId !== undefined && item.mediaId !== null && item.mediaId !== '') {
    // already listed on-chain — show price editor
    // If the item is delisted, show clear delisted state + relist UX. The user
    // can type a new price and click "relist" which calls setMediaPrice — same
    // media id, same collaborators. To change collaborators, the artist needs
    // to create a fresh listing (which auto-supersedes via annotateRelistings).
    const isDelisted = item._delisted === true
    const currentPrice = item.mediaPrice ? (Number(item.mediaPrice) / 1e18).toFixed(4) : '0'
    const borderColor = isDelisted ? 'var(--dim)' : 'var(--green)'
    const headerColor = isDelisted ? 'var(--dim)' : 'var(--green)'
    const headerText = isDelisted
      ? `delisted (id: ${item.mediaId}) — set a new price and relist`
      : `listed on-chain (id: ${item.mediaId})`
    const actionLabel = isDelisted ? 'relist' : 'update price'
    return `<div style="margin-top:0.5em;padding:0.5em;border:1px solid ${borderColor};font-size:0.8em">
      <span style="color:${headerColor}">${headerText}</span>
      <div style="display:flex;gap:0.5ch;align-items:center;margin-top:0.5em">
        <input type="text" class="media-price-edit project-input" data-media-id="${item.mediaId}" value="${isDelisted ? '' : currentPrice}" placeholder="${isDelisted ? '0.01' : 'ETH'}" style="width:8ch;font-size:0.85em;padding:0.2em 0.5ch">
        <span style="color:var(--dim)">ETH</span>
        <span class="media-price-fiat" data-media-id="${item.mediaId}" style="color:var(--dim)"></span>
        <button class="buy-btn media-update-price-btn" data-media-id="${item.mediaId}" data-relist="${isDelisted ? '1' : '0'}" style="font-size:0.8em;padding:0.2em 1ch">${actionLabel}</button>
      </div>
      <span class="media-price-status" data-media-id="${item.mediaId}" style="color:var(--muted);font-size:0.85em"></span>
      ${isDelisted
        ? `<div style="margin-top:0.75em;padding-top:0.75em;border-top:1px solid var(--border)">
            <div style="color:var(--dim);font-size:0.75em;margin-bottom:0.4em">to change collaborators or splits, create a fresh listing — it will auto-supersede this one on /works.</div>
            <button class="buy-btn media-fresh-listing-btn" data-media-id="${item.mediaId}" style="font-size:0.8em;padding:0.2em 1ch">create fresh listing</button>
          </div>`
        : `<button class="buy-btn media-delist-btn" data-media-id="${item.mediaId}" style="font-size:0.8em;padding:0.2em 1ch;margin-top:0.5em;border-color:var(--dim);color:var(--dim)">delist</button>`}
    </div>`
  }

  return `<div class="sell-widget" id="${id}" style="margin-top:0.75em;padding:0.75em 1em;border:1px solid var(--border);border-radius:8px;font-size:0.85em">
    <label style="display:flex;align-items:center;gap:0.6ch;cursor:pointer;color:var(--fg);font-weight:500">
      <input type="checkbox" class="sell-toggle" data-id="${id}" ${item._forSale ? 'checked' : ''} style="accent-color:var(--accent)">
      sell this work
    </label>
    <div class="sell-options" style="display:${item._forSale ? 'block' : 'none'};margin-top:0.75em;padding-top:0.75em;border-top:1px solid var(--border)">
      <div style="display:flex;gap:0.75em;align-items:center;flex-wrap:wrap;margin-bottom:0.75em">
        <div style="display:flex;align-items:center;gap:0.4ch">
          <input type="text" class="project-input sell-price" data-id="${id}" value="${item.mediaPrice ? (Number(item.mediaPrice) / 1e18) : ''}" placeholder="0.01" style="width:8ch;font-size:0.9em;padding:0.35em 0.5ch;border-radius:4px">
          <span style="color:var(--dim)">ETH</span>
          <span class="sell-price-fiat" data-id="${id}" style="color:var(--dim)"></span>
        </div>
        <div style="display:flex;align-items:center;gap:0.4ch">
          <input type="number" class="project-input sell-supply" data-id="${id}" value="${item.mediaMaxSupply || ''}" placeholder="unlimited" style="width:10ch;font-size:0.9em;padding:0.35em 0.5ch;border-radius:4px">
          <span style="color:var(--dim)">supply</span>
        </div>
      </div>
      <div class="sell-splits" data-id="${id}" style="margin-bottom:0.75em">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.4em">
          <span style="color:var(--dim);font-size:0.85em">revenue splits</span>
          <button class="sell-add-split" data-id="${id}" style="background:none;border:1px solid var(--border);color:var(--muted);font-family:inherit;font-size:0.8em;padding:0.2em 0.7ch;cursor:pointer;border-radius:4px">+ collaborator</button>
        </div>
        <div class="sell-split-list" data-id="${id}"></div>
        <div style="color:var(--dim);font-size:0.75em;margin-top:0.3em">leave empty for 100% to you</div>
      </div>
      <button class="buy-btn sell-list-btn" data-id="${id}" style="font-size:0.85em;padding:0.4em 1.5ch;border-radius:4px">publish listing</button>
      <span class="sell-status" data-id="${id}" style="color:var(--muted);font-size:0.85em;margin-left:0.5ch"></span>
    </div>
  </div>`
}

// Add a collaborator split row to a batch split list container
function _addBatchSplitRow(list) {
  const row = document.createElement('div')
  row.style.cssText = 'display:flex;gap:0.5em;align-items:center;margin-top:0.25em;position:relative'
  row.innerHTML = `
    <div style="flex:1;position:relative">
      <input type="text" class="project-input batch-split-addr" placeholder="search artist..." autocomplete="off" style="width:100%;font-size:0.8em">
      <div class="batch-split-suggest" style="display:none;position:absolute;top:100%;left:0;right:0;background:var(--bg,#111);border:1px solid var(--border);z-index:10;max-height:150px;overflow-y:auto"></div>
    </div>
    <input type="number" class="project-input batch-split-pct" placeholder="%" style="width:6ch;font-size:0.8em">
    <span style="color:var(--dim);font-size:0.8em">%</span>
    <button style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:0.8em" onclick="this.parentElement.remove()">x</button>
  `
  // Autocomplete from /api/network/search
  const input = row.querySelector('.batch-split-addr')
  const suggest = row.querySelector('.batch-split-suggest')
  let debounce = null
  input.addEventListener('input', () => {
    clearTimeout(debounce)
    const q = input.value.trim()
    if (q.length < 2) { suggest.style.display = 'none'; return }
    debounce = setTimeout(async () => {
      try {
        const resp = await fetch(`/api/network/search?q=${encodeURIComponent(q)}&limit=5`)
        const data = await resp.json()
        const items = data.results || data.items || data.artists || []
        if (items.length === 0) { suggest.style.display = 'none'; return }
        suggest.innerHTML = items.map(a => `<div class="batch-suggest-item" data-domain="${escapeHtml(a.name || a.domain || '')}" style="padding:0.4em 0.6em;cursor:pointer;font-size:0.85em;border-bottom:1px solid var(--border)">${escapeHtml(a.name || a.domain || a.id || '')}</div>`).join('')
        suggest.style.display = 'block'
        suggest.querySelectorAll('.batch-suggest-item').forEach(item => {
          item.addEventListener('click', () => {
            input.value = item.dataset.domain
            suggest.style.display = 'none'
          })
        })
      } catch { suggest.style.display = 'none' }
    }, 200)
  })
  input.addEventListener('blur', () => { setTimeout(() => { suggest.style.display = 'none' }, 200) })
  list.appendChild(row)
}

// Collect collaborators and splits from a batch split list container
// Returns { collaborators, splits } or { error } string
async function _collectBatchSplits(splitList) {
  // Only select direct child rows that have a batch-split-addr input
  const rows = splitList?.querySelectorAll(':scope > div') || []
  let collaborators = []
  let splits = []
  const myAddr = window.getWalletAddress()
  const myDomain = window.location.hostname

  for (const row of rows) {
    const addrInput = row.querySelector('.batch-split-addr')
    if (!addrInput) continue
    const addr = addrInput.value.trim()
    const pct = parseInt(row.querySelector('.batch-split-pct')?.value) || 0
    if (!addr || !pct) continue

    // Skip self-row (readonly) — we'll calculate our share as the remainder
    if (addrInput.readOnly || addr === myDomain) {
      continue
    }

    let resolved = addr
    if (!addr.startsWith('0x')) {
      try {
        const resp = await fetch(`/api/network/search?q=${encodeURIComponent(addr)}&limit=1`)
        const data = await resp.json()
        const match = (data.results || []).find(r => r.name === addr || r.domain === addr)
        if (!match?.id) return { error: `can't resolve ${addr}` }
        resolved = match.id
      } catch { return { error: `can't resolve ${addr}` } }
    }
    collaborators.push(resolved)
    splits.push(pct * 100)
  }

  if (collaborators.length > 0) {
    // Calculate artist's share as remainder
    const collabTotal = splits.reduce((a, b) => a + b, 0)
    const myShare = 10000 - collabTotal
    if (myShare < 0) return { error: 'splits exceed 100%' }
    collaborators.unshift(myAddr)
    splits.unshift(myShare)
  }

  return { collaborators, splits }
}

// wire sell widget events after editor renders
function wireSellWidgets(el, getItemByWidgetId) {
  // ---- Detect delisted on-chain state for any rows that show "listed on-chain"
  // but aren't already tagged with _delisted in site.json. Catches items that
  // were delisted via older delistMedia calls predating the _delisted flag.
  // Non-blocking: the row stays interactive while the check runs.
  ;(async () => {
    const rows = el.querySelectorAll('.media-update-price-btn[data-media-id]')
    const mediaIds = Array.from(rows).map(b => b.dataset.mediaId).filter(Boolean)
    if (!mediaIds.length) return
    try {
      const { MEDIA_ABI, getMediaAddress } = await import('./contracts.js')
      const address = getMediaAddress()
      if (!address) return
      const { createPublicClient, http } = await import('./vendor.js')
      const { optimism } = await import('./vendor.js')
      const pc = createPublicClient({ chain: optimism, transport: http() })
      const SENTINEL = 2n ** 128n
      let anyChanged = false
      // Batch all media() reads in a single multicall — was N serial RPC round-trips
      // (would stall the editor for 5-10 seconds on artists with 50+ items).
      const calls = mediaIds.map(id => ({
        address, abi: MEDIA_ABI, functionName: 'media', args: [BigInt(id)],
      }))
      let results
      try {
        results = await pc.multicall({ contracts: calls, allowFailure: true })
      } catch {
        results = []
      }
      for (let i = 0; i < mediaIds.length; i++) {
        const id = mediaIds[i]
        const r = results[i]
        if (!r || r.status !== 'success') continue
        try {
          const tuple = r.result
          // media() returns [artist, title, ipfsCid, metadataCid, price, maxSupply, totalMinted]
          const onChainPrice = BigInt(tuple[4] || 0n)
          const isDelistedNow = onChainPrice >= SENTINEL
          // Find the item in site.json by mediaId
          let item = null
          for (const mod of (siteData?.modules || [])) {
            const data = mod.data || {}
            const lists = []
            if (data.aliases) for (const a of data.aliases) for (const al of (a.albums || [])) lists.push(al.tracks || [])
            ;[data.items, data.images, data.films, data.videos, data.works, data.entries, data.publications].forEach(l => l && lists.push(l))
            for (const list of lists) {
              for (const it of list) {
                if (String(it?.mediaId) === String(id)) { item = it; break }
              }
              if (item) break
            }
            if (item) break
          }
          if (!item) continue
          if (isDelistedNow && !item._delisted) {
            item._delisted = true
            anyChanged = true
          } else if (!isDelistedNow && item._delisted) {
            delete item._delisted
            anyChanged = true
          }
        } catch {}
      }
      if (anyChanged) {
        try { await api('/api/site', { method: 'PUT', body: JSON.stringify(siteData) }) } catch {}
        // Re-render the closest module editor so the new state is reflected
        const modEditor = el.closest('.module-editor')
        if (modEditor) {
          const wrapper = modEditor.closest('.settings-module')
          const modType = wrapper?.dataset?.type
          if (modType) {
            const mod = (siteData?.modules || []).find(m => m.type === modType)
            if (mod) renderModuleEditor(modEditor, mod)
          }
        }
      }
    } catch {}
  })()

  el.querySelectorAll('.sell-toggle').forEach(cb => {
    cb.addEventListener('change', () => {
      const opts = cb.closest('.sell-widget')?.querySelector('.sell-options')
      if (opts) opts.style.display = cb.checked ? 'block' : 'none'
      const item = getItemByWidgetId(cb.dataset.id)
      if (item) item._forSale = cb.checked
    })
  })

  // fiat conversion for sell price inputs
  el.querySelectorAll('.sell-price').forEach(input => {
    const updateSellFiat = async () => {
      const fiatEl = el.querySelector(`.sell-price-fiat[data-id="${input.dataset.id}"]`)
      if (!fiatEl) return
      const eth = parseFloat(input.value) || 0
      if (eth <= 0) { fiatEl.textContent = ''; return }
      try {
        const { getEthPrices, getUserCurrency, formatFiat } = await import('./fiat.js')
        const prices = await getEthPrices()
        if (!prices) return
        const currency = getUserCurrency()
        const rate = prices[currency] || prices.usd
        if (rate) fiatEl.textContent = `(~${formatFiat(eth * rate, currency)})`
      } catch {}
    }
    updateSellFiat()
    input.addEventListener('input', updateSellFiat)
  })

  // add collaborator split rows
  el.querySelectorAll('.sell-add-split').forEach(btn => {
    btn.addEventListener('click', () => {
      const list = el.querySelector(`.sell-split-list[data-id="${btn.dataset.id}"]`)
      if (!list) return
      const row = document.createElement('div')
      row.style.cssText = 'display:flex;gap:0.5em;align-items:center;margin-top:0.25em;position:relative'
      row.innerHTML = `
        <div style="flex:1;position:relative">
          <input type="text" class="project-input split-addr" placeholder="search artist..." autocomplete="off" style="width:100%;font-size:0.8em">
          <div class="split-suggest" style="display:none;position:absolute;top:100%;left:0;right:0;background:var(--bg,#111);border:1px solid var(--border);z-index:10;max-height:150px;overflow-y:auto"></div>
        </div>
        <input type="number" class="project-input split-pct" placeholder="%" style="width:6ch;font-size:0.8em">
        <span style="color:var(--dim);font-size:0.8em">%</span>
        <button style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:0.8em" onclick="this.parentElement.remove()">x</button>
      `
      // Autocomplete
      const input = row.querySelector('.split-addr')
      const suggest = row.querySelector('.split-suggest')
      let debounce = null
      input.addEventListener('input', () => {
        clearTimeout(debounce)
        const q = input.value.trim()
        if (q.length < 2) { suggest.style.display = 'none'; return }
        debounce = setTimeout(async () => {
          try {
            const resp = await fetch(`/api/network/search?q=${encodeURIComponent(q)}&limit=5`)
            const data = await resp.json()
            const items = data.results || data.items || data.artists || []
            if (items.length === 0) { suggest.style.display = 'none'; return }
            suggest.innerHTML = items.map(a => `<div class="suggest-item" data-domain="${escapeHtml(a.name || a.domain || '')}" style="padding:0.4em 0.6em;cursor:pointer;font-size:0.85em;border-bottom:1px solid var(--border)">${escapeHtml(a.name || a.domain || a.id || '')}</div>`).join('')
            suggest.style.display = 'block'
            suggest.querySelectorAll('.suggest-item').forEach(item => {
              item.addEventListener('click', () => { input.value = item.dataset.domain; suggest.style.display = 'none' })
            })
          } catch { suggest.style.display = 'none' }
        }, 200)
      })
      input.addEventListener('blur', () => setTimeout(() => { suggest.style.display = 'none' }, 200))
      list.appendChild(row)
    })
  })

  el.querySelectorAll('.sell-list-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const widgetId = btn.dataset.id
      const statusEl = el.querySelector(`.sell-status[data-id="${widgetId}"]`)
      const priceInput = el.querySelector(`.sell-price[data-id="${widgetId}"]`)
      const supplyInput = el.querySelector(`.sell-supply[data-id="${widgetId}"]`)
      const splitList = el.querySelector(`.sell-split-list[data-id="${widgetId}"]`)
      const item = getItemByWidgetId(widgetId)
      if (!item) return

      const mediaSrc = item.src || item.art || item.video || ''
      if (!mediaSrc) { statusEl.textContent = 'no media file'; return }

      // extract IPFS CID from URL
      const cidMatch = mediaSrc.match(/ipfs-proxy\/([A-Za-z0-9]+)/)
      const cid = cidMatch ? cidMatch[1] : ''
      if (!cid) { statusEl.textContent = 'not on IPFS'; return }

      const priceEth = parseFloat(priceInput?.value || '0')
      const maxSupply = parseInt(supplyInput?.value || '0') || 0
      const title = item.title || item.name || 'untitled'

      // collect splits from rows
      const splitRows = splitList?.querySelectorAll('div') || []
      let collaborators = []
      let splits = []

      if (splitRows.length > 0) {
        const myAddr = window.getWalletAddress()
        let myPct = 10000 // start with 100%

        for (const row of splitRows) {
          const addr = row.querySelector('.split-addr')?.value.trim()
          const pct = parseInt(row.querySelector('.split-pct')?.value) || 0
          if (!addr || !pct) continue
          // resolve domain to address if needed
          let resolved = addr
          if (!addr.startsWith('0x')) {
            try {
              const resp = await fetch(`/api/network/search?q=${encodeURIComponent(addr)}&limit=1`)
              const data = await resp.json()
              const match = (data.results || []).find(r => r.name === addr || r.domain === addr)
              if (!match?.id) { statusEl.textContent = `can't resolve ${addr}`; return }
              resolved = match.id
            } catch { statusEl.textContent = `can't resolve ${addr}`; return }
          }
          collaborators.push(resolved)
          splits.push(pct * 100) // convert % to basis points
          myPct -= pct * 100
        }

        if (myPct < 0) { statusEl.textContent = 'splits exceed 100%'; return }

        // add self with remainder
        collaborators.unshift(myAddr)
        splits.unshift(myPct)
      }

      try {
        const { listMedia } = await import('./media.js')

        // Check if this CID is already listed on-chain (prevent duplicates)
        try {
          const { query } = await import('./ponder.js')
          const existing = await query(`query CheckDup($artist: String!, $cid: String!) {
            mediaListings(where: { artist: $artist, ipfsCid: $cid }, limit: 1) {
              items { id }
            }
          }`, { artist: window.getWalletAddress().toLowerCase(), cid })
          const existingId = existing?.mediaListings?.items?.[0]?.id
          if (existingId !== undefined) {
            item.mediaId = existingId.toString()
            item.mediaPrice = parseEther(String(priceEth)).toString()
            statusEl.textContent = `already listed (id: ${existingId}) — linking...`
            btn.style.display = 'none'
            // Auto-save to persist the linked mediaId
            try {
              await api('/api/site', { method: 'PUT', body: JSON.stringify(siteData) })
              statusEl.textContent = `linked to existing listing (id: ${existingId})`
            } catch { statusEl.textContent = `linked (id: ${existingId}) — click save` }
            return
          }
        } catch {}

        statusEl.textContent = 'confirm in wallet...'
        // extract cover art CID if available (from album art)
        const artSrc = item._albumArt || item.art || item.coverArt || ''
        const artCidMatch = artSrc.match(/ipfs-proxy\/([A-Za-z0-9]+)/)
        const metadataCid = artCidMatch ? artCidMatch[1] : ''
        const mediaId = await listMedia(title, cid, metadataCid, priceEth, maxSupply, collaborators, splits)
        item.mediaId = mediaId.toString()
        item.mediaPrice = parseEther(String(priceEth)).toString()
        item.mediaMaxSupply = maxSupply
        statusEl.textContent = `listed (id: ${mediaId}) — saving...`
        btn.style.display = 'none'
        // auto-save so mediaId persists without manual save
        try {
          await api('/api/site', { method: 'PUT', body: JSON.stringify(siteData) })
          statusEl.textContent = `listed (id: ${mediaId}) — saved`
        } catch { statusEl.textContent = `listed (id: ${mediaId}) — save failed, click save` }
      } catch (e) {
        statusEl.textContent = e.code === 4001 ? 'cancelled' : `error: ${(e.shortMessage || e.message || '').slice(0, 80)}`
      }
    })
  })

  // fiat conversion for listed prices
  {
    const updateFiat = async (input) => {
      const fiatEl = el.querySelector(`.media-price-fiat[data-media-id="${input.dataset.mediaId}"]`)
      if (!fiatEl) return
      const eth = parseFloat(input.value) || 0
      if (eth <= 0) { fiatEl.textContent = ''; return }
      try {
        const { getEthPrices, getUserCurrency, formatFiat } = await import('./fiat.js')
        const prices = await getEthPrices()
        if (!prices) { fiatEl.textContent = ''; return }
        const currency = getUserCurrency()
        const rate = prices[currency] || prices.usd
        if (!rate) { fiatEl.textContent = ''; return }
        fiatEl.textContent = `(~${formatFiat(eth * rate, currency)})`
      } catch { fiatEl.textContent = '' }
    }
    el.querySelectorAll('.media-price-edit').forEach(input => {
      updateFiat(input) // show on load
      input.addEventListener('input', () => updateFiat(input))
    })
  }
  // Helper: find an item in siteData modules by mediaId so delist/relist can
  // toggle the local _delisted flag and persist it. Returns null if not found.
  function findItemByMediaId(mediaId) {
    const idStr = String(mediaId)
    for (const mod of (siteData?.modules || [])) {
      const data = mod.data || {}
      // music: data.aliases[].albums[].tracks[]
      if (mod.type === 'music' && Array.isArray(data.aliases)) {
        for (const alias of data.aliases) {
          for (const album of (alias.albums || [])) {
            for (const tr of (album.tracks || [])) {
              if (String(tr.mediaId) === idStr) return tr
            }
          }
        }
      }
      // gallery, video, audio, demos, writing, film, technology — items[] or images[]
      const lists = [data.items, data.images, data.films, data.videos, data.works, data.entries].filter(Array.isArray)
      for (const list of lists) {
        for (const it of list) {
          if (String(it?.mediaId) === idStr) return it
        }
      }
    }
    return null
  }

  async function persistSiteData() {
    try { await api('/api/site', { method: 'PUT', body: JSON.stringify(siteData) }) } catch {}
  }

  // "create fresh listing" — clears the on-chain mediaId from the local item
  // so the next render shows the unlisted "list for sale" form, where the
  // owner can set new collaborators/splits and call listMedia again. This
  // creates a new on-chain listing with the same ipfsCid; annotateRelistings
  // automatically supersedes the old one on /works and /art surfaces.
  el.querySelectorAll('.media-fresh-listing-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const mediaId = btn.dataset.mediaId
      const ok = await confirmModal({
        title: 'create a fresh listing?',
        body: 'this opens the list-for-sale form again so you can set new collaborators and splits. the existing listing stays on-chain (delisted) — once the new one is published, /works and /art will show the new one and the old becomes a historical record.',
        confirmLabel: 'continue',
        danger: false,
      })
      if (!ok) return
      const item = findItemByMediaId(mediaId)
      if (!item) return
      // Stash the previous listing data so we can show it as "previous version"
      // metadata if needed later. For now we just clear the active fields.
      delete item.mediaId
      delete item.mediaPrice
      delete item.mediaMaxSupply
      delete item._delisted
      item._forSale = true // pre-toggle the sell form so the user lands on it
      await persistSiteData()
      // Re-render the closest module editor
      const modEditor = el.closest('.module-editor')
      if (modEditor) {
        const wrapper = modEditor.closest('.settings-module')
        const modType = wrapper?.dataset?.type
        if (modType) {
          const mod = (siteData?.modules || []).find(m => m.type === modType)
          if (mod) renderModuleEditor(modEditor, mod)
        }
      }
    })
  })

  // delist a listed media item
  el.querySelectorAll('.media-delist-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const mediaId = btn.dataset.mediaId
      const statusEl = el.querySelector(`.media-price-status[data-media-id="${mediaId}"]`)
      // Confirm — delisting is destructive (the item disappears from /works)
      const ok = await confirmModal({
        title: 'delist this work?',
        body: 'it will be removed from your works for sale page. you can relist it later with a new price (collaborators stay the same — to change them, create a new listing).',
        confirmLabel: 'delist',
      })
      if (!ok) return
      btn.textContent = 'delisting...'
      try {
        const { delistMedia } = await import('./media.js')
        await delistMedia(parseInt(mediaId))
        btn.textContent = 'delisted'
        if (statusEl) statusEl.textContent = 'delisted — no more purchases possible'
        // mark in site.json so the next render shows the relist UX
        const item = findItemByMediaId(mediaId)
        if (item) { item._delisted = true; await persistSiteData() }
      } catch (e) {
        btn.textContent = 'delist'
        if (statusEl) statusEl.textContent = e.code === 4001 ? 'cancelled' : `error: ${(e.message || '').slice(0, 30)}`
      }
    })
  })
  // update price OR relist (when previously delisted)
  el.querySelectorAll('.media-update-price-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const mediaId = btn.dataset.mediaId
      const isRelist = btn.dataset.relist === '1'
      const priceInput = el.querySelector(`.media-price-edit[data-media-id="${mediaId}"]`)
      const statusEl = el.querySelector(`.media-price-status[data-media-id="${mediaId}"]`)
      const newPrice = parseFloat(priceInput?.value || '0')
      if (isNaN(newPrice) || newPrice < 0) { if (statusEl) statusEl.textContent = 'invalid price'; return }
      btn.textContent = isRelist ? 'relisting...' : 'updating...'
      try {
        const { setMediaPrice } = await import('./media.js')
        await setMediaPrice(parseInt(mediaId), newPrice)
        btn.textContent = isRelist ? 'relisted' : 'updated'
        if (statusEl) statusEl.textContent = isRelist ? 'relisted on-chain — visible on /works again' : 'price updated on-chain'
        // clear delisted state in site.json so the row flips back to normal
        const item = findItemByMediaId(mediaId)
        if (item) {
          if (item._delisted) { delete item._delisted }
          item.mediaPrice = (newPrice * 1e18).toString()
          await persistSiteData()
        }
      } catch (e) {
        btn.textContent = isRelist ? 'relist' : 'update price'
        if (statusEl) statusEl.textContent = e.code === 4001 ? 'cancelled' : `error: ${(e.message || '').slice(0, 30)}`
      }
    })
  })
}

// Shared handler for removing a collaborator tag from any module type
async function _handleRemoveCollabTag(btn, collabItems, el, mod) {
  const domain = btn.dataset.domain
  const itemTitle = btn.dataset.title
  const ok = await confirmModal({
    title: `remove collaborator "${domain}"?`,
    body: `this will remove ${domain} as a collaborator on "${itemTitle}". the item will be removed from their site.`,
    confirmLabel: 'remove',
  })
  if (!ok) return
  btn.textContent = '...'
  try {
    const collabRes = await fetch(`/api/collaborations?wallet=${window.getWalletAddress?.()?.toLowerCase()}`)
    if (collabRes.ok) {
      const collabs = await collabRes.json()
      const match = collabs.find(c => c.fromDomain === (siteData?.domain || location.hostname) && c.toDomain === domain && c.itemTitle === itemTitle && c.status === 'accepted')
      if (match) {
        await fetch(`/api/collaborations/${match.id}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${await getSettingsToken()}` },
        })
      }
    }
    for (const item of collabItems) {
      if (item._collabs) {
        const idx = item._collabs.indexOf(domain)
        if (idx >= 0) item._collabs.splice(idx, 1)
      }
    }
    renderModuleEditor(el, mod)
  } catch { btn.textContent = 'error' }
}

function _openModuleSubpage(mod) {
  const contentEl = document.getElementById('settings-content')
  if (!contentEl) return
  _activeSubpage = { type: mod.type, mod }

  // Hide tabs
  const tabs = document.querySelector('.settings-tabs')
  if (tabs) tabs.style.display = 'none'

  const label = mod.customLabel || t('settings.modules.' + mod.type) || mod.type
  contentEl.innerHTML = `
    <div class="settings-subpage">
      <div class="settings-subpage-header">
        <button class="settings-subpage-back" id="subpage-back">
          <i class="ph ph-arrow-left"></i> modules
        </button>
        <span class="settings-subpage-title">${escapeHtml(label)}</span>
        <span id="settings-status" style="font-size:0.75em;color:var(--muted);margin-left:auto"></span>
      </div>
      <div id="subpage-editor-content" data-module-type="${escapeHtml(mod.type)}"></div>
    </div>
  `

  document.getElementById('subpage-back').addEventListener('click', () => {
    _activeSubpage = null
    if (tabs) tabs.style.display = ''
    // Re-render modules tab
    const tabContent = document.getElementById('settings-content')
    if (tabContent) {
      tabContent.innerHTML = ''
      renderModulesTab(tabContent)
    }
  })

  const editorEl = document.getElementById('subpage-editor-content')
  renderModuleEditor(editorEl, mod)
}

function renderModuleEditor(el, mod) {
  _injectEditorCSS()
  const type = mod.type
  const data = mod.data

  if (type === 'credits') {
    // backward-compat: data can be a flat array (old) or { items, categoryOrder, resumePdf, resumeLabel }
    if (Array.isArray(data)) mod.data = { items: data, categoryOrder: [], resumePdf: '', resumeLabel: '' }
    const creditsData = mod.data
    const items = creditsData.items || []
    creditsData.items = items
    if (!creditsData.categoryOrder) creditsData.categoryOrder = []
    // build global category list from existing credits
    const _allCats = [...new Set(items.map(c => c.category).filter(Boolean))]
    // ensure categoryOrder includes all used categories
    for (const cat of _allCats) { if (!creditsData.categoryOrder.includes(cat)) creditsData.categoryOrder.push(cat) }

    // --- resume PDF section ---
    const resumeHtml = `<div style="border:1px solid var(--border);padding:0.75em;margin-bottom:1em">
      <div style="display:flex;align-items:center;gap:0.75em;flex-wrap:wrap">
        <span style="color:var(--muted);font-size:0.85em">resume PDF</span>
        <button class="buy-btn credits-upload-resume" style="font-size:0.75em;padding:0.2em 0.8ch">${creditsData.resumePdf ? 'replace PDF' : 'upload PDF'}</button>
        ${creditsData.resumePdf ? `<button class="credits-remove-resume" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:0.75em">remove</button>` : ''}
        <input class="project-input credits-resume-label" value="${escapeHtml(creditsData.resumeLabel || '')}" placeholder="button label (e.g. download resume)" style="flex:1;min-width:120px;font-size:0.85em">
      </div>
      ${creditsData.resumePdf ? `<div style="margin-top:0.4em;font-size:0.75em;color:var(--dim)">uploaded: ${escapeHtml(creditsData.resumePdf.split('/').pop())}</div>` : ''}
    </div>`

    // --- category order section ---
    const catOrderHtml = creditsData.categoryOrder.length > 1 ? `<div style="border:1px solid var(--border);padding:0.75em;margin-bottom:1em">
      <span style="color:var(--muted);font-size:0.85em;display:block;margin-bottom:0.4em">category order</span>
      <div class="credits-cat-order" style="display:flex;flex-direction:column;gap:0.25em">
        ${creditsData.categoryOrder.map((cat, ci) => `<div style="display:flex;align-items:center;gap:0.5em" data-cat-idx="${ci}">
          <span style="color:var(--fg);font-size:0.85em;flex:1">${escapeHtml(cat)}</span>
          <button class="cat-order-up" data-ci="${ci}" style="background:none;border:1px solid var(--border);color:var(--muted);cursor:pointer;font-size:0.75em;padding:0.1em 0.4ch;line-height:1" ${ci === 0 ? 'disabled' : ''}>\u25B2</button>
          <button class="cat-order-down" data-ci="${ci}" style="background:none;border:1px solid var(--border);color:var(--muted);cursor:pointer;font-size:0.75em;padding:0.1em 0.4ch;line-height:1" ${ci === creditsData.categoryOrder.length - 1 ? 'disabled' : ''}>\u25BC</button>
        </div>`).join('')}
      </div>
    </div>` : ''

    // --- credits items ---
    el.innerHTML = resumeHtml + catOrderHtml + items.map((c, i) => {
      const _exp = _editorExpandedItems.has(`credits-${i}`)
      const _tl = escapeHtml(c.title || c.role || c.org || 'untitled credit')
      const catLabel = c.category ? ` \u2014 ${escapeHtml(c.category)}` : ''
      return `
      <div class="editor-item" data-index="${i}" data-drag-idx="${i}">
        <div class="editor-collapse-header" data-toggle-idx="${i}" data-toggle-prefix="credits">
          <span class="drag-handle">\u2261</span>
          <span class="collapse-title">${_tl}${c.year ? ' (' + escapeHtml(String(c.year)) + ')' : ''}${catLabel}</span>
          <span class="collapse-chevron ${_exp ? 'expanded' : ''}">\u25B8</span>
        </div>
        <div class="editor-collapse-body ${_exp ? 'expanded' : ''}">
        <div style="display:grid;gap:0.5em;grid-template-columns:1fr 1fr">
          <input class="project-input ed-field" data-i="${i}" data-f="title" value="${escapeHtml(c.title || '')}" placeholder="${t('settings.credits.title')}">
          <input class="project-input ed-field" data-i="${i}" data-f="role" value="${escapeHtml(c.role || '')}" placeholder="role (e.g. actor, director, writer)">
          <input class="project-input ed-field" data-i="${i}" data-f="characterName" value="${escapeHtml(c.characterName || '')}" placeholder="character name">
          <input class="project-input ed-field" data-i="${i}" data-f="org" value="${escapeHtml(c.org || '')}" placeholder="${t('settings.credits.organization')}">
          <input class="project-input ed-field" data-i="${i}" data-f="year" type="number" value="${escapeHtml(String(c.year || ''))}" placeholder="${t('settings.credits.year')}">
          <input class="project-input ed-field" data-i="${i}" data-f="director" value="${escapeHtml(c.director || '')}" placeholder="director">
          <input class="project-input ed-field" data-i="${i}" data-f="venue" value="${escapeHtml(c.venue || '')}" placeholder="venue">
          <input class="project-input ed-field" data-i="${i}" data-f="productionCompany" value="${escapeHtml(c.productionCompany || '')}" placeholder="production company">
          <input class="project-input ed-field" data-i="${i}" data-f="startDate" value="${escapeHtml(c.startDate || '')}" placeholder="start date">
          <input class="project-input ed-field" data-i="${i}" data-f="endDate" value="${escapeHtml(c.endDate || '')}" placeholder="end date">
          <input class="project-input ed-field" data-i="${i}" data-f="choreographer" value="${escapeHtml(c.choreographer || '')}" placeholder="choreographer">
          <input class="project-input ed-field" data-i="${i}" data-f="musicDirector" value="${escapeHtml(c.musicDirector || '')}" placeholder="music director">
          <input class="project-input ed-field" data-i="${i}" data-f="castingDirector" value="${escapeHtml(c.castingDirector || '')}" placeholder="casting director">
          <input class="project-input ed-field" data-i="${i}" data-f="press" value="${escapeHtml(c.press || '')}" placeholder="press/review URL">
        </div>
        <textarea class="project-input ed-field" data-i="${i}" data-f="description" placeholder="production notes" style="margin-top:0.25em;font-size:0.85em;min-height:2em;resize:vertical;width:100%;box-sizing:border-box">${escapeHtml(c.description || '')}</textarea>
        <div style="margin-top:0.25em;position:relative" class="credits-cat-wrap" data-i="${i}">
          <input class="project-input credits-cat-input" data-i="${i}" value="${escapeHtml(c.category || '')}" placeholder="category (type + tab)" autocomplete="off" style="width:100%">
          <div class="credits-cat-suggest" style="display:none;position:absolute;left:0;right:0;top:100%;background:var(--bg);border:1px solid var(--border);z-index:10;max-height:150px;overflow-y:auto"></div>
        </div>
        <div style="display:flex;gap:0.5em;margin-top:0.25em;align-items:center">
          <button class="tag-collab-btn" data-type="credits" data-i="${i}" style="background:none;border:1px solid var(--border);color:var(--muted);font-family:inherit;font-size:0.7em;padding:0.15em 0.5ch;cursor:pointer">+ collaborator</button>
          ${(c._collabs || []).map(d => `<span class="collab-tag" style="font-size:0.7em;color:var(--accent);border:1px solid var(--accent);padding:0.1em 0.4ch;display:inline-flex;align-items:center;gap:0.3ch">${escapeHtml(d)}<button class="remove-collab-tag" data-domain="${escapeHtml(d)}" data-type="credits" data-title="${(c.title || c.role || 'untitled').replace(/"/g, '&quot;')}" style="background:none;border:none;color:var(--accent);cursor:pointer;font-size:0.9em;padding:0;line-height:1">x</button></span>`).join('')}
          <button class="ed-remove" data-i="${i}" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:0.8em;margin-left:auto">${t('settings.modules.remove')}</button>
        </div>
        </div>
      </div>`
    }).join('') + `<button class="buy-btn ed-add" style="margin-top:0.5em;font-size:0.8em;padding:0.3em 1ch">${t('settings.credits.addCredit')}</button>`

    _wireCollapseAndDrag(el, 'credits', items, mod)
    wireEditorEvents(el, mod, items)

    // --- category autocomplete ---
    el.querySelectorAll('.credits-cat-input').forEach(input => {
      const idx = parseInt(input.dataset.i)
      const suggestEl = input.closest('.credits-cat-wrap').querySelector('.credits-cat-suggest')
      const showSuggestions = (filter) => {
        const allCats = [...new Set(items.map(c => c.category).filter(Boolean))]
        const filtered = filter ? allCats.filter(c => c.toLowerCase().includes(filter.toLowerCase())) : allCats
        if (!filtered.length) { suggestEl.style.display = 'none'; return }
        suggestEl.innerHTML = filtered.map(c => `<div class="credits-cat-option" style="padding:0.3em 0.5ch;cursor:pointer;font-size:0.85em;color:var(--fg)" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</div>`).join('')
        suggestEl.style.display = 'block'
        suggestEl.querySelectorAll('.credits-cat-option').forEach(opt => {
          opt.addEventListener('mousedown', (e) => {
            e.preventDefault()
            input.value = opt.dataset.cat
            items[idx].category = opt.dataset.cat
            if (!creditsData.categoryOrder.includes(opt.dataset.cat)) creditsData.categoryOrder.push(opt.dataset.cat)
            suggestEl.style.display = 'none'
          })
        })
      }
      input.addEventListener('focus', () => showSuggestions(input.value))
      input.addEventListener('input', () => showSuggestions(input.value))
      input.addEventListener('blur', () => { setTimeout(() => { suggestEl.style.display = 'none' }, 150) })
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Tab' || e.key === 'Enter') {
          const val = input.value.trim()
          if (val) {
            items[idx].category = val
            if (!creditsData.categoryOrder.includes(val)) creditsData.categoryOrder.push(val)
          }
          suggestEl.style.display = 'none'
        }
      })
    })

    // --- category order buttons ---
    el.querySelectorAll('.cat-order-up').forEach(btn => {
      btn.addEventListener('click', () => {
        const ci = parseInt(btn.dataset.ci)
        if (ci <= 0) return
        const order = creditsData.categoryOrder
        ;[order[ci - 1], order[ci]] = [order[ci], order[ci - 1]]
        renderModuleEditor(el, mod)
      })
    })
    el.querySelectorAll('.cat-order-down').forEach(btn => {
      btn.addEventListener('click', () => {
        const ci = parseInt(btn.dataset.ci)
        const order = creditsData.categoryOrder
        if (ci >= order.length - 1) return
        ;[order[ci], order[ci + 1]] = [order[ci + 1], order[ci]]
        renderModuleEditor(el, mod)
      })
    })

    // --- resume PDF upload ---
    el.querySelector('.credits-upload-resume')?.addEventListener('click', () => {
      uploadFile(el.querySelector('.credits-upload-resume'), (url, _poster, filename) => {
        creditsData.resumePdf = url
        creditsData.resumeFilename = filename || ''
        renderModuleEditor(el, mod)
      }, '.pdf')
    })
    el.querySelector('.credits-remove-resume')?.addEventListener('click', () => {
      creditsData.resumePdf = ''
      renderModuleEditor(el, mod)
    })
    el.querySelector('.credits-resume-label')?.addEventListener('change', (e) => {
      creditsData.resumeLabel = e.target.value
    })
  } else if (type === 'music') {
    const aliases = data?.aliases || []
    let html = ''
    for (let a = 0; a < aliases.length; a++) {
      const alias = aliases[a]
      html += `<div class="editor-item" data-drag-idx="${a}" data-alias-drag="${a}" style="padding:1em 0">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5em">
          <div style="display:flex;align-items:center;gap:0.5ch;flex:1">
            <span class="drag-handle">\u2261</span>
            <input class="project-input alias-name" data-alias="${a}" value="${alias.name || ''}" placeholder="${t('settings.music.aliasName')}" style="font-size:1.1em;max-width:300px">
          </div>
          <button class="ed-remove-alias" data-alias="${a}" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:0.8em">${t('settings.music.removeAlias')}</button>
        </div>`
      for (let b = 0; b < (alias.albums || []).length; b++) {
        const album = alias.albums[b]
        const _albumKey = `album-${a}-${b}`
        const _albumExp = _editorExpandedItems.has(_albumKey)
        const _albumT = escapeHtml(album.title || 'untitled album')
        html += `<div class="editor-card" data-drag-idx="${b}" data-album-drag="${b}" data-album-alias="${a}">
          <div class="editor-collapse-header" data-toggle-album="${a}-${b}">
            <span class="drag-handle">\u2261</span>
            <span class="collapse-title">${_albumT}${album.year ? ' (' + album.year + ')' : ''}</span>
            <span class="collapse-chevron ${_albumExp ? 'expanded' : ''}">\u25B8</span>
          </div>
          <div class="editor-collapse-body ${_albumExp ? 'expanded' : ''}">
          <div style="display:flex;flex-direction:column;gap:0.75em">
            <div style="display:grid;gap:0.75em;grid-template-columns:1fr 1fr">
              <input class="project-input album-field" data-alias="${a}" data-album="${b}" data-f="title" value="${escapeHtml(album.title || '')}" placeholder="${t('settings.music.albumTitle')}" style="font-size:0.95em;padding:0.5em 0.75ch">
              <input class="project-input album-field" data-alias="${a}" data-album="${b}" data-f="year" type="number" value="${album.year || ''}" placeholder="${t('settings.credits.year')}" style="font-size:0.95em;padding:0.5em 0.75ch">
              <select class="project-input album-field" data-alias="${a}" data-album="${b}" data-f="collectionType" style="font-size:0.9em;padding:0.45em 0.5ch">
                ${['album', 'podcast', 'playlist', 'mixtape'].map(ct => `<option value="${ct}" ${(album.collectionType || 'album') === ct ? 'selected' : ''}>${ct}</option>`).join('')}
              </select>
              <input class="project-input album-field" data-alias="${a}" data-album="${b}" data-f="genre" value="${escapeHtml(album.genre || '')}" placeholder="genre (e.g. hip-hop, jazz)" style="font-size:0.9em;padding:0.45em 0.75ch">
              <input class="project-input album-field" data-alias="${a}" data-album="${b}" data-f="artist" value="${escapeHtml(album.artist || '')}" placeholder="artist (defaults to ${escapeHtml(alias.name || 'alias name')})" style="font-size:0.9em;padding:0.45em 0.75ch">
              <input class="project-input album-field" data-alias="${a}" data-album="${b}" data-f="producer" value="${escapeHtml(album.producer || '')}" placeholder="producer" style="font-size:0.9em;padding:0.45em 0.75ch">
            </div>
            <textarea class="project-input album-field" data-alias="${a}" data-album="${b}" data-f="description" placeholder="album notes / concept" style="font-size:0.9em;min-height:3em;resize:vertical;width:100%;box-sizing:border-box;padding:0.5em 0.75ch">${escapeHtml(album.description || '')}</textarea>
          </div>
          <div style="display:flex;gap:1em;margin-top:1em;align-items:center">
            ${album.art ? `<img loading="lazy" src="${album.art}" style="width:80px;height:80px;object-fit:cover;border:1px solid var(--border)">` : ''}
            <button class="buy-btn upload-art" data-alias="${a}" data-album="${b}" style="font-size:0.85em;padding:0.4em 1.5ch">${album.art ? 'change cover' : t('settings.music.uploadCover')}</button>
          </div>
          <div style="margin-top:1.25em">
            <span style="color:var(--dim);font-size:0.85em;text-transform:uppercase;letter-spacing:0.1em">${t('settings.music.tracks')}</span>
            ${(album.tracks || []).map((tr, ti) => {
              return `
              <div class="editor-card" data-drag-idx="${ti}" data-track-drag="${ti}" data-track-alias="${a}" data-track-album="${b}" style="padding:1em">
                <div style="display:flex;gap:0.75em;align-items:center">
                  <span class="drag-handle" style="font-size:1.1em;color:var(--dim)">\u2261</span>
                  <span style="color:var(--dim);font-size:0.8em;min-width:2ch">${ti + 1}</span>
                  ${tr.src ? `<button class="track-play-btn" data-track-src="${tr.src}" data-track-title="${escapeHtml(tr.title || '')}" data-track-artist="${escapeHtml(alias?.name || siteData?.name || '')}" style="background:none;border:1px solid var(--border);color:var(--fg);width:28px;height:28px;border-radius:50%;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:0.7em"><i class="ph ph-play"></i></button>` : '<span style="width:28px;height:28px;flex-shrink:0"></span>'}
                  <input class="project-input track-field" data-alias="${a}" data-album="${b}" data-track="${ti}" data-f="title" value="${escapeHtml(tr.title || '')}" placeholder="${t('settings.music.trackTitle')}" style="flex:1;font-size:0.9em">
                  <button class="buy-btn upload-track" data-alias="${a}" data-album="${b}" data-track="${ti}" style="font-size:0.8em;padding:0.3em 1ch">${tr.src ? t('settings.music.uploaded') : t('settings.music.upload')}</button>
                  <button class="ed-remove-track" data-alias="${a}" data-album="${b}" data-track="${ti}" title="remove track" style="background:none;border:1px solid var(--border);color:var(--dim);font-family:inherit;font-size:0.8em;padding:0.3em 0.6ch;cursor:pointer">\u00d7</button>
                </div>
                ${renderSellWidget(tr, `sell-track-${a}-${b}-${ti}`)}
              </div>`
            }).join('')}
            <button class="buy-btn add-track" data-alias="${a}" data-album="${b}" style="font-size:0.85em;padding:0.4em 1.5ch;margin-top:0.75em">${t('settings.music.addTrack')}</button>
          </div>
          ${(() => {
            const tracks = album.tracks || []
            const tracksWithSrc = tracks.filter(t => t.src)
            const unlistedTracks = tracksWithSrc.filter(t => t.mediaId === undefined || t.mediaId === null || t.mediaId === '')
            if (tracksWithSrc.length >= 2 && unlistedTracks.length > 0) {
              return `<div style="margin-top:1em;padding:1em 1.25em;border:1px solid var(--accent);font-size:0.9em">
                <div style="display:flex;gap:0.75em;align-items:center;flex-wrap:wrap">
                  <span style="color:var(--accent);font-weight:500">batch list ${unlistedTracks.length} unlisted track${unlistedTracks.length === 1 ? '' : 's'}</span>
                  <input type="text" class="project-input batch-album-price eth-price-input" data-alias="${a}" data-album="${b}" placeholder="0.01" style="width:8ch;font-size:0.9em;padding:0.4em 0.5ch">
                  <span style="color:var(--dim)">ETH per track</span><span class="eth-fiat-label" style="color:var(--dim);font-size:0.85em;margin-left:0.5ch"></span>
                  <input type="number" class="project-input batch-album-supply" data-alias="${a}" data-album="${b}" placeholder="unlimited" style="width:10ch;font-size:0.9em;padding:0.4em 0.5ch">
                  <span style="color:var(--dim)">supply</span>
                </div>
                <div class="batch-album-splits" data-alias="${a}" data-album="${b}" style="margin-top:0.5em">
                  <div style="display:flex;justify-content:space-between;align-items:center">
                    <span style="color:var(--dim);font-size:0.85em">splits</span>
                    <button class="batch-album-add-split" data-alias="${a}" data-album="${b}" style="background:none;border:1px solid var(--border);color:var(--muted);font-family:inherit;font-size:0.8em;padding:0.1em 0.5ch;cursor:pointer">+ collaborator</button>
                  </div>
                  <div class="batch-album-split-list" data-alias="${a}" data-album="${b}"></div>
                  <div style="color:var(--dim);font-size:0.75em;margin-top:0.25em">you automatically get the remainder (e.g. add a collaborator at 30% and you get 70%) — splits apply to all tracks</div>
                </div>
                <button class="buy-btn batch-list-album-btn" data-alias="${a}" data-album="${b}" style="font-size:0.9em;padding:0.5em 1.5ch;margin-top:0.75em">list album for sale</button>
                <span class="batch-album-status" data-alias="${a}" data-album="${b}" style="color:var(--muted);font-size:0.85em;margin-left:0.5ch"></span>
              </div>`
            }
            return ''
          })()}
          <div style="display:flex;gap:0.5em;margin-top:0.25em;align-items:center">
            <button class="tag-collab-btn" data-type="music" data-i="${b}" data-alias="${a}" style="background:none;border:1px solid var(--border);color:var(--muted);font-family:inherit;font-size:0.7em;padding:0.15em 0.5ch;cursor:pointer">+ collaborator</button>
            ${(album._collabs || []).map(c => `<span class="collab-tag" style="font-size:0.7em;color:var(--accent);border:1px solid var(--accent);padding:0.1em 0.4ch;display:inline-flex;align-items:center;gap:0.3ch">${escapeHtml(c)}<button class="remove-collab-tag" data-domain="${escapeHtml(c)}" data-type="music" data-title="${(album.title || 'untitled').replace(/"/g, '&quot;')}" style="background:none;border:none;color:var(--accent);cursor:pointer;font-size:0.9em;padding:0;line-height:1">x</button></span>`).join('')}
            <button class="ed-remove-album" data-alias="${a}" data-album="${b}" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:0.75em;margin-left:auto">${t('settings.music.removeAlbum')}</button>
          </div>
          </div>
        </div>`
      }
      html += `<button class="buy-btn add-album" data-alias="${a}" style="font-size:0.75em;padding:0.2em 0.8ch;margin-top:0.25em">${t('settings.music.addAlbum')}</button></div>`
    }
    html += `<button class="buy-btn add-alias" style="font-size:0.8em;padding:0.3em 1ch;margin-top:0.5em">${t('settings.music.addAlias')}</button>`
    el.innerHTML = html

    // wire album collapse toggles
    el.querySelectorAll('.editor-collapse-header[data-toggle-album]').forEach(header => {
      header.addEventListener('click', (e) => {
        if (e.target.closest('.drag-handle')) return
        const key = 'album-' + header.dataset.toggleAlbum
        if (_editorExpandedItems.has(key)) _editorExpandedItems.delete(key)
        else _editorExpandedItems.add(key)
        const body = header.nextElementSibling
        const chevron = header.querySelector('.collapse-chevron')
        body.classList.toggle('expanded')
        chevron.classList.toggle('expanded')
      })
    })
    _wireDragDrop(el, '.editor-item[data-alias-drag]', (from, to) => {
      _arrayMove(aliases, from, to)
      renderModuleEditor(el, mod)
    })
    el.querySelectorAll('.editor-item[data-alias-drag]').forEach(aliasEl => {
      const a = parseInt(aliasEl.dataset.aliasDrag)
      _wireDragDrop(aliasEl, '.editor-card[data-album-drag][data-album-alias="' + a + '"]', (from, to) => {
        _arrayMove(aliases[a].albums, from, to)
        renderModuleEditor(el, mod)
      })
    })
    el.querySelectorAll('.editor-card[data-album-drag]').forEach(albumEl => {
      const a = parseInt(albumEl.dataset.albumAlias)
      const b = parseInt(albumEl.dataset.albumDrag)
      _wireDragDrop(albumEl, '.editor-card[data-track-drag][data-track-alias="' + a + '"][data-track-album="' + b + '"]', (from, to) => {
        _arrayMove(aliases[a].albums[b].tracks, from, to)
        renderModuleEditor(el, mod)
      })
    })

    // wire music events
    el.querySelectorAll('.alias-name').forEach(input => {
      input.addEventListener('change', () => { aliases[input.dataset.alias].name = input.value })
    })
    el.querySelectorAll('.album-field').forEach(input => {
      input.addEventListener('change', () => {
        const a = parseInt(input.dataset.alias), b = parseInt(input.dataset.album), f = input.dataset.f
        if (f.startsWith('links.')) {
          const key = f.split('.')[1]
          if (!aliases[a].albums[b].links) aliases[a].albums[b].links = {}
          aliases[a].albums[b].links[key] = input.value
        } else {
          aliases[a].albums[b][f] = input.type === 'number' ? parseInt(input.value) : input.value
        }
        // Duplicate-title guard: if this is the title field and it now
        // matches another album's title within the same alias, warn.
        // Never blocks the save — just flags it so accidental duplicates
        // don't slip through unnoticed.
        if (f === 'title') {
          const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase()
          const mine = norm(input.value)
          const parent = input.closest('.album-editor') || input.closest('[data-album]')?.parentElement
          const existingWarn = parent?.querySelector('.album-dup-warning')
          if (existingWarn) existingWarn.remove()
          if (!mine) return
          const dupeIdx = (aliases[a].albums || []).findIndex((al, i) =>
            i !== b && norm(al.title) === mine
          )
          if (dupeIdx >= 0 && parent) {
            const warn = document.createElement('div')
            warn.className = 'album-dup-warning'
            warn.style.cssText = 'color:var(--yellow,#da3);font-size:0.75em;margin-top:0.35em;padding:0.4em 0.6ch;border-left:2px solid var(--yellow,#da3);background:color-mix(in srgb,#da3 5%,transparent)'
            warn.innerHTML = `You already have an album called <strong>${escapeHtml(input.value)}</strong> in this alias (album ${dupeIdx + 1}). If this is the same record, edit the existing one instead — duplicates render as separate cards on your site.`
            input.parentElement?.after(warn)
          }
        }
      })
    })
    el.querySelectorAll('.track-field').forEach(input => {
      input.addEventListener('change', () => {
        const a = parseInt(input.dataset.alias), b = parseInt(input.dataset.album), ti = parseInt(input.dataset.track)
        aliases[a].albums[b].tracks[ti].title = input.value
      })
    })
    el.querySelectorAll('.upload-art').forEach(btn => {
      btn.addEventListener('click', () => uploadFile(btn, (url) => {
        aliases[parseInt(btn.dataset.alias)].albums[parseInt(btn.dataset.album)].art = url
        renderModuleEditor(el, mod)
      }))
    })
    el.querySelectorAll('.upload-track').forEach(btn => {
      btn.addEventListener('click', () => uploadFile(btn, (url, _poster, filename) => {
        const a = parseInt(btn.dataset.alias), b = parseInt(btn.dataset.album), ti = parseInt(btn.dataset.track)
        const track = aliases[a].albums[b].tracks[ti]
        track.src = url
        if (!track.title) { track.title = prettifyFilename(filename) }
        btn.textContent = t('settings.music.uploaded')
        renderModuleEditor(el, mod)
      }, undefined, { onFileSelected: (file, b) => showLocalMediaPreview(b, file) }))
    })
    el.querySelectorAll('.add-track').forEach(btn => {
      btn.addEventListener('click', () => {
        const a = parseInt(btn.dataset.alias), b = parseInt(btn.dataset.album)
        if (!aliases[a].albums[b].tracks) aliases[a].albums[b].tracks = []
        const ti = aliases[a].albums[b].tracks.length
        aliases[a].albums[b].tracks.push({ title: '', src: '' })
        // append new track row inline instead of re-rendering (preserves in-progress uploads)
        const row = document.createElement('div')
        row.style.cssText = 'margin-top:0.25em;padding:0.25em 0;border-bottom:1px solid var(--border)'
        row.innerHTML = `<div style="display:flex;gap:0.5em;align-items:center">
          <input class="project-input track-field" data-alias="${a}" data-album="${b}" data-track="${ti}" data-f="title" value="" placeholder="${t('settings.music.trackTitle')}" style="flex:1;font-size:0.85em">
          <button class="buy-btn upload-track" data-alias="${a}" data-album="${b}" data-track="${ti}" style="font-size:0.7em;padding:0.15em 0.5ch">${t('settings.music.upload')}</button>
        </div>`
        btn.parentNode.insertBefore(row, btn)
        // wire the new track's input and upload button
        row.querySelector('.track-field').addEventListener('change', function() {
          aliases[a].albums[b].tracks[ti].title = this.value
        })
        const uploadBtn = row.querySelector('.upload-track')
        uploadBtn.addEventListener('click', () => uploadFile(uploadBtn, (url, _poster, filename) => {
          const track = aliases[a].albums[b].tracks[ti]
          track.src = url
          if (!track.title) {
            track.title = prettifyFilename(filename)
            const titleInput = row.querySelector('.track-field')
            if (titleInput) titleInput.value = track.title
          }
          uploadBtn.textContent = t('settings.music.uploaded')
        }, undefined, { onFileSelected: (file, b) => showLocalMediaPreview(b, file) }))
      })
    })
    el.querySelectorAll('.add-album').forEach(btn => {
      btn.addEventListener('click', () => {
        const _a = parseInt(btn.dataset.alias)
        aliases[_a].albums.push({ title: '', year: new Date().getFullYear(), art: '', tracks: [], links: {} })
        _editorExpandedItems.add(`album-${_a}-${aliases[_a].albums.length - 1}`)
        renderModuleEditor(el, mod)
      })
    })
    el.querySelector('.add-alias')?.addEventListener('click', () => {
      aliases.push({ name: '', albums: [] })
      mod.data = { ...mod.data, aliases }
      renderModuleEditor(el, mod)
    })
    el.querySelectorAll('.ed-remove-alias').forEach(btn => {
      btn.addEventListener('click', async () => {
        const a = parseInt(btn.dataset.alias)
        const alias = aliases[a]
        const albumCount = alias?.albums?.length || 0
        const ok = await confirmModal({
          title: `remove alias "${alias?.name || 'untitled'}"?`,
          body: albumCount > 0 ? `this will also remove ${albumCount} album${albumCount === 1 ? '' : 's'} listed under this alias. on-chain media listings stay on-chain — only the link from your site is removed.` : 'this can\'t be undone from the editor — you would have to re-add the alias.',
          confirmLabel: 'remove alias',
        })
        if (!ok) return
        aliases.splice(a, 1)
        renderModuleEditor(el, mod)
        try { await saveSettings() } catch {}
      })
    })
    el.querySelectorAll('.ed-remove-album').forEach(btn => {
      btn.addEventListener('click', async () => {
        const a = parseInt(btn.dataset.alias)
        const b = parseInt(btn.dataset.album)
        const album = aliases[a]?.albums?.[b]
        const trackCount = album?.tracks?.length || 0
        const ok = await confirmModal({
          title: `remove album "${album?.title || 'untitled'}"?`,
          body: trackCount > 0 ? `this will also remove ${trackCount} track${trackCount === 1 ? '' : 's'} from your site. any on-chain listings for these tracks stay on-chain — only the link from your site is removed.` : 'remove this album from your site?',
          confirmLabel: 'remove album',
        })
        if (!ok) return
        aliases[a].albums.splice(b, 1)
        renderModuleEditor(el, mod)
        try { await saveSettings() } catch {}
      })
    })
    // tag collaborator on album
    el.querySelectorAll('.tag-collab-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const a = parseInt(btn.dataset.alias)
        const b = parseInt(btn.dataset.i)
        const album = aliases[a]?.albums?.[b]
        if (!album) return
        const domain = await promptModal({ title: 'tag collaborator', placeholder: 'artist domain (e.g. canteenkilla.space)', confirmLabel: 'tag' })
        if (!domain) return
        // Add to _collabs and save — the server detects new collab tags during PUT /api/site
        if (!album._collabs) album._collabs = []
        if (!album._collabs.includes(domain.trim())) album._collabs.push(domain.trim())
        renderModuleEditor(el, mod)
        try { await saveSettings() } catch {}
      })
    })
    // remove collaborator tag from album
    el.querySelectorAll('.remove-collab-tag').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        _handleRemoveCollabTag(btn, aliases.flatMap(a => a.albums || []), el, mod)
      })
    })
    // remove a single track from an album (gated by confirm)
    el.querySelectorAll('.ed-remove-track').forEach(btn => {
      btn.addEventListener('click', async () => {
        const a = parseInt(btn.dataset.alias), b = parseInt(btn.dataset.album), ti = parseInt(btn.dataset.track)
        const track = aliases[a]?.albums[b]?.tracks?.[ti]
        const ok = await confirmModal({
          title: `remove track "${track?.title || 'untitled'}"?`,
          body: track?.mediaId ? 'this track is listed on-chain. removing it from your site does not delist it — to delist, click "delist" first.' : '',
          confirmLabel: 'remove track',
        })
        if (!ok) return
        aliases[a].albums[b].tracks.splice(ti, 1)
        renderModuleEditor(el, mod)
        try { await saveSettings() } catch {}
      })
    })
    // Live fiat conversion on all ETH price inputs
    {
      let _fiatPrices = null
      import('./fiat.js').then(m => m.getEthPrices().then(p => { _fiatPrices = p })).catch(() => {})
      el.addEventListener('input', (e) => {
        if (!e.target.classList.contains('eth-price-input') || !_fiatPrices) return
        const eth = parseFloat(e.target.value) || 0
        const label = e.target.parentElement?.querySelector('.eth-fiat-label')
        if (!label) return
        if (eth > 0) {
          import('./fiat.js').then(m => {
            const currency = m.getUserCurrency()
            const rate = _fiatPrices[currency] || _fiatPrices.usd || 0
            if (!rate) { label.textContent = ''; return }
            const perItem = m.formatFiat(eth * rate, currency)
            // Find track/item count from the batch label text nearby
            const batchText = e.target.parentElement?.querySelector('[style*="color:var(--accent)"]')?.textContent || ''
            const countMatch = batchText.match(/(\d+)\s+unlisted/)
            const count = countMatch ? parseInt(countMatch[1]) : 0
            if (count > 1) {
              label.textContent = `(~${perItem} each, ~${m.formatFiat(eth * rate * count, currency)} total)`
            } else {
              label.textContent = `(~${perItem})`
            }
          }).catch(() => {})
        } else {
          label.textContent = ''
        }
      })
    }

    // wire batch album add-split buttons
    el.querySelectorAll('.batch-album-add-split').forEach(btn => {
      btn.addEventListener('click', () => {
        const list = el.querySelector(`.batch-album-split-list[data-alias="${btn.dataset.alias}"][data-album="${btn.dataset.album}"]`)
        if (list) _addBatchSplitRow(list)
      })
    })

    // wire batch list album buttons
    el.querySelectorAll('.batch-list-album-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const a = parseInt(btn.dataset.alias), b = parseInt(btn.dataset.album)
        const album = aliases[a]?.albums?.[b]
        if (!album) return
        const statusEl = el.querySelector(`.batch-album-status[data-alias="${a}"][data-album="${b}"]`)
        const priceInput = el.querySelector(`.batch-album-price[data-alias="${a}"][data-album="${b}"]`)
        const supplyInput = el.querySelector(`.batch-album-supply[data-alias="${a}"][data-album="${b}"]`)
        const priceEth = parseFloat(priceInput?.value || '0')
        const maxSupply = parseInt(supplyInput?.value || '0') || 0

        // Collect collaborator splits from the batch UI
        const splitList = el.querySelector(`.batch-album-split-list[data-alias="${a}"][data-album="${b}"]`)
        const splitResult = await _collectBatchSplits(splitList)
        if (splitResult.error) { if (statusEl) statusEl.textContent = splitResult.error; return }
        const { collaborators: batchCollabs, splits: batchSplits } = splitResult

        const tracks = (album.tracks || []).filter(t => t.src && (t.mediaId === undefined || t.mediaId === null || t.mediaId === ''))
        if (!tracks.length) { if (statusEl) statusEl.textContent = 'no unlisted tracks'; return }

        // Build entries from unlisted tracks with IPFS sources
        const entries = []
        for (const tr of tracks) {
          const cidMatch = (tr.src || '').match(/ipfs-proxy\/([A-Za-z0-9]+)/)
          const cid = cidMatch ? cidMatch[1] : ''
          if (!cid) continue
          const artSrc = album.art || ''
          const artCidMatch = artSrc.match(/ipfs-proxy\/([A-Za-z0-9]+)/)
          const metadataCid = artCidMatch ? artCidMatch[1] : ''
          entries.push({ title: tr.title || 'untitled', ipfsCid: cid, metadataCid, price: priceEth, maxSupply, collaborators: batchCollabs, splits: batchSplits })
        }
        if (!entries.length) { if (statusEl) statusEl.textContent = 'no tracks on IPFS'; return }

        try {
          if (statusEl) statusEl.textContent = `listing ${entries.length} tracks... confirm in wallet`
          btn.disabled = true
          const { listBatchMedia } = await import('./media.js')
          const ids = await listBatchMedia(entries)

          // Store media IDs back on the tracks
          let idIdx = 0
          for (const tr of (album.tracks || [])) {
            if (!tr.src) continue
            if (tr.mediaId !== undefined && tr.mediaId !== null && tr.mediaId !== '') continue
            const cidMatch = (tr.src || '').match(/ipfs-proxy\/([A-Za-z0-9]+)/)
            if (!cidMatch) continue
            if (idIdx < ids.length) {
              tr.mediaId = ids[idIdx]
              tr.mediaPrice = parseEther(String(priceEth)).toString()
              tr.mediaMaxSupply = maxSupply
              idIdx++
            }
          }
          if (statusEl) statusEl.textContent = `listed ${ids.length} tracks — saving...`
          try {
            await api('/api/site', { method: 'PUT', body: JSON.stringify(siteData) })
            if (statusEl) statusEl.textContent = `listed ${ids.length} tracks — saved`
          } catch { if (statusEl) statusEl.textContent = `listed ${ids.length} tracks — save failed, click save` }
          renderModuleEditor(el, mod)
        } catch (e) {
          btn.disabled = false
          if (statusEl) statusEl.textContent = e.code === 4001 ? 'cancelled' : `error: ${(e.shortMessage || e.message || '').slice(0, 80)}`
        }
      })
    })
    // wire sell widgets for tracks (with album art context)
    wireSellWidgets(el, (widgetId) => {
      const m = widgetId.match(/sell-track-(\d+)-(\d+)-(\d+)/)
      if (!m) return null
      const track = aliases[parseInt(m[1])]?.albums?.[parseInt(m[2])]?.tracks?.[parseInt(m[3])]
      if (track) track._albumArt = aliases[parseInt(m[1])]?.albums?.[parseInt(m[2])]?.art || ''
      return track
    })

  } else if (type === 'gallery') {
    const images = data?.images || []
    const exhibitions = data?.exhibitions || []
    let html = `<h4 style="color:var(--muted);font-size:0.8em;margin-bottom:0.5em">${t('settings.gallery.images')}</h4>`
    html += images.map((img, i) => {
      const _exp = _editorExpandedItems.has(`img-${i}`)
      const _tl = escapeHtml(img.title || 'untitled work')
      return `
      <div class="editor-item" data-index="${i}" data-drag-idx="${i}" data-img-drag="${i}">
        <div class="editor-collapse-header" data-toggle-idx="${i}" data-toggle-prefix="img">
          <span class="drag-handle">\u2261</span>
          <span class="collapse-title">${_tl}${img.year ? ' (' + img.year + ')' : ''}</span>
          ${img.src ? '<span style="font-size:0.7em;color:var(--dim)">[img]</span>' : ''}
          <span class="collapse-chevron ${_exp ? 'expanded' : ''}">\u25B8</span>
        </div>
        <div class="editor-collapse-body ${_exp ? 'expanded' : ''}">
        <div style="display:grid;gap:0.5em;grid-template-columns:1fr 1fr">
          <input class="project-input ed-img" data-i="${i}" data-f="title" value="${escapeHtml(img.title || '')}" placeholder="${t('settings.credits.title')}">
          <input class="project-input ed-img" data-i="${i}" data-f="series" value="${escapeHtml(img.series || '')}" placeholder="series / collection">
          <input class="project-input ed-img" data-i="${i}" data-f="medium" value="${img.medium || ''}" placeholder="${t('settings.gallery.medium')}">
          <input class="project-input ed-img" data-i="${i}" data-f="year" type="number" value="${img.year || ''}" placeholder="${t('settings.credits.year')}">
          <input class="project-input ed-img" data-i="${i}" data-f="dimensions" value="${img.dimensions || ''}" placeholder="dimensions (e.g. 24 x 36 inches)">
          <input class="project-input ed-img" data-i="${i}" data-f="materials" value="${img.materials || ''}" placeholder="materials (e.g. oil on canvas)">
          <input class="project-input ed-img" data-i="${i}" data-f="edition" value="${img.edition || ''}" placeholder="edition (e.g. 1/10, AP 2/3)">
          <input class="project-input ed-img" data-i="${i}" data-f="location" value="${img.location || ''}" placeholder="location">
        </div>
        <input class="project-input ed-img" data-i="${i}" data-f="description" value="${img.description || ''}" placeholder="description" style="margin-top:0.25em">
        <div style="display:flex;gap:0.5em;align-items:center;margin-top:0.25em">
          <button class="buy-btn upload-img" data-i="${i}" style="font-size:0.75em;padding:0.2em 0.8ch">${img.src ? t('settings.gallery.replace') : t('settings.music.upload')}</button>
          ${img.src ? `<img loading="lazy" src="/api/img?url=${encodeURIComponent(img.src)}&w=200" style="max-width:80px;max-height:50px">` : ''}
        </div>
        ${renderSellWidget(img, `sell-img-${i}`)}
        <button class="ed-remove-img" data-i="${i}" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:0.75em">${t('settings.modules.remove')}</button>
        </div>
      </div>`
    }).join('')
    html += `<button class="buy-btn add-img" style="font-size:0.8em;padding:0.3em 1ch;margin-top:0.5em">${t('settings.gallery.addImage')}</button>`
    // batch list collection button for gallery
    {
      const imgsWithSrc = images.filter(img => img.src)
      const unlistedImgs = imgsWithSrc.filter(img => img.mediaId === undefined || img.mediaId === null || img.mediaId === '')
      if (imgsWithSrc.length >= 2 && unlistedImgs.length > 0) {
        html += `<div style="margin-top:0.75em;padding:0.5em;border:1px solid var(--accent);font-size:0.8em">
          <div style="display:flex;gap:0.5em;align-items:center;flex-wrap:wrap">
            <span style="color:var(--accent)">batch list ${unlistedImgs.length} unlisted image${unlistedImgs.length === 1 ? '' : 's'}</span>
            <input type="text" class="project-input batch-gallery-price eth-price-input" placeholder="0.01" style="width:8ch;font-size:0.85em;padding:0.2em 0.5ch">
            <span style="color:var(--dim)">ETH each</span><span class="eth-fiat-label" style="color:var(--dim);font-size:0.8em;margin-left:0.5ch"></span>
            <input type="number" class="project-input batch-gallery-supply" placeholder="unlimited" style="width:10ch;font-size:0.85em;padding:0.2em 0.5ch">
            <span style="color:var(--dim)">supply</span>
          </div>
          <div class="batch-gallery-splits" style="margin-top:0.5em">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <span style="color:var(--dim);font-size:0.85em">splits</span>
              <button class="batch-gallery-add-split" style="background:none;border:1px solid var(--border);color:var(--muted);font-family:inherit;font-size:0.8em;padding:0.1em 0.5ch;cursor:pointer">+ collaborator</button>
            </div>
            <div class="batch-gallery-split-list"></div>
            <div style="color:var(--dim);font-size:0.75em;margin-top:0.25em">you automatically get the remainder (e.g. add a collaborator at 30% and you get 70%) — splits apply to all images</div>
          </div>
          <button class="buy-btn batch-list-gallery-btn" style="font-size:0.75em;padding:0.2em 0.8ch;margin-top:0.5em">list collection on-chain</button>
          <span class="batch-gallery-status" style="color:var(--muted);font-size:0.85em;margin-left:0.5ch"></span>
        </div>`
      }
    }
    html += `<h4 style="color:var(--muted);font-size:0.8em;margin:1.5em 0 0.5em">${t('settings.gallery.exhibitions')}</h4>`
    html += exhibitions.map((ex, i) => {
      const _exp = _editorExpandedItems.has(`ex-${i}`)
      const _tl = escapeHtml(ex.title || ex.venue || 'untitled exhibition')
      return `
      <div class="editor-item" data-drag-idx="${i}" data-ex-drag="${i}">
        <div class="editor-collapse-header" data-toggle-idx="${i}" data-toggle-prefix="ex">
          <span class="drag-handle">\u2261</span>
          <span class="collapse-title">${_tl}${ex.year ? ' (' + escapeHtml(String(ex.year)) + ')' : ''}</span>
          <span class="collapse-chevron ${_exp ? 'expanded' : ''}">\u25B8</span>
        </div>
        <div class="editor-collapse-body ${_exp ? 'expanded' : ''}">
        <div style="display:grid;gap:0.5em;grid-template-columns:1fr 1fr">
          <input class="project-input ed-ex" data-i="${i}" data-f="title" value="${escapeHtml(ex.title || '')}" placeholder="${t('settings.credits.title')}">
          <input class="project-input ed-ex" data-i="${i}" data-f="venue" value="${escapeHtml(ex.venue || '')}" placeholder="${t('settings.gallery.venue')}">
          <input class="project-input ed-ex" data-i="${i}" data-f="year" type="number" value="${escapeHtml(String(ex.year || ''))}" placeholder="${t('settings.credits.year')}">
          <input class="project-input ed-ex" data-i="${i}" data-f="startDate" value="${escapeHtml(ex.startDate || '')}" placeholder="start date">
          <input class="project-input ed-ex" data-i="${i}" data-f="endDate" value="${escapeHtml(ex.endDate || '')}" placeholder="end date">
          <input class="project-input ed-ex" data-i="${i}" data-f="curator" value="${escapeHtml(ex.curator || '')}" placeholder="curator">
          <input class="project-input ed-ex" data-i="${i}" data-f="coArtists" value="${escapeHtml(ex.coArtists || '')}" placeholder="co-artists (group shows)">
          <input class="project-input ed-ex" data-i="${i}" data-f="url" value="${escapeHtml(ex.url || '')}" placeholder="exhibition page URL">
        </div>
        <button class="ed-remove-ex" data-i="${i}" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:0.75em">${t('settings.modules.remove')}</button>
        </div>
      </div>`
    }).join('')
    html += `<button class="buy-btn add-ex" style="font-size:0.8em;padding:0.3em 1ch;margin-top:0.5em">${t('settings.gallery.addExhibition')}</button>`
    el.innerHTML = html

    // wire collapse + drag for gallery
    _wireCollapseToggles(el, 'img')
    _wireCollapseToggles(el, 'ex')
    _wireDragDrop(el, '.editor-item[data-img-drag]', (from, to) => {
      _remapExpandedKeys('img', from, to)
      _arrayMove(images, from, to)
      mod.data = { ...mod.data, images }
      renderModuleEditor(el, mod)
    })
    _wireDragDrop(el, '.editor-item[data-ex-drag]', (from, to) => {
      _remapExpandedKeys('ex', from, to)
      _arrayMove(exhibitions, from, to)
      mod.data = { ...mod.data, exhibitions }
      renderModuleEditor(el, mod)
    })

    // wire gallery events
    el.querySelectorAll('.ed-img').forEach(input => {
      input.addEventListener('change', () => { images[parseInt(input.dataset.i)][input.dataset.f] = input.type === 'number' ? parseInt(input.value) : input.value })
    })
    el.querySelectorAll('.ed-ex').forEach(input => {
      input.addEventListener('change', () => { exhibitions[parseInt(input.dataset.i)][input.dataset.f] = input.type === 'number' ? parseInt(input.value) : input.value })
    })
    el.querySelectorAll('.upload-img').forEach(btn => {
      // Explicit accept list — image/* covers most browsers' TIFF picker behavior, but
      // HEIC/HEIF + .tif/.tiff are commonly missing from the system picker without
      // an explicit extension hint. Visual artists shooting their own work need both.
      btn.addEventListener('click', () => uploadFile(btn, (url, _poster, filename) => {
        const img = images[parseInt(btn.dataset.i)]
        img.src = url
        if (!img.title) img.title = prettifyFilename(filename)
        renderModuleEditor(el, mod)
      }, 'image/*,.tif,.tiff,.heic,.heif'))
    })
    el.querySelector('.add-img')?.addEventListener('click', () => { images.push({}); _editorExpandedItems.add(`img-${images.length - 1}`); mod.data = { ...mod.data, images }; renderModuleEditor(el, mod) })
    el.querySelector('.add-ex')?.addEventListener('click', () => { exhibitions.push({}); _editorExpandedItems.add(`ex-${exhibitions.length - 1}`); mod.data = { ...mod.data, exhibitions }; renderModuleEditor(el, mod) })

    el.querySelectorAll('.ed-remove-img').forEach(btn => {
      btn.addEventListener('click', async () => {
        const i = parseInt(btn.dataset.i)
        const img = images[i]
        const ok = await confirmModal({
          title: `remove "${img?.title || 'this work'}"?`,
          body: img?.mediaId ? 'this work is listed on-chain. removing it from your site does not delist it — to delist, click "delist" first, then remove.' : 'remove this work from your gallery?',
          confirmLabel: 'remove',
        })
        if (!ok) return
        images.splice(i, 1)
        renderModuleEditor(el, mod)
        try { await saveSettings() } catch {}
      })
    })
    el.querySelectorAll('.ed-remove-ex').forEach(btn => {
      btn.addEventListener('click', async () => {
        const i = parseInt(btn.dataset.i)
        const ex = exhibitions[i]
        const ok = await confirmModal({
          title: `remove exhibition "${ex?.title || ex?.venue || 'this entry'}"?`,
          confirmLabel: 'remove',
        })
        if (!ok) return
        exhibitions.splice(i, 1)
        mod.data = { ...mod.data, exhibitions }
        renderModuleEditor(el, mod)
        try { await saveSettings() } catch {}
      })
    })

    // wire batch gallery add-split button
    el.querySelector('.batch-gallery-add-split')?.addEventListener('click', () => {
      const list = el.querySelector('.batch-gallery-split-list')
      if (list) _addBatchSplitRow(list)
    })

    // wire batch list gallery button
    el.querySelector('.batch-list-gallery-btn')?.addEventListener('click', async () => {
      const statusEl = el.querySelector('.batch-gallery-status')
      const priceInput = el.querySelector('.batch-gallery-price')
      const supplyInput = el.querySelector('.batch-gallery-supply')
      const priceEth = parseFloat(priceInput?.value || '0')
      const maxSupply = parseInt(supplyInput?.value || '0') || 0
      const btn = el.querySelector('.batch-list-gallery-btn')

      // Collect collaborator splits from the batch UI
      const splitList = el.querySelector('.batch-gallery-split-list')
      const splitResult = await _collectBatchSplits(splitList)
      if (splitResult.error) { if (statusEl) statusEl.textContent = splitResult.error; return }
      const { collaborators: batchCollabs, splits: batchSplits } = splitResult

      const unlisted = images.filter(img => img.src && (img.mediaId === undefined || img.mediaId === null || img.mediaId === ''))
      if (!unlisted.length) { if (statusEl) statusEl.textContent = 'no unlisted images'; return }

      const entries = []
      const entryToImg = []
      for (const img of unlisted) {
        const cidMatch = (img.src || '').match(/ipfs-proxy\/([A-Za-z0-9]+)/)
        const cid = cidMatch ? cidMatch[1] : ''
        if (!cid) continue
        entries.push({ title: img.title || 'untitled', ipfsCid: cid, metadataCid: '', price: priceEth, maxSupply, collaborators: batchCollabs, splits: batchSplits })
        entryToImg.push(img)
      }
      if (!entries.length) { if (statusEl) statusEl.textContent = 'no images on IPFS'; return }

      try {
        if (statusEl) statusEl.textContent = `listing ${entries.length} images... confirm in wallet`
        if (btn) btn.disabled = true
        const { listBatchMedia } = await import('./media.js')
        const ids = await listBatchMedia(entries)
        for (let i = 0; i < ids.length && i < entryToImg.length; i++) {
          entryToImg[i].mediaId = ids[i]
          entryToImg[i].mediaPrice = parseEther(String(priceEth)).toString()
          entryToImg[i].mediaMaxSupply = maxSupply
        }
        if (statusEl) statusEl.textContent = `listed ${ids.length} images — saving...`
        try {
          await api('/api/site', { method: 'PUT', body: JSON.stringify(siteData) })
          if (statusEl) statusEl.textContent = `listed ${ids.length} images — saved`
        } catch { if (statusEl) statusEl.textContent = `listed ${ids.length} images — save failed, click save` }
        renderModuleEditor(el, mod)
      } catch (e) {
        if (btn) btn.disabled = false
        if (statusEl) statusEl.textContent = e.code === 4001 ? 'cancelled' : `error: ${(e.shortMessage || e.message || '').slice(0, 80)}`
      }
    })

    wireSellWidgets(el, (widgetId) => {
      const m = widgetId.match(/sell-img-(\d+)/)
      return m ? images[parseInt(m[1])] : null
    })

  } else if (type === 'technology') {
    const items = Array.isArray(data) ? data : data?.projects || []
    el.innerHTML = items.map((p, i) => {
      const _exp = _editorExpandedItems.has(`technology-${i}`)
      const _tl = escapeHtml(p.name || p.role || 'untitled project')
      return `
      <div class="editor-item" data-index="${i}" data-drag-idx="${i}">
        <div class="editor-collapse-header" data-toggle-idx="${i}" data-toggle-prefix="technology">
          <span class="drag-handle">\u2261</span>
          <span class="collapse-title">${_tl}</span>
          <span class="collapse-chevron ${_exp ? 'expanded' : ''}">\u25B8</span>
        </div>
        <div class="editor-collapse-body ${_exp ? 'expanded' : ''}">
        <div style="display:grid;gap:0.5em;grid-template-columns:1fr 1fr">
          <input class="project-input ed-field" data-i="${i}" data-f="name" value="${escapeHtml(p.name || '')}" placeholder="${t('settings.tech.name')}">
          <input class="project-input ed-field" data-i="${i}" data-f="role" value="${escapeHtml(p.role || '')}" placeholder="${t('settings.tech.role')}">
        </div>
        <input class="project-input ed-field" data-i="${i}" data-f="description" value="${escapeHtml(p.description || '')}" placeholder="${t('settings.tech.description')}" style="margin-top:0.25em">
        <input class="project-input ed-field" data-i="${i}" data-f="url" value="${escapeHtml(p.url || '')}" placeholder="${t('settings.tech.url')}" style="margin-top:0.25em">
        <input class="project-input ed-field" data-i="${i}" data-f="stack" value="${escapeHtml(p.stack || '')}" placeholder="tech stack (e.g. React, Node.js, Solidity)" style="margin-top:0.25em">
        <div style="display:grid;gap:0.5em;grid-template-columns:1fr 1fr;margin-top:0.25em">
          <input class="project-input ed-field" data-i="${i}" data-f="repo" value="${escapeHtml(p.repo || '')}" placeholder="repo URL (GitHub/GitLab)">
          <select class="project-input ed-field" data-i="${i}" data-f="status" style="font-size:0.85em">
            <option value="" ${!p.status ? 'selected' : ''}>status</option>
            ${['active', 'archived', 'deprecated'].map(s => `<option value="${s}" ${p.status === s ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </div>
        <button class="ed-remove" data-i="${i}" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:0.8em;margin-top:0.25em">${t('settings.modules.remove')}</button>
        </div>
      </div>`
    }).join('') + `<button class="buy-btn ed-add" style="margin-top:0.5em;font-size:0.8em;padding:0.3em 1ch">${t('settings.tech.addProject')}</button>`

    _wireCollapseAndDrag(el, 'technology', items, mod)
    wireEditorEvents(el, mod, items)
  } else if (type === 'writing') {
    const pubs = data?.publications || []
    let html = `<h4 style="color:var(--muted);font-size:0.8em;margin-bottom:0.5em">${t('settings.writing.publications')}</h4>`
    html += pubs.map((p, i) => {
      const _exp = _editorExpandedItems.has(`pub-${i}`)
      const _tl = escapeHtml(p.title || 'untitled publication')
      return `
      <div class="editor-item" data-drag-idx="${i}" data-pub-drag="${i}">
        <div class="editor-collapse-header" data-toggle-idx="${i}" data-toggle-prefix="pub">
          <span class="drag-handle">\u2261</span>
          <span class="collapse-title">${_tl}${p.year ? ' (' + escapeHtml(String(p.year)) + ')' : ''}</span>
          <span class="collapse-chevron ${_exp ? 'expanded' : ''}">\u25B8</span>
        </div>
        <div class="editor-collapse-body ${_exp ? 'expanded' : ''}">
        <div style="display:grid;gap:0.5em;grid-template-columns:1fr 1fr">
          <input class="project-input ed-pub" data-i="${i}" data-f="title" value="${escapeHtml(p.title || '')}" placeholder="${t('settings.credits.title')}">
          <input class="project-input ed-pub" data-i="${i}" data-f="publication" value="${escapeHtml(p.publication || '')}" placeholder="${t('settings.writing.publication')}">
          <input class="project-input ed-pub" data-i="${i}" data-f="year" type="number" value="${escapeHtml(String(p.year || ''))}" placeholder="${t('settings.credits.year')}">
          <input class="project-input ed-pub" data-i="${i}" data-f="url" value="${escapeHtml(p.url || '')}" placeholder="${t('settings.tech.url')}">
          <input class="project-input ed-pub" data-i="${i}" data-f="genre" value="${escapeHtml(p.genre || '')}" placeholder="genre (poetry, essay, fiction...)">
          <input class="project-input ed-pub" data-i="${i}" data-f="publisher" value="${escapeHtml(p.publisher || '')}" placeholder="publisher">
          <input class="project-input ed-pub" data-i="${i}" data-f="translator" value="${escapeHtml(p.translator || '')}" placeholder="translator">
          <input class="project-input ed-pub" data-i="${i}" data-f="isbn" value="${escapeHtml(p.isbn || '')}" placeholder="ISBN">
          <input class="project-input ed-pub" data-i="${i}" data-f="pageCount" type="number" value="${escapeHtml(String(p.pageCount || ''))}" placeholder="page count">
          <input class="project-input ed-pub" data-i="${i}" data-f="language" value="${escapeHtml(p.language || '')}" placeholder="language">
          <input class="project-input ed-pub" data-i="${i}" data-f="awards" value="${escapeHtml(p.awards || '')}" placeholder="awards">
        </div>
        <div style="display:flex;gap:0.5em;margin-top:0.25em;flex-wrap:wrap">
          <button class="buy-btn upload-doc" data-i="${i}" style="font-size:0.7em;padding:0.15em 0.5ch">${p.src ? 'has document' : 'upload document'}</button>
          <button class="buy-btn upload-cover" data-i="${i}" style="font-size:0.7em;padding:0.15em 0.5ch">${p.coverImage ? 'has cover' : 'upload cover'}</button>
        </div>
        ${renderSellWidget(p, `sell-pub-${i}`)}
        <button class="ed-rm-pub" data-i="${i}" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:0.75em">${t('settings.modules.remove')}</button>
        </div>
      </div>`
    }).join('')
    html += `<button class="buy-btn add-pub" style="font-size:0.8em;padding:0.3em 1ch;margin:0.5em 0 1.5em">${t('settings.writing.addPublication')}</button>`
    el.innerHTML = html
    el.querySelectorAll('.ed-pub').forEach(input => { input.addEventListener('change', () => { pubs[parseInt(input.dataset.i)][input.dataset.f] = input.type === 'number' ? parseInt(input.value) : input.value }) })
    el.querySelectorAll('.upload-doc').forEach(btn => { btn.addEventListener('click', () => uploadFile(btn, (url) => { pubs[parseInt(btn.dataset.i)].src = url; btn.textContent = 'has document'; renderModuleEditor(el, mod) }, 'image/*,.pdf,.epub,.txt,.doc,.docx')) })
    el.querySelectorAll('.upload-cover').forEach(btn => { btn.addEventListener('click', () => uploadFile(btn, (url) => { pubs[parseInt(btn.dataset.i)].coverImage = url; btn.textContent = 'has cover'; renderModuleEditor(el, mod) }, 'image/*')) })
    el.querySelector('.add-pub')?.addEventListener('click', () => { pubs.push({}); _editorExpandedItems.add(`pub-${pubs.length - 1}`); mod.data = { ...mod.data, publications: pubs }; renderModuleEditor(el, mod) })
    el.querySelectorAll('.ed-rm-pub').forEach(btn => {
      btn.addEventListener('click', async () => {
        const i = parseInt(btn.dataset.i)
        const ok = await confirmModal({
          title: `remove "${pubs[i]?.title || 'this entry'}"?`,
          confirmLabel: 'remove',
        })
        if (!ok) return
        pubs.splice(i, 1)
        renderModuleEditor(el, mod)
        try { await saveSettings() } catch {}
      })
    })
    _wireCollapseToggles(el, 'pub')
    _wireDragDrop(el, '.editor-item[data-pub-drag]', (from, to) => {
      _remapExpandedKeys('pub', from, to)
      _arrayMove(pubs, from, to)
      mod.data = { ...mod.data, publications: pubs }
      renderModuleEditor(el, mod)
    })
    wireSellWidgets(el, (widgetId) => {
      const i = parseInt(widgetId.split('-').pop())
      return pubs[i]
    })

  } else if (type === 'film' || type === 'audio' || type === 'education' || type === 'video' || type === 'demos') {
    // generic list editor for film works, audio items, education events, demos
    const items = Array.isArray(data) ? data : data?.works || data?.items || data?.events || []
    const fields = type === 'film' ? ['title', 'role', 'director', 'year', 'description', 'cinematographer', 'composer', 'editor', 'writer', 'productionCompany', 'runtime', 'distributor', 'trailer'] :
                   type === 'audio' ? ['title', 'description', 'year', 'series', 'episodeNumber', 'guests'] :
                   type === 'video' ? ['title', 'description', 'collaborators', 'year', 'director', 'cast', 'cinematographer', 'editor', 'runtime', 'genre', 'location'] :
                   type === 'demos' ? ['title', 'description', 'year', 'status', 'collaborators', 'tools', 'startedDate', 'estimatedCompletion', 'medium'] :
                   ['title', 'role', 'org', 'year', 'description', 'degree', 'field', 'startYear', 'endYear']
    el.innerHTML = items.map((item, i) => {
      const _exp = _editorExpandedItems.has(`${type}-${i}`)
      const _tl = escapeHtml(item.title || item.name || (fields[0] && item[fields[0]]) || 'untitled')
      return `
      <div class="editor-item" data-drag-idx="${i}" data-gen-drag="${i}">
        <div class="editor-collapse-header" data-toggle-idx="${i}" data-toggle-prefix="${type}">
          <span class="drag-handle">\u2261</span>
          <span class="collapse-title">${_tl}${item.year ? ' (' + escapeHtml(String(item.year)) + ')' : ''}</span>
          <span class="collapse-chevron ${_exp ? 'expanded' : ''}">\u25B8</span>
        </div>
        <div class="editor-collapse-body ${_exp ? 'expanded' : ''}">
        <div style="display:grid;gap:0.5em;grid-template-columns:${fields.length <= 4 ? '1fr '.repeat(Math.min(fields.length, 2)) : '1fr 1fr'}">
          ${fields.map(f => `<input class="project-input ed-gen" data-i="${i}" data-f="${f}" value="${escapeHtml(String(item[f] || ''))}" placeholder="${f === 'episodeNumber' ? 'episode #' : f === 'startYear' ? 'start year' : f === 'endYear' ? 'end year' : f === 'productionCompany' ? 'production company' : f === 'cinematographer' ? 'cinematographer (DP)' : f === 'startedDate' ? 'started date' : f === 'estimatedCompletion' ? 'est. completion' : f}" ${f === 'year' || f === 'episodeNumber' || f === 'startYear' || f === 'endYear' ? 'type="number"' : ''}>`).join('')}
        </div>
        ${type === 'film' ? `<textarea class="project-input ed-gen" data-i="${i}" data-f="synopsis" placeholder="synopsis" style="margin-top:0.25em;font-size:0.85em;min-height:2em;resize:vertical;width:100%;box-sizing:border-box">${escapeHtml(item.synopsis || '')}</textarea>` : ''}
        ${type === 'demos' ? `<textarea class="project-input ed-gen" data-i="${i}" data-f="notes" placeholder="WIP notes, known issues" style="margin-top:0.25em;font-size:0.85em;min-height:2em;resize:vertical;width:100%;box-sizing:border-box">${escapeHtml(item.notes || '')}</textarea>` : ''}
        ${type === 'film' || type === 'video' ? (() => {
          const vidUrl = item.video || item.src
          if (vidUrl) {
            const cm = vidUrl.match(/ipfs-proxy\/([A-Za-z0-9]+)/)
            const th = cm ? `/api/video-thumb?cid=${cm[1]}&w=200` : ''
            return `<button class="buy-btn upload-video" data-i="${i}" style="font-size:0.7em;padding:0.1em 0.3ch;margin-top:0.25em">${th ? `<img src="${th}" alt="" style="width:80px;height:45px;object-fit:cover;border-radius:4px;vertical-align:middle" onerror="this.outerHTML='✓ uploaded'"> <span style="color:var(--green);font-size:0.8em">✓</span>` : '✓ uploaded'}</button>`
          }
          return `<button class="buy-btn upload-video" data-i="${i}" style="font-size:0.7em;padding:0.15em 0.5ch;margin-top:0.25em">upload video</button>`
        })() : ''}
        ${type === 'audio' ? `<button class="buy-btn upload-audio" data-i="${i}" style="font-size:0.7em;padding:0.15em 0.5ch;margin-top:0.25em">${item.src ? 'has audio' : 'upload audio'}</button>` : ''}
        ${type === 'demos' ? `
  <div style="display:flex;gap:0.5em;margin-top:0.25em;flex-wrap:wrap">
    <button class="buy-btn upload-demo-media" data-i="${i}" style="font-size:0.7em;padding:0.15em 0.5ch">${item.src ? 'has media' : 'upload media'}</button>
    <button class="buy-btn upload-demo-image" data-i="${i}" style="font-size:0.7em;padding:0.15em 0.5ch">${item.image ? 'has image' : '+ image'}</button>
    <button class="buy-btn upload-demo-video" data-i="${i}" style="font-size:0.7em;padding:0.15em 0.5ch">${item.video ? 'has video' : '+ video'}</button>
  </div>` : ''}
        ${renderSellWidget(item, `sell-gen-${i}`)}
        <div style="display:flex;gap:0.5em;margin-top:0.25em;align-items:center">
          <button class="tag-collab-btn" data-type="${type}" data-i="${i}" style="background:none;border:1px solid var(--border);color:var(--muted);font-family:inherit;font-size:0.7em;padding:0.15em 0.5ch;cursor:pointer">+ collaborator</button>
          ${(item._collabs || []).map(c => `<span class="collab-tag" style="font-size:0.7em;color:var(--accent);border:1px solid var(--accent);padding:0.1em 0.4ch;display:inline-flex;align-items:center;gap:0.3ch">${escapeHtml(c)}<button class="remove-collab-tag" data-domain="${escapeHtml(c)}" data-type="${type}" data-title="${(item.title || 'untitled').replace(/"/g, '&quot;')}" style="background:none;border:none;color:var(--accent);cursor:pointer;font-size:0.9em;padding:0;line-height:1">x</button></span>`).join('')}
          <button class="ed-rm-gen" data-i="${i}" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:0.75em;margin-left:auto">${t('settings.modules.remove')}</button>
        </div>
        </div>
      </div>`
    }).join('') + `<button class="buy-btn add-gen" style="font-size:0.8em;padding:0.3em 1ch;margin-top:0.5em">${type === 'film' ? t('settings.film.addWork') : type === 'audio' ? t('settings.audio.addTrack') : type === 'video' ? '+ add video' : type === 'demos' ? '+ add demo' : t('settings.education.addEvent')}</button>`
    // batch list collection button for video/audio/film (not education or demos)
    + (() => {
      if (type === 'education' || type === 'demos') return ''
      const mediaSrcKey = type === 'film' ? 'video' : 'src'
      const itemsWithSrc = items.filter(it => it[mediaSrcKey] || it.src)
      const unlisted = itemsWithSrc.filter(it => it.mediaId === undefined || it.mediaId === null || it.mediaId === '')
      if (itemsWithSrc.length < 2 || unlisted.length === 0) return ''
      const label = type === 'film' ? 'film' : type === 'video' ? 'video' : 'audio'
      return `<div style="margin-top:0.75em;padding:0.5em;border:1px solid var(--accent);font-size:0.8em">
        <div style="display:flex;gap:0.5em;align-items:center;flex-wrap:wrap">
          <span style="color:var(--accent)">batch list ${unlisted.length} unlisted ${label}${unlisted.length === 1 ? '' : 's'}</span>
          <input type="text" class="project-input batch-gen-price eth-price-input" placeholder="0.01" style="width:8ch;font-size:0.85em;padding:0.2em 0.5ch">
          <span style="color:var(--dim)">ETH each</span><span class="eth-fiat-label" style="color:var(--dim);font-size:0.8em;margin-left:0.5ch"></span>
          <input type="number" class="project-input batch-gen-supply" placeholder="unlimited" style="width:10ch;font-size:0.85em;padding:0.2em 0.5ch">
          <span style="color:var(--dim)">supply</span>
        </div>
        <div class="batch-gen-splits" style="margin-top:0.5em">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span style="color:var(--dim);font-size:0.85em">splits</span>
            <button class="batch-gen-add-split" style="background:none;border:1px solid var(--border);color:var(--muted);font-family:inherit;font-size:0.8em;padding:0.1em 0.5ch;cursor:pointer">+ collaborator</button>
          </div>
          <div class="batch-gen-split-list"></div>
          <div style="color:var(--dim);font-size:0.75em;margin-top:0.25em">you automatically get the remainder (e.g. add a collaborator at 30% and you get 70%) — splits apply to all items</div>
        </div>
        <button class="buy-btn batch-list-gen-btn" style="font-size:0.75em;padding:0.2em 0.8ch;margin-top:0.5em">list collection on-chain</button>
        <span class="batch-gen-status" style="color:var(--muted);font-size:0.85em;margin-left:0.5ch"></span>
      </div>`
    })()

    el.querySelectorAll('.ed-gen').forEach(input => { input.addEventListener('change', () => { items[parseInt(input.dataset.i)][input.dataset.f] = input.type === 'number' ? parseInt(input.value) : input.value }) })
    el.querySelectorAll('.upload-video').forEach(btn => {
      btn.addEventListener('click', () => uploadFile(btn, (url, posterUrl, filename) => {
        const item = items[parseInt(btn.dataset.i)]
        item.video = url
        item.src = url
        if (posterUrl) item.poster = posterUrl
        if (!item.title) item.title = prettifyFilename(filename)
        // Show thumbnail preview instead of plain text
        const cidMatch = url.match(/ipfs-proxy\/([A-Za-z0-9]+)/)
        const thumbUrl = cidMatch ? `/api/video-thumb?cid=${cidMatch[1]}&w=200` : ''
        if (thumbUrl) {
          btn.innerHTML = `<img src="${thumbUrl}" alt="" style="width:80px;height:45px;object-fit:cover;border-radius:4px;vertical-align:middle" onerror="this.outerHTML='✓ uploaded'"> <span style="color:var(--green);font-size:0.8em">✓</span>`
          btn.style.padding = '0.1em 0.3ch'
        } else {
          btn.textContent = '✓ uploaded'
        }
        renderModuleEditor(el, mod)
      }, undefined, { onFileSelected: (file, b) => showLocalMediaPreview(b, file) }))
    })
    el.querySelectorAll('.upload-audio').forEach(btn => {
      btn.addEventListener('click', () => uploadFile(btn, (url, _poster, filename) => {
        const item = items[parseInt(btn.dataset.i)]
        item.src = url
        if (!item.title) item.title = prettifyFilename(filename)
        btn.textContent = 'has audio'
        renderModuleEditor(el, mod)
      }, undefined, { onFileSelected: (file, b) => showLocalMediaPreview(b, file) }))
    })
    el.querySelectorAll('.upload-demo-media').forEach(btn => {
      btn.addEventListener('click', () => uploadFile(btn, (url, posterUrl, filename) => {
        const item = items[parseInt(btn.dataset.i)]
        item.src = url
        if (posterUrl) item.poster = posterUrl
        if (!item.title) item.title = prettifyFilename(filename)
        btn.textContent = 'has media'
        renderModuleEditor(el, mod)
      }, 'audio/*,video/*,image/*,.pdf', { onFileSelected: (file, b) => showLocalMediaPreview(b, file) }))
    })
    el.querySelectorAll('.upload-demo-image').forEach(btn => {
      btn.addEventListener('click', () => uploadFile(btn, (url) => {
        const item = items[parseInt(btn.dataset.i)]
        item.image = url
        btn.textContent = 'has image'
        renderModuleEditor(el, mod)
      }, 'image/*', { onFileSelected: (file, b) => showLocalMediaPreview(b, file) }))
    })
    el.querySelectorAll('.upload-demo-video').forEach(btn => {
      btn.addEventListener('click', () => uploadFile(btn, (url, posterUrl) => {
        const item = items[parseInt(btn.dataset.i)]
        item.video = url
        if (posterUrl) item.poster = posterUrl
        btn.textContent = 'has video'
        renderModuleEditor(el, mod)
      }, 'video/*', { onFileSelected: (file, b) => showLocalMediaPreview(b, file) }))
    })
    el.querySelector('.add-gen')?.addEventListener('click', () => { items.push({}); mod.data = items; _editorExpandedItems.add(`${type}-${items.length - 1}`); renderModuleEditor(el, mod) })
    el.querySelectorAll('.ed-rm-gen').forEach(btn => {
      btn.addEventListener('click', async () => {
        const i = parseInt(btn.dataset.i)
        const item = items[i]
        const ok = await confirmModal({
          title: `remove "${item?.title || 'this entry'}"?`,
          body: item?.mediaId ? 'this item is listed on-chain. removing it from your site does not delist it — to delist, click "delist" first.' : '',
          confirmLabel: 'remove',
        })
        if (!ok) return
        items.splice(i, 1)
        mod.data = items
        renderModuleEditor(el, mod)
        try { await saveSettings() } catch {}
      })
    })
    _wireCollapseToggles(el, type)
    _wireDragDrop(el, '.editor-item[data-gen-drag]', (from, to) => {
      _remapExpandedKeys(type, from, to)
      _arrayMove(items, from, to)
      renderModuleEditor(el, mod)
    })
    // Tag collaborator buttons
    el.querySelectorAll('.tag-collab-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const i = parseInt(btn.dataset.i)
        const itemType = btn.dataset.type
        const item = items[i]
        const domain = await promptModal({ title: 'tag collaborator', placeholder: 'artist domain (e.g. canteenkilla.space)', confirmLabel: 'tag' })
        if (!domain) return
        btn.textContent = 'tagging...'
        try {
          const resp = await fetch('/api/collaborations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${await getSettingsToken()}` },
            body: JSON.stringify({ collaboratorDomain: domain.trim(), itemType, itemTitle: item.title || 'untitled', itemId: `${itemType}-${i}` }),
          })
          if (!resp.ok) { const err = await resp.json().catch(() => ({})); btn.textContent = err.error || 'failed'; setTimeout(() => { btn.textContent = '+ collaborator' }, 2000); return }
          if (!item._collabs) item._collabs = []
          if (!item._collabs.includes(domain.trim())) item._collabs.push(domain.trim())
          renderModuleEditor(el, mod)
        } catch (e) { btn.textContent = 'error'; setTimeout(() => { btn.textContent = '+ collaborator' }, 2000) }
      })
    })
    // Remove collaborator tag buttons
    el.querySelectorAll('.remove-collab-tag').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        _handleRemoveCollabTag(btn, items, el, mod)
      })
    })
    // wire batch generic add-split button
    el.querySelector('.batch-gen-add-split')?.addEventListener('click', () => {
      const list = el.querySelector('.batch-gen-split-list')
      if (list) _addBatchSplitRow(list)
    })

    // wire batch list collection button for video/audio/film
    el.querySelector('.batch-list-gen-btn')?.addEventListener('click', async () => {
      const statusEl = el.querySelector('.batch-gen-status')
      const priceInput = el.querySelector('.batch-gen-price')
      const supplyInput = el.querySelector('.batch-gen-supply')
      const btn = el.querySelector('.batch-list-gen-btn')
      const priceEth = parseFloat(priceInput?.value || '0')
      const maxSupply = parseInt(supplyInput?.value || '0') || 0
      const mediaSrcKey = type === 'film' ? 'video' : 'src'

      // Collect collaborator splits from the batch UI
      const splitList = el.querySelector('.batch-gen-split-list')
      const splitResult = await _collectBatchSplits(splitList)
      if (splitResult.error) { if (statusEl) statusEl.textContent = splitResult.error; return }
      const { collaborators: batchCollabs, splits: batchSplits } = splitResult

      const unlisted = items.filter(it => (it[mediaSrcKey] || it.src) && (it.mediaId === undefined || it.mediaId === null || it.mediaId === ''))
      if (!unlisted.length) { if (statusEl) statusEl.textContent = 'no unlisted items'; return }

      const entries = []
      const entryToItem = []
      for (const it of unlisted) {
        const src = it[mediaSrcKey] || it.src || ''
        const cidMatch = src.match(/ipfs-proxy\/([A-Za-z0-9]+)/)
        const cid = cidMatch ? cidMatch[1] : ''
        if (!cid) continue
        const artSrc = it.poster || it.art || it.coverArt || ''
        const artCidMatch = artSrc.match(/ipfs-proxy\/([A-Za-z0-9]+)/)
        const metadataCid = artCidMatch ? artCidMatch[1] : ''
        entries.push({ title: it.title || 'untitled', ipfsCid: cid, metadataCid, price: priceEth, maxSupply, collaborators: batchCollabs, splits: batchSplits })
        entryToItem.push(it)
      }
      if (!entries.length) { if (statusEl) statusEl.textContent = 'no items on IPFS'; return }

      try {
        if (statusEl) statusEl.textContent = `listing ${entries.length} items... confirm in wallet`
        if (btn) btn.disabled = true
        const { listBatchMedia } = await import('./media.js')
        const ids = await listBatchMedia(entries)
        for (let i = 0; i < ids.length && i < entryToItem.length; i++) {
          entryToItem[i].mediaId = ids[i]
          entryToItem[i].mediaPrice = parseEther(String(priceEth)).toString()
          entryToItem[i].mediaMaxSupply = maxSupply
        }
        if (statusEl) statusEl.textContent = `listed ${ids.length} items — saving...`
        try {
          await api('/api/site', { method: 'PUT', body: JSON.stringify(siteData) })
          if (statusEl) statusEl.textContent = `listed ${ids.length} items — saved`
        } catch { if (statusEl) statusEl.textContent = `listed ${ids.length} items — save failed, click save` }
        renderModuleEditor(el, mod)
      } catch (e) {
        if (btn) btn.disabled = false
        if (statusEl) statusEl.textContent = e.code === 4001 ? 'cancelled' : `error: ${(e.shortMessage || e.message || '').slice(0, 80)}`
      }
    })

    wireSellWidgets(el, (widgetId) => {
      const m = widgetId.match(/sell-gen-(\d+)/)
      return m ? items[parseInt(m[1])] : null
    })

  } else {
    el.innerHTML = `<p style="color:var(--muted);font-size:0.85em">use the AI tab to edit ${escapeHtml(type)} content.</p>`
  }
}

// capture a thumbnail from a video file (browser-side, no server needed)
async function captureVideoThumbnail(file) {
  return new Promise((resolve) => {
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.muted = true
    // Media Rendering Rule: iOS Safari refuses to render a video frame
    // to a canvas from a video element that isn't playsInline. Even
    // though we never .play() this element, some UAs still fullscreen
    // on `.currentTime =`; setting both variants keeps the offscreen
    // capture strictly inline.
    video.playsInline = true
    video.setAttribute('playsinline', '')
    video.src = URL.createObjectURL(file)
    video.addEventListener('loadeddata', () => {
      video.currentTime = Math.min(2, video.duration / 4)
    })
    video.addEventListener('seeked', () => {
      const canvas = document.createElement('canvas')
      canvas.width = Math.min(640, video.videoWidth)
      canvas.height = Math.round(canvas.width * video.videoHeight / video.videoWidth)
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height)
      canvas.toBlob(blob => {
        URL.revokeObjectURL(video.src)
        resolve(blob)
      }, 'image/jpeg', 0.8)
    })
    setTimeout(() => { URL.revokeObjectURL(video.src); resolve(null) }, 5000)
  })
}

// file upload helper — opens file picker, uploads to IPFS, calls callback with URL
/** Poll an IPFS upload job until done/error, returns { cid } or throws */
async function _pollUploadJob(jobId, btn) {
  const POLL_INTERVAL = 2000
  const MAX_POLLS = 300 // 10 min max (300 * 2s)
  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL))
    try {
      const res = await fetch(`/api/ipfs/status/${jobId}`)
      const data = await res.json()
      if (data.status === 'done' && data.cid) return data
      if (data.status === 'error') throw new Error(data.error || 'upload failed')
      // Still queued or processing — update button
      if (data.status === 'queued') btn.textContent = 'queued...'
      else if (data.status === 'processing') btn.textContent = 'uploading to IPFS...'
    } catch (e) {
      if (e.message && e.message !== 'upload failed') throw e
      throw e
    }
  }
  throw new Error('upload timed out')
}

// Derive a prettified title from a filename (strip extension, replace _/- with
// spaces, collapse whitespace, title-case words). Used to auto-fill empty
// title fields on upload across gallery/music/audio/video/demos/library.

// Inline "loading screen" preview: when the user selects a music/audio/video
// file to upload, insert a native <audio>/<video> element next to the upload
// button bound to a local Blob URL so they can scrub the file immediately
// while it uploads to IPFS. The preview persists through the upload phase and
// gets replaced by the IPFS-backed version when renderModuleEditor reruns on
// completion.
function showLocalMediaPreview(btn, file) {
  if (!btn || !file) return
  try {
    // Clear any previous local preview sibling from a prior attempt on the
    // same button (avoids stacking).
    const prev = btn.parentNode?.querySelector('.upload-local-preview')
    if (prev) {
      const old = prev.querySelector('audio,video')
      if (old?.src?.startsWith('blob:')) { try { URL.revokeObjectURL(old.src) } catch {} }
      prev.remove()
    }
    const url = URL.createObjectURL(file)
    const wrap = document.createElement('div')
    wrap.className = 'upload-local-preview'
    wrap.style.cssText = 'display:block;margin-top:0.35em;max-width:320px'
    const isVideo = file.type.startsWith('video/')
    const isAudio = file.type.startsWith('audio/')
    if (!isVideo && !isAudio) { URL.revokeObjectURL(url); return }
    if (isVideo) {
      wrap.innerHTML = `<video controls preload="metadata" playsinline src="${url}" style="width:100%;max-height:180px;background:#000"></video>`
    } else {
      // Persistent-player pattern (see Media Rendering Rules) — routes the
      // blob preview through player.js so it inherits site chrome, keyboard
      // shortcuts, and Media Session controls instead of raw browser chrome.
      wrap.innerHTML = `<button class="track-play-btn" data-track-src="${url}" data-track-title="${file.name || 'upload preview'}">play</button>`
    }
    // Insert right after the button
    if (btn.nextSibling) btn.parentNode.insertBefore(wrap, btn.nextSibling)
    else btn.parentNode.appendChild(wrap)
  } catch (e) { /* non-fatal */ }
}

async function uploadFile(btn, callback, acceptTypes, options) {
  // Prevent concurrent uploads on the same button
  if (btn.dataset.uploading === '1') return
  btn.dataset.uploading = '1'
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = acceptTypes || 'image/*,audio/*,video/*'
  input.style.display = 'none'
  document.body.appendChild(input)
  input.onchange = async () => {
    input.remove()
    let file = input.files[0]
    if (!file) { btn.dataset.uploading = ''; return }
    // Optional hook: inline preview of the local file before upload (blob URL).
    // Used by music/audio/video upload buttons to show a scrubbable player
    // while the file uploads to IPFS.
    try { options?.onFileSelected?.(file, btn) } catch {}
    btn.disabled = true
    const originalText = btn.textContent
    // Optional transform hook — e.g. profile pics downsize to 512px before
    // hitting the network so a 6 MB camera photo becomes a 100 KB avatar.
    if (options?.transformFile) {
      try {
        btn.textContent = 'processing…'
        const transformed = await options.transformFile(file)
        if (transformed && transformed.size > 0) file = transformed
      } catch (e) { console.warn('transformFile failed, using original:', e?.message) }
    }
    // 20 GB cap matches the server-side MAX_UPLOAD. Visual artists routinely
    // need to upload raw 4K video / archival audio that exceeds the old 2GB
    // ceiling. Show a friendlier label for very large files.
    const maxMB = 20 * 1024
    if (file.size > maxMB * 1024 * 1024) {
      btn.textContent = `max 20GB`
      setTimeout(() => { btn.textContent = t('settings.music.upload') }, 2000)
      return
    }
    const sizeMB = (file.size / 1024 / 1024).toFixed(1)
    btn.textContent = `uploading ${sizeMB}MB...`
    btn.style.background = `linear-gradient(to right, var(--green) 0%, transparent 0%)`
    try {
      // Get token (cached if still valid, refreshes if >20min old)
      let token = await getSettingsToken()
      if (!token) {
        // Token failed — actively prompt unlock and retry
        btn.textContent = 'unlocking wallet...'
        try {
          await window.ensureAuthorized?.()
          token = await getSettingsToken()
        } catch {}
        if (!token) { btn.textContent = originalText || 'upload'; btn.disabled = false; return }
      }

      // Phase 1: Stream file to server temp disk via XHR (shows upload progress).
      // Retries + network-failure handling live in the shared helper.
      const queueData = await uploadToIpfsXhr(file.name, file, token, {
        onProgress: (pct, attempt) => {
          const suffix = attempt > 1 ? ` (retry ${attempt - 1})` : ''
          btn.textContent = `${pct}%${suffix}`
          btn.style.background = `linear-gradient(to right, var(--green) ${pct}%, transparent ${pct}%)`
        },
        onRetry: (attempt, total, wait) => {
          btn.style.background = ''
          btn.textContent = `reconnecting in ${Math.round(wait / 1000)}s…`
        },
      })
      btn.style.background = ''

      if (queueData.error) {
        btn.textContent = queueData.error.slice(0, 30)
        return
      }

      // Phase 2: If server returned a jobId, poll for Kubo processing completion
      let cid
      if (queueData.jobId) {
        btn.textContent = 'queued...'
        const result = await _pollUploadJob(queueData.jobId, btn)
        cid = result.cid
      } else if (queueData.cid) {
        // Fallback: server returned CID directly (legacy/direct mode)
        cid = queueData.cid
      } else {
        btn.textContent = 'failed'
        return
      }

      const url = `/api/ipfs-proxy/${cid}`
      // for video files, capture a thumbnail and upload it as poster
      let posterUrl = null
      if (file.type.startsWith('video/')) {
        try {
          btn.textContent = 'generating poster...'
          const posterBlob = await captureVideoThumbnail(file)
          if (posterBlob) {
            const posterBuffer = await posterBlob.arrayBuffer()
            // Poster upload also goes through the queue
            const posterQueue = await uploadToIpfs(`poster-${cid}.jpg`, posterBuffer, token)
            if (posterQueue.jobId) {
              btn.textContent = 'uploading poster...'
              const posterResult = await _pollUploadJob(posterQueue.jobId, btn)
              if (posterResult.cid) posterUrl = `/api/ipfs-proxy/${posterResult.cid}`
            } else if (posterQueue.cid) {
              posterUrl = `/api/ipfs-proxy/${posterQueue.cid}`
            }
          }
        } catch (e) { console.warn('poster capture failed:', e) }
      }
      // Pass the original filename through so handlers can auto-fill empty
      // title fields on the item being edited (gallery, music, audio,
      // video, demos, library doc, etc.).
      callback(url, posterUrl, file.name)
      btn.textContent = originalText || 'upload'
      // auto-save after successful upload
      try { await saveSettings() } catch {}
    } catch (e) { btn.textContent = e.message?.slice(0, 30) || t('settings.error') } finally {
      btn.disabled = false
      btn.dataset.uploading = ''
    }
  }
  // If user cancels the file picker, re-enable
  input.addEventListener('cancel', () => { input.remove(); btn.dataset.uploading = ''; btn.disabled = false })
  input.click()
}

function wireEditorEvents(el, mod, items) {
  const _setData = () => { if (mod.type === 'credits') { mod.data.items = items } else { mod.data = items } }
  // field changes
  el.querySelectorAll('.ed-field').forEach(input => {
    input.addEventListener('change', () => {
      const i = parseInt(input.dataset.i)
      const f = input.dataset.f
      items[i][f] = input.type === 'number' ? (parseInt(input.value) || null) : input.value
      _setData()
    })
  })

  // remove (gated behind a confirm modal — applies to credits, education,
  // technology, etc. via the shared wireEditorEvents helper)
  el.querySelectorAll('.ed-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      const i = parseInt(btn.dataset.i)
      const item = items[i]
      const ok = await confirmModal({
        title: `remove "${item?.title || item?.role || item?.org || 'this entry'}"?`,
        confirmLabel: 'remove',
      })
      if (!ok) return
      items.splice(i, 1)
      _setData()
      renderModuleEditor(el, mod)
      try { await saveSettings() } catch {}
    })
  })

  // add
  el.querySelector('.ed-add')?.addEventListener('click', () => {
    items.push({})
    _setData()
    _editorExpandedItems.add(`${mod.type}-${items.length - 1}`)
    renderModuleEditor(el, mod)
  })

  // tag collaborator buttons (shared across credits, education, technology)
  el.querySelectorAll('.tag-collab-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const i = parseInt(btn.dataset.i)
      const itemType = btn.dataset.type || mod.type
      const item = items[i]
      const domain = await promptModal({ title: 'tag collaborator', placeholder: 'artist domain (e.g. canteenkilla.space)', confirmLabel: 'tag' })
      if (!domain) return
      btn.textContent = 'tagging...'
      try {
        const resp = await fetch('/api/collaborations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${await getSettingsToken()}` },
          body: JSON.stringify({ collaboratorDomain: domain.trim(), itemType, itemTitle: item.title || item.role || 'untitled', itemId: `${itemType}-${i}` }),
        })
        if (!resp.ok) { const err = await resp.json().catch(() => ({})); btn.textContent = err.error || 'failed'; setTimeout(() => { btn.textContent = '+ collaborator' }, 2000); return }
        if (!item._collabs) item._collabs = []
        if (!item._collabs.includes(domain.trim())) item._collabs.push(domain.trim())
        renderModuleEditor(el, mod)
      } catch { btn.textContent = 'error'; setTimeout(() => { btn.textContent = '+ collaborator' }, 2000) }
    })
  })

  // Remove collaborator tag buttons (shared across credits, education, technology)
  el.querySelectorAll('.remove-collab-tag').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      _handleRemoveCollabTag(btn, items, el, mod)
    })
  })
}

// --- Theme Tab ---

function contrastBadge(ratio, adjusted) {
  const passes = ratio >= 4.5
  const ratioStr = ratio.toFixed(1) + ':1'
  if (passes && !adjusted) {
    return `<span style="color:var(--green);font-size:0.8em">${ratioStr} ${t('settings.theme.passes')}</span>`
  }
  if (adjusted) {
    return `<span style="color:#da3;font-size:0.8em">${ratioStr} -- ${t('settings.theme.adjusted')}</span>`
  }
  return `<span style="color:#e55;font-size:0.8em">${ratioStr}</span>`
}

function lightnessShift(original, corrected) {
  const [,, origL] = hexToHsl(original)
  const [,, corrL] = hexToHsl(corrected)
  return Math.abs(origL - corrL)
}

const THEME_PRESETS = [
  { key: 'dark',       label: 'dark',        bg: '#0a0a0a', fg: '#c0c0c0', accent: '#ffffff' },
  { key: 'terminal',   label: 'terminal',    bg: '#0a0a0a', fg: '#c0c0c0', accent: '#00ff41' },
  { key: 'paper',      label: 'paper',       bg: '#f5f2ea', fg: '#2a2a2a', accent: '#a04000' },
  { key: 'high',       label: 'high contrast', bg: '#000000', fg: '#ffffff', accent: '#ffff00' },
  { key: 'blueprint',  label: 'blueprint',   bg: '#0c1a2b', fg: '#c9d4e0', accent: '#4aa3ff' },
  { key: 'garden',     label: 'garden',      bg: '#f8f6ee', fg: '#3a3a2a', accent: '#3a7d3a' },
]

function renderThemeTab(el) {
  const theme = siteData.theme || {}
  // Cache the last saved theme so users can bail out of an experiment.
  el._lastSavedTheme = { bg: theme.bg || '#0a0a0a', fg: theme.fg || '#c0c0c0', accent: theme.accent || '#ffffff', font: theme.font || "-apple-system, 'Helvetica Neue', Arial, sans-serif" }
  const fonts = [
    { value: "-apple-system, 'Helvetica Neue', Arial, sans-serif", label: t('settings.theme.systemDefault'), key: 'apple-system' },
    { value: "Georgia, 'Times New Roman', serif", label: t('settings.theme.serif'), key: 'Georgia' },
    { value: "'Courier New', monospace", label: t('settings.theme.monospace'), key: 'Courier' },
  ]
  const customPresets = Array.isArray(theme.presets) ? theme.presets : []
  el.innerHTML = `
    <div style="max-width:520px">
      <div style="margin-bottom:1em">
        <div class="settings-label" style="margin-bottom:0.5em">quick presets</div>
        <div id="theme-presets" style="display:flex;flex-wrap:wrap;gap:0.6ch">
          ${THEME_PRESETS.map(p => `
            <button type="button" class="theme-preset-btn" data-preset="${p.key}"
              style="border:1px solid var(--border);padding:0.35em 0.9ch;background:${p.bg};color:${p.fg};font-size:0.85em;cursor:pointer;display:inline-flex;align-items:center;gap:0.5ch">
              <span style="display:inline-block;width:0.7em;height:0.7em;background:${p.accent};border-radius:50%"></span>
              ${p.label}
            </button>
          `).join('')}
          <button type="button" id="theme-reset" style="border:1px solid var(--border);padding:0.35em 0.9ch;background:transparent;color:var(--dim);font-size:0.85em;cursor:pointer">revert to saved</button>
        </div>
      </div>

      <div style="margin-bottom:1em">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5em">
          <div class="settings-label">your palettes</div>
          <button type="button" id="theme-save-preset" style="border:1px solid var(--border);padding:0.3em 0.9ch;background:transparent;color:var(--fg);font-size:0.8em;cursor:pointer">save current +</button>
        </div>
        <div id="theme-custom-presets" style="display:flex;flex-wrap:wrap;gap:0.6ch">
          ${customPresets.length === 0 ? `<span style="color:var(--dim);font-size:0.8em">save your current colors as a named palette to reuse later</span>` : customPresets.map((p, i) => `
            <div class="theme-custom-preset" data-index="${i}"
              style="border:1px solid var(--border);padding:0.35em 0.9ch;background:${escapeHtml(p.bg)};color:${escapeHtml(p.fg)};font-size:0.85em;display:inline-flex;align-items:center;gap:0.5ch">
              <button type="button" class="theme-custom-apply" data-index="${i}"
                style="background:transparent;border:0;color:inherit;font:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:0.5ch;padding:0">
                <span style="display:inline-block;width:0.7em;height:0.7em;background:${escapeHtml(p.accent)};border-radius:50%"></span>
                ${escapeHtml(p.name || 'unnamed')}
              </button>
              <button type="button" class="theme-custom-remove" data-index="${i}" aria-label="delete palette"
                style="background:transparent;border:0;color:inherit;font:inherit;cursor:pointer;opacity:0.6;padding:0 0 0 0.2ch">×</button>
            </div>
          `).join('')}
        </div>
      </div>

      <div class="settings-field">
        <label class="settings-label">${t('settings.theme.background')}</label>
        <div style="display:flex;align-items:center;gap:1.5ch">
          <label class="settings-swatch" style="background:${theme.bg || '#0a0a0a'};position:relative;overflow:hidden">
            <input type="color" id="s-theme-bg" value="${theme.bg || '#0a0a0a'}" style="position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%">
          </label>
          <span id="s-theme-bg-hex" style="color:var(--dim);font-size:0.85em;font-family:monospace">${theme.bg || '#0a0a0a'}</span>
        </div>
      </div>
      <div class="settings-field">
        <label class="settings-label">${t('settings.theme.text')}</label>
        <div style="display:flex;align-items:center;gap:1.5ch">
          <label class="settings-swatch" style="background:${theme.fg || '#c0c0c0'};position:relative;overflow:hidden">
            <input type="color" id="s-theme-fg" value="${theme.fg || '#c0c0c0'}" style="position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%">
          </label>
          <span id="s-theme-fg-hex" style="color:var(--dim);font-size:0.85em;font-family:monospace">${theme.fg || '#c0c0c0'}</span>
          <span id="contrast-badge-fg"></span>
        </div>
      </div>
      <div class="settings-field">
        <label class="settings-label">${t('settings.theme.accent')}</label>
        <div style="display:flex;align-items:center;gap:1.5ch">
          <label class="settings-swatch" style="background:${theme.accent || '#ffffff'};position:relative;overflow:hidden">
            <input type="color" id="s-theme-accent" value="${theme.accent || '#ffffff'}" style="position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%">
          </label>
          <span id="s-theme-accent-hex" style="color:var(--dim);font-size:0.85em;font-family:monospace">${theme.accent || '#ffffff'}</span>
          <span id="contrast-badge-accent"></span>
        </div>
      </div>
      <div class="settings-field">
        <label class="settings-label">${t('settings.theme.font')}</label>
        <select id="s-theme-font" class="project-input" style="display:none">
          ${fonts.map(f => `<option value="${f.value}" ${theme.font?.includes(f.key) ? 'selected' : ''}>${f.label}</option>`).join('')}
        </select>
        <div id="font-preview-list">
          ${fonts.map(f => {
            const isActive = theme.font?.includes(f.key) || (!theme.font && f.key === 'apple-system')
            return `<div class="font-preview-card ${isActive ? 'active' : ''}" data-font="${f.value}">
              <div style="font-family:${f.value};font-size:1.3em;color:var(--fg);margin-bottom:0.3em">Aa Bb Cc 123</div>
              <div style="font-size:0.85em;color:var(--dim)">${f.label}</div>
            </div>`
          }).join('')}
        </div>
      </div>
      <div id="contrast-warning" style="display:none;margin-top:0.5em;padding:0.5em;border:1px solid #da3;color:#da3;font-size:0.85em"></div>
      <div style="margin-top:1.5em;padding:1.25em;border:1px solid var(--border);border-radius:4px">
        <div id="theme-preview" style="padding:1em;border-radius:4px">
          <span style="font-size:1.2em">${t('settings.theme.preview')}</span>
          <p style="opacity:0.7;margin-top:0.5em">${t('settings.theme.howItLooks')}</p>
        </div>
      </div>

      <hr style="border:none;border-top:1px solid var(--border);margin:2em 0">
      <h3 style="font-size:1em;margin-bottom:1em">app settings (PWA)</h3>
      <p style="color:var(--dim);font-size:0.85em;margin-bottom:1em">customize how your site appears when installed as an app on phones and tablets.</p>
      <div class="settings-field">
        <label class="settings-label">app name</label>
        <input type="text" id="s-pwa-name" class="project-input" value="${escapeHtml(siteData.pwa?.name || siteData.name || '')}" placeholder="${escapeHtml(siteData.name || 'my site')}" style="max-width:300px">
        <p style="color:var(--dim);font-size:0.75em;margin-top:0.25em">shown on the home screen when installed</p>
      </div>
      <div class="settings-field">
        <label class="settings-label">app icon (512x512 PNG)</label>
        <div style="display:flex;align-items:center;gap:1em">
          ${siteData.pwa?.icon ? `<img src="${escapeHtml(siteData.pwa.icon)}" style="width:64px;height:64px;border-radius:12px;border:1px solid var(--border)">` : '<div style="width:64px;height:64px;border-radius:12px;border:1px dashed var(--border);display:flex;align-items:center;justify-content:center;color:var(--dim)"><i class="ph ph-image" style="font-size:1.5em"></i></div>'}
          <div>
            <input type="file" id="s-pwa-icon" accept="image/png" style="display:none">
            <button type="button" id="s-pwa-icon-btn" class="feed-card-btn" style="font-size:0.8em">upload icon</button>
            <p style="color:var(--dim);font-size:0.75em;margin-top:0.25em">square PNG, at least 512x512px</p>
          </div>
        </div>
      </div>
      <div class="settings-field">
        <label class="settings-label">splash background color</label>
        <div style="display:flex;align-items:center;gap:1ch">
          <label class="settings-swatch" style="background:${siteData.pwa?.background || theme.bg || '#0a0a0a'};position:relative;overflow:hidden">
            <input type="color" id="s-pwa-bg" value="${siteData.pwa?.background || theme.bg || '#0a0a0a'}" style="position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%">
          </label>
          <span style="color:var(--dim);font-size:0.85em">shown during app launch</span>
        </div>
      </div>
    </div>
  `

  // live preview with contrast correction
  const preview = document.getElementById('theme-preview')
  function updatePreview() {
    const bg = document.getElementById('s-theme-bg').value
    const fg = document.getElementById('s-theme-fg').value
    const accent = document.getElementById('s-theme-accent').value
    const fontSel = document.getElementById('s-theme-font')
    const fontFamily = fontSel?.value || "-apple-system, 'Helvetica Neue', Arial, sans-serif"

    const palette = deriveFullPalette(bg, fg, accent)

    // update badges
    const fgBadge = document.getElementById('contrast-badge-fg')
    const accentBadge = document.getElementById('contrast-badge-accent')
    if (fgBadge) fgBadge.innerHTML = contrastBadge(palette.fg.ratio, palette.fg.adjusted)
    if (accentBadge) accentBadge.innerHTML = contrastBadge(palette.accent.ratio, palette.accent.adjusted)

    // show warning if large adjustment
    const warning = document.getElementById('contrast-warning')
    if (warning) {
      const fgShift = palette.fg.adjusted ? lightnessShift(fg, palette.fg.color) : 0
      const accentShift = palette.accent.adjusted ? lightnessShift(accent, palette.accent.color) : 0
      if (fgShift > 35 || accentShift > 35) {
        warning.style.display = 'block'
        warning.textContent = t('settings.theme.warning')
      } else {
        warning.style.display = 'none'
      }
    }

    // preview uses corrected colors
    preview.style.background = bg
    preview.style.color = palette.fg.color
    preview.style.fontFamily = fontFamily
    preview.querySelector('span').style.color = palette.accent.color
  }

  // PWA icon upload
  document.getElementById('s-pwa-icon-btn')?.addEventListener('click', () => {
    document.getElementById('s-pwa-icon')?.click()
  })
  document.getElementById('s-pwa-icon')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    // Validate: must be PNG, at least 512x512
    if (!file.type.startsWith('image/png')) { alert('Please upload a PNG file'); return }
    const btn = document.getElementById('s-pwa-icon-btn')
    btn.textContent = 'uploading...'
    try {
      let authToken = sessionStorage.getItem('praxis-auth-token') || ''
      if (!authToken) {
        await window.ensureAuthorized?.()
        const addr = window.getWalletAddress?.()
        const provider = window.getWalletProvider?.()
        if (provider && addr) {
          const msg = `admin:${location.hostname}:${Date.now()}`
          const sig = await provider.request({ method: 'personal_sign', params: [msg, addr] })
          const authRes = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: addr, signature: sig, message: msg }) })
          const authData = await authRes.json()
          if (authData.token) { authToken = authData.token; sessionStorage.setItem('praxis-auth-token', authToken) }
        }
      }
      // PWA icons are always small (512px max), so a plain fetch-with-retry
      // is sufficient — no progress bar needed for a ~50KB payload.
      const resized = await resizeImageFile(file, 512, 0.92)
      const buf = await resized.arrayBuffer()
      const uploadData = await uploadToIpfs('pwa-icon.png', buf, authToken)
      if (uploadData.jobId) {
        for (let i = 0; i < 30; i++) {
          await new Promise(r => setTimeout(r, 1000))
          const s = await fetch(`/api/ipfs/status/${uploadData.jobId}`).then(r => r.json())
          if (s.cid) {
            if (!siteData.pwa) siteData.pwa = {}
            siteData.pwa.icon = `/api/ipfs-proxy/${s.cid}`
            btn.textContent = 'uploaded ✓'
            break
          }
          if (s.status === 'error') { btn.textContent = 'upload failed'; break }
        }
      }
    } catch { btn.textContent = 'error' }
    setTimeout(() => { btn.textContent = 'upload icon' }, 3000)
  })

  // Set a specific color input + reflect in swatch + hex label + preview.
  // Dispatches an 'input' event so the panel-level autosave debounce picks it up.
  function setColorInput(id, value) {
    const input = document.getElementById(id)
    if (!input) return
    input.value = value
    const swatch = input.closest('.settings-swatch')
    if (swatch) swatch.style.background = value
    const hex = document.getElementById(id + '-hex')
    if (hex) hex.textContent = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  document.getElementById('s-theme-bg')?.addEventListener('input', () => {
    const v = document.getElementById('s-theme-bg').value
    const swatch = document.getElementById('s-theme-bg')?.closest('.settings-swatch')
    if (swatch) swatch.style.background = v
    const hex = document.getElementById('s-theme-bg-hex')
    if (hex) hex.textContent = v
    updatePreview()
  })
  document.getElementById('s-theme-fg')?.addEventListener('input', () => {
    const v = document.getElementById('s-theme-fg').value
    const swatch = document.getElementById('s-theme-fg')?.closest('.settings-swatch')
    if (swatch) swatch.style.background = v
    const hex = document.getElementById('s-theme-fg-hex')
    if (hex) hex.textContent = v
    updatePreview()
  })
  document.getElementById('s-theme-accent')?.addEventListener('input', () => {
    const v = document.getElementById('s-theme-accent').value
    const swatch = document.getElementById('s-theme-accent')?.closest('.settings-swatch')
    if (swatch) swatch.style.background = v
    const hex = document.getElementById('s-theme-accent-hex')
    if (hex) hex.textContent = v
    updatePreview()
  })
  el.querySelectorAll('.theme-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = THEME_PRESETS.find(x => x.key === btn.dataset.preset)
      if (!p) return
      setColorInput('s-theme-bg', p.bg)
      setColorInput('s-theme-fg', p.fg)
      setColorInput('s-theme-accent', p.accent)
    })
  })
  document.getElementById('theme-reset')?.addEventListener('click', () => {
    const saved = el._lastSavedTheme || {}
    setColorInput('s-theme-bg', saved.bg || '#0a0a0a')
    setColorInput('s-theme-fg', saved.fg || '#c0c0c0')
    setColorInput('s-theme-accent', saved.accent || '#ffffff')
  })
  document.getElementById('theme-save-preset')?.addEventListener('click', () => {
    const name = (prompt('name this palette') || '').trim().slice(0, 40)
    if (!name) return
    const bg = document.getElementById('s-theme-bg').value
    const fg = document.getElementById('s-theme-fg').value
    const accent = document.getElementById('s-theme-accent').value
    // Belt-and-suspenders: validate hex at save-time. Every reader that
    // renders these into a style attribute goes through escapeHtml, but
    // that doesn't escape CSS metacharacters (; ( ) whitespace), so if
    // one of these values were ever a `red;background:url(evil)` string
    // it'd break out of the swatch's style. Enforce here so the payload
    // that lands on-chain can never contain non-hex.
    const HEX = /^#[0-9a-fA-F]{3,8}$/
    if (!HEX.test(bg) || !HEX.test(fg) || !HEX.test(accent)) return
    if (!siteData.theme) siteData.theme = {}
    const presets = Array.isArray(siteData.theme.presets) ? siteData.theme.presets : []
    presets.push({ name, bg, fg, accent })
    // Cap to 12 to keep the payload reasonable.
    siteData.theme.presets = presets.slice(-12)
    renderThemeTab(el)
    // Nudge autosave — panel input event debounces to a PUT.
    document.getElementById('settings-panel')?.dispatchEvent(new Event('input', { bubbles: true }))
  })
  el.querySelectorAll('.theme-custom-apply').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.index, 10)
      const p = (siteData.theme?.presets || [])[i]
      if (!p) return
      setColorInput('s-theme-bg', p.bg)
      setColorInput('s-theme-fg', p.fg)
      setColorInput('s-theme-accent', p.accent)
    })
  })
  el.querySelectorAll('.theme-custom-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.index, 10)
      const presets = siteData.theme?.presets || []
      if (i < 0 || i >= presets.length) return
      presets.splice(i, 1)
      renderThemeTab(el)
      document.getElementById('settings-panel')?.dispatchEvent(new Event('input', { bubbles: true }))
    })
  })
  // Font preview cards
  el.querySelectorAll('.font-preview-card').forEach(card => {
    card.addEventListener('click', () => {
      el.querySelectorAll('.font-preview-card').forEach(c => c.classList.remove('active'))
      card.classList.add('active')
      const fontSel = document.getElementById('s-theme-font')
      if (fontSel) { fontSel.value = card.dataset.font; fontSel.dispatchEvent(new Event('change', { bubbles: true })) }
      updatePreview()
    })
  })
  document.getElementById('s-theme-font')?.addEventListener('change', updatePreview)
  updatePreview()
}

// --- AI Tab ---

// ai tab removed — local Ollama too slow to be useful

// --- Save ---

async function saveSettings() {
  // skip if no auth token — don't prompt wallet during autosave
  if (!settingsToken) return
  const statusEl = document.getElementById('settings-status')
  if (statusEl) statusEl.textContent = 'saving...'
  _savingInFlight = true

  // read identity fields
  const nameEl = document.getElementById('s-name')
  const bioEl = document.getElementById('s-bio')
  const shortBioEl = document.getElementById('s-short-bio')
  const templateEl = document.getElementById('s-template')
  if (nameEl) siteData.name = nameEl.value
  if (bioEl) siteData.bio = bioEl.value
  if (shortBioEl) siteData.shortBio = shortBioEl.value
  if (templateEl) siteData.template = templateEl.value

  // read theme
  const bg = document.getElementById('s-theme-bg')
  const fg = document.getElementById('s-theme-fg')
  const accent = document.getElementById('s-theme-accent')
  const font = document.getElementById('s-theme-font')
  if (bg) {
    if (!siteData.theme) siteData.theme = {}
    siteData.theme.bg = bg.value
    siteData.theme.fg = fg?.value || '#c0c0c0'
    siteData.theme.accent = accent?.value || '#ffffff'
    siteData.theme.font = font?.value || "-apple-system, 'Helvetica Neue', Arial, sans-serif"
  }

  // PWA settings — only persist a value the user actually typed or picked.
  // The s-pwa-bg input's initial value falls back to theme.bg, so writing
  // it unconditionally locks a stale bg into siteData.pwa.background on
  // every save, which then drifts the theme swatch on the next re-render.
  const pwaNameEl = document.getElementById('s-pwa-name')
  const pwaBgEl = document.getElementById('s-pwa-bg')
  const pwaName = pwaNameEl?.value?.trim()
  const pwaBg = pwaBgEl?.value
  const pwaNameDirty = !!pwaNameEl && pwaName !== (siteData.pwa?.name || '')
  const pwaBgDirty = !!pwaBgEl && pwaBg && pwaBg !== (siteData.pwa?.background || '')
  if (pwaNameDirty || pwaBgDirty) {
    if (!siteData.pwa) siteData.pwa = {}
    if (pwaNameDirty) siteData.pwa.name = pwaName
    if (pwaBgDirty) siteData.pwa.background = pwaBg
  }

  try {
    await api('/api/site', {
      method: 'PUT',
      body: JSON.stringify(siteData),
    })
    if (statusEl) statusEl.textContent = 'saved'
    setTimeout(() => { if (statusEl) statusEl.textContent = '' }, 2000)
  } catch (e) {
    if (statusEl) statusEl.textContent = 'error saving'
  } finally {
    _savingInFlight = false
  }
}
