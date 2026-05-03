// Works for Sale page — shows all PraxisMedia listings by this artist
import { F } from './fragments.js'
import { query } from './ponder.js'
import { ipfsUrl, escapeHtml, formatEthAmount, registerPage, getWalletProvider } from './utils.js'
import { t } from './i18n.js'
import { getArtistMedia, purchaseMedia, annotateRelistings } from './media.js'
import { formatPriceSync, getEthPrices } from './fiat.js'

let _worksInited = false
let _worksLoaded = false
let _cursor = null
let _hasMore = false
let _prices = null
let _activeFilter = 'all'

registerPage('works-page', () => { _worksInited = true; init() })

function init() {
  const statusEl = document.getElementById('works-status')
  const contentEl = document.getElementById('works-content')
  if (!statusEl || !contentEl) return

  _worksLoaded = false

  const ownerAddr = document.body.dataset.owner
  if (!ownerAddr) {
    statusEl.textContent = t('works.empty')
    return
  }

  loadWorks(ownerAddr, statusEl, contentEl)
}

function classifyType(item) {
  const ct = (item.contentType || '').toLowerCase()
  if (ct.startsWith('video/')) return 'video'
  if (ct.startsWith('audio/') || ct === 'application/ogg') return 'audio'
  if (ct.startsWith('image/')) return 'image'
  if (ct.startsWith('application/pdf') || ct.startsWith('text/')) return 'text'
  // guess from CID/title if contentType is empty
  const title = (item.title || '').toLowerCase()
  if (/\.(mp4|mov|webm|avi|mkv)$/i.test(title)) return 'video'
  if (/\.(mp3|wav|flac|aac|ogg|m4a)$/i.test(title)) return 'audio'
  if (/\.(jpg|jpeg|png|gif|webp|svg)$/i.test(title)) return 'image'
  if (/\.(pdf|txt|doc|epub)$/i.test(title)) return 'text'
  return 'other'
}

// Probe IPFS content-type for listings with empty contentType (async, updates UI after detection)
async function probeContentTypes(listings) {
  const probes = listings.filter(item => !item.contentType && item.ipfsCid)
  if (!probes.length) return
  await Promise.all(probes.map(async (item) => {
    try {
      const res = await fetch(`/api/ipfs-proxy/${item.ipfsCid}`, { method: 'HEAD' })
      if (res.ok) {
        const ct = res.headers.get('content-type') || ''
        if (ct) {
          item.contentType = ct
          item._type = classifyType(item)
          // Update the DOM for this item
          const el = document.querySelector(`.works-item[data-media-id="${item.id}"]`)
          if (el) {
            const badge = el.querySelector('span[style*="border"]')
            if (badge) badge.textContent = item._type
            el.dataset.type = item._type
            // Update thumbnail
            const thumbContainer = el.querySelector('div[style*="60px"] a')
            if (thumbContainer && item._type === 'video') {
              thumbContainer.innerHTML = `<img loading="lazy" src="/api/video-thumb?cid=${encodeURIComponent(item.ipfsCid)}" style="width:100%;height:100%;object-fit:cover" onerror="this.outerHTML='<span style=\\'color:var(--dim);font-size:0.7em\\'>video</span>'">`
            } else if (thumbContainer && item._type === 'image') {
              thumbContainer.innerHTML = `<img loading="lazy" src="/api/img?url=${encodeURIComponent('/api/ipfs-proxy/' + item.ipfsCid)}&w=240" style="width:100%;height:100%;object-fit:cover">`
            }
          }
        }
      }
    } catch {}
  }))
}

function typeBadge(type) {
  return `<span style="color:var(--dim);font-size:0.7em;border:1px solid var(--border);padding:0.1em 0.5ch;border-radius:2px;margin-left:0.5ch">${type}</span>`
}

