// /write page — full-page compose editor for on-chain blog posts
// Replaces the old compose modal with a dedicated route

import { t, whenReady as i18nReady } from './i18n.js'
import { escapeHtml, getWalletProvider, registerPage, getPublicClient, ipfsUrl, renderMarkdown, formatTxError, getAuthToken } from './utils.js'
import { query } from './ponder.js'
import { F } from './fragments.js'
import { createWalletClient, custom, optimism } from './vendor.js'
import { BLOG_ABI } from './contracts.js'

const PUBLISH_REDIRECT_DELAY = 5000
const VIDEO_SIZE_LIMIT = 50 * 1024 * 1024
const FILE_SIZE_LIMIT = 10 * 1024 * 1024
const UPLOAD_POLL_INTERVAL = 2000
const UPLOAD_POLL_MAX = 300

let composeRef = { type: 0, id: 0 }
let _amendPostId = null

// --- Reference picker ---

let refSearchTimer = null

function toggleRefPicker() {
  const picker = document.getElementById('compose-ref-picker')
  if (!picker) return
  if (picker.style.display !== 'none') { picker.style.display = 'none'; return }

  picker.style.display = 'block'
  picker.innerHTML = `
    <div style="border:1px solid var(--border);padding:0.75em;border-radius:6px">
      <input type="text" id="ref-search" placeholder="search people, media, library, projects..." style="width:100%;background:transparent;border:1px solid var(--border);color:var(--fg);font-family:inherit;font-size:0.85em;padding:0.5em 0.75ch;margin-bottom:0.5em;border-radius:4px" autocomplete="off">
      <div id="ref-results" style="max-height:200px;overflow-y:auto"></div>
      <p style="color:var(--dim);font-size:0.75em;margin-top:0.5em">${t('compose.searchHelp')}</p>
    </div>
  `

  const searchInput = document.getElementById('ref-search')
  searchInput.focus()
  searchRefs('')

  searchInput.addEventListener('input', () => {
    clearTimeout(refSearchTimer)
    refSearchTimer = setTimeout(() => searchRefs(searchInput.value.trim()), 250)
  })
}

