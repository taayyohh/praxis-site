// Global persistent audio/video player — fixed bottom bar with unified queue
// Exposes: window.playTrack(), window.pauseTrack(), window.isPlaying(), window.playVideo(), window.addToQueue()

const STORAGE_KEY = 'praxis-player'
const SAVE_INTERVAL = 2000
function _esc(s) { return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') }

// --- Build DOM ---
const bar = document.createElement('div')
bar.id = 'global-player'
bar.style.cssText = `
  position: fixed; bottom: 0; left: 0; right: 0; z-index: 9999;
  height: 48px; background: var(--bg); border-top: 1px solid var(--border);
  display: none; align-items: center; gap: 1ch; padding: 0 2ch;
  padding-bottom: env(safe-area-inset-bottom, 0px);
  font-size: 0.85em; color: var(--fg); font-family: inherit;
`

// controls wrapper: [prev] [play/pause] [next]
const controlsWrap = document.createElement('div')
controlsWrap.style.cssText = 'display:flex;align-items:center;gap:0.25ch;flex-shrink:0'

const prevBtn = document.createElement('button')
prevBtn.id = 'gp-prev'
prevBtn.innerHTML = '<i class="ph ph-skip-back"></i>'
prevBtn.setAttribute('aria-label', 'previous track')
prevBtn.style.cssText = `
  background: none; border: none; color: var(--border); font-size: 1.1em;
  cursor: default; padding: 0.3em; min-width: 44px; min-height: 44px;
  display: flex; align-items: center; justify-content: center;
`

const playBtn = document.createElement('button')
playBtn.id = 'gp-play'
playBtn.innerHTML = '<i class="ph ph-play"></i>'
playBtn.setAttribute('aria-label', 'play')
playBtn.style.cssText = `
  background: rgba(255,255,255,0.1); border: none; border-radius: 50%; color: var(--fg);
  font-size: 1.2em; padding: 0; cursor: pointer;
  width: 44px; height: 44px; display: flex; align-items: center; justify-content: center;
`

const nextBtn = document.createElement('button')
nextBtn.id = 'gp-next'
nextBtn.innerHTML = '<i class="ph ph-skip-forward"></i>'
nextBtn.setAttribute('aria-label', 'next track')
nextBtn.style.cssText = `
  background: none; border: none; color: var(--border); font-size: 1.1em;
  cursor: default; padding: 0.3em; min-width: 44px; min-height: 44px;
  display: flex; align-items: center; justify-content: center;
`

const repeatBtn = document.createElement('button')
repeatBtn.id = 'gp-repeat'
repeatBtn.innerHTML = '<i class="ph ph-repeat"></i>'
repeatBtn.setAttribute('aria-label', 'repeat off')
repeatBtn.title = 'repeat off'
repeatBtn.style.cssText = `
  background: none; border: none; color: var(--border); font-size: 1.1em;
  cursor: pointer; padding: 0.3em; min-width: 44px; min-height: 44px;
  display: flex; align-items: center; justify-content: center;
`

controlsWrap.appendChild(prevBtn)
controlsWrap.appendChild(playBtn)
controlsWrap.appendChild(nextBtn)
controlsWrap.appendChild(repeatBtn)

function updateNavButtons() {
  const hasPrev = _queue.length > 1 && _queueIdx > 0
  const hasNext = _queue.length > 1 && _queueIdx >= 0 && _queueIdx < _queue.length - 1
  prevBtn.style.color = hasPrev ? 'var(--muted)' : 'var(--border)'
  prevBtn.style.cursor = hasPrev ? 'pointer' : 'default'
  prevBtn.style.pointerEvents = hasPrev ? '' : 'none'
  prevBtn.disabled = !hasPrev
  nextBtn.style.color = hasNext ? 'var(--muted)' : 'var(--border)'
  nextBtn.style.cursor = hasNext ? 'pointer' : 'default'
  nextBtn.style.pointerEvents = hasNext ? '' : 'none'
  nextBtn.disabled = !hasNext
}

const titleEl = document.createElement('a')
titleEl.id = 'gp-title'
titleEl.href = '/audio'
titleEl.style.cssText = `
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  max-width: 30ch; flex-shrink: 1; color: var(--accent); text-decoration: none; cursor: pointer;
`

const progressWrap = document.createElement('div')
progressWrap.id = 'gp-progress-wrap'
progressWrap.style.cssText = `
  flex: 1; height: 6px; background: var(--border); cursor: pointer;
  position: relative; min-width: 40px; border-radius: 3px; overflow: hidden;
`

const progressBuffer = document.createElement('div')
progressBuffer.id = 'gp-progress-buffer'
progressBuffer.style.cssText = `
  position: absolute; top: 0; left: 0; height: 100%; background: rgba(255,255,255,0.08);
  width: 0%; border-radius: 3px; transition: width 0.3s ease;
`
progressWrap.appendChild(progressBuffer)

const progressFill = document.createElement('div')
progressFill.id = 'gp-progress-fill'
progressFill.style.cssText = `
  position: absolute; top: 0; left: 0; height: 100%; background: var(--accent, #fff);
  width: 100%; border-radius: 3px; transform: scaleX(0); transform-origin: left;
  will-change: transform;
`
progressWrap.appendChild(progressFill)

const timeEl = document.createElement('span')
timeEl.id = 'gp-time'
timeEl.style.cssText = `
  white-space: nowrap; color: var(--muted); font-size: 0.85em; flex-shrink: 0;
`

// Queue toggle button
const queueBtn = document.createElement('button')
queueBtn.id = 'gp-queue-btn'
queueBtn.innerHTML = '<i class="ph ph-playlist"></i>'
queueBtn.setAttribute('aria-label', 'queue')
queueBtn.title = 'queue'
queueBtn.style.cssText = `
  background: none; border: none; color: var(--dim); font-size: 1.4em;
  cursor: pointer; padding: 0.3em; min-width: 44px; min-height: 44px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
`

bar.appendChild(controlsWrap)
bar.appendChild(titleEl)
bar.appendChild(progressWrap)
bar.appendChild(timeEl)
bar.appendChild(queueBtn)
document.body.appendChild(bar)

// --- Queue sheet (slides in from right with spring animation) ---
const queueSheet = document.createElement('div')
queueSheet.id = 'gp-queue-sheet'
queueSheet.style.cssText = `
  position: fixed; top: 0; right: 0; bottom: 40px; width: min(360px, 85vw);
  background: var(--bg, #0a0a0a); border-left: 1px solid var(--border, #222);
  z-index: 499; display: flex; flex-direction: column; overflow: hidden;
  transform: translateX(100%); transition: transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
`
queueSheet.innerHTML = `
  <div style="display:flex;justify-content:space-between;align-items:center;padding:0.75em 1em;border-bottom:1px solid var(--border,#222);flex-shrink:0">
    <span style="color:var(--fg);font-size:0.9em;font-weight:bold">queue</span>
    <div style="display:flex;gap:0.75ch;align-items:center">
      <button id="gp-queue-clear" style="background:none;border:none;color:var(--dim);font-size:0.75em;cursor:pointer;padding:0.2em 0.5ch">clear</button>
      <button id="gp-queue-close" style="background:none;border:none;color:var(--dim);font-size:1.2em;cursor:pointer">&times;</button>
    </div>
  </div>
  <div id="gp-queue-list" style="flex:1;overflow-y:auto;padding:0.5em 0"></div>
`
document.body.appendChild(queueSheet)

let _queueOpen = false
function toggleQueue() {
  _queueOpen = !_queueOpen
  queueSheet.style.transform = _queueOpen ? 'translateX(0)' : 'translateX(100%)'
  queueBtn.style.color = _queueOpen ? 'var(--accent)' : 'var(--dim)'
  if (_queueOpen) renderQueueList()
}
queueBtn.addEventListener('click', toggleQueue)
queueSheet.querySelector('#gp-queue-close').addEventListener('click', toggleQueue)
queueSheet.querySelector('#gp-queue-clear').addEventListener('click', () => {
  _queue = []; _queueIdx = -1
  audio.pause(); video.pause()
  hideBar(); renderQueueList(); updateNavButtons()
})

function renderQueueList() {
  const list = document.getElementById('gp-queue-list')
  if (!list) return
  if (_queue.length === 0) {
    list.innerHTML = '<div style="color:var(--dim);padding:2em 1em;text-align:center;font-size:0.85em">queue is empty</div>'
    return
  }
  list.innerHTML = _queue.map((item, i) => {
    const isActive = i === _queueIdx
    const isVideo = item.type === 'video'
    const icon = isVideo ? 'ph-film-strip' : 'ph-music-note'
    // If art is already an absolute URL or /api/img, use directly; otherwise wrap
    const artThumb = item.art
      ? (item.art.startsWith('http') || item.art.startsWith('/api/img') ? item.art : `/api/img?url=${encodeURIComponent(item.art)}&w=80`)
      : ''
    return `<div class="gp-queue-item" data-idx="${i}" style="display:flex;align-items:center;gap:0.75ch;padding:0.5em 1em;cursor:pointer;${isActive ? 'background:var(--surface,#111);border-left:2px solid var(--accent)' : 'border-left:2px solid transparent'}">
      ${artThumb ? `<img src="${artThumb}" style="width:36px;height:36px;object-fit:cover;flex-shrink:0;border-radius:2px" loading="lazy">` : `<i class="ph ${icon}" style="font-size:1.2em;color:var(--dim);width:36px;text-align:center;flex-shrink:0"></i>`}
      <div style="flex:1;min-width:0;overflow:hidden">
        <div style="color:${isActive ? 'var(--accent)' : 'var(--fg)'};font-size:0.85em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_esc(item.title) || 'untitled'}</div>
        ${item.artist ? `<div style="color:var(--dim);font-size:0.75em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_esc(item.artist)}</div>` : ''}
      </div>
      <button class="gp-queue-rm" data-idx="${i}" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:0.9em;flex-shrink:0;padding:0.2em">&times;</button>
    </div>`
  }).join('')

  // Click to jump to track
  list.querySelectorAll('.gp-queue-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.gp-queue-rm')) return
      const idx = parseInt(el.dataset.idx)
      _queueIdx = idx
      _playQueueItem(_queue[idx])
      renderQueueList()
    })

    // Drag-and-drop reorder
    el.setAttribute('draggable', 'true')
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', el.dataset.idx)
      el.style.opacity = '0.4'
    })
    el.addEventListener('dragend', () => { el.style.opacity = '1' })
    el.addEventListener('dragover', (e) => {
      e.preventDefault()
      el.style.borderTop = '2px solid var(--accent)'
    })
    el.addEventListener('dragleave', () => { el.style.borderTop = '' })
    el.addEventListener('drop', (e) => {
      e.preventDefault()
      el.style.borderTop = ''
      const fromIdx = parseInt(e.dataTransfer.getData('text/plain'))
      const toIdx = parseInt(el.dataset.idx)
      if (fromIdx === toIdx || isNaN(fromIdx) || isNaN(toIdx)) return
      const [moved] = _queue.splice(fromIdx, 1)
      _queue.splice(toIdx, 0, moved)
      if (_queueIdx === fromIdx) _queueIdx = toIdx
      else if (fromIdx < _queueIdx && toIdx >= _queueIdx) _queueIdx--
      else if (fromIdx > _queueIdx && toIdx <= _queueIdx) _queueIdx++
      renderQueueList()
    })
  })

  // Remove from queue
  list.querySelectorAll('.gp-queue-rm').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const idx = parseInt(btn.dataset.idx)
      _queue.splice(idx, 1)
      if (idx < _queueIdx) _queueIdx--
      else if (idx === _queueIdx) { _queueIdx = Math.min(_queueIdx, _queue.length - 1) }
      renderQueueList()
      updateNavButtons()
    })
  })
}

// --- Audio / Video elements ---
const audio = document.createElement('audio')
audio.preload = 'none'

const video = document.createElement('video')
video.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;'
video.playsInline = true
document.body.appendChild(video)

// --- State ---
let currentSrc = null
let currentTitle = ''
let currentArtist = ''
let currentArt = ''
let saveTimer = null
let activeMediaType = 'audio' // 'audio' or 'video'
let _queue = [] // playlist queue: [{ src, title, artist, art, type:'audio'|'video' }]
let _queueIdx = -1
let _repeatMode = 'off' // 'off' | 'all' | 'one'

function updateRepeatBtn() {
  const labels = { off: 'repeat off', all: 'repeat all', one: 'repeat one' }
  const icons = { off: 'ph-repeat', all: 'ph-repeat', one: 'ph-repeat-once' }
  const colors = { off: 'var(--border)', all: 'var(--accent)', one: 'var(--accent)' }
  repeatBtn.innerHTML = `<i class="ph ${icons[_repeatMode]}"></i>`
  repeatBtn.setAttribute('aria-label', labels[_repeatMode])
  repeatBtn.title = labels[_repeatMode]
  repeatBtn.style.color = colors[_repeatMode]
}

repeatBtn.addEventListener('click', () => {
  _repeatMode = _repeatMode === 'off' ? 'all' : _repeatMode === 'all' ? 'one' : 'off'
  updateRepeatBtn()
})

function fmt(seconds) {
  if (!seconds || !isFinite(seconds)) return '0:00'
  const s = Math.floor(seconds)
  const m = Math.floor(s / 60)
  const sec = s % 60
  return m + ':' + String(sec).padStart(2, '0')
}

function showBar() {
  bar.style.display = 'flex'
  bar.classList.add('active')
  document.body.style.paddingBottom = `calc(48px + env(safe-area-inset-bottom, 0px))`
}

function hideBar() {
  bar.style.display = 'none'
  bar.classList.remove('active')
  document.body.style.paddingBottom = ''
}

function updateTitle() {
  const label = currentArtist ? `${currentTitle} — ${currentArtist}` : currentTitle
  titleEl.textContent = label
  titleEl.title = label
}

function updateTime() {
  const cur = audio.currentTime || 0
  const dur = audio.duration || 0
  timeEl.textContent = `${fmt(cur)} / ${fmt(dur)}`
  // update buffer indicator
  if (audio.buffered.length > 0 && dur > 0) {
    const buffEnd = audio.buffered.end(audio.buffered.length - 1)
    progressBuffer.style.width = ((buffEnd / dur) * 100) + '%'
  }
  if (dur > 0) {
    progressFill.style.transform = 'scaleX(' + (cur / dur) + ')'
  }
}

function saveState() {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
      src: currentSrc,
      title: currentTitle,
      artist: currentArtist,
      currentTime: audio.currentTime || 0,
      playing: !audio.paused
    }))
  } catch {}
}

function clearState() {
  try { sessionStorage.removeItem(STORAGE_KEY) } catch {}
}

function startSaving() {
  stopSaving()
  saveTimer = setInterval(saveState, SAVE_INTERVAL)
}

function stopSaving() {
  if (saveTimer) { clearInterval(saveTimer); saveTimer = null }
}

// --- Player API ---

function playTrack(src, title, artist, art) {
  // pause video if playing
  if (!video.paused) video.pause()
  activeMediaType = 'audio'
  currentSrc = src
  currentTitle = title || ''
  currentArtist = artist || ''
  currentArt = art || ''
  updateTitle()
  audio.src = src
  audio.currentTime = 0
  audio.play().catch(() => {})
  playBtn.innerHTML = '<i class="ph ph-pause"></i>'
  showBar()
  startSaving()
  syncTrackButtons()
  updateMediaSession()
}

// Play a list of tracks starting from a given index
function playQueue(tracks, startIdx) {
  if (!tracks || tracks.length === 0) return
  _queue = tracks.map(t => ({ ...t, type: t.type || 'audio' }))
  _queueIdx = startIdx || 0
  _playQueueItem(_queue[_queueIdx])
}

function _playQueueItem(item) {
  if (!item) return
  if (item.type === 'video') playVideo(item.src, item.title)
  else playTrack(item.src, item.title, item.artist, item.art)
  if (_queueOpen) renderQueueList()
}

function playNext() {
  if (_queue.length === 0) return
  _queueIdx++
  if (_queueIdx >= _queue.length) { _queueIdx = -1; _queue = []; return }
  _playQueueItem(_queue[_queueIdx])
}

function playPrev() {
  if (_queue.length === 0 || _queueIdx <= 0) {
    audio.currentTime = 0
    return
  }
  _queueIdx--
  _playQueueItem(_queue[_queueIdx])
}

// Add a single item to the end of the queue (bounded at 500)
function addToQueue(item, sourceEl) {
  if (_queue.length >= 500) return
  const wasEmpty = !currentSrc && _queueIdx < 0
  _queue.push({ ...item, type: item.type || 'audio' })
  if (_queueOpen) renderQueueList()
  updateNavButtons()

  // If nothing is playing, auto-start the queued item
  if (wasEmpty) {
    _queueIdx = _queue.length - 1
    const entry = _queue[_queueIdx]
    if (!entry.type || entry.type === 'audio') {
      _playQueueItem(entry)
    }
  }

  // Animate artwork from the source element to the queue button
  _animateQueueDrop(sourceEl, item.art)
}

function _animateQueueDrop(sourceEl, artUrl) {
  if (!sourceEl) return
  const rect = sourceEl.getBoundingClientRect()
  const target = document.getElementById('gp-queue-btn')
  const targetRect = target ? target.getBoundingClientRect() : bar.getBoundingClientRect()
  if (targetRect.height === 0 && bar.style.display === 'none') return

  const startX = rect.left + rect.width / 2
  const startY = rect.top + rect.height / 2
  const endX = target ? targetRect.left + targetRect.width / 2 : targetRect.right - 40
  const endY = targetRect.top + targetRect.height / 2
  const startSize = 40
  const endSize = 16

  // Try to find nearby album art for the thumbnail
  let imgSrc = artUrl || ''
  if (!imgSrc) {
    const nearby = sourceEl.closest('.album, .album-detail, [data-album]')
      || sourceEl.closest('section')
      || sourceEl.parentElement
    const img = nearby?.querySelector('img')
    if (img?.src) imgSrc = img.src
  }

  const el = document.createElement('div')
  el.style.cssText = `
    position: fixed; z-index: 9999; pointer-events: none;
    width: ${startSize}px; height: ${startSize}px;
    left: ${startX - startSize / 2}px; top: ${startY - startSize / 2}px;
    border-radius: 4px; overflow: hidden;
    box-shadow: 0 1px 4px rgba(0,0,0,0.2);
    opacity: 1;
  `

  if (imgSrc) {
    const img = document.createElement('img')
    img.src = imgSrc.startsWith('/') ? imgSrc : `/api/img?url=${encodeURIComponent(imgSrc)}&w=80`
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block'
    el.appendChild(img)
  } else {
    el.style.background = 'var(--accent, #fff)'
    el.style.borderRadius = '50%'
    el.style.width = '12px'
    el.style.height = '12px'
    el.style.left = `${startX - 6}px`
    el.style.top = `${startY - 6}px`
    el.style.boxShadow = '0 0 8px var(--accent, #fff)'
  }

  document.body.appendChild(el)

  const midX = (startX + endX) / 2
  const midY = Math.min(startY, endY) - 60
  const duration = 500
  const startTime = performance.now()

  function step(now) {
    const t = Math.min((now - startTime) / duration, 1)
    const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
    const x = (1 - ease) * (1 - ease) * startX + 2 * (1 - ease) * ease * midX + ease * ease * endX
    const y = (1 - ease) * (1 - ease) * startY + 2 * (1 - ease) * ease * midY + ease * ease * endY
    const size = startSize + (endSize - startSize) * ease
    el.style.left = `${x - size / 2}px`
    el.style.top = `${y - size / 2}px`
    el.style.width = `${size}px`
    el.style.height = `${size}px`
    el.style.opacity = String(1 - ease * 0.3)
    if (t < 1) requestAnimationFrame(step)
    else { el.style.opacity = '0'; setTimeout(() => el.remove(), 100) }
  }
  requestAnimationFrame(step)
}

// Media Session API — lock screen / notification controls on mobile
function updateMediaSession() {
  if (!('mediaSession' in navigator)) return
  const artwork = []
  if (currentArt) {
    // currentArt is either:
    //   1. Full absolute URL from img.src (track-play-btn): "https://milesxb.bio/api/img?url=...&w=800"
    //   2. Relative IPFS path from queue data (album play): "/api/ipfs-proxy/Qm..."
    // MediaSession needs absolute URLs. Use the art directly (already sized for display)
    // and provide a resized version for the 96px lock screen icon.
    let absUrl = currentArt
    if (absUrl.startsWith('/')) absUrl = location.origin + absUrl
    // For IPFS paths, route through /api/img for resizing. For already-proxied URLs, use as-is.
    const small = currentArt.includes('/api/img?')
      ? absUrl.replace(/w=\d+/, 'w=256')
      : `${location.origin}/api/img?url=${encodeURIComponent(currentArt)}&w=256`
    artwork.push(
      { src: small, sizes: '256x256', type: 'image/jpeg' },
      { src: absUrl, sizes: '512x512', type: 'image/jpeg' },
    )
  }
  navigator.mediaSession.metadata = new MediaMetadata({
    title: currentTitle || 'untitled',
    artist: currentArtist || '',
    artwork,
  })
  navigator.mediaSession.setActionHandler('play', () => { audio.play().catch(() => {}); startSaving() })
  navigator.mediaSession.setActionHandler('pause', () => { audio.pause(); saveState(); stopSaving() })
  const hasPrev = _queue.length > 1 && _queueIdx > 0
  const hasNext = _queue.length > 1 && _queueIdx >= 0 && _queueIdx < _queue.length - 1
  try { navigator.mediaSession.setActionHandler('previoustrack', hasPrev ? playPrev : null) } catch {}
  try { navigator.mediaSession.setActionHandler('nexttrack', hasNext ? playNext : null) } catch {}
}

function pauseTrack() {
  audio.pause()
  playBtn.innerHTML = '<i class="ph ph-play"></i>'
  saveState()
}

function isPlaying() {
  return !audio.paused
}

async function playVideo(src, title, poster) {
  // pause audio if playing
  if (!audio.paused) audio.pause()
  activeMediaType = 'video'
  currentTitle = title || ''
  currentArtist = ''
  currentArt = poster || ''
  currentSrc = src
  updateTitle()
  // If not already in queue, add as standalone item
  if (!_queue.some(q => q.src === src)) {
    _queue = [{ src, title, art: poster || '', type: 'video' }]
    _queueIdx = 0
  }
  if (_queueOpen) renderQueueList()

  // try to find an inline video on the page with this src and use it directly for PiP
  // this keeps video continuous (no separate hidden element)
  const inlineVideo = document.querySelector(`video[src="${CSS.escape(src)}"]`)
  const targetVideo = inlineVideo || video

  if (!inlineVideo) {
    // no inline video found — use the hidden player element
    video.src = src
  }

  try {
    // on mobile, play inline first (autoplay often blocked without prior interaction)
    targetVideo.muted = false
    targetVideo.playsInline = true
    if (targetVideo.paused) {
      await targetVideo.play().catch(() => {
        // autoplay blocked — show video in a visible container instead
        targetVideo.controls = true
        targetVideo.style.cssText = 'position:fixed;bottom:60px;right:10px;width:200px;height:auto;z-index:9999;border:1px solid var(--border,#333);background:#000;border-radius:4px'
        document.body.appendChild(targetVideo)
        return
      })
    }
  } catch (e) {
    console.warn('[player] video play failed:', e)
  }
  showBar()
  playBtn.innerHTML = '<i class="ph ph-pause"></i>'
}

// --- Events ---

audio.addEventListener('timeupdate', updateTime)
audio.addEventListener('loadedmetadata', updateTime)
audio.addEventListener('durationchange', updateTime)
audio.addEventListener('ended', () => {
  // repeat one — replay same track
  if (_repeatMode === 'one') {
    audio.currentTime = 0
    audio.play().catch(() => {})
    return
  }
  // auto-advance queue
  if (_queue.length > 0 && _queueIdx < _queue.length - 1) {
    playNext()
    return
  }
  // end-of-queue: repeat all wraps back to track 0
  if (_repeatMode === 'all' && _queue.length > 0) {
    _queueIdx = 0
    const track = _queue[0]
    playTrack(track.src, track.title, track.artist)
    return
  }
  playBtn.innerHTML = '<i class="ph ph-play"></i>'
  progressFill.style.transform = 'scaleX(0)'
  stopSaving()
  clearState()
  _queue = []
  _queueIdx = -1
  syncTrackButtons()
})
audio.addEventListener('pause', () => {
  playBtn.innerHTML = '<i class="ph ph-play"></i>'
  playBtn.setAttribute('aria-label', 'play')
  syncTrackButtons()
})
audio.addEventListener('play', () => {
  playBtn.innerHTML = '<i class="ph ph-pause"></i>'
  playBtn.setAttribute('aria-label', 'pause')
  syncTrackButtons()
})

playBtn.addEventListener('click', () => {
  if (activeMediaType === 'video') return // handled by capture-phase listener
  if (audio.paused && audio.src) {
    audio.play().catch(() => {})
    startSaving()
  } else {
    audio.pause()
    saveState()
    stopSaving()
  }
})

prevBtn.addEventListener('click', () => playPrev())
nextBtn.addEventListener('click', () => playNext())

progressWrap.addEventListener('click', (e) => {
  if (activeMediaType === 'video') return // handled by capture-phase listener
  if (!audio.duration) return
  const rect = progressWrap.getBoundingClientRect()
  const ratio = (e.clientX - rect.left) / rect.width
  audio.currentTime = ratio * audio.duration
  updateTime()
})

// --- Sync track buttons in music module ---

function syncTrackButtons() {
  document.querySelectorAll('.track-play-btn[data-track-src]').forEach(btn => {
    if (btn.dataset.trackSrc === currentSrc && !audio.paused) {
      btn.innerHTML = '<i class="ph ph-pause"></i>'
    } else {
      btn.innerHTML = '<i class="ph ph-play"></i>'
    }
  })
  updateNavButtons()
}

// --- Global click delegation for track play buttons ---

document.addEventListener('click', (e) => {
  // single track button
  const btn = e.target.closest('.track-play-btn[data-track-src]')
  if (btn) {
    e.stopPropagation()
    const src = btn.dataset.trackSrc
    const title = btn.dataset.trackTitle || ''
    const artist = btn.dataset.trackArtist || ''
    // Find album art from the nearest album container's img
    const albumEl = btn.closest('.album') || btn.closest('.album-detail')?.previousElementSibling || btn.closest('.audio-item') || btn.closest('.demo-item') || btn.closest('.art-cover')
    const artImg = albumEl?.querySelector('img') || document.querySelector('.art-cover img, .album-art img')
    let art = artImg?.src || ''
    if (currentSrc === src && !audio.paused) {
      pauseTrack()
    } else {
      // Add to queue if not already there, then play
      const inQueue = _queue.some(q => q.src === src)
      if (!inQueue) {
        addToQueue({ src, title, artist, art, type: 'audio' }, btn)
      }
      playTrack(src, title, artist, art)
    }
    return
  }
  // album play button — plays full queue
  const albumBtn = e.target.closest('.album-play-btn[data-queue]')
  if (albumBtn) {
    e.stopPropagation()
    try {
      const raw = albumBtn.dataset.queue
      if (!raw) { console.error('album-play-btn: no queue data'); return }
      const tracks = JSON.parse(decodeURIComponent(raw))
      if (!Array.isArray(tracks) || tracks.length === 0) { console.error('album-play-btn: empty queue'); return }
      if (currentSrc === tracks[0].src && !audio.paused) {
        pauseTrack()
        const icon = albumBtn.querySelector('i')
        if (icon) { icon.className = 'ph ph-play' }
      } else {
        playQueue(tracks, 0)
        const icon = albumBtn.querySelector('i')
        if (icon) { icon.className = 'ph ph-pause' }
      }
    } catch (err) { console.error('album-play-btn error:', err) }
  }
})

// --- Resume from sessionStorage ---

try {
  const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY))
  if (saved && saved.src) {
    currentSrc = saved.src
    currentTitle = saved.title || ''
    currentArtist = saved.artist || ''
    updateTitle()
    audio.src = saved.src
    audio.currentTime = saved.currentTime || 0
    showBar()
    if (saved.playing) {
      audio.play().catch(() => {})
      playBtn.innerHTML = '<i class="ph ph-pause"></i>'
      startSaving()
    } else {
      playBtn.innerHTML = '<i class="ph ph-play"></i>'
    }
    // wait for metadata to update time display
    audio.addEventListener('loadedmetadata', updateTime, { once: true })
  }
} catch {}

// Reset all album-play overlay icons on pause/end
audio.addEventListener('pause', () => {
  document.querySelectorAll('.feed-collected-play-overlay i').forEach(i => { i.className = 'ph ph-play' })
})

// --- Expose API ---

window.playTrack = playTrack
window.playQueue = playQueue
window.pauseTrack = pauseTrack
window.isPlaying = isPlaying
window.playVideo = playVideo
window.addToQueue = addToQueue
window._playerCurrentSrc = () => currentSrc

// --- Video time tracking in bottom bar ---

function updateVideoTime() {
  const cur = video.currentTime || 0
  const dur = video.duration || 0
  timeEl.textContent = `${fmt(cur)} / ${fmt(dur)}`
  if (dur > 0) {
    progressFill.style.transform = 'scaleX(' + (cur / dur) + ')'
  }
}

video.addEventListener('timeupdate', updateVideoTime)
video.addEventListener('loadedmetadata', updateVideoTime)
video.addEventListener('durationchange', updateVideoTime)

// Mini-player handles video overlay now (mini-player.js)

video.addEventListener('ended', () => {
  playBtn.innerHTML = '<i class="ph ph-play"></i>'
  progressFill.style.transform = 'scaleX(0)'
  activeMediaType = 'audio'
})

video.addEventListener('pause', () => {
  if (activeMediaType === 'video') playBtn.textContent = 'play'
})
video.addEventListener('play', () => {
  if (activeMediaType === 'video') playBtn.textContent = 'pause'
})

// Find the current inline video element (for mini-player + bar controls)
function _findActiveVideo() {
  if (currentSrc) {
    // Look for inline video with this src (could be in mini-player container or in page)
    const inline = document.querySelector(`video[src="${CSS.escape(currentSrc)}"]`)
    if (inline && inline !== video) return inline
  }
  return video
}

// capture-phase handler: intercept playBtn click for video before audio handler runs
playBtn.addEventListener('click', (e) => {
  if (activeMediaType === 'video') {
    e.stopImmediatePropagation()
    const v = _findActiveVideo()
    if (v.paused && v.src) {
      v.play().catch(() => {})
    } else {
      v.pause()
    }
  }
}, true) // capture phase so it runs before the audio handler when video is active

// override progressWrap click for video
progressWrap.addEventListener('click', (e) => {
  if (activeMediaType !== 'video') return
  const v = _findActiveVideo()
  if (!v.duration) return
  e.stopImmediatePropagation()
  const rect = progressWrap.getBoundingClientRect()
  const ratio = (e.clientX - rect.left) / rect.width
  v.currentTime = ratio * v.duration
  updateVideoTime()
}, true)

// video-pip-btn delegation removed — mini-player.js handles floating video

// --- Click-to-load lazy video pattern ---
// Creates an inline <video> element so mini-player.js can detect when it scrolls out of view
document.addEventListener('click', (e) => {
  // Video detail links must navigate — skip playback interception
  if (e.target.closest('.video-detail-link')) return
  const lazy = e.target.closest('.video-lazy')
  if (!lazy) return
  const src = lazy.dataset.src
  if (!src) return
  const title = lazy.dataset.title || ''
  const poster = lazy.dataset.poster || ''

  // Create inline video element replacing the lazy placeholder
  const inlineVideo = document.createElement('video')
  inlineVideo.src = src
  inlineVideo.controls = true
  inlineVideo.playsInline = true
  inlineVideo.preload = 'none'
  if (poster) inlineVideo.poster = poster
  inlineVideo.style.cssText = 'width:100%;display:block;background:#000;'
  lazy.replaceWith(inlineVideo)
  inlineVideo.play().catch(() => {})

  // Also register with the bottom bar for time tracking + queue
  if (!audio.paused) audio.pause()
  activeMediaType = 'video'
  currentTitle = title
  currentArtist = ''
  currentArt = poster
  currentSrc = src
  updateTitle()
  if (!_queue.some(q => q.src === src)) {
    _queue = [{ src, title, art: poster, type: 'video' }]
    _queueIdx = 0
  }
  if (_queueOpen) renderQueueList()
  showBar()
  playBtn.innerHTML = '<i class="ph ph-pause"></i>'

  // Sync bar time display with inline video
  const onTime = () => {
    if (activeMediaType !== 'video' || currentSrc !== src) { inlineVideo.removeEventListener('timeupdate', onTime); return }
    const cur = inlineVideo.currentTime || 0
    const dur = inlineVideo.duration || 0
    timeEl.textContent = `${fmt(cur)} / ${fmt(dur)}`
    if (dur > 0) progressFill.style.transform = 'scaleX(' + (cur / dur) + ')'
  }
  inlineVideo.addEventListener('timeupdate', onTime)
  inlineVideo.addEventListener('ended', () => {
    playBtn.innerHTML = '<i class="ph ph-play"></i>'
    progressFill.style.transform = 'scaleX(0)'
    activeMediaType = 'audio'
  })
  inlineVideo.addEventListener('pause', () => {
    if (activeMediaType === 'video' && currentSrc === src) playBtn.innerHTML = '<i class="ph ph-play"></i>'
  })
  inlineVideo.addEventListener('play', () => {
    if (activeMediaType === 'video' && currentSrc === src) playBtn.innerHTML = '<i class="ph ph-pause"></i>'
  })
})

// --- Add-to-queue button delegation (single track) ---
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.track-queue-btn')
  if (!btn) return
  e.stopPropagation()
  addToQueue({
    src: btn.dataset.src,
    title: btn.dataset.title || 'untitled',
    artist: btn.dataset.artist || '',
    art: btn.dataset.art || '',
    type: btn.dataset.type || 'audio',
  }, btn)
  const icon = btn.querySelector('i')
  if (icon) { icon.className = 'ph ph-check'; setTimeout(() => { icon.className = 'ph ph-plus' }, 800) }
})

// --- Add album to queue (all tracks) ---
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.album-queue-btn')
  if (!btn) return
  e.stopPropagation()
  try {
    const tracks = JSON.parse(decodeURIComponent(btn.dataset.queue))
    for (const t of tracks) addToQueue({ ...t, type: t.type || 'audio' }, btn)
    const icon = btn.querySelector('i')
    if (icon) { icon.className = 'ph ph-check'; setTimeout(() => { icon.className = 'ph ph-plus' }, 800) }
  } catch {}
})