async function loadWorks(artistAddr, statusEl, contentEl) {
  statusEl.textContent = ''
  contentEl.innerHTML = '<div class="praxis-loader"></div>'

  _cursor = null
  const isOwner = window.getWalletAddress?.()?.toLowerCase() === artistAddr.toLowerCase()
  _hasMore = false
  _activeFilter = 'all'

  try {
    const [result, prices, collabData, offChainCollabs] = await Promise.all([
      getArtistMedia(artistAddr),
      getEthPrices(),
      // Also fetch media where this artist is a collaborator
      query(`
        query CollabMedia($artist: String!) {
          mediaCollaborators(where: { artist: $artist }, limit: 100) {
            items { mediaId split }
          }
        }
      `, { artist: artistAddr.toLowerCase() }).catch(() => null),
      // Off-chain collaborations (portfolio item tags)
      fetch(`/api/collaborations?wallet=${artistAddr.toLowerCase()}`).then(r => r.ok ? r.json() : []).catch(() => []),
    ])

    _prices = prices
    _cursor = result.cursor
    _hasMore = result.hasMore

    let listings = result.items || []

    // Fetch full details for collab media and merge with "featured on" label.
    // Collaborators must accept before items show on their works page (anti-spam).
    const _acceptedCollabsKey = `praxis:accepted-collabs:${artistAddr.toLowerCase()}`
    const _dismissedCollabsKey = `praxis:dismissed-collabs:${artistAddr.toLowerCase()}`
    const _acceptedCollabs = new Set(JSON.parse(localStorage.getItem(_acceptedCollabsKey) || '[]'))
    const _dismissedCollabs = new Set(JSON.parse(localStorage.getItem(_dismissedCollabsKey) || '[]'))
    const _pendingCollabs = []
    if (collabData?.mediaCollaborators?.items?.length) {
      const collabItems = collabData.mediaCollaborators.items
      const ownIds = new Set(listings.map(l => String(l.id)))
      const missingIds = collabItems.filter(c => !ownIds.has(String(c.mediaId))).map(c => c.mediaId)
      if (missingIds.length) {
        try {
          const splitMap = {}
          for (const c of collabItems) splitMap[String(c.mediaId)] = c.split
          const collabListings = await Promise.all(missingIds.map(mid =>
            query(`
              query CollabListing($id: BigInt!) {
                mediaListing(id: $id) { ${F.mediaListingFull} }
              }
            `, { id: String(mid) }).then(d => d.mediaListing).catch(() => null)
          ))
          for (const item of collabListings) {
            if (!item) continue
            item._collabSplit = splitMap[String(item.id)]
            item._featuredOn = true
            if (_acceptedCollabs.has(String(item.id))) {
              listings.push(item)
            } else if (!_dismissedCollabs.has(String(item.id))) {
              _pendingCollabs.push(item)
            }
          }
        } catch {}
      }
    }

    // Separate off-chain collabs into pending (for owner) and accepted (for all)
    const _offChainPending = []
    const _offChainAccepted = []
    const _offChainSent = [] // items this artist tagged others on
    if (Array.isArray(offChainCollabs)) {
      for (const c of offChainCollabs) {
        if (c.to === artistAddr.toLowerCase()) {
          if (c.status === 'accepted') _offChainAccepted.push(c)
          else if (c.status === 'pending') _offChainPending.push(c)
        } else if (c.from === artistAddr.toLowerCase() && c.status === 'accepted') {
          _offChainSent.push(c)
        }
      }
    }

    const allPending = [..._pendingCollabs.map(p => ({ ...p, _source: 'onchain' })), ...(isOwner ? _offChainPending.map(p => ({ ...p, _source: 'offchain' })) : [])]
    const hasOffChainContent = _offChainAccepted.length > 0 || (allPending.length > 0 && isOwner)

    if (listings.length === 0 && !_hasMore && !hasOffChainContent) {
      statusEl.textContent = t('works.empty')
      contentEl.innerHTML = ''
      return
    }

    annotateRelistings(listings)
    // Hide superseded relistings AND delisted sentinel-priced items.
    // annotateRelistings tags `delisted = true` for items at the 2^128 sentinel
    // price (set by delistMedia() when totalMinted=0), so they vanish from the
    // public works page entirely instead of rendering as "340282...ETH".
    listings = listings.filter(item => !item.superseded && !item.delisted)

    if (listings.length === 0 && !_hasMore && !hasOffChainContent) {
      statusEl.textContent = t('works.empty')
      contentEl.innerHTML = ''
      return
    }

    // classify types and build filter pills
    for (const item of listings) item._type = classifyType(item)
    const typeCounts = {}
    for (const item of listings) {
      typeCounts[item._type] = (typeCounts[item._type] || 0) + 1
    }

    statusEl.textContent = ''
    let html = ''

    // filter pills (only if more than one type)
    const types = Object.keys(typeCounts).sort()
    if (types.length > 1) {
      html += `<div id="works-filters" style="display:flex;gap:0.5ch;margin-bottom:1.5em;flex-wrap:wrap">`
      html += `<button class="works-filter active" data-filter="all" style="background:var(--surface);border:1px solid var(--accent);color:var(--accent);font-family:inherit;font-size:0.8em;padding:0.3em 1ch;cursor:pointer;border-radius:2px">${t('works.all')} (${listings.length})</button>`
      for (const type of types) {
        html += `<button class="works-filter" data-filter="${type}" style="background:none;border:1px solid var(--border);color:var(--muted);font-family:inherit;font-size:0.8em;padding:0.3em 1ch;cursor:pointer;border-radius:2px">${type} (${typeCounts[type]})</button>`
      }
      html += `</div>`
    }

    // Show all pending collaboration requests for the owner (on-chain + off-chain)
    if (allPending.length > 0 && isOwner) {
      html += `<div id="pending-collabs" style="margin-bottom:1.5em;border:1px solid var(--border);padding:1em">
        <h3 style="color:var(--muted);font-size:0.8em;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:0.75em">${allPending.length} pending collaboration${allPending.length > 1 ? 's' : ''}</h3>`
      for (const item of allPending) {
        if (item._source === 'onchain') {
          html += `<div class="pending-collab" data-media-id="${item.id}" style="display:flex;justify-content:space-between;align-items:center;padding:0.5em 0;border-top:1px solid var(--border)">
            <span style="flex:1"><span style="color:var(--accent)">${escapeHtml(item.title || 'untitled')}</span> <span style="color:var(--dim);font-size:0.85em">by ${escapeHtml(item.artist?.slice(0,6) + '...' + item.artist?.slice(-4))}</span></span>
            <div style="display:flex;gap:0.5ch">
              <button class="buy-btn collab-accept" data-id="${item.id}" style="font-size:0.75em;padding:0.2em 1ch">accept</button>
              <button class="collab-dismiss" data-id="${item.id}" style="background:none;border:1px solid var(--border);color:var(--dim);font-family:inherit;font-size:0.75em;padding:0.2em 1ch;cursor:pointer">dismiss</button>
            </div>
          </div>`
        } else {
          // Off-chain collaboration — uses API for accept/dismiss
          html += `<div class="pending-collab pending-offchain-collab" data-collab-id="${escapeHtml(item.id)}" style="display:flex;justify-content:space-between;align-items:center;padding:0.5em 0;border-top:1px solid var(--border)">
            <span style="flex:1"><span style="color:var(--accent)">${escapeHtml(item.itemTitle || 'untitled')}</span> <span style="color:var(--dim);font-size:0.85em">from <a href="https://${escapeHtml(item.fromDomain)}" target="_blank" style="color:var(--accent)">${escapeHtml(item.fromDomain)}</a></span> <span style="color:var(--dim);font-size:0.75em;border:1px solid var(--border);padding:0.1em 0.5ch;border-radius:2px">${escapeHtml(item.itemType)}</span></span>
            <div style="display:flex;gap:0.5ch">
              <button class="buy-btn offchain-collab-accept" data-collab-id="${escapeHtml(item.id)}" style="font-size:0.75em;padding:0.2em 1ch">accept</button>
              <button class="offchain-collab-dismiss" data-collab-id="${escapeHtml(item.id)}" style="background:none;border:1px solid var(--border);color:var(--dim);font-family:inherit;font-size:0.75em;padding:0.2em 1ch;cursor:pointer">dismiss</button>
            </div>
          </div>`
        }
      }
      html += `</div>`
    }

    // Show accepted off-chain collaborations (visible to everyone)
    if (_offChainAccepted.length > 0) {
      html += `<div id="offchain-accepted" style="margin-bottom:1.5em">
        <h3 style="color:var(--muted);font-size:0.8em;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:0.75em">collaborations</h3>`
      for (const c of _offChainAccepted) {
        html += `<div style="display:flex;justify-content:space-between;align-items:center;padding:0.5em 0;border-top:1px solid var(--border)">
          <span style="flex:1"><span style="color:var(--accent)">${escapeHtml(c.itemTitle || 'untitled')}</span> <span style="color:var(--dim);font-size:0.85em">with <a href="https://${escapeHtml(c.fromDomain)}" target="_blank" style="color:var(--accent)">${escapeHtml(c.fromDomain)}</a></span> <span style="color:var(--dim);font-size:0.75em;border:1px solid var(--border);padding:0.1em 0.5ch;border-radius:2px">${escapeHtml(c.itemType)}</span></span>
        </div>`
      }
      html += `</div>`
    }

    html += '<div id="works-grid">'
    html += renderListings(listings)
    html += '</div>'

    if (_hasMore) {
      html += `<button id="works-load-more" class="buy-btn" style="margin-top:1em;font-size:0.85em;padding:0.4em 1.5ch">${t('works.loadMore')}</button>`
    }

    contentEl.innerHTML = html
    attachBuyHandlers(contentEl)
    attachLoadMore(contentEl, artistAddr)
    attachFilterHandlers(contentEl)

    // Wire on-chain pending collab accept/dismiss buttons (localStorage — these are on-chain facts, UI-only filter)
    contentEl.querySelectorAll('.collab-accept').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id
        _acceptedCollabs.add(id)
        try { localStorage.setItem(_acceptedCollabsKey, JSON.stringify([..._acceptedCollabs])) } catch {}
        btn.closest('.pending-collab')?.remove()
        _worksLoaded = false
        loadWorks()
      })
    })
    contentEl.querySelectorAll('.collab-dismiss').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id
        const dismissKey = `praxis:dismissed-collabs:${artistAddr.toLowerCase()}`
        const dismissed = new Set(JSON.parse(localStorage.getItem(dismissKey) || '[]'))
        dismissed.add(id)
        try { localStorage.setItem(dismissKey, JSON.stringify([...dismissed])) } catch {}
        btn.closest('.pending-collab')?.remove()
      })
    })

    // Wire off-chain collab accept/dismiss buttons (API-backed, persists server-side)
    let _worksAuthToken = ''
    async function getWorksAuthToken() {
      if (_worksAuthToken) return _worksAuthToken
      const addr = window.getWalletAddress?.()
      if (!addr || !getWalletProvider()) throw new Error('wallet not connected')
      await window.ensureAuthorized?.()
      const msg = `admin:${location.hostname}:${Date.now()}`
      const sig = await getWalletProvider().request({ method: 'personal_sign', params: [msg, addr] })
      const authRes = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: addr, signature: sig, message: msg }),
      })
      const authData = await authRes.json()
      if (authData.token) { _worksAuthToken = authData.token; return _worksAuthToken }
      throw new Error(authData.error || 'auth failed')
    }

    contentEl.querySelectorAll('.offchain-collab-accept').forEach(btn => {
      btn.addEventListener('click', async () => {
        const collabId = btn.dataset.collabId
        const origText = btn.textContent
        btn.textContent = 'accepting...'
        btn.disabled = true
        const sibling = btn.parentElement?.querySelector('.offchain-collab-dismiss')
        if (sibling) sibling.disabled = true
        try {
          const token = await getWorksAuthToken()
          const resp = await fetch(`/api/collaborations/${collabId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ status: 'accepted' }),
          })
          if (!resp.ok) {
            if (resp.status === 401) _worksAuthToken = ''
            const err = await resp.json().catch(() => ({}))
            throw new Error(err.error || 'failed')
          }
          // Reload works to show the accepted collab in the grid
          _worksLoaded = false
          loadWorks()
        } catch (e) {
          btn.textContent = e.message || 'error'
          btn.disabled = false
          if (sibling) sibling.disabled = false
          setTimeout(() => { btn.textContent = origText }, 2000)
        }
      })
    })
    contentEl.querySelectorAll('.offchain-collab-dismiss').forEach(btn => {
      btn.addEventListener('click', async () => {
        const collabId = btn.dataset.collabId
        const origText = btn.textContent
        btn.textContent = 'dismissing...'
        btn.disabled = true
        const sibling = btn.parentElement?.querySelector('.offchain-collab-accept')
        if (sibling) sibling.disabled = true
        try {
          const token = await getWorksAuthToken()
          const resp = await fetch(`/api/collaborations/${collabId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ status: 'dismissed' }),
          })
          if (!resp.ok) {
            if (resp.status === 401) _worksAuthToken = ''
            const err = await resp.json().catch(() => ({}))
            throw new Error(err.error || 'failed')
          }
          btn.closest('.pending-offchain-collab')?.remove()
        } catch (e) {
          btn.textContent = e.message || 'error'
          btn.disabled = false
          if (sibling) sibling.disabled = false
          setTimeout(() => { btn.textContent = origText }, 2000)
        }
      })
    })

    // Probe IPFS for content types on listings with empty contentType (updates DOM async)
    probeContentTypes(listings)

  } catch (e) {
    console.warn('works load error:', e)
    statusEl.textContent = t('works.error')
  }
}

