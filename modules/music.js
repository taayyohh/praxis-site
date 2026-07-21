// Music module — aliases, albums, cover art, tracks with global player, streaming links, label
//
// SECURITY: every interpolation of owner-controlled site.json content (alias
// names, album titles, descriptions, track titles, link URLs, label name,
// etc.) MUST go through esc() before reaching innerHTML. The site renders
// to every visitor so a single unescaped field is stored XSS. Audit cycle 3
// flagged this as HIGH-1 — historically the module was fully unescaped and
// the cycle-2 patch that exposed album.description on click-through made the
// vulnerability newly reachable for any owner.

import { esc, batchBuyScript, artPlaceholder } from './shared.js'

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

export default {
  type: 'music',
  label: 'audio',
  route: '/audio',

  renderSection(data) {
    if (!data) return ''
    let html = `<style>.album-art-play-overlay { position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); width:48px; height:48px; border-radius:50%; background:rgba(0,0,0,0.6); border:none; color:#fff; font-size:1.2em; cursor:pointer; display:flex; align-items:center; justify-content:center; opacity:0; transition:opacity 0.2s; z-index:2; } div:hover > .album-art-play-overlay, .album-art-play-overlay:focus { opacity:1; } @media (hover:none) { .album-art-play-overlay { opacity:0.85; } } .album img, .album-highlight img { border-radius:4px; }</style>`
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
      html += `<div class="music-play-all" style="margin-bottom:1em;display:flex;gap:0.5ch;align-items:center"><button class="album-queue-btn" data-queue="${esc(allQueueData)}" style="background:none;border:none;color:var(--dim);font-size:1em;cursor:pointer;padding:0.2em" title="add all to queue"><i class="ph ph-plus"></i></button><button class="album-play-btn" data-queue="${esc(allQueueData)}" style="background:none;border:1px solid var(--accent);color:var(--accent);font-family:inherit;font-size:0.85em;padding:0.3em 1.2ch;cursor:pointer"><i class="ph ph-play"></i> play all (${allTracks.length} tracks)</button></div>`
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
      const albumPlayable = (album.tracks || []).filter(t => t.src)
      const albumQueueData = albumPlayable.length > 0 ? encodeURIComponent(JSON.stringify(albumPlayable.map(t => ({ src: t.src, title: t.title, artist: album.artist || aliasName, art: album.art || '' })))) : ''
      const albumPlayOverlay = albumQueueData ? `<button class="album-play-btn album-art-play-overlay" data-queue="${esc(albumQueueData)}"><i class="ph ph-play"></i></button>` : ''
      out += `<div style="position:relative;flex-shrink:0;overflow:hidden;border-radius:4px">`
      out += album.art
        ? `<a href="${artDetailUrl}" style="display:block;cursor:pointer"><img src="${esc(artThumb)}" alt="${esc(album.title)}" loading="lazy" onerror="this.style.display='none'"></a>`
        : `<a href="${artDetailUrl}" style="display:block;cursor:pointer">${artPlaceholder(album.title, 300)}</a>`
      out += albumPlayOverlay + `</div>`
      out += `<div class="album-info" style="cursor:${hasTracksOrLinks ? 'pointer' : 'default'}"><span class="album-title" style="color:var(--accent)">${esc(album.title)}</span> <span class="album-year">(${esc(album.year)})</span>`
      if (aliasName !== '_collaborations') out += `<br><span style="color:var(--muted);font-size:0.8em">by ${esc(album.artist || aliasName)}</span>`
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
          out += `<div style="margin-bottom:0.75em;display:flex;gap:0.5ch;align-items:center;flex-wrap:wrap"><button class="album-queue-btn" data-queue="${esc(expandQueue)}" style="background:none;border:none;color:var(--dim);font-size:1em;cursor:pointer;padding:0.2em" title="add album to queue"><i class="ph ph-plus"></i></button><button class="album-play-btn" data-queue="${esc(expandQueue)}" style="background:none;border:1px solid var(--accent);color:var(--accent);font-family:inherit;font-size:0.8em;padding:0.25em 1.2ch;cursor:pointer"><i class="ph ph-play"></i> play album</button>`
          // Buy album button — shows when multiple tracks are listed
          const listedTracks = (album.tracks || []).filter(t => t.mediaId !== undefined && t.mediaId !== null)
          if (listedTracks.length >= 2) {
            const totalWei = listedTracks.reduce((sum, t) => sum + BigInt(Math.round(Number(t.mediaPrice || '0'))), 0n)
            const totalEth = Number(totalWei) / 1e18
            const idsJson = esc(JSON.stringify(listedTracks.map(t => t.mediaId)))
            out += `<button class="batch-buy-btn feed-card-btn green" data-media-ids="${idsJson}" data-total-price="${totalWei.toString()}" data-eth-wei="${totalWei.toString()}">buy album <span data-eth-wei="${totalWei.toString()}" data-fiat-primary="true"></span></button>`
          }
          out += `</div>`
        }
        if (album.description) out += `<div class="album-description" style="color:var(--fg);font-size:0.9em;margin-bottom:0.75em">${esc(album.description)}</div>`
        if (album.tracks?.length) {
          out += `<div class="album-tracks">`
          for (const track of album.tracks.filter(t => t.title || t.src)) {
            out += `<div class="album-track">`
            const trackLink = track.mediaId != null ? `/art?media=${track.mediaId}` : (track.src ? '#' : '')
            out += trackLink && track.mediaId != null
              ? `<a href="${esc(trackLink)}" class="track-title" style="color:inherit;text-decoration:none">${esc(track.title)}</a>`
              : `<span class="track-title">${esc(track.title)}</span>`
            if (track.duration) {
              const m = Math.floor(track.duration / 60)
              const s = String(track.duration % 60).padStart(2, '0')
              out += ` <span class="track-duration">${m}:${s}</span>`
            } else if (track.src) {
              out += ` <span class="track-duration" data-duration-src="${esc(track.src)}">0:00</span>`
            }
            if (track.src) {
              out += `<button class="track-queue-btn" data-src="${esc(track.src)}" data-title="${esc(track.title)}" data-artist="${esc(album.artist || aliasName)}" data-art="${esc(album.art || '')}" style="background:none;border:none;color:var(--dim);font-size:0.85em;cursor:pointer;padding:0.1em 0.4ch" title="add to queue"><i class="ph ph-plus"></i></button>`
              out += `<button class="track-play-btn feed-card-btn" data-track-src="${esc(track.src)}" data-track-title="${esc(track.title)}" data-track-artist="${esc(album.artist || aliasName)}" data-album="${esc(albumId)}"><i class="ph ph-play"></i></button>`
              // Reference button — opens compose modal with this track as reference
              if (track.mediaId != null) {
                out += `<button class="track-ref-btn" data-ref-media="${track.mediaId}" data-ref-title="${esc(track.title)}" data-ref-artist="${esc(album.artist || aliasName)}" data-ref-art="${esc(album.art || '')}" data-ref-src="${esc(track.src || '')}" title="write about this track" style="background:none;border:1px solid var(--border);color:var(--fg);font-size:0.75em;cursor:pointer;padding:0.15em 0.5ch;border-radius:3px;display:inline-flex;align-items:center"><i class="ph ph-note-pencil"></i></button>`
              }
            }
            if (track.mediaId !== undefined && track.mediaId !== null) {
              out += `<button class="track-buy-btn feed-card-btn green" data-media-id="${esc(track.mediaId)}" data-price="${esc(track.mediaPrice || '0')}" style="font-size:0.7em">buy <span data-eth-wei="${esc(track.mediaPrice || '0')}" data-fiat-primary="true"></span></button>`
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
    ${batchBuyScript('buy album <span data-eth-wei="{ethWei}" data-fiat-primary="true"></span>')}
    // Reference button — opens compose modal with track as reference
    if (!window._trackRefDelegated) {
      window._trackRefDelegated = true
      document.addEventListener('click', (e) => {
        const btn = e.target.closest('.track-ref-btn')
        if (!btn) return
        e.stopPropagation()
        const mediaRef = {
          mediaId: btn.dataset.refMedia,
          title: btn.dataset.refTitle || '',
          artist: btn.dataset.refArtist || '',
          art: btn.dataset.refArt || '',
          src: btn.dataset.refSrc || ''
        }
        const params = new URLSearchParams({ ref: mediaRef.mediaId, refTitle: mediaRef.title, refArtist: mediaRef.artist, refArt: mediaRef.art, refSrc: mediaRef.src })
        window.location.href = '/write?' + params.toString()
      })
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

    // Sync playing state — show pause icon on currently playing track
    function syncPlayingState() {
      const currentSrc = window._playerCurrentSrc?.() || ''
      const playing = window.isPlaying?.() || false
      document.querySelectorAll('.track-play-btn[data-track-src]').forEach(btn => {
        const icon = btn.querySelector('i')
        if (!icon) return
        if (playing && currentSrc && btn.dataset.trackSrc === currentSrc) {
          icon.className = 'ph ph-pause'
        } else {
          icon.className = 'ph ph-play'
        }
      })
    }
    syncPlayingState()
    // Re-sync when page becomes visible or on SPA navigate
    document.addEventListener('visibilitychange', () => { if (!document.hidden) syncPlayingState() })
    window.addEventListener('spa-navigate', () => setTimeout(syncPlayingState, 200))
    // Re-sync periodically (player state changes don't emit events to modules)
    const _syncInterval = setInterval(syncPlayingState, 2000)
    window.addEventListener('spa-navigate', () => clearInterval(_syncInterval), { once: true })

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
    // Ensure overlay CSS is available on highlights page too
    const overlayCss = `<style>.album-art-play-overlay { position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); width:48px; height:48px; border-radius:50%; background:rgba(0,0,0,0.6); border:none; color:#fff; font-size:1.2em; cursor:pointer; display:flex; align-items:center; justify-content:center; opacity:0; transition:opacity 0.2s; z-index:2; } div:hover > .album-art-play-overlay, .album-art-play-overlay:focus { opacity:1; } @media (hover:none) { .album-art-play-overlay { opacity:0.85; } } .album img, .album-highlight img { border-radius:4px; }</style>`
    const allAlbums = (data.aliases || [])
      .flatMap((a, ai) => (a.albums || []).map((al, ali) => ({ ...al, alias: a.name, aliasIdx: ai, albumIdx: ali, tracks: al.tracks || [] })))

    // Check if any album has a section field
    const hasSections = allAlbums.some(al => al.section)

    function renderCard(al) {
      const playableTracks = al.tracks.filter(t => t.src)
      const queueData = encodeURIComponent(JSON.stringify(playableTracks.map(t => ({ src: t.src, title: t.title, artist: al.artist || al.alias, art: al.art || '' }))))
      const playOverlay = playableTracks.length > 0
        ? `<button class="album-play-btn album-art-play-overlay" data-queue="${esc(queueData)}"><i class="ph ph-play"></i></button>`
        : ''
      const thumbUrl = al.art ? `/api/img?url=${encodeURIComponent(al.art)}&w=480` : ''
      const artUrl = `/art?type=music&amp;alias=${al.aliasIdx}&amp;album=${al.albumIdx}`
      const safeImg = thumbUrl || (al.art ? esc(al.art) : '')
      return `<div class="album album-highlight"><div style="position:relative"><a href="${artUrl}" style="display:block;cursor:pointer"><img src="${safeImg}" alt="${esc(al.title)}" loading="lazy" onerror="this.style.display='none'"></a>${playOverlay}</div><div class="album-info"><a href="${artUrl}" style="color:var(--accent);text-decoration:none"><span class="album-title">${esc(al.title)}</span></a> <span class="album-year">(${esc(al.year)})</span><br><span style="color:var(--muted)">${esc(al.artist || al.alias)}</span></div></div>`
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
      return overlayCss + html
    }

    // No sections: original behavior
    const recent = allAlbums.sort((a, b) => (b.year || 0) - (a.year || 0)).slice(0, 4)
    const cards = recent.map(renderCard).join('\n')
    return overlayCss + `<div class="album-highlight-grid">${cards}</div>`
  },
}
