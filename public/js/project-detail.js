import { F } from './fragments.js'
import { createWalletClient, custom, parseEther } from './vendor.js'
import { optimism } from './vendor.js'
import { query } from './ponder.js'
import { escapeHtml, resolveAddresses, formatTxError, getPublicClient, formatEthAmount, registerPage, isBlocked, requireUser, getWalletProvider, parseEventMetadata, renderMarkdown, unpackLocation, slugify, resolveDomain, ensureFundsForPurchase, getProfilePic, getAuthToken } from './utils.js'
import { getTicketListingsForProject, listTicket, purchaseTicket, cancelTicketListing } from './tickets.js'
import { t } from './i18n.js'
import { getEthPrices, formatPriceSync } from './fiat.js'

registerPage('project-detail-page', initProjectDetail)

let _countdownInterval = null

import { PRAXIS_ABI, BLOG_ABI } from './contracts.js'

const PROJECT_TYPE_PRESETS = ['show', 'film', 'theater', 'recording', 'workshop', 'installation', 'other']
const PROPOSED = 0, FUNDED = 1, CONFIRMED = 2, COMPLETING = 3, COMPLETED = 4, CANCELLED = 5
const STATUS_LABELS = ['proposed', 'funded', 'confirmed', 'completing', 'completed', 'cancelled', 'disputed']
const STATUS_COLORS = ['#c0c0c0', '#4ade80', '#60a5fa', '#fbbf24', '#a78bfa', '#666', '#ef4444']
const MS_LABELS = ['pending', 'submitted', 'released', 'disputed']
const MS_COLORS = ['var(--dim)', '#fbbf24', '#4ade80', '#ef4444']
const RELOAD_DELAY = 2000
function reloadAfterTx() { setTimeout(() => location.reload(), RELOAD_DELAY) }

async function _uploadEditImages(images, statusEl) {
  const authToken = await getAuthToken()
  if (!authToken) throw new Error('wallet authentication required')
  const imageCids = []
  for (let i = 0; i < images.length; i++) {
    const img = images[i]
    if (img.cid) { imageCids.push({ cid: img.cid, name: img.file.name, type: img.file.type }); continue }
    if (statusEl) statusEl.textContent = `uploading image ${i + 1}/${images.length}...`
    const res = await fetch(`/api/ipfs?name=${encodeURIComponent(img.file.name)}`, {
      method: 'POST', body: img.file,
      headers: { 'Authorization': `Bearer ${authToken}`, 'Content-Length': img.file.size.toString() },
    })
    if (!res.ok) throw new Error('image upload failed')
    const { jobId } = await res.json()
    for (let j = 0; j < 120; j++) {
      await new Promise(r => setTimeout(r, 1000))
      const poll = await fetch(`/api/ipfs/status/${jobId}`)
      const pollData = await poll.json()
      if (pollData.status === 'done') { img.cid = pollData.cid; break }
      if (pollData.status === 'error') throw new Error(pollData.error || 'upload failed')
    }
    if (!img.cid) throw new Error('upload timed out')
    imageCids.push({ cid: img.cid, name: img.file.name, type: img.file.type })
  }
  if (statusEl) statusEl.textContent = 'uploading metadata...'
  const metadata = JSON.stringify({ images: imageCids })
  const metaBlob = new Blob([metadata], { type: 'application/json' })
  const metaRes = await fetch('/api/ipfs?name=project-metadata.json', {
    method: 'POST', body: metaBlob,
    headers: { 'Authorization': `Bearer ${authToken}`, 'Content-Length': metaBlob.size.toString() },
  })
  if (!metaRes.ok) throw new Error('metadata upload failed')
  const { jobId: metaJobId } = await metaRes.json()
  for (let j = 0; j < 120; j++) {
    await new Promise(r => setTimeout(r, 1000))
    const poll = await fetch(`/api/ipfs/status/${metaJobId}`)
    const pollData = await poll.json()
    if (pollData.status === 'done') return pollData.cid
    if (pollData.status === 'error') throw new Error(pollData.error || 'upload failed')
  }
  throw new Error('metadata upload timed out')
}

