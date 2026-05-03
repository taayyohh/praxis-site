// Projects — propose, fund, and produce creative work together
import { createWalletClient, custom, formatEther, parseEther } from './vendor.js'
import { optimism } from './vendor.js'
import { query } from './ponder.js'
import { escapeHtml, ensureWallet, resolveAddresses, formatTxError, getPublicClient , formatEthAmount, registerPage , getWalletProvider } from './utils.js'
import { t } from './i18n.js'
import { getCached, setCache, TTL } from './cache.js'
import { F } from './fragments.js'
import { getEthPrices, formatPriceSync } from './fiat.js'

const PROJECT_TYPES = ['show', 'film', 'theater', 'recording', 'workshop', 'installation', 'other']
const STATUS_LABELS = [
  () => t('projects.status.proposed'),
  () => t('projects.status.funded'),
  () => t('projects.status.confirmed'),
  () => t('projects.status.completed'),
  () => t('projects.status.cancelled'),
  () => t('projects.status.disputed'),
]
const STATUS_COLORS = ['#c0c0c0', '#4ade80', '#60a5fa', '#a78bfa', '#666', '#666']

import { PRAXIS_ABI, PRAXIS_ADDR } from './contracts.js'
const HUB_ABI = PRAXIS_ABI
const PRAXIS_DEFAULT_ADDR = PRAXIS_ADDR
let _cachedFundedIds = null

registerPage('collab-data', init)

async function init() {
  _cachedFundedIds = null
  const projectsData = document.getElementById('collab-data')
  if (!projectsData) return
  const hubAddress = projectsData.dataset.hub || PRAXIS_DEFAULT_ADDR
  const statusEl = document.getElementById('collab-status')

  if (!hubAddress) { statusEl.textContent = t('projects.notDeployed'); return }

  const publicClient = await getPublicClient()

  let walletToDomain = {}
  let domainToWallet = {}
  let projects = []
  let funders = {}
  const PAGE_SIZE = 100
  let projectsCursor = null
  let projectsHasMore = false
  let collabData = {}
  let tierData = {}
  let loadMoreProjects = async () => []

  try {
    const projectsCacheKey = 'projects:' + hubAddress
    projectsHasMore = true

    const cachedProjects = getCached(projectsCacheKey)

    // List view: fetch related data for a page of projects
    // Uses limit proportional to page size (10 collabs/funders per project max for list view)
    // Full data loaded on project-detail page
    async function fetchRelated(ids) {
      if (ids.length === 0) return
      const relLimit = Math.max(ids.length * 10, 100)
      const [collabResult, fundingResult, tierResult] = await Promise.all([
        query(
          `query C($ids: [BigInt!]!) { collaborators(where: { projectId_in: $ids }, limit: ${relLimit}) { items { ${F.collaborator} } } }`,
          { ids }
        ),
        query(
          `query F($ids: [BigInt!]!) { fundings(where: { projectId_in: $ids }, limit: ${relLimit}) { items { ${F.funding} } } }`,
          { ids }
        ),
        query(
          `query T($ids: [BigInt!]!) { tiers(where: { projectId_in: $ids }, limit: ${relLimit}) { items { ${F.tier} } } }`,
          { ids }
        ),
      ])
      const collabItems = collabResult.collaborators?.items || []
      const fundingItems = fundingResult.fundings?.items || []
      const tierItems = tierResult.tiers?.items || []

      for (const c of collabItems) {
        if (!collabData[c.projectId]) collabData[c.projectId] = { collabs: [], splits: [] }
        collabData[c.projectId].collabs.push(c.artist)
        collabData[c.projectId].splits.push(BigInt(c.split))
      }

      for (const f of fundingItems) {
        if (!funders[f.projectId]) funders[f.projectId] = []
        funders[f.projectId].push({ funder: f.funder, amount: BigInt(f.amount) })
      }

      for (const ti of tierItems) {
        if (!tierData[ti.projectId]) tierData[ti.projectId] = []
        tierData[ti.projectId].push(ti)
      }
    }

    function mapProjects(items) {
      return items.map(p => ({
        id: Number(p.id),
        proposer: p.proposer,
        title: p.title,
        description: p.description || '',
        type: p.projectType,
        status: p.status,
        goal: BigInt(p.fundingGoal),
        funded: BigInt(p.totalFunded),
        deadline: Number(p.deadline),
        collaborators: collabData[p.id]?.collabs || [],
        splits: collabData[p.id]?.splits || [],
        funders: funders[p.id] || [],
        tiers: tierData[p.id] || [],
        locationPacked: BigInt(p.location || 0),
      }))
    }

    if (cachedProjects) {
      projects = cachedProjects.projects
      projectsCursor = cachedProjects.cursor
      projectsHasMore = cachedProjects.hasMore
      collabData = cachedProjects.collabData
      tierData = cachedProjects.tierData
      funders = cachedProjects.funders
    } else {
      let data
      try {
        data = await query(`
          query ProjectsData {
            projects(limit: ${PAGE_SIZE}, orderBy: "createdAt", orderDirection: "desc") {
              items { ${F.projectDetail} }
              ${F.pageInfo}
            }
          }
        `)
      } catch {
        // fallback: query without location field (Ponder may not have it yet)
        data = await query(`
          query ProjectsData {
            projects(limit: ${PAGE_SIZE}, orderBy: "createdAt", orderDirection: "desc") {
              items { ${F.projectSummary} description }
              ${F.pageInfo}
            }
          }
        `)
      }

      projectsCursor = data.projects.pageInfo?.endCursor
      projectsHasMore = data.projects.pageInfo?.hasNextPage || false

      const projectIds = data.projects.items.map(p => p.id)
      await fetchRelated(projectIds)
      projects = mapProjects(data.projects.items)

      // cache with short TTL (30s) since project state changes frequently
      setCache(projectsCacheKey, {
        projects, cursor: projectsCursor, hasMore: projectsHasMore,
        collabData, tierData, funders,
      }, TTL.short)
    }

    // load more function for UI button
    loadMoreProjects = async function() {
      if (!projectsHasMore) return []
      let moreData
      try {
        moreData = await query(`
          query ProjectsData($after: String) {
            projects(limit: ${PAGE_SIZE}, orderBy: "createdAt", orderDirection: "desc", after: $after) {
              items { ${F.projectDetail} }
              ${F.pageInfo}
            }
          }
        `, { after: projectsCursor })
      } catch {
        moreData = await query(`
          query ProjectsData($after: String) {
            projects(limit: ${PAGE_SIZE}, orderBy: "createdAt", orderDirection: "desc", after: $after) {
              items { ${F.projectSummary} description }
              ${F.pageInfo}
            }
          }
        `, { after: projectsCursor })
      }
      projectsCursor = moreData.projects.pageInfo?.endCursor
      projectsHasMore = moreData.projects.pageInfo?.hasNextPage || false
      const newIds = moreData.projects.items.map(p => p.id)
      await fetchRelated(newIds)
      const newProjects = mapProjects(moreData.projects.items)
      projects.push(...newProjects)

      // resolve domains for new projects' addresses
      const newAddrs = [
        ...newProjects.map(p => p.proposer),
        ...newProjects.flatMap(p => p.collaborators),
        ...newProjects.flatMap(p => p.funders.map(f => f.funder)),
      ].filter(Boolean)
      const newDomains = await resolveAddresses(query, newAddrs).catch(() => ({}))
      for (const [addr, domain] of Object.entries(newDomains)) {
        walletToDomain[addr] = domain
        domainToWallet[domain.toLowerCase()] = addr
      }

      return newProjects
    }

    // collect all addresses from loaded projects for batch domain resolution
    // include connected wallet so propose form can verify registration
    const myWallet = window.getWalletAddress?.()
    const allProjectAddresses = [
      ...projects.map(p => p.proposer),
      ...projects.flatMap(p => p.collaborators),
      ...projects.flatMap(p => p.funders.map(f => f.funder)),
      ...(myWallet ? [myWallet] : []),
    ].filter(Boolean)
    const resolvedDomains = await resolveAddresses(query, allProjectAddresses).catch(() => ({}))
    for (const [addr, domain] of Object.entries(resolvedDomains)) {
      walletToDomain[addr] = domain
      domainToWallet[domain.toLowerCase()] = addr
    }

  } catch (e) {
    statusEl.textContent = 'could not load projects'
    console.error(e)
    return
  }

  const resolve = addr => walletToDomain[addr.toLowerCase()] || `${addr.slice(0, 6)}...${addr.slice(-4)}`

  const active = projects.filter(p => p.status <= 2)
  statusEl.textContent = active.length
    ? `${active.length} active project${active.length === 1 ? '' : 's'}`
    : t('projects.noActive')

  const allDomains = Object.keys(domainToWallet)
  const ethPrices = await getEthPrices().catch(() => null)
  renderAll(projects, hubAddress, publicClient, resolve, domainToWallet, allDomains, projectsHasMore, loadMoreProjects, ethPrices)
}

