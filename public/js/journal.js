// Journal — encrypted private writing, wallet-only access
// Includes script mode: Fountain-based screenplay editor
import { escapeHtml, registerPage, getWalletProvider } from './utils.js'
import { t, whenReady as i18nReady } from './i18n.js'
import {
  FOUNTAIN_MARKER, ELEM_TYPES, STAGE_ELEM_TYPES, SCRIPT_FORMATS,
  detectLineType, parseFountain, stripForcedMarker,
  nextTypeAfterEnter, cycleType, cycleTypePrev,
  isFountainContent, extractFountainBody,
  wrapFountainForStorage, fountainToHtml,
  isStagePlayContent, extractStagePlayBody,
  detectScriptFormat, getFormatFunctions,
} from './fountain.js'

let journalToken = sessionStorage.getItem('praxis:journal-token') || ''
window.addEventListener('wallet-connected', () => { journalToken = ''; try { sessionStorage.removeItem('praxis:journal-token') } catch {} })
window.addEventListener('wallet-disconnected', () => { journalToken = ''; try { sessionStorage.removeItem('praxis:journal-token') } catch {} })
let _journalWalletListenersBound = false

// Re-authenticate when session expires (server restart, 24h expiry)
async function reauthJournal() {
  const addr = window.getWalletAddress?.()
  if (!addr || !getWalletProvider()) return false
  try {
    await window.ensureAuthorized?.()
    const authMsg = `admin:${location.hostname}:${Date.now()}`
    const authSig = await getWalletProvider().request({ method: 'personal_sign', params: [authMsg, addr] })
    const authRes = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: addr, signature: authSig, message: authMsg }),
    })
    const authData = await authRes.json()
    if (authData.error) return false
    journalToken = authData.token
    sessionStorage.setItem('praxis:journal-token', journalToken)

    // re-derive and set journal key
    const keyMsg = `praxis:journal-key:v1:${addr.toLowerCase()}`
    const keySig = await getWalletProvider().request({ method: 'personal_sign', params: [keyMsg, addr.toLowerCase()] })
    const sigBytes = new Uint8Array(keySig.slice(2).match(/.{2}/g).map(b => parseInt(b, 16)))
    const hashBuffer = await crypto.subtle.digest('SHA-256', sigBytes)
    const keyHex = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('')
    await fetch('/api/journal-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${journalToken}` },
      body: JSON.stringify({ key: keyHex }),
    })
    return true
  } catch { return false }
}

