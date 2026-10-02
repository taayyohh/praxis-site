// Works for Sale page — shows all PraxisMedia listings by this artist
import { F } from './fragments.js'
import { query } from './ponder.js'
import { ipfsUrl, escapeHtml, formatEthAmount, registerPage, getWalletProvider, resolveContentTypes, classifyContentType, getAuthToken } from './utils.js'
import { t } from './i18n.js'
import { getArtistMedia, purchaseMedia, annotateRelistings } from './media.js'
import { formatPriceFiatOnly, getEthPrices } from './fiat.js'
import { renderMediaCard } from './media-card.js'
// feed-cards.js self-registers global .feed-buy-btn / .track-play-btn
// / .album-play-btn delegation on import, so the universal MediaCard's
// buy + play affordances route through the same path as the feed.
import './feed-cards.js'

let _worksInited = false
let _worksLoaded = false
let _cursor = null
let _hasMore = false
let _prices = null
let _activeFilter = 'all'
let _viewMode = 'grouped' // 'grouped' | 'individual'
let _currentListings = [] // cached for re-render on view mode toggle
const _albumArtCache = new Map() // metadataCid -> { artUrl, albumName }
const ALBUM_CACHE_MAX = 200

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
  const type = classifyContentType(item.contentType, item.title)
  return type === 'pdf' ? 'text' : type
}

