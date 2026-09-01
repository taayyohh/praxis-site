// Shared feed card renderers — used by both artist feed (feed.js) and landing (landing.js)
import { escapeHtml as esc, getProfilePic, getArtistName, slugify } from './utils.js'
const DELIST_PRICE_SENTINEL = 2n ** 128n
let t = (k) => k // fallback
try { const i18n = await import('./i18n.js'); t = i18n.t } catch {}

function avatarOverlay(addr, explicitPic) {
  const pic = explicitPic || getProfilePic(addr)
  if (!pic) return ''
  return `<img src="${esc(pic)}" class="feed-card-avatar" style="position:absolute;bottom:8px;left:8px;width:32px;height:32px;border-radius:50%;object-fit:cover;border:2px solid rgba(255,255,255,0.9);box-shadow:0 1px 6px rgba(0,0,0,0.5);z-index:3" loading="lazy" onerror="this.style.display='none'">`
}

function inlineAvatar(addr, explicitPic) {
  const pic = explicitPic || getProfilePic(addr)
  if (!pic) return ''
  return `<img src="${esc(pic)}" style="width:24px;height:24px;border-radius:50%;object-fit:cover;flex-shrink:0" loading="lazy" onerror="this.style.display='none'">`
}

function resolveDisplay(addr, resolve, explicitName) {
  return explicitName || getArtistName(addr) || resolve(addr)
}

// Consistent buy button: green solid bg
function buyBtnHtml(mediaId, price, title, opts = {}) {
  let pw = 0n; try { pw = BigInt(price || '0') } catch {}
  if (pw <= 0n) return opts.showFree ? '<span style="color:var(--green);font-size:0.8em">free</span>' : ''
  const ids = opts.ids || mediaId
  const prices = opts.prices || price
  return `<button class="feed-buy-btn feed-card-btn green" data-media-id="${esc(ids)}" data-price="${esc(price)}" ${opts.prices ? `data-prices="${esc(prices)}"` : ''} data-title="${esc(title)}">buy</button>`
}
// Price label for next to title
function priceLabelHtml(price) {
  let pw = 0n; try { pw = BigInt(price || '0') } catch {}
  if (pw <= 0n) return ''
  return ` — <span class="feed-price-label" data-eth-wei="${esc(price)}" data-fiat-primary="true"></span>`
}

// Global buy button delegation — any page importing this module gets buy button handling
if (typeof document !== 'undefined') {
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.feed-buy-btn')
    if (!btn) return
    e.preventDefault()
    e.stopPropagation()
    const mediaId = btn.dataset.mediaId
    const price = btn.dataset.price
    const prices = btn.dataset.prices || ''
    const title = btn.dataset.title || 'untitled'
    if (!mediaId || !price) return
    const { showPurchaseConfirmation } = await import('./pay.js')
    showPurchaseConfirmation(mediaId, price, title, { prices })
  })

  // Video play button delegation — uses data attributes instead of inline onclick (XSS-safe)
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.video-play-btn')
    if (!btn) return
    e.preventDefault()
    e.stopPropagation()
    const src = btn.dataset.videoSrc
    const title = btn.dataset.videoTitle || ''
    if (src && window.playVideo) window.playVideo(src, title)
  })

  // Auto-bridge + auto-purchase after returning from Stripe funding page
  if (new URLSearchParams(window.location.search).has('funded')) {
    const clean = window.location.href.replace(/[?&]funded=1/, '').replace(/\?$/, '')
    history.replaceState(null, '', clean)
    const pending = sessionStorage.getItem('praxis-pending-purchase')
    if (pending) {
      sessionStorage.removeItem('praxis-pending-purchase')
      const parsed = JSON.parse(pending)
      const isFundOnly = parsed.type === 'fund-only'
      const { mediaId, priceWei, title } = parsed

      if (!window._autoSwapInFlight) {
      window._autoSwapInFlight = true

      const overlay = document.createElement('div')
      overlay.className = 'wizard-overlay'
      overlay.style.cssText = 'z-index:10001;align-items:center;justify-content:center'
      overlay.innerHTML = `
        <div style="max-width:400px;width:100%;padding:2em;text-align:center">
          <div id="autobridge-status" style="color:var(--fg);font-size:1.1em;margin-bottom:1em">${t('pay.bridging')}</div>
          <div id="autobridge-sub" style="color:var(--muted);font-size:0.8em">${t('pay.bridgingTime')}</div>
          <button id="autobridge-dismiss" style="margin-top:1.5em;background:none;border:1px solid var(--border);color:var(--muted);padding:0.4em 1.2em;border-radius:4px;cursor:pointer;display:none">dismiss</button>
        </div>`
      document.body.appendChild(overlay)
      const statusEl = overlay.querySelector('#autobridge-status')
      const subEl = overlay.querySelector('#autobridge-sub')
      const dismissBtn = overlay.querySelector('#autobridge-dismiss')

      let aborted = false
      dismissBtn.addEventListener('click', () => { aborted = true; overlay.remove(); window._autoSwapInFlight = false })
      setTimeout(() => { if (dismissBtn) dismissBtn.style.display = 'inline-block' }, 10000)

      ;(async () => {
        try {
          const addr = await window.ensureAuthorized?.() || window.getWalletAddress?.()
          if (!addr) throw new Error('wallet not available')

          const { getPublicClient } = await import('./utils.js')
          const pc = await getPublicClient()

          const USDC_OP = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85'
          const ERC20_ABI = [{ name: 'balanceOf', type: 'function', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }]

          statusEl.textContent = 'waiting for USDC...'
          let usdcBal = 0n
          const start = Date.now()
          let pollInterval = 5000
          while (Date.now() - start < 120000 && !aborted) {
            try {
              usdcBal = await pc.readContract({ address: USDC_OP, abi: ERC20_ABI, functionName: 'balanceOf', args: [addr] })
              if (usdcBal > 0n) break
              const ethBal = await pc.getBalance({ address: addr })
              if (!isFundOnly && ethBal >= BigInt(priceWei)) { usdcBal = 0n; break }
              if (isFundOnly && ethBal > 0n) { usdcBal = 0n; break }
            } catch (e) {
              console.warn('balance poll error:', e.message)
              pollInterval = Math.min(pollInterval * 1.5, 15000)
            }
            await new Promise(r => setTimeout(r, pollInterval))
          }

          if (aborted) return

          if (usdcBal > 0n) {
            statusEl.textContent = 'swapping USDC → ETH...'
            subEl.textContent = ''

            const { getQuote, execute } = await import('./vendor-relay.js')
            const quote = await getQuote({
              chainId: 10,
              toChainId: 10,
              currency: USDC_OP,
              toCurrency: '0x0000000000000000000000000000000000000000',
              amount: usdcBal.toString(),
              user: addr,
              recipient: addr,
              tradeType: 'EXACT_INPUT',
            })

            statusEl.textContent = 'confirm swap in wallet...'
            const { createWalletClient, http, custom, optimism } = await import('./vendor.js')
            const embeddedAcct = window.getEmbeddedAccount?.()
            let walletClient
            if (embeddedAcct) {
              walletClient = createWalletClient({ chain: optimism, account: embeddedAcct, transport: http('/api/rpc/10') })
            } else {
              const provider = window.getWalletProvider?.() || window.ethereum
              if (!provider) throw new Error('no wallet available')
              walletClient = createWalletClient({ chain: optimism, transport: custom(provider) })
            }

            let swapDone = false
            const swapTimeout = new Promise((_, rej) => setTimeout(() => rej(new Error('swap timed out')), 300000))
            await Promise.race([
              execute({
                quote,
                wallet: walletClient,
                onProgress: ({ currentStep, currentStepItem, error }) => {
                  if (error) { statusEl.textContent = `swap failed: ${error.message || 'unknown'}`; return }
                  if (currentStep?.id === 'approve') statusEl.textContent = 'approving USDC...'
                  else if (currentStepItem?.status === 'complete') { statusEl.textContent = 'swap complete'; swapDone = true }
                  else if (currentStepItem?.status === 'incomplete') statusEl.textContent = 'swapping...'
                },
              }),
              swapTimeout,
            ])

            if (!swapDone) {
              statusEl.textContent = 'waiting for ETH...'
              const requiredWei = isFundOnly ? 1n : BigInt(priceWei || '1')
              for (let i = 0; i < 30 && !aborted; i++) {
                await new Promise(r => setTimeout(r, 4000))
                try {
                  const ethBal = await pc.getBalance({ address: addr })
                  if (ethBal >= requiredWei) break
                } catch {}
              }
            } else {
              await new Promise(r => setTimeout(r, 2000))
            }
          }

          overlay.remove()
          window._autoSwapInFlight = false
          window.dispatchEvent(new CustomEvent('wallet-balance-changed'))

          if (!isFundOnly && mediaId && priceWei) {
            const { showPurchaseConfirmation } = await import('./pay.js')
            showPurchaseConfirmation(mediaId, priceWei, title)
          }
        } catch (e) {
          console.error('usdc-to-eth swap failed:', e)
          statusEl.textContent = 'swap failed'
          subEl.textContent = e.message || ''
          dismissBtn.style.display = 'inline-block'
          setTimeout(() => {
            overlay.remove()
            window._autoSwapInFlight = false
            if (!isFundOnly && mediaId && priceWei) {
              import('./pay.js').then(({ showPurchaseConfirmation }) => {
                showPurchaseConfirmation(mediaId, priceWei, title)
              })
            }
          }, 3000)
        }
      })()
      }
    }
  }
}

