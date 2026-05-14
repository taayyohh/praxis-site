// Gallery module — images, exhibitions, series/collections
// For photographers, painters, sculptors, visual artists
// data: { images: [{ src, title, medium, year, series, description, dimensions, materials, edition, location }], exhibitions: [{ title, venue, year, startDate, endDate, curator, coArtists, url }] }
export default {
  type: 'gallery',
  label: 'visual',
  route: '/visual',

  renderSection(data) {
    if (!data) return ''
    let html = ''

    if (data.images?.length) {
      const PAGE_SIZE = 24
      const sections = data.sections || []

      // Group images by section (preferred) or series (backward compat)
      const sectionMap = new Map() // section/series label -> images[]
      const ungrouped = []
      for (let i = 0; i < data.images.length; i++) {
        const img = { ...data.images[i], _idx: i }
        const groupKey = img.section || img.series
        if (groupKey) {
          if (!sectionMap.has(groupKey)) sectionMap.set(groupKey, [])
          sectionMap.get(groupKey).push(img)
        } else {
          ungrouped.push(img)
        }
      }

      const hasSections = sectionMap.size > 0

      // Filter pills (only if multiple sections exist)
      if (hasSections) {
        html += '<div class="gallery-series-filters" style="display:flex;gap:0.5ch;flex-wrap:wrap;margin-bottom:1.5em">'
        html += `<button class="gallery-series-btn active" data-series="all" style="background:var(--surface);border:1px solid var(--accent);color:var(--accent);font-family:inherit;font-size:0.8em;padding:0.2em 1ch;cursor:pointer">all</button>`
        // If explicit sections defined, use that order; otherwise use natural Map order
        const orderedKeys = sections.length > 0
          ? sections.map(s => s.label).filter(l => sectionMap.has(l))
          : [...sectionMap.keys()]
        for (const name of orderedKeys) {
          html += `<button class="gallery-series-btn" data-series="${escapeAttr(name)}" style="background:none;border:1px solid var(--border);color:var(--muted);font-family:inherit;font-size:0.8em;padding:0.2em 1ch;cursor:pointer">${escapeHtml(name)} (${sectionMap.get(name).length})</button>`
        }
        if (ungrouped.length) {
          html += `<button class="gallery-series-btn" data-series="_ungrouped" style="background:none;border:1px solid var(--border);color:var(--muted);font-family:inherit;font-size:0.8em;padding:0.2em 1ch;cursor:pointer">other (${ungrouped.length})</button>`
        }
        html += '</div>'
      }

      // Ungrouped images go at top (no header) when sections exist
      if (hasSections && ungrouped.length > 0) {
        html += `<div class="gallery-series" data-series-name="_ungrouped">`
        html += '<div class="gallery-grid">'
        for (let i = 0; i < Math.min(ungrouped.length, PAGE_SIZE); i++) {
          html += renderGalleryItem(ungrouped[i])
        }
        html += '</div>'
        if (ungrouped.length > PAGE_SIZE) {
          html += renderLoadMore(ungrouped, PAGE_SIZE, '_ungrouped')
        }
        html += '</div>'
      }

      // Render each section with header
      if (hasSections) {
        const orderedKeys = sections.length > 0
          ? sections.map(s => s.label).filter(l => sectionMap.has(l))
          : [...sectionMap.keys()]
        for (const sectionName of orderedKeys) {
          const images = sectionMap.get(sectionName)
          html += `<div class="gallery-series" data-series-name="${escapeAttr(sectionName)}">`
          html += `<div style="color:var(--dim);font-size:0.75em;text-transform:uppercase;letter-spacing:0.1em;margin:1.5em 0 0.75em;border-bottom:1px solid var(--border);padding-bottom:0.3em">${escapeHtml(sectionName)}`
          // Buy collection button for this section
          const listedInSection = images.filter(img => img.mediaId !== undefined && img.mediaId !== null)
          if (listedInSection.length >= 2) {
            const totalWei = listedInSection.reduce((sum, img) => sum + BigInt(img.mediaPrice || '0'), 0n)
            const totalEth = Number(totalWei) / 1e18
            const priceLabel = totalEth > 0 ? `${totalEth} ETH` : 'free'
            const idsJson = escapeAttr(JSON.stringify(listedInSection.map(img => img.mediaId)))
            html += ` <button class="batch-buy-btn" data-media-ids="${idsJson}" data-total-price="${totalWei.toString()}" data-eth-wei="${totalWei.toString()}" style="background:none;border:1px solid var(--green);color:var(--green);font-family:inherit;font-size:0.85em;padding:0.15em 0.8ch;cursor:pointer;text-transform:none;letter-spacing:normal">buy collection (${priceLabel})</button>`
          }
          html += `</div>`
          html += '<div class="gallery-grid">'
          for (const img of images.slice(0, PAGE_SIZE)) {
            html += renderGalleryItem(img)
          }
          html += '</div>'
          if (images.length > PAGE_SIZE) {
            html += renderLoadMore(images, PAGE_SIZE, sectionName)
          }
          html += '</div>'
        }
      }

      // All images flat if no sections
      if (!hasSections) {
        const allImages = data.images.map((img, i) => ({ ...img, _idx: i }))
        // Buy all button for flat layout
        const allListed = allImages.filter(img => img.mediaId !== undefined && img.mediaId !== null)
        if (allListed.length >= 2) {
          const totalWei = allListed.reduce((sum, img) => sum + BigInt(img.mediaPrice || '0'), 0n)
          const totalEth = Number(totalWei) / 1e18
          const priceLabel = totalEth > 0 ? `${totalEth} ETH` : 'free'
          const idsJson = escapeAttr(JSON.stringify(allListed.map(img => img.mediaId)))
          html += `<div style="margin-bottom:1em"><button class="batch-buy-btn" data-media-ids="${idsJson}" data-total-price="${totalWei.toString()}" data-eth-wei="${totalWei.toString()}" style="background:none;border:1px solid var(--green);color:var(--green);font-family:inherit;font-size:0.85em;padding:0.3em 1.2ch;cursor:pointer">buy all (${priceLabel})</button></div>`
        }
        html += '<div class="gallery-grid">'
        for (let i = 0; i < Math.min(allImages.length, PAGE_SIZE); i++) {
          html += renderGalleryItem(allImages[i])
        }
        html += '</div>'
        if (allImages.length > PAGE_SIZE) {
          html += renderLoadMore(allImages, PAGE_SIZE, '_all')
        }
      }
    }

    if (data.exhibitions?.length) {
      html += '<h3 style="margin-top:2em">exhibitions</h3>'
      for (const ex of data.exhibitions.sort((a, b) => (b.year || 0) - (a.year || 0))) {
        const titleHtml = ex.url ? `<a href="${escapeAttr(ex.url)}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none;border-bottom:1px solid var(--border)">${escapeHtml(ex.title)}</a>` : escapeHtml(ex.title)
        html += `<div class="credit"><span class="credit-title">${titleHtml}</span> <span class="credit-detail">-- ${escapeHtml(ex.venue || '')}${ex.year ? `, ${ex.year}` : ''}</span>`
        if (ex.startDate || ex.endDate) html += `<br><span style="color:var(--muted);font-size:0.85em">${escapeHtml(ex.startDate || '')}${ex.startDate && ex.endDate ? ' — ' : ''}${escapeHtml(ex.endDate || '')}</span>`
        if (ex.curator) html += `<br><span style="color:var(--dim);font-size:0.8em">curated by ${escapeHtml(ex.curator)}</span>`
        if (ex.coArtists) html += `<br><span style="color:var(--dim);font-size:0.8em">with ${escapeHtml(ex.coArtists)}</span>`
        html += `</div>`
      }
    }

    // Wire up series filter buttons + buy buttons + load more + lightbox
    html += `<script>
    (function() {
      // Lightbox handled by /js/gallery-ui.js (loaded as route module via spa.js)

      // Series filter
      document.querySelectorAll('.gallery-series-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
          document.querySelectorAll('.gallery-series-btn').forEach(function(b) {
            b.style.background = 'none'
            b.style.borderColor = 'var(--border)'
            b.style.color = 'var(--muted)'
            b.classList.remove('active')
          })
          btn.style.background = 'var(--surface)'
          btn.style.borderColor = 'var(--accent)'
          btn.style.color = 'var(--accent)'
          btn.classList.add('active')

          var filter = btn.dataset.series
          document.querySelectorAll('.gallery-series').forEach(function(s) {
            if (filter === 'all') {
              s.style.display = ''
            } else {
              s.style.display = s.dataset.seriesName === filter ? '' : 'none'
            }
          })
          // If no series sections (flat grid), show/hide individual items
          if (!document.querySelector('.gallery-series')) {
            document.querySelectorAll('.gallery-grid .gallery-item').forEach(function(item) {
              item.style.display = filter === 'all' ? '' : 'none'
            })
          }
        })
      })

      // Buy button delegation (shared)
      import('/js/media.js').then(function(m) { if (m.wireMediaBuyButtons) m.wireMediaBuyButtons() })
      // Wire batch buy buttons (buy collection)
      if (!window._batchBuyDelegated) {
        window._batchBuyDelegated = true
        document.addEventListener('click', async function(e) {
          var btn = e.target.closest('.batch-buy-btn[data-media-ids]')
          if (!btn || btn.disabled) return
          e.stopPropagation()
          try {
            var ids = JSON.parse(btn.dataset.mediaIds)
            var totalPrice = btn.dataset.totalPrice || '0'
            var addr = window.getWalletAddress && window.getWalletAddress()
            if (addr) {
              var owned = window._getOwnedMediaIds && await window._getOwnedMediaIds(addr)
              if (owned) {
                var unownedIds = ids.filter(function(id) { return !owned.has(String(id)) })
                if (unownedIds.length === 0) { btn.textContent = 'owned'; btn.disabled = true; return }
              }
            }
            btn.textContent = 'confirming...'
            btn.disabled = true
            var mod = await import('/js/media.js')
            await mod.purchaseBatchMedia(ids, totalPrice)
            btn.textContent = 'owned'
            btn.style.borderColor = 'var(--accent)'
            btn.style.color = 'var(--accent)'
          } catch (err) {
            btn.textContent = err.code === 4001 ? 'cancelled' : 'error'
            btn.disabled = false
            setTimeout(function() {
              var totalEth = Number(btn.dataset.totalPrice || '0') / 1e18
              btn.textContent = 'buy collection (' + (totalEth > 0 ? totalEth + ' ETH' : 'free') + ')'
            }, 2000)
          }
        })
        async function checkBatchOwned() {
          var addr = window.getWalletAddress && window.getWalletAddress()
          if (!addr) return
          var owned = window._getOwnedMediaIds && await window._getOwnedMediaIds(addr)
          if (!owned) return
          document.querySelectorAll('.batch-buy-btn[data-media-ids]').forEach(function(btn) {
            try {
              var ids = JSON.parse(btn.dataset.mediaIds)
              if (ids.every(function(id) { return owned.has(String(id)) })) {
                btn.textContent = 'owned'
                btn.style.borderColor = 'var(--accent)'
                btn.style.color = 'var(--accent)'
                btn.disabled = true
              }
            } catch (ex) {}
          })
        }
        checkBatchOwned()
        window.addEventListener('wallet-connected', checkBatchOwned)
        window.addEventListener('spa-navigate', function() { setTimeout(checkBatchOwned, 100) })
      }
    })();
    </script>`
    return html
  },

  renderCV(data) {
    if (!data) return ''
    const items = []
    if (data.exhibitions) {
      for (const ex of data.exhibitions.sort((a, b) => (b.year || 0) - (a.year || 0))) {
        items.push(`<div class="cv-item"><span class="cv-title">${escapeHtml(ex.title)}</span> <span class="cv-detail">-- ${escapeHtml(ex.venue || '')}, ${escapeHtml(String(ex.year || ''))}</span></div>`)
      }
    }
    return items.join('\n')
  },

  renderHighlights(data) {
    if (!data?.images?.length) return ''
    return `<div class="gallery-grid">` + data.images.slice(0, 6).map(img => {
      const thumb = img.src ? `/api/img?url=${encodeURIComponent(img.src)}&w=800` : img.src
      const full = img.src ? `/api/img?url=${encodeURIComponent(img.src)}&w=2400` : img.src
      return `<div class="gallery-item"><img src="${escapeAttr(thumb)}" data-full="${escapeAttr(full)}" data-caption="${escapeAttr(img.title || '')}" alt="${escapeAttr(img.title || '')}" loading="lazy" class="gallery-thumb"></div>`
    }).join('') + `</div>`
  },
}