// Resolve content types server-side for listings with empty contentType, then update DOM
async function resolveAndUpdateContentTypes(listings) {
  const probes = listings.filter(item => !item.contentType && item.ipfsCid)
  if (!probes.length) return
  const cids = probes.map(item => item.ipfsCid)
  const resolved = await resolveContentTypes(cids)
  for (const item of probes) {
    const ct = resolved[item.ipfsCid]
    if (!ct) continue
    item.contentType = ct
    item._type = classifyContentType(ct) === 'pdf' ? 'text' : classifyContentType(ct)
    // Replace the whole card with a freshly-rendered MediaCard so the
    // category, thumb, and actions all come from one code path. Cheap
    // for the handful of items whose contentType was unknown at list
    // time; the server probe fills most of them before response.
    const el = document.querySelector(`.media-card[data-media-id="${item.id}"]`)
    if (el) {
      const tmp = document.createElement('template')
      tmp.innerHTML = renderListings([item]).trim()
      const fresh = tmp.content.firstElementChild
      if (fresh) el.replaceWith(fresh)
    }
  }
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

    // View mode toggle (grouped / individual)
    _currentListings = listings
    html += `<div id="works-view-toggle" style="display:flex;gap:0.5ch;margin-bottom:1em;align-items:center">
      <span style="color:var(--dim);font-size:0.75em;margin-right:0.5ch">view:</span>
      <button class="works-view-btn${_viewMode === 'grouped' ? ' active' : ''}" data-mode="grouped" style="background:${_viewMode === 'grouped' ? 'var(--surface)' : 'none'};border:1px solid ${_viewMode === 'grouped' ? 'var(--accent)' : 'var(--border)'};color:${_viewMode === 'grouped' ? 'var(--accent)' : 'var(--muted)'};font-family:inherit;font-size:0.8em;padding:0.3em 1ch;cursor:pointer;border-radius:2px">releases</button>
      <button class="works-view-btn${_viewMode === 'individual' ? ' active' : ''}" data-mode="individual" style="background:${_viewMode === 'individual' ? 'var(--surface)' : 'none'};border:1px solid ${_viewMode === 'individual' ? 'var(--accent)' : 'var(--border)'};color:${_viewMode === 'individual' ? 'var(--accent)' : 'var(--muted)'};font-family:inherit;font-size:0.8em;padding:0.3em 1ch;cursor:pointer;border-radius:2px">items</button>
    </div>`

    html += '<div id="works-grid" class="works-grid">'
    if (_viewMode === 'grouped') {
      html += await renderGroupedListings(listings)
    } else {
      html += renderListings(listings)
    }
    html += '</div>'

    if (_hasMore) {
      html += `<button id="works-load-more" class="buy-btn" style="margin-top:1em;font-size:0.85em;padding:0.4em 1.5ch">${t('works.loadMore')}</button>`
    }

    contentEl.innerHTML = html
    attachLoadMore(contentEl, artistAddr)
    attachFilterHandlers(contentEl)
    attachViewToggle(contentEl)

    // Publish-to-organization used to attach a trigger to every work
    // card's action row — too noisy next to a buy/collect primary. The
    // owner now reaches it from the item detail page (/art?media=…)
    // instead, so a visitor's card view stays focused on the one
    // visitor-facing action.

    // Scroll to album if URL hash targets one (e.g. #album-<mcid>)
    if (location.hash) {
      const target = document.getElementById(location.hash.slice(1))
      if (target) requestAnimationFrame(() => target.scrollIntoView({ behavior: 'smooth', block: 'center' }))
    }

    // Wire on-chain pending collab accept/dismiss buttons (localStorage — these are on-chain facts, UI-only filter)
    contentEl.querySelectorAll('.collab-accept').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id
        _acceptedCollabs.add(id)
        try { localStorage.setItem(_acceptedCollabsKey, JSON.stringify([..._acceptedCollabs])) } catch {}
        btn.closest('.pending-collab')?.remove()
        _worksLoaded = false
        init()
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
    contentEl.querySelectorAll('.offchain-collab-accept').forEach(btn => {
      btn.addEventListener('click', async () => {
        const collabId = btn.dataset.collabId
        const origText = btn.textContent
        btn.textContent = 'accepting...'
        btn.disabled = true
        const sibling = btn.parentElement?.querySelector('.offchain-collab-dismiss')
        if (sibling) sibling.disabled = true
        try {
          const token = await getAuthToken()
          const resp = await fetch(`/api/collaborations/${collabId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ status: 'accepted' }),
          })
          if (!resp.ok) {
            const err = await resp.json().catch(() => ({}))
            throw new Error(err.error || 'failed')
          }
          // Reload works to show the accepted collab in the grid
          _worksLoaded = false
          init()
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
          const token = await getAuthToken()
          const resp = await fetch(`/api/collaborations/${collabId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ status: 'dismissed' }),
          })
          if (!resp.ok) {
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

    // Resolve content types server-side for listings with empty contentType (updates DOM async)
    resolveAndUpdateContentTypes(listings)

  } catch (e) {
    console.warn('works load error:', e)
    statusEl.textContent = t('works.error')
  }
}

// Map the works nomenclature ("audio" / "video" / "image" / "text") to
// the universal MediaCard content categories ("audio" / "video" /
// "image" / "document"). Items with no detectable type fall through
// to "other" so the category icon still renders.
function worksTypeToCategory(type) {
  if (type === 'text' || type === 'pdf') return 'document'
  if (type === 'audio' || type === 'video' || type === 'image') return type
  return 'other'
}

function renderListings(listings) {
  let html = ''
  for (const item of listings) {
    const type = item._type || classifyType(item)
    const category = worksTypeToCategory(type)
    const maxSupply = Number(item.maxSupply || 0)
    const totalMinted = Number(item.totalMinted || 0)
    const soldOut = maxSupply > 0 && totalMinted >= maxSupply
    const limited = !soldOut && maxSupply > 0
    html += renderMediaCard(item, {
      layout: category === 'video' ? 'wide' : 'square',
      category,
      state: soldOut ? 'sold-out' : (limited ? 'limited' : null),
      resolve: addr => addr,
      hidePrice: false,
      extraDataAttrs: { type, price: item.price || '0' },
    })
  }
  return html
}

// --- Album grouping logic ---

function lruSet(map, key, value) {
  if (map.size >= ALBUM_CACHE_MAX) map.delete(map.keys().next().value)
  map.set(key, value)
}

function groupByMetadataCid(listings) {
  const albumGroups = new Map() // metadataCid -> [items]
  const singles = []
  for (const item of listings) {
    const mcid = item.metadataCid
    if (mcid) {
      if (!albumGroups.has(mcid)) albumGroups.set(mcid, [])
      albumGroups.get(mcid).push(item)
    } else {
      singles.push(item)
    }
  }
  return { albumGroups, singles }
}

async function resolveAlbumArt(albumEntries) {
  // Fetch site.json for the artist and match album tracks to group
  const domain = location.hostname
  let siteData = null
  try {
    const res = await fetch('/site.json')
    if (res.ok) siteData = await res.json()
  } catch {}
  if (!siteData) return

  for (const [mcid, items] of albumEntries) {
    if (_albumArtCache.has(mcid)) continue
    const trackTitles = new Set(items.map(i => (i.title || '').toLowerCase()).filter(Boolean))

    for (const mod of (siteData.modules || [])) {
      if (_albumArtCache.has(mcid)) break
      if (mod.type === 'music') {
        for (const alias of (mod.data?.aliases || [])) {
          for (const album of (alias.albums || [])) {
            const albumTracks = (album.tracks || []).map(t => (t.title || '').toLowerCase()).filter(Boolean)
            const matches = albumTracks.filter(t => trackTitles.has(t)).length
            if (matches >= Math.min(trackTitles.size, albumTracks.length) * 0.5 && matches >= 2) {
              lruSet(_albumArtCache, mcid, {
                artUrl: album.art ? `/api/img?url=${encodeURIComponent(album.art)}&w=400` : '',
                albumName: album.title || '',
                mediaType: 'album',
              })
            }
          }
        }
      } else if (mod.type === 'gallery') {
        const images = mod.data?.images || []
        const sectionMap = new Map()
        for (const img of images) {
          const key = img.section || img.series || '_all'
          if (!sectionMap.has(key)) sectionMap.set(key, [])
          sectionMap.get(key).push(img)
        }
        for (const [secName, secImages] of sectionMap) {
          const secTitles = secImages.map(i => (i.title || '').toLowerCase()).filter(Boolean)
          const matches = secTitles.filter(t => trackTitles.has(t)).length
          if (matches >= Math.min(trackTitles.size, secTitles.length) * 0.5 && matches >= 2) {
            const firstImg = secImages[0]
            lruSet(_albumArtCache, mcid, {
              artUrl: firstImg?.src ? `/api/img?url=${encodeURIComponent(firstImg.src)}&w=400` : '',
              albumName: secName !== '_all' ? secName : (mod.data?.title || 'collection'),
              mediaType: 'collection',
            })
          }
        }
      } else if (mod.type === 'film' || mod.type === 'video') {
        const works = mod.data?.works || mod.data?.videos || []
        const workTitles = works.map(w => (w.title || '').toLowerCase()).filter(Boolean)
        const matches = workTitles.filter(t => trackTitles.has(t)).length
        if (matches >= Math.min(trackTitles.size, workTitles.length) * 0.5 && matches >= 2) {
          const firstWork = works[0]
          lruSet(_albumArtCache, mcid, {
            artUrl: firstWork?.poster ? `/api/img?url=${encodeURIComponent(firstWork.poster)}&w=400` : '',
            albumName: mod.data?.title || 'series',
            mediaType: 'series',
          })
        }
      }
    }
  }
}

function renderAlbumCard(mcid, items) {
  const cached = _albumArtCache.get(mcid)
  const albumName = cached?.albumName || items[0]?.title || 'untitled'
  const mtype = cached?.mediaType || 'album'

  // Decide the item category of the group from the dominant content
  // type. 'collection' is Praxis-site parlance for a mixed image
  // bundle; 'series' is video seasons; everything else = audio album.
  const firstItem = items[0] || {}
  const firstCategory = worksTypeToCategory(classifyType(firstItem))
  const groupCategory = mtype === 'collection'
    ? (firstCategory === 'image' ? 'image' : 'bundle')
    : (mtype === 'series' ? 'video' : (firstCategory === 'image' ? 'image' : 'audio'))

  const allSoldOut = items.every(it => {
    const max = Number(it.maxSupply || 0)
    const minted = Number(it.totalMinted || 0)
    return max > 0 && minted >= max
  })

  const albumItem = {
    mediaId: `album-${mcid}`,
    headline: albumName,
    title: albumName,
    aliasName: cached?.aliasName || '',
    metadataCid: mcid,
    count: items.length,
    items: items.map(it => ({
      mediaId: it.id,
      title: it.title || 'untitled',
      price: it.price,
      ipfsCid: it.ipfsCid,
      contentType: it.contentType,
      metadataCid: it.metadataCid,
    })),
  }

  return renderMediaCard(albumItem, {
    layout: 'album',
    category: groupCategory,
    state: allSoldOut ? 'sold-out' : null,
    resolve: addr => addr,
    extraDataAttrs: { type: mtype, mcid: mcid, span: '2' },
  })
}

async function renderGroupedListings(listings) {
  const { albumGroups, singles } = groupByMetadataCid(listings)

  // Resolve album art for groups with 2+ items
  const toResolve = [...albumGroups.entries()].filter(([mcid, items]) => items.length >= 2 && !_albumArtCache.has(mcid))
  if (toResolve.length > 0) {
    await resolveAlbumArt(toResolve)
  }

  // Merge pass: albums listed in multiple on-chain batches get separate
  // metadataCids but resolve to the SAME site.json album (matched by
  // albumName + artUrl). Fold them into one card. Preserves site.json's
  // track order via `trackIndex` when we have it.
  const mergedGroups = new Map() // mergeKey -> { mcid (primary), items }
  for (const [mcid, items] of albumGroups) {
    const cached = _albumArtCache.get(mcid)
    // Group by (albumName + artUrl) when resolved; fall back to mcid alone
    // so groups that didn't match site.json stay unmerged (safe default).
    const mergeKey = (cached?.albumName && cached?.artUrl)
      ? `resolved:${cached.albumName.toLowerCase()}|${cached.artUrl}`
      : `mcid:${mcid}`
    const existing = mergedGroups.get(mergeKey)
    if (existing) {
      // De-dupe by id in case the same listing appears in both batches
      // (shouldn't, but defensive).
      const seen = new Set(existing.items.map(i => i.id))
      for (const it of items) if (!seen.has(it.id)) existing.items.push(it)
    } else {
      mergedGroups.set(mergeKey, { mcid, items: [...items] })
    }
  }

  let html = ''
  // Albums first
  for (const [, { mcid, items }] of mergedGroups) {
    if (items.length >= 2) {
      html += renderAlbumCard(mcid, items)
    } else {
      // Single item with metadataCid — render normally
      html += renderListings(items)
    }
  }
  // Then singles
  html += renderListings(singles)
  return html
}

function attachViewToggle(container) {
  container.querySelectorAll('.works-view-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const mode = btn.dataset.mode
      if (mode === _viewMode) return
      _viewMode = mode

      // Update button styles
      container.querySelectorAll('.works-view-btn').forEach(b => {
        const isActive = b.dataset.mode === mode
        b.style.background = isActive ? 'var(--surface)' : 'none'
        b.style.borderColor = isActive ? 'var(--accent)' : 'var(--border)'
        b.style.color = isActive ? 'var(--accent)' : 'var(--muted)'
        b.classList.toggle('active', isActive)
      })

      // Re-render grid
      const grid = container.querySelector('#works-grid')
      if (!grid) return
      if (_viewMode === 'grouped') {
        grid.innerHTML = await renderGroupedListings(_currentListings)
      } else {
        grid.innerHTML = renderListings(_currentListings)
      }

      // Re-apply active filter
      if (_activeFilter !== 'all') {
        grid.querySelectorAll('.media-card').forEach(item => {
          item.style.display = item.dataset.type === _activeFilter ? '' : 'none'
        })
      }
    })
  })

  // Album buy buttons are routed through the global .feed-buy-btn
  // delegation registered by feed-cards.js on import — see the
  // "buy-album" action in media-card.js.
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
      grid.querySelectorAll('.media-card').forEach(item => {
        item.style.display = (_activeFilter === 'all' || item.dataset.type === _activeFilter) ? '' : 'none'
      })
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
          if (_activeFilter !== 'all') {
            grid.querySelectorAll('.media-card').forEach(item => {
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
