// Universal MediaCard — the one card component for every piece of
// media the protocol can show. Replaces, in order of migration:
//   - works.js grid cards (every type)
//   - collection.js grid + list items
//   - feed-cards.js renderMediaCard (single listing)
//   - feed-cards.js renderBatchCard (album listing)
//   - feed-cards.js renderPurchaseCard (single collected)
//   - feed-cards.js renderPurchaseBatchCard (album collected)
//   - feed-cards.js renderTicketListedCard / renderTicketPurchasedCard
//   - feed-cards.js renderCredentialCard
//
// One signature, caller-passed context. The component itself has no
// knowledge of "feed" vs. "collection" vs. "works" — only of layout,
// category, state, and the actions the caller wants on the card.
//
// Signature:
//   renderMediaCard(item, {
//     layout, category, subtype, state, actions, header,
//     gated, linkTo, external, resolve, siteModules
//   })
//
// Every option has a reasonable inference from the item shape. The
// caller passes only the ones they need to override. See /design
// section 5 for every rendered variant.

import {
  escapeHtml as esc,
  slugify,
  inlineAvatar,
  getProfilePic,
  getArtistName,
} from './utils.js'

const DELIST_PRICE_SENTINEL = 2n ** 128n

// ─── category inference ────────────────────────────────────────────
// Maps an item's contentType / subtype hint to one of 12 content
// categories. Caller can always override by passing context.category.
function inferCategory(item, context) {
  if (context.category) return context.category
  const ct = (item.contentType || '').toLowerCase()
  if (item.items && item.items.length > 1) {
    const inner = item.items.map(it => (it.contentType || '').toLowerCase())
    if (inner.every(c => c.startsWith('image/'))) return 'image'
    if (inner.every(c => c.startsWith('video/'))) return 'video'
    if (inner.every(c => c.startsWith('audio/') || c === 'application/ogg')) return 'audio'
    return 'bundle'
  }
  if (ct.startsWith('audio/') || ct === 'application/ogg') return 'audio'
  if (ct.startsWith('video/')) return 'video'
  if (ct.startsWith('image/')) return 'image'
  if (ct === 'application/pdf' || ct.startsWith('text/')) return 'document'
  if (ct === 'model/gltf-binary' || ct === 'model/gltf+json') return '3d'
  if (ct === 'text/html') return 'interactive'
  if (ct.startsWith('application/') && (ct.includes('javascript') || ct.includes('json'))) return 'code'
  if (item.kind === 'ticket') return 'ticket'
  if (item.kind === 'credential') return 'credential'
  if (item.kind === 'live') return 'live'
  return 'other'
}

// ─── layout inference ──────────────────────────────────────────────
function inferLayout(item, context) {
  const category = context.category || inferCategory(item, context)
  if (item.items && item.items.length > 1) return 'album'
  if (category === 'video' || category === 'live') return 'wide'
  return 'square'
}

// ─── default link ──────────────────────────────────────────────────
function defaultLinkFor(item, context) {
  if (context.linkTo) return context.linkTo
  const id = item.mediaId || item.id
  if (!id) return '#'
  return `/art?media=${encodeURIComponent(id)}`
}

// ─── album slug URL ────────────────────────────────────────────────
// Returns a /music/<alias>/<album> URL when we have both parts, else
// null. Server now emits aliasName/albumTitle authoritatively; falls
// back to item.aliasName+headline for in-flight payloads.
function albumSlugUrl(item) {
  const aName = item.albumPath?.aliasName || item.aliasName || ''
  const aTitle = item.albumPath?.albumTitle || item.headline || item.title || ''
  if (!aName || !aTitle) return null
  return `/music/${slugify(aName)}/${slugify(aTitle)}`
}

// ─── art fallback chain per category ───────────────────────────────
function thumbSrcFor(item, category, width = 280) {
  const cid = item.ipfsCid || ''
  const metaCid = item.metadataCid || ''
  const metaThumb = metaCid ? `/api/img?url=/api/ipfs-proxy/${encodeURIComponent(metaCid)}&w=${width}` : ''
  if (category === 'image') {
    if (cid) return `/api/img?url=/api/ipfs-proxy/${encodeURIComponent(cid)}&w=${width}`
    return metaThumb
  }
  if (category === 'video') {
    if (cid) return `/api/video-thumb?cid=${encodeURIComponent(cid)}`
    return metaThumb
  }
  if (category === 'document') {
    if (cid) return `/api/pdf-thumb?src=${encodeURIComponent(`/api/ipfs-proxy/${cid}`)}`
    return metaThumb
  }
  return metaThumb
}