async function maybeCreateProjectGroup(projectId, project, data, funderAddr) {
  const client = window._xmtpClient
  const sdk = window._xmtpSdk
  if (!client || !sdk) return

  const myAddr = window.getWalletAddress?.()?.toLowerCase()
  const title = project.title || `Project #${projectId}`

  async function resolveInboxId(addr) {
    try {
      let id = null
      if (typeof client.findInboxIdByIdentifier === 'function') {
        id = await client.findInboxIdByIdentifier({ identifier: addr, identifierKind: sdk.IdentifierKind.Ethereum })
      }
      if (!id && typeof client.fetchInboxIdByIdentifier === 'function') {
        id = await client.fetchInboxIdByIdentifier({ identifier: addr, identifierKind: sdk.IdentifierKind.Ethereum })
      }
      return id
    } catch { return null }
  }

  async function resolveInboxIds(addrs) {
    const filtered = [...addrs].filter(a => a !== myAddr)
    const results = await Promise.all(filtered.map(resolveInboxId))
    return results.filter(Boolean)
  }

  let existing = null
  try {
    const checkRes = await fetch(`/api/project-group?id=${projectId}`)
    existing = await checkRes.json()
  } catch { return }

  if (existing?.communityGroupId && funderAddr) {
    try {
      const funderInboxId = await resolveInboxId(funderAddr.toLowerCase())
      if (funderInboxId) {
        const group = await client.conversations.getConversationById(existing.communityGroupId)
        if (group) {
          const members = await group.members()
          const alreadyMember = members.some(m => m.inboxId === funderInboxId)
          if (!alreadyMember) await group.addMembers([funderInboxId])
        }
      }
    } catch (e) { console.warn('praxis: add funder to community group failed:', e?.message) }
    return
  }

  if (existing?.teamGroupId || existing?.communityGroupId) return

  const teamAddrs = new Set()
  if (project.proposer) teamAddrs.add(project.proposer.toLowerCase())
  for (const c of (data.collaborators?.items || [])) {
    if (c.artist) teamAddrs.add(c.artist.toLowerCase())
  }

  const communityAddrs = new Set(teamAddrs)
  if (funderAddr) communityAddrs.add(funderAddr.toLowerCase())

  try {
    const [teamIds, communityIds] = await Promise.all([
      resolveInboxIds(teamAddrs),
      resolveInboxIds(communityAddrs),
    ])

    const [teamGroup, communityGroup] = await Promise.all([
      client.conversations.createGroup(teamIds, { name: `${title} — team` }),
      client.conversations.createGroup(communityIds, { name: title }),
    ])

    const token = sessionStorage.getItem('praxis-auth-token') || localStorage.getItem('praxis-auth-token')
    const headers = { 'Content-Type': 'application/json' }
    if (token) headers['Authorization'] = `Bearer ${token}`
    await fetch(`/api/project-group?id=${projectId}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ teamGroupId: teamGroup.id, communityGroupId: communityGroup.id }),
    })
  } catch (e) {
    console.warn('praxis: auto-create project groups failed:', e?.message)
  }
}

async function _resolveProjectSlug(slug) {
  try {
    const siteResp = await fetch('/site.json')
    if (!siteResp.ok) return null
    const site = await siteResp.json()
    const wallet = site.wallet?.toLowerCase()
    if (!wallet) return null
    const data = await query(`
      query SlugProjects($proposer: String!) {
        projects(where: { proposer: $proposer }, orderBy: "createdAt", orderDirection: "desc", limit: 200) {
          items { id title }
        }
      }
    `, { proposer: wallet })
    const projects = data?.projects?.items || []
    const matched = projects.find(p => slugify(p.title) === slug)
    return matched ? String(matched.id) : null
  } catch (e) {
    console.warn('project slug resolve error:', e)
    return null
  }
}

function profilePicHtml(addr, size = 22) {
  const pic = getProfilePic(addr)
  if (!pic) return ''
  return `<img src="${escapeHtml(pic)}" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;flex-shrink:0" loading="lazy" onerror="this.style.display='none'">`
}

async function initProjectDetail() {
  const el = document.getElementById('project-detail-page')
  if (!el) return
  const params = new URLSearchParams(window.location.search)
  let projectId = params.get('id')
  const loadingEl = document.getElementById('project-detail-loading')
  const contentEl = document.getElementById('project-detail-content')
  const praxisAddr = el.dataset.praxis
  const registryAddr = el.dataset.registry

  if (!projectId) {
    const segs = window.location.pathname.split('/').filter(Boolean)
    if (segs.length >= 2 && (segs[0] === 'project' || segs[0] === 'event')) {
      projectId = await _resolveProjectSlug(decodeURIComponent(segs[1]))
    }
  }

  if (!projectId) { loadingEl.textContent = 'no project id'; return }

  try {
    let data
    try {
      const res = await fetch(`/api/project/${projectId}`)
      data = await res.json()
      if (data.error) throw new Error(data.error)
      if (data.collaborators && !data.collaborators.items) data.collaborators = { items: data.collaborators }
      if (data.tiers && !data.tiers.items) data.tiers = { items: data.tiers }
      if (data.fundings && !data.fundings.items) data.fundings = { items: data.fundings }
    } catch {
      data = await query(`
        query Project($id: BigInt!) {
          project(id: $id) {
            ${F.projectDetail}
          }
          collaborators(where: { projectId: $id }, limit: 50) {
            items { ${F.collaborator} }
          }
          tiers(where: { projectId: $id }, limit: 20) {
            items { ${F.tier} }
          }
          fundings(where: { projectId: $id }, limit: 100, orderBy: "blockNumber", orderDirection: "desc") {
            items { ${F.fundingFull} }
          }
        }
      `, { id: projectId })
    }

    const p = data.project
    if (!p) { loadingEl.textContent = 'project not found'; return }

    loadingEl.style.display = 'none'

    let domainMap = data.domains || {}
    if (!Object.keys(domainMap).length) {
      const addressesToResolve = [
        p.proposer,
        ...data.collaborators.items.map(c => c.artist),
        ...data.fundings.items.map(f => f.funder),
      ].filter(Boolean)
      domainMap = await resolveAddresses(query, addressesToResolve).catch(() => ({}))
    }
    const resolve = addr => resolveDomain(domainMap, addr)
    const esc = escapeHtml
    const myAddr = window.getWalletAddress?.()?.toLowerCase()
    const isProposer = myAddr === p.proposer.toLowerCase()
    const isCollaborator = data.collaborators.items.some(c => c.artist.toLowerCase() === myAddr)
    const isTeam = isProposer || isCollaborator
    const isFunder = data.fundings.items.some(f => f.funder.toLowerCase() === myAddr)

    const [publicClient, ethPrices] = await Promise.all([getPublicClient(), getEthPrices().catch(() => null)])

    const goalEth = formatPriceSync(p.fundingGoal, ethPrices)
    const fundedEth = formatPriceSync(p.totalFunded, ethPrices)
    const pct = Number(p.fundingGoal) > 0 ? Math.round(Number(p.totalFunded) * 100 / Number(p.fundingGoal)) : 0
    const typeName = p.projectType || 'other'
    const isEvent = typeName === 'show' || typeName === 'theater' || typeName === 'workshop'
    const statusLabel = isEvent
      ? { 0: 'tickets available', 1: 'tickets available', 2: 'confirmed', 3: 'happening soon', 4: 'event over', 5: 'cancelled', 6: 'disputed' }[p.status] || STATUS_LABELS[p.status]
      : STATUS_LABELS[p.status] || 'unknown'
    const statusColor = STATUS_COLORS[p.status] || '#666'

    const { meta: eventMeta, text: cleanDescription } = parseEventMetadata(p.description)
    const eventDate = eventMeta?.eventDate ? new Date(eventMeta.eventDate) : null
    const deadlineDate = p.deadline > 0 ? new Date(Number(p.deadline) * 1000) : null
    const deadlineStr = isEvent && eventDate
      ? eventDate.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) + (eventMeta.doorsTime ? ` · doors ${esc(eventMeta.doorsTime)}` : '')
      : deadlineDate ? deadlineDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : 'no deadline'
    const createdStr = new Date(Number(p.createdAt) * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })

    // batch-check hasConfirmed
    const collabAddrs = data.collaborators.items.map(c => c.artist)
    const allParticipants = [p.proposer, ...collabAddrs.filter(a => a.toLowerCase() !== p.proposer.toLowerCase())]
    const confirmedSet = new Set()
    let confirmCount = 0
    if (p.status >= FUNDED) {
      try {
        const confirmCalls = allParticipants.map(addr => ({
          address: praxisAddr, abi: PRAXIS_ABI,
          functionName: 'hasConfirmed', args: [BigInt(projectId), addr],
        }))
        const confirmResults = await publicClient.multicall({ contracts: confirmCalls, allowFailure: true })
        for (let i = 0; i < allParticipants.length; i++) {
          if (confirmResults[i].status === 'success' && confirmResults[i].result) {
            confirmedSet.add(allParticipants[i].toLowerCase())
            confirmCount++
          }
        }
      } catch (e) { console.warn('hasConfirmed batch check:', e) }
    }
    const totalParticipants = allParticipants.length

    // ── TEAM ──
    const teamHtml = data.collaborators.items.map(c => {
      const domain = resolve(c.artist)
      const splitPct = (Number(c.split) / 100).toFixed(0)
      const isConfirmed = confirmedSet.has(c.artist.toLowerCase())
      const confirmLabel = p.status >= FUNDED
        ? (isConfirmed
          ? '<span style="color:#4ade80;font-size:0.8em;margin-left:0.5ch">confirmed</span>'
          : '<span style="color:var(--dim);font-size:0.8em;margin-left:0.5ch">pending</span>')
        : ''
      return `<div class="pd-row">
        <span style="display:flex;align-items:center;gap:0.5ch">${profilePicHtml(c.artist, 22)}<a href="/network?artist=${c.artist.toLowerCase()}" style="color:var(--fg)">${esc(domain)}</a>${confirmLabel}</span>
        <span style="color:var(--muted)">${splitPct}%</span>
      </div>`
    }).join('')

    // ── TIERS ──
    const tiersHtml = (data.tiers?.items || []).map(tier => {
      const priceEth = formatPriceSync(tier.price, ethPrices)
      const isFreeRsvp = Number(tier.price) <= 1000
      const remaining = Number(tier.maxSupply) - Number(tier.sold)
      const badgeText = isEvent
        ? (isFreeRsvp ? 'free rsvp' : 'ticket')
        : (tier.transferable ? 'ticket' : 'producer')
      const badgeColor = (tier.transferable || isEvent) ? '#4ade80' : '#a78bfa'
      const priceLabel = isEvent && isFreeRsvp ? 'free' : priceEth
      const capacityLabel = isEvent
        ? (remaining > 0 ? `${remaining} spot${remaining !== 1 ? 's' : ''} left` : 'sold out')
        : `${tier.sold}/${tier.maxSupply} sold`
      const btnLabel = isEvent ? (isFreeRsvp ? 'RSVP' : 'get tickets') : 'fund'
      const soldOut = remaining <= 0
      const tierDateStr = tier.eventDate && BigInt(tier.eventDate) > 0n
        ? new Date(Number(tier.eventDate) * 1000).toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        : ''
      const tierLoc = unpackLocation(tier.location)
      const tierLocStr = tierLoc ? `${tierLoc.lat.toFixed(4)}, ${tierLoc.lng.toFixed(4)}` : ''
      return `<div class="pd-tier">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1em">
          <div style="flex:1;min-width:0">
            <span class="pd-tier-badge" style="background:color-mix(in srgb, ${badgeColor} 15%, transparent);color:${badgeColor}">${badgeText}</span>
            <div class="pd-tier-name">${esc(tier.name)}</div>
            ${tierDateStr ? `<div style="color:var(--dim);font-size:0.8em;margin-top:0.25em"><i class="ph ph-calendar" style="margin-right:0.3ch"></i> ${tierDateStr}</div>` : ''}
            ${tierLocStr ? `<div style="color:var(--dim);font-size:0.8em;margin-top:0.15em"><i class="ph ph-map-pin" style="margin-right:0.3ch"></i> ${tierLocStr}</div>` : ''}
          </div>
          <div style="text-align:right;flex-shrink:0">
            <div class="pd-tier-price">${priceLabel}</div>
            <div class="pd-tier-meta">${capacityLabel}</div>
          </div>
        </div>
        ${!soldOut && p.status <= FUNDED ? `<div class="pd-tier-footer">
          <div class="pd-qty-stepper">
            <button type="button" class="qty-minus" data-tier-id="${esc(tier.tierId)}">−</button>
            <input type="number" class="fund-qty" data-tier-id="${esc(tier.tierId)}" value="1" min="1" max="${remaining}">
            <button type="button" class="qty-plus" data-tier-id="${esc(tier.tierId)}">+</button>
          </div>
          <button class="pd-tier-cta fund-tier-btn" data-tier-id="${esc(tier.tierId)}" data-price="${esc(tier.price)}" data-tier-name="${esc(tier.name)}">${btnLabel}</button>
        </div>` : (soldOut ? `<div class="pd-tier-footer"><button class="pd-tier-cta sold-out" disabled>sold out</button></div>` : '')}
      </div>`
    }).join('')

    // ── FUNDERS ──
    const fundersHtml = data.fundings.items.slice(0, 20).map(f => {
      const domain = resolve(f.funder)
      const amtLabel = formatEthAmount(f.amount) === '0' ? 'free' : formatPriceSync(f.amount, ethPrices)
      const dateStr = new Date(Number(f.timestamp) * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      return `<div class="pd-row">
        <span style="display:flex;align-items:center;gap:0.5ch">${profilePicHtml(f.funder, 20)}<a href="/network?artist=${f.funder.toLowerCase()}" style="color:var(--fg)">${esc(domain)}</a></span>
        <span style="display:flex;gap:1ch;align-items:center"><span style="color:#4ade80;font-variant-numeric:tabular-nums">${amtLabel}</span><span style="color:var(--dim);font-size:0.85em">${dateStr}</span></span>
      </div>`
    }).join('')
    const showAllFunders = data.fundings.items.length > 20
      ? `<div style="text-align:center;padding:0.5em;font-size:0.8em;color:var(--muted);cursor:pointer" id="show-all-funders">show all ${data.fundings.items.length} backers</div>` : ''

    // ── MILESTONES ──
    let msCount = 0
    try {
      msCount = Number(await publicClient.readContract({ address: praxisAddr, abi: PRAXIS_ABI, functionName: 'milestoneCount', args: [BigInt(projectId)] }))
    } catch {}

    let milestonesHtml = ''
    let milestones = []
    let disputeWindowDays = 0

    if (msCount > 0) {
      const msCalls = [
        { address: praxisAddr, abi: PRAXIS_ABI, functionName: 'getDisputeWindowDays', args: [BigInt(projectId)] },
        { address: praxisAddr, abi: PRAXIS_ABI, functionName: 'releasedFunds', args: [BigInt(projectId)] },
        ...Array.from({ length: msCount }, (_, i) => ({
          address: praxisAddr, abi: PRAXIS_ABI, functionName: 'getMilestone', args: [BigInt(projectId), BigInt(i)],
        })),
      ]
      const msMulti = await publicClient.multicall({ contracts: msCalls, allowFailure: true })
      disputeWindowDays = msMulti[0].status === 'success' ? Number(msMulti[0].result) : 3
      const releasedWei = msMulti[1].status === 'success' ? msMulti[1].result : 0n
      milestones = msMulti.slice(2).map((r, i) => {
        const v = r.status === 'success' ? r.result : ['', 0n, 0, 0n]
        return { index: i, description: v[0], bps: Number(v[1]), status: Number(v[2]), submittedAt: Number(v[3]) }
      })

      const releasedCount = milestones.filter(m => m.status === 2).length
      const progressPct = msCount > 0 ? Math.round(releasedCount * 100 / msCount) : 0
      const releasedEth = formatPriceSync(releasedWei, ethPrices)

      milestonesHtml = `<div class="pd-glass">
        <div class="pd-section-title"><i class="ph ph-flag-checkered" style="margin-right:0.3ch"></i> milestones — ${releasedCount}/${msCount} released · ${releasedEth} distributed</div>
        <div style="margin-bottom:1em"><div class="project-progress-bar"><div class="project-progress-fill" style="width:${progressPct}%;background:#4ade80"></div></div></div>
        ${milestones.map((m, i) => {
          const pctVal = (m.bps / 100).toFixed(0)
          const sLabel = MS_LABELS[m.status] || 'unknown'
          const sColor = MS_COLORS[m.status] || 'var(--dim)'
          const nowSec = Math.floor(Date.now() / 1000)
          const windowEnd = m.submittedAt + disputeWindowDays * 86400
          const windowActive = m.status === 1 && nowSec < windowEnd

          let actionHtml = ''
          if (m.status === 0 && isProposer && p.status == CONFIRMED) {
            const prevOk = i === 0 || milestones[i - 1].status === 2
            if (prevOk) actionHtml = `<button class="buy-btn ms-submit-btn" data-ms-idx="${i}" style="font-size:0.8em;padding:0.3em 1ch;margin-top:0">submit</button>`
          } else if (m.status === 1 && windowActive && isFunder) {
            actionHtml = `<button class="buy-btn ms-dispute-btn" data-ms-idx="${i}" style="font-size:0.8em;padding:0.3em 1ch;border-color:#ef4444;color:#ef4444;background:transparent;margin-top:0">dispute</button>`
          } else if (m.status === 1 && !windowActive) {
            actionHtml = `<button class="buy-btn ms-release-btn" data-ms-idx="${i}" style="font-size:0.8em;padding:0.3em 1ch;border-color:#4ade80;color:#4ade80;background:transparent;margin-top:0">release</button>`
          }

          let countdownHtml = ''
          if (windowActive) {
            const left = windowEnd - nowSec
            const d = Math.floor(left / 86400)
            const h = Math.floor((left % 86400) / 3600)
            const m2 = Math.floor((left % 3600) / 60)
            countdownHtml = `<span class="ms-countdown" data-ms-end="${windowEnd}" style="color:var(--accent);font-size:0.8em;margin-left:1ch">${d}d ${h}h ${m2}m</span>`
          }

          return `<div style="padding:0.75em 0;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:1em">
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:0.5ch;flex-wrap:wrap">
                <span style="color:var(--fg);font-size:0.9em">${i + 1}. ${esc(m.description)}</span>
                <span style="color:var(--dim);font-size:0.75em">${pctVal}%</span>
              </div>
              <div style="display:flex;align-items:center;gap:0.5ch;margin-top:0.25em">
                <span style="color:${sColor};font-size:0.75em;text-transform:uppercase">${sLabel}</span>
                ${countdownHtml}
              </div>
            </div>
            ${actionHtml}
          </div>`
        }).join('')}
        <p id="ms-action-status" style="color:var(--muted);font-size:0.85em;margin-top:0.5em"></p>
      </div>`
    }

    // ── REVENUE SHARING ──
    let revenueHtml = ''
    let revShareBps = 0
    let totalRev = 0n
    let pendingRev = 0n
    let myContribution = 0n

    try {
      const reads = [
        publicClient.readContract({ address: praxisAddr, abi: PRAXIS_ABI, functionName: 'revenueShareBps', args: [BigInt(projectId)] }),
        publicClient.readContract({ address: praxisAddr, abi: PRAXIS_ABI, functionName: 'totalRevenue', args: [BigInt(projectId)] }),
      ]
      if (myAddr && isFunder) {
        reads.push(
          publicClient.readContract({ address: praxisAddr, abi: PRAXIS_ABI, functionName: 'pendingRevenueFor', args: [BigInt(projectId), myAddr] }),
          publicClient.readContract({ address: praxisAddr, abi: PRAXIS_ABI, functionName: 'contributions', args: [BigInt(projectId), myAddr] }),
        )
      }
      const results = await Promise.all(reads)
      revShareBps = Number(results[0])
      totalRev = results[1]
      if (results[2] !== undefined) pendingRev = results[2]
      if (results[3] !== undefined) myContribution = results[3]
    } catch {}

    if (revShareBps > 0) {
      const revPct = (revShareBps / 100).toFixed(0)
      const totalRevEth = formatPriceSync(totalRev, ethPrices)

      revenueHtml = `<div class="pd-glass">
        <div class="pd-section-title"><i class="ph ph-chart-pie" style="margin-right:0.3ch"></i> revenue — ${revPct}% to backers</div>
        <div style="color:var(--fg);font-size:0.9em;margin-bottom:1em">total revenue: <span style="color:var(--accent)">${totalRevEth}</span></div>`

      if (myAddr && isFunder) {
        try {
          const myPct = Number(p.totalFunded) > 0 ? ((Number(myContribution) / Number(p.totalFunded)) * 100).toFixed(1) : '0'
          const pendingEth = formatPriceSync(pendingRev, ethPrices)

          revenueHtml += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75em;margin-bottom:1em">
            <div style="padding:0.75em;border:1px solid var(--border);border-radius:8px">
              <div style="color:var(--dim);font-size:0.7em;text-transform:uppercase;letter-spacing:0.08em">your share</div>
              <div style="color:var(--accent);font-weight:700;font-size:1.1em">${myPct}%</div>
            </div>
            <div style="padding:0.75em;border:1px solid var(--border);border-radius:8px">
              <div style="color:var(--dim);font-size:0.7em;text-transform:uppercase;letter-spacing:0.08em">claimable</div>
              <div style="color:#4ade80;font-weight:700;font-size:1.1em">${pendingEth}</div>
              ${Number(pendingRev) > 0 ? '<button class="buy-btn" id="action-claim-revenue" style="font-size:0.75em;padding:0.3em 0.8em;margin-top:0.3em">claim</button>' : ''}
            </div>
          </div>`
        } catch {}
      }

      if (myAddr && isTeam && p.status == COMPLETED) {
        revenueHtml += `<div style="padding:0.75em;border:1px solid var(--border);border-radius:8px">
          <div style="display:flex;gap:0.5ch;align-items:center">
            <input type="text" id="revenue-amount" placeholder="0.1" class="project-input" style="width:10ch;padding:0.5em 0.8ch;font-size:0.85em">
            <span style="color:var(--dim);font-size:0.85em">ETH</span>
            <button class="buy-btn" id="action-distribute-revenue" style="margin-top:0">send revenue</button>
          </div>
          <p style="color:var(--dim);font-size:0.8em;margin-top:0.25em">${revPct}% goes to backers, rest returns to you</p>
        </div>`
      }

      revenueHtml += '</div>'
    }

    // ── LOCATION ──
    let locationHtml = ''
    const projLoc = unpackLocation(p.location)
    if (projLoc) {
      try {
        const geoRes = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${projLoc.lat}&lon=${projLoc.lng}&format=json`)
        const geoData = await geoRes.json()
        const city = geoData.address?.city || geoData.address?.town || geoData.address?.village || geoData.address?.suburb || ''
        const state = geoData.address?.state || ''
        const country = geoData.address?.country || ''
        const name = [city, state].filter(Boolean).join(', ') || [city, country].filter(Boolean).join(', ') || geoData.display_name?.split(',').slice(0, 2).join(',').trim() || `${projLoc.lat.toFixed(4)}, ${projLoc.lng.toFixed(4)}`
        locationHtml = `<div style="color:var(--dim);font-size:0.85em;margin-bottom:1.5em"><i class="ph ph-map-pin" style="margin-right:0.3ch"></i> ${esc(name)}</div>`
      } catch {
        locationHtml = `<div style="color:var(--dim);font-size:0.85em;margin-bottom:1.5em"><i class="ph ph-map-pin" style="margin-right:0.3ch"></i> ${projLoc.lat.toFixed(4)}, ${projLoc.lng.toFixed(4)}</div>`
      }
    }

    // ── LIFECYCLE ACTIONS ──
    let actionsHtml = ''
    const actionItems = []

    if ((p.status == FUNDED || p.status == CONFIRMED) && isTeam) {
      const myConfirmed = myAddr ? confirmedSet.has(myAddr) : false
      if (p.status == FUNDED && !myConfirmed) {
        actionItems.push(`<button class="buy-btn" id="action-confirm" style="margin-top:0"><i class="ph ph-check-circle" style="margin-right:0.3ch"></i> i'm in</button>`)
      }
    }

    if (p.status == CONFIRMED && isProposer && msCount === 0) {
      actionItems.push(`<button class="buy-btn" id="action-complete" style="margin-top:0"><i class="ph ph-flag" style="margin-right:0.3ch"></i> mark complete</button>`)
    }

    if (p.status == COMPLETING && isFunder) {
      actionItems.push(`<button class="buy-btn" id="action-dispute" style="border-color:#ef4444;color:#ef4444;background:transparent;margin-top:0"><i class="ph ph-warning" style="margin-right:0.3ch"></i> dispute</button>`)
    }
    if (p.status == COMPLETING && isProposer) {
      const disputeEndsAt = p.disputeDeadline
        ? Number(p.disputeDeadline)
        : (p.completedAt ? Number(p.completedAt) + (3 * 86400) : Number(p.createdAt) + (3 * 86400))
      const canFinalize = Math.floor(Date.now() / 1000) >= disputeEndsAt
      actionItems.push(`<button class="buy-btn" id="action-finalize" ${canFinalize ? '' : 'disabled'} style="margin-top:0"><i class="ph ph-seal-check" style="margin-right:0.3ch"></i> finalize</button>`)
    }

    if (p.status == COMPLETED && isTeam) {
      actionItems.push(`<button class="buy-btn" id="action-claim" style="border-color:#4ade80;color:#4ade80;background:transparent;margin-top:0"><i class="ph ph-wallet" style="margin-right:0.3ch"></i> claim funds</button>`)
    }

    if (p.status == PROPOSED && isProposer) {
      actionItems.push(`<button class="buy-btn" id="action-edit-toggle" style="background:transparent;border:1px solid var(--border);color:var(--fg);margin-top:0"><i class="ph ph-pencil-simple" style="margin-right:0.3ch"></i> edit</button>`)
    }

    if ((p.status == PROPOSED || p.status == FUNDED) && isProposer) {
      actionItems.push(`<button class="buy-btn" id="action-cancel" style="border-color:#ef4444;color:#ef4444;background:transparent;margin-top:0"><i class="ph ph-x-circle" style="margin-right:0.3ch"></i> cancel</button>`)
    }

    if (p.status == PROPOSED && isFunder) {
      actionItems.push(`<button class="buy-btn" id="action-withdraw" style="border-color:#ef4444;color:#ef4444;background:transparent;margin-top:0"><i class="ph ph-arrow-u-up-left" style="margin-right:0.3ch"></i> withdraw funding</button>`)
    }

    if (p.status == CANCELLED && isFunder) {
      actionItems.push(`<button class="buy-btn" id="action-refund" style="margin-top:0"><i class="ph ph-arrow-counter-clockwise" style="margin-right:0.3ch"></i> claim refund</button>`)
    }

    // timeout: anyone can call when CONFIRMED and past deadline + 30 days
    if (p.status == CONFIRMED && deadlineDate) {
      const timeoutAt = Number(p.deadline) + (30 * 86400)
      if (Math.floor(Date.now() / 1000) > timeoutAt) {
        actionItems.push(`<button class="buy-btn" id="action-timeout" style="border-color:#ef4444;color:#ef4444;background:transparent;margin-top:0"><i class="ph ph-clock-countdown" style="margin-right:0.3ch"></i> timeout project</button>`)
      }
    }

    // completion invites
    if (p.status == COMPLETED && (isFunder || isTeam)) {
      actionItems.push(`<button class="buy-btn" id="action-claim-invites" style="background:transparent;border:1px solid var(--border);color:var(--fg);margin-top:0"><i class="ph ph-envelope-simple" style="margin-right:0.3ch"></i> claim invite codes</button>`)
    }

    if (actionItems.length > 0) {
      actionsHtml = `<div class="pd-glass">
        <div class="pd-section-title"><i class="ph ph-lightning" style="margin-right:0.3ch"></i> actions</div>
        ${p.status == COMPLETING ? (() => {
          const disputeEndsAt = p.disputeDeadline
            ? Number(p.disputeDeadline)
            : (p.completedAt ? Number(p.completedAt) + (3 * 86400) : Number(p.createdAt) + (3 * 86400))
          const canFinalize = Math.floor(Date.now() / 1000) >= disputeEndsAt
          return `<div style="padding:0.75em;border:1px solid rgba(251,191,36,0.2);border-radius:8px;background:rgba(251,191,36,0.04);margin-bottom:1em;display:flex;align-items:center;gap:0.75em">
            <i class="ph ph-warning" style="color:#fbbf24;font-size:1.2em;flex-shrink:0"></i>
            <span style="font-size:0.85em">dispute window <span id="dispute-countdown" style="color:var(--accent);font-weight:600">${canFinalize ? 'ended' : ''}</span></span>
          </div>`
        })() : ''}
        ${(p.status == FUNDED || p.status == CONFIRMED) && isTeam ? `<div style="color:var(--dim);font-size:0.85em;margin-bottom:0.75em">${confirmCount} of ${totalParticipants} confirmed</div>` : ''}
        <div style="display:flex;gap:0.5em;flex-wrap:wrap">${actionItems.join('')}</div>
        <p id="action-status" style="color:var(--muted);font-size:0.85em;margin-top:0.75em"></p>
      </div>`
    }

    // ── EDIT PROJECT FORM ──
    const descText = isEvent ? cleanDescription : (p.description || '')
    const editFormHtml = p.status == PROPOSED && isProposer ? `<div class="pd-glass pd-edit-form" id="edit-form">
      <div class="pd-section-title"><i class="ph ph-pencil-simple" style="margin-right:0.3ch"></i> edit project</div>
      <div class="pd-edit-field">
        <div class="pd-edit-label">title</div>
        <input class="project-input" id="edit-title" value="${esc(p.title)}">
      </div>
      <div class="pd-edit-field">
        <div class="pd-edit-label">description</div>
        <textarea class="project-input" id="edit-description" style="min-height:6em;resize:vertical">${esc(descText)}</textarea>
      </div>
      <div class="pd-edit-field">
        <div class="pd-edit-label">category</div>
        <select class="project-input" id="edit-type" style="padding:0.6em 0.8ch">${PROJECT_TYPE_PRESETS.map(t => `<option value="${t}" ${t === typeName ? 'selected' : ''}>${t}</option>`).join('')}</select>
      </div>
      <div class="pd-edit-field">
        <div class="pd-edit-label">images</div>
        <div id="edit-image-preview" style="display:flex;gap:0.5em;flex-wrap:wrap;margin-bottom:0.5em"></div>
        <label class="buy-btn" style="display:inline-flex;cursor:pointer;margin-top:0;background:transparent;border:1px solid var(--border);color:var(--fg)">
          <i class="ph ph-image" style="margin-right:0.3ch"></i> add images
          <input type="file" id="edit-images" accept="image/*" multiple style="display:none">
        </label>
      </div>
      <div style="display:flex;gap:0.5em;justify-content:flex-end;margin-top:1em">
        <button class="buy-btn" id="edit-cancel" style="background:transparent;border:1px solid var(--border);color:var(--fg);margin-top:0">cancel</button>
        <button class="buy-btn" id="edit-save" style="margin-top:0"><i class="ph ph-check" style="margin-right:0.3ch"></i> save changes</button>
      </div>
      <p id="edit-status" style="color:var(--muted);font-size:0.85em;margin-top:0.5em"></p>
    </div>` : ''

    // ── MAIN RENDER ──
    contentEl.innerHTML = `
      <div style="margin-bottom:1em">
        <span style="color:var(--dim);font-size:0.7em;text-transform:uppercase;letter-spacing:0.1em">${esc(typeName)}</span>
        <span style="color:${statusColor};font-size:0.7em;text-transform:uppercase;letter-spacing:0.1em;margin-left:1ch">${statusLabel}</span>
      </div>
      <h1 style="color:var(--accent);font-size:1.8em;font-weight:normal;margin-bottom:0.25em">${esc(p.title)}</h1>
      ${isEvent ? `
        <div style="font-size:1.1em;color:var(--fg);margin-bottom:0.5em">${deadlineStr}</div>
        ${eventMeta?.venue ? `<div style="color:var(--muted);font-size:0.95em;margin-bottom:0.25em"><i class="ph ph-map-pin"></i> ${esc(eventMeta.venue)}${eventMeta.venueAddress ? ` · <a href="https://maps.google.com/?q=${encodeURIComponent(eventMeta.venueAddress)}" target="_blank" rel="noopener" style="color:var(--dim);font-size:0.85em">directions</a>` : ''}</div>` : ''}
        ${eventMeta?.ageRestriction ? `<div style="color:var(--dim);font-size:0.8em;margin-bottom:0.5em">${esc(eventMeta.ageRestriction)}</div>` : ''}
        <div style="color:var(--muted);font-size:0.85em;margin-bottom:1.5em">
          hosted by ${profilePicHtml(p.proposer, 18)} <a href="/network?artist=${p.proposer.toLowerCase()}" style="color:var(--fg)">${esc(resolve(p.proposer))}</a>
        </div>
      ` : `
        <div style="color:var(--muted);font-size:0.85em;margin-bottom:1.5em;display:flex;align-items:center;gap:0.5ch;flex-wrap:wrap">
          proposed by ${profilePicHtml(p.proposer, 18)} <a href="/network?artist=${p.proposer.toLowerCase()}" style="color:var(--fg)">${esc(resolve(p.proposer))}</a>
          <span style="color:var(--dim)"> · ${createdStr} · deadline ${deadlineStr}</span>
        </div>
      `}
      ${descText ? `<div style="color:var(--fg);line-height:1.7;max-width:65ch;margin-bottom:1.5em">${renderMarkdown(descText)}</div>` : ''}
      <div id="project-gallery" style="display:none;margin-bottom:1.5em"></div>
      ${locationHtml}

      ${isEvent ? '' : `
      <div class="pd-glass">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:0.5em">
          <div>
            <span style="color:var(--accent);font-size:1.4em;font-weight:700">${fundedEth}</span>
            <span style="color:var(--muted);font-size:0.85em"> / ${goalEth}</span>
          </div>
          <span style="color:${statusColor};font-weight:700;font-size:1.2em">${pct}%</span>
        </div>
        <div class="project-progress-bar"><div class="project-progress-fill" style="width:${Math.min(pct, 100)}%"></div></div>
        <div style="display:flex;gap:2em;font-size:0.8em;color:var(--muted);margin-top:0.5em">
          <span><span style="color:var(--fg);font-weight:600">${data.fundings.items.length}</span> backers</span>
          ${deadlineDate ? `<span><span style="color:var(--fg);font-weight:600">${Math.max(0, Math.ceil((deadlineDate.getTime() - Date.now()) / 86400000))}</span> days left</span>` : ''}
        </div>
      </div>
      `}

      ${tiersHtml ? `<div class="pd-glass" style="padding:0;overflow:hidden">
        <div style="padding:1em 1.25em 0"><div class="pd-section-title"><i class="ph ph-${isEvent ? 'ticket' : 'stack'}" style="margin-right:0.3ch"></i> ${isEvent ? 'tickets' : 'tiers'}</div></div>
        ${tiersHtml}
      </div>` : ''}

      <div id="resale-tickets-section"></div>

      <div class="pd-glass">
        <div class="pd-section-title"><i class="ph ph-users-three" style="margin-right:0.3ch"></i> ${isEvent ? 'organizers' : 'team'}</div>
        ${teamHtml}
        <div id="chat-links" style="margin-top:0.75em;display:flex;gap:0.5em"></div>
      </div>

      ${fundersHtml ? `<div class="pd-glass">
        <div class="pd-section-title"><i class="ph ph-hand-heart" style="margin-right:0.3ch"></i> ${isEvent ? 'attendees' : 'backers'}</div>
        ${fundersHtml}
        ${showAllFunders}
      </div>` : ''}

      ${milestonesHtml}

      <div id="credentials-section"></div>
      <div id="checkin-section"></div>

      ${revenueHtml}
      ${actionsHtml}
      ${editFormHtml}

      <div id="activity-timeline"></div>

      <div id="project-comments"></div>
      <div id="project-comment-form"></div>
    `

    document.title = `${p.title} — project`

    // ── WIRE UP ACTIONS ──

    async function execAction(fn, args, value, meta, { statusId = 'action-status', btnSelector = '.pd-glass .buy-btn' } = {}) {
      const statusEl = document.getElementById(statusId)
      const addr = window.getWalletAddress?.()
      if (!addr) { if (statusEl) statusEl.textContent = 'connect wallet'; return }
      const actionBtns = contentEl.querySelectorAll(btnSelector)
      actionBtns.forEach(b => b.disabled = true)
      if (statusEl) statusEl.textContent = 'confirm in wallet...'
      try {
        await window.ensureScroll?.()
        const currentAccount = await window.authorizedSigner?.(addr)
          const walletClient = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })
        const action = walletClient.writeContract({
          address: praxisAddr, abi: PRAXIS_ABI,
          functionName: fn, args, account: currentAccount,
          ...(value ? { value } : {}),
        })
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('transaction timed out')), 60000))
        const hash = await Promise.race([action, timeout])
        if (statusEl) statusEl.textContent = `tx: ${hash.slice(0, 14)}...`
        await publicClient.waitForTransactionReceipt({ hash })
        if (statusEl) statusEl.textContent = 'done — reloading...'

        if (fn === 'fundTier') {
          try {
            const proposerAddr = p.proposer
            if (proposerAddr && proposerAddr.toLowerCase() !== addr.toLowerCase()) {
              const tierName = meta?.tierName || 'tier'
              const qty = meta?.qty || 1
              const msg = `funded ${p.title} — ${tierName} x${qty}`
              window.dispatchEvent(new CustomEvent('auto-dm', {
                detail: { to: proposerAddr, message: msg }
              }))
            }
          } catch (e) { console.warn('auto-dm failed:', e?.message) }
          maybeCreateProjectGroup(projectId, p, data, addr).catch(() => {})
        }

        reloadAfterTx()
      } catch (e) {
        if (statusEl) statusEl.textContent = formatTxError(e)
      } finally {
        actionBtns.forEach(b => b.disabled = false)
      }
    }
    const msOpts = { statusId: 'ms-action-status', btnSelector: '.ms-submit-btn,.ms-dispute-btn,.ms-release-btn' }

    document.getElementById('action-cancel')?.addEventListener('click', () => {
      if (!confirm('cancel this project? all funders will be refunded')) return
      execAction('cancelProject', [BigInt(projectId)])
    })
    document.getElementById('action-confirm')?.addEventListener('click', () => execAction('confirmProject', [BigInt(projectId)]))
    document.getElementById('action-complete')?.addEventListener('click', () => {
      if (!confirm('mark this project complete? this starts the dispute window for funders.')) return
      execAction('completeProject', [BigInt(projectId)])
    })
    document.getElementById('action-finalize')?.addEventListener('click', () => execAction('finalizeProject', [BigInt(projectId)]))
    document.getElementById('action-dispute')?.addEventListener('click', () => execAction('dispute', [BigInt(projectId)]))
    document.getElementById('action-claim')?.addEventListener('click', () => execAction('claimFunds', []))
    document.getElementById('action-refund')?.addEventListener('click', () => execAction('claimRefund', [BigInt(projectId)]))
    document.getElementById('action-withdraw')?.addEventListener('click', () => {
      if (!confirm('withdraw your funding? you will receive a full refund.')) return
      execAction('withdrawFunding', [BigInt(projectId)])
    })
    document.getElementById('action-timeout')?.addEventListener('click', () => {
      if (!confirm('this project is past its deadline. timing out will cancel it and allow refunds.')) return
      execAction('timeoutProject', [BigInt(projectId)])
    })
    document.getElementById('action-claim-invites')?.addEventListener('click', () => {
      execAction('claimCompletionInvites', [BigInt(projectId)])
    })

    // ── EDIT PROJECT ──
    const _editImages = []
    document.getElementById('action-edit-toggle')?.addEventListener('click', () => {
      const form = document.getElementById('edit-form')
      if (form) {
        form.classList.toggle('active')
        document.getElementById('action-edit-toggle').textContent = form.classList.contains('active') ? 'cancel edit' : 'edit'
      }
    })
    document.getElementById('edit-cancel')?.addEventListener('click', () => {
      const form = document.getElementById('edit-form')
      if (form) form.classList.remove('active')
      const btn = document.getElementById('action-edit-toggle')
      if (btn) btn.innerHTML = '<i class="ph ph-pencil-simple" style="margin-right:0.3ch"></i> edit'
      _editImages.length = 0
    })
    document.getElementById('edit-images')?.addEventListener('change', (e) => {
      const files = Array.from(e.target.files || [])
      const preview = document.getElementById('edit-image-preview')
      for (const file of files) {
        _editImages.push({ file, cid: null })
        const url = URL.createObjectURL(file)
        const img = document.createElement('div')
        img.style.cssText = 'width:60px;height:60px;border-radius:4px;overflow:hidden;border:1px solid var(--border);position:relative'
        img.innerHTML = `<img src="${url}" style="width:100%;height:100%;object-fit:cover;display:block">`
        preview.appendChild(img)
      }
      e.target.value = ''
    })
    document.getElementById('edit-save')?.addEventListener('click', async () => {
      const title = document.getElementById('edit-title')?.value?.trim()
      const description = document.getElementById('edit-description')?.value?.trim()
      const projectType = document.getElementById('edit-type')?.value
      if (!title) { document.getElementById('edit-status').textContent = 'title is required'; return }

      let metadataCid = p.metadataCid || ''
      if (_editImages.length > 0) {
        const statusEl = document.getElementById('edit-status')
        try {
          metadataCid = await _uploadEditImages(_editImages, statusEl)
        } catch (e) {
          statusEl.textContent = `image upload failed: ${e.message}`
          return
        }
      }
      await execAction('updateProject', [BigInt(projectId), title, description || '', projectType || 'other', metadataCid], null, null, { statusId: 'edit-status' })
    })

    // milestone actions
    contentEl.querySelectorAll('.ms-submit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!confirm('submit this milestone for review?')) return
        execAction('submitMilestone', [BigInt(projectId), BigInt(btn.dataset.msIdx)], null, null, msOpts)
      })
    })
    contentEl.querySelectorAll('.ms-dispute-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!confirm('dispute this milestone?')) return
        execAction('disputeMilestone', [BigInt(projectId), BigInt(btn.dataset.msIdx)], null, null, msOpts)
      })
    })
    contentEl.querySelectorAll('.ms-release-btn').forEach(btn => {
      btn.addEventListener('click', () => execAction('releaseMilestone', [BigInt(projectId), BigInt(btn.dataset.msIdx)], null, null, msOpts))
    })

    // milestone countdown timers
    const msCountdownEls = contentEl.querySelectorAll('.ms-countdown')
    if (msCountdownEls.length > 0) {
      const msInterval = setInterval(() => {
        const now = Math.floor(Date.now() / 1000)
        let anyActive = false
        msCountdownEls.forEach(el => {
          const end = parseInt(el.dataset.msEnd)
          const left = end - now
          if (left <= 0) { el.textContent = 'window closed — release available'; return }
          anyActive = true
          const d = Math.floor(left / 86400), h = Math.floor((left % 86400) / 3600), m = Math.floor((left % 3600) / 60)
          el.textContent = `${d}d ${h}h ${m}m`
        })
        if (!anyActive) clearInterval(msInterval)
      }, 60000)
      window.addEventListener('spa-navigate', () => clearInterval(msInterval), { once: true })
    }

    // dispute window countdown
    if (p.status == COMPLETING) {
      const disputeEndsAt = p.disputeDeadline
        ? Number(p.disputeDeadline)
        : (p.completedAt ? Number(p.completedAt) + (3 * 86400) : Number(p.createdAt) + (3 * 86400))
      const canFinalize = Math.floor(Date.now() / 1000) >= disputeEndsAt

      if (!canFinalize) {
        function updateCountdown() {
          const now = Math.floor(Date.now() / 1000)
          const left = disputeEndsAt - now
          if (left <= 0) {
            if (_countdownInterval) { clearInterval(_countdownInterval); _countdownInterval = null }
            const el = document.getElementById('dispute-countdown')
            if (el) el.textContent = 'ended — finalize available'
            const btn = document.getElementById('action-finalize')
            if (btn) { btn.disabled = false }
            return
          }
          const d = Math.floor(left / 86400), h = Math.floor((left % 86400) / 3600), m = Math.floor((left % 3600) / 60), s = left % 60
          const el = document.getElementById('dispute-countdown')
          if (el) el.textContent = `${d}d ${h}h ${m}m ${s}s`
        }
        setTimeout(() => {
          updateCountdown()
          if (_countdownInterval) clearInterval(_countdownInterval)
          _countdownInterval = setInterval(updateCountdown, 1000)
          window.addEventListener('spa-navigate', () => {
            if (_countdownInterval) { clearInterval(_countdownInterval); _countdownInterval = null }
          }, { once: true })
        }, 100)
      }
    }

    // ── QTY STEPPER ──
    contentEl.querySelectorAll('.qty-minus').forEach(btn => {
      btn.addEventListener('click', () => {
        const input = contentEl.querySelector(`.fund-qty[data-tier-id="${btn.dataset.tierId}"]`)
        if (input) input.value = Math.max(1, parseInt(input.value) - 1)
      })
    })
    contentEl.querySelectorAll('.qty-plus').forEach(btn => {
      btn.addEventListener('click', () => {
        const input = contentEl.querySelector(`.fund-qty[data-tier-id="${btn.dataset.tierId}"]`)
        if (input) input.value = Math.min(parseInt(input.max) || 999, parseInt(input.value) + 1)
      })
    })

    // ── FUND TIER with ensureFundsForPurchase ──
    contentEl.querySelectorAll('.fund-tier-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const userAddr = await requireUser('fund this project')
        if (!userAddr) return
        const tierId = BigInt(btn.dataset.tierId)
        const price = BigInt(btn.dataset.price)
        const qtyInput = contentEl.querySelector(`.fund-qty[data-tier-id="${btn.dataset.tierId}"]`)
        const qty = BigInt(Math.max(1, parseInt(qtyInput?.value) || 1))
        const totalValue = price * qty
        const statusEl = document.getElementById('action-status')

        const funded = await ensureFundsForPurchase(totalValue, statusEl)
        if (!funded) return

        execAction('fundTier', [BigInt(projectId), tierId, qty], totalValue, {
          tierName: btn.dataset.tierName || 'tier',
          qty: Number(qty),
        })
      })
    })

    // revenue actions
    document.getElementById('action-claim-revenue')?.addEventListener('click', () => execAction('claimRevenue', [BigInt(projectId)]))

    document.getElementById('action-distribute-revenue')?.addEventListener('click', async () => {
      const amountStr = document.getElementById('revenue-amount')?.value
      if (!amountStr) return
      const statusEl = document.getElementById('action-status')
      const addr = window.getWalletAddress?.()
      if (!addr) { statusEl.textContent = 'connect wallet'; return }
      statusEl.textContent = 'confirm in wallet...'
      try {
        await window.ensureScroll?.()
        const revAccount = await window.authorizedSigner?.(addr)
          const walletClient = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })
        const hash = await walletClient.writeContract({
          address: praxisAddr, abi: PRAXIS_ABI,
          functionName: 'distributeRevenue', args: [BigInt(projectId)],
          value: parseEther(amountStr),
          account: revAccount,
        })
        statusEl.textContent = `tx: ${hash.slice(0, 14)}...`
        await publicClient.waitForTransactionReceipt({ hash })
        statusEl.textContent = 'revenue distributed'
        reloadAfterTx()
      } catch (e) {
        statusEl.textContent = formatTxError(e)
      }
    })

    // show all funders
    document.getElementById('show-all-funders')?.addEventListener('click', function () {
      const allHtml = data.fundings.items.map(f => {
        const domain = resolve(f.funder)
        const amtLabel = formatEthAmount(f.amount) === '0' ? 'free' : formatPriceSync(f.amount, ethPrices)
        const dateStr = new Date(Number(f.timestamp) * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        return `<div class="pd-row">
          <span style="display:flex;align-items:center;gap:0.5ch">${profilePicHtml(f.funder, 20)}<a href="/network?artist=${f.funder.toLowerCase()}" style="color:var(--fg)">${esc(domain)}</a></span>
          <span style="display:flex;gap:1ch;align-items:center"><span style="color:#4ade80;font-variant-numeric:tabular-nums">${amtLabel}</span><span style="color:var(--dim);font-size:0.85em">${dateStr}</span></span>
        </div>`
      }).join('')
      this.parentElement.innerHTML = `<div class="pd-section-title"><i class="ph ph-hand-heart" style="margin-right:0.3ch"></i> ${isEvent ? 'attendees' : 'backers'}</div>${allHtml}`
    })

    // ── GALLERY ──
    if (p.metadataCid) {
      const galleryEl = document.getElementById('project-gallery')
      if (galleryEl) {
        try {
          const metaRes = await fetch(`/api/ipfs-proxy/${p.metadataCid}`)
          const metadata = await metaRes.json()
          if (metadata.images?.length) {
            const imgs = metadata.images
            const isSingle = imgs.length === 1
            galleryEl.style.display = ''
            galleryEl.innerHTML = `<div style="display:${isSingle ? 'block' : 'grid'};${isSingle ? '' : 'grid-template-columns:repeat(auto-fill,minmax(200px,1fr));'}gap:0.5em">${
              imgs.map(img => `<a href="/api/ipfs-proxy/${esc(img.cid)}" target="_blank" style="display:block;border-radius:6px;overflow:hidden;border:1px solid var(--border)"><img src="/api/ipfs-proxy/${esc(img.cid)}" loading="lazy" style="width:100%;${isSingle ? 'max-height:400px;object-fit:cover' : 'height:200px;object-fit:cover'};display:block" alt="${esc(img.name || '')}"></a>`).join('')
            }</div>`
          }
        } catch (e) { console.warn('gallery load error:', e) }
      }
    }

    // ── RESALE TICKETS ──
    const resaleEl = document.getElementById('resale-tickets-section')
    if (resaleEl) {
      try {
        const listings = await getTicketListingsForProject(projectId)
        let ownedTickets = []
        if (myAddr) {
          try {
            const credData = await query(`
              query MyTickets($holder: String!, $projectId: BigInt!) {
                credentials(where: { holder: $holder, projectId: $projectId, tokenType: 1 }, limit: 50) {
                  items { id tierId holder amount tokenId }
                }
              }
            `, { holder: myAddr, projectId: String(projectId) })
            ownedTickets = credData.credentials?.items || []
          } catch {}
        }

        const sellerAddrs = listings.map(l => l.seller)
        const sellerDomains = await resolveAddresses(query, sellerAddrs).catch(() => ({}))

        let resaleHtml = ''
        if (listings.length > 0) {
          resaleHtml += `<div class="pd-section-title"><i class="ph ph-storefront" style="margin-right:0.3ch"></i> ${t('tickets.resale')}</div>`
          for (const listing of listings) {
            const sellerDomain = sellerDomains[listing.seller.toLowerCase()] || `${listing.seller.slice(0, 6)}...${listing.seller.slice(-4)}`
            const priceEth = formatPriceSync(listing.price, ethPrices)
            const isMine = myAddr && listing.seller.toLowerCase() === myAddr
            resaleHtml += `<div class="pd-row">
              <span><a href="/network?artist=${listing.seller.toLowerCase()}" style="color:var(--fg)">${esc(sellerDomain)}</a> <span style="color:var(--accent);margin-left:0.5ch">${priceEth}</span></span>
              ${isMine
                ? `<button class="buy-btn cancel-ticket-btn" data-token-id="${esc(listing.tokenId)}" style="font-size:0.8em;padding:0.3em 1ch;border-color:#ef4444;color:#ef4444;background:transparent;margin-top:0">${t('tickets.cancel')}</button>`
                : `<button class="buy-btn buy-ticket-btn" data-token-id="${esc(listing.tokenId)}" data-price="${esc(listing.price)}" style="font-size:0.8em;padding:0.3em 1ch;margin-top:0">${t('tickets.buy')}</button>`
              }
            </div>`
          }
        }

        const listedTokenIds = new Set(listings.map(l => l.tokenId.toString()))
        const unlistedTickets = ownedTickets.filter(t => !listedTokenIds.has(t.tokenId.toString()))
        if (unlistedTickets.length > 0) {
          resaleHtml += `<div class="pd-section-title" style="margin-top:1em"><i class="ph ph-ticket" style="margin-right:0.3ch"></i> ${t('tickets.yourTickets')}</div>`
          for (const ticket of unlistedTickets) {
            resaleHtml += `<div style="display:flex;gap:0.5ch;align-items:center;padding:0.5em 0;border-bottom:1px solid var(--border);font-size:0.9em">
              <span style="color:var(--fg)">ticket #${ticket.tokenId}</span>
              <input type="text" class="ticket-price-input project-input" data-token-id="${esc(ticket.tokenId)}" placeholder="${t('tickets.enterPrice')}" style="width:10ch;margin-left:auto;padding:0.4em 0.6ch;font-size:0.85em">
              <span style="color:var(--dim);font-size:0.85em">ETH</span>
              <button class="buy-btn list-ticket-btn" data-token-id="${esc(ticket.tokenId)}" style="font-size:0.8em;padding:0.3em 1ch;margin-top:0">${t('tickets.listForSale')}</button>
            </div>`
          }
        }

        if (!resaleHtml && listings.length === 0) {
          const hasTicketTiers = (data.tiers?.items || []).some(tier => tier.transferable)
          if (hasTicketTiers) {
            resaleHtml = `<div class="pd-section-title"><i class="ph ph-storefront" style="margin-right:0.3ch"></i> ${t('tickets.resale')}</div>
              <p style="color:var(--dim);font-size:0.9em">${t('tickets.noListings')}</p>`
          }
        }

        if (resaleHtml) {
          resaleEl.innerHTML = `<div class="pd-glass">${resaleHtml}<p id="ticket-status" style="color:var(--muted);font-size:0.85em;margin-top:0.5em"></p></div>`

          resaleEl.querySelectorAll('.buy-ticket-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
              const statusEl = document.getElementById('ticket-status')
              const funded = await ensureFundsForPurchase(BigInt(btn.dataset.price), statusEl)
              if (!funded) return
              statusEl.textContent = 'confirm in wallet...'
              try {
                await purchaseTicket(btn.dataset.tokenId, btn.dataset.price)
                statusEl.textContent = t('tickets.purchased')
                reloadAfterTx()
              } catch (e) { statusEl.textContent = formatTxError(e) }
            })
          })

          resaleEl.querySelectorAll('.cancel-ticket-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
              const statusEl = document.getElementById('ticket-status')
              statusEl.textContent = 'confirm in wallet...'
              try {
                await cancelTicketListing(btn.dataset.tokenId)
                statusEl.textContent = 'cancelled'
                reloadAfterTx()
              } catch (e) { statusEl.textContent = formatTxError(e) }
            })
          })

          resaleEl.querySelectorAll('.list-ticket-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
              const statusEl = document.getElementById('ticket-status')
              const input = resaleEl.querySelector(`.ticket-price-input[data-token-id="${btn.dataset.tokenId}"]`)
              const priceStr = input?.value?.trim()
              if (!priceStr) { statusEl.textContent = t('tickets.enterPrice'); return }
              statusEl.textContent = 'confirm in wallet...'
              try {
                await listTicket(btn.dataset.tokenId, parseEther(priceStr))
                statusEl.textContent = t('tickets.listed')
                reloadAfterTx()
              } catch (e) { statusEl.textContent = formatTxError(e) }
            })
          })
        }
      } catch (e) { console.warn('resale tickets error:', e) }
    }

    // ── XMTP CHAT LINKS (conditional) ──
    const chatLinksEl = document.getElementById('chat-links')
    if (chatLinksEl) {
      try {
        const groupRes = await fetch(`/api/project-group?id=${projectId}`)
        const groupData = await groupRes.json()
        let linksHtml = ''
        if (groupData.teamGroupId && isTeam) {
          linksHtml += `<a href="/messages?group=${esc(groupData.teamGroupId)}" class="pd-chat-link"><i class="ph ph-chat-teardrop" style="font-size:1.1em"></i> team chat</a>`
        }
        if (groupData.communityGroupId) {
          linksHtml += `<a href="/messages?group=${esc(groupData.communityGroupId)}" class="pd-chat-link"><i class="ph ph-chats" style="font-size:1.1em"></i> community chat</a>`
        }
        chatLinksEl.innerHTML = linksHtml
      } catch {}
    }

    // ── CREDENTIAL HOLDERS ──
    const credSection = document.getElementById('credentials-section')
    if (credSection) {
      try {
        const credData = await query(`
          query ProjectCredentials($projectId: BigInt!) {
            credentials(where: { projectId: $projectId }, limit: 100) {
              items { ${F.credential} }
            }
          }
        `, { projectId: String(projectId) })
        const creds = credData.credentials?.items || []
        if (creds.length > 0) {
          const credAddrs = [...new Set(creds.map(c => c.holder))].filter(a => !domainMap[a?.toLowerCase()])
          if (credAddrs.length > 0) {
            const newDomains = await resolveAddresses(query, credAddrs).catch(() => ({}))
            Object.assign(domainMap, newDomains)
          }
          const tierMap = {}
          for (const tier of (data.tiers?.items || [])) {
            tierMap[String(tier.tierId)] = tier
          }
          const credHtml = creds.map(c => {
            const domain = resolve(c.holder)
            const tier = tierMap[String(c.tierId)]
            const badgeLabel = tier?.name || (c.tokenType === 1 ? 'ticket' : 'producer')
            const badgeColor = c.tokenType === 1 ? '#60a5fa' : '#a78bfa'
            return `<div class="pd-row">
              <span style="display:flex;align-items:center;gap:0.5ch">${profilePicHtml(c.holder, 20)}<a href="/network?artist=${c.holder.toLowerCase()}" style="color:var(--fg);font-size:0.9em">${esc(domain)}</a></span>
              <span class="pd-credential-badge" style="background:${badgeColor};color:#000">${esc(badgeLabel)}</span>
            </div>`
          }).join('')
          credSection.innerHTML = `<div class="pd-glass">
            <div class="pd-section-title"><i class="ph ph-medal" style="margin-right:0.3ch"></i> credential holders</div>
            ${credHtml}
          </div>`
        }
      } catch (e) { console.warn('credentials load error:', e) }
    }

    // ── CHECK-IN (event organizers only) ──
    const checkinSection = document.getElementById('checkin-section')
    if (checkinSection && isEvent && isTeam && (p.status == CONFIRMED || p.status == COMPLETING || p.status == COMPLETED)) {
      try {
        const checkinData = await query(`
          query ProjectCheckins($projectId: BigInt!) {
            checkins(where: { projectId: $projectId }, limit: 200) {
              items { tokenId projectId timestamp }
            }
          }
        `, { projectId: String(projectId) })
        const checkins = checkinData.checkins?.items || []
        const totalTicketsSold = (data.tiers?.items || []).reduce((sum, t) => sum + Number(t.sold), 0)

        checkinSection.innerHTML = `<div class="pd-glass">
          <div class="pd-section-title"><i class="ph ph-qr-code" style="margin-right:0.3ch"></i> check-in</div>
          <div style="display:flex;gap:2em;margin-bottom:1em;font-size:0.85em">
            <span><span style="color:var(--accent);font-weight:700">${checkins.length}</span> checked in</span>
            <span><span style="color:var(--accent);font-weight:700">${totalTicketsSold}</span> tickets sold</span>
            ${totalTicketsSold > 0 ? `<span><span style="color:var(--accent);font-weight:700">${Math.round(checkins.length / totalTicketsSold * 100)}%</span> attendance</span>` : ''}
          </div>
          <div style="display:flex;gap:0.5ch;align-items:center">
            <input type="text" id="checkin-token-id" class="project-input" placeholder="token ID" style="width:12ch;padding:0.5em 0.8ch;font-size:0.85em">
            <button class="buy-btn" id="action-checkin" style="margin-top:0"><i class="ph ph-check-circle" style="margin-right:0.3ch"></i> check in</button>
          </div>
          <p id="checkin-status" style="color:var(--muted);font-size:0.85em;margin-top:0.5em"></p>
        </div>`

        document.getElementById('action-checkin')?.addEventListener('click', async () => {
          const tokenIdStr = document.getElementById('checkin-token-id')?.value?.trim()
          const statusEl = document.getElementById('checkin-status')
          if (!tokenIdStr) { statusEl.textContent = 'enter a token ID'; return }
          await execAction('checkIn', [BigInt(projectId), BigInt(tokenIdStr)], null, null, { statusId: 'checkin-status' })
        })
      } catch (e) { console.warn('checkin section error:', e) }
    }

    // ── ACTIVITY TIMELINE ──
    const timelineEl = document.getElementById('activity-timeline')
    if (timelineEl) {
      try {
        const feedData = await query(`
          query ProjectActivity($refId: String!) {
            feedEntrys(where: { refId: $refId }, orderBy: "timestamp", orderDirection: "desc", limit: 50) {
              items { id author eventType refId title timestamp }
            }
          }
        `, { refId: String(projectId) })
        const events = feedData.feedEntrys?.items || []
        if (events.length > 0) {
          const eventAddrs = [...new Set(events.map(e => e.author))].filter(a => !domainMap[a?.toLowerCase()])
          if (eventAddrs.length > 0) {
            const newDomains = await resolveAddresses(query, eventAddrs).catch(() => ({}))
            Object.assign(domainMap, newDomains)
          }

          const eventTypeConfig = {
            'project': { color: 'var(--fg)', icon: 'ph-flag' },
            'funding': { color: '#4ade80', icon: 'ph-hand-heart' },
            'project-confirmed': { color: '#60a5fa', icon: 'ph-check-circle' },
            'project-completing': { color: '#fbbf24', icon: 'ph-hourglass' },
            'project-completed': { color: '#4ade80', icon: 'ph-flag-checkered' },
            'project-disputed': { color: '#ef4444', icon: 'ph-warning' },
            'project-cancelled': { color: '#666', icon: 'ph-x-circle' },
            'project-timedout': { color: '#ef4444', icon: 'ph-clock-countdown' },
            'revenue-distributed': { color: '#4ade80', icon: 'ph-chart-pie' },
            'credential': { color: '#a78bfa', icon: 'ph-medal' },
            'purchase': { color: '#4ade80', icon: 'ph-shopping-cart' },
          }

          const eventDescriptions = {
            'project': (e) => `<strong>${esc(resolve(e.author))}</strong> proposed project`,
            'funding': (e) => `<strong>${esc(resolve(e.author))}</strong> funded the project`,
            'project-confirmed': (e) => `project confirmed`,
            'project-completing': (e) => `project entering dispute window`,
            'project-completed': (e) => `project completed`,
            'project-disputed': (e) => `<strong>${esc(resolve(e.author))}</strong> disputed the project`,
            'project-cancelled': (e) => `project was cancelled`,
            'project-timedout': (e) => `project timed out past deadline`,
            'revenue-distributed': (e) => `revenue distributed to backers`,
            'credential': (e) => `<strong>${esc(resolve(e.author))}</strong> earned ${esc(e.title || 'credential')}`,
            'purchase': (e) => `<strong>${esc(resolve(e.author))}</strong> purchased`,
          }

          const timelineHtml = events.map(e => {
            const config = eventTypeConfig[e.eventType] || { color: 'var(--dim)', icon: 'ph-circle' }
            const desc = (eventDescriptions[e.eventType] || (() => `<strong>${esc(resolve(e.author))}</strong> ${esc(e.eventType)}`))(e)
            const dateStr = new Date(Number(e.timestamp) * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
            return `<div class="pd-timeline-item">
              <div class="pd-timeline-dot" style="background:${config.color}"></div>
              <div style="flex:1;color:var(--muted)">${desc}</div>
              <span style="color:var(--dim);font-size:0.85em;white-space:nowrap">${dateStr}</span>
            </div>`
          }).join('')

          timelineEl.innerHTML = `<div class="pd-glass">
            <div class="pd-section-title"><i class="ph ph-clock-counter-clockwise" style="margin-right:0.3ch"></i> activity</div>
            ${timelineHtml}
          </div>`
        }
      } catch (e) { console.warn('activity timeline error:', e) }
    }

    // ── COMMENTS ──
    const blogAddr = el.dataset.blog || document.body.dataset.blog
    await loadProjectComments(projectId, p.title, domainMap)
    if (blogAddr && window.getWalletAddress?.()) {
      renderCommentForm(blogAddr, projectId, p.title)
    }
    if (!window._projectCommentWalletBound) {
      window._projectCommentWalletBound = true
      window.addEventListener('wallet-connected', () => {
        if (blogAddr) renderCommentForm(blogAddr, projectId, p.title)
      })
    }

  } catch (e) {
    loadingEl.textContent = 'could not load project'
    console.error('project detail error:', e)
  }
}

