// Artist profile — shows credentials, projects, posts, connections
// Activated when URL has ?artist= parameter on /network page
import { F } from './fragments.js'
import { query } from './ponder.js'
import { escapeHtml, resolveAddresses, resolveDomain, isBlocked, blockUser, unblockUser, registerPage, getWalletProvider, renderMarkdown } from './utils.js'

// pagination cursors per section
let _credsCursor = null, _credsHasMore = false
let _followsCursor = null, _followsHasMore = false
let _followersCursor = null, _followersHasMore = false
let _postsCursor = null, _postsHasMore = false
let _projectMap = {}
let _domainMap = {}

registerPage('network-data', () => {
  const params = new URLSearchParams(window.location.search)
  const artistAddr = params.get('artist') || params.get('audience')
  if (artistAddr) showProfile(artistAddr.toLowerCase())
}, 'network-data-profile')

async function fetchPage(queryStr, vars, entityName, cursor) {
  const safeCursor = cursor ? cursor.replace(/[^a-zA-Z0-9+/=_-]/g, '') : null
  const afterArg = safeCursor ? `, after: "${safeCursor}"` : ''
  const q = queryStr.replace('__AFTER__', afterArg)
  const data = await query(q, vars)
  return {
    items: data[entityName]?.items || [],
    cursor: data[entityName]?.pageInfo?.endCursor || null,
    hasMore: data[entityName]?.pageInfo?.hasNextPage || false,
  }
}