export function renderMediaCard(d, resolve) {
  let priceWei = 0n
  try { priceWei = BigInt(d.price || '0') } catch {}
  if (priceWei >= DELIST_PRICE_SENTINEL) return ''
  const artist = resolve(d.artist)
  const title = d.title || 'untitled'
  const artLink = d.artLink || `/art?media=${encodeURIComponent(d.mediaId)}`
  const cid = d.ipfsCid || ''
  const metaCid = d.metadataCid || ''
  const isVideo = d.contentType?.startsWith('video')
  const isPdf = d.contentType === 'application/pdf' || d.contentType?.startsWith('text/')
  // If contentType is empty but metadataCid exists, it's likely audio with cover art (MP3 with album art)
  const isAudio = d.contentType?.startsWith('audio') || d.contentType === 'application/ogg' || (!d.contentType && metaCid && !isPdf)
  const isUnknown = !d.contentType && !metaCid
  // Art source: metadata cover → image content → video thumbnail → generic thumb probe
  let artSrc = metaCid ? `/api/img?url=/api/ipfs-proxy/${encodeURIComponent(metaCid)}&w=200` : ''
  if (!artSrc && cid && d.contentType?.startsWith('image')) artSrc = `/api/img?url=/api/ipfs-proxy/${encodeURIComponent(cid)}&w=200`
  if (!artSrc && cid && isVideo) artSrc = `/api/video-thumb?cid=${encodeURIComponent(cid)}`
  const playBtn = isAudio && cid ? `<button class="track-play-btn" data-track-src="/api/ipfs-proxy/${encodeURIComponent(cid)}" data-track-title="${esc(title)}" data-track-artist="${esc(artist)}" data-track-art="${esc(artSrc)}" style="background:none;border:1px solid var(--border);color:var(--fg);width:28px;height:28px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:0.7em;flex-shrink:0"><i class="ph ph-play"></i></button>` : ''
  const buyBtn = buyBtnHtml(d.mediaId, d.price, title, { showFree: true })
  const isWideThumb = isVideo // only confirmed video gets wide layout
  const linkTarget = d.external ? 'target="_blank"' : ''
  const displayName = resolveDisplay(d.artist, resolve, d.artistName)
  const aPic = d.artistPic || null
  if (isWideThumb && artSrc) {
    const videoSrc = cid ? `/api/ipfs-proxy/${encodeURIComponent(cid)}` : ''
    return `
      <div class="feed-item" style="border:1px solid var(--border);border-radius:6px;overflow:hidden;padding:0">
        <div class="video-lazy" data-src="${esc(videoSrc)}" data-poster="${esc(artSrc)}" data-title="${esc(title)}" style="aspect-ratio:16/9;background:#000;position:relative;cursor:pointer;overflow:hidden">
          <img src="${esc(artSrc)}" alt="" loading="lazy" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block" onerror="this.style.display='none'">
          <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:56px;height:56px;border-radius:50%;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;pointer-events:none"><i class="ph ph-play" style="color:#fff;font-size:22px"></i></div>
          ${avatarOverlay(d.artist, aPic)}
        </div>
        <div class="feed-media-card-info">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span class="feed-author">${esc(displayName)}</span>
            <span style="color:var(--dim);font-size:0.8em">for sale</span>
          </div>
          <div style="display:flex;align-items:center;gap:0.4ch"><a href="${esc(artLink)}" ${linkTarget} style="color:var(--fg);font-weight:600;text-decoration:none;font-size:0.95em">${esc(title)}</a>${priceLabelHtml(d.price)}</div>
          <div class="feed-media-card-actions">${buyBtn}</div>
        </div>
      </div>
    `
  }
  if ((isUnknown || isPdf) && cid) {
    const mediaSrc = `/api/ipfs-proxy/${encodeURIComponent(cid)}`
    const coverSrc = metaCid ? `/api/img?url=/api/ipfs-proxy/${encodeURIComponent(metaCid)}&w=400` : ''
    return `
      <div class="feed-item" style="border:1px solid var(--border);border-radius:6px;overflow:hidden" data-pdf-thumb="${esc(mediaSrc)}">
        <div class="feed-pdf-thumb-slot" style="display:none"></div>
        <div style="padding:0.75em 1em">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.3em">
            <span class="feed-author" style="display:flex;align-items:center;gap:0.5ch">${inlineAvatar(d.artist, aPic)}${esc(displayName)}</span>
            <span style="color:var(--dim);font-size:0.8em">for sale</span>
          </div>
          <a href="#" class="feed-library-open" data-media-url="${esc(mediaSrc)}" data-title="${esc(title)}" style="color:var(--fg);font-weight:700;font-size:1.1em;text-decoration:none;display:block">${esc(title)}</a>
          ${priceLabelHtml(d.price)}
          <div style="margin-top:0.4em">${buyBtn}</div>
        </div>
      </div>
    `
  }
  const audioPlayOverlay = isAudio && cid ? `<button class="track-play-btn feed-collected-play-overlay" data-track-src="/api/ipfs-proxy/${encodeURIComponent(cid)}" data-track-title="${esc(title)}" data-track-artist="${esc(displayName)}" data-track-art="${esc(artSrc)}"><i class="ph ph-play"></i></button>` : ''
  return `
    <div class="feed-item feed-collected-card">
      <div class="feed-collected-art-wrap" style="position:relative${!artSrc ? ';display:flex;align-items:center;justify-content:center;background:var(--surface)' : ''}">
        ${artSrc ? `<a href="${esc(artLink)}" ${linkTarget}><img src="${esc(artSrc)}" alt="" loading="lazy"></a>` : `<a href="${esc(artLink)}" ${linkTarget} style="display:flex;align-items:center;justify-content:center;width:100%;height:100%"><i class="ph ph-file" style="font-size:2em;color:var(--muted)"></i></a>`}
        ${audioPlayOverlay}
        ${avatarOverlay(d.artist, aPic)}
      </div>
      <div class="feed-collected-body">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span class="feed-author">${esc(displayName)}</span>
          <span style="color:var(--dim);font-size:0.8em">for sale</span>
        </div>
        <div style="display:flex;align-items:center;gap:0.4ch"><a href="${esc(artLink)}" ${linkTarget} style="color:var(--fg);font-weight:600;text-decoration:none;font-size:0.95em">${esc(title)}</a>${priceLabelHtml(d.price)}</div>
        <div class="feed-collected-actions">${buyBtn}</div>
      </div>
    </div>
  `
}