// --- Helpers ---

function escapeHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function escapeAttr(s) {
  return (s || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function renderGalleryItem(img) {
  const gridThumb = img.src ? `/api/img?url=${encodeURIComponent(img.src)}&w=800` : img.src
  const fullSrc = img.src ? `/api/img?url=${encodeURIComponent(img.src)}&w=2400` : img.src
  const artUrl = `/art?type=gallery&amp;image=${img._idx}`
  const captionText = [escapeHtml(img.title || ''), img.year ? `(${img.year})` : '', img.medium ? escapeHtml(img.medium) : ''].filter(Boolean).join(' ')
  let captionExtra = ''
  if (img.mediaId !== undefined && img.mediaId !== null) {
    const priceEth = img.mediaPrice ? (Number(img.mediaPrice) / 1e18) : 0
    const priceLabel = priceEth > 0 ? `${priceEth} ETH` : 'free'
    captionExtra = ` <button class="track-buy-btn" data-media-id="${img.mediaId}" data-price="${img.mediaPrice || '0'}" data-eth-wei="${img.mediaPrice || '0'}" style="background:none;border:1px solid var(--green);color:var(--green);font-family:inherit;font-size:0.7em;padding:0.1em 0.6ch;cursor:pointer;margin-left:0.5ch">${priceLabel}</button>`
  }
  let captionMeta = ''
  if (img.dimensions || img.materials) captionMeta += `<div style="color:var(--muted);font-size:0.75em">${escapeHtml(img.dimensions || '')}${img.dimensions && img.materials ? ' · ' : ''}${escapeHtml(img.materials || '')}</div>`
  if (img.edition) captionMeta += `<span class="gallery-edition" style="font-size:0.65em;padding:0.1em 0.4ch;border:1px solid var(--border);color:var(--muted)">${escapeHtml(img.edition)}</span> `
  if (img.location) captionMeta += `<div style="color:var(--dim);font-size:0.7em">${escapeHtml(img.location)}</div>`
  if (img.collab) captionMeta += `<div style="color:var(--muted);font-size:0.8em">with <a href="https://${escapeAttr(img.collab.from)}" style="color:var(--accent);text-decoration:none">${escapeHtml(img.collab.from)}</a></div>`
  return `<div class="gallery-item"><img src="${escapeAttr(gridThumb)}" data-full="${escapeAttr(fullSrc)}" data-caption="${escapeAttr(captionText)}" data-art-url="${escapeAttr(artUrl)}" alt="${escapeHtml(img.title || '')}" loading="lazy" class="gallery-thumb"><div class="gallery-caption"><a href="${artUrl}" style="color:inherit;text-decoration:none">${captionText}</a>${captionExtra}${captionMeta}</div></div>`
}

function renderLoadMore(images, pageSize, seriesId) {
  const remaining = images.length - pageSize
  const safeId = (seriesId || '').replace(/[^a-zA-Z0-9_-]/g, '_')
  // Store only src + idx for deferred images (title/year/medium/mediaId/mediaPrice loaded from page data)
  // This keeps the inline payload small — just CIDs and indices instead of full metadata
  const deferredData = JSON.stringify(images.slice(pageSize).map(img => ({
    s: img.src, t: img.title || '', y: img.year, m: img.medium,
    mi: img.mediaId, mp: img.mediaPrice, i: img._idx,
  })))

  return `<button class="gallery-load-more gallery-load-more-${safeId}" data-images="${escapeAttr(deferredData)}" data-page-size="${pageSize}" style="display:block;margin:1em auto;background:none;border:1px solid var(--border);color:var(--fg);font-family:inherit;font-size:0.85em;padding:0.3em 1.5ch;cursor:pointer">load more (${remaining} remaining)</button>
  <script>
  (function() {
    function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
    var btn = document.querySelector('.gallery-load-more-${safeId}');
    if (!btn) return;
    var remaining = JSON.parse(btn.getAttribute('data-images'));
    var pageSize = parseInt(btn.dataset.pageSize, 10);
    var grid = btn.previousElementSibling;
    if (grid && grid.classList.contains('gallery-grid')) {
      var shown = 0;
      btn.addEventListener('click', function() {
        var end = Math.min(shown + pageSize, remaining.length);
        for (var i = shown; i < end; i++) {
          var img = remaining[i];
          var thumb = img.s ? '/api/img?url=' + encodeURIComponent(img.s) + '&w=800' : img.s;
          var artUrl = '/art?type=gallery&amp;image=' + img.i;
          var extra = '';
          if (img.mi !== undefined && img.mi !== null) {
            var pe = img.mp ? (Number(img.mp) / 1e18) : 0;
            var pl = pe > 0 ? pe + ' ETH' : 'free';
            extra = ' <button class="track-buy-btn" data-media-id="' + img.mi + '" data-price="' + (img.mp || '0') + '" data-eth-wei="' + (img.mp || '0') + '" style="background:none;border:1px solid var(--green);color:var(--green);font-family:inherit;font-size:0.7em;padding:0.1em 0.6ch;cursor:pointer;margin-left:0.5ch">' + pl + '</button>';
          }
          var fullSrc = img.s ? '/api/img?url=' + encodeURIComponent(img.s) + '&w=2400' : img.s;
          var captionText = esc(img.t || '') + (img.y ? ' (' + esc(String(img.y)) + ')' : '') + (img.m ? ' -- ' + esc(img.m) : '');
          var div = document.createElement('div');
          div.className = 'gallery-item';
          div.innerHTML = '<img src="' + esc(thumb || '') + '" data-full="' + esc(fullSrc || '') + '" data-caption="' + captionText + '" data-art-url="' + esc(artUrl) + '" alt="' + esc(img.t) + '" loading="lazy" class="gallery-thumb"><div class="gallery-caption"><a href="' + esc(artUrl) + '" style="color:inherit;text-decoration:none">' + captionText + '</a>' + extra + '</div>';
          grid.appendChild(div);
        }
        shown = end;
        if (shown >= remaining.length) btn.style.display = 'none';
        else btn.textContent = 'load more (' + (remaining.length - shown) + ' remaining)';
      });
    }
  })();
  </script>`
}
