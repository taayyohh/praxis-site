// Organization profile page — distinct layouts per org type
import { escapeHtml, registerPage, resolveAddresses, getPublicClient, ipfsUrl, getProfilePic, getArtistName } from './utils.js'
import { query } from './ponder.js'
import { ORG_ADDRESS, ORG_ABI } from './contracts.js'

registerPage('org-page', initOrg)

const ORG_TYPE_CONFIG = {
  label:      { rosterTitle: 'artists', catalogTitle: 'releases', maxWidth: '1000px' },
  gallery:    { rosterTitle: 'represented', catalogTitle: 'collection', maxWidth: '1200px' },
  company:    { rosterTitle: 'company', catalogTitle: 'productions', maxWidth: '1100px' },
  publisher:  { rosterTitle: 'authors', catalogTitle: 'catalog', maxWidth: '700px' },
  collective: { rosterTitle: 'roster', catalogTitle: 'works', maxWidth: '1000px' },
}

async function initOrg() {
  const container = document.getElementById('org-page')
  if (!container) return

  const params = new URLSearchParams(location.search)
  const orgId = params.get('id')
  if (!orgId && orgId !== '0') {
    container.innerHTML = `<p style="color:var(--muted)">no organization specified. <a href="/org?id=0" style="color:var(--accent)">browse orgs</a></p>`
    return
  }

  container.innerHTML = '<span class="praxis-loader"></span>'

  try {
    const res = await fetch(`/api/org/${encodeURIComponent(orgId)}`)
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      container.innerHTML = `<p style="color:var(--muted)">${escapeHtml(err.error || 'organization not found')}</p>`
      return
    }
    const org = await res.json()
    await renderOrg(container, org, orgId)
  } catch {
    container.innerHTML = `<p style="color:var(--muted)">failed to load organization</p>`
  }
}