export function renderBatchCard(d, resolve, opts = {}) {
  const artist = resolve(d.artist)
  let headline = d.headline || 'untitled'
  let albumPath = d.albumPath || null

  // Client-side album resolution from site modules (if available)
  if (!albumPath && opts.siteModules) {
    const trackTitles = new Set((d.items || []).map(it => (it.title || '').toLowerCase()).filter(Boolean))
    for (let mi = 0; mi < opts.siteModules.length; mi++) {
      if (albumPath) break
      const mod = opts.siteModules[mi]
      if (mod.type !== 'music') continue
      for (let ai = 0; ai < (mod.data?.aliases || []).length; ai++) {
        if (albumPath) break
        for (let bi = 0; bi < (mod.data.aliases[ai].albums || []).length; bi++) {
          const album = mod.data.aliases[ai].albums[bi]
          const albumTitles = (album.tracks || []).map(t => (t.title || '').toLowerCase()).filter(Boolean)
          const matches = albumTitles.filter(t => trackTitles.has(t)).length
          if (matches >= Math.min(trackTitles.size, albumTitles.length) * 0.5 && matches >= 2) {
            headline = album.title || headline
            albumPath = { alias: ai, album: bi, aliasName: mod.data.aliases[ai].name, albumTitle: album.title }
          }
        }
      }
    }
  }

  const firstItem = d.items?.[0]
  const aName = albumPath?.aliasName || d.aliasName || ''
  const aTitle = albumPath?.albumTitle || headline
  const slugUrl = (aName && aTitle) ? `/music/${slugify(aName)}/${slugify(aTitle)}` : null
  const artistBase = artist.includes('.') ? `https://${esc(artist)}` : ''
  const artLink = slugUrl
    ? `${artistBase}${slugUrl}`
    : (firstItem ? `${artistBase}/art?media=${encodeURIComponent(firstItem.mediaId)}` : '#')

  const metaCid = firstItem?.metadataCid || ''
  const artSrc = metaCid ? `/api/img?url=/api/ipfs-proxy/${encodeURIComponent(metaCid)}&w=280` : ''

  const sorted = [...(d.items || [])].sort((a, b) => {
    try { return Number(BigInt(a.mediaId) - BigInt(b.mediaId)) } catch { return 0 }
  })

  let totalWei = 0n
  for (const it of sorted) { try { totalWei += BigInt(it.price || '0') } catch {} }

  const tracklist = sorted.map((it, i) => {
    const cid = it.ipfsCid || ''
    let pw = 0n; try { pw = BigInt(it.price || '0') } catch {}
    const playBtn = cid ? `<button class="track-play-btn" data-track-src="/api/ipfs-proxy/${encodeURIComponent(cid)}" data-track-title="${esc(it.title || '')}" data-track-artist="${esc(artist)}" style="background:none;border:1px solid var(--border);color:var(--fg);width:24px;height:24px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:0.6em;flex-shrink:0"><i class="ph ph-play"></i></button>` : ''
    const buyBtn = pw > 0n ? `<button class="feed-buy-btn feed-card-btn green" data-media-id="${esc(String(it.mediaId))}" data-price="${esc(it.price)}" data-title="${esc(it.title || '')}" style="font-size:0.7em;padding:0.2em 0.6ch"><span data-eth-wei="${esc(it.price)}" data-fiat-primary="true"></span></button>` : ''
    return `<div class="feed-batch-track"><span class="feed-batch-track-num">${i + 1}</span>${playBtn}<a href="${artistBase}/art?media=${encodeURIComponent(it.mediaId)}" style="color:var(--fg);text-decoration:none;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(it.title || 'untitled')}</a>${buyBtn}</div>`
  }).join('')

  const albumBuyData = sorted.filter(it => { try { return BigInt(it.price || '0') > 0n } catch { return false } })
  const buyAlbumBtn = albumBuyData.length > 0 ? buyBtnHtml(albumBuyData[0].mediaId, String(totalWei), `${headline} (${sorted.length} tracks)`, { ids: albumBuyData.map(it => it.mediaId).join(','), prices: albumBuyData.map(it => it.price).join(',') }) : ''

  const playableTracks = sorted.filter(it => it.ipfsCid)
  let playAllBtn = ''
  if (playableTracks.length > 0) {
    const queueData = encodeURIComponent(JSON.stringify(playableTracks.map(it => ({
      src: `/api/ipfs-proxy/${it.ipfsCid}`,
      title: it.title || '',
      artist,
      art: artSrc || '',
    }))))
    playAllBtn = `<button class="album-play-btn feed-card-btn" data-queue="${queueData}"><i class="ph ph-play"></i> play</button>`
  }

  const aliasName = d.aliasName || ''
  const linkTarget = d.external ? ' target="_blank"' : ''
  return `
    <div class="feed-item feed-media-card feed-batch-card">
      ${artSrc ? `<a href="${esc(artLink)}"${linkTarget} class="feed-media-card-art" style="position:relative"><img src="${esc(artSrc)}" alt="" loading="lazy">${avatarOverlay(d.artist, d.artistPic)}</a>` : ''}
      <div class="feed-media-card-info">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span class="feed-author">${esc(aliasName || (getArtistName(d.artist) || artist))}</span>
          <span style="color:var(--dim);font-size:0.8em">${d.count || sorted.length} tracks</span>
        </div>
        <a href="${esc(artLink)}"${linkTarget} style="color:var(--fg);font-weight:600;text-decoration:none;font-size:0.95em">${esc(headline)}</a>
        <div class="feed-media-card-actions">${playAllBtn}${buyAlbumBtn}</div>
        <div class="feed-batch-tracklist">${tracklist}</div>
      </div>
    </div>
  `
}