function renderListings(listings) {
  let html = ''
  for (const item of listings) {
    const title = escapeHtml(item.title || `#${item.id}`)
    const priceDisplay = formatPriceSync(item.price, _prices)
    const maxSupply = Number(item.maxSupply || 0)
    const totalMinted = Number(item.totalMinted || 0)
    const soldOut = maxSupply > 0 && totalMinted >= maxSupply
    const supplyText = maxSupply === 0
      ? t('works.unlimited')
      : `${totalMinted} / ${maxSupply} ${t('works.minted')}`

    const type = item._type || classifyType(item)
    const artDetailUrl = `/art?media=${item.id}`

    // thumbnail: use metadataCid for images, video-thumb for video, ipfs for audio cover
    let thumbHtml = ''
    const ipfsCidUrl = item.ipfsCid ? ipfsUrl(item.ipfsCid) : ''
    if (type === 'video' && ipfsCidUrl) {
      thumbHtml = `<img loading="lazy" src="/api/video-thumb?cid=${encodeURIComponent(item.ipfsCid)}" style="width:100%;height:100%;object-fit:cover" onerror="this.outerHTML='<span style=\\'color:var(--dim);font-size:0.7em\\'>video</span>'">`
    } else if (type === 'image' && ipfsCidUrl) {
      thumbHtml = `<img loading="lazy" src="/api/img?url=${encodeURIComponent(ipfsCidUrl)}&w=240" style="width:100%;height:100%;object-fit:cover">`
    } else if (item.metadataCid) {
      const coverUrl = ipfsUrl(item.metadataCid)
      thumbHtml = `<img loading="lazy" src="/api/img?url=${encodeURIComponent(coverUrl)}&w=240" style="width:100%;height:100%;object-fit:cover">`
    } else {
      thumbHtml = `<span style="color:var(--dim);font-size:0.7em">${type}</span>`
    }

    html += `<div class="works-item" data-media-id="${item.id}" data-price="${item.price}" data-type="${type}" style="display:flex;gap:1.5ch;padding:1em;border:1px solid var(--border);margin-bottom:0.75em;align-items:center">`

    // thumbnail
    html += `<div style="width:60px;height:60px;background:var(--surface);border:1px solid var(--border);flex-shrink:0;display:flex;align-items:center;justify-content:center;overflow:hidden">
      <a href="${artDetailUrl}">${thumbHtml}</a>
    </div>`

    // info
    html += `<div style="flex:1;min-width:0">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.5ch">
        <span><a href="${artDetailUrl}" style="color:var(--accent);font-size:1em;text-decoration:none">${title}</a>${item._featuredOn ? '<span style="color:var(--muted);font-size:0.7em;border:1px solid var(--border);padding:0.1em 0.5ch;border-radius:2px;margin-left:0.5ch">featured on</span>' : ''}${typeBadge(type)}</span>
        <span style="color:var(--fg);font-size:0.85em">${priceDisplay}</span>
      </div>
      <div style="color:var(--muted);font-size:0.8em;margin-top:0.25em">${supplyText}</div>
      <div style="margin-top:0.5em">`

    if (soldOut) {
      html += `<span style="color:var(--muted);font-size:0.85em">${t('works.soldOut')}</span>`
    } else {
      html += `<button class="buy-btn works-buy-btn" data-media-id="${item.id}" data-price="${item.price}" style="font-size:0.85em;padding:0.3em 1.5ch">${t('works.buy')}</button>`
    }

    html += `</div></div></div>`
  }
  return html
}

