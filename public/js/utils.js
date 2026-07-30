// Shared utilities used across all Praxis frontend modules
import { F } from './fragments.js'
import { getCached as _getCached, setCache as _setCache, TTL as _TTL } from './cache.js'
import { t } from './i18n.js'

// Debug logger gated by `localStorage['praxis-debug'] = '1'`. Used by modules
// that emit informational `praxis: ...` logs (XMTP init paths, zkp2p intent
// fetcher, etc.) so end-user consoles stay quiet by default while devs can
// flip the flag to see the full trace. Audit cycle 4 LOW-2/LOW-3 cleanup.
export function dbg(...args) {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('praxis-debug') === '1') {
      console.log(...args)
    }
  } catch {}
}

// === Auth token ===
// Shared auth token for admin endpoints. Resets on wallet connect/disconnect.
let _authToken = ''
if (typeof window !== 'undefined') {
  window.addEventListener('wallet-connected', () => { _authToken = '' })
  window.addEventListener('wallet-disconnected', () => { _authToken = '' })
}

export async function getAuthToken() {
  if (_authToken) return _authToken
  let addr = window.getWalletAddress?.()
  if (!addr || !getWalletProvider()) {
    addr = await window.connectWallet?.()
    if (!addr) return ''
  }
  try {
    await window.ensureAuthorized?.()
    const msg = `admin:${location.hostname}:${Date.now()}`
    const sig = await getWalletProvider().request({ method: 'personal_sign', params: [msg, addr] })
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: addr, signature: sig, message: msg }),
    })
    if (!res.ok) throw new Error(`auth ${res.status}`)
    const data = await res.json()
    if (data.error) console.warn('auth error:', data.error)
    if (data.token) _authToken = data.token
    return _authToken
  } catch (e) {
    console.warn('getAuthToken failed:', e?.message)
    return ''
  }
}

// === Wallet provider routing ===
// Returns the EIP-1193 provider that Praxis should use for any wallet operation.
// When another wallet (Phantom/Coinbase/Rabby) has locked window.ethereum as
// non-configurable, our embedded provider lives at window.praxisEthereum.
// EVERY wallet RPC call must go through this helper, not window.ethereum directly.
export function getWalletProvider() {
  if (typeof window === 'undefined') return null
  // Always use the embedded wallet — never fall back to MetaMask/browser extensions
  return window.praxisEthereum || null
}

// Sign a personal_sign message using the embedded wallet first, falling back to
// the active provider. Returns a Uint8Array (XMTP) — for hex string usage, just
// call provider.request directly via getWalletProvider().
export async function praxisSignMessage(address, message) {
  // 1. Embedded wallet helper — fastest, no popup, works even if window.ethereum is locked
  if (typeof window !== 'undefined' && window.signMessage) {
    try {
      const hex = await window.signMessage(message)
      return hex
    } catch (e) {
      // fall through to provider
      console.warn('[utils] window.signMessage failed, trying provider:', e?.message)
    }
  }
  // 2. Provider request via the praxis namespace (or external wallet fallback)
  const provider = getWalletProvider()
  if (!provider) throw new Error('no wallet provider available')
  return await provider.request({ method: 'personal_sign', params: [message, address] })
}