async function showProfile(addr) {
  const container = document.getElementById('network-list')
  const statusEl = document.getElementById('network-status')
  if (!container || !statusEl) return

  // hide the regular network list
  container.innerHTML = ''
  document.getElementById('register-form')?.remove()
  document.getElementById('load-more-btn')?.remove()

  statusEl.textContent = 'loading profile...'

  // reset pagination state
  _credsCursor = null; _credsHasMore = false
  _followsCursor = null; _followsHasMore = false
  _followersCursor = null; _followersHasMore = false
  _postsCursor = null; _postsHasMore = false
  _projectMap = {}

  try {
    // fetch artist + FIRST PAGE of each section in parallel
    const myAddr = window.getWalletAddress?.()?.toLowerCase()
    const isMe = myAddr === addr

    // fetch artist + supporter + follow check + FIRST PAGE of each section in parallel
    const parallelQueries = [
      query(`
        query Artist($addr: String!) {
          artists(where: { id: $addr }, limit: 1) {
            items { ${F.artistFull} }
          }
        }
      `, { addr }),
      fetchPage(
        `query Creds($addr: String!) { credentials(where: { holder: $addr }, limit: 50__AFTER__) { items { ${F.credential} } ${F.pageInfo} } }`,
        { addr }, 'credentials', null
      ),
      fetchPage(
        `query Follows($addr: String!) { follows(where: { follower: $addr }, limit: 50__AFTER__) { items { ${F.followOut} } ${F.pageInfo} } }`,
        { addr }, 'follows', null
      ),
      fetchPage(
        `query Followers($addr: String!) { follows(where: { followed: $addr }, limit: 50__AFTER__) { items { ${F.followIn} } ${F.pageInfo} } }`,
        { addr }, 'follows', null
      ),
      fetchPage(
        `query Posts($addr: String!) { blogPosts(where: { author: $addr }, orderBy: "timestamp", orderDirection: "desc", limit: 50__AFTER__) { items { ${F.post} } ${F.pageInfo} } }`,
        { addr }, 'blogPosts', null
      ),
      // supporter fallback — run in parallel, use result only if artist not found
      query(`
        query Supporter($addr: String!) {
          supporters(where: { id: $addr }, limit: 1) {
            items { ${F.supporter} }
          }
        }
      `, { addr }).catch(() => ({ supporters: { items: [] } })),
      // follow state check — run in parallel
      (myAddr && !isMe)
        ? query(`
            query FollowCheck($me: String!, $them: String!) {
              follows(where: { follower: $me, followed: $them }, limit: 1) {
                items { follower }
              }
            }
          `, { me: myAddr, them: addr }).catch(() => ({ follows: { items: [] } }))
        : Promise.resolve(null),
    ]

    const [artistData, credsResult, followsResult, followersResult, postsResult, supData, followCheckData] = await Promise.all(parallelQueries)

    _credsCursor = credsResult.cursor; _credsHasMore = credsResult.hasMore
    _followsCursor = followsResult.cursor; _followsHasMore = followsResult.hasMore
    _followersCursor = followersResult.cursor; _followersHasMore = followersResult.hasMore
    _postsCursor = postsResult.cursor; _postsHasMore = postsResult.hasMore

    const allCredentials = credsResult.items
    const allFollows = followsResult.items
    const allFollowers = followersResult.items

    // Filter posts: exclude amendments (refType=5) and replace amended originals
    // with their latest amendment version
    const rawPosts = postsResult.items
    const amendmentsByRef = {}
    for (const p of rawPosts) {
      if (Number(p.refType) === 5 && p.refId) {
        const refKey = String(p.refId)
        if (!amendmentsByRef[refKey] || Number(p.timestamp) > Number(amendmentsByRef[refKey].timestamp)) {
          amendmentsByRef[refKey] = p
        }
      }
    }
    const allPosts = rawPosts
      .filter(p => Number(p.refType) !== 5) // exclude amendment entries
      .map(p => {
        const amended = amendmentsByRef[String(p.id)]
        return amended ? { ...p, title: amended.title, content: amended.content, _amended: true } : p
      })

    let artist = artistData.artists?.items?.[0]
    if (!artist) {
      // use supporter fallback from parallel query
      const sup = supData.supporters?.items?.[0]
      if (sup) {
        artist = { id: sup.id, domain: sup.handle, registeredAt: sup.registeredAt, followerCount: sup.followerCount, followingCount: sup.followingCount, isSupporter: true }
      }
      if (!artist) {
        statusEl.textContent = 'user not found'
        return
      }
    }

    // get project details for credentials (single batch, not paginated loop)
    const projectIds = [...new Set(allCredentials.map(c => c.projectId))]
    if (projectIds.length > 0) {
      try {
        const data = await query(`
          query Projects($ids: [BigInt!]!) {
            projects(where: { id_in: $ids }, limit: 100) {
              items { ${F.projectSummary} }
            }
          }
        `, { ids: projectIds })
        for (const p of (data.projects?.items || [])) {
          _projectMap[p.id] = p
        }
      } catch (e) { console.warn('project details:', e) }
    }

    // resolve domain names for following/followers on demand
    const allAddrs = [
      ...allFollows.map(f => f.followed),
      ...allFollowers.map(f => f.follower),
    ]
    _domainMap = await resolveAddresses(query, allAddrs).catch(() => ({}))

    statusEl.textContent = ''
    const resolve = a => _domainMap[a.toLowerCase()] || `${a.slice(0, 6)}...${a.slice(-4)}`

    // categorize credentials
    const tickets = allCredentials.filter(c => c.tokenType === 1)
    const producerCredits = allCredentials.filter(c => c.tokenType === 2)
    const contributorCredits = allCredentials.filter(c => c.tokenType === 3)

    const PROJECT_TYPES = ['show', 'film', 'theater', 'recording', 'workshop', 'installation', 'other']

    // use follow check result from parallel query
    let isFollowing = false
    if (followCheckData) {
      isFollowing = (followCheckData.follows?.items?.length || 0) > 0
    }
    // check if they follow us (for mutual DM eligibility)
    const theyFollowMe = myAddr ? allFollows.some(f => f.followed.toLowerCase() === myAddr) : false
    const isMutual = isFollowing && theyFollowMe

    // display counts — show "50+" if there might be more
    const followCount = allFollows.length + (_followsHasMore ? '+' : '')
    const followerCount = allFollowers.length + (_followersHasMore ? '+' : '')
    const credCount = producerCredits.length + contributorCredits.length

    const siteUrl = `https://${escapeHtml(artist.domain)}`
    const ogImage = `${siteUrl}/og/index.png`

    let html = `
      <div class="profile">
        <a href="${siteUrl}" target="_blank" style="display:block;margin-bottom:1em;border-radius:8px;overflow:hidden;border:1px solid var(--border);transition:border-color 0.15s;position:relative">
          <img src="${ogImage}" alt="${escapeHtml(artist.domain)}" style="width:100%;display:block" loading="lazy" onerror="this.closest('a').style.display='none'">
        </a>

        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75em">
          <div>
            <a href="${siteUrl}" style="color:var(--fg);font-size:1em;text-decoration:none;font-weight:600">${escapeHtml(artist.domain)}</a>
            <span style="color:var(--dim);font-size:0.7em;margin-left:0.75ch">${addr.slice(0, 6)}...${addr.slice(-4)}</span>
          </div>
          ${!isMe ? `
            <div style="display:flex;gap:0.4ch;align-items:center">
              <button class="profile-btn profile-btn-follow follow-btn${isFollowing ? ' profile-btn-active' : ''}" data-follow-addr="${addr}">${isFollowing ? 'following' : 'follow'}</button>
              ${isMutual ? `<button class="profile-btn profile-btn-dm dm-btn" data-dm-addr="${addr}" data-dm-domain="${escapeHtml(artist.domain)}">dm</button>` : ''}
              <button class="profile-btn profile-btn-block profile-block-btn${isBlocked(addr) ? ' profile-btn-blocked' : ''}" data-block-addr="${addr}">${isBlocked(addr) ? 'unblock' : 'block'}</button>
            </div>
          ` : ''}
        </div>

        <div class="profile-stats" style="margin-bottom:1.5em">
          <span>${followCount} following</span>
          <span class="profile-stats-sep">&middot;</span>
          <span>${followerCount} followers</span>
          <span class="profile-stats-sep">&middot;</span>
          <span>${credCount}${_credsHasMore ? '+' : ''} credentials</span>
        </div>
    `

    // Fetch media listings for content grid
    let mediaItems = []
    try {
      const mediaData = await query(`query ArtistMedia($a: String!) {
        mediaListings(where: { artist: $a }, orderBy: "timestamp", orderDirection: "desc", limit: 6) {
          items { id title ipfsCid metadataCid price }
        }
      }`, { a: addr })
      mediaItems = mediaData?.mediaListings?.items || []
    } catch {}

    // Content grid: posts + media in a unified view
    const hasContent = allPosts.length > 0 || mediaItems.length > 0
    if (hasContent) {
      html += `<div class="profile-section"><h3>activity</h3>`
      html += `<div style="display:grid;grid-template-columns:1fr;gap:0.75em">`
      // Posts as cards
      for (const p of allPosts.slice(0, 4)) {
        html += renderPostCard(p)
      }
      // Media as cards
      for (const m of mediaItems.slice(0, 4)) {
        const thumb = m.metadataCid ? `/api/img?url=${encodeURIComponent('/api/ipfs-proxy/' + m.metadataCid)}&w=400` : ''
        const priceEth = m.price ? (Number(m.price) / 1e18) : 0
        html += `<a href="/art?media=${m.id}" style="display:flex;align-items:center;gap:1ch;padding:0.75em;border:1px solid var(--border);border-radius:6px;text-decoration:none;color:var(--fg);transition:border-color 0.15s">
          ${thumb ? `<img src="${escapeHtml(thumb)}" style="width:48px;height:48px;object-fit:cover;border-radius:4px;flex-shrink:0" loading="lazy" onerror="this.style.display='none'">` : ''}
          <div style="min-width:0">
            <div style="font-size:0.9em;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(m.title)}</div>
            ${priceEth > 0 ? `<div style="font-size:0.75em;color:var(--dim)">${priceEth} ETH</div>` : ''}
          </div>
        </a>`
      }
      html += `</div>`
      if (_postsHasMore || allPosts.length > 4) {
        html += `<button id="profile-load-more-posts" class="profile-btn profile-btn-load" style="margin-top:0.75em">load more</button>`
      }
      html += `</div>`
    }

    // Credentials (compact)
    if (producerCredits.length > 0 || contributorCredits.length > 0) {
      html += `<div class="profile-section" id="profile-credentials"><h3>credentials</h3>`
      html += renderCredentials(contributorCredits, producerCredits, PROJECT_TYPES)
      if (_credsHasMore) {
        html += `<button id="profile-load-more-creds" class="profile-btn profile-btn-load">load more</button>`
      }
      html += `</div>`
    }

    // Connections: collapsed by default, show first 6, expand on click
    if (allFollows.length > 0) {
      const showFollows = allFollows.slice(0, 6)
      const moreFollows = allFollows.length > 6 || _followsHasMore
      html += `<div class="profile-section" id="profile-following"><h3>following <span style="color:var(--dim);font-weight:normal">${followCount}</span></h3><div class="profile-chips">`
      for (const f of showFollows) {
        const domain = resolve(f.followed)
        html += `<a href="/network?artist=${f.followed}" class="profile-chip">${escapeHtml(domain)}</a>`
      }
      html += `</div>`
      if (moreFollows) {
        html += `<button id="profile-load-more-follows" class="profile-btn profile-btn-load">show all</button>`
      }
      html += `</div>`
    }

    if (allFollowers.length > 0) {
      const showFollowers = allFollowers.slice(0, 6)
      const moreFollowers = allFollowers.length > 6 || _followersHasMore
      html += `<div class="profile-section" id="profile-followers"><h3>followers <span style="color:var(--dim);font-weight:normal">${followerCount}</span></h3><div class="profile-chips">`
      for (const f of showFollowers) {
        const domain = resolve(f.follower)
        html += `<a href="/network?artist=${f.follower}" class="profile-chip">${escapeHtml(domain)}</a>`
      }
      html += `</div>`
      if (moreFollowers) {
        html += `<button id="profile-load-more-followers" class="profile-btn profile-btn-load">show all</button>`
      }
      html += `</div>`
    }

    html += `<div class="profile-back"><a href="/network">&larr; back to network</a></div></div>`

    container.innerHTML = html

    // wire up follow button
    container.querySelector('.follow-btn')?.addEventListener('click', async (e) => {
      const btn = e.target.closest('.follow-btn')
      if (!btn) return
      const targetAddr = btn.dataset.followAddr
      if (!targetAddr) return
      // call follow/unfollow on-chain (same logic as network.js toggleFollow)
      const { createWalletClient, custom, optimism, parseEther } = await import('./vendor.js')
      const { getPublicClient, requireUser, getCachedBalance } = await import('./utils.js')
      const userAddr = await requireUser('follow artists')
      if (!userAddr) return
      const registryAddress = window._registryAddress || document.querySelector('[data-registry]')?.dataset?.registry
      if (!registryAddress) return
      const isFollowing = btn.textContent.trim() === 'following'
      // Pre-flight ETH balance check on Optimism: follow tx is cheap but non-zero.
      // Using a hardcoded floor (~0.0005 ETH) avoids an extra estimateGas RPC call.
      // Without this, a zero-balance user gets a confusing wallet error or hanging tx.
      const statusEl = container.querySelector('.follow-status') || btn
      try {
        const GAS_FLOOR = parseEther('0.0005')
        const balance = await getCachedBalance(userAddr)
        if (balance < GAS_FLOOR) {
          // Delegate to the unified funding sheet: handles wallet/chain/balance/onramp.
          const { ensureFundsForPurchase } = await import('./utils.js')
          const ready = await ensureFundsForPurchase(GAS_FLOOR.toString(), statusEl)
          if (!ready) {
            // user cancelled or funding failed — statusEl already has a message
            return
          }
        }
      } catch (balErr) {
        console.warn('follow balance pre-check failed:', balErr?.message)
        // fall through and let the writeContract surface the real error
      }
      try {
        await window.ensureOptimism?.()
        const currentAccount = await window.ensureAuthorized?.() || window.getWalletAddress()
        const walletClient = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })
        const hash = await walletClient.writeContract({
          address: registryAddress,
          abi: [{ name: isFollowing ? 'unfollow' : 'follow', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'target', type: 'address' }], outputs: [] }],
          functionName: isFollowing ? 'unfollow' : 'follow',
          args: [targetAddr],
          account: currentAccount,
        })
        const pc = await getPublicClient()
        await pc.waitForTransactionReceipt({ hash })
        btn.textContent = isFollowing ? 'follow' : 'following'
        btn.classList.toggle('profile-btn-active', !isFollowing)
        // optimistic follower count update in DOM
        const statsEl = container.querySelector('.profile-stats')
        if (statsEl) {
          const followerSpan = [...statsEl.querySelectorAll('span')].find(s => s.textContent.includes('follower'))
          if (followerSpan) {
            const match = followerSpan.textContent.match(/^(\d+)/)
            if (match) {
              const count = parseInt(match[1]) + (isFollowing ? -1 : 1)
              followerSpan.textContent = followerSpan.textContent.replace(/^\d+/, Math.max(0, count))
            }
          }
        }
      } catch (e) {
        if (e.code !== 4001) console.error('follow error:', e)
      }
    })

    // wire up dm button
    container.querySelector('.dm-btn')?.addEventListener('click', (e) => {
      const btn = e.target
      window.dispatchEvent(new CustomEvent('open-dm', { detail: { address: btn.dataset.dmAddr, domain: btn.dataset.dmDomain } }))
    })

    // wire up block button
    container.querySelector('.profile-block-btn')?.addEventListener('click', async (e) => {
      const btn = e.target.closest('.profile-block-btn')
      if (!btn) return
      const targetAddr = btn.dataset.blockAddr
      if (isBlocked(targetAddr)) {
        unblockUser(targetAddr)
        btn.textContent = 'block'
        btn.classList.remove('profile-btn-blocked')
        return
      }
      // gate on sign-in (same pattern as follow button)
      const { requireUser } = await import('./utils.js')
      const userAddr = await requireUser('block users')
      if (!userAddr) return
      // custom confirm modal (matching praxis-modal-overlay pattern)
      const ok = await showBlockConfirmModal()
      if (!ok) return
      blockUser(targetAddr)
      btn.textContent = 'unblock'
      btn.classList.add('profile-btn-blocked')
    })

    // wire up "load more" buttons
    wireLoadMore(container, addr, artist, PROJECT_TYPES, resolve)

  } catch (e) {
    statusEl.textContent = 'could not load profile'
    console.error('profile error:', e)
  }
}