async function renderAll(projects, hubAddress, publicClient, resolve, domainToWallet, allDomains, hasMore, loadMoreFn, ethPrices = null) {
  // clear the below-header loader
  const loaderEl = document.getElementById('collab-loader')
  if (loaderEl) loaderEl.remove()

  const activeEl = document.getElementById('collab-active')
  const mineEl = document.getElementById('collab-mine')
  const contribEl = document.getElementById('collab-contributions')
  const wallet = window.getWalletAddress?.()?.toLowerCase()

  const active = projects.filter(p => p.status <= 2)
  const mine = wallet ? projects.filter(p =>
    p.proposer.toLowerCase() === wallet ||
    p.collaborators.some(c => c.toLowerCase() === wallet)
  ) : []

  // contributions: projects you funded OR collaborate on (but didn't propose)
  let contributions = []
  if (wallet) {
    // query fundings where funder = wallet (cached for reuse in load-more)
    try {
      if (!_cachedFundedIds) {
        const fundedData = await query(
          `query MyFundings($me: String!) { fundings(where: { funder: $me }, limit: 100) { items { ${F.funding} } } }`,
          { me: wallet }
        )
        _cachedFundedIds = [...new Set((fundedData.fundings?.items || []).map(f => String(f.projectId)))]
      }
      const fundedData = { fundings: { items: _cachedFundedIds.map(id => ({ projectId: id })) } }
      const fundedItems = fundedData.fundings?.items || []
      const fundedProjectIds = [...new Set(fundedItems.map(f => String(f.projectId)))]

      // find funded projects in already-loaded list
      const fundedProjects = projects.filter(p => fundedProjectIds.includes(String(p.id)))
      // find collab projects (not proposer)
      const collabProjects = projects.filter(p =>
        p.proposer.toLowerCase() !== wallet &&
        p.collaborators.some(c => c.toLowerCase() === wallet)
      )

      // merge, deduplicate, label
      const seen = new Set()
      for (const p of fundedProjects) {
        if (!seen.has(p.id)) {
          seen.add(p.id)
          const isAlsoCollab = p.collaborators.some(c => c.toLowerCase() === wallet)
          contributions.push({ ...p, _contribLabel: isAlsoCollab ? 'collaborator + backed' : 'backed' })
        }
      }
      for (const p of collabProjects) {
        if (!seen.has(p.id)) {
          seen.add(p.id)
          contributions.push({ ...p, _contribLabel: 'collaborator' })
        }
      }
    } catch (e) { console.warn('contributions query failed', e) }
  }

  // check for pending withdrawals (cached to share with notifications.js)
  if (wallet) {
    try {
      const pendingCacheKey = `pending:${hubAddress}:${wallet.toLowerCase()}`
      let pending = getCached(pendingCacheKey)
      if (pending !== null) {
        pending = BigInt(pending)
      } else {
        pending = await publicClient.readContract({
          address: hubAddress,
          abi: [{ name: 'pendingWithdrawals', type: 'function', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
          functionName: 'pendingWithdrawals',
          args: [wallet],
        })
        setCache(pendingCacheKey, pending.toString(), TTL.short)
      }
      if (pending > 0n) {
        const ethAmount = formatPriceSync(pending, ethPrices)
        const claimHtml = `
          <div class="project-card" style="border-color:var(--green)">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <div>
                <span style="color:var(--green)">${ethAmount}</span> ${t('projects.readyToClaim')}
              </div>
              <div style="display:flex;gap:0.5em">
                <button class="buy-btn" id="claim-funds-btn">${t('projects.claim')}</button>
                <button class="buy-btn" id="cashout-btn" style="border-color:var(--muted);color:var(--muted)">${t('projects.cashOutVenmo')}</button>
              </div>
            </div>
            <p id="claim-status" style="color:var(--muted);font-size:0.85em;margin-top:0.5em"></p>
          </div>
        `
        statusEl.insertAdjacentHTML('afterend', claimHtml)

        document.getElementById('claim-funds-btn')?.addEventListener('click', async () => {
          const cs = document.getElementById('claim-status')
          cs.textContent = t('projects.claiming')
          try {
            const claimAcct = await window.ensureAuthorized?.() || wallet
            const wc = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })
            const hash = await wc.writeContract({ address: hubAddress, abi: HUB_ABI, functionName: 'claimFunds', args: [], account: claimAcct })
            cs.textContent = `tx: ${hash.slice(0, 14)}...`
            await publicClient.waitForTransactionReceipt({ hash })
            cs.textContent = t('projects.claimedReloading')
            setTimeout(() => location.reload(), 1500)
          } catch (e) {
            cs.textContent = e.code === 4001 ? t('status.cancelled') : `error: ${e.shortMessage || e.message}`
          }
        })

        document.getElementById('cashout-btn')?.addEventListener('click', async () => {
          const cs = document.getElementById('claim-status')
          // first claim the funds on-chain
          cs.textContent = t('projects.claimingOnChain')
          try {
            const cashAcct = await window.ensureAuthorized?.() || wallet
            const wc = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })
            const hash = await wc.writeContract({ address: hubAddress, abi: HUB_ABI, functionName: 'claimFunds', args: [], account: cashAcct })
            await publicClient.waitForTransactionReceipt({ hash })
            cs.textContent = t('projects.claimedOfframp')
            // then offramp via native ramp (zkp2p + Relay)
            const ok = await window.peerOfframpOptimism?.(wallet, ethAmount)
            cs.textContent = ok ? t('projects.cashedOut') : t('projects.offrampCancelled')
          } catch (e) {
            cs.textContent = e.code === 4001 ? t('status.cancelled') : `error: ${e.shortMessage || e.message}`
          }
        })
      }
    } catch (e) { if (e?.message) console.warn("praxis:", e.message) }
  }

  // batch-check hasConfirmed for funded projects
  const confirmedIds = new Set()
  if (wallet) {
    const fundedProjects = projects.filter(p => p.status === 1 && (
      p.proposer.toLowerCase() === wallet || p.collaborators.some(c => c.toLowerCase() === wallet)
    ))
    if (fundedProjects.length > 0) {
      try {
        const confirmCalls = fundedProjects.map(p => ({
          address: hubAddress, abi: HUB_ABI, functionName: 'hasConfirmed', args: [BigInt(p.id), wallet],
        }))
        const results = await publicClient.multicall({ contracts: confirmCalls, allowFailure: true })
        for (let i = 0; i < fundedProjects.length; i++) {
          if (results[i].status === 'success' && results[i].result) confirmedIds.add(fundedProjects[i].id)
        }
      } catch (e) { console.warn('hasConfirmed check:', e) }
    }
  }

  activeEl.innerHTML = active.length
    ? active.map(p => projectCard(p, wallet, resolve, confirmedIds, ethPrices)).join('')
    : `<p style="color:#666">${t('projects.noActiveYet')}</p>`

  mineEl.innerHTML = mine.length
    ? mine.map(p => projectCard(p, wallet, resolve, confirmedIds, ethPrices)).join('')
    : `<p style="color:#666">${t('projects.noneYet')}</p>`

  // render contributions (funded + collab projects)
  if (contribEl) {
    contribEl.innerHTML = contributions.length
      ? contributions.map(p => {
          const label = p._contribLabel || 'backed'
          return `<div class="contribution-wrapper">
            <span class="contribution-label" style="display:inline-block;font-size:0.75em;color:var(--muted);margin-bottom:0.25em">${label}</span>
            ${projectCard(p, wallet, resolve, new Set(), ethPrices)}
          </div>`
        }).join('')
      : `<p style="color:#666">${t('projects.noneYet')}</p>`
    attachHandlers(contribEl, hubAddress, publicClient)
  }

  attachHandlers(activeEl, hubAddress, publicClient)
  attachHandlers(mineEl, hubAddress, publicClient)
  geocodeProjectCards()

  // "load more" button — placed after all sections, visible on any filter
  document.getElementById('projects-load-more-btn')?.remove()
  if (hasMore && loadMoreFn) {
    const listView = document.getElementById('projects-list-view')
    const btnHtml = `<button id="projects-load-more-btn" class="buy-btn" style="margin-top:1em;width:100%">${t('network.loadMore') || 'load more'}</button>`
    listView.insertAdjacentHTML('beforeend', btnHtml)
    document.getElementById('projects-load-more-btn').addEventListener('click', async () => {
      const btn = document.getElementById('projects-load-more-btn')
      btn.textContent = 'loading...'
      btn.disabled = true
      try {
        const newProjects = await loadMoreFn()
        const newActive = newProjects.filter(p => p.status <= 2)
        const newMine = wallet ? newProjects.filter(p =>
          p.proposer.toLowerCase() === wallet ||
          p.collaborators.some(c => c.toLowerCase() === wallet)
        ) : []
        if (newActive.length > 0) {
          activeEl.insertAdjacentHTML('beforeend', newActive.map(p => projectCard(p, wallet, resolve, new Set(), ethPrices)).join(''))
          attachHandlers(activeEl, hubAddress, publicClient)
        }
        if (newMine.length > 0) {
          mineEl.insertAdjacentHTML('beforeend', newMine.map(p => projectCard(p, wallet, resolve, new Set(), ethPrices)).join(''))
          attachHandlers(mineEl, hubAddress, publicClient)
        }
        // contributions from new projects
        if (wallet && newProjects.length > 0) {
          try {
            const fundedIds = new Set(_cachedFundedIds || [])
            const newContribs = newProjects.filter(p =>
              fundedIds.has(String(p.id)) ||
              (p.proposer.toLowerCase() !== wallet && p.collaborators.some(c => c.toLowerCase() === wallet))
            )
            if (newContribs.length > 0) {
              contribEl.insertAdjacentHTML('beforeend', newContribs.map(p => {
                const isFunded = fundedIds.has(String(p.id))
                const isCollab = p.collaborators.some(c => c.toLowerCase() === wallet)
                const label = isFunded && isCollab ? 'collaborator + backed' : isFunded ? 'backed' : 'collaborator'
                return `<div class="contribution-wrapper">
                  <span class="contribution-label" style="display:inline-block;font-size:0.75em;color:var(--muted);margin-bottom:0.25em">${label}</span>
                  ${projectCard(p, wallet, resolve, new Set(), ethPrices)}
                </div>`
              }).join(''))
              attachHandlers(contribEl, hubAddress, publicClient)
            }
          } catch {}
        }
        geocodeProjectCards()
        // hide if no more
        if (newProjects.length === 0) {
          btn.style.display = 'none'
        } else {
          btn.textContent = t('network.loadMore') || 'load more'
          btn.disabled = false
        }
      } catch (e) {
        btn.textContent = 'error loading'
        console.warn('load more projects error:', e)
      }
    })
  }

  renderProposeForm(hubAddress, publicClient, domainToWallet, resolve, allDomains)

  // wire up list filter pills (active / yours / contributions)
  const listFilterBtns = document.querySelectorAll('.projects-list-filter')
  const listSections = {
    active: document.getElementById('collab-active'),
    mine: document.getElementById('collab-mine'),
    contributions: document.getElementById('collab-contributions'),
  }
  listFilterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      listFilterBtns.forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      const filter = btn.dataset.listFilter
      Object.entries(listSections).forEach(([key, el]) => {
        if (el) el.style.display = key === filter ? '' : 'none'
      })
    })
  })

  // wire up search input (filters project cards by text content)
  const searchInput = document.getElementById('projects-search')
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      const q = searchInput.value.trim().toLowerCase()
      // filter list-view project cards
      document.querySelectorAll('#projects-list-view .project-card').forEach(card => {
        const text = card.textContent.toLowerCase()
        card.style.display = !q || text.includes(q) ? '' : 'none'
      })
      // filter map-view no-location cards
      document.querySelectorAll('#projects-no-location .project-card').forEach(card => {
        const text = card.textContent.toLowerCase()
        card.style.display = !q || text.includes(q) ? '' : 'none'
      })
    })
  }

  // wire up list|map view toggle
  setupViewToggle(projects, resolve)
}

