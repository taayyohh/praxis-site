// Notification center — queries Ponder for actionable events for the connected wallet
import { query } from './ponder.js'
import { F } from './fragments.js'
import { resolveAddresses, resolveDomain, escapeHtml, getPublicClient, formatEthAmount, isBlocked, getPendingWithdrawals, getWalletProvider, timeAgo, getAuthToken } from './utils.js'
import { t } from './i18n.js'
import { getCached, setCache, TTL } from './cache.js'

const LAST_SEEN_KEY = 'praxis-notif-last-seen'
const NOTIF_CACHE_KEY = 'praxis-notif-cache'
const NOTIF_CACHE_TTL = 2 * 60 * 1000 // 2 minutes
import { PRAXIS_ADDR, PRAXIS_ABI } from './contracts.js'

let notifPanel = null
let currentNotifications = []
let _serverLastSeen = 0 // fallback from server for cross-device sync
let _visTickBound = false // guard to prevent duplicate visibilitychange listeners

// 5-minute in-memory cache for on-chain notification reads (hasConfirmed,
// pendingWithdrawals). At 30s poll intervals with hundreds of signed-in tabs
// these reads otherwise hammer Scroll RPC.
const ONCHAIN_CACHE_TTL_MS = 5 * 60 * 1000
const _onchainCache = new Map() // key -> { value, ts }
function _onchainCacheGet(key) {
  const hit = _onchainCache.get(key)
  if (!hit) return undefined
  if (Date.now() - hit.ts > ONCHAIN_CACHE_TTL_MS) {
    _onchainCache.delete(key)
    return undefined
  }
  // LRU bump: delete + re-set moves entry to end of Map iteration order
  _onchainCache.delete(key)
  _onchainCache.set(key, hit)
  return hit.value
}
function _onchainCacheSet(key, value) {
  // LRU: delete first so re-set moves to end
  _onchainCache.delete(key)
  // Bound the cache — evict least-recently-used (first in Map order)
  if (_onchainCache.size >= 1000) {
    const firstKey = _onchainCache.keys().next().value
    if (firstKey !== undefined) _onchainCache.delete(firstKey)
  }
  _onchainCache.set(key, { value, ts: Date.now() })
}

/** Build an <a> tag linking to the person's profile page */
function whoLink(addr, domainMap) {
  const name = escapeHtml(resolveDomain(domainMap, addr))
  const href = `/network?artist=${addr.toLowerCase()}`
  return `<a href="${href}" style="color:var(--accent)">${name}</a>`
}

function getLastSeen() {
  try {
    const local = parseInt(localStorage.getItem(LAST_SEEN_KEY) || '0', 10)
    return Math.max(local, _serverLastSeen)
  } catch { return _serverLastSeen }
}

function setLastSeen(ts) {
  try { localStorage.setItem(LAST_SEEN_KEY, String(ts)) } catch {}
  // Fire-and-forget: persist to server for cross-device sync
  const addr = window.getWalletAddress?.()
  if (addr) {
    const authToken = sessionStorage.getItem('praxis-auth-token') || ''
    fetch('/api/notifications/mark-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}) },
      body: JSON.stringify({ wallet: addr, timestamp: ts }),
    }).catch(() => {}) // fire-and-forget
  }
}