async function searchRefs(q) {
  const resultsEl = document.getElementById('ref-results')
  if (!resultsEl) return

  try {
    // Server-side search: use indexed queries with title_contains for scalability
    // Sanitize query to prevent GraphQL injection (strip quotes, backslashes, newlines)
    const safeQ = q.replace(/["\\{}\n\r]/g, '').slice(0, 100)
    const queries = []
    if (safeQ) {
      queries.push(query(`{ libraryItems(limit: 10, where: { title_contains: "${safeQ}" }, orderBy: "timestamp", orderDirection: "desc") { items { ${F.libraryItem} } } }`))
      queries.push(query(`{ projects(limit: 10, where: { title_contains: "${safeQ}" }, orderBy: "createdAt", orderDirection: "desc") { items { ${F.projectSummary} } } }`))
      queries.push(query(`{ mediaListings(limit: 10, where: { title_contains: "${safeQ}" }, orderBy: "id", orderDirection: "desc") { items { id title artist ipfsCid metadataCid contentType } } }`))
    } else {
      queries.push(query(`{ libraryItems(limit: 10, orderBy: "timestamp", orderDirection: "desc") { items { ${F.libraryItem} } } }`))
      queries.push(query(`{ projects(limit: 10, orderBy: "createdAt", orderDirection: "desc") { items { ${F.projectSummary} } } }`))
      queries.push(query(`{ mediaListings(limit: 10, orderBy: "id", orderDirection: "desc") { items { id title artist ipfsCid metadataCid contentType } } }`))
    }
    const [libData, projData, mediaData] = await Promise.all(queries)

    // Search people via server endpoint (already indexed)
    let people = []
    if (q && q.length >= 2) {
      try {
        const searchRes = await fetch(`/api/network/search?q=${encodeURIComponent(q)}&limit=10`)
        if (searchRes.ok) {
          const searchData = await searchRes.json()
          people = (searchData.artists || []).concat(searchData.supporters || [])
        }
      } catch {}
    }

    const libItems = (libData.libraryItems?.items || []).slice(0, 8)
    const projItems = (projData.projects?.items || []).slice(0, 8)
    const mediaItems = (mediaData.mediaListings?.items || []).slice(0, 8)

    const hasResults = libItems.length > 0 || projItems.length > 0 || mediaItems.length > 0 || people.length > 0
    if (!hasResults) {
      resultsEl.innerHTML = `<p style="color:var(--muted);font-size:0.85em;padding:0.5em">${q ? t('compose.noMatches') : t('compose.noItems')}</p>`
      return
    }

    let html = ''

    // People results
    if (people.length > 0) {
      html += `<p style="color:var(--dim);font-size:0.7em;text-transform:uppercase;letter-spacing:0.05em;padding:0.3em 0.5em">people</p>`
      for (const p of people) {
        const domain = p.domain || p.name || `${p.handle || ''}.ourpraxis.network`
        const handle = p.handle || domain.split('.')[0]
        html += `<div class="ref-option ref-person" data-domain="${escapeHtml(domain)}" data-handle="${escapeHtml(handle)}">
          <span style="color:var(--accent)">@${escapeHtml(handle)}</span>
          <span style="color:var(--dim)"> — ${escapeHtml(domain)}</span>
        </div>`
      }
    }

    // Media results
    if (mediaItems.length > 0) {
      html += `<p style="color:var(--dim);font-size:0.7em;text-transform:uppercase;letter-spacing:0.05em;padding:0.3em 0.5em${people.length ? ';margin-top:0.5em' : ''}">media</p>`
      for (const m of mediaItems) {
        const artCid = m.metadataCid || ''
        const artUrl = artCid ? `/api/ipfs-proxy/${artCid}` : ''
        const srcUrl = m.ipfsCid ? `/api/ipfs-proxy/${m.ipfsCid}` : ''
        html += `<div class="ref-option ref-media" data-ref-type="3" data-ref-id="${m.id}" data-ref-title="${escapeHtml(m.title || '')}" data-ref-art="${escapeHtml(artUrl)}" data-ref-src="${escapeHtml(srcUrl)}">
          <span style="color:var(--accent)">${escapeHtml(m.title || 'untitled')}</span>
          <span style="color:var(--dim);font-size:0.8em"> — media #${m.id}</span>
        </div>`
      }
    }

    // Library results
    if (libItems.length > 0) {
      html += `<p style="color:var(--dim);font-size:0.7em;text-transform:uppercase;letter-spacing:0.05em;padding:0.3em 0.5em;margin-top:0.5em">${t('compose.refLibrary')}</p>`
      for (const item of libItems) {
        html += `<div class="ref-option" data-ref-type="4" data-ref-id="${item.id}">
          <span style="color:var(--accent)">${escapeHtml(item.title)}</span>
          ${item.author ? `<span style="color:var(--dim)"> — ${escapeHtml(item.author)}</span>` : ''}
        </div>`
      }
    }

    // Project results
    if (projItems.length > 0) {
      html += `<p style="color:var(--dim);font-size:0.7em;text-transform:uppercase;letter-spacing:0.05em;padding:0.3em 0.5em;margin-top:0.5em">${t('compose.refProjects')}</p>`
      for (const proj of projItems) {
        html += `<div class="ref-option" data-ref-type="1" data-ref-id="${proj.id}">
          <span style="color:var(--accent)">${escapeHtml(proj.title)}</span>
        </div>`
      }
    }

    resultsEl.innerHTML = html

    // Wire click handlers
    resultsEl.querySelectorAll('.ref-option').forEach(opt => {
      opt.style.cssText = 'padding:0.5em 0.75em;cursor:pointer;font-size:0.85em;border-bottom:1px solid var(--border)'
      opt.addEventListener('click', () => {
        if (opt.classList.contains('ref-person')) {
          // @-mention: insert markdown link into content
          const domain = opt.dataset.domain
          const handle = opt.dataset.handle
          const pos = contentInput.selectionStart || contentInput.value.length
          const before = contentInput.value.substring(0, pos)
          const after = contentInput.value.substring(pos)
          contentInput.value = before + `[@${handle}](https://${domain})` + after
          contentInput.selectionStart = contentInput.selectionEnd = pos + `[@${handle}](https://${domain})`.length
          document.getElementById('compose-ref-picker').style.display = 'none'
          showEditor()
          contentInput.focus()
        } else if (opt.classList.contains('ref-media')) {
          // Media reference: set on-chain ref AND show rich card
          composeRef.type = parseInt(opt.dataset.refType)
          composeRef.id = parseInt(opt.dataset.refId)
          const refTitle = opt.dataset.refTitle || ''
          const refArt = opt.dataset.refArt || ''
          const refSrc = opt.dataset.refSrc || ''
          document.getElementById('compose-ref-label').textContent = `ref: ${refTitle}`
          document.getElementById('compose-ref-picker').style.display = 'none'
          // Render rich media card
          const slot = document.getElementById('compose-ref-card-slot')
          if (slot) {
            const artSrc = refArt ? `/api/img?url=${encodeURIComponent(refArt)}&w=120` : ''
            const isAudio = refSrc && !refSrc.includes('video')
            slot.innerHTML = `
              <div class="feed-collected-card" style="margin:0.75em 0">
                <div class="feed-collected-art-wrap" style="width:60px;height:60px;flex-shrink:0">
                  ${artSrc ? `<img src="${escapeHtml(artSrc)}" alt="" style="width:100%;height:100%;object-fit:cover">` : ''}
                  ${isAudio && refSrc ? `<button class="track-play-btn feed-collected-play-overlay" data-track-src="${escapeHtml(refSrc)}" data-track-title="${escapeHtml(refTitle)}"><i class="ph ph-play" style="font-size:0.8em"></i></button>` : ''}
                </div>
                <div class="feed-collected-body" style="padding:0.4em 0.75ch">
                  <div style="font-size:0.85em;font-weight:600;color:var(--fg)">${escapeHtml(refTitle)}</div>
                </div>
                <button onclick="this.closest('.feed-collected-card').remove();document.getElementById('compose-ref-label').textContent=''" style="background:none;border:none;color:var(--dim);cursor:pointer;padding:0.3em;font-size:0.9em;flex-shrink:0"><i class="ph ph-x"></i></button>
              </div>`
          }
        } else {
          // Library/project reference: set on-chain ref
          composeRef.type = parseInt(opt.dataset.refType)
          composeRef.id = parseInt(opt.dataset.refId)
          const title = opt.querySelector('span')?.textContent || ''
          document.getElementById('compose-ref-label').textContent = `ref: ${title}`
          document.getElementById('compose-ref-picker').style.display = 'none'
        }
      })
      opt.addEventListener('mouseenter', () => opt.style.background = 'var(--surface)')
      opt.addEventListener('mouseleave', () => opt.style.background = '')
    })
  } catch (e) {
    console.warn('searchRefs error:', e)
    resultsEl.innerHTML = `<p style="color:var(--muted);font-size:0.85em">${t('compose.couldNotSearch')}</p>`
  }
}

// --- Submit post on-chain ---

async function submitPost() {
  const blogAddr = document.body.dataset.blog
  if (!blogAddr) {
    const statusEl = document.getElementById('compose-status')
    if (statusEl) statusEl.textContent = 'no blog registry configured'
    return
  }

  const titleInput = document.getElementById('compose-title')
  const bodyInput = document.getElementById('compose-content')
  const statusEl = document.getElementById('compose-status')
  const title = titleInput.value.trim()
  const content = bodyInput.value.trim()

  if (!title) { statusEl.textContent = t('compose.enterTitle'); return }

  const addr = window.getWalletAddress?.()
  if (!addr) {
    await window.connectWallet?.()
    if (!window.getWalletAddress?.()) { statusEl.textContent = t('compose.connectWallet'); return }
  }

  try {
    await getWalletProvider().request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0xa' }],
    })
  } catch (e) {
    if (e.code === 4902) { statusEl.textContent = t('compose.addOptimism'); return }
  }

  statusEl.textContent = t('compose.confirming')

  try {
    const publicClient = await getPublicClient()

    const isAmend = !!_amendPostId
    const useRef = isAmend || (composeRef.type > 0 && composeRef.id > 0)
    let fnArgs
    if (isAmend) {
      fnArgs = [title, content, 5, BigInt(_amendPostId)]
    } else if (useRef) {
      fnArgs = [title, content, composeRef.type, BigInt(composeRef.id)]
    } else {
      fnArgs = [title, content]
    }
    await window.ensureOptimism?.()
    const currentAccount = await window.ensureAuthorized?.() || window.getWalletAddress()
    const walletClient = createWalletClient({
      chain: optimism,
      transport: custom(getWalletProvider()),
    })
    const hash = await walletClient.writeContract({
      address: blogAddr,
      abi: BLOG_ABI,
      functionName: useRef ? 'postWithRef' : 'post',
      args: fnArgs,
      account: currentAccount,
    })

    statusEl.textContent = `tx: ${hash.slice(0, 14)}...`
    await publicClient.waitForTransactionReceipt({ hash })

    titleInput.value = ''
    bodyInput.value = ''
    _amendPostId = null
    try { localStorage.removeItem('praxis-blog-draft') } catch {}
    statusEl.textContent = t('compose.published')

    // TODO: mention notifications handled server-side in Ponder indexer
    // (scans post content for [@handle](url) patterns on Posted event)

    // Clear feed cache so reload fetches fresh data from Ponder
    try { sessionStorage.removeItem('praxis-feed-' + document.body.dataset.owner?.toLowerCase()) } catch {}
    try { for (const k of Object.keys(sessionStorage)) { if (k.startsWith('praxis-feed')) sessionStorage.removeItem(k) } } catch {}

    // Navigate home after short delay for Ponder indexing
    setTimeout(() => { window.location.href = '/' }, PUBLISH_REDIRECT_DELAY)
  } catch (e) {
    statusEl.textContent = formatTxError(e)
  }
}

