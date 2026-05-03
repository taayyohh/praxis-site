// In-page video mini-player — YouTube-style floating overlay when scrolling past a playing video
// Replaces native browser PiP with a custom overlay that preserves playback state

;(function () {
  let active = null // { video, placeholder, container, observer, scrollTarget }
  const DESKTOP_WIDTH = 300
  const MOBILE_WIDTH = 200
  const EDGE_MARGIN = 16 // 1em approx

  function getPlayerBarHeight() {
    const bar = document.getElementById('global-player')
    if (bar && bar.style.display !== 'none' && bar.offsetHeight > 0) return bar.offsetHeight
    return 0
  }

  function getMiniWidth() {
    return window.innerWidth < 640 ? MOBILE_WIDTH : DESKTOP_WIDTH
  }

  function createMiniPlayer(videoEl) {
    if (active) dismiss(false) // only one at a time

    const parent = videoEl.parentElement
    if (!parent) return

    // Create placeholder to preserve layout
    const placeholder = document.createElement('div')
    placeholder.className = 'mini-player-placeholder'
    placeholder.style.cssText = `width:${videoEl.offsetWidth}px;height:${videoEl.offsetHeight}px;`
    parent.insertBefore(placeholder, videoEl)

    // Create fixed container
    const container = document.createElement('div')
    container.className = 'mini-player-container'
    const w = getMiniWidth()
    const bottom = EDGE_MARGIN + getPlayerBarHeight()
    container.style.cssText = `
      position: fixed;
      bottom: ${bottom}px;
      right: ${EDGE_MARGIN}px;
      width: ${w}px;
      z-index: 500;
      background: #000;
      border: 1px solid var(--border, #333);
      border-radius: 4px;
      overflow: hidden;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5);
      transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s ease;
      transform: scale(0.8) translateY(20px);
      opacity: 0;
      cursor: pointer;
    `

    // Controls overlay
    const controls = document.createElement('div')
    controls.className = 'mini-player-controls'
    controls.style.cssText = `
      position: absolute;
      top: 0; left: 0; right: 0;
      display: flex;
      justify-content: flex-end;
      gap: 4px;
      padding: 4px;
      background: linear-gradient(to bottom, rgba(0,0,0,0.6), transparent);
      z-index: 2;
      opacity: 0;
      transition: opacity 0.2s ease;
    `

    const backBtn = document.createElement('button')
    backBtn.innerHTML = '<i class="ph ph-arrow-square-up-left"></i>'
    backBtn.title = 'back to video'
    backBtn.setAttribute('aria-label', 'back to video')
    backBtn.style.cssText = btnStyle()
    backBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      scrollBack()
    })

    const closeBtn = document.createElement('button')
    closeBtn.innerHTML = '<i class="ph ph-x"></i>'
    closeBtn.title = 'close'
    closeBtn.setAttribute('aria-label', 'close mini player')
    closeBtn.style.cssText = btnStyle()
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      dismiss(true)
    })

    controls.appendChild(backBtn)
    controls.appendChild(closeBtn)
    container.appendChild(controls)

    // Show controls on hover
    container.addEventListener('mouseenter', () => { controls.style.opacity = '1' })
    container.addEventListener('mouseleave', () => { controls.style.opacity = '0' })
    // Always show on touch
    container.addEventListener('touchstart', () => { controls.style.opacity = '1' }, { passive: true })

    // Click container to scroll back
    container.addEventListener('click', () => scrollBack())

    // Move the video element into the container
    videoEl.style.cssText = 'width:100%;height:auto;display:block;'
    container.appendChild(videoEl)
    document.body.appendChild(container)

    // Animate in
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        container.style.transform = 'scale(1) translateY(0)'
        container.style.opacity = '1'
      })
    })

    // Observe placeholder coming back into view
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && active) {
          restore()
        }
      }
    }, { threshold: 0.5 })
    observer.observe(placeholder)

    active = { video: videoEl, placeholder, container, observer, scrollTarget: placeholder }
  }

  function btnStyle() {
    return 'background:rgba(0,0,0,0.5);border:none;color:#fff;font-size:1.1em;cursor:pointer;padding:4px;border-radius:2px;display:flex;align-items:center;justify-content:center;min-width:28px;min-height:28px;'
  }

  function scrollBack() {
    if (!active) return
    // If placeholder is still in DOM, scroll to it
    if (active.placeholder?.isConnected) {
      active.placeholder.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setTimeout(() => { if (active) restore() }, 600)
    } else if (active.sourceUrl) {
      // Placeholder gone (navigated away) — go back to the original page
      const url = active.sourceUrl
      dismiss(false) // don't pause — will restore on arrival
      window.location.href = url
    }
  }

  function restore() {
    if (!active) return
    const { video, placeholder, container, observer } = active
    observer.disconnect()

    // Move video back to its original position
    const parent = placeholder.parentElement
    if (parent) {
      // Restore original video styles
      video.style.cssText = 'max-width:100%;'
      // Restore controls if they were present
      if (!video.hasAttribute('controls')) video.setAttribute('controls', '')
      parent.insertBefore(video, placeholder)
      placeholder.remove()
    }

    // Remove the container
    container.remove()
    active = null
  }

  function dismiss(shouldPause) {
    if (!active) return
    const { video } = active
    if (shouldPause) video.pause()
    restore()
  }

  // --- Observe all playing videos for viewport exit ---
  // Use a single IntersectionObserver for all videos on the page
  let viewportObserver = null
  const trackedVideos = new WeakSet()

  function setupViewportObserver() {
    if (viewportObserver) viewportObserver.disconnect()
    viewportObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const video = entry.target
        // Video left the viewport and is playing — activate mini-player
        if (!entry.isIntersecting && !video.paused && !video.ended && !active) {
          // Don't mini-player the hidden player.js video element
          if (video.closest('#global-player') || video.offsetWidth <= 1) continue
          createMiniPlayer(video)
        }
      }
    }, { threshold: 0.25 })
  }
  setupViewportObserver()

  function trackVideo(video) {
    if (trackedVideos.has(video)) return
    trackedVideos.add(video)
    viewportObserver.observe(video)

    // When video starts playing, pause all other videos and observe this one
    video.addEventListener('play', () => {
      document.querySelectorAll('video').forEach(v => {
        if (v !== video && !v.paused) v.pause()
      })
      if (active && active.video !== video) dismiss(false)
      if (!trackedVideos.has(video)) {
        trackedVideos.add(video)
        viewportObserver.observe(video)
      }
    })

    // When video pauses or ends, dismiss mini-player if it's this video
    video.addEventListener('pause', () => {
      if (active && active.video === video) dismiss(false)
    })
    video.addEventListener('ended', () => {
      if (active && active.video === video) dismiss(false)
    })
  }

  // Scan for videos on the page
  function scanVideos() {
    document.querySelectorAll('video[controls]').forEach(v => {
      // Skip the hidden player.js video
      if (v.offsetWidth <= 1 && v.offsetHeight <= 1) return
      trackVideo(v)
    })
  }

  // Initial scan
  scanVideos()

  // Before SPA navigation: if a video is playing inline (not in mini-player), grab it
  window.addEventListener('spa-before-navigate', () => {
    if (active) return // already in mini-player, keep it
    // Find any playing video in main and activate mini-player before DOM is destroyed
    const main = document.querySelector('main')
    if (!main) return
    const playing = main.querySelector('video')
    if (playing && !playing.paused && !playing.closest('#mini-player-container')) {
      activate(playing)
      if (active) active.sourceUrl = location.pathname + location.search
    }
  })

  // After SPA navigation: keep mini-player alive, just re-scan for new videos
  window.addEventListener('spa-navigate', () => {
    // DON'T dismiss — mini-player persists across navigation
    // Mark that the placeholder is gone (page changed)
    if (active) {
      active.observer?.disconnect()
      if (!active.sourceUrl) active.sourceUrl = location.pathname + location.search
    }
    // Re-scan after DOM settles
    setTimeout(scanVideos, 200)
  })

  // Also scan when new content is dynamically inserted (video-lazy -> video replacement)
  const bodyObserver = new MutationObserver((mutations) => {
    let hasNewVideo = false
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeName === 'VIDEO') { hasNewVideo = true; break }
        if (node.querySelectorAll) {
          const vids = node.querySelectorAll('video[controls]')
          if (vids.length) { hasNewVideo = true; break }
        }
      }
      if (hasNewVideo) break
    }
    if (hasNewVideo) scanVideos()
  })
  bodyObserver.observe(document.body, { childList: true, subtree: true })

  // Update mini-player position when audio player visibility changes
  const playerBar = document.getElementById('global-player')
  if (playerBar) {
    const posObserver = new MutationObserver(() => {
      if (active) {
        const bottom = EDGE_MARGIN + getPlayerBarHeight()
        active.container.style.bottom = bottom + 'px'
      }
    })
    posObserver.observe(playerBar, { attributes: true, attributeFilter: ['style', 'class'] })
  }

  // Handle window resize
  window.addEventListener('resize', () => {
    if (active) {
      active.container.style.width = getMiniWidth() + 'px'
      const bottom = EDGE_MARGIN + getPlayerBarHeight()
      active.container.style.bottom = bottom + 'px'
    }
  })

  // Expose for external use (e.g., player.js video-lazy click handler)
  window._miniPlayerDismiss = () => { if (active) dismiss(true) }
  window._miniPlayerActive = () => !!active
})()