async function loadNotifications(myAddr) {
  // check cache
  try {
    const cached = sessionStorage.getItem(NOTIF_CACHE_KEY)
    if (cached) {
      const { data, timestamp, addr } = JSON.parse(cached)
      if (addr === myAddr.toLowerCase() && Date.now() - timestamp < NOTIF_CACHE_TTL) {
        return data
      }
    }
  } catch {}

  const notifications = []
  const myAddrLower = myAddr.toLowerCase()

  try {
    // Primary: use server-side /api/notifications endpoint (1 query vs 4+2)
    const serverNotifs = await fetch(`/api/notifications?addr=${myAddrLower}&limit=30`).then(r => r.json())

    // Capture server-side lastSeen for cross-device fallback
    if (typeof serverNotifs?.lastSeen === 'number' && serverNotifs.lastSeen > _serverLastSeen) {
      _serverLastSeen = serverNotifs.lastSeen
    }

    if (serverNotifs?.notifications?.length > 0) {
      const domainMap = serverNotifs.domains || {}
      const resolve = (addr) => resolveDomain(domainMap, addr)

      for (const n of serverNotifs.notifications) {
        if (isBlocked(n.fromAddr)) continue
        if (n.fromAddr.toLowerCase() === myAddrLower) continue

        if (n.eventType === 'funding') {
          const amt = formatEthAmount(n.amount)
          notifications.push({
            type: 'funding',
            text: t('notifications.funded', { who: whoLink(n.fromAddr, domainMap), amount: amt, project: escapeHtml(n.title || `project #${n.refId}`) }),
            time: Number(n.timestamp) * 1000,
            link: `/project?id=${n.refId}`,
            fromAddr: n.fromAddr, refId: n.refId, _who: whoLink(n.fromAddr, domainMap), _project: escapeHtml(n.title || `project #${n.refId}`),
          })
        } else if (n.eventType === 'follow') {
          notifications.push({
            type: 'follower',
            text: t('notifications.newFollower', { who: whoLink(n.fromAddr, domainMap) }),
            time: Number(n.timestamp) * 1000,
            link: `/network?artist=${n.fromAddr.toLowerCase()}`,
            fromAddr: n.fromAddr, _who: whoLink(n.fromAddr, domainMap),
          })
        } else if (n.eventType === 'purchase') {
          notifications.push({
            type: 'purchase',
            text: t('notifications.mediaPurchased', { who: whoLink(n.fromAddr, domainMap), title: escapeHtml(n.title || `media #${n.refId}`) }),
            time: Number(n.timestamp) * 1000,
            link: `/art?media=${n.refId}`,
            fromAddr: n.fromAddr, refId: n.refId, _who: whoLink(n.fromAddr, domainMap), _title: escapeHtml(n.title || `media #${n.refId}`),
          })
        } else if (n.eventType === 'confirmed') {
          notifications.push({
            type: 'confirm',
            text: t('notifications.confirmNeeded', { project: escapeHtml(n.title || `project #${n.refId}`) }),
            time: Number(n.timestamp) * 1000,
            link: `/project?id=${n.refId}`,
          })
        } else if (n.eventType === 'ticket-purchased') {
          notifications.push({
            type: 'purchase',
            text: t('notifications.mediaPurchased', { who: whoLink(n.fromAddr, domainMap), title: escapeHtml(n.title || 'ticket') }),
            time: Number(n.timestamp) * 1000,
            link: '/collection',
            fromAddr: n.fromAddr, refId: n.refId, _who: whoLink(n.fromAddr, domainMap), _title: escapeHtml(n.title || 'ticket'), _ticketPurchase: true,
          })
        } else if (n.eventType === 'completed') {
          notifications.push({
            type: 'completed',
            text: t('notifications.completed', { who: whoLink(n.fromAddr, domainMap), title: escapeHtml(n.title || `project #${n.refId}`) }),
            time: Number(n.timestamp) * 1000,
            link: `/project?id=${n.refId}`,
          })
        } else if (n.eventType === 'cancelled') {
          notifications.push({
            type: 'cancelled',
            text: t('notifications.cancelled', { title: escapeHtml(n.title || `project #${n.refId}`) }),
            time: Number(n.timestamp) * 1000,
            link: `/project?id=${n.refId}`,
          })
        } else if (n.eventType === 'reply') {
          notifications.push({
            type: 'reply',
            text: t('notifications.reply', { who: whoLink(n.fromAddr, domainMap) }),
            time: Number(n.timestamp) * 1000,
            link: `/post?id=${n.refId}`,
          })
        } else if (n.eventType === 'invite-used') {
          notifications.push({
            type: 'invite-used',
            text: t('notifications.inviteUsed', { who: whoLink(n.fromAddr, domainMap) }),
            time: Number(n.timestamp) * 1000,
            link: `/network?artist=${n.fromAddr.toLowerCase()}`,
          })
        } else if (n.eventType === 'disputed') {
          notifications.push({
            type: 'disputed',
            text: t('notifications.disputed', { who: whoLink(n.fromAddr, domainMap), title: escapeHtml(n.title || `project #${n.refId}`) }),
            time: Number(n.timestamp) * 1000,
            link: `/project?id=${n.refId}`,
          })
        } else if (n.eventType === 'completing') {
          notifications.push({
            type: 'completing',
            text: t('notifications.completing', { title: escapeHtml(n.title || `project #${n.refId}`) }),
            time: Number(n.timestamp) * 1000,
            link: `/project?id=${n.refId}`,
          })
        } else if (n.eventType === 'revenue') {
          const amt = formatEthAmount(n.amount)
          notifications.push({
            type: 'revenue',
            text: t('notifications.revenueReceived', { amount: amt, title: escapeHtml(n.title || `project #${n.refId}`) }),
            time: Number(n.timestamp) * 1000,
            link: `/project?id=${n.refId}`,
          })
        } else if (n.eventType === 'referral_paid') {
          const referredDomain = resolve(n.fromAddr)
          const amt = n.amount ? formatEthAmount(n.amount) : ''
          notifications.push({
            type: 'referral',
            text: `${escapeHtml(referredDomain)} joined via your invite${amt ? ` — you earned ${amt}` : ''}`,
            time: Number(n.timestamp) * 1000,
            link: `/network`,
          })
        } else if (n.eventType === 'mention') {
          notifications.push({
            type: 'mention',
            text: `${whoLink(n.fromAddr, domainMap)} mentioned you in <a href="/post?id=${encodeURIComponent(n.refId)}" style="color:var(--accent)">${escapeHtml(n.title || 'a post')}</a>`,
            time: Number(n.timestamp) * 1000,
            link: `/post?id=${n.refId}`,
          })
        } else if (n.eventType === 'sponsored-invite-redeemed') {
          const inviteeDomain = resolve(n.fromAddr)
          notifications.push({
            type: 'sponsored-invite-redeemed',
            text: `${escapeHtml(inviteeDomain)} joined using your sponsored invite`,
            time: Number(n.timestamp) * 1000,
            link: `/network`,
          })
        }
      }
    }
  } catch (e) {
    // Fallback: direct Ponder queries if server endpoint fails
    console.warn('notifications: server endpoint failed, falling back to Ponder queries:', e?.message)
    try {
      await _loadNotificationsPonder(notifications, myAddr, myAddrLower)
    } catch (e2) {
      console.warn('notifications: fallback load failed', e2)
    }
  }

  // Run all three supplementary checks in parallel (unclaimed funds, collab invites, project confirmations)
  await Promise.all([
    // Unclaimed funds — always check on-chain (not in Ponder notification table).
    // Cached 5 minutes to avoid hammering Scroll RPC on every 30s poll.
    (async () => {
      try {
        const pendingKey = `pendingWithdrawals:${myAddrLower}`
        let pending = _onchainCacheGet(pendingKey)
        if (pending === undefined) {
          pending = await getPendingWithdrawals(myAddr)
          _onchainCacheSet(pendingKey, pending)
        }
        if (pending.praxis > 0n) {
          notifications.push({
            type: 'unclaimed',
            text: `<span data-eth-wei="${String(pending.praxis)}" data-fiat-primary="true">${formatEthAmount(pending.praxis)} ETH</span> unclaimed from projects`,
            time: 0,
            link: '/earnings',
            _persistent: true,
          })
        }
        if (pending.media > 0n) {
          const mediaTitles = notifications.filter(n => n.type === 'purchase' && n._title).map(n => n._title)
          const source = mediaTitles.length > 0 ? `media sales (${mediaTitles.slice(0, 3).join(', ')})` : 'media sales'
          notifications.push({
            type: 'unclaimed',
            text: `<span data-eth-wei="${String(pending.media)}" data-fiat-primary="true">${formatEthAmount(pending.media)} ETH</span> unclaimed from ${escapeHtml(source)}`,
            time: 0,
            link: '/earnings',
            _persistent: true,
          })
        }
      } catch (e) { console.warn('notifications: pendingWithdrawals check failed', e) }
    })(),

    // Collaboration invites + dismissal notifications — off-chain, stored in shared SQLite
    (async () => {
      try {
        const collabRes = await fetch(`/api/collaborations?wallet=${myAddrLower}`)
        if (collabRes.ok) {
          const collabs = await collabRes.json()
          // Pending invites (for collaborator)
          const pendingCollabs = collabs.filter(c => c.to === myAddrLower && c.status === 'pending')
          for (const c of pendingCollabs) {
            notifications.push({
              type: 'collaboration',
              text: `<a href="https://${escapeHtml(c.fromDomain)}" target="_blank" style="color:var(--accent)">${escapeHtml(c.fromDomain)}</a> tagged you as collaborator on <strong>${escapeHtml(c.itemTitle)}</strong>`,
              time: new Date(c.createdAt).getTime() || Date.now(),
              link: '/works',
              _collabId: c.id,
            })
          }
          // Dismissed collabs — show notifications to the other party
          const dismissed = collabs.filter(c => c.status === 'dismissed' && c.dismissedBy)
          for (const c of dismissed) {
            const updatedTime = new Date(c.updatedAt).getTime() || Date.now()
            if (c.dismissedBy === 'collaborator' && c.from === myAddrLower) {
              notifications.push({
                type: 'collab-removed',
                text: `<a href="https://${escapeHtml(c.toDomain)}" target="_blank" style="color:var(--accent)">${escapeHtml(c.toDomain)}</a> removed your collaboration on <strong>${escapeHtml(c.itemTitle)}</strong> from their site`,
                time: updatedTime,
                link: '/works',
              })
            } else if (c.dismissedBy === 'creator' && c.to === myAddrLower) {
              notifications.push({
                type: 'collab-removed',
                text: `<a href="https://${escapeHtml(c.fromDomain)}" target="_blank" style="color:var(--accent)">${escapeHtml(c.fromDomain)}</a> removed you as collaborator on <strong>${escapeHtml(c.itemTitle)}</strong>`,
                time: updatedTime,
                link: '/works',
              })
            }
          }
        }
      } catch (e) { console.warn('notifications: collaboration check failed', e) }
    })(),

    // Org invites — pending on-chain invitations to join an organization
    (async () => {
      try {
        const invRes = await fetch(`/api/orgs/invites/${myAddrLower}`)
        if (invRes.ok) {
          const invData = await invRes.json()
          const pending = (invData.invites || []).filter(i => i.status === 'pending')
          for (const inv of pending) {
            notifications.push({
              type: 'org-invite',
              text: `<strong>${escapeHtml(inv.orgName || `org #${inv.orgId}`)}</strong> invited you to join`,
              time: Number(inv.invitedAt) * 1000 || Date.now(),
              link: `/org?id=${inv.orgId}`,
              _orgId: String(inv.orgId),
            })
          }
        }
      } catch (e) { console.warn('notifications: org invite check failed', e) }
    })(),

    // Projects needing confirmation — requires on-chain multicall (not in notification table)
    // MyCollabs -> CollabProjects are sequential (second depends on first), but run in parallel with the above
    (async () => {
      try {
        const collabsData = await query(`query MyCollabs($me: String!) { collaborators(where: { artist: $me }, limit: 50) { items { ${F.collaborator} } } }`, { me: myAddrLower })
        const myCollabs = collabsData.collaborators?.items || []
        if (myCollabs.length) {
          const collabProjectIds = myCollabs.map(c => c.projectId)
          const collabProjectsData = await query(
            `query CollabProjects($ids: [BigInt!]!) { projects(where: { id_in: $ids }, limit: 50) { items { ${F.projectSummary} } } }`,
            { ids: collabProjectIds }
          )
          const needsConfirm = (collabProjectsData.projects?.items || []).filter(p => p.status === 1 || p.status === 2)
          if (needsConfirm.length) {
            // Split into cached vs uncached so we only hit RPC for misses.
            const uncachedIdxs = []
            const cachedResults = new Array(needsConfirm.length)
            for (let i = 0; i < needsConfirm.length; i++) {
              const k = `hasConfirmed:${needsConfirm[i].id}:${myAddrLower}`
              const hit = _onchainCacheGet(k)
              if (hit !== undefined) cachedResults[i] = hit
              else uncachedIdxs.push(i)
            }
            let freshResults = []
            if (uncachedIdxs.length > 0) {
              const pc = await getPublicClient()
              const confirmCalls = uncachedIdxs.map(i => ({
                address: PRAXIS_ADDR,
                abi: PRAXIS_ABI,
                functionName: 'hasConfirmed',
                args: [BigInt(needsConfirm[i].id), myAddr],
              }))
              freshResults = await pc.multicall({ contracts: confirmCalls, allowFailure: true })
              for (let j = 0; j < uncachedIdxs.length; j++) {
                const idx = uncachedIdxs[j]
                const r = freshResults[j]
                if (r.status === 'success') {
                  const k = `hasConfirmed:${needsConfirm[idx].id}:${myAddrLower}`
                  _onchainCacheSet(k, r)
                  cachedResults[idx] = r
                } else {
                  cachedResults[idx] = r
                }
              }
            }
            const results = cachedResults
            for (let i = 0; i < needsConfirm.length; i++) {
              const r = results[i]
              if (r && r.status === 'success' && !r.result) {
                notifications.push({
                  type: 'confirm',
                  text: t('notifications.confirmNeeded', { project: escapeHtml(needsConfirm[i].title) }),
                  time: 0,
                  link: `/project?id=${needsConfirm[i].id}`,
                  _persistent: true,
                })
              }
            }
          }
        }
      } catch (e) { console.warn('notifications: collab confirmation check failed', e) }
    })(),
  ])

  // sort newest first, then aggregate
  notifications.sort((a, b) => b.time - a.time)
  const aggregated = aggregateNotifications(notifications)
  notifications.length = 0
  notifications.push(...aggregated)

  // cache
  try {
    sessionStorage.setItem(NOTIF_CACHE_KEY, JSON.stringify({
      data: notifications,
      timestamp: Date.now(),
      addr: myAddrLower,
    }))
  } catch {}

  return notifications
}