// ─── category icon fallback ────────────────────────────────────────
function categoryIcon(category) {
  const icons = {
    audio: 'ph-music-notes',
    video: 'ph-film-strip',
    image: 'ph-image',
    document: 'ph-file-text',
    '3d': 'ph-cube',
    interactive: 'ph-cursor-click',
    code: 'ph-code',
    live: 'ph-broadcast',
    ticket: 'ph-ticket',
    credential: 'ph-seal-check',
    bundle: 'ph-stack',
    other: 'ph-file',
  }
  return icons[category] || 'ph-file'
}

// ─── price helpers ─────────────────────────────────────────────────
function parsePrice(wei) {
  try { return BigInt(wei || '0') } catch { return 0n }
}

function isDelisted(item) {
  return parsePrice(item.price) >= DELIST_PRICE_SENTINEL
}

function priceInline(wei) {
  const pw = parsePrice(wei)
  if (pw <= 0n) return '<span style="color:var(--green);font-size:0.8em">free</span>'
  return `<span data-eth-wei="${esc(wei)}" data-fiat-primary="true"></span>`
}

// ─── action vocabulary ─────────────────────────────────────────────
// Each action maps to one markup fragment. Caller passes action
// identifiers; we render each with consistent styling. Buttons use
// event delegation (see feed-cards.js and player.js) — no inline
// onclick, keeps content-security-policy clean.
function renderAction(action, item, context) {
  const cid = item.ipfsCid || ''
  const title = item.title || 'untitled'
  const artist = context.resolve ? context.resolve(item.artist) : (item.artist || '')
  const metaCid = item.metadataCid || ''
  const artSrc = metaCid ? `/api/img?url=/api/ipfs-proxy/${encodeURIComponent(metaCid)}&w=200` : ''
  const price = item.price || '0'

  switch (action) {
    case 'play': {
      if (!cid) return ''
      return `<button class="track-play-btn media-card-play-btn" data-track-src="/api/ipfs-proxy/${encodeURIComponent(cid)}" data-track-title="${esc(title)}" data-track-artist="${esc(artist)}" data-track-art="${esc(artSrc)}" aria-label="play"><i class="ph ph-play"></i></button>`
    }
    case 'play-all': {
      const tracks = (item.items || []).filter(it => it.ipfsCid)
      if (!tracks.length) return ''
      const queue = encodeURIComponent(JSON.stringify(tracks.map(it => ({
        src: `/api/ipfs-proxy/${it.ipfsCid}`,
        title: it.title || '',
        artist,
        art: artSrc,
      }))))
      return `<button class="album-play-btn feed-card-btn" data-queue="${queue}"><i class="ph ph-play"></i> play</button>`
    }
    case 'buy': {
      const pw = parsePrice(price)
      if (pw <= 0n) return ''
      return `<button class="feed-buy-btn feed-card-btn green" data-media-id="${esc(String(item.mediaId || item.id))}" data-price="${esc(price)}" data-title="${esc(title)}">buy <span data-eth-wei="${esc(price)}" data-fiat-primary="true"></span></button>`
    }
    case 'buy-album': {
      const buyables = (item.items || []).filter(it => parsePrice(it.price) > 0n)
      if (!buyables.length) return ''
      let total = 0n
      for (const it of buyables) total += parsePrice(it.price)
      const label = item.headline ? `${item.headline} (${buyables.length} items)` : `${buyables.length} items`
      return `<button class="feed-buy-btn feed-card-btn green" data-media-id="${esc(String(buyables[0].mediaId))}" data-price="${esc(String(total))}" data-ids="${esc(buyables.map(it => it.mediaId).join(','))}" data-prices="${esc(buyables.map(it => it.price).join(','))}" data-title="${esc(label)}">buy album <span data-eth-wei="${esc(String(total))}" data-fiat-primary="true"></span></button>`
    }
    case 'buy-ticket': {
      const pw = parsePrice(price)
      if (pw <= 0n) return ''
      return `<button class="feed-buy-btn feed-card-btn green" data-media-id="${esc(String(item.mediaId || item.id))}" data-price="${esc(price)}" data-title="${esc(title)}">buy ticket</button>`
    }
    case 'collect-free': {
      return `<button class="feed-buy-btn feed-card-btn green" data-media-id="${esc(String(item.mediaId || item.id))}" data-price="0" data-title="${esc(title)}">collect free</button>`
    }
    case 'download': {
      if (!cid) return ''
      return `<a class="media-card-icon-btn" href="/api/ipfs-proxy/${encodeURIComponent(cid)}" download="${esc(title)}" aria-label="download" title="download"><i class="ph ph-download-simple"></i></a>`
    }
    case 'open': {
      return `<a class="feed-card-btn" href="${esc(defaultLinkFor(item, context))}"><i class="ph ph-arrow-square-out"></i> open</a>`
    }
    case 'view': {
      return `<a class="media-card-view-link" href="${esc(defaultLinkFor(item, context))}">→ view</a>`
    }
    case 'unlock': {
      return `<button class="feed-card-btn" disabled aria-disabled="true"><i class="ph ph-lock-key"></i> unlock</button>`
    }
    case 'claim': {
      return `<button class="feed-card-btn green" data-media-id="${esc(String(item.mediaId || item.id))}" data-claim-id="${esc(String(item.mediaId || item.id))}">claim</button>`
    }
    case 'share': {
      return `<button class="media-card-icon-btn" data-share-url="${esc(defaultLinkFor(item, context))}" data-share-title="${esc(title)}" aria-label="share" title="share"><i class="ph ph-share-network"></i></button>`
    }
    case 'tip': {
      return `<button class="media-card-icon-btn" data-tip-to="${esc(item.artist || '')}" aria-label="tip" title="tip"><i class="ph ph-coin"></i></button>`
    }
    case 'queue': {
      if (!cid) return ''
      return `<button class="media-card-icon-btn" data-queue-src="/api/ipfs-proxy/${encodeURIComponent(cid)}" data-queue-title="${esc(title)}" aria-label="add to queue" title="add to queue"><i class="ph ph-queue"></i></button>`
    }
    default:
      return ''
  }
}