// Parse structured event metadata from project description.
// Convention: description starts with ---praxis-event---\n{json}\n---\n then human text.
export function parseEventMetadata(description) {
  if (!description) return { meta: null, text: description || '' }
  const match = description.match(/^---praxis-event---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return { meta: null, text: description }
  try {
    return { meta: JSON.parse(match[1]), text: match[2].trim() }
  } catch {
    return { meta: null, text: description }
  }
}

// Format ETH amount — shows enough precision to never display "0" for non-zero values
export function formatEthAmount(wei) {
  const num = Number(wei) / 1e18
  if (num === 0) return '0'
  if (num >= 0.01) return num.toFixed(4).replace(/\.?0+$/, '')
  // for tiny amounts, show enough decimals
  const str = num.toFixed(18).replace(/0+$/, '')
  // find first significant digit after decimal
  const match = str.match(/^0\.(0*)([1-9])/)
  if (match) {
    const zeros = match[1].length
    return num.toFixed(zeros + 4).replace(/\.?0+$/, '')
  }
  return str
}

// IPFS gateway — proxied through server to hide token
export function ipfsUrl(cid) {
  return `/api/ipfs-proxy/${cid}`
}

// Fix 8: IPFS request deduplication — concurrent fetches for same CID share one request
// 30s timeout ensures inflight entries don't stick forever on hung requests
const _ipfsFetchInflight = new Map()
const _IPFS_FETCH_TIMEOUT = 30000
const _IPFS_FETCH_INFLIGHT_MAX = 500
export function fetchIpfs(cid) {
  if (_ipfsFetchInflight.has(cid)) return _ipfsFetchInflight.get(cid)
  // M9: bypass coalescing if at max to prevent unbounded growth
  if (_ipfsFetchInflight.size >= _IPFS_FETCH_INFLIGHT_MAX) return fetch(ipfsUrl(cid))
  const promise = fetch(ipfsUrl(cid)).then(r => {
    _ipfsFetchInflight.delete(cid)
    return r
  }, err => {
    _ipfsFetchInflight.delete(cid)
    throw err
  })
  // safety timeout: if the fetch hangs beyond 30s, clear inflight so retries can proceed
  const timer = setTimeout(() => { _ipfsFetchInflight.delete(cid) }, _IPFS_FETCH_TIMEOUT)
  // avoid holding the process open in environments that support unref
  if (typeof timer === 'object' && timer.unref) timer.unref()
  const wrapped = promise.finally(() => clearTimeout(timer))
  _ipfsFetchInflight.set(cid, wrapped)
  return wrapped
}

// Placeholder for missing album/cover art — inline SVG with title text
export function artPlaceholder(title, size = 240) {
  const t = (title || 'untitled').slice(0, 30)
  const escaped = t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const fs = Math.min(18, Math.max(10, Math.floor(size / (t.length * 0.6))))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="width:100%;height:100%"><rect x="4" y="4" width="${size - 8}" height="${size - 8}" fill="none" stroke="var(--accent, #e0e0e0)" stroke-width="1.5"/><text x="${size / 2}" y="${size / 2}" text-anchor="middle" dominant-baseline="central" fill="var(--fg, #ccc)" font-family="monospace" font-size="${fs}">${escaped}</text></svg>`
}

export function rewriteIpfsUrls(html) {
  // rewrite any direct Pinata gateway URLs to our proxy
  html = html.replace(/https?:\/\/[a-z]+\.mypinata\.cloud\/ipfs\/([A-Za-z0-9]+)(\?[^"')]*)?/g, '/api/ipfs-proxy/$1')
  html = html.replace(/https?:\/\/gateway\.pinata\.cloud\/ipfs\/([A-Za-z0-9]+)/g, '/api/ipfs-proxy/$1')
  return html
}

// shared public client singleton — lazy initialized
let _publicClient = null
export async function getPublicClient() {
  if (_publicClient) return _publicClient
  const { createPublicClient, http } = await import('./vendor.js')
  const { optimism } = await import('./vendor.js')
  _publicClient = createPublicClient({ chain: optimism, transport: http() })
  return _publicClient
}

// cached ETH balance — 60s TTL, single RPC across all pages
const _inflightBalance = new Map()

// Drop the cached balance for a wallet so the next read fetches fresh from RPC.
// Called after txs that change the balance (bridge, ramp, purchase, etc.).
export function invalidateBalanceCache(addr) {
  if (!addr) return
  const key = `praxis-balance-${addr.toLowerCase()}`
  try { sessionStorage.removeItem(key) } catch {}
  _inflightBalance.delete(addr.toLowerCase())
}

export async function getCachedBalance(addr) {
  const addrLower = addr.toLowerCase()
  const key = `praxis-balance-${addrLower}`
  try {
    const cached = sessionStorage.getItem(key)
    if (cached) {
      const { value, ts } = JSON.parse(cached)
      if (Date.now() - ts < 60000) return BigInt(value)
    }
  } catch {}

  // if already fetching this address, return the same promise
  if (_inflightBalance.has(addrLower)) return _inflightBalance.get(addrLower)
  // M11: bypass coalescing if at max to prevent unbounded growth
  const _shouldCoalesceBalance = _inflightBalance.size < 50

  const promise = (async () => {
    const pc = await getPublicClient()
    const balance = await pc.getBalance({ address: addr })
    try { sessionStorage.setItem(key, JSON.stringify({ value: balance.toString(), ts: Date.now() })) } catch {}
    return balance
  })()

  if (_shouldCoalesceBalance) _inflightBalance.set(addrLower, promise)

  try {
    const result = await promise
    return result
  } finally {
    _inflightBalance.delete(addrLower)
  }
}

// Rewrite external URLs to go through our proxy (avoids CSP connect-src blocks)
function proxyUrl(url) {
  if (!url || url.startsWith('/') || url.startsWith(location.origin)) return url
  return `/api/fetch-url?url=${encodeURIComponent(url)}`
}

// universal media renderer — inline display for any file type
// handles IPFS URLs without extensions by using a placeholder that auto-detects MIME
export function renderMedia(url, filename) {
  const proxied = proxyUrl(url)
  const ext = (filename || url)?.split('.').pop()?.toLowerCase()?.split('?')[0] || ''
  const html = renderByExt(proxied, ext)
  if (html) return html

  // no extension match (common with IPFS URLs) — render auto-detect container
  const id = 'media-' + Math.random().toString(36).slice(2, 8)
  setTimeout(() => detectAndRender(id, proxied), 0)
  return `<div id="${id}" style="margin:0.5em 0"><span class="praxis-loader"></span></div>`
}

function renderByExt(url, ext) {
  if (['jpg','jpeg','png','gif','webp','svg','avif'].includes(ext)) {
    return `<img src="${url}" loading="lazy" style="max-width:100%;margin:0.5em 0">`
  }
  if (ext === 'pdf') {
    return renderPdf(url)
  }
  if (['mp3','wav','ogg','flac','aac','m4a','opus'].includes(ext)) {
    return `<audio src="${url}" controls preload="none" style="width:100%;margin:0.5em 0"></audio>`
  }
  if (['mp4','webm','mov','mkv','avi'].includes(ext)) {
    return `<video src="${url}" controls preload="none" style="max-width:100%;margin:0.5em 0"></video>`
  }
  return null
}

// PDF renderer — fetches as blob to bypass X-Frame-Options restrictions
function _isMobileOrTablet() {
  return /Android|iPhone|iPad|iPod|Mobile|Tablet/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && window.innerWidth < 1024)
}

// Shared PDF.js loader — deduplicates script injection across call sites
let _pdfJsLoadPromise = null
export function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib)
  if (_pdfJsLoadPromise) return _pdfJsLoadPromise
  _pdfJsLoadPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
      resolve(window.pdfjsLib)
    }
    s.onerror = reject
    document.head.appendChild(s)
  })
  return _pdfJsLoadPromise
}

// Render first page of a PDF to a canvas thumbnail (width px). Returns the canvas element.
// Callers should cache results keyed by URL to avoid re-fetching.
const _pdfThumbCache = new Map()
const _PDF_THUMB_MAX_CACHE = 100
export async function renderPdfThumbnail(url, width = 300) {
  if (_pdfThumbCache.has(url)) return _pdfThumbCache.get(url).cloneNode(true)

  const pdfjsLib = await loadPdfJs()
  const res = await fetch(url)
  if (!res.ok) throw new Error(`PDF fetch failed: ${res.status}`)
  const data = await res.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data }).promise
  const page = await pdf.getPage(1)
  const scale = (width * (window.devicePixelRatio || 1)) / page.getViewport({ scale: 1 }).width
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = viewport.width
  canvas.height = viewport.height
  canvas.style.cssText = `width:${width}px;height:auto;display:block`
  const ctx = canvas.getContext('2d')
  // Fill white background first (PDFs render transparent otherwise)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, viewport.width, viewport.height)
  await page.render({ canvasContext: ctx, viewport }).promise

  // Bounded LRU cache
  if (_pdfThumbCache.size >= _PDF_THUMB_MAX_CACHE) {
    const oldest = _pdfThumbCache.keys().next().value
    _pdfThumbCache.delete(oldest)
  }
  _pdfThumbCache.set(url, canvas)
  return canvas.cloneNode(true)
}

function renderPdf(url) {
  const id = 'pdf-' + Math.random().toString(36).slice(2, 8)

  // On mobile/tablet, show page-1 thumbnail + "open PDF" button (fast preview),
  // then lazily render remaining pages below when the user scrolls.
  if (_isMobileOrTablet()) {
    setTimeout(async () => {
      const el = document.getElementById(id)
      if (!el) return
      try {
        // Render page 1 thumbnail first for fast preview
        const thumbCanvas = await renderPdfThumbnail(url, Math.min(window.innerWidth - 32, 600))
        thumbCanvas.style.cssText = 'width:100%;height:auto;display:block;cursor:pointer;border:1px solid var(--border);border-radius:4px;background:#fff'
        thumbCanvas.addEventListener('click', () => window.open(url, '_blank'))

        const openBtn = document.createElement('a')
        openBtn.href = url
        openBtn.target = '_blank'
        openBtn.style.cssText = 'display:block;text-align:center;color:var(--accent);padding:0.75em;font-size:0.9em;text-decoration:none;border:1px solid var(--border);border-radius:4px;margin-top:0.5em'
        openBtn.textContent = 'open PDF'

        el.innerHTML = ''
        el.appendChild(thumbCanvas)
        el.appendChild(openBtn)

        // Now progressively render remaining pages below the thumbnail
        const pdfjsLib = await loadPdfJs()
        const res = await fetch(url)
        if (!res.ok) throw new Error(`${res.status}`)
        const data = await res.arrayBuffer()
        const pdf = await pdfjsLib.getDocument({ data }).promise

        if (pdf.numPages > 1) {
          const container = document.createElement('div')
          container.style.cssText = 'margin-top:0.5em'

          for (let i = 2; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i)
            const viewport = page.getViewport({ scale: window.devicePixelRatio * (window.innerWidth < 600 ? 1 : 1.5) })
            const canvas = document.createElement('canvas')
            canvas.width = viewport.width
            canvas.height = viewport.height
            canvas.style.cssText = 'width:100%;height:auto;display:block;margin-bottom:0.5em'
            container.appendChild(canvas)
            await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
          }

          // Insert remaining pages between thumbnail and open button
          el.insertBefore(container, openBtn)
        }

        // Add actions to sheet header
        const sheetHeader = el.closest('#library-sheet')?.querySelector('div:first-child > div:first-child')
        if (sheetHeader && !sheetHeader.querySelector('.pdf-actions')) {
          const actions = document.createElement('span')
          actions.className = 'pdf-actions'
          actions.style.cssText = 'display:flex;gap:0.5ch;margin-left:auto;align-items:center'
          actions.innerHTML = `<a href="${url}" target="_blank" style="color:var(--muted);font-size:0.8em;padding:0.2em 0.8ch;border:1px solid var(--border,#333);border-radius:3px;text-decoration:none">open</a>`
          const saveBtn = el.closest('#library-sheet')?.querySelector('#library-sheet-save')
          if (saveBtn) { const isSaved = saveBtn.textContent.includes('saved'); saveBtn.style.cssText = 'background:none;border:1px solid ' + (isSaved ? 'var(--accent)' : 'var(--border,#333)') + ';color:' + (isSaved ? 'var(--accent)' : 'var(--muted)') + ';font-family:inherit;font-size:0.85em;padding:0.3em 1ch;cursor:pointer;border-radius:3px;position:static;display:flex;align-items:center;gap:0.4ch'; actions.appendChild(saveBtn) }
          sheetHeader.appendChild(actions)
        }
      } catch (e) {
        // Fallback: try to show at least a thumbnail above the open button
        try {
          const thumbCanvas = await renderPdfThumbnail(url, Math.min(window.innerWidth - 32, 400))
          thumbCanvas.style.cssText = 'width:100%;height:auto;display:block;cursor:pointer;margin-bottom:0.5em'
          thumbCanvas.addEventListener('click', () => window.open(url, '_blank'))
          el.innerHTML = ''
          el.appendChild(thumbCanvas)
          const link = document.createElement('a')
          link.href = url
          link.target = '_blank'
          link.style.cssText = 'color:var(--accent);display:block;text-align:center;padding:0.5em'
          link.textContent = 'open PDF'
          el.appendChild(link)
        } catch {
          el.innerHTML = `<a href="${url}" target="_blank" style="color:var(--accent);padding:2em;display:block;text-align:center">open PDF</a>`
        }
      }
    }, 0)
    return `<div id="${id}" style="margin:0"><span class="praxis-loader" style="display:block;padding:2em;text-align:center"></span></div>`
  }

  setTimeout(async () => {
    const el = document.getElementById(id)
    if (!el) return
    const maxRetries = 3
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(url)
        if (res.status === 502 || res.status === 503 || res.status === 504) {
          if (attempt < maxRetries) { el.innerHTML = `<span class="praxis-loader"></span> retrying...`; await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); continue }
          throw new Error(`${res.status}`)
        }
        if (!res.ok) throw new Error(`${res.status}`)
        const blob = await res.blob()
        const blobUrl = URL.createObjectURL(blob)
        el.innerHTML = `<div style="position:relative;flex:1;overflow:auto;-webkit-overflow-scrolling:touch">
          <iframe src="${blobUrl}" style="width:100%;height:calc(100vh - 4em);border:none;display:block" allow="fullscreen"></iframe>
        </div>`
        // Add actions to the parent sheet header if inside a library sheet
        const sheetHeader = el.closest('#library-sheet')?.querySelector('div:first-child > div:first-child')
        if (sheetHeader) {
          const actions = document.createElement('span')
          actions.style.cssText = 'display:flex;gap:0.5ch;margin-left:auto;align-items:center'
          actions.innerHTML = `<a href="${url}" target="_blank" style="color:var(--muted);font-size:0.8em;padding:0.2em 0.8ch;border:1px solid var(--border,#333);border-radius:3px;text-decoration:none">open</a>`
          // Move the save button into the header if it exists
          const saveBtn = el.closest('#library-sheet')?.querySelector('#library-sheet-save')
          if (saveBtn) { const isSaved = saveBtn.textContent.includes('saved'); saveBtn.style.cssText = 'background:none;border:1px solid ' + (isSaved ? 'var(--accent)' : 'var(--border,#333)') + ';color:' + (isSaved ? 'var(--accent)' : 'var(--muted)') + ';font-family:inherit;font-size:0.85em;padding:0.3em 1ch;cursor:pointer;border-radius:3px;position:static;display:flex;align-items:center;gap:0.4ch'; actions.appendChild(saveBtn) }
          sheetHeader.appendChild(actions)
        }
        return
      } catch (e) {
        if (attempt < maxRetries) { el.innerHTML = `<span class="praxis-loader"></span> retrying...`; await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); continue }
        el.innerHTML = `<a href="${url}" target="_blank" style="color:var(--accent)">open PDF</a>`
      }
    }
  }, 0)
  return `<div id="${id}" style="margin:0.5em 0"><span class="praxis-loader"></span></div>`
}

async function detectAndRender(id, url) {
  const el = document.getElementById(id)
  if (!el) return
  try {
    const res = await fetch(url, { method: 'HEAD' })
    const ct = (res.headers.get('content-type') || '').split(';')[0].trim()
    if (ct.startsWith('image/')) {
      el.innerHTML = `<img src="${url}" loading="lazy" style="max-width:100%;margin:0.5em 0">`
    } else if (ct === 'application/pdf') {
      el.innerHTML = renderPdf(url)
    } else if (ct.startsWith('audio/')) {
      el.innerHTML = `<audio src="${url}" controls preload="none" style="width:100%;margin:0.5em 0"></audio>`
    } else if (ct.startsWith('video/')) {
      el.innerHTML = `<video src="${url}" controls preload="none" style="max-width:100%;margin:0.5em 0"></video>`
    } else {
      el.innerHTML = `<a href="${url}" target="_blank" style="color:var(--accent)">open file (${ct || 'unknown'})</a>`
    }
  } catch {
    el.innerHTML = `<a href="${url}" target="_blank" style="color:var(--accent)">open file</a>`
  }
}

export function escapeHtml(s) {
  const d = document.createElement('div')
  d.textContent = s
  return d.innerHTML
}

// Shared markdown renderer — escapes HTML first for XSS safety, then applies
// markdown transformations that produce safe HTML tags. URLs validated to only
// allow http/https/relative paths. Used by post.js, feed.js, landing, etc.
export function renderMarkdown(text) {
  if (!text) return ''
  // Escape HTML first for XSS safety
  let html = escapeHtml(text)
  // Rewrite IPFS gateway URLs if the function exists
  if (typeof window !== 'undefined' && window.__rewriteIpfsUrls) html = window.__rewriteIpfsUrls(html)
  // Helper: escape a value for safe insertion into HTML attributes
  const escAttr = (s) => (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  // Images: ![alt](url)
  html = html.replace(/!\[([^\]]*)\]\s*\(([^)]+)\)/g, (_, alt, url) => {
    if (!/^(https?:|\/[^\/])/.test(url)) return alt
    const src = url.includes('/api/ipfs-proxy/') ? `/api/img?url=${encodeURIComponent(url)}&amp;w=1200` : url
    return `<img src="${escAttr(src)}" alt="${escAttr(alt)}" loading="lazy" style="max-width:100%;margin:1em 0">`
  })
  // Video embeds: [video: filename](url) — renders as thumbnail with click-to-play
  html = html.replace(/\[video:\s*([^\]]*)\]\s*\(([^)]+)\)/g, (_, label, url) => {
    if (!/^(https?:|\/[^\/])/.test(url)) return label
    const safeUrl = escAttr(url)
    // Extract CID for video-thumb poster (avoids autoplay/mute issues from <video preload>)
    const cidMatch = url.match(/ipfs-proxy\/([A-Za-z0-9]+)/)
    const posterUrl = cidMatch ? '/api/video-thumb?cid=' + cidMatch[1] + '&w=800' : ''
    return `<div class="video-lazy" data-src="${safeUrl}" data-title="${escAttr(label)}" style="position:relative;width:100%;overflow:hidden;cursor:pointer;background:#000;aspect-ratio:16/9">
      ${posterUrl ? `<img src="${posterUrl}" style="width:100%;height:100%;object-fit:cover;display:block" loading="lazy" onerror="this.style.display='none'">` : ''}
      <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">
        <div style="width:56px;height:56px;border-radius:50%;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center">
          <i class="ph ph-play" style="color:#fff;font-size:1.4em;margin-left:2px"></i>
        </div>
      </div>
    </div>`
  })
  // Audio embeds: [audio: filename](url)
  html = html.replace(/\[audio:\s*([^\]]*)\]\s*\(([^)]+)\)/g, (_, label, url) => {
    if (!/^(https?:|\/[^\/])/.test(url)) return label
    return `<button class="track-play-btn" data-track-src="${escAttr(url)}" data-track-title="${escAttr(label)}" style="margin:0.5em 0">play ${escAttr(label)}</button>`
  })
  // Links: [text](url) — supports praxis:// internal links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, href) => {
    const praxisMatch = href.match(/^praxis:\/\/(project|media|post|library|artist)\/(.+)$/)
    if (praxisMatch) {
      const [, type, id] = praxisMatch
      const eid = encodeURIComponent(id)
      const routes = { project: `/project?id=${eid}`, media: `/art?id=${eid}`, post: `/post?id=${eid}`, library: `/library?item=${eid}`, artist: `/network?artist=${eid}` }
      return `<a href="${escAttr(routes[type])}" style="color:var(--accent);text-decoration:underline;text-decoration-style:dotted">${text}</a>`
    }
    if (!/^(https?:|\/[^\/]|mailto:)/.test(href)) return text
    return `<a href="${escAttr(href)}">${text}</a>`
  })
  // Bold then italic (order matters)
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')
  // Headings
  html = html.replace(/^#{3}\s+(.+)$/gm, '<h3>$1</h3>')
  html = html.replace(/^#{2}\s+(.+)$/gm, '<h2>$1</h2>')
  html = html.replace(/^#{1}\s+(.+)$/gm, '<h2>$1</h2>')
  // Blockquotes (escaped > is &gt;)
  html = html.replace(/^&gt;\s+(.+)$/gm, '<blockquote>$1</blockquote>')
  // Horizontal rules
  html = html.replace(/^---+$/gm, '<hr>')
  // Paragraphs from double newlines
  html = html.split(/\n\n+/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('')
  return html
}

// Shared wallet client — always call AFTER ensureAuthorized/ensureWallet
// Routes through getWalletProvider() so embedded users with another wallet
// extension installed (Phantom/Coinbase/Rabby) still hit the embedded provider.
export async function getWalletClient() {
  const { createWalletClient, custom, optimism } = await import('./vendor.js')
  return createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })
}

export async function ensureWallet() {
  let addr = window.getWalletAddress?.()
  if (!addr) {
    await window.connectWallet?.()
    addr = window.getWalletAddress?.()
  }
  return addr || null
}

export async function requireUser(action = 'continue') {
  const addr = window.getWalletAddress?.()
  if (!addr) {
    await window.connectWallet?.()
    const newAddr = window.getWalletAddress?.()
    if (!newAddr) return null
    return requireUser(action) // re-check after connect
  }

  // check if registered (cache for session)
  const cacheKey = `praxis-user-${addr.toLowerCase()}`
  const cached = sessionStorage.getItem(cacheKey)
  if (cached === 'artist' || cached === 'supporter' || cached === 'user') return addr

  try {
    const pc = await getPublicClient()
    const registryAddr = document.body.dataset.registry || document.querySelector('[data-registry]')?.dataset?.registry
    if (!registryAddr) return addr // no registry configured, allow action

    const IS_USER_ABI = [
      { name: 'isUser', type: 'function', inputs: [{ name: 'wallet', type: 'address' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
    ]

    const isRegistered = await pc.readContract({
      address: registryAddr,
      abi: IS_USER_ABI,
      functionName: 'isUser',
      args: [addr],
    })

    if (isRegistered) {
      sessionStorage.setItem(cacheKey, 'user')
      return addr
    }

    // not registered — show inline registration modal
    return _showInlineRegistration(addr, registryAddr, pc, action)
  } catch {
    return addr // on error, allow action (don't block)
  }
}

// Inline supporter registration modal — shown when unregistered user tries a gated action
function _showInlineRegistration(address, registryAddress, publicClient, action) {
  return new Promise(resolve => {
    // remove any existing modal
    document.getElementById('praxis-register-overlay')?.remove()

    const REGISTER_ABI = [
      { name: 'registerSupporter', type: 'function', inputs: [{ name: 'handle', type: 'string' }], outputs: [], stateMutability: 'nonpayable' },
      { name: 'handleAvailable', type: 'function', inputs: [{ name: 'handle', type: 'string' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
    ]

    const overlay = document.createElement('div')
    overlay.id = 'praxis-register-overlay'
    overlay.className = 'praxis-modal-overlay'
    overlay.style.zIndex = '10002'

    const dialog = document.createElement('div')
    dialog.className = 'praxis-modal-dialog'
    dialog.style.maxWidth = '380px'
    dialog.style.fontFamily = 'inherit'

    dialog.innerHTML = `
      <div style="margin-bottom:1.5em">
        <div style="color:var(--fg, #c0c0c0);margin-bottom:0.5em">${t('audience.registerPrompt')}</div>
        <div style="color:var(--dim, #444);font-size:0.85em">to ${escapeHtml(action)}</div>
      </div>
      <div style="display:flex;align-items:center;gap:1ch;margin-bottom:1em">
        <input id="praxis-reg-handle" type="text" maxlength="32" autocomplete="off" spellcheck="false"
          placeholder="${t('audience.handlePlaceholder')}"
          style="background:none;border:1px solid var(--border, #333);color:var(--fg, #c0c0c0);font-family:inherit;font-size:0.9em;padding:0.4em 0.75ch;flex:1">
        <span id="praxis-reg-handle-status" style="font-size:0.9em;min-width:1.5ch"></span>
      </div>
      <div style="display:flex;gap:1ch;align-items:center">
        <button id="praxis-reg-submit" disabled style="background:none;border:1px solid var(--border, #333);color:var(--fg, #c0c0c0);font-family:inherit;font-size:0.85em;padding:0.4em 1.5ch;cursor:pointer;opacity:0.4">${t('audience.register')}</button>
        <button id="praxis-reg-cancel" style="background:none;border:none;color:var(--dim, #444);font-family:inherit;font-size:0.85em;cursor:pointer">${t('audience.dismiss')}</button>
        <span id="praxis-reg-status" style="color:var(--dim, #444);font-size:0.85em;margin-left:auto"></span>
      </div>
    `

    overlay.appendChild(dialog)
    document.body.appendChild(overlay)

    const handleInput = document.getElementById('praxis-reg-handle')
    const handleStatus = document.getElementById('praxis-reg-handle-status')
    const submitBtn = document.getElementById('praxis-reg-submit')
    const cancelBtn = document.getElementById('praxis-reg-cancel')
    const statusEl = document.getElementById('praxis-reg-status')

    let resolved = false
    let txInProgress = false
    function cleanup(result) {
      if (resolved) return
      if (txInProgress) return
      resolved = true
      overlay.remove()
      document.removeEventListener('keydown', onKey)
      resolve(result)
    }

    // close on overlay click (not dialog)
    overlay.addEventListener('click', e => {
      if (e.target === overlay) cleanup(null)
    })

    // cancel
    cancelBtn.addEventListener('click', () => cleanup(null))

    // escape key
    function onKey(e) { if (e.key === 'Escape') { cleanup(null) } }
    document.addEventListener('keydown', onKey)

    // debounced handle availability check
    let checkTimeout = null
    let handleAvail = false
    function updateSubmitState() {
      const canSubmit = handleAvail && !txInProgress
      submitBtn.disabled = !canSubmit
      submitBtn.style.opacity = canSubmit ? '1' : '0.4'
    }
    handleInput.addEventListener('input', () => {
      clearTimeout(checkTimeout)
      handleStatus.textContent = ''
      handleAvail = false
      updateSubmitState()
      const raw = handleInput.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '')
      handleInput.value = raw
      if (raw.length < 3) {
        if (raw.length > 0) handleStatus.textContent = '...'
        return
      }
      checkTimeout = setTimeout(async () => {
        try {
          handleStatus.textContent = '...'
          const available = await publicClient.readContract({
            address: registryAddress,
            abi: REGISTER_ABI,
            functionName: 'handleAvailable',
            args: [raw],
          })
          handleStatus.textContent = available ? '\u2713' : '\u2717'
          handleStatus.style.color = available ? 'var(--green, #4ade80)' : 'var(--red, #ef4444)'
          handleAvail = available
          updateSubmitState()
        } catch {
          handleStatus.textContent = ''
          handleAvail = false
          updateSubmitState()
        }
      }, 300)
    })

    // register
    submitBtn.addEventListener('click', async () => {
      const handle = handleInput.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '')
      if (handle.length < 3 || !handleAvail) return

      txInProgress = true
      statusEl.textContent = t('audience.registering')
      submitBtn.disabled = true
      submitBtn.style.opacity = '0.4'
      cancelBtn.style.display = 'none'

      try {
        if (!await window.ensureOptimism?.()) { submitBtn.textContent = 'join'; submitBtn.style.opacity = ''; cancelBtn.style.display = ''; return }

        // sponsor gas
        const sponsorRes = await fetch('https://ourpraxis.network/orchestrator/sponsor-gas', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wallet: address, handle }),
        }).then(r => r.json()).catch(() => null)

        if (sponsorRes?.sponsored && sponsorRes?.txHash) {
          await publicClient.waitForTransactionReceipt({ hash: sponsorRes.txHash })
        }

        const { createWalletClient, custom, optimism } = await import('./vendor.js')

        const currentAccount = await window.ensureAuthorized?.() || address
        const walletClient = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })
        const hash = await walletClient.writeContract({
          address: registryAddress,
          abi: REGISTER_ABI,
          functionName: 'registerSupporter',
          args: [handle],
          account: currentAccount,
        })

        await publicClient.waitForTransactionReceipt({ hash })

        // set up supporter site (non-fatal, retry after delay for indexer lag)
        const doSetup = () => fetch('https://ourpraxis.network/orchestrator/supporter/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ handle, wallet: address }),
        })
        doSetup().catch(() => setTimeout(() => doSetup().catch(() => {}), 5000))

        // cache registration
        const cacheKey = `praxis-user-${address.toLowerCase()}`
        sessionStorage.setItem(cacheKey, 'supporter')
        sessionStorage.setItem('praxis-audience-checked', '1')

        statusEl.textContent = t('audience.registered')

        function showWelcome(handle) {
          const siteUrl = `${handle}.ourpraxis.network`
          submitBtn.style.display = 'none'
          cancelBtn.style.display = 'none'
          dialog.innerHTML = `
            <div style="text-align:center;padding:1em 0">
              <div style="font-size:1.1em;color:var(--fg, #c0c0c0);margin-bottom:0.75em">welcome to praxis</div>
              <div style="color:var(--dim, #666);font-size:0.85em;margin-bottom:1.25em;line-height:1.5">your site is live at<br><a href="https://${escapeHtml(siteUrl)}" target="_blank" style="color:var(--accent, #00ff41);text-decoration:none;font-size:1.05em">${escapeHtml(siteUrl)}</a></div>
              <div style="color:var(--dim, #555);font-size:0.8em;margin-bottom:1.5em">collect music, video, and art directly from artists.<br>100% of every purchase goes to the creator.</div>
              <button id="praxis-welcome-continue" style="background:none;border:1px solid var(--border, #333);color:var(--fg, #c0c0c0);font-family:inherit;font-size:0.85em;padding:0.5em 2ch;cursor:pointer">continue</button>
            </div>
          `
          document.getElementById('praxis-welcome-continue')?.addEventListener('click', () => {
            txInProgress = false
            cleanup(address)
          })
        }

        const regHandle = handleInput.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '')

        // offer biometric setup if supported and using embedded wallet
        if (window.PublicKeyCredential && !localStorage.getItem('praxis-webauthn-cred') && getWalletProvider()?.isPraxis) {
          submitBtn.style.display = 'none'
          cancelBtn.style.display = 'none'
          statusEl.innerHTML = `
            <span style="color:var(--fg, #c0c0c0)">enable fingerprint / Face ID for transactions?</span>
            <div style="display:flex;gap:1ch;margin-top:0.75em">
              <button id="praxis-bio-yes" style="background:none;border:1px solid var(--border, #333);color:var(--fg, #c0c0c0);font-family:inherit;font-size:0.85em;padding:0.4em 1.5ch;cursor:pointer">yes</button>
              <button id="praxis-bio-skip" style="background:none;border:none;color:var(--dim, #444);font-family:inherit;font-size:0.8em;cursor:pointer">skip</button>
            </div>
          `
          document.getElementById('praxis-bio-yes')?.addEventListener('click', async () => {
            try {
              await window.setupBiometric?.()
            } catch (e) {
              console.warn('biometric setup failed:', e.message)
            }
            showWelcome(regHandle)
          })
          document.getElementById('praxis-bio-skip')?.addEventListener('click', () => {
            showWelcome(regHandle)
          })
          return
        }

        showWelcome(regHandle)
      } catch (e) {
        const msg = e.shortMessage || e.message || ''
        statusEl.textContent = msg.includes('handle taken') ? 'handle taken'
          : msg.includes('already registered') ? 'already registered'
          : msg.includes('User rejected') ? 'cancelled'
          : (msg.slice(0, 60) || 'error')
        txInProgress = false
        cancelBtn.style.display = ''
        updateSubmitState()
      }
    })

    // focus handle input
    setTimeout(() => handleInput.focus(), 100)
  })
}

// MEDIUM-3: `ensureOptimism` is owned by wallet.js and exposed as
// `window.ensureOptimism`. The canonical implementation handles chain
// adding via wallet_addEthereumChain and returns true only on actual
// success. A local export here previously diverged (returned true on
// generic errors, never added the chain) so we removed it. Callers
// should use `window.ensureOptimism()` directly.

// --- Universal buy utility: wallet + chain + balance check + funding sheet fallback ---
// Use this for ANY purchase flow. It ensures the user has a wallet, is on Optimism,
// has enough ETH, and opens the unified funding sheet if balance is insufficient.
// Returns the wallet address if ready, null if user cancelled.
export async function ensureFundsForPurchase(amountWei, statusEl) {
  // 1. ensure wallet connected
  const addr = await ensureWallet()
  if (!addr) return null

  // 2. ensure on Optimism
  const onOptimism = await window.ensureOptimism?.()
  if (!onOptimism) {
    if (statusEl) statusEl.textContent = 'could not connect wallet'
    return null
  }

  // 3. check balance
  const balance = await getCachedBalance(addr)
  if (balance < BigInt(amountWei)) {
    if (statusEl) statusEl.textContent = 'insufficient ETH — opening funding...'

    // open unified funding bottom sheet (lazy-loaded from pay.js)
    let funded = false
    try {
      if (window.showFundingSheet) {
        funded = await window.showFundingSheet(addr, amountWei, { statusEl })
      } else {
        // fallback: lazy-load pay.js which registers window.showFundingSheet
        await import('./pay.js')
        if (window.showFundingSheet) {
          funded = await window.showFundingSheet(addr, amountWei, { statusEl })
        }
      }
    } catch (e) {
      console.warn('funding sheet failed:', e?.message)
    }

    if (!funded) {
      if (statusEl) statusEl.textContent = 'funding cancelled'
      return null
    }

    // re-check balance after funding
    try { sessionStorage.removeItem(`praxis-balance-${addr.toLowerCase()}`) } catch {}
    try { sessionStorage.removeItem(`praxis-multichain-${addr.toLowerCase()}`) } catch {}
    await new Promise(r => setTimeout(r, 2000))
    const newBalance = await getCachedBalance(addr)
    if (newBalance < BigInt(amountWei)) {
      if (statusEl) statusEl.textContent = 'still insufficient ETH'
      return null
    }
  }

  return addr
}

// --- On-demand batch address resolver (replaces global artist fetch) ---
// In-memory LRU-style cache: address → domain, max 2000 entries
const _domainCache = new Map()
const _DOMAIN_CACHE_MAX = 2000

const _DOMAIN_CACHE_TTL = 600000 // L16: 10 minute TTL

const _profilePicCache = new Map()
const _nameCache = new Map()

export function getProfilePic(addr) {
  if (!addr) return null
  const key = addr.toLowerCase()
  const cached = _profilePicCache.get(key)
  if (cached) return cached
  try {
    const val = sessionStorage.getItem(`pfp:${key}`)
    if (val) {
      if (_profilePicCache.size >= _DOMAIN_CACHE_MAX) _profilePicCache.delete(_profilePicCache.keys().next().value)
      _profilePicCache.set(key, val)
      return val
    }
  } catch {}
  return null
}

export function getArtistName(addr) {
  if (!addr) return null
  const key = addr.toLowerCase()
  const cached = _nameCache.get(key)
  if (cached) return cached
  try {
    const val = sessionStorage.getItem(`name:${key}`)
    if (val) {
      if (_nameCache.size >= _DOMAIN_CACHE_MAX) _nameCache.delete(_nameCache.keys().next().value)
      _nameCache.set(key, val)
      return val
    }
  } catch {}
  return null
}

function _domainCacheSet(addr, domain) {
  const key = addr.toLowerCase()
  // evict oldest if at capacity
  if (_domainCache.size >= _DOMAIN_CACHE_MAX && !_domainCache.has(key)) {
    const oldest = _domainCache.keys().next().value
    _domainCache.delete(oldest)
  }
  _domainCache.set(key, { domain, ts: Date.now() })
  // also write to sessionStorage with individual keys
  try { sessionStorage.setItem(`domain:${key}`, domain) } catch {}
}

function _domainCacheGet(addr) {
  const key = addr.toLowerCase()
  if (_domainCache.has(key)) {
    const entry = _domainCache.get(key)
    // L16: check TTL
    if (Date.now() - entry.ts > _DOMAIN_CACHE_TTL) {
      _domainCache.delete(key)
      return undefined
    }
    return entry.domain
  }
  // fallback to sessionStorage
  try {
    const val = sessionStorage.getItem(`domain:${key}`)
    if (val) {
      _domainCache.set(key, { domain: val, ts: Date.now() })
      return val
    }
  } catch {}
  return undefined
}

// Inflight deduplication: key is sorted address list, value is promise
const _inflightResolves = new Map()

/**
 * Resolve an array of addresses to their domains via on-demand batch queries.
 * Returns a plain object { lowercaseAddr: domain } for backward compat with resolveDomain().
 */
export async function resolveAddresses(queryFn, addresses) {
  if (!addresses || addresses.length === 0) return {}

  const unique = [...new Set(addresses.map(a => a.toLowerCase()))]
  const result = {}
  const uncached = []

  for (const addr of unique) {
    const cached = _domainCacheGet(addr)
    if (cached !== undefined) {
      result[addr] = cached
    } else {
      uncached.push(addr)
    }
  }

  if (uncached.length === 0) {
    const needPics = unique.filter(a => !_profilePicCache.has(a) && !sessionStorage.getItem?.(`pfp:${a}`))
    if (needPics.length > 0) {
      try {
        const r = await fetch('/api/artists/resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ addresses: needPics.slice(0, 200) }),
        })
        const data = r.ok ? await r.json() : null
        if (data) {
          for (const [addr, pic] of Object.entries(data.profilePics || {})) {
            const pk = addr.toLowerCase()
            if (_profilePicCache.size >= _DOMAIN_CACHE_MAX) _profilePicCache.delete(_profilePicCache.keys().next().value)
            _profilePicCache.set(pk, pic)
            try { sessionStorage.setItem(`pfp:${pk}`, pic) } catch {}
          }
          for (const [addr, name] of Object.entries(data.names || {})) {
            const nk = addr.toLowerCase()
            if (_nameCache.size >= _DOMAIN_CACHE_MAX) _nameCache.delete(_nameCache.keys().next().value)
            _nameCache.set(nk, name)
            try { sessionStorage.setItem(`name:${nk}`, name) } catch {}
          }
        }
      } catch {}
    }
    return result
  }

  // deduplicate inflight requests: hash sorted address list to a short key
  const sorted = uncached.slice().sort().join(',')
  let h = 0
  for (let i = 0; i < sorted.length; i++) h = (Math.imul(31, h) + sorted.charCodeAt(i)) | 0
  const batchKey = (h >>> 0).toString(16) + ':' + uncached.length
  if (_inflightResolves.has(batchKey)) {
    const inflightResult = await _inflightResolves.get(batchKey)
    Object.assign(result, inflightResult)
    return result
  }

  const promise = (async () => {
    const batchResult = {}
    // Use server-side /api/artists/resolve endpoint (handles both artists + supporters, server-level caching)
    // Chunk into batches of 200 (server max)
    for (let i = 0; i < uncached.length; i += 200) {
      const chunk = uncached.slice(i, i + 200)
      try {
        const res = await fetch('/api/artists/resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ addresses: chunk }),
        })
        if (!res.ok) throw new Error(`resolve ${res.status}`)
        const data = await res.json()
        for (const [addr, domain] of Object.entries(data.addresses || {})) {
          const key = addr.toLowerCase()
          batchResult[key] = domain
          _domainCacheSet(key, domain)
        }
        for (const [addr, pic] of Object.entries(data.profilePics || {})) {
          const pk = addr.toLowerCase()
          _profilePicCache.set(pk, pic)
          try { sessionStorage.setItem(`pfp:${pk}`, pic) } catch {}
          if (_profilePicCache.size > _DOMAIN_CACHE_MAX) {
            _profilePicCache.delete(_profilePicCache.keys().next().value)
          }
        }
        for (const [addr, name] of Object.entries(data.names || {})) {
          const nk = addr.toLowerCase()
          _nameCache.set(nk, name)
          try { sessionStorage.setItem(`name:${nk}`, name) } catch {}
          if (_nameCache.size > _DOMAIN_CACHE_MAX) {
            _nameCache.delete(_nameCache.keys().next().value)
          }
        }
      } catch (e) {
        console.warn('resolveAddresses server error, falling back to direct query:', e)
        // Fallback to direct Ponder query if server endpoint fails
        try {
          const data = await queryFn(
            `query ResolveDomains($ids: [String!]!) { artists(where: { id_in: $ids }, limit: 200) { items { ${F.artist} } } }`,
            { ids: chunk }
          )
          for (const a of (data.artists?.items || [])) {
            const key = a.id.toLowerCase()
            batchResult[key] = a.domain
            _domainCacheSet(key, a.domain)
          }
        } catch (e2) {
          console.warn('resolveAddresses fallback error:', e2)
        }
      }
    }
    return batchResult
  })()

  // M10: only coalesce if under max to prevent unbounded growth
  if (_inflightResolves.size < 100) _inflightResolves.set(batchKey, promise)
  try {
    const batchResult = await promise
    Object.assign(result, batchResult)
  } finally {
    _inflightResolves.delete(batchKey)
  }

  return result
}

/**
 * DEPRECATED — returns empty object. Callers should migrate to resolveAddresses().
 * Kept for backward compat during migration.
 */
export async function getArtistDomains(_queryFn) {
  return {}
}

export function resolveDomain(domainMap, addr) {
  // check in-memory cache first, then fall back to provided map
  const cached = _domainCacheGet(addr)
  if (cached) return cached
  return domainMap[addr.toLowerCase()] || `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

// On-demand single-address resolution using the shared cache
export async function resolveSingleDomain(queryFn, addr) {
  const key = addr.toLowerCase()
  const cached = _domainCacheGet(key)
  if (cached) return cached
  // resolve via batch resolver (single address)
  const result = await resolveAddresses(queryFn, [addr])
  return result[key] || `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

// Paginated fetch of follows for a user, capped to avoid huge _in filters
export async function getAllFollows(queryFn, myAddr, maxResults = 200) {
  const followed = []
  let cursor = null

  while (followed.length < maxResults) {
    const data = await queryFn(`
      query($me: String!, $after: String) {
        follows(where: { follower: $me }, limit: ${Math.min(maxResults, 200)}, after: $after) {
          items { ${F.followOut} }
          ${F.pageInfo}
        }
      }
    `, { me: myAddr, after: cursor })
    for (const f of data.follows.items) {
      followed.push(f.followed.toLowerCase())
    }
    if (!data.follows.pageInfo?.hasNextPage || followed.length >= maxResults) break
    cursor = data.follows.pageInfo.endCursor
  }

  return followed.slice(0, maxResults)
}

// --- Shared pending withdrawals (multicall, cached) ---
import { PRAXIS_ADDR as _PRAXIS_ADDR, PRAXIS_ABI as _PENDING_ABI } from './contracts.js'

export async function getPendingWithdrawals(addr) {
  const addrLower = addr.toLowerCase()
  const mediaAddr = document.body.dataset.media || ''

  // check cache
  const praxisKey = `pending:${_PRAXIS_ADDR}:${addrLower}`
  const mediaKey = mediaAddr ? `pending:${mediaAddr}:${addrLower}` : null
  let praxis = _getCached(praxisKey)
  let media = mediaKey ? _getCached(mediaKey) : null

  if (praxis !== null && (media !== null || !mediaAddr)) {
    return { praxis: BigInt(praxis), media: media !== null ? BigInt(media) : 0n }
  }

  // multicall both contracts
  const pc = await getPublicClient()
  const calls = [{ address: _PRAXIS_ADDR, abi: _PENDING_ABI, functionName: 'pendingWithdrawals', args: [addr] }]
  if (mediaAddr) calls.push({ address: mediaAddr, abi: _PENDING_ABI, functionName: 'pendingWithdrawals', args: [addr] })

  const results = await pc.multicall({ contracts: calls, allowFailure: true })
  const praxisVal = results[0].status === 'success' ? results[0].result : 0n
  const mediaVal = mediaAddr && results[1]?.status === 'success' ? results[1].result : 0n

  _setCache(praxisKey, praxisVal.toString(), _TTL.short)
  if (mediaKey) _setCache(mediaKey, mediaVal.toString(), _TTL.short)

  return { praxis: praxisVal, media: mediaVal }
}

// --- Block/mute users (local, localStorage-based) ---

const BLOCKED_KEY = 'praxis-blocked'

export function getBlockedUsers() {
  try { return JSON.parse(localStorage.getItem(BLOCKED_KEY) || '[]') } catch { return [] }
}

export function blockUser(addr) {
  const blocked = getBlockedUsers()
  if (!blocked.includes(addr.toLowerCase())) {
    blocked.push(addr.toLowerCase())
    localStorage.setItem(BLOCKED_KEY, JSON.stringify(blocked))
  }
}

export function unblockUser(addr) {
  const blocked = getBlockedUsers().filter(a => a !== addr.toLowerCase())
  localStorage.setItem(BLOCKED_KEY, JSON.stringify(blocked))
}

export function isBlocked(addr) {
  return getBlockedUsers().includes(addr?.toLowerCase())
}

// Register a page-specific module for SPA navigation
// Automatically re-checks on spa-navigate events
// Uses a Map to prevent duplicate listeners from accumulating
// Optional `key` parameter allows multiple modules to watch the same element
// without overwriting each other's listeners (defaults to elementId)
const _registeredPages = new Map()
export function registerPage(elementId, initFn, key) {
  const mapKey = key || elementId
  const check = () => { if (document.getElementById(elementId)) initFn() }
  check()
  // replace previous listener for this key to prevent accumulation
  const prev = _registeredPages.get(mapKey)
  if (prev) window.removeEventListener('spa-navigate', prev)
  _registeredPages.set(mapKey, check)
  window.addEventListener('spa-navigate', check)
}

// --- Token name generator: deterministic memorable names from BigInt token IDs ---
const _tokenAdj = [
  'amber','velvet','lunar','coral','ember','crystal','jade','copper','silver','obsidian',
  'arctic','crimson','golden','phantom','shadow','mystic','ancient','cosmic','fading','hollow',
  'silent','woven','drifting','electric','frozen','burning','violet','indigo','scarlet','cerulean',
  'sunken','brazen','tender','vivid','pale','dark','bright','quiet','wild','gentle',
  'bitter','molten','veiled','stark','iron','ashen','dusted','rusted','sunlit','gilded',
  'earthen','spectral','deep','raw','thin','faint','heavy','swift','slow','vast',
]
const _tokenNoun = [
  'echo','prism','orbit','tide','flame','bloom','cipher','spark','relic','crown',
  'veil','pulse','drift','throne','grove','vault','haze','wave','storm','mirror',
  'shard','forge','dust','stone','light','depth','root','seed','wind','shore',
  'glyph','hymn','moth','arc','bell','knot','loom','reef','moss','dusk',
  'dawn','rift','plume','ink','bone','field','well','path','gate','rim',
  'fold','thread','grain','ash','spire','den','vale','crest','ledge','brook',
]

/**
 * Convert a BigInt token ID to a deterministic, memorable word combination.
 * Returns something like "velvet-prism" or "amber-echo-3" for display in UI.
 */
export function tokenName(tokenId) {
  const id = BigInt(tokenId)
  // simple deterministic hash: mix bits via multiply-and-shift
  // use two different multipliers to get independent indices for adj and noun
  const ADJ_LEN = _tokenAdj.length   // 60
  const NOUN_LEN = _tokenNoun.length  // 60
  const TOTAL_COMBOS = ADJ_LEN * NOUN_LEN // 3600

  // hash the token ID into a manageable number
  // multiply by large primes, take mod — keeps it deterministic
  const h1 = Number(((id * 2654435761n) >> 16n) % BigInt(ADJ_LEN))
  const h2 = Number(((id * 2246822519n) >> 16n) % BigInt(NOUN_LEN))

  const adj = _tokenAdj[Math.abs(h1)]
  const noun = _tokenNoun[Math.abs(h2)]

  // compute a collision suffix: for IDs that map to the same adj+noun pair,
  // this distinguishes them. bucket = which "round" of the 3600-combo space we're in
  const bucket = Number((id % BigInt(TOTAL_COMBOS * 100)) / BigInt(TOTAL_COMBOS))
  if (bucket === 0) return `${adj}-${noun}`
  return `${adj}-${noun}-${bucket}`
}

// --- Bookmark helpers (localStorage-based, shared across library + feed) ---

function _bookmarkStorageKey() {
  const addr = window.getWalletAddress?.()?.toLowerCase() || ''
  return addr ? `praxis:bookmarks:${addr}` : null
}

export function getBookmarks() {
  const key = _bookmarkStorageKey()
  if (!key) return []
  try { return JSON.parse(localStorage.getItem(key) || '[]') } catch { return [] }
}

export function isBookmarked(itemId) {
  return getBookmarks().some(b => b.id === itemId)
}

export function saveBookmark(item) {
  const key = _bookmarkStorageKey()
  if (!key) return
  const bm = getBookmarks()
  if (bm.some(b => b.id === item.id)) return
  bm.push({ ...item, savedAt: Date.now() })
  try { localStorage.setItem(key, JSON.stringify(bm)) } catch {}
  _syncBookmarksToServer(bm)
}

export function removeBookmark(itemId) {
  const key = _bookmarkStorageKey()
  if (!key) return
  const bm = getBookmarks().filter(b => b.id !== itemId)
  try { localStorage.setItem(key, JSON.stringify(bm)) } catch {}
  _syncBookmarksToServer(bm)
}

// push bookmarks to server (encrypted with journal key if session exists)
async function _syncBookmarksToServer(bookmarks) {
  try {
    const token = sessionStorage.getItem('praxis:journal-token') || sessionStorage.getItem('praxis-auth-token')
    if (!token) return
    await fetch('/api/bookmarks', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ data: JSON.stringify(bookmarks) }),
    })
  } catch {}
}

// --- Shared media bottom sheet (used by library + feed) ---

export function openMediaSheet({ url, title, author, itemId }) {
  // Remove existing sheet
  document.getElementById('library-sheet')?.remove()

  const sheet = document.createElement('div')
  sheet.id = 'library-sheet'
  sheet.style.cssText = 'position:fixed;bottom:0;left:0;right:0;top:0;z-index:9000;background:var(--bg,#0a0a0a);overflow-y:auto;transition:transform 0.3s;transform:translateY(100%)'

  // Header: title + author + close button (no save button here)
  const header = `<div style="display:flex;justify-content:space-between;align-items:center;padding:1em 1.5em 0.5em;position:sticky;top:0;background:var(--bg,#0a0a0a);z-index:1">
    <div style="display:flex;align-items:center;gap:1ch">
      <strong style="color:var(--accent)">${escapeHtml(title)}</strong>
      ${author ? `<span style="color:var(--muted);font-size:0.85em"> -- ${escapeHtml(author)}</span>` : ''}
    </div>
    <button id="library-sheet-close" style="background:none;border:none;color:var(--muted);font-size:1.5em;cursor:pointer;padding:0.25em">&times;</button>
  </div>`

  // Save button: fixed bottom-right, always visible even when scrolling
  const saved = itemId && isBookmarked(itemId)
  const saveBtnHtml = window.getWalletAddress?.()
    ? `<button id="library-sheet-save" data-item-id="${itemId || ''}" data-title="${escapeHtml(title)}" data-author="${escapeHtml(author || '')}" data-url="${escapeHtml(url)}" style="position:fixed;bottom:calc(1em + env(safe-area-inset-bottom));right:1em;z-index:9001;background:#0a0a0a;border:1px solid ${saved ? 'var(--accent)' : '#333'};color:${saved ? 'var(--accent)' : '#999'};font-family:inherit;font-size:1em;padding:0.5em 1.5ch;cursor:pointer;border-radius:4px;display:flex;align-items:center;gap:0.5ch"><i class="ph ${saved ? 'ph-fill' : ''} ph-bookmark-simple"></i> ${saved ? 'saved' : 'save to collection'}</button>`
    : ''

  sheet.innerHTML = header + '<div id="library-sheet-media" style="padding:0"><span class="praxis-loader" style="display:block;padding:2em;text-align:center"></span></div>' + saveBtnHtml
  document.body.appendChild(sheet)
  requestAnimationFrame(() => { sheet.style.transform = 'translateY(0)' })

  // Render media content
  const container = document.getElementById('library-sheet-media')
  const filename = url.split('/').pop()
  container.innerHTML = renderMedia(url, filename)
  const iframe = container.querySelector('iframe')
  if (iframe) iframe.style.height = 'calc(100vh - 4em)'

  // Close handlers
  const closeSheet = () => {
    sheet.style.transform = 'translateY(100%)'
    setTimeout(() => sheet.remove(), 300)
    // clear ?item= param from URL on close
    const u = new URL(window.location)
    if (u.searchParams.has('item')) {
      u.searchParams.delete('item')
      history.replaceState(null, '', u)
    }
  }
  document.getElementById('library-sheet-close').addEventListener('click', closeSheet)

  // Escape key to close
  const onKey = (e) => {
    if (e.key === 'Escape') { closeSheet(); document.removeEventListener('keydown', onKey) }
  }
  document.addEventListener('keydown', onKey)

  // Save/unsave handler
  document.getElementById('library-sheet-save')?.addEventListener('click', (ev) => {
    const btn = ev.target.closest('#library-sheet-save')
    if (!btn) return
    const id = btn.dataset.itemId
    if (isBookmarked(id)) {
      removeBookmark(id)
      btn.innerHTML = '<i class="ph ph-bookmark-simple"></i> save to collection'
      btn.style.borderColor = 'var(--border)'
      btn.style.color = 'var(--muted)'
    } else {
      saveBookmark({ id, title: btn.dataset.title, author: btn.dataset.author, url: btn.dataset.url })
      btn.innerHTML = '<i class="ph ph-fill ph-bookmark-simple"></i> saved'
      btn.style.borderColor = 'var(--accent)'
      btn.style.color = 'var(--accent)'
    }
  })
}

export function formatTxError(e) {
  if (e.code === 4001) return 'cancelled'
  const msg = e.shortMessage || e.message || 'unknown error'
  if (msg.includes('insufficient funds')) return 'insufficient ETH for gas'
  if (msg.includes('user rejected')) return 'cancelled'
  if (msg.includes('not registered')) return 'wallet not registered in the network'
  return msg.length > 80 ? msg.slice(0, 80) + '...' : msg
}

// --- Batch content-type resolution (server-side, persistent cache) ---
const _ctCache = new Map() // cid -> contentType (client-side session cache)
const CT_CACHE_MAX = 500

export async function resolveContentTypes(cids) {
  const unknown = cids.filter(c => !_ctCache.has(c))
  if (unknown.length > 0) {
    try {
      const res = await fetch('/api/content-types', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(unknown.slice(0, 50)),
      })
      if (res.ok) {
        const data = await res.json()
        for (const [cid, ct] of Object.entries(data)) {
          if (_ctCache.size >= CT_CACHE_MAX) _ctCache.delete(_ctCache.keys().next().value)
          _ctCache.set(cid, ct)
        }
      }
    } catch {}
  }
  const result = {}
  for (const cid of cids) result[cid] = _ctCache.get(cid) || ''
  return result
}

// --- Bounded LRU helper ---
// Delete-then-set bump pattern so Map insertion order tracks recency.
// Shared by messages.js, wallet.js, and any module needing bounded Maps.
export function boundedSet(map, key, value, cap = 500) {
  if (map.has(key)) map.delete(key)
  else if (map.size >= cap) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
  map.set(key, value)
}

export function unpackLocation(packed) {
  if (!packed || packed === '0' || packed === 0n) return null
  const val = BigInt(packed)
  if (val === 0n) return null
  const lngRaw = val & ((1n << 64n) - 1n)
  const latRaw = val >> 64n
  let lat = latRaw >= (1n << 63n) ? Number(latRaw - (1n << 64n)) : Number(latRaw)
  let lng = lngRaw >= (1n << 63n) ? Number(lngRaw - (1n << 64n)) : Number(lngRaw)
  lat = lat / 1e7
  lng = lng / 1e7
  if (lat === 0 && lng === 0) return null
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
  return { lat, lng }
}

export function classifyContentType(ct, title) {
  if (ct) {
    const lower = ct.toLowerCase()
    if (lower.startsWith('audio/') || lower === 'application/ogg') return 'audio'
    if (lower.startsWith('video/')) return 'video'
    if (lower.startsWith('image/')) return 'image'
    if (lower === 'application/pdf') return 'pdf'
    if (lower.startsWith('text/')) return 'text'
  }
  if (title) {
    const t = title.toLowerCase()
    if (/\.(mp4|mov|webm|avi|mkv)$/.test(t)) return 'video'
    if (/\.(mp3|wav|flac|aac|ogg|m4a)$/.test(t)) return 'audio'
    if (/\.(jpg|jpeg|png|gif|webp|svg)$/.test(t)) return 'image'
    if (/\.(pdf|txt|doc|epub)$/.test(t)) return 'text'
  }
  return 'other'
}

export function slugify(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'untitled'
}

export function mediaUrl(type, item, mod) {
  if (type === 'music') {
    const aliasSlug = slugify(item.aliasName)
    const albumSlug = slugify(item.albumTitle)
    return `/music/${aliasSlug}/${albumSlug}`
  }
  return `/${type}/${slugify(item.title)}`
}

export function mediaUrlHtml(type, item, mod) {
  return escapeHtml(mediaUrl(type, item, mod))
}