// Fallback: load notifications from direct Ponder queries (used when /api/notifications fails)
async function _loadNotificationsPonder(notifications, myAddr, myAddrLower) {
  const addressesToResolve = []

  // H7: Run all queries in parallel (fundings + purchases alongside initial 3)
  const [projectsData, followsData, myMediaData] = await Promise.all([
    query(`query MyProjects($me: String!) { projects(where: { proposer: $me }, limit: 50, orderBy: "createdAt", orderDirection: "desc") { items { ${F.projectSummary} } } }`, { me: myAddrLower }),
    query(`query MyFollowers($me: String!) { follows(where: { followed: $me }, limit: 10, orderBy: "timestamp", orderDirection: "desc") { items { ${F.followIn} timestamp } } }`, { me: myAddrLower }),
    query(`query MyMedia($me: String!) { mediaListings(where: { artist: $me }, limit: 50) { items { ${F.mediaListing} } } }`, { me: myAddrLower }),
  ])

  const myProjects = projectsData.projects?.items || []
  const projectIds = myProjects.map(p => p.id)
  const projectTitleMap = {}
  for (const p of myProjects) projectTitleMap[String(p.id)] = p.title

  const myMedia = myMediaData.mediaListings?.items || []
  const mediaTitleMap = {}
  const mediaIds = myMedia.map(m => m.id)
  for (const m of myMedia) mediaTitleMap[String(m.id)] = m.title

  // Run fundings + purchases in parallel
  const [fundingsResult, purchasesResult] = await Promise.all([
    projectIds.length
      ? query(`query RecentFundings($ids: [BigInt!]!) { fundings(where: { projectId_in: $ids }, limit: 20, orderBy: "blockNumber", orderDirection: "desc") { items { ${F.fundingFull} } } }`, { ids: projectIds }).catch(e => { console.warn('notifications: fundings query failed', e); return null })
      : Promise.resolve(null),
    myMedia.length
      ? query(`query MediaPurchases($ids: [BigInt!]!) { mediaPurchases(where: { mediaId_in: $ids }, limit: 10, orderBy: "timestamp", orderDirection: "desc") { items { ${F.mediaPurchase} } } }`, { ids: mediaIds }).catch(e => { console.warn('notifications: media purchases query failed', e); return null })
      : Promise.resolve(null),
  ])

  const fundingsItems = fundingsResult?.fundings?.items || []
  for (const f of fundingsItems) addressesToResolve.push(f.funder)

  const followers = followsData.follows?.items || []
  for (const f of followers) addressesToResolve.push(f.follower)

  const purchasesItems = purchasesResult?.mediaPurchases?.items || []
  for (const p of purchasesItems) addressesToResolve.push(p.buyer)

  const domainMap = await resolveAddresses(query, addressesToResolve).catch(() => ({}))
  const resolve = (addr) => resolveDomain(domainMap, addr)

  for (const f of fundingsItems) {
    if (f.funder.toLowerCase() !== myAddrLower && !isBlocked(f.funder)) {
      const title = projectTitleMap[String(f.projectId)] || `project #${f.projectId}`
      const amt = formatEthAmount(f.amount)
      const funderName = escapeHtml(resolve(f.funder))
      const funderLink = `<a href="/network?artist=${f.funder.toLowerCase()}" style="color:var(--accent)">${funderName}</a>`
      notifications.push({
        type: 'funding',
        text: t('notifications.funded', { who: funderLink, amount: amt, project: escapeHtml(title) }),
        time: f.timestamp ? Number(f.timestamp) * 1000 : Date.now(),
        link: `/project?id=${f.projectId}`,
        fromAddr: f.funder, refId: f.projectId, _who: funderLink, _project: escapeHtml(title),
      })
    }
  }

  for (const f of followers) {
    if (isBlocked(f.follower)) continue
    const name = escapeHtml(resolve(f.follower))
    const profileLink = `<a href="/network?artist=${f.follower.toLowerCase()}" style="color:var(--accent)">${name}</a>`
    notifications.push({
      type: 'follower',
      text: t('notifications.newFollower', { who: profileLink }),
      time: Number(f.timestamp) * 1000,
      link: `/network?artist=${f.follower.toLowerCase()}`,
      fromAddr: f.follower, _who: profileLink,
    })
  }

  for (const p of purchasesItems) {
    if (p.buyer.toLowerCase() !== myAddrLower && !isBlocked(p.buyer)) {
      const title = mediaTitleMap[String(p.mediaId)] || `media #${p.mediaId}`
      const buyerName = escapeHtml(resolve(p.buyer))
      const buyerLink = `<a href="/network?artist=${p.buyer.toLowerCase()}" style="color:var(--accent)">${buyerName}</a>`
      notifications.push({
        type: 'purchase',
        text: t('notifications.mediaPurchased', { who: buyerLink, title: escapeHtml(title) }),
        time: Number(p.timestamp) * 1000,
        link: '/works',
        fromAddr: p.buyer, refId: p.mediaId, _who: buyerLink, _title: escapeHtml(title),
      })
    }
  }
}