function projectCard(p, wallet, resolve, confirmedIds = new Set(), ethPrices = null) {
  const pct = p.goal > 0n ? Number(p.funded * 10000n / p.goal) / 100 : 0
  const goalEth = formatEther(p.goal)
  const fundedEth = formatEther(p.funded)
  const deadlineDate = new Date(p.deadline * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const isProposer = wallet && p.proposer.toLowerCase() === wallet
  const daysLeft = Math.max(0, Math.ceil((p.deadline * 1000 - Date.now()) / 86400000))

  // location line (render raw coords, geocode async after DOM insert)
  let locationLine = ''
  if (p.locationPacked && p.locationPacked !== 0n) {
    const loc = unpackLocation(p.locationPacked)
    if (loc) {
      const coordStr = `${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)}`
      locationLine = `<div class="project-card-location" data-lat="${loc.lat}" data-lng="${loc.lng}" style="color:var(--dim);font-size:0.85em;margin-bottom:0.5em"><i class="ph ph-map-pin" style="margin-right:0.3ch"></i> <span class="location-name">${coordStr}</span></div>`
    }
  }

  // team section
  const team = p.collaborators.map((c, i) => {
    const domain = resolve(c)
    const splitPct = p.splits[i] ? (Number(p.splits[i]) / 100).toFixed(0) : '?'
    return `<span class="project-team-member"><a href="https://${escapeHtml(domain)}">${escapeHtml(domain)}</a> <span class="project-split">${splitPct}%</span></span>`
  }).join('')

  // funders section
  let fundersHtml = ''
  if (p.funders.length > 0) {
    const funderList = p.funders.map(f => {
      const domain = resolve(f.funder)
      return `<span class="project-funder">${escapeHtml(domain)} <span style="color:#444">${formatPriceSync(f.amount, ethPrices)}</span></span>`
    }).join('')
    fundersHtml = `<div class="project-funders"><span style="color:#666;font-size:0.8em">${t('projects.producer')}s:</span> ${funderList}</div>`
  }

  // progress bar
  const progressBar = `<div class="project-progress-bar"><div class="project-progress-fill" style="width:${Math.min(pct, 100)}%"></div></div>`

  // tier cards for funding
  let tiersHtml = ''
  if (p.status === 0 && p.tiers.length > 0) {
    tiersHtml = `<div class="project-tiers">${p.tiers.map(tier => {
      const priceEth = formatPriceSync(tier.price, ethPrices)
      const remaining = tier.maxSupply > 0 ? t('projects.left', { n: tier.maxSupply - tier.sold }) : t('projects.unlimited')
      const soldOut = tier.maxSupply > 0 && tier.sold >= tier.maxSupply
      const badge = tier.transferable ? `<span class="tier-badge tier-ticket">${t('projects.ticket')}</span>` : `<span class="tier-badge tier-producer">${t('projects.producer')}</span>`
      return `<div class="tier-card ${soldOut ? 'tier-sold-out' : ''}" data-project="${p.id}" data-tier="${tier.tierId}">
        <div class="tier-header">${badge} <span class="tier-name">${escapeHtml(tier.name)}</span></div>
        <div class="tier-price">${priceEth}</div>
        <div class="tier-supply">${remaining}</div>
        ${!soldOut ? `<div class="tier-actions">
          <input type="number" class="tier-qty" value="1" min="1" max="${tier.maxSupply > 0 ? tier.maxSupply - tier.sold : 99}" style="width:4ch;background:transparent;border:1px solid var(--border);color:var(--fg);font-family:inherit;font-size:0.85em;padding:0.3em 0.5ch;text-align:center">
          <button class="buy-btn collab-fund-btn" data-id="${p.id}" data-tier="${tier.tierId}" data-price="${tier.price}">${t('projects.fund')}</button>
        </div>` : `<div style="color:#666;font-size:0.8em">${t('projects.soldOut')}</div>`}
      </div>`
    }).join('')}</div>`
  }

  // actions
  let actions = ''
  if (p.status === 0) {
    actions = `${tiersHtml}
    <div class="project-actions">
      ${isProposer ? `<button class="buy-btn collab-cancel-btn" data-id="${p.id}" style="border-color:#666;color:#666">${t('projects.cancel')}</button>` : ''}
    </div>`
  } else if (p.status === 1) {
    const isCollaborator = wallet && p.collaborators.some(c => c.toLowerCase() === wallet)
    const alreadyConfirmed = confirmedIds.has(p.id)
    actions = `<div class="project-actions">
      ${(isProposer || isCollaborator) && !alreadyConfirmed ? `<button class="buy-btn collab-confirm-btn" data-id="${p.id}">${t('projects.confirm')}</button>` : ''}
      ${alreadyConfirmed ? `<span style="color:var(--muted);font-size:0.85em">confirmed -- waiting for team</span>` : ''}
      ${isProposer ? `<button class="buy-btn collab-cancel-btn" data-id="${p.id}" style="border-color:#666;color:#666">${t('projects.cancel')}</button>` : ''}
    </div>`
  } else if (p.status === 2 && isProposer) {
    actions = `<div class="project-actions">
      <button class="buy-btn collab-complete-btn" data-id="${p.id}">${t('projects.completeDistribute')}</button>
    </div>`
  } else if (p.status === 4 || (p.status === 0 && Date.now() / 1000 >= p.deadline)) {
    actions = `<div class="project-actions">
      <button class="buy-btn collab-refund-btn" data-id="${p.id}">${t('projects.claimRefund')}</button>
    </div>`
  }

  return `
    <div class="project-card" data-id="${p.id}" style="cursor:pointer" onclick="if(!event.target.closest('button,input,select,a,.tier-card')){location.href='/project?id=${p.id}'}">
      <div class="project-card-header">
        <div>
          <h3 class="project-card-title"><a href="/project?id=${p.id}" style="color:inherit;text-decoration:none">${escapeHtml(p.title)}</a></h3>
          <span class="project-type-badge">${PROJECT_TYPES[p.type]}</span>
          <span class="project-status-badge" style="color:${STATUS_COLORS[p.status]}">${STATUS_LABELS[p.status]?.() || ''}</span>
        </div>
        <div class="project-deadline">${p.status <= 2 && daysLeft > 0 ? t('projects.daysLeft', { d: daysLeft }) : p.status <= 2 ? '' : deadlineDate}</div>
      </div>

      ${p.description ? `<p class="project-description">${escapeHtml(p.description)}</p>` : ''}
      ${locationLine}

      <div class="project-team">
        <span class="project-proposer">proposed by <a href="https://${escapeHtml(resolve(p.proposer))}">${escapeHtml(resolve(p.proposer))}</a></span>
        <div class="project-team-list">${team}</div>
      </div>

      <div class="project-funding">
        <div class="project-funding-text">
          <span data-eth-wei="${project.goal || '0'}">${fundedEth} / ${goalEth} ETH</span>
          <span style="color:#666">${pct.toFixed(0)}%</span>
        </div>
        ${progressBar}
      </div>

      ${fundersHtml}
      ${actions}
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:0.5em">
        <p class="collab-tx-status" data-id="${p.id}" style="color:#666;margin:0"></p>
        <a href="/project?id=${p.id}" style="color:var(--muted);font-size:0.8em">view details</a>
      </div>
    </div>
  `
}

// Batch-geocode all project card location elements that still show raw coords
const _geocodeCache = new Map()
const GEOCODE_CACHE_MAX = 200
function geocodeProjectCards(container) {
  const els = (container || document).querySelectorAll('.project-card-location[data-lat][data-lng]')
  els.forEach(async (el) => {
    const lat = parseFloat(el.dataset.lat)
    const lng = parseFloat(el.dataset.lng)
    if (isNaN(lat) || isNaN(lng)) return
    const key = `${lat.toFixed(4)},${lng.toFixed(4)}`
    // skip if already geocoded
    if (el.dataset.geocoded) return
    el.dataset.geocoded = '1'
    try {
      let name
      if (_geocodeCache.has(key)) {
        name = _geocodeCache.get(key)
      } else {
        const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`)
        const data = await res.json()
        const city = data.address?.city || data.address?.town || data.address?.village || data.address?.suburb || ''
        const state = data.address?.state || ''
        const country = data.address?.country || ''
        name = [city, state].filter(Boolean).join(', ') || [city, country].filter(Boolean).join(', ') || data.display_name?.split(',').slice(0, 2).join(',').trim() || key
        if (_geocodeCache.size >= GEOCODE_CACHE_MAX) { const first = _geocodeCache.keys().next().value; _geocodeCache.delete(first) }
        _geocodeCache.set(key, name)
      }
      const span = el.querySelector('.location-name')
      if (span) span.textContent = name
    } catch (e) {
      console.warn('card geocode error:', e)
    }
  })
}

function attachHandlers(container, hubAddress, publicClient) {
  container.querySelectorAll('.collab-fund-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await txAction(btn, hubAddress, publicClient, async (wc, acct) => {
        const tierCard = btn.closest('.tier-card')
        const tierId = BigInt(btn.dataset.tier || 0)
        const price = BigInt(btn.dataset.price || 0)
        const qtyInput = tierCard?.querySelector('.tier-qty')
        const qty = BigInt(qtyInput?.value || 1)
        return wc.writeContract({ address: hubAddress, abi: HUB_ABI, functionName: 'fundTier', args: [BigInt(btn.dataset.id), tierId, qty], value: price * qty, account: acct })
      })
      // after funding, try to join the project group chat
      try {
        const projectId = btn.dataset.id
        const res = await fetch(`https://milesxb.bio/api/project-group?id=${projectId}`)
        const { groupId } = await res.json()
        if (groupId && window._xmtpClient) {
          // sync to pick up the group invitation
          await window._xmtpClient.conversations.sync()
        }
      } catch (e) { if (e?.message) console.warn("praxis:", e.message) }
    })
  })
  container.querySelectorAll('.collab-confirm-btn').forEach(btn => {
    btn.addEventListener('click', () => txAction(btn, hubAddress, publicClient, async (wc, acct) =>
      wc.writeContract({ address: hubAddress, abi: HUB_ABI, functionName: 'confirmProject', args: [BigInt(btn.dataset.id)], account: acct })
    ))
  })
  container.querySelectorAll('.collab-complete-btn').forEach(btn => {
    btn.addEventListener('click', () => txAction(btn, hubAddress, publicClient, async (wc, acct) =>
      wc.writeContract({ address: hubAddress, abi: HUB_ABI, functionName: 'completeProject', args: [BigInt(btn.dataset.id)], account: acct })
    ))
  })
  container.querySelectorAll('.collab-cancel-btn').forEach(btn => {
    btn.addEventListener('click', () => txAction(btn, hubAddress, publicClient, async (wc, acct) =>
      wc.writeContract({ address: hubAddress, abi: HUB_ABI, functionName: 'cancelProject', args: [BigInt(btn.dataset.id)], account: acct })
    ))
  })
  container.querySelectorAll('.collab-refund-btn').forEach(btn => {
    btn.addEventListener('click', () => txAction(btn, hubAddress, publicClient, async (wc, acct) =>
      wc.writeContract({ address: hubAddress, abi: HUB_ABI, functionName: 'claimRefund', args: [BigInt(btn.dataset.id)], account: acct })
    ))
  })
}