// ── Project comments (blog posts with refType=1, refId=projectId) ──

async function loadProjectComments(projectId, projectTitle, domainMap) {
  const commentsEl = document.getElementById('project-comments')
  if (!commentsEl) return

  const resolve = addr => resolveDomain(domainMap, addr)

  async function resolveNewAuthors(items) {
    const newAddrs = items.map(r => r.author).filter(a => !domainMap[a.toLowerCase()])
    if (newAddrs.length > 0) {
      try {
        const newDomains = await resolveAddresses(query, newAddrs)
        Object.assign(domainMap, newDomains)
      } catch {}
    }
  }

  function renderComment(c, isReply) {
    const d = new Date(Number(c.timestamp) * 1000)
    const timeStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    const indent = isReply ? 'margin-left:2ch;' : ''
    return `<div class="project-comment" data-comment-id="${escapeHtml(c.id)}" style="${indent}padding:0.75em 0;border-bottom:1px solid var(--border)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.4em">
        <span style="display:flex;align-items:center;gap:0.5ch">${profilePicHtml(c.author, 20)}<a href="/network?artist=${c.author.toLowerCase()}" style="color:var(--fg);font-size:0.85em;font-weight:500">${escapeHtml(resolve(c.author))}</a></span>
        <time style="color:var(--dim);font-size:0.8em">${timeStr}</time>
      </div>
      <div style="color:var(--fg);font-size:0.9em;line-height:1.65">${renderMarkdown(c.content)}</div>
      <div class="comment-replies" id="replies-for-${escapeHtml(c.id)}"></div>
    </div>`
  }

  let commentsCursor = null
  let commentsHasMore = true

  try {
    const data = await query(`
      query ProjectComments($refId: BigInt!) {
        blogPosts(where: { refType: 1, refId: $refId }, orderBy: "timestamp", orderDirection: "asc", limit: 100) {
          items { ${F.post} }
          totalCount
          ${F.pageInfo}
        }
      }
    `, { refId: projectId })

    const allComments = data.blogPosts?.items || []
    const comments = allComments.filter(c => !isBlocked(c.author))
    const totalCount = comments.length
    commentsCursor = data.blogPosts?.pageInfo?.endCursor
    commentsHasMore = data.blogPosts?.pageInfo?.hasNextPage || false

    if (comments.length === 0) {
      commentsEl.innerHTML = `<div class="pd-glass">
        <div class="pd-section-title"><i class="ph ph-chat-dots" style="margin-right:0.3ch"></i> discussion</div>
        <p style="color:var(--dim);font-size:0.9em">no comments yet</p>
      </div>`
      return
    }

    await resolveNewAuthors(comments)

    commentsEl.innerHTML = `<div class="pd-glass">
      <div class="pd-section-title"><i class="ph ph-chat-dots" style="margin-right:0.3ch"></i> ${totalCount} ${totalCount === 1 ? 'comment' : 'comments'}</div>
      <div id="comments-list">${comments.map(c => renderComment(c, false)).join('')}</div>
      ${commentsHasMore ? `<button id="comments-load-more" class="buy-btn" style="width:100%">load more</button>` : ''}
    </div>`

    const commentIds = comments.map(c => c.id)
    await loadCommentReplies(commentIds, domainMap, resolve)

    document.getElementById('comments-load-more')?.addEventListener('click', async () => {
      const btn = document.getElementById('comments-load-more')
      btn.textContent = 'loading...'
      btn.disabled = true
      try {
        const moreData = await query(`
          query ProjectComments($refId: BigInt!, $after: String) {
            blogPosts(where: { refType: 1, refId: $refId }, orderBy: "timestamp", orderDirection: "asc", limit: 100, after: $after) {
              items { ${F.post} }
              ${F.pageInfo}
            }
          }
        `, { refId: projectId, after: commentsCursor })
        const newComments = (moreData.blogPosts?.items || []).filter(c => !isBlocked(c.author))
        commentsCursor = moreData.blogPosts?.pageInfo?.endCursor
        commentsHasMore = moreData.blogPosts?.pageInfo?.hasNextPage || false

        await resolveNewAuthors(newComments)
        const listEl = document.getElementById('comments-list')
        listEl.insertAdjacentHTML('beforeend', newComments.map(c => renderComment(c, false)).join(''))
        const newIds = newComments.map(c => c.id)
        await loadCommentReplies(newIds, domainMap, resolve)

        if (!commentsHasMore) btn.style.display = 'none'
        else { btn.textContent = 'load more'; btn.disabled = false }
      } catch (e) {
        btn.textContent = 'error loading'
        console.warn('load more comments error:', e)
      }
    })
  } catch (e) { console.warn('project comments error:', e?.message) }
}

