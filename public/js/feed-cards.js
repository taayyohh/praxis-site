// Shared feed card renderers — used by both artist feed (feed.js) and landing (landing.js)
import { escapeHtml as esc, getProfilePic, getArtistName, slugify } from './utils.js'
import { OPTIMISM_CHAIN_ID, USDC_OPTIMISM, rpcUrlFor } from './chains.js'
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
          const addr = await window.authorizedSigner?.(window.getWalletAddress?.())
          if (!addr) throw new Error('wallet not available')

          const { getPublicClient } = await import('./utils.js')
          const pc = await getPublicClient()

          const USDC_OP = USDC_OPTIMISM
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
              chainId: OPTIMISM_CHAIN_ID,
              toChainId: OPTIMISM_CHAIN_ID,
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
              walletClient = createWalletClient({ chain: optimism, account: embeddedAcct, transport: http(rpcUrlFor(OPTIMISM_CHAIN_ID)) })
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

// ─── project cards ─────────────────────────────────────────────────
// Project cards keep their own renderers for now — they carry a
// funding progress bar + status pill that the universal MediaCard
// doesn't cover yet. Everything else that used to live here (feed
// media + event renderers) now routes through media-card.js and
// event-card.js — see feed.js dispatch.

export function renderProjectCard(p, resolve, opts = {}) {
  const domain = resolve(p.proposer)
  const typeName = p.projectType || 'other'
  const statusLabels = ['proposed', 'funded', 'confirmed', 'completing', 'completed', 'cancelled', 'disputed']
  const statusColors = ['#c0c0c0', '#4ade80', '#60a5fa', '#fbbf24', '#a78bfa', '#666', '#ef4444']
  const statusIcons = ['ph-clock', 'ph-check-circle', 'ph-handshake', 'ph-spinner', 'ph-star', 'ph-x-circle', 'ph-warning']
  const pct = Number(p.fundingGoal) > 0 ? Math.round(Number(p.totalFunded) * 100 / Number(p.fundingGoal)) : 0
  let deadlineStr = ''
  if (p.deadline > 0) {
    const deadlineMs = Number(p.deadline) * 1000
    const daysLeft = Math.ceil((deadlineMs - Date.now()) / 86400000)
    deadlineStr = daysLeft > 0 ? `${daysLeft} day${daysLeft !== 1 ? 's' : ''} left` : new Date(deadlineMs).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }
  const linkTarget = opts.external ? ' target="_blank"' : ''

  const posterCid = p.posterCid || p.imageCid || ''
  const posterImg = posterCid ? `<img src="/api/img?url=/api/ipfs-proxy/${encodeURIComponent(posterCid)}&w=680" alt="" style="width:100%;max-height:280px;object-fit:cover;display:block;border-radius:6px 6px 0 0" loading="lazy" onerror="this.style.display='none'">` : ''

  return `
    <a href="/project?id=${p.id}"${linkTarget} class="feed-item" style="display:block;border:1px solid var(--border);border-radius:6px;text-decoration:none;color:inherit;padding:0;overflow:hidden">
      ${posterImg}
      <div style="padding:1.5em 1.75em">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:0.5em">
          <span style="color:var(--accent);font-weight:700;font-size:1.3em;line-height:1.3">${esc(p.title)}</span>
          <span style="font-size:0.75em;color:${statusColors[p.status]};flex-shrink:0;margin-left:1ch;display:flex;align-items:center;gap:0.3ch"><i class="ph ${statusIcons[p.status]}" style="font-size:1.1em"></i>${statusLabels[p.status]}</span>
        </div>
        <div style="font-size:0.8em;color:var(--muted);line-height:1.5;display:flex;align-items:center;gap:0.5ch">
          ${inlineAvatar(p.proposer)}<span style="color:var(--fg)">${esc(domain)}</span>${deadlineStr ? ` · ${deadlineStr}` : ''}${typeName !== 'other' ? ` · ${esc(typeName)}` : ''}
        </div>
        ${p.description ? `<p style="color:var(--dim);font-size:0.8em;margin:1em 0 0;line-height:1.6;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(p.description).slice(0, 200)}</p>` : ''}
        <div style="margin-top:1.25em">
          <div style="background:color-mix(in srgb, var(--fg) 8%, transparent);height:6px;border-radius:3px;overflow:hidden"><div style="background:var(--green);height:100%;border-radius:3px;width:${Math.min(pct, 100)}%"></div></div>
          <div style="font-size:0.75em;color:var(--dim);margin-top:0.5em">${pct}% funded · <span data-eth-wei="${esc(p.fundingGoal || '0')}" data-fiat-primary="true"></span> goal</div>
        </div>
      </div>
    </a>
  `
}

// Wide project card for the portfolio "projects" strip that sits directly
// below the identity divider on any tenant whose wallet is proposer or
// collaborator. Different shape from renderProjectCard (which is the feed
// event card): wider, hero-poster-forward, includes a collaborators
// avatar strip and links to the project's attached domain if set. The
// grid renders 1 or 2 of these per row depending on viewport.
//
// Data shape: the payload returned by /api/projects/by-wallet/:address —
// includes on-chain project fields plus `collaborators: [{ artist, split }]`,
// `domain: string | null` (attached tenant domain), `offchainMetadata: {
// posterCid, blurb, ... } | null`, and `domainMap` (address → domain).
export function renderProjectSummary(p, resolve, opts = {}) {
  const proposerLower = String(p.proposer).toLowerCase()
  const domain = resolve ? resolve(p.proposer) : (p.domainMap?.[proposerLower] || proposerLower.slice(0, 8) + '…')
  const statusLabels = ['proposed', 'funded', 'confirmed', 'completing', 'completed', 'cancelled', 'disputed']
  const statusColors = ['#c0c0c0', '#4ade80', '#60a5fa', '#fbbf24', '#a78bfa', '#666', '#ef4444']
  const statusIcons = ['ph-clock', 'ph-check-circle', 'ph-handshake', 'ph-spinner', 'ph-star', 'ph-x-circle', 'ph-warning']
  const goal = BigInt(p.fundingGoal || 0)
  const funded = BigInt(p.totalFunded || 0)
  const pct = goal > 0n ? Number((funded * 10000n) / goal) / 100 : 0

  // Poster: prefer off-chain override (project_metadata.posterCid → allows
  // updating the poster mid-run without a contract write), fall back to
  // the on-chain metadataCid (immutable brief), else nothing.
  const posterCid = p.offchainMetadata?.posterCid || p.posterCid || p.imageCid || p.metadataCid || ''
  const posterImg = posterCid
    ? `<img src="/api/img?url=/api/ipfs-proxy/${encodeURIComponent(posterCid)}&w=1000" alt="" loading="lazy" onerror="this.style.display='none'" style="width:100%;height:100%;object-fit:cover;display:block">`
    : ''

  // Deadline line: days-left while funding is open, no line after that.
  let deadlineStr = ''
  const status = Number(p.status || 0)
  if (status === 0 && p.deadline && Number(p.deadline) > 0) {
    const deadlineMs = Number(p.deadline) * 1000
    const daysLeft = Math.ceil((deadlineMs - Date.now()) / 86400000)
    if (daysLeft > 0) deadlineStr = `${daysLeft} day${daysLeft !== 1 ? 's' : ''} left`
  }

  // Collaborators strip — avatars for up to N collaborators (excluding the
  // proposer, who's already shown in the header) + a "+N more" chip when
  // there are extras. Avatars pull from /api/artists/resolve's profilePics
  // if the caller passed picMap, else fall back to the initial-in-circle.
  const collabs = (p.collaborators || [])
    .map(c => String(c.artist).toLowerCase())
    .filter(a => a !== proposerLower)
  const shownCollabs = collabs.slice(0, 4)
  const extraCollabs = Math.max(0, collabs.length - shownCollabs.length)
  const collabAvatars = shownCollabs.map(addr => {
    const pic = p.picMap?.[addr]
    const dom = p.domainMap?.[addr] || `${addr.slice(0, 6)}…`
    const initial = (dom[0] || '·').toUpperCase()
    const safe = pic && /^(https?:\/\/|\/api\/ipfs-proxy\/|\/ipfs\/)/i.test(String(pic)) ? String(pic) : ''
    return safe
      ? `<span title="${esc(dom)}" style="display:inline-block;width:22px;height:22px;border-radius:50%;overflow:hidden;border:1px solid var(--bg);margin-left:-6px;background:var(--bg-2,#111)"><img src="${esc(safe)}" alt="" style="width:100%;height:100%;object-fit:cover"></span>`
      : `<span title="${esc(dom)}" style="display:inline-flex;width:22px;height:22px;border-radius:50%;border:1px solid var(--bg);margin-left:-6px;background:var(--bg-2,#111);color:var(--muted);align-items:center;justify-content:center;font-size:0.7em">${esc(initial)}</span>`
  }).join('')
  const collabStrip = shownCollabs.length
    ? `<span style="display:inline-flex;align-items:center;margin-left:0.75ch;padding-left:6px">${collabAvatars}${extraCollabs > 0 ? `<span style="margin-left:0.5ch;font-size:0.7em;color:var(--dim)">+${extraCollabs}</span>` : ''}</span>`
    : ''

  // Card link target — attached tenant domain if the proposer wired one,
  // else the internal /project/:id detail page.
  const href = p.domain ? `https://${p.domain}` : `/project?id=${esc(p.id)}`
  const linkTarget = p.domain ? ' target="_blank" rel="noopener"' : ''

  const blurb = p.offchainMetadata?.blurb || p.description || ''

  return `
    <a href="${href}"${linkTarget} class="project-summary-card" data-project-id="${esc(p.id)}" style="display:flex;flex-direction:column;border:1px solid var(--border);border-radius:8px;overflow:hidden;text-decoration:none;color:inherit;background:color-mix(in srgb, var(--fg) 2%, transparent);transition:border-color 0.15s, transform 0.15s">
      <div class="project-summary-poster" style="aspect-ratio:16 / 9;background:color-mix(in srgb, var(--fg) 4%, var(--bg));position:relative;overflow:hidden">
        ${posterImg}
        <span style="position:absolute;top:0.75em;left:0.75em;display:inline-flex;align-items:center;gap:0.4ch;background:rgba(0,0,0,0.55);color:#fff;font-size:0.7em;padding:0.25em 0.75ch;border-radius:99px;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)"><i class="ph ${statusIcons[status] || statusIcons[0]}" style="font-size:1em;color:${statusColors[status] || statusColors[0]}"></i>${statusLabels[status] || 'proposed'}</span>
        <button type="button" class="project-summary-hide-btn" data-project-id="${esc(p.id)}" aria-label="hide from my portfolio" title="hide from my portfolio"><i class="ph ph-eye-slash"></i></button>
      </div>
      <div style="padding:1.25em 1.5em 1.5em;display:flex;flex-direction:column;gap:0.6em">
        <h3 style="margin:0;font-size:1.15em;line-height:1.3;color:var(--fg);font-weight:600">${esc(p.title || 'untitled project')}</h3>
        <div style="font-size:0.8em;color:var(--muted);display:flex;align-items:center;gap:0.4ch;flex-wrap:wrap">
          <span>by <span style="color:var(--accent)">${esc(domain)}</span></span>${collabStrip}${deadlineStr ? `<span style="color:var(--dim);margin-left:0.75ch">· ${esc(deadlineStr)}</span>` : ''}
        </div>
        ${blurb ? `<p style="margin:0.2em 0 0;color:var(--dim);font-size:0.85em;line-height:1.55;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(String(blurb).slice(0, 220))}</p>` : ''}
        ${goal > 0n ? `<div style="margin-top:0.4em">
          <div style="display:flex;justify-content:space-between;font-size:0.75em;color:var(--dim);margin-bottom:0.35em"><span><span data-eth-wei="${esc(String(funded))}" data-fiat-primary="true"></span> raised</span><span>${pct.toFixed(0)}% of <span data-eth-wei="${esc(String(goal))}" data-fiat-primary="true"></span></span></div>
          <div style="background:color-mix(in srgb, var(--fg) 8%, transparent);height:6px;border-radius:3px;overflow:hidden"><div style="background:var(--green);height:100%;border-radius:3px;width:${Math.min(pct, 100).toFixed(1)}%"></div></div>
        </div>` : ''}
      </div>
    </a>
  `
}
