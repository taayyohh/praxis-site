// Project-site attach modal — opens on /project/:id for the proposer.
// Two paths inside the same modal:
//   1. "attach a domain I own" (BYO) — the proposer already points their
//      A record at us; we verify DNS + provision.
//   2. "buy a new domain" (NameSilo) — search + purchase + provision.
//
// In both cases the proposer signs a message with the shape
//   praxis-project-attach:<projectId>:<domain>:<msTimestamp>
// which the orchestrator verifies against Praxis.sol getProjectProposer.
//
// This module is loaded on demand from project-detail.js — no cost for
// tenants that never open the modal.

import { createWalletClient, custom, optimism, parseEther } from './vendor.js'
import { escapeHtml, getWalletProvider, requireUser, formatTxError, getAuthToken, uploadToIpfs, resizeImageFile, getPublicClient, ensureFundsForPurchase } from './utils.js'
import { TREASURY_ADMIN_ADDR } from './contracts.js'

const SERVER_IP_FALLBACK = '5.161.199.120'

export async function openProjectAttachModal(projectId, project, opts = {}) {
  const proposer = String(project?.proposer || '').toLowerCase()
  const projectTitle = project?.title || `Project #${projectId}`
  let posterCid = opts.posterCid || project?.posterCid || null
  let posterFile = null // File waiting to upload once we know it's needed

  const addr = await requireUser('attach a domain')
  if (!addr) return
  if (addr.toLowerCase() !== proposer) {
    alert('only the project proposer can attach a domain')
    return
  }

  // Skeleton modal.
  const overlay = document.createElement('div')
  overlay.className = 'project-attach-overlay'
  overlay.innerHTML = `
    <div class="project-attach-modal" role="dialog" aria-modal="true" aria-labelledby="pa-title">
      <button class="project-attach-close" aria-label="close">&times;</button>
      <h2 id="pa-title" class="project-attach-title">attach a domain to <span style="color:var(--accent)">${escapeHtml(projectTitle)}</span></h2>
      <p class="project-attach-lede">
        The domain becomes this project's home — funding widget as hero,
        optional modules stack below, wallet-signed edits by the proposer.
        Nothing changes on Ethereum. You can detach any time.
      </p>

      <div class="project-attach-poster">
        <div class="project-attach-poster-preview" id="pa-poster-preview" ${posterCid ? '' : 'hidden'}>
          ${posterCid ? `<img src="/api/ipfs-proxy/${escapeHtml(posterCid)}" alt="poster preview">` : ''}
        </div>
        <div class="project-attach-poster-controls">
          <label class="project-attach-poster-btn buy-btn" for="pa-poster-file">
            <i class="ph ph-image"></i> <span id="pa-poster-btn-label">${posterCid ? 'change poster' : 'add poster (optional)'}</span>
          </label>
          <input type="file" id="pa-poster-file" accept="image/*" hidden>
          <button type="button" class="project-attach-poster-clear" id="pa-poster-clear" ${posterCid ? '' : 'hidden'}>remove</button>
        </div>
        <p class="project-attach-poster-hint">16:9 or landscape works best — used for the funding hero + og:image.</p>
      </div>

      <div class="project-attach-tabs" role="tablist">
        <button class="project-attach-tab active" data-tab="byo" role="tab">use a domain I own</button>
        <button class="project-attach-tab" data-tab="buy" role="tab">buy a new domain</button>
      </div>

      <section class="project-attach-panel" data-panel="byo">
        <p class="project-attach-help">
          Point an A record for your domain at <code class="project-attach-ip">${SERVER_IP_FALLBACK}</code>,
          wait a minute or two for DNS to propagate, then paste the
          domain below.
        </p>
        <div class="project-attach-form">
          <input type="text" class="project-input" id="pa-byo-domain" placeholder="thatguythefilm.com" autocomplete="off">
          <button class="buy-btn" id="pa-byo-attach">attach</button>
        </div>
        <p class="project-attach-status" id="pa-byo-status"></p>
      </section>

      <section class="project-attach-panel" data-panel="buy" hidden>
        <div class="project-attach-search-row">
          <input type="text" class="project-input" id="pa-buy-handle" placeholder="thatguythefilm" autocomplete="off">
          <button class="buy-btn" id="pa-buy-search">search</button>
        </div>
        <p class="project-attach-status" id="pa-buy-status"></p>
        <div id="pa-buy-results" class="project-attach-results"></div>
        <div id="pa-buy-contact" class="project-attach-contact" hidden></div>
      </section>
    </div>
  `

  document.body.appendChild(overlay)
  requestAnimationFrame(() => overlay.classList.add('is-open'))

  function close() {
    overlay.classList.remove('is-open')
    setTimeout(() => overlay.remove(), 220)
  }
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close() })
  overlay.querySelector('.project-attach-close').addEventListener('click', close)
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey) }
  })

  // Tab switching.
  overlay.querySelectorAll('.project-attach-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      overlay.querySelectorAll('.project-attach-tab').forEach(b => b.classList.toggle('active', b === btn))
      overlay.querySelectorAll('.project-attach-panel').forEach(p => {
        p.hidden = p.dataset.panel !== btn.dataset.tab
      })
    })
  })

  // Poster picker — local preview via createObjectURL; the file itself
  // uploads to IPFS on submit (after wallet is unlocked). Clearing
  // discards both the pending file AND any previously-set posterCid.
  const posterFileInput = overlay.querySelector('#pa-poster-file')
  const posterPreview = overlay.querySelector('#pa-poster-preview')
  const posterClearBtn = overlay.querySelector('#pa-poster-clear')
  const posterBtnLabel = overlay.querySelector('#pa-poster-btn-label')
  posterFileInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) { alert('please pick an image file'); return }
    if (file.size > 15 * 1024 * 1024) { alert('poster must be under 15 MB'); return }
    posterFile = file
    const localUrl = URL.createObjectURL(file)
    posterPreview.innerHTML = `<img src="${localUrl}" alt="poster preview">`
    posterPreview.hidden = false
    posterClearBtn.hidden = false
    posterBtnLabel.textContent = 'change poster'
  })
  posterClearBtn.addEventListener('click', () => {
    posterFile = null
    posterCid = null
    posterPreview.innerHTML = ''
    posterPreview.hidden = true
    posterClearBtn.hidden = true
    posterBtnLabel.textContent = 'add poster (optional)'
    posterFileInput.value = ''
  })

  // Upload the pending poster (if any) to IPFS. Returns the CID or
  // whatever was already set. Called from both submit paths.
  async function resolvePosterCid(statusEl) {
    if (!posterFile) return posterCid || ''
    statusEl.textContent = 'uploading poster…'
    const token = await getAuthToken()
    if (!token) throw new Error('wallet authentication required')
    const resized = await resizeImageFile(posterFile, 2048, 0.88)
    const { jobId } = await uploadToIpfs(resized.name || posterFile.name, resized, token)
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 1000))
      const poll = await fetch(`/api/ipfs/status/${jobId}`).then(r => r.json()).catch(() => null)
      if (poll?.status === 'done' && poll.cid) return poll.cid
      if (poll?.status === 'error') throw new Error(poll.error || 'poster upload failed')
    }
    throw new Error('poster upload timed out')
  }

  const byoStatus = overlay.querySelector('#pa-byo-status')
  const buyStatus = overlay.querySelector('#pa-buy-status')
  const buyResults = overlay.querySelector('#pa-buy-results')
  const buyContact = overlay.querySelector('#pa-buy-contact')

  async function signAttach(domain) {
    // Domain must be normalized (lowercased) so the strict field
    // compare on the orchestrator matches — the site is served
    // case-insensitively anyway.
    const msg = `praxis-project-attach:${projectId}:${String(domain).toLowerCase()}:${Date.now()}`
    const account = await window.authorizedSigner?.(addr)
    const walletClient = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })
    const signature = await walletClient.signMessage({ account, message: msg })
    return { signature, message: msg }
  }

  // Persist poster into project_metadata so the wide
  // card on any other portfolio picks it up. The tenant's own funding
  // hero reads posterCid from site.json, which the orchestrator writes
  // during provisioning — that's separate from this call.
  async function saveProjectMetadata(cid, statusEl) {
    if (!cid) return
    const msg = `praxis-project-metadata:${projectId}:${cid}:${Date.now()}`
    const account = await window.authorizedSigner?.(addr)
    const walletClient = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })
    const signature = await walletClient.signMessage({ account, message: msg })
    const res = await fetch('/api/project-metadata', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, wallet: addr, posterCid: cid, signature, message: msg }),
    })
    const data = await res.json().catch(() => ({}))
    if (data?.error) {
      // Non-fatal for the attach — the site still renders the poster
      // from site.json; only the wide-card overlay is missing it.
      console.warn('poster metadata save failed:', data.error)
      if (statusEl) statusEl.textContent = `poster stored on site, but overlay update failed: ${data.error}`
    }
  }

  async function commit(url, payload, statusEl) {
    statusEl.textContent = 'provisioning site…'
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok || data.error) {
        statusEl.textContent = data.error || `error (${res.status})`
        statusEl.classList.add('is-error')
        return null
      }
      statusEl.classList.remove('is-error')
      statusEl.innerHTML = `attached — <a href="https://${escapeHtml(payload.domain)}" target="_blank" rel="noopener" style="color:var(--accent)">visit ${escapeHtml(payload.domain)}</a>`
      setTimeout(() => location.reload(), 3000)
      return data
    } catch (e) {
      statusEl.textContent = formatTxError(e)
      statusEl.classList.add('is-error')
      return null
    }
  }

  // ── BYO path ─────────────────────────────────────────
  overlay.querySelector('#pa-byo-attach').addEventListener('click', async () => {
    const domain = overlay.querySelector('#pa-byo-domain').value.trim().toLowerCase()
    if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
      byoStatus.textContent = 'enter a valid domain (e.g. thatguythefilm.com)'
      return
    }
    byoStatus.classList.remove('is-error')
    try {
      const cid = await resolvePosterCid(byoStatus)
      if (cid && cid !== posterCid) {
        byoStatus.textContent = 'saving poster…'
        await saveProjectMetadata(cid, byoStatus)
      }
      byoStatus.textContent = 'sign to attach…'
      const { signature, message } = await signAttach(domain)
      await commit('/orchestrator/project-site/attach', {
        projectId, domain, wallet: addr, name: projectTitle, bio: project?.description || '',
        posterCid: cid || null, signature, message,
      }, byoStatus)
    } catch (e) {
      byoStatus.textContent = formatTxError(e)
      byoStatus.classList.add('is-error')
    }
  })

  // ── BUY path — NameSilo search + purchase ────────────
  overlay.querySelector('#pa-buy-search').addEventListener('click', async () => {
    const handle = overlay.querySelector('#pa-buy-handle').value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '')
    if (!handle) { buyStatus.textContent = 'enter a handle'; return }
    buyStatus.classList.remove('is-error')
    buyStatus.textContent = 'searching…'
    buyResults.innerHTML = ''
    buyContact.hidden = true
    try {
      const res = await fetch(`/orchestrator/domains/search?handle=${encodeURIComponent(handle)}`)
      const data = await res.json()
      if (data.error) { buyStatus.textContent = data.error; buyStatus.classList.add('is-error'); return }
      const domains = (data.domains || []).filter(d => d.available && !d.premium && !d.tooExpensive)
      if (!domains.length) { buyStatus.textContent = 'no available domains for that handle'; return }
      buyStatus.textContent = 'pick one below.'
      buyResults.innerHTML = domains.map(d => {
        const usd = d.priceUsd ? `$${Number(d.priceUsd).toFixed(2)}` : ''
        return `<div class="project-attach-domain-row">
          <span><span style="color:var(--accent)">${escapeHtml(d.domain)}</span>
            ${usd ? `<span style="color:var(--dim);font-size:0.85em;margin-left:1ch">${usd} / 2yr</span>` : ''}</span>
          <button class="buy-btn project-attach-pick" data-domain="${escapeHtml(d.domain)}" data-price-eth="${d.priceEth || '0'}">pick</button>
        </div>`
      }).join('')
      buyResults.querySelectorAll('.project-attach-pick').forEach(btn => {
        btn.addEventListener('click', () => showContactForm(btn.dataset.domain, btn.dataset.priceEth))
      })
    } catch (e) {
      buyStatus.textContent = formatTxError(e)
      buyStatus.classList.add('is-error')
    }
  })

  function showContactForm(domain, priceEth) {
    buyContact.hidden = false
    buyContact.innerHTML = `
      <p class="project-attach-contact-lede">
        NameSilo needs ICANN-required contact info for
        <span style="color:var(--accent)">${escapeHtml(domain)}</span>.
      </p>
      <div class="project-attach-contact-grid">
        <input class="project-input" id="pa-c-first" placeholder="first name">
        <input class="project-input" id="pa-c-last" placeholder="last name">
        <input class="project-input" id="pa-c-email" placeholder="email" type="email" style="grid-column:1/-1">
        <input class="project-input" id="pa-c-address" placeholder="address" style="grid-column:1/-1">
        <input class="project-input" id="pa-c-city" placeholder="city">
        <input class="project-input" id="pa-c-state" placeholder="state / region">
        <input class="project-input" id="pa-c-zip" placeholder="zip">
        <input class="project-input" id="pa-c-country" placeholder="country" value="US">
      </div>
      <button class="buy-btn" id="pa-buy-confirm" style="margin-top:0.75em">buy + attach ${escapeHtml(domain)}</button>
      <p class="project-attach-status" id="pa-confirm-status"></p>
    `
    const confirmStatus = buyContact.querySelector('#pa-confirm-status')
    buyContact.querySelector('#pa-buy-confirm').addEventListener('click', async () => {
      const contactInfo = {
        firstName: buyContact.querySelector('#pa-c-first').value.trim(),
        lastName: buyContact.querySelector('#pa-c-last').value.trim(),
        email: buyContact.querySelector('#pa-c-email').value.trim(),
        address: buyContact.querySelector('#pa-c-address').value.trim(),
        city: buyContact.querySelector('#pa-c-city').value.trim(),
        state: buyContact.querySelector('#pa-c-state').value.trim(),
        zip: buyContact.querySelector('#pa-c-zip').value.trim(),
        country: buyContact.querySelector('#pa-c-country').value.trim() || 'US',
      }
      if (!contactInfo.firstName || !contactInfo.lastName || !contactInfo.email) {
        confirmStatus.textContent = 'first name, last name, and email required'
        confirmStatus.classList.add('is-error')
        return
      }
      confirmStatus.classList.remove('is-error')

      const domainPriceEth = Math.max(0.003, parseFloat(priceEth || '0')) // enforce sanity floor client-side too
      try {
        // 1. Upload the poster (if any) before spending money — cheaper
        // to bail here than mid-purchase.
        const cid = await resolvePosterCid(confirmStatus)
        if (cid && cid !== posterCid) {
          confirmStatus.textContent = 'saving poster…'
          await saveProjectMetadata(cid, confirmStatus)
        }

        // 2. Charge the wallet — send domain price to the treasury admin
        // EOA. ensureFundsForPurchase kicks the funding sheet if the
        // embedded wallet is short.
        const priceWei = parseEther(domainPriceEth.toFixed(6))
        const funded = await ensureFundsForPurchase(priceWei, confirmStatus)
        if (!funded) return
        confirmStatus.textContent = `confirm ${domainPriceEth.toFixed(4)} ETH payment…`
        const payAccount = await window.authorizedSigner?.(addr)
        const walletClient = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })
        const txHash = await walletClient.sendTransaction({
          to: TREASURY_ADMIN_ADDR,
          value: priceWei,
          account: payAccount,
        })
        confirmStatus.textContent = `payment sent (${txHash.slice(0, 10)}…) — waiting for confirmation…`
        const publicClient = await getPublicClient()
        await publicClient.waitForTransactionReceipt({ hash: txHash })

        // 3. Sign attach.
        confirmStatus.textContent = 'sign to attach…'
        const { signature, message } = await signAttach(domain)

        // 4. Register — orchestrator verifies txHash before hitting NameSilo.
        await commit('/orchestrator/project-site/register', {
          projectId, domain, wallet: addr, name: projectTitle, bio: project?.description || '',
          posterCid: cid || null, contactInfo, signature, message, txHash,
        }, confirmStatus)
      } catch (e) {
        confirmStatus.textContent = formatTxError(e)
        confirmStatus.classList.add('is-error')
      }
    })
  }
}