async function loadCommentReplies(commentIds, domainMap, resolve) {
  if (!commentIds.length) return

  try {
    const data = await query(`
      query CommentReplies($ids: [BigInt!]!) {
        blogPosts(where: { refType: 3, refId_in: $ids }, orderBy: "timestamp", orderDirection: "asc", limit: 200) {
          items { ${F.post} }
        }
      }
    `, { ids: commentIds })

    const allReplies = (data.blogPosts?.items || []).filter(r => !isBlocked(r.author))
    if (!allReplies.length) return

    const newAddrs = [...new Set(allReplies.map(r => r.author))].filter(a => !domainMap[a.toLowerCase()])
    if (newAddrs.length > 0) {
      try {
        const newDomains = await resolveAddresses(query, newAddrs)
        Object.assign(domainMap, newDomains)
      } catch {}
    }

    const byParent = new Map()
    for (const r of allReplies) {
      const pid = String(r.refId)
      if (!byParent.has(pid)) byParent.set(pid, [])
      byParent.get(pid).push(r)
    }

    for (const commentId of commentIds) {
      const replies = byParent.get(String(commentId)) || []
      if (!replies.length) continue
      const repliesEl = document.getElementById(`replies-for-${commentId}`)
      if (repliesEl) {
        repliesEl.innerHTML = replies.map(r => {
          const d = new Date(Number(r.timestamp) * 1000)
          const timeStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
          return `<div style="margin-left:2ch;padding:0.6em 0;border-top:1px solid var(--border)">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.25em">
              <span style="display:flex;align-items:center;gap:0.5ch">${profilePicHtml(r.author, 18)}<a href="/network?artist=${r.author.toLowerCase()}" style="color:var(--fg);font-size:0.8em;font-weight:500">${escapeHtml(resolve(r.author))}</a></span>
              <time style="color:var(--dim);font-size:0.75em">${timeStr}</time>
            </div>
            <div style="color:var(--fg);font-size:0.88em;line-height:1.6">${renderMarkdown(r.content)}</div>
          </div>`
        }).join('')
      }
    }
  } catch (e) { console.warn('comment replies error:', e?.message) }
}