function showBlockConfirmModal() {
  return new Promise((resolve) => {
    // remove any existing dialog
    document.getElementById('block-confirm-dialog')?.remove()

    const overlay = document.createElement('div')
    overlay.id = 'block-confirm-dialog'
    overlay.className = 'praxis-modal-overlay'
    overlay.style.cssText = 'background:rgba(0,0,0,0.7);z-index:9999'

    const dialog = document.createElement('div')
    dialog.className = 'praxis-modal-dialog'
    dialog.style.cssText = 'max-width:400px'
    dialog.innerHTML = `
      <h3 style="color:#ef4444;margin-bottom:1em">block this user?</h3>
      <ul style="color:var(--fg, #c0c0c0);margin:0 0 1.5em 0;padding-left:1.2em;line-height:1.6;font-size:0.9em">
        <li>their messages will be hidden</li>
        <li>they won't appear in your feed or notifications</li>
        <li>they won't be able to message you</li>
      </ul>
      <div style="display:flex;gap:1ch;justify-content:flex-end">
        <button id="block-cancel-btn" style="background:none;border:1px solid var(--border, #333);color:var(--fg, #c0c0c0);font-family:inherit;font-size:0.85em;padding:0.4em 1.5ch;cursor:pointer">cancel</button>
        <button id="block-confirm-btn" style="background:none;border:1px solid #ef4444;color:#ef4444;font-family:inherit;font-size:0.85em;padding:0.4em 1.5ch;cursor:pointer">block</button>
      </div>
    `
    overlay.appendChild(dialog)
    document.body.appendChild(overlay)

    const cleanup = (result) => {
      overlay.remove()
      resolve(result)
    }

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(false)
    })
    document.getElementById('block-cancel-btn').addEventListener('click', () => cleanup(false))
    document.getElementById('block-confirm-btn').addEventListener('click', () => cleanup(true))
  })
}