function attachFilterHandlers(container) {
  container.querySelectorAll('.works-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.works-filter').forEach(b => {
        b.style.background = 'none'
        b.style.borderColor = 'var(--border)'
        b.style.color = 'var(--muted)'
        b.classList.remove('active')
      })
      btn.style.background = 'var(--surface)'
      btn.style.borderColor = 'var(--accent)'
      btn.style.color = 'var(--accent)'
      btn.classList.add('active')

      _activeFilter = btn.dataset.filter
      const grid = container.querySelector('#works-grid')
      if (!grid) return
      grid.querySelectorAll('.works-item').forEach(item => {
        item.style.display = (_activeFilter === 'all' || item.dataset.type === _activeFilter) ? '' : 'none'
      })
    })
  })
}

function attachBuyHandlers(container) {
  container.querySelectorAll('.works-buy-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const mediaId = btn.dataset.mediaId
      const price = btn.dataset.price
      const origText = btn.textContent
      btn.textContent = t('status.confirming')
      btn.disabled = true

      try {
        await purchaseMedia(mediaId, price)
        btn.textContent = t('works.purchased')
        const item = btn.closest('.works-item')
        if (item) {
          setTimeout(() => {
            const ownerAddr = document.body.dataset.owner
            if (ownerAddr) {
              const statusEl = document.getElementById('works-status')
              const contentEl = document.getElementById('works-content')
              if (statusEl && contentEl) loadWorks(ownerAddr, statusEl, contentEl)
            }
          }, 2000)
        }
      } catch (e) {
        console.warn('purchase error:', e)
        if (e.message?.includes('cancelled') || e.message?.includes('rejected') || e.message?.includes('denied')) {
          btn.textContent = t('status.cancelled')
        } else {
          btn.textContent = origText
        }
        btn.disabled = false
      }
    })
  })
}