// --- Upload helpers ---

function _composeFileCategory(file) {
  if (!file || !file.type) return 'other'
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('video/')) return 'video'
  if (file.type.startsWith('audio/')) return 'audio'
  if (file.type === 'application/pdf') return 'pdf'
  return 'other'
}

function _composeSizeLimit(category) {
  if (category === 'video' || category === 'audio') return VIDEO_SIZE_LIMIT
  return FILE_SIZE_LIMIT
}

function _composeMarkdown(category, filename, url) {
  if (category === 'image') return `![${filename}](${url})`
  if (category === 'video') return `[video: ${filename}](${url})`
  if (category === 'audio') return `[audio: ${filename}](${url})`
  return `[${filename}](${url})`
}

function _composeInsertText(textarea, text) {
  const pos = textarea.selectionStart || textarea.value.length
  const before = textarea.value.substring(0, pos)
  const after = textarea.value.substring(pos)
  const nl = before.endsWith('\n') || !before ? '' : '\n'
  textarea.value = before + nl + text + '\n' + after
  textarea.selectionStart = textarea.selectionEnd = pos + nl.length + text.length + 1
}

async function _composePollJob(jobId, statusEl, onStatus) {
  for (let i = 0; i < UPLOAD_POLL_MAX; i++) {
    await new Promise(r => setTimeout(r, UPLOAD_POLL_INTERVAL))
    try {
      const res = await fetch(`/api/ipfs/status/${jobId}`)
      const data = await res.json()
      if (data.status === 'done' && data.cid) return data.cid
      if (data.status === 'error') throw new Error(data.error || 'upload failed')
      const msg = data.status === 'queued' ? 'queued — waiting...' : 'pinning to IPFS...'
      statusEl.textContent = msg
      if (onStatus) onStatus(msg)
    } catch (e) { throw e }
  }
  throw new Error('upload timed out')
}

