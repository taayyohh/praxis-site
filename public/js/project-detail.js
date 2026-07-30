// Project detail page — full view of a single project with lifecycle controls
import { F } from './fragments.js'
import { createWalletClient, custom, parseEther } from './vendor.js'
import { optimism } from './vendor.js'
import { query } from './ponder.js'
import { escapeHtml, resolveAddresses, formatTxError, getPublicClient , formatEthAmount, registerPage, isBlocked, requireUser , getWalletProvider, parseEventMetadata, renderMarkdown, unpackLocation, slugify } from './utils.js'
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

/**
 * Auto-create TWO XMTP group chats for a project after first funding:
 * 1. Team group (proposer + collaborators) — internal coordination
 * 2. Community group (proposer + collaborators + funders) — public updates
 * Skips silently if XMTP is not initialized or groups already exist.
 */
async function maybeCreateProjectGroup(projectId, project, data, funderAddr) {
  const client = window._xmtpClient
  const sdk = window._xmtpSdk
  if (!client || !sdk) return

  // Check if groups already exist
  try {
    const checkRes = await fetch(`/api/project-group?id=${projectId}`)
    const checkData = await checkRes.json()
    if (checkData.teamGroupId || checkData.communityGroupId) return
  } catch {
    return
  }

  const myAddr = window.getWalletAddress?.()?.toLowerCase()
  const title = project.title || `Project #${projectId}`

  // Collect team addresses (proposer + collaborators)
  const teamAddrs = new Set()
  if (project.proposer) teamAddrs.add(project.proposer.toLowerCase())
  for (const c of (data.collaborators?.items || [])) {
    if (c.artist) teamAddrs.add(c.artist.toLowerCase())
  }

  // Community = team + funder
  const communityAddrs = new Set(teamAddrs)
  if (funderAddr) communityAddrs.add(funderAddr.toLowerCase())

  // Resolve inbox IDs helper
  async function resolveInboxIds(addrs) {
    const filtered = addrs.filter(a => a !== myAddr)
    const results = await Promise.all(filtered.map(async addr => {
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
    }))
    return results.filter(Boolean)
  }

  try {
    const [teamIds, communityIds] = await Promise.all([
      resolveInboxIds(teamAddrs),
      resolveInboxIds(communityAddrs),
    ])

    // Create both groups in parallel
    const [teamGroup, communityGroup] = await Promise.all([
      client.conversations.createGroup(teamIds, { name: `${title} — team` }),
      client.conversations.createGroup(communityIds, { name: title }),
    ])

    // Store both group IDs on server
    const token = sessionStorage.getItem('praxis-auth-token') || localStorage.getItem('praxis-auth-token')
    const headers = { 'Content-Type': 'application/json' }
    if (token) headers['Authorization'] = `Bearer ${token}`
    await fetch(`/api/project-group?id=${projectId}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ teamGroupId: teamGroup.id, communityGroupId: communityGroup.id }),
    })

    console.log(`praxis: auto-created team + community groups for project ${projectId}`)
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

async function initProjectDetail() {
  const el = document.getElementById('project-detail-page')
  if (!el) return
  const params = new URLSearchParams(window.location.search)
  let projectId = params.get('id')
  const loadingEl = document.getElementById('project-detail-loading')
  const contentEl = document.getElementById('project-detail-content')
  const praxisAddr = el.dataset.praxis
  const registryAddr = el.dataset.registry

  // Vanity slug: /project/<slug>
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
      // Wrap arrays in items to match expected shape
      if (data.collaborators && !data.collaborators.items) data.collaborators = { items: data.collaborators }
      if (data.tiers && !data.tiers.items) data.tiers = { items: data.tiers }
      if (data.fundings && !data.fundings.items) data.fundings = { items: data.fundings }
    } catch {
      // Fallback to direct Ponder query
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

    // Use pre-resolved domains from materialized endpoint, or resolve on demand
    let domainMap = data.domains || {}
    if (!Object.keys(domainMap).length) {
      const addressesToResolve = [
        p.proposer,
        ...data.collaborators.items.map(c => c.artist),
        ...data.fundings.items.map(f => f.funder),
      ].filter(Boolean)
      domainMap = await resolveAddresses(query, addressesToResolve).catch(() => ({}))
    }
    const resolve = addr => domainMap[addr.toLowerCase()] || `${addr.slice(0, 6)}...${addr.slice(-4)}`
    const myAddr = window.getWalletAddress?.()?.toLowerCase()
    const isProposer = myAddr === p.proposer.toLowerCase()
    const isCollaborator = data.collaborators.items.some(c => c.artist.toLowerCase() === myAddr)
    const isFunder = data.fundings.items.some(f => f.funder.toLowerCase() === myAddr)

    const [publicClient, ethPrices] = await Promise.all([getPublicClient(), getEthPrices().catch(() => null)])

    const goalEth = formatEthAmount(p.fundingGoal)
    const fundedEth = formatEthAmount(p.totalFunded)
    const pct = Number(p.fundingGoal) > 0 ? Math.round(Number(p.totalFunded) * 100 / Number(p.fundingGoal)) : 0
    const typeName = p.projectType || 'other'
    const isEvent = typeName === 'show' || typeName === 'theater' || typeName === 'workshop'
    const statusLabel = isEvent
      ? { 0: 'tickets available', 1: 'tickets available', 2: 'confirmed', 3: 'happening soon', 4: 'event over', 5: 'cancelled', 6: 'disputed' }[p.status] || STATUS_LABELS[p.status]
      : STATUS_LABELS[p.status] || 'unknown'
    const statusColor = STATUS_COLORS[p.status] || '#666'

    // Parse event metadata from description (if present)
    const { meta: eventMeta, text: cleanDescription } = parseEventMetadata(p.description)
    const eventDate = eventMeta?.eventDate ? new Date(eventMeta.eventDate) : null
    const deadlineDate = p.deadline > 0 ? new Date(Number(p.deadline) * 1000) : null
    const deadlineStr = isEvent && eventDate
      ? eventDate.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) + (eventMeta.doorsTime ? ` · doors ${escapeHtml(eventMeta.doorsTime)}` : '')
      : deadlineDate ? deadlineDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : 'no deadline'
    const createdStr = new Date(Number(p.createdAt) * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })

    // batch-check hasConfirmed for ALL collaborators (including proposer)
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

    // team section
    const teamHtml = data.collaborators.items.map(c => {
      const domain = resolve(c.artist)
      const splitPct = (Number(c.split) / 100).toFixed(0)
      const isConfirmed = confirmedSet.has(c.artist.toLowerCase())
      const confirmLabel = p.status >= FUNDED
        ? (isConfirmed
          ? '<span style="color:#4ade80;font-size:0.8em;margin-left:0.5ch">confirmed</span>'
          : '<span style="color:var(--dim);font-size:0.8em;margin-left:0.5ch">pending</span>')
        : ''
      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:0.5em 0;border-bottom:1px solid var(--border);font-size:0.9em">
        <span><a href="/network?artist=${c.artist.toLowerCase()}" style="color:var(--fg)">${escapeHtml(domain)}</a>${confirmLabel}</span>
        <span>${splitPct}%</span>
      </div>`
    }).join('')

    // tiers section
    const tiersHtml = (data.tiers?.items || []).map(t => {
      const priceEth = formatPriceSync(t.price, ethPrices)
      const isFreeRsvp = Number(t.price) <= 1000 // 1000 wei ≈ free
      const remaining = Number(t.maxSupply) - Number(t.sold)
      const badge = isEvent
        ? (isFreeRsvp ? '<span style="color:#4ade80;font-size:0.7em;text-transform:uppercase">free rsvp</span>' : '<span style="color:#4ade80;font-size:0.7em;text-transform:uppercase">ticket</span>')
        : (t.transferable ? '<span style="color:#4ade80;font-size:0.7em;text-transform:uppercase">ticket</span>' : '<span style="color:#a78bfa;font-size:0.7em;text-transform:uppercase">producer</span>')
      const priceLabel = isEvent && isFreeRsvp ? 'free' : priceEth
      const capacityLabel = isEvent
        ? (remaining > 0 ? `${remaining} spot${remaining !== 1 ? 's' : ''} left` : 'sold out')
        : `${t.sold}/${t.maxSupply} sold`
      const btnLabel = isEvent ? (isFreeRsvp ? 'RSVP' : 'get tickets') : 'fund'
      const tierDateStr = t.eventDate && BigInt(t.eventDate) > 0n
        ? new Date(Number(t.eventDate) * 1000).toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        : ''
      const tierLoc = unpackLocation(t.location)
      const tierLocStr = tierLoc ? `${tierLoc.lat.toFixed(4)}, ${tierLoc.lng.toFixed(4)}` : ''
      return `<div style="border:1px solid var(--border);padding:1em">
        <div>${badge}</div>
        <div style="color:var(--accent);margin:0.25em 0">${escapeHtml(t.name)}</div>
        ${tierDateStr ? `<div style="color:var(--dim);font-size:0.8em;margin-bottom:0.25em"><i class="ph ph-calendar" style="margin-right:0.3ch"></i> ${tierDateStr}</div>` : ''}
        ${tierLocStr ? `<div style="color:var(--dim);font-size:0.8em;margin-bottom:0.25em"><i class="ph ph-map-pin" style="margin-right:0.3ch"></i> ${tierLocStr}</div>` : ''}
        <div style="color:var(--fg);font-size:0.9em">${priceLabel}</div>
        <div style="color:var(--dim);font-size:0.8em">${capacityLabel}</div>
        ${remaining > 0 && p.status <= FUNDED ? `<div style="display:flex;gap:0.5ch;align-items:center;margin-top:0.5em">
          <input type="number" class="fund-qty" data-tier-id="${t.tierId}" value="1" min="1" max="${remaining}" style="width:4ch;background:transparent;border:1px solid var(--border);color:var(--fg);font-family:inherit;font-size:0.85em;padding:0.3em 0.5ch;text-align:center">
          <button class="buy-btn fund-tier-btn" data-tier-id="${t.tierId}" data-price="${t.price}" style="font-size:0.85em;padding:0.3em 1ch">${btnLabel}</button>
        </div>` : ''}
      </div>`
    }).join('')

    // funders section
    const fundersHtml = data.fundings.items.slice(0, 20).map(f => {
      const domain = resolve(f.funder)
      const amtLabel = formatEthAmount(f.amount) === '0' ? 'free' : formatPriceSync(f.amount, ethPrices)
      return `<div style="font-size:0.85em;padding:0.3em 0"><a href="/network?artist=${f.funder.toLowerCase()}" style="color:var(--fg)">${escapeHtml(domain)}</a> <span style="color:#4ade80">${amtLabel}</span></div>`
    }).join('')

    // milestone count — needed before actions block to gate "mark complete"
    let msCount = 0
    try {
      msCount = Number(await publicClient.readContract({ address: praxisAddr, abi: PRAXIS_ABI, functionName: 'milestoneCount', args: [BigInt(projectId)] }))
    } catch {}

    // lifecycle actions
    let actionsHtml = '<div id="project-actions" style="margin-top:1.5em;padding-top:1em;border-top:1px solid var(--border)">'

    if ((p.status == FUNDED || p.status == CONFIRMED) && (isProposer || isCollaborator)) {
      // FUNDED or CONFIRMED — show confirmation progress
      const myConfirmed = myAddr ? confirmedSet.has(myAddr) : false

      actionsHtml += `<div style="color:var(--dim);font-size:0.85em;margin-bottom:0.5em">${confirmCount} of ${totalParticipants} confirmed</div>`

      if (p.status == CONFIRMED) {
        actionsHtml += '<span style="color:#4ade80;font-size:0.85em">all confirmed</span> '
      } else if (myConfirmed) {
        actionsHtml += '<span style="color:var(--muted);font-size:0.85em">you confirmed -- waiting for team</span> '
      } else {
        actionsHtml += '<button class="buy-btn" id="action-confirm">i\'m in</button> '
      }
    }

    if (p.status == CONFIRMED && isProposer && msCount === 0) {
      // CONFIRMED non-milestone — proposer can complete
      actionsHtml += '<button class="buy-btn" id="action-complete">mark complete</button> '
      actionsHtml += '<span style="color:var(--dim);font-size:0.8em">all confirmed -- proposer can mark complete (starts dispute window)</span> '
    }

    if (p.status == COMPLETING) {
      // COMPLETING — dispute window with live countdown
      // Use disputeDeadline from Ponder (set by ProjectCompleting event), fallback to completedAt + 3 days
      const disputeEndsAt = p.disputeDeadline
        ? Number(p.disputeDeadline)
        : (p.completedAt ? Number(p.completedAt) + (3 * 86400) : Number(p.createdAt) + (3 * 86400))
      const nowSec = Math.floor(Date.now() / 1000)
      const remaining = disputeEndsAt - nowSec
      const canFinalize = remaining <= 0

      actionsHtml += `<div style="margin-bottom:0.75em">
        <span style="color:#fbbf24;font-size:0.85em">dispute window</span>
        <span id="dispute-countdown" style="color:var(--accent);font-size:0.9em;margin-left:1ch">${canFinalize ? 'ended' : ''}</span>
      </div>`
      if (isFunder) {
        actionsHtml += '<button class="buy-btn" id="action-dispute" style="border-color:#ef4444;color:#ef4444">dispute</button> '
      }
      if (isProposer) {
        actionsHtml += `<button class="buy-btn" id="action-finalize" ${canFinalize ? '' : 'disabled'}>finalize</button> `
      }

      // live countdown
      if (!canFinalize) {
        function updateCountdown() {
          const now = Math.floor(Date.now() / 1000)
          const left = disputeEndsAt - now
          if (left <= 0) {
            if (_countdownInterval) { clearInterval(_countdownInterval); _countdownInterval = null }
            const el = document.getElementById('dispute-countdown')
            if (el) el.textContent = 'ended — finalize available'
            const btn = document.getElementById('action-finalize')
            if (btn) { btn.disabled = false; btn.style = '' }
            return
          }
          const d = Math.floor(left / 86400)
          const h = Math.floor((left % 86400) / 3600)
          const m = Math.floor((left % 3600) / 60)
          const s = left % 60
          const el = document.getElementById('dispute-countdown')
          if (el) el.textContent = `${d}d ${h}h ${m}m ${s}s`
        }
        setTimeout(() => {
          updateCountdown()
          if (_countdownInterval) clearInterval(_countdownInterval)
          _countdownInterval = setInterval(updateCountdown, 1000)
          // register cleanup every init (not guarded — SPA may re-init)
          const cleanupFn = () => {
            if (_countdownInterval) { clearInterval(_countdownInterval); _countdownInterval = null }
          }
          window.addEventListener('spa-navigate', cleanupFn, { once: true })
        }, 100)
      }
    }

    if (p.status == COMPLETED && (isProposer || isCollaborator)) {
      // COMPLETED — claim funds
      actionsHtml += '<button class="buy-btn" id="action-claim" style="border-color:#4ade80;color:#4ade80">claim funds</button> '
    }

    if ((p.status == PROPOSED || p.status == FUNDED) && isProposer) {
      // PROPOSED or FUNDED — proposer can cancel
      actionsHtml += '<button class="buy-btn" id="action-cancel" style="border-color:#ef4444;color:#ef4444">cancel project</button> '
    }

    if (p.status == CANCELLED && isFunder) {
      // CANCELLED — claim refund
      actionsHtml += '<button class="buy-btn" id="action-refund">claim refund</button> '
    }

    actionsHtml += '<p id="action-status" style="color:var(--muted);font-size:0.85em;margin-top:0.5em"></p></div>'

    // location display
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
        locationHtml = `<div style="color:var(--dim);font-size:0.85em;margin-bottom:1.5em"><i class="ph ph-map-pin" style="margin-right:0.3ch"></i> ${escapeHtml(name)}</div>`
      } catch {
        locationHtml = `<div style="color:var(--dim);font-size:0.85em;margin-bottom:1.5em"><i class="ph ph-map-pin" style="margin-right:0.3ch"></i> ${projLoc.lat.toFixed(4)}, ${projLoc.lng.toFixed(4)}</div>`
      }
    }

    // milestones section — read from contract (msCount already loaded above)
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
        const v = r.status === 'success' ? r.result : ['' , 0n, 0, 0n]
        return { index: i, description: v[0], bps: Number(v[1]), status: Number(v[2]), submittedAt: Number(v[3]) }
      })

      const releasedCount = milestones.filter(m => m.status === 2).length
      const progressPct = msCount > 0 ? Math.round(releasedCount * 100 / msCount) : 0
      const releasedEth = formatEthAmount(releasedWei)

      milestonesHtml = `<div style="margin-bottom:2em;padding-top:1em;border-top:1px solid var(--border)">
        <h3 style="color:var(--muted);font-size:0.8em;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:0.75em">milestones — ${releasedCount}/${msCount} released · ${releasedEth} ETH distributed</h3>
        <div style="margin-bottom:1em"><div class="project-progress-bar"><div class="project-progress-fill" style="width:${progressPct}%;background:#4ade80"></div></div></div>
        <div style="display:grid;gap:0.75em">${milestones.map((m, i) => {
          const pct = (m.bps / 100).toFixed(0)
          const statusLabel = MS_LABELS[m.status] || 'unknown'
          const statusColor = MS_COLORS[m.status] || 'var(--dim)'
          const nowSec = Math.floor(Date.now() / 1000)
          const windowEnd = m.submittedAt + disputeWindowDays * 86400
          const windowActive = m.status === 1 && nowSec < windowEnd

          let actionHtml = ''
          if (m.status === 0 && isProposer && p.status == CONFIRMED) {
            const prevOk = i === 0 || milestones[i - 1].status === 2
            if (prevOk) actionHtml = `<button class="buy-btn ms-submit-btn" data-ms-idx="${i}" style="font-size:0.8em;padding:0.3em 1ch">submit</button>`
          } else if (m.status === 1 && windowActive && isFunder) {
            actionHtml = `<button class="buy-btn ms-dispute-btn" data-ms-idx="${i}" style="font-size:0.8em;padding:0.3em 1ch;border-color:#ef4444;color:#ef4444">dispute</button>`
          } else if (m.status === 1 && !windowActive) {
            actionHtml = `<button class="buy-btn ms-release-btn" data-ms-idx="${i}" style="font-size:0.8em;padding:0.3em 1ch;border-color:#4ade80;color:#4ade80">release</button>`
          }

          let countdownHtml = ''
          if (windowActive) {
            const left = windowEnd - nowSec
            const d = Math.floor(left / 86400)
            const h = Math.floor((left % 86400) / 3600)
            const m2 = Math.floor((left % 3600) / 60)
            countdownHtml = `<span class="ms-countdown" data-ms-end="${windowEnd}" style="color:var(--accent);font-size:0.8em;margin-left:1ch">${d}d ${h}h ${m2}m</span>`
          }

          return `<div style="padding:0.75em 1em;border:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:1em">
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:0.5ch;flex-wrap:wrap">
                <span style="color:var(--fg);font-size:0.9em">${escapeHtml(m.description)}</span>
                <span style="color:var(--dim);font-size:0.75em">${pct}%</span>
              </div>
              <div style="display:flex;align-items:center;gap:0.5ch;margin-top:0.25em">
                <span style="color:${statusColor};font-size:0.75em;text-transform:uppercase">${statusLabel}</span>
                ${countdownHtml}
              </div>
            </div>
            ${actionHtml}
          </div>`
        }).join('')}</div>
        <p id="ms-action-status" style="color:var(--muted);font-size:0.85em;margin-top:0.5em"></p>
      </div>`
    }

    // revenue sharing section — batch all RPC reads
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

      revenueHtml = `<div style="margin-top:2em;padding-top:1.5em;border-top:1px solid var(--border)">
        <h3 style="color:var(--muted);font-size:0.8em;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:0.75em">revenue sharing -- ${revPct}% to funders</h3>
        <div style="color:var(--fg);font-size:0.9em;margin-bottom:1em">total revenue received: <span style="color:var(--accent)">${totalRevEth}</span></div>`

      if (myAddr && isFunder) {
        try {
          const myPct = Number(p.totalFunded) > 0 ? ((Number(myContribution) / Number(p.totalFunded)) * 100).toFixed(1) : '0'
          const pendingEth = formatPriceSync(pendingRev, ethPrices)

          revenueHtml += `<div style="padding:1em;border:1px solid var(--border);margin-bottom:1em">
            <div style="color:var(--fg);font-size:0.9em">you own <span style="color:var(--accent)">${myPct}%</span> of funder revenue</div>
            <div style="color:var(--fg);font-size:0.9em;margin-top:0.25em">claimable: <span style="color:#4ade80">${pendingEth}</span></div>
            ${Number(pendingRev) > 0 ? '<button class="buy-btn" id="action-claim-revenue" style="margin-top:0.5em">claim revenue</button>' : ''}
          </div>`
        } catch {}
      }

      // team view: send revenue form
      if (myAddr && (isProposer || isCollaborator) && p.status == COMPLETED) {
        revenueHtml += `<div style="padding:1em;border:1px solid var(--border)">
          <div style="display:flex;gap:0.5ch;align-items:center">
            <input type="text" id="revenue-amount" placeholder="0.1" class="project-input" style="width:10ch">
            <span style="color:var(--dim);font-size:0.85em">ETH</span>
            <button class="buy-btn" id="action-distribute-revenue">send revenue</button>
          </div>
          <p style="color:var(--dim);font-size:0.8em;margin-top:0.25em">${revPct}% goes to funders, rest returns to you</p>
        </div>`
      }

      revenueHtml += '</div>'
    }

    contentEl.innerHTML = `
      <div style="margin-bottom:1em">
        <span style="color:var(--dim);font-size:0.7em;text-transform:uppercase;letter-spacing:0.1em">${escapeHtml(typeName)}</span>
        <span style="color:${statusColor};font-size:0.7em;text-transform:uppercase;letter-spacing:0.1em;margin-left:1ch">${statusLabel}</span>
      </div>
      <h1 style="color:var(--accent);font-size:1.8em;font-weight:normal;margin-bottom:0.25em">${escapeHtml(p.title)}</h1>
      ${isEvent ? `
        <div style="font-size:1.1em;color:var(--fg);margin-bottom:0.5em">${deadlineStr}</div>
        ${eventMeta?.venue ? `<div style="color:var(--muted);font-size:0.95em;margin-bottom:0.25em"><i class="ph ph-map-pin"></i> ${escapeHtml(eventMeta.venue)}${eventMeta.venueAddress ? ` · <a href="https://maps.google.com/?q=${encodeURIComponent(eventMeta.venueAddress)}" target="_blank" rel="noopener" style="color:var(--dim);font-size:0.85em">directions</a>` : ''}</div>` : ''}
        ${eventMeta?.ageRestriction ? `<div style="color:var(--dim);font-size:0.8em;margin-bottom:0.5em">${escapeHtml(eventMeta.ageRestriction)}</div>` : ''}
        <div style="color:var(--muted);font-size:0.85em;margin-bottom:1.5em">
          hosted by <a href="/network?artist=${p.proposer.toLowerCase()}" style="color:var(--fg)">${escapeHtml(resolve(p.proposer))}</a>
        </div>
      ` : `
        <div style="color:var(--muted);font-size:0.85em;margin-bottom:1.5em">
          proposed by <a href="/network?artist=${p.proposer.toLowerCase()}" style="color:var(--fg)">${escapeHtml(resolve(p.proposer))}</a>
          <span style="color:var(--dim)"> · ${createdStr} · funding deadline ${deadlineStr}</span>
        </div>
      `}
      ${(isEvent ? cleanDescription : p.description) ? `<p style="color:var(--fg);line-height:1.7;max-width:65ch;margin-bottom:1em">${escapeHtml(isEvent ? cleanDescription : p.description)}</p>` : ''}
      <div id="project-gallery" style="display:none;margin-bottom:1.5em"></div>
      ${locationHtml}

      ${isEvent ? '' : `
      <div style="margin-bottom:2em">
        <div style="display:flex;justify-content:space-between;font-size:0.9em;margin-bottom:0.4em">
          <span style="color:var(--fg)" data-eth-wei="${p.goal || '0'}">${fundedEth} / ${goalEth} ETH</span>
          <span style="color:${statusColor}">${pct}%</span>
        </div>
        <div class="project-progress-bar"><div class="project-progress-fill" style="width:${Math.min(pct, 100)}%"></div></div>
      </div>
      `}

      ${tiersHtml ? `<div style="margin-bottom:2em"><h3 style="color:var(--muted);font-size:0.8em;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:0.75em">${isEvent ? 'tickets' : 'tiers'}</h3><div style="display:grid;gap:1em">${tiersHtml}</div></div>` : ''}

      <div id="resale-tickets-section" style="margin-bottom:2em"></div>

      <div style="margin-bottom:2em">
        <h3 style="color:var(--muted);font-size:0.8em;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:0.75em">${isEvent ? 'organizers' : 'team'}</h3>
        ${teamHtml}
      </div>

      ${fundersHtml ? `<div style="margin-bottom:2em"><h3 style="color:var(--muted);font-size:0.8em;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:0.75em">${isEvent ? 'attendees' : 'backers'}</h3>${fundersHtml}</div>` : ''}

      ${milestonesHtml}
      ${actionsHtml}
      ${revenueHtml}

      <div id="project-comments" style="margin-top:2em;padding-top:1.5em;border-top:1px solid var(--border)"></div>
      <div id="project-comment-form" style="margin-top:1.5em"></div>
    `

    document.title = `${p.title} — project`

    // wire up actions

    async function execAction(fn, args, value, meta, { statusId = 'action-status', btnSelector = '#project-actions .buy-btn' } = {}) {
      const statusEl = document.getElementById(statusId)
      const addr = window.getWalletAddress?.()
      if (!addr) { if (statusEl) statusEl.textContent = 'connect wallet'; return }
      const actionBtns = contentEl.querySelectorAll(btnSelector)
      actionBtns.forEach(b => b.disabled = true)
      if (statusEl) statusEl.textContent = 'confirm in wallet...'
      try {
        await window.ensureScroll?.()
        const currentAccount = await window.ensureAuthorized?.() || addr
        const walletClient = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })
        const action = walletClient.writeContract({
          address: praxisAddr, abi: PRAXIS_ABI,
          functionName: fn, args, account: currentAccount,
          ...(value ? { value } : {}),
        })
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('transaction timed out')), 15000))
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

    // milestone actions
    contentEl.querySelectorAll('.ms-submit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!confirm('submit this milestone for review?')) return
        execAction('submitMilestone', [BigInt(projectId), BigInt(btn.dataset.msIdx)], null, null, msOpts)
      })
    })
    contentEl.querySelectorAll('.ms-dispute-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!confirm('dispute this milestone? if enough backers dispute (≥50% by value), the project is cancelled and all remaining funds are refundable.')) return
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
          if (left <= 0) {
            el.textContent = 'window closed — release available'
            return
          }
          anyActive = true
          const d = Math.floor(left / 86400)
          const h = Math.floor((left % 86400) / 3600)
          const m = Math.floor((left % 3600) / 60)
          el.textContent = `${d}d ${h}h ${m}m`
        })
        if (!anyActive) clearInterval(msInterval)
      }, 60000)
      window.addEventListener('spa-navigate', () => clearInterval(msInterval), { once: true })
    }

    // fund tier buttons
    contentEl.querySelectorAll('.fund-tier-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const userAddr = await requireUser('fund this project')
        if (!userAddr) return
        const tierId = BigInt(btn.dataset.tierId)
        const price = BigInt(btn.dataset.price)
        const qtyInput = contentEl.querySelector(`.fund-qty[data-tier-id="${btn.dataset.tierId}"]`)
        const qty = BigInt(Math.max(1, parseInt(qtyInput?.value) || 1))
        const totalValue = price * qty
        const tier = (data.tiers?.items || []).find(t => String(t.tierId) === btn.dataset.tierId)
        execAction('fundTier', [BigInt(projectId), tierId, qty], totalValue, {
          tierName: tier?.name || 'tier',
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
        const revAccount = await window.ensureAuthorized?.() || addr
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

    // --- project image gallery ---
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
              imgs.map(img => `<a href="/api/ipfs-proxy/${escapeHtml(img.cid)}" target="_blank" style="display:block;border-radius:6px;overflow:hidden;border:1px solid var(--border)"><img src="/api/ipfs-proxy/${escapeHtml(img.cid)}" loading="lazy" style="width:100%;${isSingle ? 'max-height:400px;object-fit:cover' : 'height:200px;object-fit:cover'};display:block" alt="${escapeHtml(img.name || '')}"></a>`).join('')
            }</div>`
          }
        } catch (e) { console.warn('gallery load error:', e) }
      }
    }

    // --- resale tickets section ---
    const resaleEl = document.getElementById('resale-tickets-section')
    if (resaleEl) {
      try {
        const listings = await getTicketListingsForProject(projectId)

        // check if connected wallet owns any TICKET tokens for this project
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
          } catch (e) { console.warn('owned tickets query error:', e) }
        }

        // resolve seller addresses
        const sellerAddrs = listings.map(l => l.seller)
        const sellerDomains = await resolveAddresses(query, sellerAddrs).catch(() => ({}))

        let resaleHtml = ''

        if (listings.length > 0) {
          resaleHtml += `<h3 style="color:var(--muted);font-size:0.8em;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:0.75em">${t('tickets.resale')}</h3>`
          for (const listing of listings) {
            const sellerDomain = sellerDomains[listing.seller.toLowerCase()] || `${listing.seller.slice(0, 6)}...${listing.seller.slice(-4)}`
            const priceEth = formatPriceSync(listing.price, ethPrices)
            const isMine = myAddr && listing.seller.toLowerCase() === myAddr

            resaleHtml += `<div style="display:flex;justify-content:space-between;align-items:center;padding:0.75em 0;border-bottom:1px solid var(--border);font-size:0.9em">
              <div>
                <a href="/network?artist=${listing.seller.toLowerCase()}" style="color:var(--fg)">${escapeHtml(sellerDomain)}</a>
                <span style="color:var(--accent);margin-left:1ch">${priceEth}</span>
              </div>
              <div>
                ${isMine
                  ? `<button class="buy-btn cancel-ticket-btn" data-token-id="${listing.tokenId}" style="font-size:0.8em;padding:0.3em 1ch;border-color:#ef4444;color:#ef4444">${t('tickets.cancel')}</button>`
                  : `<button class="buy-btn buy-ticket-btn" data-token-id="${listing.tokenId}" data-price="${listing.price}" style="font-size:0.8em;padding:0.3em 1ch">${t('tickets.buy')}</button>`
                }
              </div>
            </div>`
          }
        }

        // show "list for resale" for owned tickets not currently listed
        const listedTokenIds = new Set(listings.map(l => l.tokenId.toString()))
        const unlistedTickets = ownedTickets.filter(t => !listedTokenIds.has(t.tokenId.toString()))

        if (unlistedTickets.length > 0) {
          resaleHtml += `<h3 style="color:var(--muted);font-size:0.8em;text-transform:uppercase;letter-spacing:0.1em;margin-top:1.5em;margin-bottom:0.75em">${t('tickets.yourTickets')}</h3>`
          for (const ticket of unlistedTickets) {
            resaleHtml += `<div style="display:flex;gap:0.5ch;align-items:center;padding:0.5em 0;border-bottom:1px solid var(--border);font-size:0.9em">
              <span style="color:var(--fg)">ticket #${ticket.tokenId}</span>
              <input type="text" class="ticket-price-input project-input" data-token-id="${ticket.tokenId}" placeholder="${t('tickets.enterPrice')}" style="width:10ch;margin-left:auto">
              <span style="color:var(--dim);font-size:0.85em">ETH</span>
              <button class="buy-btn list-ticket-btn" data-token-id="${ticket.tokenId}" style="font-size:0.8em;padding:0.3em 1ch">${t('tickets.listForSale')}</button>
            </div>`
          }
        }

        if (!resaleHtml && listings.length === 0) {
          // only show "no listings" if there are ticket tiers for this project
          const hasTicketTiers = (data.tiers?.items || []).some(tier => tier.transferable)
          if (hasTicketTiers) {
            resaleHtml = `<h3 style="color:var(--muted);font-size:0.8em;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:0.75em">${t('tickets.resale')}</h3>
              <p style="color:var(--dim);font-size:0.9em">${t('tickets.noListings')}</p>`
          }
        }

        if (resaleHtml) {
          resaleEl.innerHTML = resaleHtml
          resaleEl.insertAdjacentHTML('beforeend', '<p id="ticket-status" style="color:var(--muted);font-size:0.85em;margin-top:0.5em"></p>')

          // wire up buy buttons
          resaleEl.querySelectorAll('.buy-ticket-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
              const statusEl = document.getElementById('ticket-status')
              statusEl.textContent = 'confirm in wallet...'
              try {
                await purchaseTicket(btn.dataset.tokenId, btn.dataset.price)
                statusEl.textContent = t('tickets.purchased')
                reloadAfterTx()
              } catch (e) {
                statusEl.textContent = formatTxError(e)
              }
            })
          })

          // wire up cancel buttons
          resaleEl.querySelectorAll('.cancel-ticket-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
              const statusEl = document.getElementById('ticket-status')
              statusEl.textContent = 'confirm in wallet...'
              try {
                await cancelTicketListing(btn.dataset.tokenId)
                statusEl.textContent = 'cancelled'
                reloadAfterTx()
              } catch (e) {
                statusEl.textContent = formatTxError(e)
              }
            })
          })

          // wire up list buttons
          resaleEl.querySelectorAll('.list-ticket-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
              const statusEl = document.getElementById('ticket-status')
              const input = resaleEl.querySelector(`.ticket-price-input[data-token-id="${btn.dataset.tokenId}"]`)
              const priceStr = input?.value?.trim()
              if (!priceStr) { statusEl.textContent = t('tickets.enterPrice'); return }
              statusEl.textContent = 'confirm in wallet...'
              try {
                const priceWei = parseEther(priceStr)
                await listTicket(btn.dataset.tokenId, priceWei)
                statusEl.textContent = t('tickets.listed')
                reloadAfterTx()
              } catch (e) {
                statusEl.textContent = formatTxError(e)
              }
            })
          })
        }
      } catch (e) {
        console.warn('resale tickets error:', e)
      }
    }

    // --- comments section ---
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

// --- Project comments (blog posts with refType=1, refId=projectId) ---

async function loadProjectComments(projectId, projectTitle, domainMap) {
  const commentsEl = document.getElementById('project-comments')
  if (!commentsEl) return

  const resolve = addr => domainMap?.[addr.toLowerCase()] || `${addr.slice(0, 6)}...${addr.slice(-4)}`

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
    return `<div class="project-comment" data-comment-id="${c.id}" style="${indent}padding:1em 0;border-top:1px solid var(--border)">
      <div style="display:flex;justify-content:space-between;margin-bottom:0.5em">
        <a href="/network?artist=${c.author.toLowerCase()}" style="color:var(--fg);font-size:0.85em">${escapeHtml(resolve(c.author))}</a>
        <time style="color:var(--dim);font-size:0.8em">${timeStr}</time>
      </div>
      <div style="color:var(--fg);font-size:0.95em;line-height:1.6">${renderMarkdown(c.content)}</div>
      <div class="comment-replies" id="replies-for-${c.id}"></div>
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
      commentsEl.innerHTML = `<h3 style="color:var(--muted);font-size:0.8em;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:1em">comments</h3>
        <p style="color:var(--dim);font-size:0.9em">no comments yet</p>`
      return
    }

    await resolveNewAuthors(comments)

    commentsEl.innerHTML = `
      <h3 id="comments-heading" style="color:var(--muted);font-size:0.8em;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:1em">${totalCount} ${totalCount === 1 ? 'comment' : 'comments'}</h3>
      <div id="comments-list">${comments.map(c => renderComment(c, false)).join('')}</div>
      ${commentsHasMore ? `<button id="comments-load-more" class="buy-btn" style="margin-top:1em;width:100%">load more comments</button>` : ''}
    `

    // load replies for each comment (refType=3, refId=commentId)
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

        // load replies for new comments
        const newIds = newComments.map(c => c.id)
        await loadCommentReplies(newIds, domainMap, resolve)

        if (!commentsHasMore) {
          btn.style.display = 'none'
        } else {
          btn.textContent = 'load more comments'
          btn.disabled = false
        }
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
          return `<div style="margin-left:2ch;padding:0.75em 0;border-top:1px solid var(--border)">
            <div style="display:flex;justify-content:space-between;margin-bottom:0.25em">
              <a href="/network?artist=${r.author.toLowerCase()}" style="color:var(--fg);font-size:0.8em">${escapeHtml(resolve(r.author))}</a>
              <time style="color:var(--dim);font-size:0.75em">${timeStr}</time>
            </div>
            <div style="color:var(--fg);font-size:0.9em;line-height:1.6">${renderMarkdown(r.content)}</div>
          </div>`
        }).join('')
      }
    }
  } catch (e) { console.warn('comment replies error:', e?.message) }
  }
}

function renderCommentForm(blogAddr, projectId, projectTitle) {
  const formEl = document.getElementById('project-comment-form')
  if (!formEl || formEl.dataset.rendered) return
  formEl.dataset.rendered = '1'

  formEl.innerHTML = `
    <div style="border-top:1px solid var(--border);padding-top:1.5em">
      <textarea id="comment-content" placeholder="write a comment..." style="width:100%;background:transparent;border:1px solid var(--border);color:var(--fg);font-family:inherit;font-size:0.95em;padding:0.75em 1ch;resize:vertical;min-height:4em;line-height:1.6"></textarea>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:0.5em">
        <span id="comment-status" style="color:var(--muted);font-size:0.85em"></span>
        <button class="buy-btn" id="comment-submit" style="font-size:0.85em;padding:0.3em 1.5ch">comment</button>
      </div>
    </div>
  `

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
      const commentAccount = await window.ensureAuthorized?.() || addr
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