function renderPostCard(p) {
  const date = new Date(Number(p.timestamp) * 1000)
  const friendlyDate = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const title = escapeHtml(p.title || 'untitled')
  const content = p.content || ''
  const hasMedia = /\[(video|audio):\s/.test(content) || /!\[/.test(content)

  let previewHtml = ''
  if (hasMedia) {
    const truncContent = content.length > 500 ? content.slice(0, 500) : content
    previewHtml = `<div class="profile-post-media" style="margin-top:0.5em;border-radius:6px;overflow:hidden">${renderMarkdown(truncContent)}</div>`
  } else if (content) {
    let text = content
      .replace(/!\[([^\]]*)\]\s*\(([^)]+)\)/g, '')
      .replace(/\[([^\]]+)\]\s*\(([^)]+)\)/g, '$1')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\n+/g, ' ')
      .trim()
    if (text.length > 120) text = text.slice(0, 120) + '...'
    previewHtml = `<span class="profile-post-preview">${escapeHtml(text)}</span>`
  }

  return `<a href="/post?id=${p.id}" class="profile-post-card">
    <div style="display:flex;justify-content:space-between;align-items:baseline">
      <span class="profile-post-title">${title}</span>
      <span class="profile-post-date">${friendlyDate}</span>
    </div>
    ${previewHtml}
  </a>`
}