// Standalone poster editor — reused post-attach from the /project/:id
// project-site panel. Same upload + signing pipeline as the attach
// modal, but doesn't touch the tenant provisioning. Writes both to
// project_metadata (for wide cards) and to the tenant's site.json (via
// the /api/project-metadata endpoint which rebuilds the tenant).
export async function openPosterEditor(projectId, project, opts = {}) {
  const proposer = String(project?.proposer || '').toLowerCase()
  const addr = await requireUser('update the poster')
  if (!addr) return
  if (addr.toLowerCase() !== proposer) {
    alert('only the project proposer can update the poster')
    return
  }

  let currentCid = String(opts.posterCid || '').trim()
  let pending = null

  const overlay = document.createElement('div')
  overlay.className = 'project-attach-overlay'
  overlay.innerHTML = `
    <div class="project-attach-modal" role="dialog" aria-modal="true">
      <button class="project-attach-close" aria-label="close">&times;</button>
      <h2 class="project-attach-title">${currentCid ? 'change' : 'add'} project poster</h2>
      <p class="project-attach-lede">
        Used as the funding widget hero, the Open Graph share image, and
        the wide project card on every collaborator's portfolio.
      </p>
      <div class="project-attach-poster">
        <div class="project-attach-poster-preview" id="pe-preview" ${currentCid ? '' : 'hidden'}>
          ${currentCid ? `<img src="/api/ipfs-proxy/${escapeHtml(currentCid)}" alt="poster preview">` : ''}
        </div>
        <div class="project-attach-poster-controls">
          <label class="project-attach-poster-btn buy-btn" for="pe-file"><i class="ph ph-image"></i> <span id="pe-btn-label">${currentCid ? 'pick a new image' : 'pick an image'}</span></label>
          <input type="file" id="pe-file" accept="image/*" hidden>
          <button type="button" class="project-attach-poster-clear" id="pe-clear" ${currentCid ? '' : 'hidden'}>remove</button>
        </div>
        <p class="project-attach-poster-hint">16:9 or landscape works best.</p>
      </div>
      <div style="display:flex;gap:0.75ch;justify-content:flex-end;margin-top:1em">
        <button type="button" class="project-attach-poster-clear" id="pe-cancel">cancel</button>
        <button type="button" class="buy-btn" id="pe-save">save poster</button>
      </div>
      <p class="project-attach-status" id="pe-status"></p>
    </div>
  `
  document.body.appendChild(overlay)
  requestAnimationFrame(() => overlay.classList.add('is-open'))

  const close = () => { overlay.classList.remove('is-open'); setTimeout(() => overlay.remove(), 220) }
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close() })
  overlay.querySelector('.project-attach-close').addEventListener('click', close)
  overlay.querySelector('#pe-cancel').addEventListener('click', close)

  const preview = overlay.querySelector('#pe-preview')
  const clearBtn = overlay.querySelector('#pe-clear')
  const btnLabel = overlay.querySelector('#pe-btn-label')
  const status = overlay.querySelector('#pe-status')
  const fileInput = overlay.querySelector('#pe-file')

  fileInput.addEventListener('change', (e) => {
    const f = e.target.files?.[0]
    if (!f) return
    if (!f.type.startsWith('image/')) { alert('please pick an image file'); return }
    if (f.size > 15 * 1024 * 1024) { alert('poster must be under 15 MB'); return }
    pending = f
    const url = URL.createObjectURL(f)
    preview.innerHTML = `<img src="${url}" alt="poster preview">`
    preview.hidden = false
    clearBtn.hidden = false
    btnLabel.textContent = 'pick a different image'
  })
  clearBtn.addEventListener('click', () => {
    pending = null
    currentCid = ''
    preview.innerHTML = ''
    preview.hidden = true
    clearBtn.hidden = true
    btnLabel.textContent = 'pick an image'
    fileInput.value = ''
  })

  overlay.querySelector('#pe-save').addEventListener('click', async () => {
    status.classList.remove('is-error')
    try {
      let cid = currentCid
      if (pending) {
        status.textContent = 'uploading poster…'
        const token = await getAuthToken()
        if (!token) throw new Error('wallet authentication required')
        const resized = await resizeImageFile(pending, 2048, 0.88)
        const { jobId } = await uploadToIpfs(resized.name || pending.name, resized, token)
        for (let i = 0; i < 60; i++) {
          await new Promise(r => setTimeout(r, 1000))
          const poll = await fetch(`/api/ipfs/status/${jobId}`).then(r => r.json()).catch(() => null)
          if (poll?.status === 'done' && poll.cid) { cid = poll.cid; break }
          if (poll?.status === 'error') throw new Error(poll.error || 'upload failed')
        }
        if (!cid || cid === currentCid) throw new Error('upload timed out')
      }

      status.textContent = 'sign to save…'
      const msg = `praxis-project-metadata:${projectId}:${cid}:${Date.now()}`
      const account = await window.authorizedSigner?.(addr)
      const walletClient = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })
      const signature = await walletClient.signMessage({ account, message: msg })

      const res = await fetch('/api/project-metadata', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, wallet: addr, posterCid: cid, signature, message: msg }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      status.textContent = 'saved — reloading…'
      setTimeout(() => location.reload(), 800)
    } catch (e) {
      status.textContent = formatTxError(e)
      status.classList.add('is-error')
    }
  })
}