async function txAction(btn, hubAddress, publicClient, action) {
  const statusEl = btn.closest('.project-card')?.querySelector('.collab-tx-status')
  const address = window.getWalletAddress?.()
  if (!address) {
    await window.connectWallet?.()
    if (!window.getWalletAddress?.()) { if (statusEl) statusEl.textContent = t('projects.connectWallet'); return }
  }

  try {
    await getWalletProvider().request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xa' }] })
  } catch (e) {
    if (e.code === 4902) { if (statusEl) statusEl.textContent = t('projects.addOptimism'); return }
  }

  if (statusEl) statusEl.textContent = t('projects.confirming')

  try {
    const currentAccount = await window.ensureAuthorized?.() || window.getWalletAddress()
    const wc = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })
    const hash = await action(wc, currentAccount)
    if (statusEl) statusEl.textContent = `tx: ${hash.slice(0, 14)}...`
    await publicClient.waitForTransactionReceipt({ hash })
    if (statusEl) statusEl.textContent = t('projects.doneReloading')
    setTimeout(() => location.reload(), 1500)
  } catch (e) {
    if (statusEl) statusEl.textContent = e.code === 4001 ? t('status.cancelled') : `error: ${e.shortMessage || e.message}`
  }
}

function renderProposeForm(hubAddress, publicClient, domainToWallet, resolve, allDomains) {
  const formEl = document.getElementById('collab-propose-form')
  if (!formEl) return

  // check if wallet is connected and registered
  const myAddr = window.getWalletAddress?.()
  const isRegistered = myAddr && domainToWallet && Object.values(domainToWallet).some(w => w.toLowerCase() === myAddr.toLowerCase())

  if (!isRegistered) {
    // show button but prompt wallet connection / registration when clicked
    formEl.innerHTML = `<button id="propose-toggle" class="buy-btn" style="font-size:0.85em;padding:0.3em 1.5ch">${t('projects.proposeProject')}</button>`
    document.getElementById('propose-toggle').addEventListener('click', async () => {
      if (!window.getWalletAddress?.()) {
        await window.connectWallet?.()
      }
      if (!window.getWalletAddress?.()) return
      // re-render after wallet connection
      renderProposeForm(hubAddress, publicClient, domainToWallet, resolve, allDomains)
    })
    return
  }

  // compact button (right-aligned next to title in sticky header)
  formEl.innerHTML = `<button id="propose-toggle" class="buy-btn" style="font-size:0.85em;padding:0.3em 1.5ch">${t('projects.proposeProject')}</button>`

  // create bottom sheet panel (same pattern as compose panel)
  document.getElementById('propose-panel')?.remove()
  const panel = document.createElement('div')
  panel.id = 'propose-panel'
  panel.className = 'compose-panel'
  panel.innerHTML = `
    <div class="compose-panel-inner" style="overflow-y:auto">
      <div class="compose-header" style="display:flex;align-items:center;justify-content:space-between;padding:0.75em 0;position:relative">
        <button id="propose-close" class="compose-close-btn" aria-label="close" style="display:flex;align-items:center;padding:0;margin:0;background:none;border:none;color:var(--fg);cursor:pointer"><i class="ph ph-x"></i></button>
        <span style="position:absolute;left:50%;transform:translateX(-50%);text-transform:uppercase;letter-spacing:0.15em;font-size:0.85em">${t('projects.proposeProject')}</span>
        <button class="buy-btn" id="propose-btn" style="font-size:0.85em;padding:0.3em 1.5ch">${t('projects.propose')}</button>
      </div>
      <div style="flex:1;overflow-y:auto;padding-bottom:2em">
        <div style="display:grid;gap:1em">
          <input type="text" id="propose-title" placeholder="${t('projects.titlePlaceholder')}" class="project-input">
          <textarea id="propose-desc" placeholder="${t('projects.descPlaceholder')}" rows="4" class="project-input" style="resize:vertical"></textarea>
          <div id="propose-type-container" class="project-input" style="display:flex;flex-wrap:wrap;gap:0.3em;align-items:center;position:relative;cursor:text;min-height:2em;padding:0.3em 0.5ch">
            <input type="text" id="propose-type" placeholder="${t('projects.categoryPlaceholder')}" style="border:none;outline:none;background:none;color:var(--fg);font:inherit;flex:1;min-width:8ch;padding:0">
            <div id="propose-type-dropdown" style="display:none;position:absolute;top:100%;left:0;right:0;background:var(--bg,#111);border:1px solid var(--border);max-height:150px;overflow-y:auto;z-index:10"></div>
          </div>
          <div>
            <label class="project-label">${t('projects.team')}</label>
            <div id="propose-team">
              <div class="propose-team-row" style="display:flex;gap:0.5em;margin-bottom:0.5em;align-items:center">
                <input type="text" class="team-domain-input project-input" placeholder="${t('projects.memberPlaceholder')}" autocomplete="off" style="flex:3">
                <input type="number" class="team-split-input project-input" placeholder="${t('projects.splitPct')}" style="flex:1" value="50">
                <span style="color:#444;font-size:0.85em">${t('projects.splitPct')}</span>
                <button type="button" class="remove-team-btn" style="background:none;border:none;color:#666;cursor:pointer;font-size:1.2em">&times;</button>
              </div>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center">
              <button type="button" id="add-team-btn" style="background:none;border:none;color:#666;cursor:pointer;font-size:0.85em">${t('projects.addMember')}</button>
              <span id="split-total" style="color:#444;font-size:0.8em">${t('projects.total', { pct: 50 })}</span>
            </div>
          </div>
          <div>
            <label class="project-label">${t('projects.deadline')}</label>
            <input type="date" id="propose-deadline" class="project-input" style="color-scheme:dark;max-width:300px">
          </div>
          <div>
            <label class="project-label">${t('projects.fundingTiers')}</label>
            <div id="propose-tiers">
              <div class="propose-tier-row" style="display:flex;gap:0.5em;margin-bottom:0.5em;align-items:center">
                <input type="text" class="tier-name-input project-input" placeholder="tier name" style="flex:2">
                <input type="text" class="tier-price-input project-input" placeholder="ETH" style="flex:1">
                <input type="number" class="tier-supply-input project-input" placeholder="cap" style="flex:1" min="1" value="10">
                <select class="tier-type-input project-input" style="flex:1.2;font-size:0.85em">
                  <option value="ticket">${t('projects.ticketTransferable')}</option>
                  <option value="backer">${t('projects.backerCredit')}</option>
                </select>
                <button type="button" class="remove-tier-btn" style="background:none;border:none;color:#666;cursor:pointer;font-size:1.2em">&times;</button>
              </div>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center">
              <button type="button" id="add-tier-btn" style="background:none;border:none;color:#666;cursor:pointer;font-size:0.85em">${t('projects.addTier')}</button>
              <span id="tier-calc" style="color:#444;font-size:0.8em">${t('projects.fundingGoal', { eth: '0' })}</span>
            </div>
          </div>
          <div style="margin:1em 0">
            <label class="project-label">${t('projects.locationOptional')}</label>
            <div style="display:flex;gap:0.5em;align-items:center;max-width:400px">
              <input type="text" id="propose-location" class="project-input" style="flex:1" placeholder="e.g. Brooklyn, NY" autocomplete="off">
              <button type="button" id="detect-location-btn" class="buy-btn" style="font-size:0.8em;padding:0.3em 1ch;white-space:nowrap">${t('projects.detectLocation')}</button>
              <button type="button" id="choose-on-map-btn" class="buy-btn" style="font-size:0.8em;padding:0.3em 1ch;white-space:nowrap">choose on map</button>
            </div>
            <p id="detect-location-status" style="color:var(--dim);font-size:0.8em;margin-top:0.25em">${t('projects.locationHelp')}</p>
            <div id="propose-location-map" style="height:200px;border:1px solid var(--border);margin-top:0.5em;display:none"></div>
            <div id="propose-radius-row" style="display:none;margin-top:0.5em">
              <input type="range" id="propose-radius" min="1" max="50" value="5" style="width:100%">
              <span id="propose-radius-label" style="color:var(--dim);font-size:0.8em">5 km radius</span>
            </div>
            <input type="hidden" id="propose-location-data" value="">
          </div>
          <!-- revenue sharing -->
          <div class="project-card-group">
            <span class="project-card-group-title">revenue sharing</span>
            <p class="project-card-group-hint">share future revenue from this project (e.g. ticket sales, streaming, residuals) with the people who funded it. funders earn proportional to what they put in.</p>
            <label class="project-option">
              <input type="checkbox" id="revenue-share-check">
              <span class="project-option-title">share future revenue with funders</span>
              <span class="project-option-desc">payouts split pro-rata based on each funder's contribution. you keep the rest.</span>
            </label>
            <div id="revenue-share-options" style="display:none;margin-top:0.75em">
              <label class="project-label">${t('projects.revenueLabel')}</label>
              <div class="project-card-row">
                <input type="number" id="revenue-share-pct" class="project-input" placeholder="50" min="1" max="100" value="50" style="width:8ch">
                <span style="color:var(--muted);font-size:0.85em">% of revenue → funders</span>
              </div>
              <p style="color:var(--dim);font-size:0.8em;margin-top:0.5em">${t('projects.revenueHelp')}</p>
            </div>
          </div>

          <!-- completion mode -->
          <div class="project-card-group">
            <span class="project-card-group-title">how the project completes</span>
            <p class="project-card-group-hint">when work is finished, who has to confirm before funds are released to the team? this protects both the team (work was done) and the funders (work was approved).</p>

            <label class="project-option">
              <input type="radio" name="confirm-mode" value="0" checked>
              <span class="project-option-title">proposer confirms alone</span>
              <span class="project-option-desc">you (the proposer) mark the project complete on your own. fastest. trust-based.</span>
            </label>
            <label class="project-option">
              <input type="radio" name="confirm-mode" value="1">
              <span class="project-option-title">majority of the team confirms</span>
              <span class="project-option-desc">more than half of your collaborators must sign off before completion. balanced.</span>
            </label>
            <label class="project-option">
              <input type="radio" name="confirm-mode" value="2">
              <span class="project-option-title">all collaborators confirm</span>
              <span class="project-option-desc">every collaborator must sign off. safest. requires unanimous agreement.</span>
            </label>

            <div style="margin-top:1em">
              <span class="project-card-group-title" style="font-size:0.75em">or skip confirmation entirely</span>
              <label class="project-option" style="margin-top:0.4em">
                <input type="checkbox" id="auto-complete-check">
                <span class="project-option-title">instant — auto-complete on full funding</span>
                <span class="project-option-desc">funds release the moment the goal is met. no confirmation, no dispute window. use this for fixed-price products (event tickets, finished media) where there's nothing to deliver later.</span>
              </label>
            </div>

            <div style="margin-top:1em">
              <label class="project-label" style="font-size:0.75em;text-transform:uppercase;letter-spacing:0.05em">dispute window</label>
              <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.5em">after the project is marked complete, funders have this many days to dispute and reclaim their money if the work wasn't delivered.</p>
              <div class="project-card-row">
                <input type="number" id="propose-dispute-days" class="project-input" value="3" min="0" max="30">
                <span style="color:var(--muted);font-size:0.85em">days (0 = no dispute window)</span>
              </div>
            </div>
          </div>
        </div>
        <div style="display:flex;justify-content:center;padding:0.75em 0 0.25em;border-top:1px solid var(--border)">
          <span style="color:var(--dim);font-size:0.75em">proposed on Ethereum via praxis</span>
        </div>
        <p id="propose-status" style="color:#666;margin-top:0.5em;text-align:center"></p>
      </div>
    </div>
  `
  document.body.appendChild(panel)

  // open panel
  document.getElementById('propose-toggle').addEventListener('click', () => {
    panel.classList.add('compose-open')
  })

  // close panel
  document.getElementById('propose-close').addEventListener('click', () => {
    panel.classList.remove('compose-open')
  })

  document.getElementById('revenue-share-check')?.addEventListener('change', (e) => {
    document.getElementById('revenue-share-options').style.display = e.target.checked ? 'block' : 'none'
  })

  // Auto-complete toggle: disable confirmation mode radios + dispute window
  document.getElementById('auto-complete-check')?.addEventListener('change', (e) => {
    const radios = document.querySelectorAll('input[name="confirm-mode"]')
    const disputeInput = document.getElementById('propose-dispute-days')
    if (e.target.checked) {
      radios.forEach(r => { r.disabled = true; r.checked = false; r.closest('.project-option').style.opacity = '0.35' })
      if (disputeInput) { disputeInput.disabled = true; disputeInput.value = '0'; disputeInput.closest('div[style*="margin-top"]').style.opacity = '0.35' }
    } else {
      radios.forEach(r => { r.disabled = false; r.closest('.project-option').style.opacity = '1' })
      if (!document.querySelector('input[name="confirm-mode"]:checked')) radios[0].checked = true
      if (disputeInput) { disputeInput.disabled = false; disputeInput.value = '3'; disputeInput.closest('div[style*="margin-top"]').style.opacity = '1' }
    }
  })

  // --- Category tag input ---
  const _categoryTags = []
  const _catContainer = document.getElementById('propose-type-container')
  const _catInput = document.getElementById('propose-type')
  const _catDropdown = document.getElementById('propose-type-dropdown')
  const CATEGORY_STORAGE_KEY = 'praxis:project-categories'

  function _getCachedCategories() {
    try { return JSON.parse(localStorage.getItem(CATEGORY_STORAGE_KEY) || '[]') } catch { return [] }
  }
  function _saveCachedCategories(cats) {
    const unique = [...new Set(cats)]
    const capped = unique.length > 100 ? unique.slice(-100) : unique
    try { localStorage.setItem(CATEGORY_STORAGE_KEY, JSON.stringify(capped)) } catch {}
  }

  function _addCategoryTag(text) {
    const val = text.trim().toLowerCase().replace(/,/g, '')
    if (!val || _categoryTags.includes(val)) return
    _categoryTags.push(val)
    const pill = document.createElement('span')
    pill.className = 'category-tag-pill'
    pill.style.cssText = 'display:inline-flex;align-items:center;gap:0.3ch;border:1px solid var(--border);color:var(--fg);font-size:0.8em;padding:0.2em 0.6ch;white-space:nowrap'
    pill.dataset.value = val
    pill.textContent = val
    const x = document.createElement('button')
    x.type = 'button'
    x.textContent = '\u00d7'
    x.style.cssText = 'background:none;border:none;color:var(--dim,#666);cursor:pointer;font-size:1.1em;padding:0 0.2ch;line-height:1'
    x.addEventListener('click', (e) => {
      e.stopPropagation()
      const idx = _categoryTags.indexOf(val)
      if (idx >= 0) _categoryTags.splice(idx, 1)
      pill.remove()
      if (_categoryTags.length === 0) _catInput.placeholder = t('projects.categoryPlaceholder')
    })
    pill.appendChild(x)
    _catContainer.insertBefore(pill, _catInput)
    _catInput.value = ''
    _catInput.placeholder = ''
    _catDropdown.style.display = 'none'
    // cache the category
    const cached = _getCachedCategories()
    if (!cached.includes(val)) { cached.push(val); _saveCachedCategories(cached) }
  }

  function _showCategoryDropdown(filter) {
    const cached = _getCachedCategories()
    const combined = [...new Set([...PROJECT_TYPES, ...cached])]
    const matches = filter ? combined.filter(c => c.includes(filter.toLowerCase()) && !_categoryTags.includes(c)) : combined.filter(c => !_categoryTags.includes(c))
    if (matches.length === 0) { _catDropdown.style.display = 'none'; return }
    _catDropdown.innerHTML = ''
    for (const m of matches.slice(0, 15)) {
      const item = document.createElement('div')
      item.textContent = m
      item.style.cssText = 'padding:0.3em 0.6ch;cursor:pointer;font-size:0.85em;color:var(--fg)'
      item.addEventListener('mousedown', (e) => { e.preventDefault(); _addCategoryTag(m) })
      item.addEventListener('mouseenter', () => { item.style.background = 'var(--border)' })
      item.addEventListener('mouseleave', () => { item.style.background = 'none' })
      _catDropdown.appendChild(item)
    }
    _catDropdown.style.display = 'block'
  }

  _catContainer.addEventListener('click', () => _catInput.focus())
  _catInput.addEventListener('focus', () => _showCategoryDropdown(_catInput.value))
  _catInput.addEventListener('input', () => _showCategoryDropdown(_catInput.value))
  _catInput.addEventListener('blur', () => { setTimeout(() => { _catDropdown.style.display = 'none' }, 150) })
  _catInput.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === 'Tab' || e.key === ',') && _catInput.value.trim()) {
      e.preventDefault()
      _addCategoryTag(_catInput.value)
    }
    if (e.key === 'Backspace' && !_catInput.value && _categoryTags.length > 0) {
      const last = _categoryTags.pop()
      const pills = _catContainer.querySelectorAll('.category-tag-pill')
      if (pills.length) pills[pills.length - 1].remove()
      if (_categoryTags.length === 0) _catInput.placeholder = t('projects.categoryPlaceholder')
    }
  })

  function _getCategoryValue() {
    return _categoryTags.join(', ')
  }

  // --- Mini map location picker ---
  let proposeMap = null
  let proposeMarker = null
  let proposeCircle = null
  let proposeLocationData = { lat: null, lng: null, radius: 5, name: '' }

  function updateLocationData() {
    const hiddenInput = document.getElementById('propose-location-data')
    if (hiddenInput && proposeLocationData.lat != null) {
      hiddenInput.value = JSON.stringify(proposeLocationData)
    }
  }

  async function reverseGeocode(lat, lng) {
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`)
      const data = await res.json()
      const city = data.address?.city || data.address?.town || data.address?.village || data.address?.suburb || ''
      const state = data.address?.state || ''
      const country = data.address?.country || ''
      return [city, state].filter(Boolean).join(', ') || [city, country].filter(Boolean).join(', ') || data.display_name?.split(',').slice(0, 2).join(',').trim() || `${lat.toFixed(4)}, ${lng.toFixed(4)}`
    } catch (e) {
      console.warn('geocode error:', e)
      return `${lat.toFixed(4)}, ${lng.toFixed(4)}`
    }
  }

  function updateProposeMarker(lat, lng, skipGeocode) {
    const L = window.L
    if (!proposeMap || !L) return
    const locInput = document.getElementById('propose-location')

    if (proposeMarker) {
      proposeMarker.setLatLng([lat, lng])
    } else {
      const pinIcon = L.divIcon({
        html: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 256 256" style="color:var(--accent)"><path fill="currentColor" d="M128 16a88.1 88.1 0 0 0-88 88c0 75.3 80 132.2 83.4 134.3a8 8 0 0 0 9.2 0C136 236.2 216 179.3 216 104a88.1 88.1 0 0 0-88-88m0 56a32 32 0 1 1-32 32a32 32 0 0 1 32-32"/></svg>',
        className: '',
        iconSize: [24, 24],
        iconAnchor: [12, 24],
        popupAnchor: [0, -24],
      })
      proposeMarker = L.marker([lat, lng], { icon: pinIcon, draggable: true }).addTo(proposeMap)
      proposeMarker.on('dragend', async () => {
        const pos = proposeMarker.getLatLng()
        const name = await reverseGeocode(pos.lat, pos.lng)
        locInput.value = name
        locInput.dataset.lat = pos.lat.toFixed(7)
        locInput.dataset.lng = pos.lng.toFixed(7)
        proposeLocationData.lat = pos.lat
        proposeLocationData.lng = pos.lng
        proposeLocationData.name = name
        updateLocationData()
        updateProposeCircle(pos.lat, pos.lng)
      })
    }

    const radius = parseInt(document.getElementById('propose-radius')?.value) || 5
    updateProposeCircle(lat, lng, radius)
    proposeMap.setView([lat, lng], 12)

    proposeLocationData.lat = lat
    proposeLocationData.lng = lng
    if (!skipGeocode) {
      reverseGeocode(lat, lng).then(name => {
        locInput.value = name
        proposeLocationData.name = name
        updateLocationData()
      })
    }
    locInput.dataset.lat = lat.toFixed(7)
    locInput.dataset.lng = lng.toFixed(7)
    updateLocationData()
  }

  function updateProposeCircle(lat, lng, radiusKm) {
    const L = window.L
    if (!proposeMap || !L) return
    if (!radiusKm) radiusKm = parseInt(document.getElementById('propose-radius')?.value) || 5
    if (proposeCircle) {
      proposeCircle.setLatLng([lat, lng])
      proposeCircle.setRadius(radiusKm * 1000)
    } else {
      proposeCircle = L.circle([lat, lng], {
        radius: radiusKm * 1000,
        color: '#c0c0c0',
        weight: 1,
        opacity: 0.3,
        fillColor: '#c0c0c0',
        fillOpacity: 0.1,
      }).addTo(proposeMap)
    }
  }

  async function showProposeMap(lat, lng) {
    await loadLeaflet()
    const L = window.L
    const mapEl = document.getElementById('propose-location-map')
    const radiusRow = document.getElementById('propose-radius-row')
    if (!mapEl) return

    mapEl.style.display = 'block'
    radiusRow.style.display = 'block'

    if (!proposeMap) {
      proposeMap = L.map(mapEl, { scrollWheelZoom: true }).setView([lat || 20, lng || 0], lat ? 12 : 2)
      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OSM',
        maxZoom: 19,
      }).addTo(proposeMap)

      proposeMap.on('click', async (e) => {
        updateProposeMarker(e.latlng.lat, e.latlng.lng)
      })

      setTimeout(() => proposeMap.invalidateSize(), 350)
    } else {
      proposeMap.invalidateSize()
      if (lat && lng) proposeMap.setView([lat, lng], 12)
    }

    if (lat && lng) {
      updateProposeMarker(lat, lng, true)
    }
  }

  // radius slider
  document.getElementById('propose-radius')?.addEventListener('input', (e) => {
    const val = parseInt(e.target.value) || 5
    document.getElementById('propose-radius-label').textContent = `${val} km radius`
    proposeLocationData.radius = val
    updateLocationData()
    if (proposeMarker) {
      const pos = proposeMarker.getLatLng()
      updateProposeCircle(pos.lat, pos.lng, val)
    }
  })

  // detect location button
  document.getElementById('detect-location-btn')?.addEventListener('click', async () => {
    const locInput = document.getElementById('propose-location')
    const locStatus = document.getElementById('detect-location-status')
    if (!navigator.geolocation) {
      locStatus.textContent = 'geolocation not supported'
      return
    }
    locStatus.textContent = 'detecting...'
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const { latitude, longitude } = pos.coords
      try {
        const name = await reverseGeocode(latitude, longitude)
        locInput.value = name
        locInput.dataset.lat = latitude.toFixed(7)
        locInput.dataset.lng = longitude.toFixed(7)
        proposeLocationData = { lat: latitude, lng: longitude, radius: parseInt(document.getElementById('propose-radius')?.value) || 5, name }
        updateLocationData()
        locStatus.textContent = t('projects.locationHelp')
        await showProposeMap(latitude, longitude)
        updateProposeMarker(latitude, longitude, true)
      } catch (e) {
        locStatus.textContent = 'could not detect location'
        console.warn('geocode error:', e)
      }
    }, (err) => {
      locStatus.textContent = err.code === 1 ? 'location permission denied' : 'could not detect location'
    }, { enableHighAccuracy: false, timeout: 10000 })
  })

  // choose on map button
  document.getElementById('choose-on-map-btn')?.addEventListener('click', async () => {
    const locInput = document.getElementById('propose-location')
    const lat = locInput.dataset.lat ? parseFloat(locInput.dataset.lat) : null
    const lng = locInput.dataset.lng ? parseFloat(locInput.dataset.lng) : null
    await showProposeMap(lat, lng)
  })

  // clear lat/lng data attrs if user types manually
  document.getElementById('propose-location')?.addEventListener('input', () => {
    const locInput = document.getElementById('propose-location')
    delete locInput.dataset.lat
    delete locInput.dataset.lng
    proposeLocationData.lat = null
    proposeLocationData.lng = null
    proposeLocationData.name = locInput.value
    updateLocationData()
  })

  // team management
  function updateSplitTotal() {
    const inputs = document.querySelectorAll('.team-split-input')
    const total = [...inputs].reduce((sum, el) => sum + (parseFloat(el.value) || 0), 0)
    const el = document.getElementById('split-total')
    if (el) {
      el.textContent = t('projects.total', { pct: total })
      el.style.color = total === 100 ? '#4ade80' : '#ef4444'
    }
  }

  document.getElementById('add-team-btn').addEventListener('click', () => {
    const row = `<div class="propose-team-row" style="display:flex;gap:0.5em;margin-bottom:0.5em;align-items:center">
      <input type="text" class="team-domain-input project-input" placeholder="${t('projects.memberPlaceholder')}" autocomplete="off" style="flex:3">
      <input type="number" class="team-split-input project-input" placeholder="${t('projects.splitPct')}" style="flex:1" value="50">
      <span style="color:#444;font-size:0.85em">${t('projects.splitPct')}</span>
      <button type="button" class="remove-team-btn" style="background:none;border:none;color:#666;cursor:pointer;font-size:1.2em">&times;</button>
    </div>`
    document.getElementById('propose-team').insertAdjacentHTML('beforeend', row)
    updateSplitTotal()
  })

  document.getElementById('propose-team').addEventListener('click', (e) => {
    if (e.target.closest('.remove-team-btn')) {
      const rows = document.querySelectorAll('.propose-team-row')
      if (rows.length > 1) { e.target.closest('.propose-team-row').remove(); updateSplitTotal() }
    }
  })

  // debounced domain search for autocomplete
  let _domainSearchTimer = null
  document.getElementById('propose-team').addEventListener('input', (e) => {
    if (e.target.classList.contains('team-split-input')) updateSplitTotal()
    if (e.target.classList.contains('team-domain-input')) {
      const input = e.target
      const val = input.value.trim().toLowerCase()
      const valid = domainToWallet[val]
      input.style.borderColor = val.length === 0 ? '#333' : (valid ? '#4ade80' : '#ef4444')

      // show autocomplete dropdown
      let dropdown = input.parentElement.querySelector('.domain-dropdown')
      if (!dropdown) {
        dropdown = document.createElement('div')
        dropdown.className = 'domain-dropdown'
        input.parentElement.style.position = 'relative'
        input.parentElement.appendChild(dropdown)
      }

      if (val.length < 2) { dropdown.innerHTML = ''; return }

      // check local cache first, then query Ponder
      const localMatches = Object.keys(domainToWallet).filter(d => d.includes(val)).slice(0, 5)
      if (localMatches.length > 0) {
        renderDropdown(dropdown, localMatches, input)
      }

      // debounced live search from Ponder
      clearTimeout(_domainSearchTimer)
      _domainSearchTimer = setTimeout(async () => {
        try {
          const data = await query(`query SearchArtists($prefix: String!) { artists(where: { domain_contains: $prefix }, limit: 5) { items { ${F.artist} } } }`, { prefix: val })
          const results = data.artists?.items || []
          for (const a of results) {
            const key = a.id.toLowerCase()
            domainToWallet[a.domain.toLowerCase()] = key
          }
          const matches = results.map(a => a.domain.toLowerCase())
          // merge with local matches, deduplicate
          const allMatches = [...new Set([...localMatches, ...matches])].slice(0, 5)
          if (input.value.trim().toLowerCase() === val) {
            renderDropdown(dropdown, allMatches, input)
          }
        } catch {}
      }, 300)
    }
  })

  function renderDropdown(dropdown, matches, input) {
    dropdown.innerHTML = matches.map(d =>
      `<div class="domain-option" data-domain="${escapeHtml(d)}">${escapeHtml(d)}</div>`
    ).join('')
    dropdown.querySelectorAll('.domain-option').forEach(opt => {
      opt.addEventListener('mousedown', (ev) => {
        ev.preventDefault()
        input.value = opt.dataset.domain
        input.style.borderColor = '#4ade80'
        dropdown.innerHTML = ''
      })
    })
  }

  document.getElementById('propose-team').addEventListener('focusout', (e) => {
    if (e.target.classList.contains('team-domain-input')) {
      setTimeout(() => {
        const dropdown = e.target.parentElement.querySelector('.domain-dropdown')
        if (dropdown) dropdown.innerHTML = ''
      }, 150)
    }
  })

  // tier management
  function updateTierCalc() {
    const rows = document.querySelectorAll('.propose-tier-row')
    let total = 0
    for (const row of rows) {
      const price = parseFloat(row.querySelector('.tier-price-input')?.value) || 0
      const supply = parseInt(row.querySelector('.tier-supply-input')?.value) || 0
      if (supply > 0) total += price * supply
    }
    const el = document.getElementById('tier-calc')
    if (el) {
      el.textContent = total > 0 ? t('projects.fundingGoal', { eth: formatEthAmount(BigInt(Math.round(total * 1e18))) }) : t('projects.fundingGoal', { eth: '0' })
      el.style.color = total > 0 ? '#4ade80' : '#444'
    }
  }

  document.getElementById('add-tier-btn').addEventListener('click', () => {
    const row = `<div class="propose-tier-row" style="display:flex;gap:0.5em;margin-bottom:0.5em;align-items:center">
      <input type="text" class="tier-name-input project-input" placeholder="tier name" style="flex:2">
      <input type="text" class="tier-price-input project-input" placeholder="ETH" style="flex:1">
      <input type="number" class="tier-supply-input project-input" placeholder="cap" style="flex:1" min="1" value="10">
      <select class="tier-type-input project-input" style="flex:1">
        <option value="ticket">${t('projects.ticket')}</option>
        <option value="backer">${t('projects.backerCredit')}</option>
      </select>
      <button type="button" class="remove-tier-btn" style="background:none;border:none;color:#666;cursor:pointer;font-size:1.2em">&times;</button>
    </div>`
    document.getElementById('propose-tiers').insertAdjacentHTML('beforeend', row)
    updateTierCalc()
  })

  document.getElementById('propose-tiers').addEventListener('click', (e) => {
    if (e.target.closest('.remove-tier-btn')) {
      const rows = document.querySelectorAll('.propose-tier-row')
      if (rows.length > 1) { e.target.closest('.propose-tier-row').remove(); updateTierCalc() }
    }
  })

  document.getElementById('propose-tiers').addEventListener('input', () => updateTierCalc())

  document.getElementById('propose-btn').addEventListener('click', async () => {
    const ps = document.getElementById('propose-status')
    const title = document.getElementById('propose-title').value.trim()
    const desc = document.getElementById('propose-desc').value.trim()
    // collect category tags; use first matching PROJECT_TYPE for the contract enum
    if (_catInput.value.trim()) _addCategoryTag(_catInput.value) // capture any unsubmitted text
    const typeStr = _categoryTags.find(t => PROJECT_TYPES.indexOf(t) >= 0) || _categoryTags[0] || ''
    const typeVal = PROJECT_TYPES.indexOf(typeStr) >= 0 ? PROJECT_TYPES.indexOf(typeStr) : 6 // default to OTHER
    // collect team from rows
    const teamRows = document.querySelectorAll('.propose-team-row')
    const collabDomains = []
    const splitValues = []
    for (const row of teamRows) {
      const domain = row.querySelector('.team-domain-input').value.trim()
      const pct = parseFloat(row.querySelector('.team-split-input').value) || 0
      if (!domain) continue
      collabDomains.push(domain)
      splitValues.push(Math.round(pct * 100)) // percent -> basis points
    }
    const deadlineStr = document.getElementById('propose-deadline').value

    if (!title) { ps.textContent = 'enter a title'; return }
    if (collabDomains.length === 0) { ps.textContent = 'add at least one team member'; return }
    if (collabDomains.length !== splitValues.length) { ps.textContent = 'split count must match team members'; return }

    const splitSum = splitValues.reduce((a, b) => a + b, 0)
    if (splitSum !== 10000) { ps.textContent = `splits total ${(splitSum / 100).toFixed(1)}%, must be 100%`; return }

    if (!deadlineStr) { ps.textContent = 'set a deadline'; return }

    // collect tiers
    const tierRows = document.querySelectorAll('.propose-tier-row')
    const tierNames = []
    const tierPrices = []
    const tierSupplies = []
    const tierTransferable = []
    for (const row of tierRows) {
      const name = row.querySelector('.tier-name-input').value.trim()
      const price = row.querySelector('.tier-price-input').value.trim()
      const supply = parseInt(row.querySelector('.tier-supply-input').value) || 0
      const transfer = row.querySelector('.tier-type-input').value === 'ticket'
      if (!name || !price) continue
      tierNames.push(name)
      tierPrices.push(parseEther(price))
      tierSupplies.push(BigInt(supply))
      tierTransferable.push(transfer)
    }

    if (tierNames.length === 0) { ps.textContent = 'add at least one funding tier'; return }

    // auto-calculate funding goal from tier prices x supplies
    let goalWei = 0n
    for (let i = 0; i < tierPrices.length; i++) {
      const supply = tierSupplies[i]
      if (supply > 0n) goalWei += tierPrices[i] * supply
    }
    if (goalWei === 0n) { ps.textContent = 'set tier capacities to calculate funding goal'; return }

    const collabAddresses = []
    for (const domain of collabDomains) {
      let addr = domainToWallet[domain.toLowerCase()]
      if (!addr) {
        // fallback: query Ponder for this domain
        try {
          const data = await query(`query LookupDomain($domain: String!) { artists(where: { domain: $domain }, limit: 1) { items { ${F.artist} } } }`, { domain: domain.toLowerCase() })
          const artist = data.artists?.items?.[0]
          if (artist) {
            addr = artist.id.toLowerCase()
            domainToWallet[artist.domain.toLowerCase()] = addr
          }
        } catch {}
      }
      if (!addr) { ps.textContent = `"${domain}" not found in registry`; return }
      collabAddresses.push(addr)
    }

    const deadline = Math.floor(new Date(deadlineStr).getTime() / 1000)
    if (deadline <= Math.floor(Date.now() / 1000)) { ps.textContent = 'deadline must be in the future'; return }

    const address = window.getWalletAddress?.()
    if (!address) {
      await window.connectWallet?.()
      if (!window.getWalletAddress?.()) { ps.textContent = t('projects.connectWallet'); return }
    }

    try {
      await getWalletProvider().request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xa' }] })
    } catch (e) { if (e.code === 4902) { ps.textContent = t('projects.addOptimism'); return } }

    // revenue share
    const revShareChecked = document.getElementById('revenue-share-check')?.checked
    const revSharePct = revShareChecked ? (parseInt(document.getElementById('revenue-share-pct')?.value) || 0) : 0
    const revShareBps = BigInt(Math.min(revSharePct * 100, 10000))

    // location -- use detected lat/lng if available, otherwise geocode
    let locationPacked = 0n
    const locInput = document.getElementById('propose-location')
    const locationStr = locInput?.value.trim()
    let detectedLat = locInput?.dataset.lat ? parseFloat(locInput.dataset.lat) : null
    let detectedLng = locInput?.dataset.lng ? parseFloat(locInput.dataset.lng) : null
    const locationRadius = proposeLocationData.radius || 5
    if (locationStr) {
      try {
        if (detectedLat == null || detectedLng == null) {
          // geocode from text input
          const geoRes = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(locationStr)}&limit=1`)
          const geoData = await geoRes.json()
          if (geoData[0]) {
            detectedLat = parseFloat(geoData[0].lat)
            detectedLng = parseFloat(geoData[0].lon)
          }
        }
        if (detectedLat != null && detectedLng != null) {
          const lat = Math.round(detectedLat * 1e7)
          const lng = Math.round(detectedLng * 1e7)
          // pack into uint128: upper 64 = lat, lower 64 = lng
          const latBig = BigInt(lat < 0 ? lat + 2**64 : lat) // handle negative as uint64
          const lngBig = BigInt(lng < 0 ? lng + 2**64 : lng)
          locationPacked = (latBig << 64n) | lngBig
          // store display format: "Name|lat,lng,radius"
          locInput.dataset.locationDisplay = `${locationStr}|${detectedLat.toFixed(7)},${detectedLng.toFixed(7)},${locationRadius}`
        }
      } catch {}
    }

    // completion settings
    const confirmModeEl = document.querySelector('input[name="confirm-mode"]:checked')
    const confirmationMode = parseInt(confirmModeEl?.value || '0')
    const autoComplete = document.getElementById('auto-complete-check')?.checked || false
    const disputeWindowDays = autoComplete ? 0n : BigInt(parseInt(document.getElementById('propose-dispute-days')?.value) || 3)

    ps.textContent = t('projects.confirming')

    try {
      const proposeAcct = await window.ensureAuthorized?.() || window.getWalletAddress()
      const wc = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })
      const hash = await wc.writeContract({
        address: hubAddress, abi: HUB_ABI, functionName: 'proposeProject',
        args: [title, desc, typeVal, collabAddresses, splitValues.map(s => BigInt(s)), goalWei, BigInt(deadline), tierNames, tierPrices, tierSupplies, tierTransferable, revShareBps, locationPacked, disputeWindowDays, autoComplete, confirmationMode],
        account: proposeAcct,
      })
      ps.textContent = `tx: ${hash.slice(0, 14)}...`
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      ps.textContent = t('projects.doneReloading')

      // --- auto-create XMTP group chat with collaborators ---
      try {
        // extract projectId from ProjectProposed event log
        // event ProjectProposed(uint256 indexed projectId, address indexed proposer, uint256 fundingGoal)
        const { keccak256, toBytes } = await import('./vendor.js')
        const proposedTopic = keccak256(toBytes('ProjectProposed(uint256,address,uint256)'))
        const proposedLog = receipt.logs.find(l => l.topics[0]?.toLowerCase() === proposedTopic.toLowerCase())
        let projectId = null
        if (proposedLog && proposedLog.topics[1]) {
          projectId = BigInt(proposedLog.topics[1]).toString()
        }

        if (projectId && collabAddresses.length > 0) {
          const sdk = await import('./vendor-xmtp.js').catch(() => null)
          if (sdk) {
            // Reuse existing XMTP client — never create fire-and-forget installations.
            // Priority: window._xmtpClient (from messages.js/wallet.js/dm.js)
            // Fallback: Client.build (FREE, reconnects to OPFS — no new installation)
            // Last resort: Client.create (costs 1 identity operation — only if truly needed)
            let xmtpClient = window._xmtpClient || null
            if (!xmtpClient) {
              const myAddr = window.getWalletAddress()
              if (myAddr) {
                const hasRegistered = localStorage.getItem(`xmtp-registered-${myAddr.toLowerCase()}`)
                // Try Client.build first (FREE — no identity operation cost)
                if (hasRegistered) {
                  try {
                    const identifier = { identifier: myAddr, identifierKind: sdk.IdentifierKind.Ethereum }
                    xmtpClient = await sdk.Client.build(identifier, { env: 'production' })
                    if (!xmtpClient?.inboxId) xmtpClient = null
                  } catch (buildErr) {
                    console.warn('praxis: projects Client.build failed:', buildErr?.message)
                    xmtpClient = null
                  }
                }
                // Only fall back to Client.create if Client.build failed and user has never registered.
                // This path is rare — typically only happens if user proposes a project before ever visiting /messages.
                if (!xmtpClient) {
                  await window.ensureAuthorized?.()
                  const signer = {
                    type: 'EOA',
                    getIdentifier: () => ({
                      identifier: myAddr,
                      identifierKind: sdk.IdentifierKind.Ethereum,
                    }),
                    signMessage: async (message) => {
                      const hex = await getWalletProvider().request({
                        method: 'personal_sign',
                        params: [message, myAddr],
                      })
                      return new Uint8Array(hex.slice(2).match(/.{2}/g).map(b => parseInt(b, 16)))
                    },
                  }
                  try {
                    xmtpClient = await sdk.Client.create(signer, { env: 'production' })
                    // Store for reuse so we don't create another installation
                    if (xmtpClient) {
                      window._xmtpClient = xmtpClient
                      window._xmtpSdk = sdk
                      try { localStorage.setItem(`xmtp-registered-${myAddr.toLowerCase()}`, '1') } catch {}
                    }
                  } catch (createErr) {
                    console.warn('praxis: projects Client.create failed:', createErr?.message)
                    xmtpClient = null
                  }
                }
              }
            }

            if (xmtpClient) {
              // resolve collaborator addresses to XMTP inbox IDs
              const inboxIds = []
              for (const addr of collabAddresses) {
                try {
                  const id = await xmtpClient.fetchInboxIdByIdentifier({
                    identifier: addr,
                    identifierKind: sdk.IdentifierKind.Ethereum,
                  })
                  if (id) inboxIds.push(id)
                } catch {}
              }

              if (inboxIds.length > 0) {
                const group = await xmtpClient.conversations.newGroup(inboxIds, { name: title })
                // store group ID via API
                await fetch(`/api/project-group?id=${projectId}`, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ groupId: group.id }),
                })
              }
            }
          }
        }
      } catch (e) {
        console.warn('auto group chat creation failed:', e)
      }

      setTimeout(() => location.reload(), 3000)
    } catch (e) {
      ps.textContent = e.code === 4001 ? t('status.cancelled') : `error: ${e.shortMessage || e.message}`
    }
  })
}