/** Aggregate similar notifications within 24h windows */
function aggregateNotifications(items) {
  const DAY = 86400000
  const groups = new Map()

  for (const n of items) {
    let key = null
    if (n.type === 'follower') key = 'follow'
    else if (n.type === 'funding' && n.refId != null) key = `funding:${n.refId}`
    else if (n.type === 'purchase' && n.refId != null && !n._ticketPurchase) key = `purchase:${n.refId}`
    else if (n.type === 'purchase' && n._ticketPurchase && n.refId != null) key = `ticket-purchased:${n.refId}`

    if (!key) { continue }

    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(n)
  }

  // Build set of items to remove (grouped into a representative)
  const remove = new Set()
  const additions = []

  for (const [, members] of groups) {
    if (members.length < 2) continue

    // Sort newest first (items are already sorted, but be safe)
    members.sort((a, b) => b.time - a.time)

    // Sub-group by 24h windows
    let windowStart = members[0].time
    let window = [members[0]]

    const flush = () => {
      if (window.length >= 2) {
        const rep = { ...window[0] }
        const others = window.slice(1).map(m => m.fromAddr).filter(Boolean)
        const uniqueOthers = [...new Set(others)]
        rep.group = { count: window.length - 1, others: uniqueOthers }

        // Build aggregated text
        const who = rep._who || ''
        const countLabel = rep.group.count === 1 ? '1 other' : `${rep.group.count} others`
        if (rep.type === 'follower') {
          rep.text = t('notifications.followedAgg', { who, count: countLabel })
        } else if (rep.type === 'funding') {
          rep.text = t('notifications.fundedAgg', { who, count: countLabel, project: rep._project || '' })
        } else if (rep.type === 'purchase') {
          rep.text = t('notifications.purchasedAgg', { who, count: countLabel, title: rep._title || '' })
        }

        for (const m of window) remove.add(m)
        additions.push(rep)
      }
    }

    for (let i = 1; i < members.length; i++) {
      if (windowStart - members[i].time <= DAY) {
        window.push(members[i])
      } else {
        flush()
        windowStart = members[i].time
        window = [members[i]]
      }
    }
    flush()
  }

  // Rebuild: keep non-removed items, insert aggregated representatives
  const result = items.filter(n => !remove.has(n))
  for (const a of additions) result.push(a)
  result.sort((a, b) => b.time - a.time)
  return result
}