function attachLoadMore(container, artistAddr) {
  const loadMoreBtn = container.querySelector('#works-load-more')
  if (!loadMoreBtn) return

  loadMoreBtn.addEventListener('click', async () => {
    if (!_hasMore || !_cursor) return
    loadMoreBtn.textContent = t('works.loading')
    loadMoreBtn.disabled = true

    try {
      const result = await getArtistMedia(artistAddr, _cursor)
      _cursor = result.cursor
      _hasMore = result.hasMore

      let newListings = result.items || []
      annotateRelistings(newListings)
      newListings = newListings.filter(item => !item.superseded && !item.delisted)
      for (const item of newListings) item._type = classifyType(item)

      if (newListings.length > 0) {
        const grid = container.querySelector('#works-grid')
        if (grid) {
          grid.insertAdjacentHTML('beforeend', renderListings(newListings))
          attachBuyHandlers(grid)
          // apply current filter to new items
          if (_activeFilter !== 'all') {
            grid.querySelectorAll('.works-item').forEach(item => {
              item.style.display = item.dataset.type === _activeFilter ? '' : 'none'
            })
          }
        }
      }

      if (_hasMore) {
        loadMoreBtn.textContent = t('works.loadMore')
        loadMoreBtn.disabled = false
      } else {
        loadMoreBtn.remove()
      }
    } catch (e) {
      console.warn('load more works error:', e)
      loadMoreBtn.textContent = t('works.loadMore')
      loadMoreBtn.disabled = false
    }
  })
}