async function renderOrg(container, org, orgId) {
  const meta = org.metadata || {}
  const name = escapeHtml(org.name || 'unnamed')
  const bio = escapeHtml(meta.bio || meta.description || '')
  const adminAddr = (org.admin || '').toLowerCase()
  const memberCount = org.members?.length || 0
  const dissolved = org.dissolved
  const myAddr = (window.getWalletAddress?.() || '').toLowerCase()
  const isAdmin = myAddr && myAddr === adminAddr
  const isMember = myAddr && org.members?.some(m => (m.wallet || m).toLowerCase() === myAddr)
  const orgType = meta.orgType || window._siteData?.orgType || 'collective'
  const cfg = ORG_TYPE_CONFIG[orgType] || ORG_TYPE_CONFIG.collective

  let memberDomains = {}
  let memberPics = {}
  let memberNames = {}
  if (org.members?.length) {
    const addrs = org.members.map(m => m.wallet || m)
    try { memberDomains = await resolveAddresses(query, addrs) } catch {}
    try {
      const r = await fetch('/api/artists/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addresses: addrs.slice(0, 200) }),
      })
      if (r.ok) {
        const data = await r.json()
        memberPics = data.profilePics || {}
        memberNames = data.names || {}
      }
    } catch {}
  }
  if (adminAddr && !memberDomains[adminAddr]) {
    try { Object.assign(memberDomains, await resolveAddresses(query, [adminAddr])) } catch {}
  }

  const adminDisplay = memberDomains[adminAddr] || `${adminAddr.slice(0, 6)}...${adminAddr.slice(-4)}`

  // Type-specific header styles
  const headerStyle = {
    label: `font-size:2.4em;font-weight:700;letter-spacing:-0.02em;margin:0`,
    gallery: `font-size:1.2em;text-transform:uppercase;letter-spacing:0.2em;font-weight:400;margin:0`,
    company: `font-size:2em;text-transform:uppercase;letter-spacing:0.08em;font-weight:600;margin:0`,
    publisher: `font-size:2.2em;font-family:Georgia,'Times New Roman',serif;font-weight:400;font-style:italic;margin:0`,
    collective: `font-size:1.8em;font-weight:500;margin:0`,
  }

  container.innerHTML = `
    <div class="org-page-root" style="max-width:${cfg.maxWidth};margin:0 auto">
      <div class="org-header" style="margin-bottom:2.5em;${orgType === 'gallery' ? 'text-align:center;' : ''}">
        <h1 style="${headerStyle[orgType] || headerStyle.collective}">${name}</h1>
        ${dissolved ? '<span style="color:var(--red,#a44);font-size:0.85em;border:1px solid var(--red,#a44);padding:0.1em 0.5ch;border-radius:3px;margin-top:0.5em;display:inline-block">dissolved</span>' : ''}
        ${bio ? `<p style="color:var(--muted);line-height:1.7;margin:0.8em 0 0;${orgType === 'publisher' ? 'font-family:Georgia,serif;font-size:1.05em;max-width:55ch;' : 'font-size:0.9em;max-width:65ch;'}${orgType === 'gallery' ? 'margin-left:auto;margin-right:auto;' : ''}">${bio}</p>` : ''}
        <div style="font-size:0.75em;color:var(--dim);margin-top:0.6em;display:flex;gap:2ch;${orgType === 'gallery' ? 'justify-content:center;' : ''}flex-wrap:wrap">
          <span>${memberCount} ${escapeHtml(cfg.rosterTitle)}</span>
          <span>admin: <a href="${memberDomains[adminAddr] ? `https://${escapeHtml(memberDomains[adminAddr])}` : '#'}" style="color:var(--accent);text-decoration:none">${escapeHtml(adminDisplay)}</a></span>
        </div>
      </div>

      ${isAdmin && !dissolved ? `
      <div style="margin-bottom:2em;padding:1em;border:1px solid var(--border);background:rgba(255,255,255,0.02)">
        <div style="display:flex;gap:0.5em;align-items:center;flex-wrap:wrap">
          <div style="flex:1;min-width:200px;position:relative">
            <input type="text" id="org-invite-input" class="project-input" placeholder="search artists by name or domain" autocomplete="off" style="width:100%;box-sizing:border-box">
            <div id="org-invite-suggest" style="position:absolute;top:100%;left:0;right:0;background:var(--bg,#111);border:1px solid var(--border);border-top:none;max-height:200px;overflow-y:auto;display:none;z-index:10"></div>
          </div>
          <button id="org-invite-btn" class="buy-btn" style="font-size:0.85em;padding:0.4em 1.5ch;white-space:nowrap">invite</button>
        </div>
        <div id="org-invite-status" style="font-size:0.85em;color:var(--muted);min-height:1.2em;margin-top:0.5em"></div>
      </div>
      ` : ''}

      <div id="org-featured" style="margin-bottom:3em"></div>

      <div style="margin-bottom:3em">
        <h2 class="org-section-title">${escapeHtml(cfg.catalogTitle)}</h2>
        <div id="org-catalog"><span class="praxis-loader"></span></div>
        <div id="org-catalog-sentinel" style="height:1px"></div>
      </div>

      <div style="margin-bottom:3em">
        <h2 class="org-section-title">${escapeHtml(cfg.rosterTitle)}</h2>
        <div id="org-roster" class="org-roster org-roster-${escapeHtml(orgType)}">
          ${renderRoster((org.members || []).filter(m => (m.wallet || m).toLowerCase() !== adminAddr), memberDomains, isAdmin, orgId, orgType, memberPics, memberNames)}
        </div>
      </div>

      ${isAdmin && !dissolved ? `
      <div style="padding-top:1.5em;border-top:1px solid var(--border)">
        <button id="org-dissolve-btn" style="font-size:0.8em;color:var(--dim);background:transparent;border:1px solid var(--border);padding:0.4em 1.5ch;cursor:pointer;font-family:inherit">dissolve organization</button>
        <span style="font-size:0.75em;color:var(--dim);margin-left:1ch">permanent — cannot be undone</span>
      </div>
      ` : ''}

      ${!isAdmin && isMember && !dissolved ? `
      <div style="padding-top:1.5em;border-top:1px solid var(--border)">
        <button id="org-leave-btn" class="buy-btn" style="font-size:0.8em;padding:0.4em 1.5ch;border-color:var(--dim);color:var(--dim)">leave organization</button>
      </div>
      ` : ''}
    </div>

    <style>
      .org-section-title {
        font-size:0.8em; text-transform:uppercase; letter-spacing:0.15em;
        color:var(--dim); margin:0 0 1.2em; padding-bottom:0.5em;
        border-bottom:1px solid var(--border);
      }

      /* --- Label --- */
      .org-label-grid {
        display:grid; grid-template-columns:repeat(auto-fill, minmax(160px, 1fr)); gap:1.2em;
      }
      .org-label-card { cursor:pointer; transition:opacity 0.15s; }
      .org-label-card:hover { opacity:0.85; }
      .org-label-card img { width:100%; aspect-ratio:1; object-fit:cover; display:block; border:1px solid var(--border); }
      .org-label-card .meta { padding:0.5em 0 0; }
      .org-label-card .title { font-size:0.85em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .org-label-card .artist { font-size:0.75em; color:var(--dim); text-decoration:none; display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

      /* --- Gallery --- */
      .org-gallery-masonry { columns:3; column-gap:1em; }
      .org-gallery-item { break-inside:avoid; margin-bottom:1em; cursor:pointer; position:relative; overflow:hidden; }
      .org-gallery-item img { width:100%; display:block; border:1px solid var(--border); transition:opacity 0.2s; }
      .org-gallery-item:hover img { opacity:0.85; }
      .org-gallery-item .overlay {
        position:absolute; bottom:0; left:0; right:0;
        padding:0.6em 0.8em; background:linear-gradient(transparent, rgba(0,0,0,0.8));
        opacity:0; transition:opacity 0.2s; display:flex; justify-content:space-between; align-items:flex-end;
      }
      .org-gallery-item:hover .overlay { opacity:1; }
      .org-gallery-item .overlay .title { font-size:0.8em; color:#fff; }
      .org-gallery-item .overlay .artist { font-size:0.7em; color:rgba(255,255,255,0.6); }

      /* --- Company (film) --- */
      .org-poster-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(140px, 1fr)); gap:1.2em; }
      .org-poster-card { cursor:pointer; transition:transform 0.15s; }
      .org-poster-card:hover { transform:translateY(-2px); }
      .org-poster-card .poster { width:100%; aspect-ratio:2/3; object-fit:cover; display:block; border:1px solid var(--border); }
      .org-poster-card .poster-placeholder { width:100%; aspect-ratio:2/3; background:var(--surface,#111); border:1px solid var(--border); display:flex; align-items:center; justify-content:center; color:var(--dim); font-size:0.8em; }
      .org-poster-card .meta { padding:0.5em 0 0; }
      .org-poster-card .title { font-size:0.85em; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .org-poster-card .artist { font-size:0.7em; color:var(--dim); text-decoration:none; display:block; }

      /* --- Publisher --- */
      .org-pub-list { display:flex; flex-direction:column; gap:2em; }
      .org-pub-item { display:flex; gap:1.5em; padding-bottom:2em; border-bottom:1px solid var(--border); }
      .org-pub-item .cover { width:120px; flex-shrink:0; }
      .org-pub-item .cover img { width:100%; aspect-ratio:2/3; object-fit:cover; border:1px solid var(--border); }
      .org-pub-item .info { flex:1; min-width:0; }
      .org-pub-item .title { font-family:Georgia,'Times New Roman',serif; font-size:1.15em; margin-bottom:0.2em; }
      .org-pub-item .artist { font-size:0.85em; color:var(--dim); text-decoration:none; font-style:italic; }

      /* --- Collective --- */
      .org-coll-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(200px, 1fr)); gap:1em; }
      .org-coll-card { border:1px solid var(--border); overflow:hidden; transition:border-color 0.15s; }
      .org-coll-card:hover { border-color:var(--border-hover, rgba(255,255,255,0.18)); }
      .org-coll-card .media { width:100%; aspect-ratio:4/3; object-fit:cover; display:block; }
      .org-coll-card .body { padding:0.7em 0.8em; }
      .org-coll-card .type-badge { font-size:0.65em; text-transform:uppercase; letter-spacing:0.1em; color:var(--dim); border:1px solid var(--border); padding:0.1em 0.5ch; display:inline-block; margin-bottom:0.3em; }
      .org-coll-card .title { font-size:0.85em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .org-coll-card .artist { font-size:0.75em; color:var(--dim); text-decoration:none; display:block; margin-top:0.2em; }

      /* --- Featured --- */
      .org-featured-label { display:flex; gap:1.5em; align-items:flex-start; padding:1.5em; border:1px solid var(--border); background:rgba(255,255,255,0.02); }
      .org-featured-label img { width:200px; height:200px; object-fit:cover; flex-shrink:0; border:1px solid var(--border); }
      .org-featured-label .info { flex:1; min-width:0; }
      .org-featured-label .title { font-size:1.3em; font-weight:600; margin-bottom:0.2em; }
      .org-featured-label .artist { font-size:0.9em; color:var(--dim); text-decoration:none; }

      .org-featured-gallery img { width:100%; max-height:500px; object-fit:cover; display:block; border:1px solid var(--border); }
      .org-featured-gallery .caption { font-size:0.85em; color:var(--dim); margin-top:0.5em; }

      .org-featured-company { position:relative; width:100%; aspect-ratio:16/9; overflow:hidden; border:1px solid var(--border); background:#000; }
      .org-featured-company video { width:100%; height:100%; object-fit:cover; }
      .org-featured-company .overlay { position:absolute; bottom:0; left:0; right:0; padding:1.5em; background:linear-gradient(transparent, rgba(0,0,0,0.85)); }
      .org-featured-company .overlay .title { font-size:1.4em; font-weight:600; color:#fff; text-transform:uppercase; letter-spacing:0.04em; }
      .org-featured-company .overlay .artist { font-size:0.85em; color:rgba(255,255,255,0.6); margin-top:0.3em; }

      .org-featured-pub { display:flex; gap:2em; padding:2em 0; align-items:flex-start; }
      .org-featured-pub .cover img { width:160px; aspect-ratio:2/3; object-fit:cover; border:1px solid var(--border); }
      .org-featured-pub .info { flex:1; }
      .org-featured-pub .title { font-family:Georgia,serif; font-size:1.6em; font-weight:400; margin-bottom:0.3em; }
      .org-featured-pub .artist { font-size:1em; color:var(--dim); font-style:italic; text-decoration:none; }

      /* --- Roster variants --- */
      .org-roster { display:grid; gap:1em; }
      .org-roster-label { grid-template-columns:repeat(auto-fill, minmax(140px, 1fr)); }
      .org-roster-gallery { grid-template-columns:repeat(auto-fill, minmax(160px, 1fr)); }
      .org-roster-company { grid-template-columns:repeat(auto-fill, minmax(160px, 1fr)); }
      .org-roster-publisher { grid-template-columns:1fr; max-width:500px; }
      .org-roster-collective { grid-template-columns:repeat(auto-fill, minmax(160px, 1fr)); }

      .org-member-card { border:1px solid var(--border); padding:0.8em; transition:border-color 0.15s; }
      .org-member-card:hover { border-color:var(--border-hover, rgba(255,255,255,0.18)); }
      .org-member-card a { text-decoration:none; color:var(--fg); display:block; }
      .org-member-card .name { font-size:0.95em; font-weight:500; color:var(--accent); }
      .org-member-card .wallet { font-size:0.7em; color:var(--dim); margin-top:0.3em; font-family:monospace; }

      .org-pub-member { display:flex; justify-content:space-between; align-items:baseline; padding:0.6em 0; border-bottom:1px solid var(--border); }
      .org-pub-member .name { font-family:Georgia,serif; font-size:0.95em; color:var(--accent); text-decoration:none; }
      .org-pub-member .wallet { font-size:0.7em; color:var(--dim); font-family:monospace; }

      /* Responsive */
      @media (max-width: 768px) {
        .org-gallery-masonry { columns:2; }
        .org-featured-label { flex-direction:column; }
        .org-featured-label img { width:100%; height:auto; aspect-ratio:1; }
        .org-featured-pub { flex-direction:column; }
        .org-featured-pub .cover img { width:100%; max-width:200px; }
      }
      @media (max-width: 480px) {
        .org-gallery-masonry { columns:1; }
        .org-label-grid { grid-template-columns:repeat(auto-fill, minmax(130px, 1fr)); }
        .org-poster-grid { grid-template-columns:repeat(auto-fill, minmax(110px, 1fr)); }
      }
    </style>
  `

  wireInvite(container, orgId, myAddr)
  wireRemoveButtons(container, orgId, myAddr, memberDomains, org.name)
  wireDissolve(container, orgId, myAddr)
  wireLeave(container, orgId, myAddr, org.name)
  loadCatalog(orgId, orgType)
}

// --- Catalog with infinite scroll ---

let _catalogCursor = null
let _catalogLoading = false
let _catalogObserver = null

async function loadCatalog(orgId, orgType) {
  const catalogEl = document.getElementById('org-catalog')
  const sentinel = document.getElementById('org-catalog-sentinel')
  const featured = document.getElementById('org-featured')
  if (!catalogEl) return
  if (_catalogLoading) return
  _catalogLoading = true

  try {
    const typeParam = ORG_TYPE_CONFIG[orgType]?.mediaFilter
    const url = `/api/org/${orgId}/catalog?limit=30${typeParam ? `&type=${typeParam}` : ''}${_catalogCursor ? `&after=${_catalogCursor}` : ''}`
    const res = await fetch(url)
    if (!res.ok) { catalogEl.innerHTML = '<p style="color:var(--dim);font-size:0.85em">no works yet</p>'; return }
    const data = await res.json()
    const items = data.items || []

    if (!items.length && !_catalogCursor) {
      catalogEl.innerHTML = '<p style="color:var(--dim);font-size:0.85em">no works yet</p>'
      return
    }

    // First load: render featured item
    if (!_catalogCursor && items.length && featured) {
      featured.innerHTML = renderFeatured(items[0], orgType)
      wireBuyButtons(featured)
    }

    const html = renderCatalog(_catalogCursor ? items : items.slice(1), orgType)
    if (_catalogCursor) {
      catalogEl.insertAdjacentHTML('beforeend', html)
    } else {
      catalogEl.innerHTML = html
    }

    wireBuyButtons(catalogEl)

    // Infinite scroll
    if (data.pageInfo?.hasNextPage) {
      _catalogCursor = data.pageInfo.endCursor
      if (sentinel && !_catalogObserver) {
        _catalogObserver = new IntersectionObserver(entries => {
          if (entries[0].isIntersecting && !_catalogLoading) loadCatalog(orgId, orgType)
        }, { rootMargin: '400px' })
        _catalogObserver.observe(sentinel)
      }
    } else if (_catalogObserver) {
      _catalogObserver.disconnect()
      _catalogObserver = null
    }
  } catch {
    if (!_catalogCursor) catalogEl.innerHTML = '<p style="color:var(--dim);font-size:0.85em">failed to load catalog</p>'
  } finally {
    _catalogLoading = false
  }
}

function wireBuyButtons(el) {
  el.querySelectorAll('.org-buy-btn:not([data-wired])').forEach(btn => {
    btn.dataset.wired = '1'
    btn.addEventListener('click', async (e) => {
      e.stopPropagation()
      const mediaId = btn.dataset.mediaId
      const price = btn.dataset.price
      try {
        btn.textContent = 'confirm...'
        btn.disabled = true
        const { purchaseMedia } = await import('./media.js')
        await purchaseMedia(mediaId, price)
        btn.textContent = 'collected'
        btn.style.borderColor = 'var(--green,#4a4)'
        btn.style.color = 'var(--green,#4a4)'
      } catch (e) {
        btn.disabled = false
        btn.textContent = e.code === 4001 ? formatPrice(price) : 'failed'
        setTimeout(() => { btn.textContent = formatPrice(price) }, 2000)
      }
    })
  })
}

function formatPrice(wei) {
  const bi = BigInt(wei)
  if (bi === 0n) return 'free'
  const whole = bi / 10n**18n
  const frac = bi % 10n**18n
  const eth = Number(whole) + Number(frac) / 1e18
  if (eth < 0.001) return `${(eth * 1e6).toFixed(0)}μΞ`
  if (eth < 1) return `${eth.toFixed(4)}Ξ`
  return `${eth.toFixed(2)}Ξ`
}

function buyBtn(item) {
  const price = BigInt(item.price || 0)
  if (price <= 0n) return ''
  return `<button class="buy-btn org-buy-btn" data-media-id="${item.id}" data-price="${item.price}" style="font-size:0.8em;padding:0.3em 1ch">${formatPrice(item.price)}</button>`
}

function artistLink(item) {
  const name = escapeHtml(item.artistDomain || `${(item.artist || '').slice(0, 8)}...`)
  const href = item.artistDomain ? `https://${escapeHtml(item.artistDomain)}` : '#'
  return `<a href="${href}" class="artist" style="color:var(--dim);text-decoration:none">${name}</a>`
}

function itemImg(item, w) {
  const cid = item.metadataCid || item.ipfsCid
  if (!cid) return ''
  return `/api/img?url=${encodeURIComponent(ipfsUrl(cid))}&w=${w}`
}

// --- Featured renderers ---

function renderFeatured(item, orgType) {
  if (!item) return ''
  const title = escapeHtml(item.title || 'untitled')
  const img = itemImg(item, 400)
  const artist = artistLink(item)

  if (orgType === 'label') {
    const isAudio = (item.contentType || '').includes('audio')
    return `<div class="org-featured-label">
      ${img ? `<img src="${escapeHtml(img)}" alt="${title}" loading="lazy">` : '<div style="width:200px;height:200px;background:var(--surface);border:1px solid var(--border);flex-shrink:0"></div>'}
      <div class="info">
        <div class="title">${title}</div>
        <div style="margin-bottom:0.8em">${artist}</div>
        ${isAudio ? `<button class="track-play-btn" data-track-src="${escapeHtml(ipfsUrl(item.ipfsCid))}" data-track-title="${title}" data-track-artist="${escapeHtml(item.artistDomain || '')}" style="padding:0.5em 1.5ch;border:1px solid var(--border);background:transparent;color:var(--fg);cursor:pointer;font-family:inherit;font-size:0.85em">▶ play</button>` : ''}
        <span style="margin-left:0.5em">${buyBtn(item)}</span>
      </div>
    </div>`
  }

  if (orgType === 'gallery') {
    return `<div class="org-featured-gallery">
      ${img ? `<img src="${itemImg(item, 1200)}" alt="${title}" loading="lazy">` : ''}
      <div class="caption">${title} — ${artist} ${buyBtn(item)}</div>
    </div>`
  }

  if (orgType === 'company') {
    const isVideo = (item.contentType || '').includes('video')
    if (isVideo && item.ipfsCid) {
      return `<div class="org-featured-company">
        <video src="${escapeHtml(ipfsUrl(item.ipfsCid))}" preload="none" playsinline controls poster="${img ? escapeHtml(img) : ''}"></video>
        <div class="overlay"><div class="title">${title}</div><div class="artist">${escapeHtml(item.artistDomain || '')}</div></div>
      </div>`
    }
    return `<div class="org-featured-company" style="display:flex;align-items:center;justify-content:center">
      ${img ? `<img src="${escapeHtml(itemImg(item, 1100))}" alt="${title}" style="width:100%;height:100%;object-fit:cover">` : ''}
      <div class="overlay"><div class="title">${title}</div><div class="artist">${escapeHtml(item.artistDomain || '')}</div></div>
    </div>`
  }

  if (orgType === 'publisher') {
    return `<div class="org-featured-pub">
      ${img ? `<div class="cover"><img src="${escapeHtml(img)}" alt="${title}" loading="lazy"></div>` : ''}
      <div class="info">
        <div class="title">${title}</div>
        <div style="margin:0.3em 0 0.8em">${artist}</div>
        ${buyBtn(item)}
      </div>
    </div>`
  }

  // collective — simple card
  return img ? `<div style="margin-bottom:0.5em">
    <img src="${escapeHtml(itemImg(item, 1000))}" alt="${title}" style="width:100%;max-height:400px;object-fit:cover;display:block;border:1px solid var(--border)" loading="lazy">
    <div style="padding:0.5em 0;font-size:0.9em">${title} — ${artist} ${buyBtn(item)}</div>
  </div>` : ''
}

// --- Catalog renderers per type ---

function renderCatalog(items, orgType) {
  if (!items.length) return ''
  if (orgType === 'label') return renderLabelCatalog(items)
  if (orgType === 'gallery') return renderGalleryCatalog(items)
  if (orgType === 'company') return renderCompanyCatalog(items)
  if (orgType === 'publisher') return renderPublisherCatalog(items)
  return renderCollectiveCatalog(items)
}

function renderLabelCatalog(items) {
  return `<div class="org-label-grid">${items.map(item => {
    const img = itemImg(item, 320)
    const title = escapeHtml(item.title || 'untitled')
    const isAudio = (item.contentType || '').includes('audio')
    return `<div class="org-label-card">
      <div style="position:relative">
        ${img ? `<img src="${escapeHtml(img)}" alt="${title}" loading="lazy">` : `<div style="width:100%;aspect-ratio:1;background:var(--surface);border:1px solid var(--border)"></div>`}
        ${isAudio ? `<button class="track-play-btn" data-track-src="${escapeHtml(ipfsUrl(item.ipfsCid))}" data-track-title="${title}" data-track-artist="${escapeHtml(item.artistDomain || '')}" style="position:absolute;bottom:6px;right:6px;width:36px;height:36px;border-radius:50%;border:1px solid rgba(255,255,255,0.3);background:rgba(0,0,0,0.6);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:0.8em">▶</button>` : ''}
      </div>
      <div class="meta">
        <div class="title">${title}</div>
        ${artistLink(item)}
        ${BigInt(item.price || 0) > 0n ? `<div style="margin-top:0.3em">${buyBtn(item)}</div>` : ''}
      </div>
    </div>`
  }).join('')}</div>`
}

function renderGalleryCatalog(items) {
  return `<div class="org-gallery-masonry">${items.map(item => {
    const img = itemImg(item, 600)
    if (!img) return ''
    const title = escapeHtml(item.title || 'untitled')
    return `<div class="org-gallery-item">
      <img src="${escapeHtml(img)}" alt="${title}" loading="lazy">
      <div class="overlay">
        <div>
          <div class="title">${title}</div>
          <div class="artist">${escapeHtml(item.artistDomain || '')}</div>
        </div>
        ${BigInt(item.price || 0) > 0n ? `<div>${buyBtn(item)}</div>` : ''}
      </div>
    </div>`
  }).join('')}</div>`
}

function renderCompanyCatalog(items) {
  return `<div class="org-poster-grid">${items.map(item => {
    const img = itemImg(item, 280)
    const title = escapeHtml(item.title || 'untitled')
    return `<div class="org-poster-card">
      ${img ? `<img class="poster" src="${escapeHtml(img)}" alt="${title}" loading="lazy">` : `<div class="poster-placeholder">${escapeHtml(item.contentType || '—')}</div>`}
      <div class="meta">
        <div class="title">${title}</div>
        ${artistLink(item)}
        ${BigInt(item.price || 0) > 0n ? `<div style="margin-top:0.3em">${buyBtn(item)}</div>` : ''}
      </div>
    </div>`
  }).join('')}</div>`
}

function renderPublisherCatalog(items) {
  return `<div class="org-pub-list">${items.map(item => {
    const img = itemImg(item, 240)
    const title = escapeHtml(item.title || 'untitled')
    return `<div class="org-pub-item">
      ${img ? `<div class="cover"><img src="${escapeHtml(img)}" alt="${title}" loading="lazy"></div>` : ''}
      <div class="info">
        <div class="title">${title}</div>
        ${artistLink(item)}
        ${BigInt(item.price || 0) > 0n ? `<div style="margin-top:0.6em">${buyBtn(item)}</div>` : ''}
      </div>
    </div>`
  }).join('')}</div>`
}

function renderCollectiveCatalog(items) {
  return `<div class="org-coll-grid">${items.map(item => {
    const img = itemImg(item, 400)
    const isAudio = (item.contentType || '').includes('audio')
    const title = escapeHtml(item.title || 'untitled')
    const typeLabel = (item.contentType || 'other').replace('/', ' ')
    return `<div class="org-coll-card">
      ${img ? `<img class="media" src="${escapeHtml(img)}" alt="${title}" loading="lazy">` : isAudio ? `<div class="media" style="display:flex;align-items:center;justify-content:center;background:var(--surface)"><button class="track-play-btn" data-track-src="${escapeHtml(ipfsUrl(item.ipfsCid))}" data-track-title="${title}" data-track-artist="${escapeHtml(item.artistDomain || '')}" style="width:48px;height:48px;border-radius:50%;border:1px solid var(--border);background:transparent;color:var(--fg);cursor:pointer;font-size:1.2em">▶</button></div>` : `<div class="media" style="background:var(--surface);display:flex;align-items:center;justify-content:center;color:var(--dim);font-size:0.8em">${escapeHtml(typeLabel)}</div>`}
      <div class="body">
        <span class="type-badge">${escapeHtml(typeLabel)}</span>
        <div class="title">${title}</div>
        ${artistLink(item)}
        ${BigInt(item.price || 0) > 0n ? `<div style="margin-top:0.4em">${buyBtn(item)}</div>` : ''}
      </div>
    </div>`
  }).join('')}</div>`
}

// --- Roster ---

function renderRoster(members, domainMap, isAdmin, orgId, orgType, pics = {}, names = {}) {
  if (!members.length) return '<p style="color:var(--dim);font-size:0.85em">no members yet</p>'

  if (orgType === 'publisher') {
    return members.map(m => {
      const wallet = (m.wallet || m).toLowerCase()
      const domain = domainMap[wallet]
      const name = names[wallet] || getArtistName(wallet)
      const display = name ? escapeHtml(name) : (domain ? escapeHtml(domain) : `${wallet.slice(0, 6)}...${wallet.slice(-4)}`)
      const href = domain ? `https://${escapeHtml(domain)}` : '#'
      return `<div class="org-pub-member">
        <a href="${href}" class="name">${display}</a>
        <span class="wallet">${domain ? escapeHtml(domain) : `${wallet.slice(0, 10)}...`}</span>
        ${isAdmin ? `<button class="org-remove-btn" data-wallet="${wallet}" style="margin-left:1ch;font-size:0.7em;color:var(--dim);background:transparent;border:1px solid var(--border);padding:0.2em 0.8ch;cursor:pointer;font-family:inherit">remove</button>` : ''}
      </div>`
    }).join('')
  }

  return members.map(m => {
    const wallet = (m.wallet || m).toLowerCase()
    const domain = domainMap[wallet]
    const name = names[wallet] || getArtistName(wallet)
    const display = name ? escapeHtml(name) : (domain ? escapeHtml(domain) : `${wallet.slice(0, 6)}...${wallet.slice(-4)}`)
    const href = domain ? `https://${escapeHtml(domain)}` : '#'
    const pic = pics[wallet] || getProfilePic(wallet)
    const picHtml = pic ? `<img src="${escapeHtml(pic)}" style="width:48px;height:48px;border-radius:50%;object-fit:cover;margin-bottom:0.4em" loading="lazy" onerror="this.style.display='none'">` : ''
    return `<div class="org-member-card">
      <a href="${href}">
        ${picHtml}
        <div class="name">${display}</div>
        <div class="wallet" style="font-size:0.75em;color:var(--dim)">${domain ? escapeHtml(domain) : `${wallet.slice(0, 10)}...`}</div>
      </a>
      ${isAdmin ? `<button class="org-remove-btn" data-wallet="${wallet}" style="margin-top:0.5em;font-size:0.7em;color:var(--dim);background:transparent;border:1px solid var(--border);padding:0.2em 0.8ch;cursor:pointer;font-family:inherit">remove</button>` : ''}
    </div>`
  }).join('')
}

// --- Admin wiring ---

function wireInvite(container, orgId, myAddr) {
  const inviteBtn = container.querySelector('#org-invite-btn')
  const inviteInput = container.querySelector('#org-invite-input')
  const inviteStatus = container.querySelector('#org-invite-status')
  const suggest = container.querySelector('#org-invite-suggest')
  if (!inviteBtn) return

  let _debounce = null
  let _selectedWallet = null

  inviteInput?.addEventListener('input', () => {
    _selectedWallet = null
    clearTimeout(_debounce)
    const q = inviteInput.value.trim()
    if (q.length < 2 || q.startsWith('0x')) { suggest.style.display = 'none'; return }
    _debounce = setTimeout(async () => {
      try {
        const r = await fetch(`/api/network/search?q=${encodeURIComponent(q)}&limit=6`)
        const data = await r.json()
        const items = (data.results || data.items || data || []).filter(a => a.id?.toLowerCase() !== myAddr)
        if (!items.length) { suggest.style.display = 'none'; return }
        suggest.innerHTML = items.map(a => {
          const domain = escapeHtml(a.domain || a.name || '')
          const short = a.id ? `${a.id.slice(0, 6)}...${a.id.slice(-4)}` : ''
          return `<div class="org-suggest-item" data-wallet="${escapeHtml(a.id || '')}" data-domain="${domain}" style="padding:0.5em 0.8em;cursor:pointer;display:flex;justify-content:space-between;align-items:center;font-size:0.9em;border-bottom:1px solid var(--border)">
            <span style="color:var(--fg)">${domain}</span>
            <span style="color:var(--dim);font-size:0.8em">${escapeHtml(short)}</span>
          </div>`
        }).join('')
        suggest.style.display = 'block'
        suggest.querySelectorAll('.org-suggest-item').forEach(item => {
          item.addEventListener('click', () => {
            inviteInput.value = item.dataset.domain
            _selectedWallet = item.dataset.wallet
            suggest.style.display = 'none'
          })
          item.addEventListener('mouseenter', () => { item.style.background = 'rgba(255,255,255,0.05)' })
          item.addEventListener('mouseleave', () => { item.style.background = '' })
        })
      } catch { suggest.style.display = 'none' }
    }, 250)
  })

  document.addEventListener('click', (e) => {
    if (!suggest.contains(e.target) && e.target !== inviteInput) suggest.style.display = 'none'
  })

  inviteBtn.addEventListener('click', async () => {
    suggest.style.display = 'none'
    const raw = inviteInput?.value?.trim()
    if (!raw) { inviteStatus.textContent = 'enter a domain or wallet address'; return }

    let targetWallet = _selectedWallet || null
    if (!targetWallet) {
      if (raw.startsWith('0x')) {
        targetWallet = raw
      } else {
        inviteStatus.textContent = 'resolving...'
        try {
          const r = await fetch(`/api/network/search?q=${encodeURIComponent(raw)}&limit=5`)
          const data = await r.json()
          const items = data.results || data.items || data || []
          const match = items.find(a =>
            (a.domain || a.name || '').toLowerCase() === raw.toLowerCase() ||
            (a.handle || '').toLowerCase() === raw.toLowerCase().replace(/\.[a-z]+$/, '')
          ) || items[0]
          if (!match?.id) { inviteStatus.textContent = `could not find "${escapeHtml(raw)}"`; return }
          targetWallet = match.id
        } catch { inviteStatus.textContent = 'failed to resolve'; return }
      }
    }

    if (!/^0x[0-9a-fA-F]{40}$/.test(targetWallet)) { inviteStatus.textContent = 'invalid wallet address'; return }

    try {
      inviteStatus.textContent = 'confirm in wallet...'
      if (!await window.ensureOptimism?.()) { inviteStatus.textContent = 'wallet not connected'; return }
      const { createWalletClient, custom, optimism } = await import('./vendor.js')
      const wc = createWalletClient({ chain: optimism, transport: custom(window.getWalletProvider()) })
      const hash = await wc.writeContract({
        address: ORG_ADDRESS, abi: ORG_ABI, functionName: 'inviteMember',
        args: [BigInt(orgId), targetWallet], account: myAddr,
      })
      inviteStatus.textContent = 'waiting for confirmation...'
      const pc = await getPublicClient()
      await pc.waitForTransactionReceipt({ hash })
      inviteStatus.style.color = 'var(--green,#4a4)'
      inviteStatus.textContent = 'invite sent!'
      inviteInput.value = ''
      _selectedWallet = null
      setTimeout(() => { inviteStatus.style.color = ''; inviteStatus.textContent = '' }, 3000)
    } catch (e) {
      inviteStatus.style.color = '#ef4444'
      inviteStatus.textContent = e.code === 4001 ? 'cancelled' : `error: ${(e.shortMessage || e.message || '').slice(0, 80)}`
    }
  })
  inviteInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') inviteBtn.click() })
}

function wireRemoveButtons(container, orgId, myAddr, memberDomains, orgName) {
  container.querySelectorAll('.org-remove-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const wallet = btn.dataset.wallet
      if (!wallet) return
      const display = memberDomains[wallet.toLowerCase()] || `${wallet.slice(0, 6)}...${wallet.slice(-4)}`
      if (!confirm(`remove ${display} from ${orgName}?`)) return
      try {
        btn.textContent = '...'
        if (!await window.ensureOptimism?.()) return
        const { createWalletClient, custom, optimism } = await import('./vendor.js')
        const wc = createWalletClient({ chain: optimism, transport: custom(window.getWalletProvider()) })
        const hash = await wc.writeContract({
          address: ORG_ADDRESS, abi: ORG_ABI, functionName: 'removeMember',
          args: [BigInt(orgId), wallet], account: myAddr,
        })
        const pc = await getPublicClient()
        await pc.waitForTransactionReceipt({ hash })
        btn.closest('.org-member-card, .org-pub-member')?.remove()
      } catch (e) {
        btn.textContent = 'remove'
        if (e.code !== 4001) alert(`error: ${e.shortMessage || e.message}`)
      }
    })
  })
}

function wireDissolve(container, orgId, myAddr) {
  container.querySelector('#org-dissolve-btn')?.addEventListener('click', async () => {
    if (!confirm('permanently dissolve this organization? this cannot be undone.')) return
    const btn = container.querySelector('#org-dissolve-btn')
    try {
      btn.textContent = 'confirm in wallet...'
      if (!await window.ensureOptimism?.()) { btn.textContent = 'dissolve organization'; return }
      const { createWalletClient, custom, optimism } = await import('./vendor.js')
      const wc = createWalletClient({ chain: optimism, transport: custom(window.getWalletProvider()) })
      const hash = await wc.writeContract({
        address: ORG_ADDRESS, abi: ORG_ABI, functionName: 'dissolveOrg',
        args: [BigInt(orgId)], account: myAddr,
      })
      const pc = await getPublicClient()
      await pc.waitForTransactionReceipt({ hash })
      location.reload()
    } catch (e) {
      btn.textContent = 'dissolve organization'
      if (e.code !== 4001) alert(`error: ${e.shortMessage || e.message}`)
    }
  })
}

function wireLeave(container, orgId, myAddr, orgName) {
  container.querySelector('#org-leave-btn')?.addEventListener('click', async () => {
    if (!confirm(`leave "${orgName}"?`)) return
    const btn = container.querySelector('#org-leave-btn')
    try {
      btn.textContent = 'confirm in wallet...'
      if (!await window.ensureOptimism?.()) { btn.textContent = 'leave organization'; return }
      const { createWalletClient, custom, optimism } = await import('./vendor.js')
      const wc = createWalletClient({ chain: optimism, transport: custom(window.getWalletProvider()) })
      const hash = await wc.writeContract({
        address: ORG_ADDRESS, abi: ORG_ABI, functionName: 'leaveOrg',
        args: [BigInt(orgId)], account: myAddr,
      })
      const pc = await getPublicClient()
      await pc.waitForTransactionReceipt({ hash })
      location.reload()
    } catch (e) {
      btn.textContent = 'leave organization'
      if (e.code !== 4001) alert(`error: ${e.shortMessage || e.message}`)
    }
  })
}