export function renderFollowCard(d, resolve, opts = {}) {
  const follower = d.follower ? resolve(d.follower) : resolve(d.author)
  const followed = d.followed ? resolve(d.followed) : (d.target ? resolve(d.target) : resolve(d.refId))
  let followedDomain = d.followed ? resolve(d.followed) : followed
  if (followedDomain && !followedDomain.includes('.') && !followedDomain.startsWith('0x')) {
    followedDomain = followedDomain + '.ourpraxis.network'
  }
  const followedLink = followedDomain.includes('.') ? `https://${esc(followedDomain)}` : '#'
  const ogImg = followedDomain.includes('.') ? `<img src="https://${esc(followedDomain)}/og/index.png" style="width:100%;aspect-ratio:1200/630;max-height:220px;object-fit:cover;display:block;border-radius:6px 6px 0 0" loading="lazy" onerror="this.style.display='none'">` : ''
  const linkTarget = opts.external ? ' target="_blank"' : ''
  const fPic = getProfilePic(d.follower || d.author)
  return `
    <a href="${followedLink}"${linkTarget} class="feed-item" style="display:block;border:1px solid var(--border);border-radius:6px;text-decoration:none;color:inherit;padding:0;overflow:hidden">
      ${ogImg}
      <div style="padding:1em 1.25em;display:flex;align-items:center;gap:0.75em">
        ${fPic ? `<img src="${esc(fPic)}" style="width:28px;height:28px;border-radius:50%;object-fit:cover;flex-shrink:0" loading="lazy" onerror="this.style.display='none'">` : ''}
        <div style="font-size:0.95em;line-height:1.5"><span style="color:var(--accent);font-weight:600">${esc(follower)}</span> <span style="color:var(--muted)">followed</span> <span style="color:var(--accent);font-weight:600">${esc(followed)}</span></div>
      </div>
    </a>
  `
}