function renderCredentials(contributorCredits, producerCredits, PROJECT_TYPES) {
  let html = ''
  for (const c of contributorCredits) {
    const proj = _projectMap[c.projectId]
    const title = proj ? proj.title : `project #${c.projectId}`
    const type = proj ? PROJECT_TYPES[proj.projectType] : ''
    html += `<div class="credential-item"><span class="credential-role">contributor</span> <span class="credential-project">${escapeHtml(title)}</span> ${type ? `<span class="credential-type">${type}</span>` : ''}</div>`
  }
  for (const c of producerCredits) {
    const proj = _projectMap[c.projectId]
    const title = proj ? proj.title : `project #${c.projectId}`
    const type = proj ? PROJECT_TYPES[proj.projectType] : ''
    html += `<div class="credential-item"><span class="credential-role">producer</span> <span class="credential-project">${escapeHtml(title)}</span> ${type ? `<span class="credential-type">${type}</span>` : ''}</div>`
  }
  return html
}

function wireLoadMore(container, addr, artist, PROJECT_TYPES, resolve) {
  // credentials
  const credsBtn = container.querySelector('#profile-load-more-creds')
  if (credsBtn) {
    credsBtn.addEventListener('click', async () => {
      if (!_credsHasMore) return
      credsBtn.textContent = 'loading...'
      credsBtn.disabled = true
      try {
        const result = await fetchPage(
          `query Creds($addr: String!) { credentials(where: { holder: $addr }, limit: 50__AFTER__) { items { ${F.credential} } ${F.pageInfo} } }`,
          { addr }, 'credentials', _credsCursor
        )
        _credsCursor = result.cursor
        _credsHasMore = result.hasMore

        // fetch project details for new creds
        const newProjIds = [...new Set(result.items.map(c => c.projectId).filter(id => !_projectMap[id]))]
        if (newProjIds.length > 0) {
          try {
            const data = await query(`query Projects($ids: [BigInt!]!) { projects(where: { id_in: $ids }, limit: 100) { items { ${F.projectSummary} } } }`, { ids: newProjIds })
            for (const p of (data.projects?.items || [])) _projectMap[p.id] = p
          } catch (e) { console.warn('project details:', e) }
        }

        const section = container.querySelector('#profile-credentials')
        const contributorCredits = result.items.filter(c => c.tokenType === 3)
        const producerCredits = result.items.filter(c => c.tokenType === 2)
        const html = renderCredentials(contributorCredits, producerCredits, PROJECT_TYPES)
        credsBtn.insertAdjacentHTML('beforebegin', html)

        if (_credsHasMore) {
          credsBtn.textContent = 'load more'
          credsBtn.disabled = false
        } else {
          credsBtn.remove()
        }
      } catch (e) {
        console.warn('load more creds:', e)
        credsBtn.textContent = 'load more'
        credsBtn.disabled = false
      }
    })
  }

  // posts
  const postsBtn = container.querySelector('#profile-load-more-posts')
  if (postsBtn) {
    postsBtn.addEventListener('click', async () => {
      if (!_postsHasMore) return
      postsBtn.textContent = 'loading...'
      postsBtn.disabled = true
      try {
        const result = await fetchPage(
          `query Posts($addr: String!) { blogPosts(where: { author: $addr }, orderBy: "timestamp", orderDirection: "desc", limit: 50__AFTER__) { items { ${F.post} } ${F.pageInfo} } }`,
          { addr }, 'blogPosts', _postsCursor
        )
        _postsCursor = result.cursor
        _postsHasMore = result.hasMore

        // Filter amendments from paginated results too
        const moreAmendments = {}
        for (const p of result.items) {
          if (Number(p.refType) === 5 && p.refId) {
            const refKey = String(p.refId)
            if (!moreAmendments[refKey] || Number(p.timestamp) > Number(moreAmendments[refKey].timestamp)) {
              moreAmendments[refKey] = p
            }
          }
        }
        const filteredPosts = result.items
          .filter(p => Number(p.refType) !== 5)
          .map(p => {
            const amended = moreAmendments[String(p.id)]
            return amended ? { ...p, title: amended.title, content: amended.content, _amended: true } : p
          })

        let html = ''
        for (const p of filteredPosts) {
          html += renderPostCard(p)
        }
        postsBtn.insertAdjacentHTML('beforebegin', html)

        if (_postsHasMore) {
          postsBtn.textContent = 'load more'
          postsBtn.disabled = false
        } else {
          postsBtn.remove()
        }
      } catch (e) {
        console.warn('load more posts:', e)
        postsBtn.textContent = 'load more'
        postsBtn.disabled = false
      }
    })
  }

  // following — open modal
  const followsBtn = container.querySelector('#profile-load-more-follows')
  if (followsBtn) {
    followsBtn.addEventListener('click', () => showConnectionsModal('following', addr, resolve))
  }

  // followers — open modal
  const followersBtn = container.querySelector('#profile-load-more-followers')
  if (followersBtn) {
    followersBtn.addEventListener('click', () => showConnectionsModal('followers', addr, resolve))
  }
}