// ─── default action set per category ───────────────────────────────
function inferActions(item, category, state, context) {
  if (context.actions) return context.actions
  const delisted = isDelisted(item)
  const owned = context.owned === true
  const free = parsePrice(item.price) === 0n && !(item.items && item.items.length)
  if (state === 'sold-out' || state === 'ended' || state === 'delisted' || delisted) {
    return owned ? ['view'] : []
  }
  if (owned) {
    if (category === 'audio') return ['play']
    if (category === 'video') return []
    if (category === 'document' || category === 'image' || category === '3d' || category === 'code' || category === 'other') return ['download']
    if (category === 'ticket') return ['view']
    if (category === 'credential') return ['view']
    return ['view']
  }
  const defaults = {
    audio: item.items && item.items.length > 1 ? ['play-all', 'buy-album'] : (free ? ['play', 'collect-free'] : ['play', 'buy']),
    video: free ? ['collect-free'] : ['buy'],
    image: item.items && item.items.length > 1 ? ['buy-album'] : (free ? ['collect-free'] : ['buy']),
    document: free ? ['collect-free'] : ['buy'],
    '3d': free ? ['collect-free'] : ['buy'],
    interactive: ['open'],
    code: free ? ['collect-free'] : ['buy'],
    live: ['buy-ticket'],
    ticket: ['buy-ticket'],
    credential: ['claim'],
    bundle: ['buy-album'],
    other: free ? ['collect-free'] : ['buy'],
  }
  return defaults[category] || []
}

// ─── display name helper ───────────────────────────────────────────
function displayName(addr, context, explicitName) {
  const resolve = context.resolve || (a => a)
  return explicitName || getArtistName(addr) || resolve(addr)
}