export function renderProjectCard(p, resolve, opts = {}) {
  const domain = resolve(p.proposer)
  const typeName = p.projectType || 'other'
  const statusLabels = ['proposed', 'funded', 'confirmed', 'completing', 'completed', 'cancelled', 'disputed']
  const statusColors = ['#c0c0c0', '#4ade80', '#60a5fa', '#fbbf24', '#a78bfa', '#666', '#ef4444']
  const statusIcons = ['ph-clock', 'ph-check-circle', 'ph-handshake', 'ph-spinner', 'ph-star', 'ph-x-circle', 'ph-warning']
  const pct = Number(p.fundingGoal) > 0 ? Math.round(Number(p.totalFunded) * 100 / Number(p.fundingGoal)) : 0
  const deadlineStr = p.deadline > 0 ? new Date(Number(p.deadline) * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''
  const linkTarget = opts.external ? ' target="_blank"' : ''

  return `
    <a href="/project?id=${p.id}"${linkTarget} class="feed-item" style="display:block;border:1px solid var(--border);border-radius:6px;text-decoration:none;color:inherit;padding:0;overflow:hidden">
      <div style="padding:1em 1.25em">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:0.15em">
          <span style="color:var(--accent);font-weight:700;font-size:1.1em;line-height:1.3">${esc(p.title)}</span>
          <span style="font-size:0.8em;color:${statusColors[p.status]};flex-shrink:0;margin-left:1ch">${statusLabels[p.status]}</span>
        </div>
        <div style="font-size:0.85em;color:var(--muted);line-height:1.5;display:flex;align-items:center;gap:0.4ch">
          ${inlineAvatar(p.proposer)}<span style="color:var(--fg)">${esc(domain)}</span>${deadlineStr ? ` · ${deadlineStr}` : ''}${typeName !== 'other' ? ` · ${esc(typeName)}` : ''}
        </div>
        ${p.description ? `<p style="color:var(--dim);font-size:0.85em;margin:0.5em 0 0;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(p.description).slice(0, 200)}</p>` : ''}
        <div style="margin-top:0.75em">
          <div style="background:var(--border);height:2px;border-radius:1px;overflow:hidden"><div style="background:var(--green);height:100%;width:${Math.min(pct, 100)}%"></div></div>
          <div style="font-size:0.8em;color:var(--dim);margin-top:0.4em">${pct}% funded · <span data-eth-wei="${esc(p.fundingGoal || '0')}" data-fiat-primary="true"></span> goal</div>
        </div>
      </div>
    </a>
  `
}

export function renderFundedCard(d, resolve, opts = {}) {
  const funder = resolve(d.funder)
  const linkTarget = opts.external ? ' target="_blank"' : ''
  const fPic = getProfilePic(d.funder)
  return `
    <a href="/project?id=${d.projectId}"${linkTarget} class="feed-item" style="display:block;border:1px solid var(--border);border-radius:6px;text-decoration:none;color:inherit;padding:0;overflow:hidden">
      <div style="padding:1em 1.25em;display:flex;align-items:center;gap:0.75em">
        ${fPic ? `<img src="${esc(fPic)}" style="width:28px;height:28px;border-radius:50%;object-fit:cover;flex-shrink:0" loading="lazy" onerror="this.style.display='none'">` : ''}
        <div style="flex:1;min-width:0">
          <div style="font-size:0.95em;line-height:1.5"><span style="color:var(--accent);font-weight:600">${esc(funder)}</span> <span style="color:var(--muted)">funded</span> <span style="color:var(--accent);font-weight:600">${esc(d.projectTitle)}</span>${d.amount && d.amount !== '0' ? ` <span style="color:var(--muted)">for</span> <span style="color:var(--fg)" data-eth-wei="${esc(d.amount)}" data-fiat-primary="true"></span>` : ''}</div>
        </div>
      </div>
    </a>
  `
}

export function renderPurchaseCard(d, resolve, opts = {}) {
  const buyer = resolve(d.buyer)
  const title = d.title || 'untitled'
  const linkTarget = opts.external ? ' target="_blank"' : ''
  const metaCid = d.metadataCid || ''
  const cid = d.ipfsCid || ''
  const isAudio = d.contentType?.startsWith('audio') || d.contentType === 'application/ogg' || (!d.contentType && metaCid)
  const isVideo = d.contentType?.startsWith('video')
  const isUnknown = !d.contentType && !metaCid
  let artSrc = metaCid ? `/api/img?url=/api/ipfs-proxy/${encodeURIComponent(metaCid)}&w=200` : ''
  if (!artSrc && cid && d.contentType?.startsWith('image')) artSrc = `/api/img?url=/api/ipfs-proxy/${encodeURIComponent(cid)}&w=200`
  if (!artSrc && cid && (isVideo || isUnknown)) artSrc = `/api/video-thumb?cid=${encodeURIComponent(cid)}`
  const isWideContent = isVideo || isUnknown
  const videoSrc = cid ? `/api/ipfs-proxy/${encodeURIComponent(cid)}` : ''
  if (isWideContent && artSrc && videoSrc) {
    // Video collected: full-width video-lazy on top (same as listing)
    return `
      <div class="feed-item" style="border:1px solid var(--border);border-radius:6px;overflow:hidden;padding:0">
        <div class="video-lazy" data-src="${esc(videoSrc)}" data-poster="${esc(artSrc)}" data-title="${esc(title)}" style="aspect-ratio:16/9;background:#000;position:relative;cursor:pointer;overflow:hidden">
          <img src="${esc(artSrc)}" alt="" loading="lazy" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block" onerror="this.style.display='none'">
          <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:56px;height:56px;border-radius:50%;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;pointer-events:none"><i class="ph ph-play" style="color:#fff;font-size:22px"></i></div>
          ${avatarOverlay(d.buyer)}
        </div>
        <div class="feed-media-card-info">
          <div style="color:var(--muted);font-size:0.8em;display:flex;align-items:center;gap:0.5ch">${inlineAvatar(d.buyer)}<span style="color:var(--fg)">${esc(buyer)}</span> collected</div>
          <a href="/art?media=${encodeURIComponent(d.mediaId)}"${linkTarget} style="color:var(--fg);font-weight:600;text-decoration:none;font-size:0.95em">${esc(title)}</a>
          <div class="feed-collected-actions">
            <a href="/art?media=${encodeURIComponent(d.mediaId)}"${linkTarget} class="feed-card-btn" style="text-decoration:none"><i class="ph ph-arrow-right"></i> view</a>
            ${buyBtnHtml(d.mediaId, d.price, title)}
          </div>
        </div>
      </div>
    `
  }
  // Audio/image collected: side-by-side
  const playOverlay = isAudio && cid ? `<button class="track-play-btn feed-collected-play-overlay" data-track-src="/api/ipfs-proxy/${encodeURIComponent(cid)}" data-track-title="${esc(title)}" data-track-artist="${esc(buyer)}" data-track-art="${esc(artSrc)}"><i class="ph ph-play"></i></button>` : ''
  return `
    <div class="feed-item feed-collected-card">
      <div class="feed-collected-art-wrap">
        ${artSrc ? `<a href="/art?media=${encodeURIComponent(d.mediaId)}"${linkTarget}><img src="${artSrc}" alt="" loading="lazy"></a>` : ''}
        ${playOverlay}
        ${avatarOverlay(d.buyer)}
      </div>
      <div class="feed-collected-body">
        <div style="color:var(--muted);font-size:0.8em;display:flex;align-items:center;gap:0.5ch">${inlineAvatar(d.buyer)}<span style="color:var(--fg)">${esc(buyer)}</span> collected</div>
        <a href="/art?media=${encodeURIComponent(d.mediaId)}"${linkTarget} style="color:var(--fg);font-weight:600;text-decoration:none;font-size:1em">${esc(title)}</a>
        <div class="feed-collected-actions">
          <a href="/art?media=${encodeURIComponent(d.mediaId)}"${linkTarget} class="feed-card-btn" style="text-decoration:none"><i class="ph ph-arrow-right"></i> view</a>
          ${buyBtnHtml(d.mediaId, d.price, title)}
        </div>
      </div>
    </div>
  `
}

export function renderPurchaseBatchCard(d, resolve, opts = {}) {
  const buyer = resolve(d.buyer)
  const artist = d.artist ? resolve(d.artist) : ''
  const headline = d.headline || 'untitled'
  const albumPath = d.albumPath
  const slugUrl2 = albumPath?.aliasName ? `/music/${slugify(albumPath.aliasName)}/${slugify(albumPath.albumTitle || headline)}` : null
  const artLink = slugUrl2
    ? (artist.includes('.') ? `https://${esc(artist)}${slugUrl2}` : slugUrl2)
    : '#'
  const firstItem = d.items?.[0]
  const metaCid = firstItem?.metadataCid || ''
  const artRaw = metaCid ? `/api/ipfs-proxy/${metaCid}` : ''
  const artSrc = metaCid ? `/api/img?url=${encodeURIComponent(artRaw)}&w=280` : ''
  const aliasName = d.aliasName || ''
  const displayArtist = aliasName || artist
  const sorted = [...(d.items || [])].sort((a, b) => {
    try { return Number(BigInt(a.mediaId) - BigInt(b.mediaId)) } catch { return 0 }
  })
  const playableTracks = sorted.filter(it => it.ipfsCid)
  let playOverlay = ''
  if (playableTracks.length > 0) {
    const queueData = encodeURIComponent(JSON.stringify(playableTracks.map(it => ({
      src: `/api/ipfs-proxy/${it.ipfsCid}`, title: it.title || '', artist: displayArtist, art: artRaw || '',
    }))))
    playOverlay = `<button class="album-play-btn feed-collected-play-overlay" data-queue="${queueData}"><i class="ph ph-play"></i></button>`
  }
  // Build album buy button with real prices (same pattern as listing batch card)
  const albumBuyData = sorted.filter(it => { try { return BigInt(it.price || '0') > 0n } catch { return false } })
  let totalWei = 0n
  for (const it of albumBuyData) { try { totalWei += BigInt(it.price || '0') } catch {} }
  const buyAlbumBtn = albumBuyData.length > 0
    ? buyBtnHtml(albumBuyData[0].mediaId, String(totalWei), `${headline} (${sorted.length} tracks)`, { ids: albumBuyData.map(it => it.mediaId).join(','), prices: albumBuyData.map(it => it.price).join(',') })
    : ''
  const linkTarget = opts.external ? ' target="_blank"' : ''
  const artistLink = artist.includes('.') ? `https://${esc(artist)}` : '#'
  return `
    <div class="feed-item feed-collected-card">
      <div class="feed-collected-art-wrap">
        ${artSrc ? `<a href="${esc(artLink)}"${linkTarget}><img src="${artSrc}" alt="" loading="lazy"></a>` : ''}
        ${playOverlay}
        ${avatarOverlay(d.buyer)}
      </div>
      <div class="feed-collected-body">
        <div style="color:var(--muted);font-size:0.8em;display:flex;align-items:center;gap:0.5ch">${inlineAvatar(d.buyer)}<span style="color:var(--fg)">${esc(buyer)}</span> collected</div>
        <a href="${esc(artLink)}"${linkTarget} style="color:var(--fg);font-weight:600;text-decoration:none;font-size:1em">${esc(headline)}</a>
        ${displayArtist ? `<a href="${artistLink}"${linkTarget} style="color:var(--muted);font-size:0.8em;text-decoration:none">${esc(displayArtist)}</a>` : ''}
        <div class="feed-collected-actions">
          <a href="${esc(artLink)}"${linkTarget} class="feed-card-btn" style="text-decoration:none"><i class="ph ph-arrow-right"></i> view</a>
          ${buyAlbumBtn}
        </div>
      </div>
    </div>
  `
}

export function renderSupporterCard(d, resolve, opts = {}) {
  const handle = d.handle
  const displayName = handle || resolve(d.wallet)
  const link = handle ? `https://${esc(handle)}.ourpraxis.network` : '#'
  const ogImg = handle ? `<img src="https://${esc(handle)}.ourpraxis.network/og/index.png" style="width:100%;aspect-ratio:1200/630;max-height:220px;object-fit:cover;display:block;border-radius:6px 6px 0 0" loading="lazy" onerror="this.style.display='none'">` : ''
  const linkTarget = opts.external ? ' target="_blank"' : ''
  const sPic = getProfilePic(d.wallet)
  return `
    <a href="${link}"${linkTarget} class="feed-item" style="display:block;border:1px solid var(--border);border-radius:6px;text-decoration:none;color:inherit;padding:0;overflow:hidden">
      ${ogImg}
      <div style="padding:1em 1.25em;display:flex;align-items:center;gap:0.75em">
        ${sPic ? `<img src="${esc(sPic)}" style="width:28px;height:28px;border-radius:50%;object-fit:cover;flex-shrink:0" loading="lazy" onerror="this.style.display='none'">` : ''}
        <div style="font-size:0.95em;line-height:1.5"><span style="color:var(--accent);font-weight:600">${esc(displayName)}</span> <span style="color:var(--muted)">joined the audience</span></div>
      </div>
    </a>
  `
}

export function renderJoinedCard(d, resolve, opts = {}) {
  let domain = d.domain || d.title || ''
  const fullDomain = domain.includes('.') ? domain : (domain && !domain.startsWith('0x') ? domain + '.ourpraxis.network' : '')
  const domainLink = fullDomain ? `https://${esc(fullDomain)}` : '#'
  const ogImg = fullDomain ? `<img src="https://${esc(fullDomain)}/og/index.png" style="width:100%;aspect-ratio:1200/630;max-height:220px;object-fit:cover;display:block;border-radius:6px 6px 0 0" loading="lazy" onerror="this.style.display='none'">` : ''
  const linkTarget = opts.external ? ' target="_blank"' : ''
  const jPic = getProfilePic(d.wallet || d.artist)
  return `
    <a href="${domainLink}"${linkTarget} class="feed-item" style="display:block;border:1px solid var(--border);border-radius:6px;text-decoration:none;color:inherit;padding:0;overflow:hidden">
      ${ogImg}
      <div style="padding:1em 1.25em;display:flex;align-items:center;gap:0.75em">
        ${jPic ? `<img src="${esc(jPic)}" style="width:28px;height:28px;border-radius:50%;object-fit:cover;flex-shrink:0" loading="lazy" onerror="this.style.display='none'">` : ''}
        <div style="font-size:0.95em;line-height:1.5"><span style="color:var(--accent);font-weight:600">${esc(domain)}</span> <span style="color:var(--muted)">joined the network</span></div>
      </div>
    </a>
  `
}

export function renderTicketListedCard(d, resolve, opts = {}) {
  const seller = resolveDisplay(d.seller, resolve)
  const linkTarget = opts.external ? ' target="_blank"' : ''
  const sPic = getProfilePic(d.seller)
  return `
    <a href="/tickets"${linkTarget} class="feed-item" style="display:block;border:1px solid var(--border);border-radius:6px;text-decoration:none;color:inherit;padding:0;overflow:hidden">
      <div style="padding:1em 1.25em;display:flex;align-items:center;gap:0.75em">
        ${sPic ? `<img src="${esc(sPic)}" style="width:28px;height:28px;border-radius:50%;object-fit:cover;flex-shrink:0" loading="lazy" onerror="this.style.display='none'">` : ''}
        <div style="flex:1;min-width:0">
          <div style="font-size:0.95em;line-height:1.5"><span style="color:var(--accent);font-weight:600">${esc(seller)}</span> <span style="color:var(--muted)">listed a ticket for</span> <span style="color:var(--accent);font-weight:600">${esc(d.eventName || 'an event')}</span>${d.price && d.price !== '0' ? ` <span style="color:var(--muted)">at</span> <span style="color:var(--fg)" data-eth-wei="${esc(d.price)}" data-fiat-primary="true"></span>` : ''}</div>
        </div>
      </div>
    </a>
  `
}

export function renderTicketPurchasedCard(d, resolve, opts = {}) {
  const buyer = resolveDisplay(d.buyer, resolve)
  const linkTarget = opts.external ? ' target="_blank"' : ''
  const bPic = getProfilePic(d.buyer)
  return `
    <a href="/tickets"${linkTarget} class="feed-item" style="display:block;border:1px solid var(--border);border-radius:6px;text-decoration:none;color:inherit;padding:0;overflow:hidden">
      <div style="padding:1em 1.25em;display:flex;align-items:center;gap:0.75em">
        ${bPic ? `<img src="${esc(bPic)}" style="width:28px;height:28px;border-radius:50%;object-fit:cover;flex-shrink:0" loading="lazy" onerror="this.style.display='none'">` : ''}
        <div style="flex:1;min-width:0">
          <div style="font-size:0.95em;line-height:1.5"><span style="color:var(--accent);font-weight:600">${esc(buyer)}</span> <span style="color:var(--muted)">got a ticket to</span> <span style="color:var(--accent);font-weight:600">${esc(d.eventName || 'an event')}</span></div>
        </div>
      </div>
    </a>
  `
}

export function renderTransferCard(d, resolve, opts = {}) {
  const domain = d.domain || resolve(d.newWallet) || resolve(d.oldWallet)
  return `
    <div class="feed-item" style="border:1px solid var(--border);border-radius:6px;overflow:hidden;padding:0">
      <div style="padding:1em 1.25em">
        <div style="font-size:0.95em;line-height:1.5"><span style="color:var(--accent);font-weight:600">${esc(domain)}</span> <span style="color:var(--muted)">moved to a new wallet</span></div>
      </div>
    </div>
  `
}

export function renderReferralCard(d, resolve, opts = {}) {
  const referrer = resolveDisplay(d.referrer, resolve)
  const referred = resolveDisplay(d.referred, resolve)
  let referredDomain = resolve(d.referred)
  if (referredDomain && !referredDomain.includes('.') && !referredDomain.startsWith('0x')) {
    referredDomain = referredDomain + '.ourpraxis.network'
  }
  const referredLink = referredDomain.includes('.') ? `https://${esc(referredDomain)}` : '#'
  const linkTarget = opts.external ? ' target="_blank"' : ''
  const rPic = getProfilePic(d.referred)
  return `
    <a href="${referredLink}"${linkTarget} class="feed-item" style="display:block;border:1px solid var(--border);border-radius:6px;text-decoration:none;color:inherit;padding:0;overflow:hidden">
      <div style="padding:1em 1.25em;display:flex;align-items:center;gap:0.75em">
        ${rPic ? `<img src="${esc(rPic)}" style="width:28px;height:28px;border-radius:50%;object-fit:cover;flex-shrink:0" loading="lazy" onerror="this.style.display='none'">` : ''}
        <div style="flex:1;min-width:0">
          <div style="font-size:0.95em;line-height:1.5"><span style="color:var(--accent);font-weight:600">${esc(referred)}</span> <span style="color:var(--muted)">was invited by</span> <span style="color:var(--accent);font-weight:600">${esc(referrer)}</span></div>
        </div>
      </div>
    </a>
  `
}

export function renderProjectCompletedCard(d, resolve, opts = {}) {
  const proposer = resolveDisplay(d.proposer, resolve)
  const linkTarget = opts.external ? ' target="_blank"' : ''
  return `
    <a href="/project?id=${esc(String(d.projectId))}"${linkTarget} class="feed-item" style="display:block;border:1px solid var(--border);border-radius:6px;text-decoration:none;color:inherit;padding:0;overflow:hidden">
      <div style="padding:1em 1.25em">
        <div style="color:var(--accent);font-weight:700;font-size:1.1em;line-height:1.3">${esc(d.title || 'untitled')}</div>
        <div style="font-size:0.85em;color:var(--muted);margin-top:0.3em;line-height:1.5;display:flex;align-items:center;gap:0.4ch">
          ${inlineAvatar(d.proposer)}<span style="color:var(--fg)">${esc(proposer)}</span>'s project completed${d.totalFunded && d.totalFunded !== '0' ? ` · <span data-eth-wei="${esc(d.totalFunded)}" data-fiat-primary="true"></span> funded` : ''}
        </div>
      </div>
    </a>
  `
}

export function renderProjectConfirmedCard(d, resolve, opts = {}) {
  const proposer = resolveDisplay(d.proposer, resolve)
  const linkTarget = opts.external ? ' target="_blank"' : ''
  const collabCount = d.collaboratorCount ? Number(d.collaboratorCount) : 0
  return `
    <a href="/project?id=${esc(String(d.projectId))}"${linkTarget} class="feed-item" style="display:block;border:1px solid var(--border);border-radius:6px;text-decoration:none;color:inherit;padding:0;overflow:hidden">
      <div style="padding:1em 1.25em">
        <div style="color:var(--accent);font-weight:700;font-size:1.1em;line-height:1.3">${esc(d.title || 'untitled')}</div>
        <div style="font-size:0.85em;color:var(--muted);margin-top:0.3em;line-height:1.5;display:flex;align-items:center;gap:0.4ch">
          ${inlineAvatar(d.proposer)}<span style="color:var(--fg)">${esc(proposer)}</span>'s project confirmed${collabCount ? ` · ${collabCount} collaborator${collabCount !== 1 ? 's' : ''}` : ''}
        </div>
      </div>
    </a>
  `
}

export function renderOrgCreatedCard(d, resolve, opts = {}) {
  const founder = resolveDisplay(d.founder, resolve)
  const fPic = getProfilePic(d.founder)
  return `
    <div class="feed-item" style="border:1px solid var(--border);border-radius:6px;overflow:hidden;padding:0">
      <div style="padding:1em 1.25em">
        <div style="font-size:0.95em;line-height:1.5;display:flex;align-items:center;gap:0.75em">
          ${fPic ? `<img src="${esc(fPic)}" style="width:28px;height:28px;border-radius:50%;object-fit:cover;flex-shrink:0" loading="lazy" onerror="this.style.display='none'">` : ''}
          <div><span style="color:var(--accent);font-weight:600">${esc(founder)}</span> <span style="color:var(--muted)">created</span> <span style="color:var(--accent);font-weight:700">${esc(d.name || 'an organization')}</span></div>
        </div>
        ${d.description ? `<div style="color:var(--dim);font-size:0.85em;margin-top:0.5em;line-height:1.6;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(d.description).slice(0, 160)}</div>` : ''}
      </div>
    </div>
  `
}

export function renderCredentialCard(d, resolve, opts = {}) {
  const recipient = resolveDisplay(d.recipient, resolve)
  const tierColors = { gold: '#fbbf24', silver: '#c0c0c0', bronze: '#cd7f32' }
  const tierColor = tierColors[(d.tier || '').toLowerCase()] || 'var(--accent)'
  const rPic = getProfilePic(d.recipient)
  return `
    <div class="feed-item" style="border:1px solid var(--border);border-radius:6px;overflow:hidden;padding:0">
      <div style="padding:1em 1.25em">
        <div style="font-size:0.95em;line-height:1.5;display:flex;align-items:center;gap:0.75em">
          ${rPic ? `<img src="${esc(rPic)}" style="width:28px;height:28px;border-radius:50%;object-fit:cover;flex-shrink:0" loading="lazy" onerror="this.style.display='none'">` : ''}
          <div><span style="color:var(--accent);font-weight:600">${esc(recipient)}</span> <span style="color:var(--muted)">earned</span> <span style="color:var(--accent);font-weight:700">${esc(d.role || 'contributor')}</span> <span style="color:var(--muted)">from</span> <span style="color:var(--accent);font-weight:600">${esc(d.projectTitle || 'a project')}</span></div>
        </div>
        ${d.tier ? `<div style="margin-top:0.5em;margin-left:${rPic ? '2.75em' : '0'}"><span style="font-size:0.7em;letter-spacing:0.08em;color:${tierColor}">${esc(d.tier)}</span></div>` : ''}
      </div>
    </div>
  `
}