// Detach — one-click confirmation, wallet-signs the same shape message.
export async function detachProjectSite(projectId, project) {
  const proposer = String(project?.proposer || '').toLowerCase()
  const addr = await requireUser('detach the site')
  if (!addr) return
  if (addr.toLowerCase() !== proposer) {
    alert('only the project proposer can detach the site')
    return
  }
  if (!confirm(`Detach the site from this project? The Praxis-hosted page will stop rendering. The domain (and on-chain project) are untouched.`)) return
  try {
    // Server returns the attached domain based on projectId, but we need
    // the domain in the signed message. Fetch it first.
    const meta = await fetch(`/api/project/${projectId}`).then(r => r.json()).catch(() => null)
    const attached = meta?.project?.domain || meta?.domain || null
    if (!attached) { alert('no site attached to this project'); return }

    const msg = `praxis-project-detach:${projectId}:${String(attached).toLowerCase()}:${Date.now()}`
    const account = await window.authorizedSigner?.(addr)
    const walletClient = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })
    const signature = await walletClient.signMessage({ account, message: msg })

    const res = await fetch('/orchestrator/project-site/detach', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, wallet: addr, signature, message: msg }),
    })
    const data = await res.json()
    if (data.error) { alert(`detach failed: ${data.error}`); return }
    alert('detached — the site will stop rendering shortly')
    location.reload()
  } catch (e) {
    alert(`detach failed: ${formatTxError(e)}`)
  }
}