// ─── header slot ───────────────────────────────────────────────────
function renderHeader(header, context) {
  if (!header) return ''
  const actor = header.actor
  const name = header.actorName || displayName(actor, context)
  const avatarPic = getProfilePic(actor)
  const avatar = inlineAvatar(actor, avatarPic)
  const verb = {
    collected: 'collected',
    listed: 'listed',
    posted: 'posted',
    contributed: 'contributed to library',
    proposed: 'proposed',
  }[header.kind] || header.kind
  return `<div class="media-card-header">${avatar}<span class="media-card-header-actor">${esc(name)}</span><span class="media-card-header-verb">${esc(verb)}</span></div>`
}

// ─── state overlay ─────────────────────────────────────────────────
function renderStateOverlay(state, item) {
  if (!state) return ''
  if (state === 'upcoming') {
    const ts = item.startsAt || item.deadline || 0
    return `<span class="media-card-state media-card-state--upcoming" data-countdown-to="${esc(String(ts))}">upcoming</span>`
  }
  if (state === 'live-now') {
    return `<span class="media-card-state media-card-state--live"><span class="media-card-state-pulse"></span>live</span>`
  }
  if (state === 'ended') {
    return `<span class="media-card-state media-card-state--ended">ended</span>`
  }
  if (state === 'sold-out') {
    return `<span class="media-card-state media-card-state--soldout">sold out</span>`
  }
  if (state === 'limited') {
    const minted = item.totalMinted ?? 0
    const supply = item.maxSupply ?? 0
    return `<span class="media-card-state media-card-state--limited">${esc(String(minted))} of ${esc(String(supply))}</span>`
  }
  if (state === 'gated') {
    return `<span class="media-card-state media-card-state--gated"><i class="ph ph-lock-key"></i></span>`
  }
  if (state === 'superseded') {
    // Rendered as a secondary meta hint ("see newer listing"); the
    // artwork and title get dimmed via the .media-card--state-superseded
    // modifier instead of an overlay chip.
    return ''
  }
  return ''
}

// ─── artwork block ─────────────────────────────────────────────────
function renderArt(item, category, state, context) {
  const link = defaultLinkFor(item, context)
  const linkTarget = context.external ? ' target="_blank"' : ''
  const src = thumbSrcFor(item, category, context._thumbWidth || 280)
  const icon = categoryIcon(category)
  const stateOverlay = renderStateOverlay(state, item)
  const dimmed = state === 'ended' || state === 'delisted'
  const dimStyle = dimmed ? ';opacity:0.5' : ''

  let artInner
  if (category === 'bundle' && item.items && item.items.length > 1) {
    const mosaic = item.items.slice(0, 4).map(it => {
      const s = thumbSrcFor(it, inferCategory(it, {}), 140)
      return s
        ? `<img src="${esc(s)}" loading="lazy" alt="" style="width:100%;height:100%;object-fit:cover;display:block">`
        : `<div class="media-card-art-fallback"><i class="ph ${categoryIcon(inferCategory(it, {}))}"></i></div>`
    }).join('')
    artInner = `<div class="media-card-art-mosaic" style="${dimStyle.slice(1)}">${mosaic}</div>`
  } else if (src) {
    artInner = `<img src="${esc(src)}" loading="lazy" alt="" style="width:100%;height:100%;object-fit:cover;display:block${dimStyle}" onerror="this.style.display='none';this.nextElementSibling&&this.nextElementSibling.removeAttribute('hidden')"><div class="media-card-art-fallback" hidden><i class="ph ${icon}"></i></div>`
  } else {
    artInner = `<div class="media-card-art-fallback"><i class="ph ${icon}"></i></div>`
  }

  // Audio over-art play overlay for single-item owned/listed cards
  const showPlayOverlay = category === 'audio' && item.ipfsCid && (context.actions || []).includes('play')
  const playOverlay = showPlayOverlay
    ? `<button class="track-play-btn media-card-play-overlay" data-track-src="/api/ipfs-proxy/${encodeURIComponent(item.ipfsCid)}" data-track-title="${esc(item.title || 'untitled')}" data-track-artist="${esc(displayName(item.artist, context))}" data-track-art="${esc(src)}" aria-label="play"><i class="ph ph-play"></i></button>`
    : ''

  return `<a class="media-card-art" href="${esc(link)}"${linkTarget}>${artInner}${playOverlay}${stateOverlay}</a>`
}