// --- Connections Modal (following / followers) ---

async function showConnectionsModal(type, addr, resolve) {
  // type: 'following' or 'followers'
  document.getElementById('connections-modal-overlay')?.remove()

  const isFollowing = type === 'following'
  const queryStr = isFollowing
    ? `query Follows($addr: String!) { follows(where: { follower: $addr }, limit: 20__AFTER__) { items { ${F.followOut} } ${F.pageInfo} } }`
    : `query Followers($addr: String!) { follows(where: { followed: $addr }, limit: 20__AFTER__) { items { ${F.followIn} } ${F.pageInfo} } }`
  const addrField = isFollowing ? 'followed' : 'follower'

  let cursor = null
  let hasMore = true
  let loading = false

  // build modal DOM
  const overlay = document.createElement('div')
  overlay.id = 'connections-modal-overlay'
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center'

  const modal = document.createElement('div')
  modal.style.cssText = 'background:var(--bg, #111);border:1px solid var(--border, #333);border-radius:8px;max-width:400px;width:90vw;max-height:70vh;display:flex;flex-direction:column;color:var(--fg, #c0c0c0);font-family:inherit'

  // header
  const header = document.createElement('div')
  header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:0.75em 1em;border-bottom:1px solid var(--border, #333);flex-shrink:0'
  header.innerHTML = `<span style="font-weight:600;font-size:0.95em">${escapeHtml(type)}</span><button id="connections-modal-close" style="background:none;border:none;color:var(--fg, #c0c0c0);font-size:1.2em;cursor:pointer;padding:0 0.25em;line-height:1">&times;</button>`

  // scrollable list
  const list = document.createElement('div')
  list.style.cssText = 'overflow-y:auto;flex:1;padding:0.5em 0'

  // spinner
  const spinner = document.createElement('div')
  spinner.style.cssText = 'text-align:center;padding:0.75em;color:var(--dim, #666);font-size:0.85em;display:none'
  spinner.textContent = 'loading...'

  modal.appendChild(header)
  modal.appendChild(list)
  modal.appendChild(spinner)
  overlay.appendChild(modal)
  document.body.appendChild(overlay)

  // close handlers
  const close = () => overlay.remove()
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close() })
  header.querySelector('#connections-modal-close').addEventListener('click', close)
  const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey) } }
  document.addEventListener('keydown', onKey)

  // load a page
  async function loadPage() {
    if (loading || !hasMore) return
    loading = true
    spinner.style.display = 'block'
    try {
      const result = await fetchPage(queryStr, { addr }, 'follows', cursor)
      cursor = result.cursor
      hasMore = result.hasMore

      // resolve domains for this batch
      const addrs = result.items.map(f => f[addrField])
      const newAddrs = addrs.filter(a => !_domainMap[a.toLowerCase()])
      if (newAddrs.length > 0) {
        try {
          const newDomains = await resolveAddresses(query, newAddrs)
          Object.assign(_domainMap, newDomains)
        } catch (e) { console.warn('domain resolve:', e) }
      }

      for (const f of result.items) {
        const a = f[addrField]
        const domain = resolve(a)
        const short = `${a.slice(0, 6)}...${a.slice(-4)}`
        const row = document.createElement('a')
        row.href = `/network?artist=${a}`
        row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:0.5em 1em;text-decoration:none;color:var(--fg, #c0c0c0);transition:background 0.1s'
        row.addEventListener('mouseenter', () => { row.style.background = 'rgba(255,255,255,0.05)' })
        row.addEventListener('mouseleave', () => { row.style.background = 'none' })
        row.innerHTML = `<span style="font-size:0.9em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0">${escapeHtml(domain)}</span><span style="font-size:0.7em;color:var(--dim, #666);flex-shrink:0;margin-left:1ch">${escapeHtml(short)}</span>`
        list.appendChild(row)
      }

      if (!hasMore && result.items.length === 0 && list.children.length === 0) {
        list.innerHTML = '<div style="text-align:center;padding:2em;color:var(--dim, #666);font-size:0.85em">none</div>'
      }
    } catch (e) {
      console.warn('connections modal fetch:', e)
    } finally {
      loading = false
      spinner.style.display = hasMore ? 'none' : 'none'
    }
  }

  // infinite scroll
  list.addEventListener('scroll', () => {
    if (list.scrollTop + list.clientHeight >= list.scrollHeight - 60) {
      loadPage()
    }
  })

  // initial load
  await loadPage()
}

// escapeHtml imported from utils.js