// --- Map view ---

let leafletLoaded = false
let mapInstance = null

async function loadLeaflet() {
  if (leafletLoaded) return
  // load CSS
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = 'https://unpkg.com/leaflet@1.9/dist/leaflet.css'
  document.head.appendChild(link)
  // load JS
  await new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://unpkg.com/leaflet@1.9/dist/leaflet.js'
    s.onload = resolve
    s.onerror = reject
    document.head.appendChild(s)
  })
  // load marker cluster CSS + JS
  const clusterCss = document.createElement('link')
  clusterCss.rel = 'stylesheet'
  clusterCss.href = 'https://unpkg.com/leaflet.markercluster@1.5/dist/MarkerCluster.css'
  document.head.appendChild(clusterCss)
  const clusterDefaultCss = document.createElement('link')
  clusterDefaultCss.rel = 'stylesheet'
  clusterDefaultCss.href = 'https://unpkg.com/leaflet.markercluster@1.5/dist/MarkerCluster.Default.css'
  document.head.appendChild(clusterDefaultCss)
  await new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://unpkg.com/leaflet.markercluster@1.5/dist/leaflet.markercluster.js'
    s.onload = resolve
    s.onerror = reject
    document.head.appendChild(s)
  })
  leafletLoaded = true
}

function unpackLocation(packed, locationDisplay) {
  // try to parse pipe-delimited display format first: "Name|lat,lng,radius"
  if (locationDisplay && typeof locationDisplay === 'string' && locationDisplay.includes('|')) {
    const parts = locationDisplay.split('|')
    if (parts.length >= 2) {
      const coords = parts[1].split(',')
      if (coords.length >= 2) {
        const lat = parseFloat(coords[0])
        const lng = parseFloat(coords[1])
        const radius = coords.length >= 3 ? parseInt(coords[2]) || 5 : 5
        if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
          return { lat, lng, radius, name: parts[0] }
        }
      }
    }
  }

  if (!packed || packed === '0' || packed === 0n) return null
  const val = BigInt(packed)
  if (val === 0n) return null
  const lngRaw = val & ((1n << 64n) - 1n)
  const latRaw = val >> 64n
  // convert back from uint64 to signed
  let lat = latRaw >= (1n << 63n) ? Number(latRaw - (1n << 64n)) : Number(latRaw)
  let lng = lngRaw >= (1n << 63n) ? Number(lngRaw - (1n << 64n)) : Number(lngRaw)
  lat = lat / 1e7
  lng = lng / 1e7
  if (lat === 0 && lng === 0) return null
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
  return { lat, lng, radius: 5 }
}