// --- Page init ---

function initWrite() {
  const page = document.getElementById('write-page')
  if (!page) return

  const params = new URLSearchParams(window.location.search)
  const amendId = params.get('amend')
  const refMediaId = params.get('ref')
  const refTitle = params.get('refTitle') || ''
  const refArtist = params.get('refArtist') || ''
  const refArt = params.get('refArt') || ''
  const refSrc = params.get('refSrc') || ''
  const refType = params.get('refType') || ''
  const prefillTitle = params.get('prefillTitle') || ''
  const prefillContent = params.get('prefillContent') || ''

  composeRef = { type: 0, id: 0 }
  _amendPostId = amendId || null

  // Set header label
  const headerLabel = document.getElementById('write-header-label')
  if (headerLabel) {
    headerLabel.textContent = _amendPostId
      ? `${t('compose.amending')} #${_amendPostId}`
      : t('compose.write')
  }

  // Set publish button label
  const publishBtn = document.getElementById('compose-post')
  if (publishBtn) {
    publishBtn.textContent = _amendPostId ? t('compose.saveEdit') : t('compose.publish')
  }

  const titleInput = document.getElementById('compose-title')
  const contentInput = document.getElementById('compose-content')
  const statusEl = document.getElementById('compose-status')

  // Media reference from URL params
  if (refMediaId) {
    composeRef = { type: 3, id: parseInt(refMediaId) }
    const refLabel = document.getElementById('compose-ref-label')
    if (refLabel) refLabel.textContent = `ref: ${refTitle}`

    // Insert rich reference card
    const cardSlot = document.getElementById('compose-ref-card-slot')
    if (cardSlot) {
      const artSrc = refArt ? `/api/img?url=${encodeURIComponent(refArt)}&w=120` : ''
      const isAudio = refType === 'music' || refType === 'audio' || (!refType && refSrc)
      const playSrc = isAudio ? (refSrc || '') : ''
      const typeIcons = { video: 'ph-video-camera', film: 'ph-film-strip', writing: 'ph-article', gallery: 'ph-image' }
      const fallbackIcon = refType && typeIcons[refType] ? `<div style="width:60px;height:60px;display:flex;align-items:center;justify-content:center;background:var(--surface);flex-shrink:0"><i class="ph ${typeIcons[refType]}" style="font-size:1.5em;color:var(--dim)"></i></div>` : ''
      cardSlot.innerHTML = `
        <div class="compose-ref-card">
          <div class="feed-collected-card" style="margin:0.75em 0;pointer-events:auto">
            <div class="feed-collected-art-wrap" style="width:60px;height:60px;flex-shrink:0">
              ${artSrc ? `<img src="${escapeHtml(artSrc)}" alt="" style="width:100%;height:100%;object-fit:cover">` : fallbackIcon}
              ${playSrc ? `<button class="track-play-btn feed-collected-play-overlay" data-track-src="${escapeHtml(playSrc)}" data-track-title="${escapeHtml(refTitle)}" data-track-artist="${escapeHtml(refArtist)}"><i class="ph ph-play" style="font-size:0.8em"></i></button>` : ''}
            </div>
            <div class="feed-collected-body" style="padding:0.4em 0.75ch">
              <div style="font-size:0.85em;font-weight:600;color:var(--fg)">${escapeHtml(refTitle)}</div>
              ${refArtist ? `<div style="font-size:0.75em;color:var(--muted)">${escapeHtml(refArtist)}</div>` : ''}
            </div>
            <button class="compose-ref-card-remove" style="background:none;border:none;color:var(--dim);cursor:pointer;padding:0.3em;font-size:0.9em;flex-shrink:0" title="remove reference"><i class="ph ph-x"></i></button>
          </div>
        </div>
      `
      cardSlot.querySelector('.compose-ref-card-remove')?.addEventListener('click', () => {
        cardSlot.innerHTML = ''
        composeRef = { type: 0, id: 0 }
        const rl = document.getElementById('compose-ref-label')
        if (rl) rl.textContent = ''
      })
    }
  }

  // Restore draft if no prefill and not amending
  let restoredTitle = prefillTitle
  let restoredContent = prefillContent
  if (!restoredTitle && !restoredContent && !_amendPostId) {
    try {
      const draft = JSON.parse(localStorage.getItem('praxis-blog-draft') || 'null')
      if (draft && (draft.title || draft.body)) {
        restoredTitle = draft.title || ''
        restoredContent = draft.body || ''
      }
    } catch {}
  }

  if (restoredTitle && titleInput) titleInput.value = restoredTitle
  if (restoredContent && contentInput) contentInput.value = restoredContent

  // Close button — navigate back
  document.getElementById('compose-close')?.addEventListener('click', () => {
    saveDraft()
    window.history.length > 1 ? window.history.back() : (window.location.href = '/')
  })

  // Publish button
  publishBtn?.addEventListener('click', () => submitPost())

  // Reference picker
  document.getElementById('compose-ref')?.addEventListener('click', toggleRefPicker)

  // --- Image upload ---
  document.getElementById('compose-image')?.addEventListener('click', async () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.onchange = async () => {
      const file = input.files[0]
      if (!file) return
      statusEl.textContent = t('compose.uploading')
      try {
        const token = await getAuthToken()
        if (!token) { statusEl.textContent = t('compose.walletRequired'); return }
        const buffer = await file.arrayBuffer()
        const res = await fetch(`/api/ipfs?name=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Length': String(buffer.byteLength) },
          body: buffer,
        })
        if (!res.ok) { statusEl.textContent = `upload failed: ${res.status}`; return }
        const data = await res.json()
        let cid = data.cid
        if (!cid && data.jobId) {
          cid = await _composePollJob(data.jobId, statusEl, (msg) => { statusEl.textContent = msg })
        }
        if (cid) {
          const url = ipfsUrl(cid)
          const pos = contentInput.selectionStart || contentInput.value.length
          const before = contentInput.value.substring(0, pos)
          const after = contentInput.value.substring(pos)
          contentInput.value = before + (before.endsWith('\n') || !before ? '' : '\n') + `![${file.name}](${url})` + '\n' + after
          statusEl.textContent = ''
        } else {
          statusEl.textContent = t('compose.uploadFailed', { error: data.error || 'unknown' })
        }
      } catch (e) { statusEl.textContent = t('compose.uploadError', { error: e.message }) }
    }
    input.click()
  })

  // --- Drag-and-drop + paste upload ---
  let _composeDropOverlay = null
  let _composeUploadActive = 0

  function _composeSetPublishEnabled(enabled) {
    if (publishBtn) { publishBtn.disabled = !enabled; publishBtn.style.opacity = enabled ? '1' : '0.4' }
  }

  function _composeShowDropOverlay(show) {
    if (show) {
      if (!_composeDropOverlay) {
        _composeDropOverlay = document.createElement('div')
        _composeDropOverlay.className = 'compose-drop-overlay'
        _composeDropOverlay.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5);border:2px dashed var(--accent);border-radius:4px;color:var(--accent);font-size:0.95em;pointer-events:none;z-index:10'
        _composeDropOverlay.textContent = 'drop to upload'
      }
      const wrapper = contentInput.parentElement
      if (wrapper && !wrapper.contains(_composeDropOverlay)) {
        wrapper.style.position = 'relative'
        wrapper.appendChild(_composeDropOverlay)
      }
      contentInput.style.borderColor = 'var(--accent)'
    } else {
      if (_composeDropOverlay?.parentElement) _composeDropOverlay.remove()
      contentInput.style.borderColor = ''
    }
  }

  async function _composeUploadFile(file) {
    const category = _composeFileCategory(file)
    if (category === 'other') { statusEl.textContent = 'unsupported file type'; return }

    const limit = _composeSizeLimit(category)
    if (file.size > limit) {
      const limitMB = Math.round(limit / (1024 * 1024))
      statusEl.textContent = `file too large (max ${limitMB}MB for ${category})`
      return
    }

    _composeUploadActive++
    _composeSetPublishEnabled(false)

    const safeName = escapeHtml(file.name)
    let placeholder = `[uploading ${safeName} 0%...]`
    _composeInsertText(contentInput, placeholder)
    statusEl.textContent = t('compose.uploading')

    function updatePlaceholder(pct) {
      const newPlaceholder = `[uploading ${safeName} ${pct}%...]`
      contentInput.value = contentInput.value.replace(placeholder, newPlaceholder)
      placeholder = newPlaceholder
    }

    try {
      const token = await getAuthToken()
      if (!token) {
        contentInput.value = contentInput.value.replace(placeholder, '')
        statusEl.textContent = t('compose.walletRequired')
        return
      }

      const queueData = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('POST', `/api/ipfs?name=${encodeURIComponent(file.name)}`)
        xhr.setRequestHeader('Authorization', `Bearer ${token}`)
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100)
            updatePlaceholder(pct)
            statusEl.textContent = `uploading... ${pct}%`
          }
        }
        xhr.onload = () => {
          try { resolve(JSON.parse(xhr.responseText)) }
          catch { reject(new Error(xhr.statusText || 'upload failed')) }
        }
        xhr.onerror = () => reject(new Error('upload failed'))
        xhr.ontimeout = () => reject(new Error('upload timeout'))
        xhr.timeout = 10 * 60 * 1000
        xhr.send(file)
      })

      if (queueData.error) {
        contentInput.value = contentInput.value.replace(placeholder, '')
        statusEl.textContent = t('compose.uploadFailed', { error: queueData.error })
        return
      }

      let cid
      if (queueData.jobId) {
        statusEl.textContent = 'queued...'
        cid = await _composePollJob(queueData.jobId, statusEl, (msg) => {
          const newPlaceholder = `[${msg} ${safeName}...]`
          contentInput.value = contentInput.value.replace(placeholder, newPlaceholder)
          placeholder = newPlaceholder
        })
      } else if (queueData.cid) {
        cid = queueData.cid
      } else {
        contentInput.value = contentInput.value.replace(placeholder, '')
        statusEl.textContent = t('compose.uploadFailed', { error: 'no CID returned' })
        return
      }

      const url = ipfsUrl(cid)
      const md = _composeMarkdown(category, file.name, url)
      contentInput.value = contentInput.value.replace(placeholder, md)

      if (category === 'image') {
        statusEl.innerHTML = `<img src="${escapeHtml(url)}" loading="lazy" style="max-width:200px;max-height:100px;margin-top:0.5em;border:1px solid var(--border)"> ${t('compose.uploaded')}`
      } else {
        statusEl.textContent = `${t('compose.uploaded')} (${category})`
      }
    } catch (e) {
      contentInput.value = contentInput.value.replace(placeholder, '')
      statusEl.textContent = t('compose.uploadError', { error: e.message })
    } finally {
      _composeUploadActive = Math.max(0, _composeUploadActive - 1)
      if (_composeUploadActive === 0) _composeSetPublishEnabled(true)
    }
  }

  // Drag events
  let _composeDragCounter = 0
  contentInput.addEventListener('dragenter', (e) => {
    e.preventDefault()
    _composeDragCounter++
    _composeShowDropOverlay(true)
  })
  contentInput.addEventListener('dragover', (e) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  })
  contentInput.addEventListener('dragleave', (e) => {
    e.preventDefault()
    _composeDragCounter--
    if (_composeDragCounter <= 0) { _composeDragCounter = 0; _composeShowDropOverlay(false) }
  })
  contentInput.addEventListener('drop', async (e) => {
    e.preventDefault()
    _composeDragCounter = 0
    _composeShowDropOverlay(false)
    const files = e.dataTransfer?.files
    if (!files?.length) return
    for (const file of files) {
      const cat = _composeFileCategory(file)
      if (cat !== 'other') { await _composeUploadFile(file); break }
    }
  })

  // Paste support
  contentInput.addEventListener('paste', async (e) => {
    const items = e.clipboardData?.items
    if (!items) return
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile()
        if (!file) continue
        const cat = _composeFileCategory(file)
        if (cat !== 'other') {
          e.preventDefault()
          await _composeUploadFile(file)
          return
        }
      }
    }
  })

  // --- Format bar ---
  page.querySelectorAll('.compose-fmt').forEach(btn => {
    if (btn.id === 'compose-image') return
    btn.addEventListener('click', () => {
      const start = contentInput.selectionStart
      const end = contentInput.selectionEnd
      const selected = contentInput.value.substring(start, end)

      if (btn.dataset.wrap) {
        const wrap = btn.dataset.wrap
        contentInput.value = contentInput.value.substring(0, start) + wrap + selected + wrap + contentInput.value.substring(end)
        contentInput.selectionStart = start + wrap.length
        contentInput.selectionEnd = end + wrap.length
      } else if (btn.dataset.prefix) {
        const prefix = btn.dataset.prefix
        contentInput.value = contentInput.value.substring(0, start) + prefix + selected + contentInput.value.substring(end)
        contentInput.selectionStart = start + prefix.length
        contentInput.selectionEnd = end + prefix.length
      } else if (btn.dataset.link) {
        const existing = document.getElementById('compose-link-input')
        if (existing) { existing.remove(); return }
        const linkBar = document.createElement('div')
        linkBar.id = 'compose-link-input'
        linkBar.style.cssText = 'display:flex;gap:0.5ch;align-items:center;padding:0.5em 0;'
        linkBar.innerHTML = `
          <input type="url" id="compose-link-url" placeholder="https://..." style="flex:1;background:#111;border:1px solid #333;color:#c0c0c0;font-family:inherit;font-size:0.85em;padding:0.4em 1ch;box-sizing:border-box">
          <button id="compose-link-insert" class="buy-btn" style="font-size:0.8em;padding:0.3em 1ch">insert</button>
          <button id="compose-link-cancel" style="background:none;border:none;color:#666;font-family:inherit;font-size:0.8em;cursor:pointer">cancel</button>
        `
        btn.parentElement.after(linkBar)
        const urlInput = document.getElementById('compose-link-url')
        urlInput.focus()
        document.getElementById('compose-link-insert').addEventListener('click', () => {
          const url = urlInput.value.trim()
          if (url) {
            const linkText = selected || 'link'
            contentInput.value = contentInput.value.substring(0, start) + `[${linkText}](${url})` + contentInput.value.substring(end)
          }
          linkBar.remove()
          contentInput.focus()
        })
        urlInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); document.getElementById('compose-link-insert').click() }
          if (e.key === 'Escape') linkBar.remove()
        })
        document.getElementById('compose-link-cancel').addEventListener('click', () => linkBar.remove())
        return
      } else if (btn.dataset.inlineRef) {
        // @ button opens the same unified reference picker
        toggleRefPicker()
        return
      }
      contentInput.focus()
    })
  })

  // --- Auto-preview mode ---
  // Default: show preview. Click preview area → switch to edit. After 2s idle → back to preview.
  const preview = document.getElementById('compose-preview')
  const toggleBtn = document.getElementById('compose-preview-toggle')
  let _autoPreviewTimer = null
  let _isEditing = false

  function showPreview() {
    if (!preview) return
    const md = contentInput.value
    if (md.trim()) {
      preview.innerHTML = renderMarkdown(md)
      preview.style.display = 'block'
      contentInput.style.display = 'none'
    } else {
      // Empty content — stay in edit mode
      preview.style.display = 'none'
      contentInput.style.display = ''
    }
    _isEditing = false
    if (toggleBtn) toggleBtn.textContent = 'edit'
  }

  function showEditor() {
    if (preview) preview.style.display = 'none'
    contentInput.style.display = ''
    _isEditing = true
    if (toggleBtn) toggleBtn.textContent = 'preview'
    contentInput.focus()
  }

  function scheduleAutoPreview() {
    clearTimeout(_autoPreviewTimer)
    _autoPreviewTimer = setTimeout(() => {
      if (contentInput.value.trim()) showPreview()
    }, 2000)
  }

  // Toggle button: manual switch
  toggleBtn?.addEventListener('click', () => {
    if (_isEditing) {
      clearTimeout(_autoPreviewTimer)
      showPreview()
    } else {
      showEditor()
    }
  })

  // Clicking the preview area switches to edit mode
  preview?.addEventListener('click', () => {
    showEditor()
  })

  // Auto-preview after typing stops
  contentInput.addEventListener('input', () => {
    clearTimeout(_autoPreviewTimer)
    scheduleAutoPreview()
  })

  // Start in preview mode if there's content (e.g., restored draft)
  if (contentInput.value.trim()) {
    showPreview()
  }

  // Click-to-focus on editor area (when in edit mode or empty)
  page.querySelector('.write-editor')?.addEventListener('click', (e) => {
    if (e.target === preview || preview?.contains(e.target)) return // handled above
    if (e.target.classList.contains('write-editor') || e.target.closest('.write-editor') === e.target) {
      if (!_isEditing) { showEditor(); return }
      if (contentInput && !contentInput.contains(e.target) && !e.target.closest('.write-format-bar') && !e.target.closest('.compose-ref-card') && !e.target.closest('input') && !e.target.closest('button')) {
        contentInput.focus()
      }
    }
  })

  // --- Inline @-autocomplete ---
  // Detect @word in textarea and show a floating dropdown to search people
  let _atDropdown = null
  let _atSearchTimer = null
  let _atStartPos = -1

  function removeAtDropdown() {
    if (_atDropdown) { _atDropdown.remove(); _atDropdown = null }
    _atStartPos = -1
  }

  async function showAtResults(q) {
    if (!_atDropdown) return
    const resultsDiv = _atDropdown.querySelector('.at-results')
    if (!resultsDiv) return
    if (q.length < 1) { resultsDiv.innerHTML = ''; return }
    try {
      const res = await fetch(`/api/network/search?q=${encodeURIComponent(q)}&limit=6`)
      if (!res.ok) return
      const data = await res.json()
      const people = (data.results || data.artists || []).concat(data.supporters || []).slice(0, 6)
      if (people.length === 0) { resultsDiv.innerHTML = `<div style="padding:0.4em 0.75em;color:var(--dim);font-size:0.85em">no matches</div>`; return }
      resultsDiv.innerHTML = people.map(p => {
        const domain = p.domain || p.name || `${p.handle || ''}.ourpraxis.network`
        const handle = p.handle || domain.split('.')[0]
        return `<div class="at-option" data-domain="${escapeHtml(domain)}" data-handle="${escapeHtml(handle)}" style="padding:0.5em 0.75em;cursor:pointer;font-size:0.85em;border-bottom:1px solid var(--border)">
          <span style="color:var(--accent)">@${escapeHtml(handle)}</span>
          <span style="color:var(--dim)"> — ${escapeHtml(domain)}</span>
        </div>`
      }).join('')
      resultsDiv.querySelectorAll('.at-option').forEach(opt => {
        opt.addEventListener('mouseenter', () => opt.style.background = 'var(--surface)')
        opt.addEventListener('mouseleave', () => opt.style.background = '')
        opt.addEventListener('mousedown', (e) => {
          e.preventDefault() // prevent blur
          const domain = opt.dataset.domain
          const handle = opt.dataset.handle
          const before = contentInput.value.substring(0, _atStartPos)
          const after = contentInput.value.substring(contentInput.selectionStart)
          const mention = `[@${handle}](https://${domain})`
          contentInput.value = before + mention + after
          contentInput.selectionStart = contentInput.selectionEnd = _atStartPos + mention.length
          removeAtDropdown()
          contentInput.focus()
        })
      })
    } catch {}
  }

  contentInput.addEventListener('input', () => {
    const pos = contentInput.selectionStart
    const text = contentInput.value.substring(0, pos)
    // Find @ that starts a mention (after whitespace or start of string)
    const match = text.match(/@(\w*)$/)
    if (match) {
      _atStartPos = pos - match[0].length
      const q = match[1]
      if (!_atDropdown) {
        _atDropdown = document.createElement('div')
        _atDropdown.className = 'at-autocomplete'
        _atDropdown.style.cssText = 'position:fixed;background:var(--bg);border:1px solid var(--border);border-radius:6px;max-height:200px;overflow-y:auto;z-index:100;min-width:220px;box-shadow:0 4px 12px rgba(0,0,0,0.3)'
        _atDropdown.innerHTML = '<div class="at-results"></div>'
        document.body.appendChild(_atDropdown)
      }
      // Position: use a hidden div mirror to find caret coordinates
      const taRect = contentInput.getBoundingClientRect()
      const cs = getComputedStyle(contentInput)
      const mirror = document.createElement('div')
      mirror.style.cssText = `position:absolute;visibility:hidden;white-space:pre-wrap;word-wrap:break-word;overflow:hidden;font:${cs.font};line-height:${cs.lineHeight};padding:${cs.padding};width:${contentInput.clientWidth}px;`
      mirror.textContent = contentInput.value.substring(0, pos)
      const caret = document.createElement('span')
      caret.textContent = '|'
      mirror.appendChild(caret)
      document.body.appendChild(mirror)
      const caretRect = caret.getBoundingClientRect()
      const mirrorRect = mirror.getBoundingClientRect()
      const caretX = caretRect.left - mirrorRect.left
      const caretY = caretRect.top - mirrorRect.top
      mirror.remove()
      const scrollTop = contentInput.scrollTop
      _atDropdown.style.left = `${Math.min(taRect.left + caretX, window.innerWidth - 240)}px`
      _atDropdown.style.top = `${taRect.top + caretY - scrollTop + 20}px`
      clearTimeout(_atSearchTimer)
      _atSearchTimer = setTimeout(() => showAtResults(q), 200)
    } else {
      removeAtDropdown()
    }
  })

  contentInput.addEventListener('blur', () => {
    setTimeout(removeAtDropdown, 200) // delay to allow click on dropdown
  })

  contentInput.addEventListener('keydown', (e) => {
    if (_atDropdown && e.key === 'Escape') { removeAtDropdown(); e.preventDefault() }
  })

  // Focus title on load
  titleInput?.focus()

  // Autosave draft on beforeunload
  window.addEventListener('beforeunload', saveDraft)
}