function scriptPrintHtml(title, body, format) {
  // Industry-standard screenplay margins (8.5"x11", 1.5" left page margin)
  // Character: 3.7" from page left = 2.2" into 6" text area
  // Dialogue:  2.5" from page left = 1.0" into text, right edge at 6.0"
  // Paren:     3.1" from page left = 1.6" into text, right at 5.6"
  const screenplayCSS = `
.fountain-blank { height: 12pt; }
.fountain-scene { text-transform: uppercase; font-weight: bold; margin-top: 1em; text-align: left; }
.fountain-action { margin-top: 0.5em; text-align: left; }
.fountain-character { text-transform: uppercase; margin-left: 2.2in; margin-top: 1em; }
.fountain-dialogue { margin-left: 1.0in; margin-right: 1.5in; }
.fountain-paren { margin-left: 1.6in; margin-right: 1.9in; font-style: italic; }
.fountain-transition { text-align: right; text-transform: uppercase; margin-top: 1em; }`

  // Stage play formatting (Samuel French style)
  const stageplayCSS = `
.stageplay-blank { height: 12pt; }
.stageplay-act { text-transform: uppercase; font-weight: bold; text-decoration: underline; text-align: center; font-size: 14pt; margin-top: 2em; margin-bottom: 0.5em; }
.stageplay-scene { text-transform: uppercase; font-weight: bold; text-align: center; margin-top: 1.5em; margin-bottom: 0.5em; }
.stageplay-direction { font-style: italic; margin-top: 0.5em; margin-left: 0.5in; margin-right: 0.5in; }
.stageplay-character { text-transform: uppercase; font-weight: bold; margin-top: 1em; text-align: left; }
.stageplay-dialogue { margin-left: 0.5in; }
.stageplay-paren { font-style: italic; margin-left: 0.5in; }
.stageplay-action { margin-top: 0.5em; }`

  const css = format === 'stageplay' ? stageplayCSS : screenplayCSS
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>
@page { size: letter; margin: 1in 1in 1in 1.5in; }
body { font-family: 'Courier New', Courier, monospace; font-size: 12pt; line-height: 1; color: #000; }
h1 { text-align: center; font-size: 14pt; margin-bottom: 2em; text-transform: uppercase; }
p { margin: 0; padding: 0; }
${css}
</style></head>
<body><h1>${title}</h1>${body}</body></html>`
}

registerPage('journal-page', initJournal)

function fountainToPlain(editorEl) {
  const lines = []
  for (const child of editorEl.children) {
    lines.push(child.textContent)
  }
  return lines.join('\n')
}

// --- Main init ---

async function initJournal() {
  await i18nReady()
  const statusEl = document.getElementById('journal-status')
  const contentEl = document.getElementById('journal-content')

  function checkWallet() {
    const sEl = document.getElementById('journal-status')
    const cEl = document.getElementById('journal-content')
    if (!sEl || !cEl) return
    const addr = window.getWalletAddress?.()
    const owner = document.body.dataset.owner
    if (!addr || !owner || addr.toLowerCase() !== owner.toLowerCase()) {
      sEl.textContent = t('journal.connectOwner')
      cEl.innerHTML = ''
      return
    }
    sEl.textContent = ''
    showUnlock()
  }

  if (!_journalWalletListenersBound) {
    _journalWalletListenersBound = true
    window.addEventListener('wallet-connected', checkWallet)
    window.addEventListener('wallet-disconnected', checkWallet)
  }
  checkWallet()

  function showUnlock() {
    // clear status message (may have shown "connect wallet" before wallet connected)
    const s = document.getElementById('journal-status')
    if (s) s.textContent = ''
    contentEl.innerHTML = `
      <div style="text-align:center;padding:3em 0">
        <p id="journal-unlock-status" style="color:var(--muted);margin-bottom:1em">${t('journal.encrypted')}</p>
        <button class="buy-btn" id="journal-unlock">${t('journal.signToUnlock')}</button>
      </div>
    `
    document.getElementById('journal-unlock').addEventListener('click', unlock)
  }

  async function unlock() {
    const unlockStatus = document.getElementById('journal-unlock-status')
    const unlockBtn = document.getElementById('journal-unlock')
    // Ensure embedded wallet is loaded and unlocked
    if (!getWalletProvider()) {
      try {
        await import('./embedded-wallet.js')
        await window._walletReady
      } catch {}
    }
    if (!getWalletProvider()) {
      // Try to trigger unlock prompt
      try {
        await window.ensureAuthorized?.()
      } catch {}
    }
    if (!getWalletProvider()) { if (unlockStatus) unlockStatus.textContent = t('journal.noWallet'); return }

    try {
      // journal always requires explicit wallet unlock (password entry)
      // because it derives the encryption key from the signing process
      let rawAddr
      if (getWalletProvider()?.isPraxis && window.showUnlockPrompt) {
        rawAddr = await window.showUnlockPrompt()
        if (!rawAddr) { if (unlockBtn) unlockBtn.style.display = ''; return }
      } else {
        const authorizedAddr = await window.ensureAuthorized?.()
        rawAddr = authorizedAddr || window.getWalletAddress()
      }
      const addr = rawAddr?.toLowerCase()
      if (unlockBtn) unlockBtn.style.display = 'none'

      if (unlockStatus) unlockStatus.textContent = t('journal.authenticating')
      const authMsg = `admin:${location.hostname}:${Date.now()}`
      const authSig = await getWalletProvider().request({
        method: 'personal_sign',
        params: [authMsg, addr],
      })
      const authRes = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: addr, signature: authSig, message: authMsg }),
      })
      const authData = await authRes.json()
      if (authData.error) { if (unlockStatus) unlockStatus.textContent = authData.error; return }
      journalToken = authData.token
      sessionStorage.setItem('praxis:journal-token', journalToken)

      if (unlockStatus) unlockStatus.textContent = t('journal.derivingKey')
      // always use lowercase address for deterministic key (wallet-agnostic)
      const normalAddr = addr.toLowerCase()
      const keyMsg = `praxis:journal-key:v1:${normalAddr}`
      const keySig = await getWalletProvider().request({
        method: 'personal_sign',
        params: [keyMsg, normalAddr],
      })

      const sigBytes = new Uint8Array(keySig.slice(2).match(/.{2}/g).map(b => parseInt(b, 16)))
      const hashBuffer = await crypto.subtle.digest('SHA-256', sigBytes)
      const keyHex = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('')

      const keyRes = await fetch('/api/journal-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${journalToken}` },
        body: JSON.stringify({ key: keyHex }),
      })
      const keyData = await keyRes.json()
      if (keyData.error) { if (unlockStatus) unlockStatus.textContent = keyData.error; return }

      loadEntries()
    } catch (e) {
      if (unlockStatus) { unlockStatus.textContent = e.code === 4001 ? t('journal.cancelled') : `error: ${e.message}`; if (unlockBtn) unlockBtn.style.display = '' }
    }
  }

  let _showingArchived = false

  async function loadEntries() {
    let res = await fetch(`/api/journal${_showingArchived ? '?archived=1' : ''}`, {
      headers: { 'Authorization': `Bearer ${journalToken}` },
    })
    // re-auth if token expired (server restart, session TTL)
    if (res.status === 401 || res.status === 403) {
      const ok = await reauthJournal()
      if (ok) {
        res = await fetch(`/api/journal${_showingArchived ? '?archived=1' : ''}`, {
          headers: { 'Authorization': `Bearer ${journalToken}` },
        })
      }
    }
    const data = await res.json()
    const entries = (Array.isArray(data) ? data : data.items || [])
      .sort((a, b) => (b.modified ? new Date(b.modified).getTime() : 0) - (a.modified ? new Date(a.modified).getTime() : 0))

    let html = `
      <div style="margin-bottom:2em">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <button class="buy-btn" id="journal-new">${t('journal.newEntry')}</button>
            <span style="position:relative;display:inline-block;margin-left:0.5ch">
              <button class="buy-btn" id="journal-new-script">${t('journal.newScript')}</button>
              <div id="script-format-menu" style="display:none;position:absolute;top:100%;left:0;background:var(--bg);border:1px solid var(--border);z-index:10;min-width:12ch;margin-top:2px">
                <button class="script-format-opt" data-format="screenplay" style="display:block;width:100%;background:none;border:none;border-bottom:1px solid var(--border);color:var(--fg);font-family:inherit;font-size:0.85em;padding:0.5em 1ch;cursor:pointer;text-align:left">${t('journal.formatScreenplay')}</button>
                <button class="script-format-opt" data-format="teleplay" style="display:block;width:100%;background:none;border:none;border-bottom:1px solid var(--border);color:var(--fg);font-family:inherit;font-size:0.85em;padding:0.5em 1ch;cursor:pointer;text-align:left">${t('journal.formatTeleplay')}</button>
                <button class="script-format-opt" data-format="stageplay" style="display:block;width:100%;background:none;border:none;color:var(--fg);font-family:inherit;font-size:0.85em;padding:0.5em 1ch;cursor:pointer;text-align:left">${t('journal.formatStageplay')}</button>
              </div>
            </span>
          </div>
          <button id="journal-toggle-archived" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:0.85em">${_showingArchived ? t('journal.showActive') : t('journal.showArchived')}</button>
        </div>
        <div style="color:var(--dim);font-size:0.75em;margin-top:0.5em;opacity:0.7"><i class="ph ph-lock"></i> ${t('journal.private')}</div>
      </div>
    `

    if (entries.length === 0) {
      html += `<p style="color:var(--muted)">${_showingArchived ? t('journal.noArchived') : t('journal.noEntries')}</p>`
    } else {
      html += entries.map(e => `
        <div class="journal-entry" data-file="${escapeHtml(e.file)}">
          <div class="journal-entry-header">
            <span class="journal-entry-name">${escapeHtml(e.file)}</span>
            <span>
              ${_showingArchived ? `
                <button class="journal-unarchive-btn" data-file="${escapeHtml(e.file)}" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:0.85em">${t('journal.unarchive')}</button>
                <button class="journal-delete-btn" data-file="${escapeHtml(e.file)}" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:0.85em;margin-left:1ch">${t('journal.delete')}</button>
              ` : `
                <button class="journal-edit-btn" data-file="${escapeHtml(e.file)}" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:0.85em">${t('journal.edit')}</button>
                <button class="journal-archive-btn" data-file="${escapeHtml(e.file)}" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:0.85em;margin-left:1ch">${t('journal.archive')}</button>
              `}
            </span>
          </div>
          <div class="journal-entry-preview" style="color:var(--dim);font-size:0.85em">${e.modified ? new Date(e.modified).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : ''}</div>
        </div>
      `).join('')
    }

    contentEl.innerHTML = html

    // new entry (prose)
    document.getElementById('journal-new')?.addEventListener('click', () => showEditor())

    // new script entry — toggle format menu
    document.getElementById('journal-new-script')?.addEventListener('click', () => {
      const menu = document.getElementById('script-format-menu')
      if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none'
    })
    document.querySelectorAll('.script-format-opt').forEach(btn => {
      btn.addEventListener('click', () => {
        document.getElementById('script-format-menu').style.display = 'none'
        showScriptEditor(null, null, btn.dataset.format)
      })
    })

    // toggle archived view
    document.getElementById('journal-toggle-archived')?.addEventListener('click', () => {
      _showingArchived = !_showingArchived
      loadEntries()
    })

    // edit buttons — detect mode from content
    contentEl.querySelectorAll('.journal-edit-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const file = btn.dataset.file
        try {
          const res = await fetch(`/api/journal/${encodeURIComponent(file)}`, {
            headers: { 'Authorization': `Bearer ${journalToken}` },
          })
          const data = await res.json()
          if (data.content) {
            if (isStagePlayContent(data.content)) {
              showScriptEditor(file, extractStagePlayBody(data.content), 'stageplay')
            } else if (isFountainContent(data.content)) {
              showScriptEditor(file, extractFountainBody(data.content), 'screenplay')
            } else {
              showEditor(file, data.content)
            }
          } else if (data.error) {
            const el = contentEl.querySelector('.journal-entry-preview')
            if (el) el.textContent = data.error
          }
        } catch { showEditor(file, '') }
      })
    })

    // archive buttons
    contentEl.querySelectorAll('.journal-archive-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        await fetch(`/api/journal/${encodeURIComponent(btn.dataset.file)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${journalToken}` },
          body: JSON.stringify({ archived: true }),
        })
        loadEntries()
      })
    })

    // unarchive buttons
    contentEl.querySelectorAll('.journal-unarchive-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        await fetch(`/api/journal/${encodeURIComponent(btn.dataset.file)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${journalToken}` },
          body: JSON.stringify({ archived: false }),
        })
        loadEntries()
      })
    })

    // delete buttons
    contentEl.querySelectorAll('.journal-delete-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(t('journal.confirmDelete', { name: btn.dataset.file }))) return
        await fetch(`/api/journal/${encodeURIComponent(btn.dataset.file)}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${journalToken}` },
        })
        loadEntries()
      })
    })
  }

  // --- Prose editor (unchanged) ---

  function showEditor(existingFile, existingContent) {
    const today = new Date().toISOString().slice(0, 10)
    let currentFilename = existingFile || `${today}-`
    let _autosaveTimer = null
    let _saveInFlight = null
    let _lastSavedContent = existingContent || ''
    let _savedFile = existingFile

    contentEl.innerHTML = `
      <div style="max-width:680px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1em">
          <span style="color:var(--muted);font-size:0.85em;text-transform:uppercase;letter-spacing:0.1em">${existingFile ? t('journal.editEntry') : t('journal.newEntry')}</span>
          <button class="buy-btn" id="journal-back" style="font-size:0.8em;padding:0.2em 1ch">${t('journal.back')}</button>
        </div>
        <input type="text" id="journal-filename" placeholder="${today}-untitled" value="${currentFilename}" style="width:100%;background:transparent;border:1px solid var(--border);color:var(--fg);font-family:inherit;font-size:0.9em;padding:0.5em 1ch;margin-bottom:1em">
        <textarea id="journal-editor" style="width:100%;min-height:60vh;background:transparent;border:none;color:var(--fg);font-family:inherit;font-size:1em;line-height:1.8;padding:0;resize:none;outline:none" placeholder="${t('journal.writePlaceholder')}">${existingContent ? escapeHtml(existingContent) : ''}</textarea>
        <div style="display:flex;justify-content:space-between;align-items:center;padding-top:1em;border-top:1px solid var(--border)">
          <span id="journal-save-status" style="color:var(--dim);font-size:0.85em"></span>
        </div>
      </div>
    `

    document.getElementById('journal-back').addEventListener('click', async () => {
      if (_autosaveTimer) clearTimeout(_autosaveTimer)
      // ensure any pending save completes before showing entry list
      await autoSave()
      if (_saveInFlight) await _saveInFlight
      loadEntries()
    })

    document.getElementById('journal-publish')?.addEventListener('click', async () => {
      const content = document.getElementById('journal-editor')?.value?.trim()
      if (!content) return

      // custom confirmation modal
      const confirmed = await new Promise(resolve => {
        const overlay = document.createElement('div')
        overlay.className = 'praxis-modal-overlay'
        const dialog = document.createElement('div')
        dialog.className = 'praxis-modal-dialog'
        dialog.style.maxWidth = '400px'
        dialog.innerHTML = `
          <h3 style="color:var(--accent);margin-bottom:0.75em">${t('journal.publishToBlog')}</h3>
          <p style="color:var(--fg);font-size:0.9em;line-height:1.5;margin-bottom:1.5em">this will publish your journal entry as a public on-chain blog post. once published, it is permanent and visible to everyone.</p>
          <div style="display:flex;gap:1ch;justify-content:flex-end">
            <button id="pub-cancel" style="background:none;border:1px solid var(--border);color:var(--muted);font-family:inherit;font-size:0.85em;padding:0.4em 1.5ch;cursor:pointer">cancel</button>
            <button id="pub-confirm" style="background:none;border:1px solid var(--accent);color:var(--accent);font-family:inherit;font-size:0.85em;padding:0.4em 1.5ch;cursor:pointer">publish</button>
          </div>
        `
        overlay.appendChild(dialog)
        document.body.appendChild(overlay)
        overlay.addEventListener('click', e => { if (e.target === overlay) { overlay.remove(); resolve(false) } })
        dialog.querySelector('#pub-cancel').addEventListener('click', () => { overlay.remove(); resolve(false) })
        dialog.querySelector('#pub-confirm').addEventListener('click', async () => {
          // biometric gate if enabled
          if (getWalletProvider()?.isPraxis && localStorage.getItem('praxis-webauthn-cred')) {
            const ok = await window.verifyBiometric?.()
            if (!ok) { overlay.remove(); resolve(false); return }
          }
          overlay.remove()
          resolve(true)
        })
      })
      if (!confirmed) return

      const title = document.getElementById('journal-filename')?.value.trim().replace(/[^a-z0-9-]/g, '') || ''
      const params = new URLSearchParams()
      if (title) params.set('prefillTitle', title)
      if (content) params.set('prefillContent', content)
      window.location.href = '/write?' + params.toString()
    })

    const textarea = document.getElementById('journal-editor')
    const filenameInput = document.getElementById('journal-filename')

    textarea.addEventListener('input', () => {
      if (_autosaveTimer) clearTimeout(_autosaveTimer)
      const saveStatus = document.getElementById('journal-save-status')
      if (saveStatus) saveStatus.textContent = ''
      _autosaveTimer = setTimeout(() => { _saveInFlight = autoSave() }, 2000)
    })

    filenameInput.addEventListener('input', () => {
      if (_autosaveTimer) clearTimeout(_autosaveTimer)
      _autosaveTimer = setTimeout(() => { _saveInFlight = autoSave() }, 2000)
    })

    async function autoSave() {
      const saveStatus = document.getElementById('journal-save-status')
      const content = document.getElementById('journal-editor')?.value
      if (!content?.trim()) return

      const rawFilename = document.getElementById('journal-filename')?.value.trim()
      const newFilename = rawFilename?.replace(/[^a-z0-9-]/g, '')
      if (!newFilename) {
        if (saveStatus) saveStatus.textContent = 'enter a filename to save'
        return
      }

      if (content === _lastSavedContent && newFilename === (_savedFile || currentFilename)) return

      if (saveStatus) saveStatus.textContent = t('journal.saving')

      try {
        const renamed = _savedFile && newFilename !== _savedFile

        async function doSave() {
          if (renamed) {
            const r1 = await fetch('/api/journal', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${journalToken}` },
              body: JSON.stringify({ filename: newFilename, content }),
            })
            if (r1.status === 401 || r1.status === 403) return 403
            await fetch(`/api/journal/${encodeURIComponent(_savedFile)}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${journalToken}` },
              body: JSON.stringify({ archived: true }),
            })
          } else {
            const url = _savedFile ? `/api/journal/${encodeURIComponent(_savedFile)}` : '/api/journal'
            const method = _savedFile ? 'PUT' : 'POST'
            const r = await fetch(url, {
              method,
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${journalToken}` },
              body: JSON.stringify({ filename: newFilename, content }),
            })
            if (r.status === 401 || r.status === 403) return 403
            if (!r.ok) { console.error('journal save error:', r.status); return r.status }
          }
          return 200
        }

        let result = await doSave()
        if (result !== 200 && result !== 403) {
          if (saveStatus) saveStatus.textContent = `save failed (${result})`
          return
        }
        if (result === 403) {
          // session expired (server restart, TTL) — re-authenticate silently
          console.log('journal: session expired, re-authenticating...')
          if (saveStatus) saveStatus.textContent = t('journal.reconnecting') || 'reconnecting...'
          const ok = await reauthJournal()
          console.log('journal: re-auth result:', ok)
          if (ok) result = await doSave()
          else if (saveStatus) saveStatus.textContent = 're-auth failed — sign in again'
        }

        if (result === 200) {
          _lastSavedContent = content
          _savedFile = newFilename
          if (saveStatus) saveStatus.textContent = t('journal.saved')
        } else {
          if (saveStatus) saveStatus.textContent = t('journal.saveFailed')
        }
      } catch {
        if (saveStatus) saveStatus.textContent = t('journal.saveFailed')
      }
    }
  }

  // --- Script editor (Fountain-based screenplay / stage play) ---

  function showScriptEditor(existingFile, existingContent, format) {
    format = format || 'screenplay'
    const fmt = getFormatFunctions(format)
    const today = new Date().toISOString().slice(0, 10)
    let currentFilename = existingFile || `${today}-script`
    let _autosaveTimer = null
    let _lastSavedContent = existingContent || ''
    let _savedFile = existingFile
    let _currentLineType = 'scene'

    contentEl.innerHTML = `
      <div style="max-width:680px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1em">
          <span style="color:var(--muted);font-size:0.85em;text-transform:uppercase;letter-spacing:0.1em">${existingFile ? t('journal.editEntry') : SCRIPT_FORMATS[format].label}</span>
          <button class="buy-btn" id="journal-back" style="font-size:0.8em;padding:0.2em 1ch">${t('journal.back')}</button>
        </div>
        <input type="text" id="journal-filename" placeholder="${today}-untitled" value="${currentFilename}" style="width:100%;background:transparent;border:1px solid var(--border);color:var(--fg);font-family:inherit;font-size:0.9em;padding:0.5em 1ch;margin-bottom:0">
        <div class="script-toolbar">
          <span class="script-type-indicator" id="script-type-label">${t('journal.script' + fmt.types[0].charAt(0).toUpperCase() + fmt.types[0].slice(1))}</span>
          ${fmt.types.map(type => `<button data-type="${type}" ${type === fmt.types[0] ? 'class="active"' : ''}>${t('journal.script' + type.charAt(0).toUpperCase() + type.slice(1))}</button>`).join('\n          ')}
        </div>
        <div class="script-editor" id="script-editor" contenteditable="true" data-placeholder="${format === 'stageplay' ? t('journal.stageplayPlaceholder') : t('journal.scriptPlaceholder')}"></div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding-top:1em;border-top:1px solid var(--border)">
          <span id="journal-save-status" style="color:var(--dim);font-size:0.85em"></span>
          <div style="display:flex;align-items:center;gap:1ch">
            <span id="script-page-count" style="color:var(--dim);font-size:0.85em"></span>
            <button class="buy-btn" id="script-export-pdf" style="font-size:0.8em;padding:0.2em 1ch">${t('journal.exportPdf')}</button>
          </div>
        </div>
      </div>
    `

    const editor = document.getElementById('script-editor')
    const filenameInput = document.getElementById('journal-filename')
    const typeLabel = document.getElementById('script-type-label')
    const pageCount = document.getElementById('script-page-count')

    // populate editor from existing content
    const startType = fmt.types.includes('scene') ? 'scene' : fmt.types[0]
    if (existingContent) {
      renderContentInEditor(editor, existingContent, fmt)
    } else {
      // start with one empty line of the first meaningful type
      const line = document.createElement('div')
      line.className = `script-line script-${startType}`
      line.dataset.type = startType
      line.dataset.manual = '1'
      line.innerHTML = '<br>'
      editor.appendChild(line)
    }

    updatePageCount()

    document.getElementById('journal-back').addEventListener('click', () => {
      if (_autosaveTimer) clearTimeout(_autosaveTimer)
      loadEntries()
    })

    // publish script to blog — renders as formatted screenplay/stage play
    document.getElementById('journal-publish')?.addEventListener('click', () => {
      const plainText = fountainToPlain(editor)
      if (!plainText?.trim()) return
      if (!confirm(t('journal.publishConfirm'))) return
      const title = document.getElementById('journal-filename')?.value.trim().replace(/[^a-z0-9-]/g, '') || ''
      const htmlBody = fmt.toHtml(plainText)
      const marker = format === 'stageplay' ? '<!-- stageplay -->' : '<!-- screenplay -->'
      const content = `${marker}\n${htmlBody}`
      const params = new URLSearchParams()
      if (title) params.set('prefillTitle', title)
      if (content) params.set('prefillContent', content)
      window.location.href = '/write?' + params.toString()
    })

    // export PDF via print
    document.getElementById('script-export-pdf').addEventListener('click', () => {
      const plainText = fountainToPlain(editor)
      if (!plainText?.trim()) return
      const title = document.getElementById('journal-filename')?.value.trim() || 'untitled'
      const htmlBody = fmt.toHtml(plainText)
      const printWindow = window.open('', '_blank')
      printWindow.document.write(scriptPrintHtml(title, htmlBody, format))
      printWindow.document.close()
      printWindow.focus()
      printWindow.print()
    })

    // toolbar type buttons
    document.querySelectorAll('.script-toolbar button[data-type]').forEach(btn => {
      btn.addEventListener('click', () => {
        const type = btn.dataset.type
        setCurrentLineType(type)
        editor.focus()
      })
    })

    // key handling
    editor.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault()
        const line = getCurrentLine()
        if (!line) return
        const current = line.dataset.type || 'action'
        const next = e.shiftKey ? fmt.cyclePrev(current) : fmt.cycle(current)
        applyTypeToLine(line, next)
        line.dataset.manual = '1' // lock type — auto-detect won't override
        updateTypeIndicator(next)
        updateToolbarActive(next)
        // restore cursor position in the line
        const sel = window.getSelection()
        if (!sel.rangeCount || !line.contains(sel.anchorNode)) {
          const range = document.createRange()
          range.selectNodeContents(line)
          range.collapse(false) // cursor at end
          sel.removeAllRanges()
          sel.addRange(range)
        }
        scheduleAutosave()
      }

      if (e.key === 'Enter') {
        e.preventDefault()
        const line = getCurrentLine()
        const currentType = line?.dataset.type || 'action'
        const isEmpty = !line?.textContent?.trim()

        // empty line + enter = reset to action
        const nextType = isEmpty ? 'action' : fmt.nextAfterEnter(currentType)

        const newLine = document.createElement('div')
        newLine.className = `script-line script-${nextType}`
        newLine.dataset.type = nextType
        newLine.dataset.manual = '1' // lock inferred type — auto-detect won't override
        newLine.innerHTML = '<br>'

        if (line && line.nextSibling) {
          editor.insertBefore(newLine, line.nextSibling)
        } else {
          editor.appendChild(newLine)
        }

        // move cursor to new line
        const sel = window.getSelection()
        const range = document.createRange()
        range.setStart(newLine, 0)
        range.collapse(true)
        sel.removeAllRanges()
        sel.addRange(range)

        updateTypeIndicator(nextType)
        updateToolbarActive(nextType)
        scheduleAutosave()
        updatePageCount()
      }
    })

    // auto-detect type on input — only on lines without data-manual flag
    // lines created by Enter get auto-detection; Tab/toolbar-set lines keep their type
    editor.addEventListener('input', () => {
      const line = getCurrentLine()
      if (!line) return

      // skip auto-detection on manually-typed lines (Tab or toolbar set the type)
      if (line.dataset.manual) {
        updateTypeIndicator(line.dataset.type)
        updateToolbarActive(line.dataset.type)
        scheduleAutosave()
        updatePageCount()
        return
      }

      const text = line.textContent || ''
      const prevLine = line.previousElementSibling
      const prevType = prevLine?.dataset.type || 'action'
      const detected = fmt.detect(text, prevType)

      if (detected !== (line.dataset.type || 'action')) {
        applyTypeToLine(line, detected)
      }

      updateTypeIndicator(line.dataset.type)
      updateToolbarActive(line.dataset.type)
      scheduleAutosave()
      updatePageCount()
    })

    // track cursor position for type indicator
    editor.addEventListener('click', () => {
      const line = getCurrentLine()
      if (line) {
        updateTypeIndicator(line.dataset.type)
        updateToolbarActive(line.dataset.type)
      }
    })

    editor.addEventListener('keyup', (e) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        const line = getCurrentLine()
        if (line) {
          updateTypeIndicator(line.dataset.type)
          updateToolbarActive(line.dataset.type)
        }
      }
    })

    filenameInput.addEventListener('input', () => scheduleAutosave())

    function getCurrentLine() {
      const sel = window.getSelection()
      if (!sel.rangeCount) return null
      let node = sel.anchorNode
      while (node && node !== editor) {
        if (node.nodeType === 1 && node.classList?.contains('script-line')) return node
        node = node.parentNode
      }
      // fallback: last child
      return editor.lastElementChild
    }

    function setCurrentLineType(type) {
      const line = getCurrentLine()
      if (line) {
        applyTypeToLine(line, type)
        line.dataset.manual = '1' // lock type — auto-detect won't override
        updateTypeIndicator(type)
        updateToolbarActive(type)
        scheduleAutosave()
      }
    }

    function applyTypeToLine(line, type) {
      // remove old type classes — clear both screenplay and stage play types
      for (const t of [...ELEM_TYPES, ...STAGE_ELEM_TYPES]) line.classList.remove(`script-${t}`)
      line.classList.add(`script-${type}`)
      line.dataset.type = type
    }

    function updateTypeIndicator(type) {
      _currentLineType = type
      const key = `journal.script${type.charAt(0).toUpperCase() + type.slice(1)}`
      if (typeLabel) typeLabel.textContent = t(key)
    }

    function updateToolbarActive(type) {
      document.querySelectorAll('.script-toolbar button[data-type]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.type === type)
      })
    }

    function updatePageCount() {
      // rough estimate: ~56 lines per page (industry standard)
      const lineCount = editor.children.length
      const pages = Math.max(1, Math.ceil(lineCount / 56))
      if (pageCount) pageCount.textContent = `~${pages} ${pages === 1 ? t('journal.scriptPage') : t('journal.scriptPages')}`
    }

    function renderContentInEditor(el, text, fmtFns) {
      el.innerHTML = ''
      const parsed = fmtFns.parse(text)
      for (const item of parsed) {
        const div = document.createElement('div')
        div.className = `script-line script-${item.type}`
        div.dataset.type = item.type
        div.textContent = item.text || ''
        if (!div.textContent) div.innerHTML = '<br>'
        el.appendChild(div)
      }
    }

    function getContent() {
      return fountainToPlain(editor)
    }

    function scheduleAutosave() {
      if (_autosaveTimer) clearTimeout(_autosaveTimer)
      const saveStatus = document.getElementById('journal-save-status')
      if (saveStatus) saveStatus.textContent = ''
      _autosaveTimer = setTimeout(() => autoSave(), 2000)
    }

    async function autoSave() {
      const saveStatus = document.getElementById('journal-save-status')
      const plainText = getContent()
      if (!plainText?.trim()) return

      // prefix with format marker for mode detection on reload
      const content = fmt.wrap(plainText)

      const newFilename = document.getElementById('journal-filename')?.value.trim().replace(/[^a-z0-9-]/g, '')
      if (!newFilename) return

      if (plainText === _lastSavedContent && newFilename === (_savedFile || currentFilename)) return

      if (saveStatus) saveStatus.textContent = t('journal.saving')

      try {
        const renamed = _savedFile && newFilename !== _savedFile

        async function doSave() {
          if (renamed) {
            const r1 = await fetch('/api/journal', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${journalToken}` },
              body: JSON.stringify({ filename: newFilename, content }),
            })
            if (r1.status === 401 || r1.status === 403) return 403
            await fetch(`/api/journal/${encodeURIComponent(_savedFile)}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${journalToken}` },
              body: JSON.stringify({ archived: true }),
            })
          } else {
            const url = _savedFile ? `/api/journal/${encodeURIComponent(_savedFile)}` : '/api/journal'
            const method = _savedFile ? 'PUT' : 'POST'
            const r = await fetch(url, {
              method,
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${journalToken}` },
              body: JSON.stringify({ filename: newFilename, content }),
            })
            if (r.status === 401 || r.status === 403) return 403
            if (!r.ok) { console.error('journal save error:', r.status); return r.status }
          }
          return 200
        }

        let result = await doSave()
        if (result !== 200 && result !== 403) {
          if (saveStatus) saveStatus.textContent = `save failed (${result})`
          return
        }
        if (result === 403) {
          if (saveStatus) saveStatus.textContent = t('journal.reconnecting') || 'reconnecting...'
          const ok = await reauthJournal()
          if (ok) result = await doSave()
        }

        if (result === 200) {
          _lastSavedContent = plainText
          _savedFile = newFilename
          if (saveStatus) saveStatus.textContent = t('journal.saved')
        } else {
          if (saveStatus) saveStatus.textContent = t('journal.saveFailed')
        }
      } catch {
        if (saveStatus) saveStatus.textContent = t('journal.saveFailed')
      }
    }
  }
}