function setupViewToggle(projects, resolve) {
  const toggleBtns = document.querySelectorAll('.projects-toggle')
  const listView = document.getElementById('projects-list-view')
  const mapView = document.getElementById('projects-map-view')
  if (!toggleBtns.length || !listView || !mapView) return

  toggleBtns.forEach(btn => {
    btn.addEventListener('click', async () => {
      toggleBtns.forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      const view = btn.dataset.view
      const listFilters = document.getElementById('projects-list-filters')
      if (view === 'list') {
        listView.style.display = ''
        mapView.style.display = 'none'
        if (listFilters) listFilters.style.display = ''
      } else {
        listView.style.display = 'none'
        mapView.style.display = ''
        if (listFilters) listFilters.style.display = 'none'
        await initMap(projects, resolve)
      }
    })
  })
}

async function initMap(projects, resolve) {
  await loadLeaflet()
  const L = window.L
  const container = document.getElementById('projects-map')
  if (!container) return

  // destroy existing map
  if (mapInstance) {
    mapInstance.remove()
    mapInstance = null
  }

  mapInstance = L.map(container, { scrollWheelZoom: true }).setView([20, 0], 2)
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
    attribution: 'CartoDB',
    maxZoom: 19,
  }).addTo(mapInstance)

  const markerCluster = L.markerClusterGroup()
  const noLocationEl = document.getElementById('projects-no-location')
  const withLocation = []
  const withoutLocation = []

  for (const p of projects) {
    // try to unpack location from the on-chain data
    // also check for pipe-delimited display format: "Name|lat,lng,radius"
    const loc = unpackLocation(p.locationPacked || 0n, p.locationDisplay)
    if (loc) {
      withLocation.push({ ...p, loc })
    } else {
      withoutLocation.push(p)
    }
  }

  // state for filtering
  let currentFilter = 'all'
  let currentStatus = null
  let userLoc = null

  // track radius circles so we can clear them on re-render
  let radiusCircles = []

  function renderMarkers(filtered) {
    markerCluster.clearLayers()
    radiusCircles.forEach(c => mapInstance.removeLayer(c))
    radiusCircles = []
    const bounds = []
    for (const p of filtered) {
      if (!p.loc) continue
      const pct = p.goal > 0n ? Number(p.funded * 10000n / p.goal) / 100 : 0
      const popupHtml = `
        <div style="font-family:inherit;font-size:13px;min-width:150px">
          <strong><a href="/project?id=${p.id}" style="color:inherit">${escapeHtml(p.title)}</a></strong><br>
          <span style="opacity:0.7">${PROJECT_TYPES[p.type] || 'other'}</span>
          <span style="margin-left:0.5em;color:${STATUS_COLORS[p.status]}">${STATUS_LABELS[p.status]?.() || ''}</span><br>
          <span>${pct.toFixed(0)}% ${t('feed.funded').toLowerCase()}</span>
        </div>
      `
      const pinIcon = L.divIcon({
        html: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 256 256" style="color:var(--accent)"><path fill="currentColor" d="M128 16a88.1 88.1 0 0 0-88 88c0 75.3 80 132.2 83.4 134.3a8 8 0 0 0 9.2 0C136 236.2 216 179.3 216 104a88.1 88.1 0 0 0-88-88m0 56a32 32 0 1 1-32 32a32 32 0 0 1 32-32"/></svg>',
        className: '',
        iconSize: [24, 24],
        iconAnchor: [12, 24],
        popupAnchor: [0, -24],
      })
      const marker = L.marker([p.loc.lat, p.loc.lng], { icon: pinIcon })
      marker.bindPopup(popupHtml)
      markerCluster.addLayer(marker)
      bounds.push([p.loc.lat, p.loc.lng])

      // show radius circle if project has radius data
      const radiusKm = p.loc.radius || 5
      const circle = L.circle([p.loc.lat, p.loc.lng], {
        radius: radiusKm * 1000,
        color: STATUS_COLORS[p.status] || '#c0c0c0',
        weight: 1,
        opacity: 0.3,
        fillColor: STATUS_COLORS[p.status] || '#c0c0c0',
        fillOpacity: 0.1,
      }).addTo(mapInstance)
      circle.bindPopup(popupHtml)
      radiusCircles.push(circle)
    }
    mapInstance.addLayer(markerCluster)
    if (bounds.length > 0) {
      mapInstance.fitBounds(bounds, { padding: [30, 30], maxZoom: 12 })
    }
  }

  function applyFilters() {
    let filtered = [...withLocation]
    if (currentStatus !== null) {
      filtered = filtered.filter(p => p.status === currentStatus)
    }
    if (currentFilter === 'nearby' && userLoc) {
      filtered.sort((a, b) => {
        const dA = Math.hypot(a.loc.lat - userLoc.lat, a.loc.lng - userLoc.lng)
        const dB = Math.hypot(b.loc.lat - userLoc.lat, b.loc.lng - userLoc.lng)
        return dA - dB
      })
    }
    renderMarkers(filtered)
  }

  // render no-location projects
  if (noLocationEl) {
    if (withLocation.length === 0) {
      noLocationEl.innerHTML = `<p style="color:var(--muted);margin-bottom:1em">no projects with locations yet</p>` +
        (withoutLocation.length > 0
          ? `<h4 style="color:var(--muted);margin-bottom:0.5em">${t('projects.noLocation')} (${withoutLocation.length})</h4>` +
            withoutLocation.map(p => {
              const pct = p.goal > 0n ? Number(p.funded * 10000n / p.goal) / 100 : 0
              return `<div class="project-no-loc-item"><a href="/project?id=${p.id}">${escapeHtml(p.title)}</a> <span style="color:var(--muted)">${PROJECT_TYPES[p.type] || 'other'} -- ${pct.toFixed(0)}% funded</span></div>`
            }).join('')
          : '')
    } else if (withoutLocation.length > 0) {
      noLocationEl.innerHTML = `<h4 style="color:var(--muted);margin-bottom:0.5em">${t('projects.noLocation')} (${withoutLocation.length})</h4>` +
        withoutLocation.map(p => {
          const pct = p.goal > 0n ? Number(p.funded * 10000n / p.goal) / 100 : 0
          return `<div class="project-no-loc-item"><a href="/project?id=${p.id}">${escapeHtml(p.title)}</a> <span style="color:var(--muted)">${PROJECT_TYPES[p.type] || 'other'} -- ${pct.toFixed(0)}% funded</span></div>`
        }).join('')
    } else {
      noLocationEl.innerHTML = ''
    }
  }

  // initial render — map always initializes even with no markers
  renderMarkers(withLocation)

  // filter buttons
  document.querySelectorAll('.projects-filter').forEach(btn => {
    btn.addEventListener('click', async () => {
      // handle status filters vs main filters
      if (btn.dataset.status !== undefined) {
        const status = parseInt(btn.dataset.status)
        if (currentStatus === status) {
          currentStatus = null
          btn.classList.remove('active')
        } else {
          document.querySelectorAll('.projects-filter[data-status]').forEach(b => b.classList.remove('active'))
          currentStatus = status
          btn.classList.add('active')
        }
      } else if (btn.dataset.filter) {
        document.querySelectorAll('.projects-filter[data-filter]').forEach(b => b.classList.remove('active'))
        btn.classList.add('active')
        currentFilter = btn.dataset.filter
        if (currentFilter === 'nearby' && !userLoc) {
          if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
              (pos) => { userLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude }; applyFilters() },
              () => { currentFilter = 'all'; btn.classList.remove('active'); document.querySelector('.projects-filter[data-filter="all"]')?.classList.add('active') },
              { enableHighAccuracy: false, timeout: 10000 }
            )
            return
          }
        }
      }
      applyFilters()
    })
  })

  // fix map rendering on tab switch
  setTimeout(() => mapInstance.invalidateSize(), 100)
}

// escapeHtml imported from utils.js