function renderCommentForm(blogAddr, projectId, projectTitle) {
  const formEl = document.getElementById('project-comment-form')
  if (!formEl || formEl.dataset.rendered) return
  formEl.dataset.rendered = '1'

  formEl.innerHTML = `<div class="pd-glass">
    <textarea id="comment-content" class="project-input" placeholder="add a comment..." style="min-height:4em;resize:vertical;line-height:1.6;margin-bottom:0.5em"></textarea>
    <div style="display:flex;justify-content:space-between;align-items:center">
      <span id="comment-status" style="color:var(--muted);font-size:0.85em"></span>
      <button class="buy-btn" id="comment-submit" style="font-size:0.85em;padding:0.4em 1.5ch;margin-top:0"><i class="ph ph-paper-plane-tilt" style="margin-right:0.3ch"></i> comment</button>
    </div>
  </div>`

  document.getElementById('comment-submit')?.addEventListener('click', async () => {
    const content = document.getElementById('comment-content').value.trim()
    const statusEl = document.getElementById('comment-status')
    if (!content) { statusEl.textContent = 'write something'; return }

    const addr = window.getWalletAddress?.()
    if (!addr) { statusEl.textContent = 'connect wallet'; return }

    statusEl.textContent = 'confirm in wallet...'
    try {
      const publicClient = await getPublicClient()
      const title = `comment on ${projectTitle}`
      await window.ensureScroll?.()
      const commentAccount = await window.authorizedSigner?.(addr)
          const walletClient = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })
      const hash = await walletClient.writeContract({
        address: blogAddr, abi: BLOG_ABI, functionName: 'postWithRef',
        args: [title, content, 1, BigInt(projectId)],
        account: commentAccount,
      })
      statusEl.textContent = `tx: ${hash.slice(0, 14)}...`
      await publicClient.waitForTransactionReceipt({ hash })
      statusEl.textContent = 'comment posted'
      reloadAfterTx()
    } catch (e) {
      statusEl.textContent = e.code === 4001 ? 'cancelled' : `error: ${(e.shortMessage || e.message).slice(0, 60)}`
    }
  })
}
