// Music module — aliases, albums, cover art, tracks with global player, streaming links, label
//
// SECURITY: every interpolation of owner-controlled site.json content (alias
// names, album titles, descriptions, track titles, link URLs, label name,
// etc.) MUST go through esc() before reaching innerHTML. The site renders
// to every visitor so a single unescaped field is stored XSS. Audit cycle 3
// flagged this as HIGH-1 — historically the module was fully unescaped and
// the cycle-2 patch that exposed album.description on click-through made the
// vulnerability newly reachable for any owner.

// Escape HTML special chars. Used for any string written into innerHTML.
function esc(s) {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Validate a URL is safe to use as an `<a href>` target. Rejects javascript:,
// data:, vbscript:, file: and any non-http(s) scheme. Returns the original URL
// if safe, or '#' otherwise. Also escapes the result for HTML attribute use.
function safeUrl(url) {
  if (!url) return '#'
  try {
    const u = new URL(String(url), 'https://placeholder.invalid')
    if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:') {
      return esc(String(url))
    }
  } catch {}
  return '#'
}

function artPlaceholder(title, size = 240) {
  const t = (title || 'untitled').slice(0, 30)
  const escTitle = esc(t)
  const fs = Math.min(18, Math.max(10, Math.floor(size / (t.length * 0.6))))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="width:100%;height:auto"><rect x="4" y="4" width="${size - 8}" height="${size - 8}" fill="none" stroke="var(--accent, #e0e0e0)" stroke-width="1.5"/><text x="${size / 2}" y="${size / 2}" text-anchor="middle" dominant-baseline="central" fill="var(--fg, #ccc)" font-family="monospace" font-size="${fs}">${escTitle}</text></svg>`
}

export default {
  type: 'music',
  label: 'audio',
  route: '/audio',

  renderSection(data) {
    if (!data) return ''
    let html = ''
    const aliases = data.aliases || []

    // Play-all button — flattens every playable track across every alias
    // and album into one queue. Reuses the existing album-play-btn event
    // delegation in player.js (dispatches on .album-play-btn[data-queue]).
    const allTracks = aliases.flatMap(a =>
      (a?.albums || []).flatMap(al =>
        (al?.tracks || []).filter(t => t?.src)
          .map(t => ({ src: t.src, title: t.title, artist: al.artist || a.name, art: al.art || '' }))
      )
    )
    if (allTracks.length > 1) {
      const allQueueData = encodeURIComponent(JSON.stringify(allTracks))
      html += `<div class="music-play-all" style="margin-bottom:1em;display:flex;gap:0.5ch;align-items:center"><button class="album-play-btn" data-queue="${esc(allQueueData)}" style="background:none;border:1px solid var(--accent);color:var(--accent);font-family:inherit;font-size:0.85em;padding:0.3em 1.2ch;cursor:pointer"><i class="ph ph-play"></i> play all (${allTracks.length} tracks)</button><button class="album-queue-btn" data-queue="${esc(allQueueData)}" style="background:none;border:none;color:var(--dim);font-size:1em;cursor:pointer;padding:0.2em" title="add all to queue"><i class="ph ph-plus"></i></button></div>`
    }

    // Flatten all albums across all aliases, preserving alias info
    const flatAlbums = []
    for (let ai = 0; ai < aliases.length; ai++) {
      const alias = aliases[ai]
      if (!alias?.name) continue
      for (let ali = 0; ali < (alias.albums || []).length; ali++) {
        flatAlbums.push({ album: alias.albums[ali], aliasName: alias.name, ai, ali })
      }
    }

    // Group by section if any album has a section field.
    // Section order is derived from first appearance in album order.
    const hasSections = flatAlbums.some(fa => fa.album.section)
    const sectionOrder = []
    if (hasSections) {
      for (const fa of flatAlbums) {
        const s = fa.album.section
        if (s && !sectionOrder.includes(s)) sectionOrder.push(s)
      }
    }

    function renderAlbum({ album, aliasName, ai, ali }) {
      let out = ''
      const hasTracksOrLinks = (album.tracks?.length > 0) || album.links || album.description
      const albumId = `album-${(aliasName + album.title).replace(/[^a-z0-9]/gi, '-').toLowerCase()}`
      const artDetailUrl = `/art?type=music&amp;alias=${ai}&amp;album=${ali}`
      out += `<div class="album${hasTracksOrLinks ? ' album-clickable' : ''}" data-album-id="${esc(albumId)}">`
      const artThumb = album.art ? `/api/img?url=${encodeURIComponent(album.art)}&w=800` : ''
      out += album.art
        ? `<a href="${artDetailUrl}" style="display:block;cursor:pointer"><img src="${esc(artThumb)}" alt="${esc(album.title)}" loading="lazy" onerror="this.style.display='none'"></a>`
        : `<a href="${artDetailUrl}" style="display:block;cursor:pointer">${artPlaceholder(album.title, 300)}</a>`
      out += `<div class="album-info" style="cursor:${hasTracksOrLinks ? 'pointer' : 'default'}"><span class="album-title" style="color:var(--accent)">${esc(album.title)}</span> <span class="album-year">(${esc(album.year)})</span>`
      if (aliasName !== '_collaborations') out += `<br><span style="color:var(--muted);font-size:0.8em">by ${esc(aliasName)}</span>`
      if (album.collab) out += `<br><span style="color:var(--muted);font-size:0.8em">with <a href="https://${esc(album.collab.from)}" style="color:var(--accent);text-decoration:none">${esc(album.collab.from)}</a></span>`
      if (album.genre) out += `<br><span class="album-genre" style="color:var(--muted);font-size:0.8em">${esc(album.genre)}</span>`
      if (album.producer) out += `<span class="album-producer" style="color:var(--muted);font-size:0.8em">${album.genre ? ' · ' : '<br>'}produced by ${esc(album.producer)}</span>`
      if (hasTracksOrLinks) out += `<br><span style="color:var(--dim);font-size:0.75em"><i class="ph ph-caret-down"></i> tracklist</span>`
      out += `</div>`
      out += `</div>`
      // expandable track list + links
      if (hasTracksOrLinks) {
        out += `<div class="album-detail" id="${esc(albumId)}" style="display:none">`
        // Play album button at top of expanded section
        const expandPlayable = (album.tracks || []).filter(t => t.src)
        if (expandPlayable.length > 0) {
          const expandQueue = encodeURIComponent(JSON.stringify(expandPlayable.map(t => ({ src: t.src, title: t.title, artist: album.artist || aliasName, art: album.art || '' }))))
          out += `<div style="margin-bottom:0.75em;display:flex;gap:0.5ch;align-items:center;flex-wrap:wrap"><button class="album-play-btn" data-queue="${esc(expandQueue)}" style="background:none;border:1px solid var(--accent);color:var(--accent);font-family:inherit;font-size:0.8em;padding:0.25em 1.2ch;cursor:pointer"><i class="ph ph-play"></i> play album</button><button class="album-queue-btn" data-queue="${esc(expandQueue)}" style="background:none;border:none;color:var(--dim);font-size:1em;cursor:pointer;padding:0.2em" title="add album to queue"><i class="ph ph-plus"></i></button>`
          // Buy album button — shows when multiple tracks are listed
          const listedTracks = (album.tracks || []).filter(t => t.mediaId !== undefined && t.mediaId !== null)
          if (listedTracks.length >= 2) {
            const totalWei = listedTracks.reduce((sum, t) => sum + BigInt(t.mediaPrice || '0'), 0n)
            const totalEth = Number(totalWei) / 1e18
            const priceLabel = totalEth > 0 ? `${totalEth} ETH` : 'free'
            const idsJson = esc(JSON.stringify(listedTracks.map(t => t.mediaId)))
            out += `<button class="batch-buy-btn" data-media-ids="${idsJson}" data-total-price="${totalWei.toString()}" data-eth-wei="${totalWei.toString()}" style="background:none;border:1px solid var(--green);color:var(--green);font-family:inherit;font-size:0.8em;padding:0.25em 1.2ch;cursor:pointer">buy album (${priceLabel})</button>`
          }
          out += `</div>`
        }
        if (album.description) out += `<div class="album-description" style="color:var(--fg);font-size:0.9em;margin-bottom:0.75em">${esc(album.description)}</div>`
        if (album.tracks?.length) {
          out += `<div class="album-tracks">`
          for (const track of album.tracks.filter(t => t.title || t.src)) {
            out += `<div class="album-track">`
            out += `<span class="track-title">${esc(track.title)}</span>`
            if (track.duration) {
              const m = Math.floor(track.duration / 60)
              const s = String(track.duration % 60).padStart(2, '0')
              out += ` <span class="track-duration">${m}:${s}</span>`
            } else if (track.src) {
              out += ` <span class="track-duration" data-duration-src="${esc(track.src)}">0:00</span>`
            }
            if (track.src) {
              out += `<button class="track-play-btn" data-track-src="${esc(track.src)}" data-track-title="${esc(track.title)}" data-track-artist="${esc(album.artist || aliasName)}" data-album="${esc(albumId)}">play</button>`
              out += `<button class="track-queue-btn" data-src="${esc(track.src)}" data-title="${esc(track.title)}" data-artist="${esc(album.artist || aliasName)}" data-art="${esc(album.art || '')}" style="background:none;border:none;color:var(--dim);font-size:0.85em;cursor:pointer;padding:0.1em 0.4ch" title="add to queue"><i class="ph ph-plus"></i></button>`
            }
            if (track.mediaId !== undefined && track.mediaId !== null) {
              const priceEth = track.mediaPrice ? (Number(track.mediaPrice) / 1e18) : 0
              const priceLabel = priceEth > 0 ? `${priceEth} ETH` : 'free'
              out += `<button class="track-buy-btn" data-media-id="${esc(track.mediaId)}" data-price="${esc(track.mediaPrice || '0')}" data-eth-wei="${esc(track.mediaPrice || '0')}" style="background:none;border:1px solid var(--green);color:var(--green);font-family:inherit;font-size:0.7em;padding:0.1em 0.6ch;cursor:pointer;margin-left:0.5ch">${priceLabel}</button>`
            }
            out += `</div>`
          }
          out += `</div>`
        }
        if (album.links) {
          out += `<div class="album-links">`
          for (const [platform, url] of Object.entries(album.links)) {
            if (url) out += `<a href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer" class="album-link">${esc(platform)}</a>`
          }
          out += `</div>`
        }
        out += `</div>`
      }
      return out
    }

    if (hasSections) {
      // Render each section with header
      for (const sec of sectionOrder) {
        const sectionAlbums = flatAlbums.filter(fa => fa.album.section === sec)
        if (!sectionAlbums.length) continue
        html += `<div style="color:var(--dim);font-size:0.75em;text-transform:uppercase;letter-spacing:0.1em;margin:1.5em 0 0.75em;border-bottom:1px solid var(--border);padding-bottom:0.3em">${esc(sec)}</div>`
        for (const fa of sectionAlbums) html += renderAlbum(fa)
      }

      // Albums without a section go at the end (no header)
      const unsectioned = flatAlbums.filter(fa => !fa.album.section)
      for (const fa of unsectioned) html += renderAlbum(fa)
    } else {
      // No sections: render flat (backward compatible)
      for (const fa of flatAlbums) html += renderAlbum(fa)
    }
    if (data.label) {
      html += `<p class="label-credit">label: <a href="${safeUrl(data.label.url)}" rel="noopener noreferrer">${esc(data.label.name)}</a></p>`
    }
    // No inline script — album clicks + purchase buttons handled by
    // event delegation in player.js (track-play-btn) and audio-init below
    html += `<script>
    // Use event delegation so it works after SPA navigation.
    // Skip clicks on <a> (album art → detail page, handled by SPA) so
    // the expand toggle doesn't fire alongside navigation.
    if (!window._audioPageDelegated) {
      window._audioPageDelegated = true
      document.addEventListener('click', (e) => {
        if (e.target.closest('a')) return
        const album = e.target.closest('.album-clickable')
        if (album) {
          e.preventDefault()
          const id = album.dataset.albumId
          const detail = document.getElementById(id)
          if (detail) {
            const expanding = detail.style.display === 'none'
            detail.style.display = expanding ? 'block' : 'none'
            // Update caret indicator
            const caret = album.querySelector('.ph-caret-down, .ph-caret-up')
            if (caret) caret.className = expanding ? 'ph ph-caret-up' : 'ph ph-caret-down'
          }
        }
      })
    }
    import('/js/media.js').then(m => m.wireMediaBuyButtons?.())
    // Wire batch buy buttons (buy album / buy collection)
    if (!window._batchBuyDelegated) {
      window._batchBuyDelegated = true
      document.addEventListener('click', async (e) => {
        const btn = e.target.closest('.batch-buy-btn[data-media-ids]')
        if (!btn || btn.disabled) return
        e.stopPropagation()
        try {
          const ids = JSON.parse(btn.dataset.mediaIds)
          const totalPrice = btn.dataset.totalPrice || '0'
          // Check which ones are already owned
          const addr = window.getWalletAddress?.()
          if (addr) {
            const owned = await window._getOwnedMediaIds?.(addr)
            const unownedIds = owned ? ids.filter(id => !owned.has(String(id))) : ids
            if (unownedIds.length === 0) { btn.textContent = 'owned'; btn.disabled = true; return }
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
            const totalEth = Number(btn.dataset.totalPrice || '0') / 1e18
            btn.textContent = 'buy album (' + (totalEth > 0 ? totalEth + ' ETH' : 'free') + ')'
          }, 2000)
        }
      })
      // Mark batch buy buttons as owned on wallet connect
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
    }
    // auto-expand album from URL hash (e.g., /audio#album-name)
    function expandFromHash() {
      const hash = window.location.hash.slice(1)
      if (hash) {
        const detail = document.getElementById(hash)
        if (detail) detail.style.display = 'block'
      }
    }
    expandFromHash()
    window.addEventListener('hashchange', expandFromHash)
    window.addEventListener('spa-navigate', () => setTimeout(expandFromHash, 100))

    // lazy-load track durations from audio metadata (throttled, visibility-aware)
    const _durationQueue = []
    let _durationActive = 0
    const _durationMax = 3
    function _processQueue() {
      while (_durationActive < _durationMax && _durationQueue.length) {
        _durationActive++
        const el = _durationQueue.shift()
        const audio = new Audio()
        audio.preload = 'metadata'
        audio.src = el.dataset.durationSrc
        audio.addEventListener('loadedmetadata', () => {
          const dur = audio.duration
          if (dur && isFinite(dur)) {
            const m = Math.floor(dur / 60)
            const s = String(Math.floor(dur % 60)).padStart(2, '0')
            el.textContent = m + ':' + s
          }
          _durationActive--
          _processQueue()
        })
        audio.addEventListener('error', () => { _durationActive--; _processQueue() })
      }
    }
    function _enqueueDuration(el) {
      if (el._durationLoaded) return
      el._durationLoaded = true
      _durationQueue.push(el)
      _processQueue()
    }
    // observe album-detail visibility to load durations only when expanded
    function loadDurations() {
      const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.querySelectorAll('.track-duration[data-duration-src]').forEach(_enqueueDuration)
            observer.unobserve(entry.target)
          }
        }
      }, { rootMargin: '200px' })
      document.querySelectorAll('.album-detail').forEach(detail => {
        // if already visible (expanded), load immediately
        if (detail.style.display !== 'none') {
          detail.querySelectorAll('.track-duration[data-duration-src]').forEach(_enqueueDuration)
        } else {
          observer.observe(detail)
        }
      })
    }
    loadDurations()
    window.addEventListener('spa-navigate', () => setTimeout(loadDurations, 100))

    </script>`
    return html
  },

  renderCV(data) {
    if (!data) return ''
    return (data.aliases || [])
      .flatMap(a => (a.albums || []).map(al => ({ ...al, alias: a.name })))
      .sort((a, b) => (b.year || 0) - (a.year || 0))
      .map(al => `<div class="cv-item"><span class="cv-title">${esc(al.title)}</span> <span class="cv-detail">-- ${esc(al.alias)}, ${esc(al.year)}</span></div>`)
      .join('\n')
  },

  renderHighlights(data) {
    if (!data) return ''
    const allAlbums = (data.aliases || [])
      .flatMap((a, ai) => (a.albums || []).map((al, ali) => ({ ...al, alias: a.name, aliasIdx: ai, albumIdx: ali, tracks: al.tracks || [] })))

    // Check if any album has a section field
    const hasSections = allAlbums.some(al => al.section)

    function renderCard(al) {
      const playableTracks = al.tracks.filter(t => t.src)
      const firstTrack = playableTracks[0]
      const queueData = encodeURIComponent(JSON.stringify(playableTracks.map(t => ({ src: t.src, title: t.title, artist: al.alias, art: al.art || '' }))))
      const playBtn = firstTrack
        ? `<button class="album-play-btn" data-queue="${esc(queueData)}" style="background:none;border:1px solid var(--border);color:var(--muted);font-family:inherit;font-size:0.7em;padding:0.1em 0.6ch;cursor:pointer;margin-left:0.5ch">play</button>`
        : ''
      const thumbUrl = al.art ? `/api/img?url=${encodeURIComponent(al.art)}&w=480` : ''
      const artUrl = `/art?type=music&amp;alias=${al.aliasIdx}&amp;album=${al.albumIdx}`
      const safeImg = thumbUrl || (al.art ? esc(al.art) : '')
      return `<div class="album album-highlight"><a href="${artUrl}" style="display:block;cursor:pointer"><img src="${safeImg}" alt="${esc(al.title)}" loading="lazy" onerror="this.style.display='none'"></a><div class="album-info"><a href="${artUrl}" style="color:var(--accent);text-decoration:none"><span class="album-title">${esc(al.title)}</span></a> <span class="album-year">(${esc(al.year)})</span>${playBtn}<br><span style="color:var(--muted)">${esc(al.alias)}</span></div></div>`
    }

    if (hasSections) {
      // Group by section, show up to 4 total
      const sectionOrder = []
      for (const al of allAlbums) {
        if (al.section && !sectionOrder.includes(al.section)) sectionOrder.push(al.section)
      }
      let html = ''
      let count = 0
      for (const sec of sectionOrder) {
        if (count >= 4) break
        const sectionAlbums = allAlbums.filter(al => al.section === sec).sort((a, b) => (b.year || 0) - (a.year || 0))
        if (!sectionAlbums.length) continue
        html += `<div style="color:var(--dim);font-size:0.75em;text-transform:uppercase;letter-spacing:0.1em;margin:1em 0 0.5em;border-bottom:1px solid var(--border);padding-bottom:0.3em">${esc(sec)}</div>`
        const cards = sectionAlbums.slice(0, 4 - count).map(renderCard).join('\n')
        html += `<div class="album-highlight-grid">${cards}</div>`
        count += sectionAlbums.slice(0, 4 - count).length
      }
      // Unsectioned at end
      if (count < 4) {
        const unsectioned = allAlbums.filter(al => !al.section).sort((a, b) => (b.year || 0) - (a.year || 0)).slice(0, 4 - count)
        if (unsectioned.length) {
          html += `<div class="album-highlight-grid">${unsectioned.map(renderCard).join('\n')}</div>`
        }
      }
      return html
    }

    // No sections: original behavior
    const recent = allAlbums.sort((a, b) => (b.year || 0) - (a.year || 0)).slice(0, 4)
    const cards = recent.map(renderCard).join('\n')
    return `<div class="album-highlight-grid">${cards}</div>`
  },
}