function getUnreadCount(notifications) {
  const lastSeen = getLastSeen()
  return notifications.filter(n => n.time > lastSeen && !n._persistent).length
}

function updateBadge(count) {
  const badge = document.getElementById('notif-badge')
  if (!badge) return
  if (count > 0) {
    badge.textContent = count > 99 ? '99+' : String(count)
    badge.style.display = ''
  } else {
    badge.style.display = 'none'
  }
}

const NOTIF_ICONS = {
  funding: '$',
  confirm: '!',
  unclaimed: '+',
  collaboration: '⊕',
  'collab-removed': '⊖',
  'org-invite': '⊕',
  follower: '~',
  purchase: '*',
  completed: '!',
  cancelled: 'x',
  reply: '>',
  'invite-used': '+',
  mention: '@',
  'sponsored-invite-redeemed': '+',
  referral: '+',
  disputed: '?',
  completing: '.',
  revenue: '$',
}


function renderNotificationsPage(contentEl, notifications) {
  if (notifications.length === 0) {
    contentEl.innerHTML = `<p style="color:var(--muted)">${t('notifications.empty')}</p>`
    return
  }

  const lastSeen = getLastSeen()
  contentEl.innerHTML = notifications.map(n => {
    const unread = n.time > lastSeen ? ' notif-unread' : ''
    const icon = NOTIF_ICONS[n.type] || '.'
    let action = ''
    if (n.type === 'unclaimed') {
      const source = n.text.includes('media') ? 'media' : 'projects'
      action = `<button class="buy-btn notif-claim-btn" data-source="${source}" style="font-size:0.75em;padding:0.2em 0.8ch">claim</button>`
    } else if (n.type === 'collaboration' && n._collabId) {
      action = `<span style="display:flex;gap:0.3ch"><button class="buy-btn notif-collab-btn" data-collab-id="${escapeHtml(n._collabId)}" data-action="accepted" style="font-size:0.75em;padding:0.2em 0.8ch">accept</button><button class="notif-collab-btn" data-collab-id="${escapeHtml(n._collabId)}" data-action="dismissed" style="background:none;border:1px solid var(--border);color:var(--dim);font-family:inherit;font-size:0.75em;padding:0.2em 0.8ch;cursor:pointer">dismiss</button></span>`
    } else if (n.type === 'org-invite' && n._orgId) {
      action = `<span style="display:flex;gap:0.3ch"><button class="buy-btn notif-org-invite-btn" data-org-id="${escapeHtml(n._orgId)}" data-action="accept" style="font-size:0.75em;padding:0.2em 0.8ch">accept</button><button class="notif-org-invite-btn" data-org-id="${escapeHtml(n._orgId)}" data-action="decline" style="background:none;border:1px solid var(--border);color:var(--dim);font-family:inherit;font-size:0.75em;padding:0.2em 0.8ch;cursor:pointer">decline</button></span>`
    } else if (n.type === 'confirm') {
      action = `<a href="${n.link}" style="color:var(--accent);font-size:0.8em;white-space:nowrap;font-weight:bold">confirm</a>`
    } else if (n.link) {
      action = `<a href="${n.link}" style="color:var(--muted);font-size:0.8em;white-space:nowrap">view</a>`
    }
    return `<div class="notif-page-row${unread}" style="display:flex;align-items:center;gap:1ch;padding:0.75em 0;border-bottom:1px solid var(--border)">
      <span class="notif-icon" style="color:var(--muted);font-family:monospace;white-space:nowrap;width:1.5ch;text-align:center">${icon}</span>
      <span class="notif-text" style="flex:1">${n.text}</span>
      <span class="notif-time" style="color:var(--dim);font-size:0.8em;white-space:nowrap">${timeAgo(n.time)}</span>
      ${action}
    </div>`
  }).join('')

  // Convert ETH amounts to fiat display
  import('./fiat.js').then(({ enhanceEthLabels }) => enhanceEthLabels(contentEl)).catch(() => {})

  // claim buttons
  contentEl.querySelectorAll('.notif-claim-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.textContent = 'claiming...'
      btn.disabled = true
      try {
        if (btn.dataset.source === 'media') {
          const { withdrawEarnings } = await import('./media.js')
          await withdrawEarnings()
        } else {
          // Praxis project claims go to the project detail page
          window.location.href = '/projects'
          return
        }
        btn.textContent = 'claimed'
        btn.disabled = true
        btn.style.opacity = '0.5'
        btn.style.borderColor = 'var(--accent)'
        btn.style.color = 'var(--accent)'
        btn.style.cursor = 'default'
        // Invalidate on-chain cache so refresh shows 0 unclaimed
        const myAddr = window.getWalletAddress?.()?.toLowerCase()
        if (myAddr) _onchainCache.delete(`pendingWithdrawals:${myAddr}`)
        // Refresh header balance after claim
        window.dispatchEvent(new CustomEvent('wallet-balance-changed'))
      } catch (e) {
        btn.textContent = e.code === 4001 ? 'cancelled' : 'error'
        btn.disabled = false
        setTimeout(() => { btn.textContent = 'claim' }, 2000)
      }
    })
  })

  // collaboration accept/dismiss buttons
  contentEl.querySelectorAll('.notif-collab-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const collabId = btn.dataset.collabId
      const action = btn.dataset.action // 'accepted' or 'dismissed'
      const origText = btn.textContent
      btn.textContent = action === 'accepted' ? 'accepting...' : 'dismissing...'
      btn.disabled = true
      // Also disable the sibling button
      const sibling = btn.parentElement?.querySelector(`.notif-collab-btn:not([data-action="${action}"])`)
      if (sibling) sibling.disabled = true
      try {
        const token = await getAuthToken()
        if (!token) throw new Error('auth failed')
        const resp = await fetch(`/api/collaborations/${collabId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ status: action }),
        })
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}))
          throw new Error(err.error || 'failed')
        }
        // Remove the entire notification row
        const row = btn.closest('.notif-page-row')
        if (row) row.remove()
      } catch (e) {
        btn.textContent = e.message || 'error'
        btn.disabled = false
        if (sibling) sibling.disabled = false
        setTimeout(() => { btn.textContent = origText }, 2000)
      }
    })
  })

  // org invite accept/decline buttons
  contentEl.querySelectorAll('.notif-org-invite-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const orgId = btn.dataset.orgId
      const action = btn.dataset.action
      const origText = btn.textContent
      const sibling = btn.parentElement?.querySelector(`.notif-org-invite-btn:not([data-action="${action}"])`)
      btn.textContent = action === 'accept' ? 'accepting...' : 'declining...'
      btn.disabled = true
      if (sibling) sibling.disabled = true
      try {
        if (!await window.ensureOptimism?.()) throw new Error('wallet not connected')
        const { createWalletClient, custom, optimism } = await import('./vendor.js')
        const { ORG_ADDRESS, ORG_ABI } = await import('./contracts.js')
        const addr = window.getWalletAddress?.()
        const wc = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })
        const hash = await wc.writeContract({
          address: ORG_ADDRESS, abi: ORG_ABI,
          functionName: action === 'accept' ? 'acceptInvite' : 'declineInvite',
          args: [BigInt(orgId)], account: addr,
        })
        const pc = await getPublicClient()
        await pc.waitForTransactionReceipt({ hash })
        const row = btn.closest('.notif-page-row')
        if (row) row.remove()
        try { sessionStorage.removeItem(NOTIF_CACHE_KEY) } catch {}
      } catch (e) {
        btn.textContent = e.code === 4001 ? 'cancelled' : (e.message || 'error')
        btn.disabled = false
        if (sibling) sibling.disabled = false
        setTimeout(() => { btn.textContent = origText }, 2000)
      }
    })
  })

  // mark as seen
  setLastSeen(Math.max(...notifications.map(n => n.time)))
  updateBadge(0)
}

function renderPanel(notifications) {
  if (notifPanel) { notifPanel.remove(); notifPanel = null; return }

  notifPanel = document.createElement('div')
  notifPanel.className = 'notif-panel'
  notifPanel.innerHTML = `<div class="notif-header">${t('notifications.title')}</div>`

  if (notifications.length === 0) {
    // Use appendChild to avoid re-parsing the entire panel HTML (which breaks listeners)
    const empty = document.createElement('div')
    empty.className = 'notif-empty'
    empty.textContent = t('notifications.empty')
    notifPanel.appendChild(empty)
  } else {
    const lastSeen = getLastSeen()
    for (const n of notifications) {
      const unread = n.time > lastSeen ? ' notif-unread' : ''
      const icon = NOTIF_ICONS[n.type] || '.'
      if (n.type === 'org-invite' && n._orgId) {
        const row = document.createElement('div')
        row.className = `notif-item${unread}`
        row.style.cssText = 'display:flex;align-items:center;gap:0.5ch;justify-content:space-between'
        row.innerHTML = `<span><span class="notif-icon" style="color:var(--muted);font-family:monospace;margin-right:0.5ch;width:1.5ch;display:inline-block;text-align:center">${icon}</span><span class="notif-text">${n.text}</span></span><span style="display:flex;gap:0.3ch;flex-shrink:0"><button class="buy-btn panel-org-btn" data-org-id="${escapeHtml(n._orgId)}" data-action="accept" style="font-size:0.7em;padding:0.15em 0.6ch">accept</button><button class="panel-org-btn" data-org-id="${escapeHtml(n._orgId)}" data-action="decline" style="background:none;border:1px solid var(--border);color:var(--dim);font-family:inherit;font-size:0.7em;padding:0.15em 0.6ch;cursor:pointer">decline</button></span>`
        notifPanel.appendChild(row)
      } else {
        const item = document.createElement('a')
        item.className = `notif-item${unread}`
        item.href = n.link || '#'
        item.innerHTML = `<span class="notif-icon" style="color:var(--muted);font-family:monospace;margin-right:0.5ch;width:1.5ch;display:inline-block;text-align:center">${icon}</span><span class="notif-text">${n.text}</span>`
        notifPanel.appendChild(item)
      }
    }
    // Wire org invite buttons in panel
    notifPanel.querySelectorAll('.panel-org-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation()
        const orgId = btn.dataset.orgId
        const action = btn.dataset.action
        const origText = btn.textContent
        const sibling = btn.parentElement?.querySelector(`.panel-org-btn:not([data-action="${action}"])`)
        btn.textContent = '...'
        btn.disabled = true
        if (sibling) sibling.disabled = true
        try {
          if (!await window.ensureOptimism?.()) throw new Error('wallet not connected')
          const { createWalletClient, custom, optimism } = await import('./vendor.js')
          const { ORG_ADDRESS, ORG_ABI } = await import('./contracts.js')
          const addr = window.getWalletAddress?.()
          const wc = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })
          const hash = await wc.writeContract({
            address: ORG_ADDRESS, abi: ORG_ABI,
            functionName: action === 'accept' ? 'acceptInvite' : 'declineInvite',
            args: [BigInt(orgId)], account: addr,
          })
          const pc = await getPublicClient()
          await pc.waitForTransactionReceipt({ hash })
          btn.closest('.notif-item')?.remove()
          try { sessionStorage.removeItem(NOTIF_CACHE_KEY) } catch {}
        } catch (e) {
          btn.textContent = e.code === 4001 ? 'x' : '!'
          btn.disabled = false
          if (sibling) sibling.disabled = false
          setTimeout(() => { btn.textContent = origText }, 2000)
        }
      })
    })
  }

  // mark as seen
  if (notifications.length) {
    setLastSeen(Math.max(...notifications.map(n => n.time)))
  }
  updateBadge(0)

  // position near bell
  const bell = document.getElementById('top-notifications')
  if (bell) {
    bell.parentElement.style.position = 'relative'
    bell.parentElement.appendChild(notifPanel)
  } else {
    document.body.appendChild(notifPanel)
  }

  // L19: close on outside click — store handler ref and remove on spa-navigate
  const closeHandler = (e) => {
    if (notifPanel && !notifPanel.contains(e.target) && !e.target.closest('#top-notifications')) {
      notifPanel.remove()
      notifPanel = null
      document.removeEventListener('click', closeHandler)
    }
  }
  setTimeout(() => {
    document.addEventListener('click', closeHandler)
  }, 10)
  // clean up on SPA navigation to prevent listener leak
  const navCleanup = () => {
    document.removeEventListener('click', closeHandler)
    window.removeEventListener('spa-navigate', navCleanup)
    if (notifPanel) { notifPanel.remove(); notifPanel = null }
  }
  window.addEventListener('spa-navigate', navCleanup)
}

async function initNotifications(myAddr) {
  const notifPage = document.getElementById('notifications-page')

  if (notifPage) {
    // on /notifications page: do full load
    currentNotifications = await loadNotifications(myAddr)
    updateBadge(getUnreadCount(currentNotifications))
    const contentEl = document.getElementById('notifications-content')
    if (contentEl) renderNotificationsPage(contentEl, currentNotifications)
  } else {
    // on other pages: just update badge count from cache or lightweight check
    // check sessionStorage cache
    let cached = null
    try {
      const raw = sessionStorage.getItem(NOTIF_CACHE_KEY)
      if (raw) {
        const { addr, data, timestamp } = JSON.parse(raw)
        if (addr === myAddr.toLowerCase() && Date.now() - timestamp < NOTIF_CACHE_TTL) cached = data
      }
    } catch {}
    if (cached) {
      currentNotifications = cached
      updateBadge(getUnreadCount(cached))
    } else {
      // no cache: lightweight check — full load only on /notifications page
      try {
        let count = 0
        const pending = await getPendingWithdrawals(myAddr)
        if (pending && (pending.praxis > 0n || pending.media > 0n)) count++
        // quick follow count from server endpoint (1 query, not 7)
        try {
          const res = await fetch(`/api/notifications?addr=${myAddr.toLowerCase()}&limit=10`)
          if (res.ok) {
            const data = await res.json()
            // Capture server-side lastSeen for cross-device fallback
            if (typeof data?.lastSeen === 'number' && data.lastSeen > _serverLastSeen) {
              _serverLastSeen = data.lastSeen
            }
            const notifs = Array.isArray(data) ? data : data.notifications || []
            if (notifs.length > 0) {
              const lastSeen = getLastSeen()
              count += notifs.filter(n => {
                const t = n.time || (Number(n.timestamp) * 1000)
                return t > lastSeen
              }).length
            }
          }
        } catch {}
        updateBadge(count)
      } catch {}
    }
  }
}

// --- Background polling ---
// Poll /api/notifications every 30s while the user is signed in and the tab is
// visible. On new events, update the badge, refresh currentNotifications, and
// re-render the /notifications page or open panel in place. This fixes the
// "friend followed me but the /notifications panel didn't update until I
// refreshed" bug. Gated by document.visibilityState so hidden tabs don't waste
// requests, and bypasses the 2-minute session cache by invalidating it before
// each poll.
const POLL_INTERVAL_MS = 30_000
let _pollTimer = null

async function pollOnce(myAddr) {
  try {
    // Invalidate the sessionStorage cache so loadNotifications actually hits
    // the server instead of returning stale data.
    try { sessionStorage.removeItem(NOTIF_CACHE_KEY) } catch {}
    const fresh = await loadNotifications(myAddr)
    // Detect actually-new items (beyond what we already have)
    const prevIds = new Set(currentNotifications.map(n => `${n.type}:${n.fromAddr || ''}:${n.refId || ''}:${n.time}`))
    const newOnes = fresh.filter(n => !prevIds.has(`${n.type}:${n.fromAddr || ''}:${n.refId || ''}:${n.time}`))
    currentNotifications = fresh
    updateBadge(getUnreadCount(fresh))
    if (newOnes.length > 0) {
      // Refresh the /notifications page in place if mounted
      const contentEl = document.getElementById('notifications-content')
      if (contentEl) renderNotificationsPage(contentEl, fresh)
      // Refresh the open bell panel if mounted (only when actually open — the
      // panel variable is nulled when closed, so presence means it's visible).
      if (notifPanel && notifPanel.isConnected) {
        notifPanel.remove()
        notifPanel = null
        renderPanel(fresh)
      }
    }
  } catch {}
}

function startNotifPolling(myAddr) {
  stopNotifPolling()
  const tick = () => {
    if (document.visibilityState !== 'visible') return
    if (!window.getWalletAddress?.()) return
    pollOnce(myAddr)
  }
  _pollTimer = setInterval(tick, POLL_INTERVAL_MS)
  // Also poll immediately when the tab becomes visible after being hidden,
  // so returning to the tab shows fresh state without waiting up to 30s.
  // Guarded by _visTickBound so rapid wallet-connected events (cross-subdomain
  // restore, multi-tab) don't stack duplicate listeners.
  if (!_visTickBound) {
    document.addEventListener('visibilitychange', _visTick)
    _visTickBound = true
  }
  // Kick an immediate poll so the badge updates right away — waiting up to 30s
  // for the first poll after sign-in felt broken.
  if (document.visibilityState === 'visible') {
    pollOnce(myAddr)
  }
}

function stopNotifPolling() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null }
  if (_visTickBound) {
    document.removeEventListener('visibilitychange', _visTick)
    _visTickBound = false
  }
}

function _visTick() {
  if (document.visibilityState !== 'visible') return
  const a = window.getWalletAddress?.()
  if (a) pollOnce(a)
}

// listen for wallet connect
window.addEventListener('wallet-connected', (e) => {
  const addr = e.detail?.address
  if (addr) {
    // wait a tick for dock to render
    setTimeout(() => initNotifications(addr), 100)
    startNotifPolling(addr)
  }
})

// on disconnect, clear
window.addEventListener('wallet-disconnected', () => {
  currentNotifications = []
  updateBadge(0)
  if (notifPanel) { notifPanel.remove(); notifPanel = null }
  try { sessionStorage.removeItem(NOTIF_CACHE_KEY) } catch {}
  stopNotifPolling()
})

// re-init on SPA navigation (e.g. navigating to /notifications)
window.addEventListener('spa-navigate', () => {
  const a = window.getWalletAddress?.()
  if (a) {
    const notifPage = document.getElementById('notifications-page')
    if (notifPage) {
      // re-render into page with cached notifications
      const contentEl = document.getElementById('notifications-content')
      if (contentEl && currentNotifications.length > 0) {
        renderNotificationsPage(contentEl, currentNotifications)
      } else if (contentEl) {
        initNotifications(a)
      }
    }
  }
})

// if already connected at load time, init + start polling
if (window.getWalletAddress?.()) {
  setTimeout(() => {
    const a = window.getWalletAddress?.()
    if (a) { initNotifications(a); startNotifPolling(a) }
  }, 200)
}