// ─── album tracklist ───────────────────────────────────────────────
function renderTracklist(item, context) {
  const items = [...(item.items || [])].sort((a, b) => {
    try { return Number(BigInt(a.mediaId) - BigInt(b.mediaId)) } catch { return 0 }
  })
  const artist = displayName(item.artist, context)
  const trackLinks = (item.albumPath && item.albumPath.aliasName)
    ? `/music/${slugify(item.albumPath.aliasName)}/${slugify(item.albumPath.albumTitle || item.headline || '')}`
    : null
  return items.map((it, i) => {
    const cid = it.ipfsCid || ''
    const pw = parsePrice(it.price)
    const playBtn = cid
      ? `<button class="track-play-btn" data-track-src="/api/ipfs-proxy/${encodeURIComponent(cid)}" data-track-title="${esc(it.title || '')}" data-track-artist="${esc(artist)}" aria-label="play"><i class="ph ph-play"></i></button>`
      : ''
    const buyBtn = pw > 0n
      ? `<button class="feed-buy-btn feed-card-btn green media-card-track-buy" data-media-id="${esc(String(it.mediaId))}" data-price="${esc(it.price)}" data-title="${esc(it.title || '')}"><span data-eth-wei="${esc(it.price)}" data-fiat-primary="true"></span></button>`
      : ''
    const trackLink = trackLinks || `/art?media=${encodeURIComponent(it.mediaId)}`
    return `<div class="media-card-track"><span class="media-card-track-num">${i + 1}</span>${playBtn}<a class="media-card-track-title" href="${esc(trackLink)}">${esc(it.title || 'untitled')}</a>${buyBtn}</div>`
  }).join('')
}

// ─── gallery grid (image bundles) ──────────────────────────────────
function renderGallery(item) {
  const items = item.items || []
  const shown = items.slice(0, 12)
  const extra = items.length - shown.length
  const cells = shown.map(it => {
    const src = it.ipfsCid ? `/api/img?url=/api/ipfs-proxy/${encodeURIComponent(it.ipfsCid)}&w=160` : ''
    return src
      ? `<a class="media-card-gallery-cell" href="/art?media=${encodeURIComponent(it.mediaId)}"><img src="${esc(src)}" loading="lazy" alt="${esc(it.title || '')}"></a>`
      : `<a class="media-card-gallery-cell media-card-gallery-cell--empty" href="/art?media=${encodeURIComponent(it.mediaId)}"><i class="ph ph-image"></i></a>`
  }).join('')
  const extraCell = extra > 0 ? `<div class="media-card-gallery-cell media-card-gallery-more">+${extra}</div>` : ''
  return `<div class="media-card-gallery">${cells}${extraCell}</div>`
}

// ─── meta line (price · count · state secondary) ───────────────────
function renderMeta(item, category, state, context) {
  const parts = []
  const price = item.price
  const pw = parsePrice(price)
  if (!context.hidePrice) {
    if (item.items && item.items.length > 1) {
      let total = 0n
      for (const it of item.items) total += parsePrice(it.price)
      if (total > 0n) parts.push(`<span data-eth-wei="${esc(String(total))}" data-fiat-primary="true"></span>`)
    } else if (pw > 0n) {
      parts.push(priceInline(price))
    } else if (!context.header) {
      parts.push('<span style="color:var(--green)">free</span>')
    }
  }
  if (item.items && item.items.length > 1) {
    const label = category === 'image' ? `${item.items.length} images`
      : category === 'video' ? `${item.items.length} videos`
      : `${item.count || item.items.length} tracks`
    parts.push(esc(label))
  }
  if (item.maxSupply && item.maxSupply !== '0' && state !== 'limited') {
    parts.push(`${esc(String(item.totalMinted ?? 0))} of ${esc(String(item.maxSupply))}`)
  }
  if (context.subtype) parts.push(esc(context.subtype))
  if (item.superseded || state === 'superseded') {
    const href = item.activeListingId ? `/art?media=${encodeURIComponent(item.activeListingId)}` : null
    parts.push(href
      ? `<a class="media-card-meta-superseded" href="${esc(href)}">see newer listing</a>`
      : '<span class="media-card-meta-superseded">superseded</span>')
  }
  return parts.length
    ? `<div class="media-card-meta">${parts.join(' · ')}</div>`
    : ''
}