function saveDraft() {
  const title = document.getElementById('compose-title')?.value?.trim() || ''
  const body = document.getElementById('compose-content')?.value?.trim() || ''
  if (title || body) {
    try { localStorage.setItem('praxis-blog-draft', JSON.stringify({ title, body, ts: Date.now() })) } catch {}
  } else {
    try { localStorage.removeItem('praxis-blog-draft') } catch {}
  }
}

registerPage('write-page', initWrite)

// Expose redirect function for backward compatibility
window.openComposeModal = function(blogAddr, amendPostId, prefillTitle, prefillContent, opts) {
  const params = new URLSearchParams()
  if (amendPostId) params.set('amend', amendPostId)
  if (opts?.mediaRef) {
    params.set('ref', opts.mediaRef.mediaId)
    if (opts.mediaRef.title) params.set('refTitle', opts.mediaRef.title)
    if (opts.mediaRef.artist) params.set('refArtist', opts.mediaRef.artist)
    if (opts.mediaRef.art) params.set('refArt', opts.mediaRef.art)
    if (opts.mediaRef.src) params.set('refSrc', opts.mediaRef.src)
    if (opts.mediaRef.type) params.set('refType', opts.mediaRef.type)
  }
  if (prefillTitle) params.set('prefillTitle', prefillTitle)
  if (prefillContent) params.set('prefillContent', prefillContent)
  const qs = params.toString()
  window.location.href = '/write' + (qs ? '?' + qs : '')
}