// ─── actions row ───────────────────────────────────────────────────
function renderActions(item, category, state, context) {
  const list = inferActions(item, category, state, context)
  if (!list.length) return ''
  const html = list.map(a => renderAction(a, item, context)).filter(Boolean).join('')
  if (!html) return ''
  return `<div class="media-card-actions">${html}</div>`
}

// ─── title + aliasName ─────────────────────────────────────────────
function renderTitle(item, context) {
  const title = item.headline || item.title || 'untitled'
  const link = albumSlugUrl(item) || defaultLinkFor(item, context)
  const linkTarget = context.external ? ' target="_blank"' : ''
  const aliasName = item.albumPath?.aliasName || item.aliasName
  // Caller can override where the author line links to (e.g. the
  // collection page routes to its own `/collection?artist=X` filter on
  // the current tenant rather than off to the artist's own site).
  const authorHref = context.authorHref
    || (aliasName ? `/music/${slugify(aliasName)}` : null)
    || (item.artist && context.resolve ? ('https://' + context.resolve(item.artist)) : null)
  const authorText = aliasName || (item.artist ? displayName(item.artist, context) : '')
  const authorLine = authorText && !context.hideAuthor
    ? `<a class="media-card-author" href="${esc(authorHref || '#')}">${esc(authorText)}</a>`
    : ''
  return `
    ${authorLine}
    <a class="media-card-title" href="${esc(link)}"${linkTarget}>${esc(title)}</a>
  `
}

// ─── main ──────────────────────────────────────────────────────────
export function renderMediaCard(item, context = {}) {
  if (!item) return ''
  const category = inferCategory(item, context)
  const state = context.state || (isDelisted(item) ? 'delisted' : null)
  const layout = context.layout || inferLayout(item, context)
  const gated = context.gated || null
  const header = context.header || null

  context = { ...context, category, state, layout, actions: context.actions || inferActions(item, category, state, context) }

  const headerHtml = renderHeader(header, context)
  const artHtml = renderArt(item, category, state, context)
  const metaHtml = renderMeta(item, category, state, context)
  const actionsHtml = renderActions(item, category, state, context)
  const titleHtml = renderTitle(item, context)

  let infoBody
  if (layout === 'album') {
    const inner = category === 'image' ? renderGallery(item) : `<div class="media-card-tracklist">${renderTracklist(item, context)}</div>`
    infoBody = `${titleHtml}${metaHtml}${actionsHtml}${inner}`
  } else {
    infoBody = `${titleHtml}${metaHtml}${actionsHtml}`
  }

  const gatedCaption = gated?.unlockBy
    ? `<div class="media-card-gated-caption">unlock with ${esc(gated.unlockBy)}</div>`
    : ''

  // Callers may inject additional data-* attributes on the outer div
  // (e.g. the /works grid filter reads data-type, the collection grid
  // reads data-media-type) without having to post-process the DOM.
  const extraAttrs = context.extraDataAttrs
    ? Object.entries(context.extraDataAttrs).map(([k, v]) => `data-${esc(k)}="${esc(String(v ?? ''))}"`).join(' ')
    : ''

  // Callers can also append classes (e.g. `.collection-item` for the
  // collection page's filter / search selectors) without having to
  // post-process the DOM.
  const extraClasses = context.extraClasses ? ' ' + context.extraClasses : ''

  return `
    <div class="media-card media-card--${layout} media-card--cat-${category}${state ? ' media-card--state-' + state : ''}${extraClasses}" data-media-id="${esc(String(item.mediaId || item.id || ''))}" data-category="${esc(category)}" ${extraAttrs}>
      ${headerHtml}
      ${artHtml}
      <div class="media-card-info">${infoBody}${gatedCaption}</div>
    </div>
  `
}

// ─── row + horizontal layouts share a thinner thumb ────────────────
// Callers pass layout: 'row' | 'horizontal' explicitly; the base
// renderMediaCard honors them. Row/horizontal use smaller thumb
// widths via context._thumbWidth tweak.
export function renderMediaCardRow(item, context = {}) {
  return renderMediaCard(item, { ...context, layout: 'row', _thumbWidth: 96 })
}

export function renderMediaCardHorizontal(item, context = {}) {
  return renderMediaCard(item, { ...context, layout: 'horizontal', _thumbWidth: 240 })
}
