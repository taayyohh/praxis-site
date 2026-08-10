import { F } from './fragments.js'
import { createWalletClient, custom } from './vendor.js'
import { optimism } from './vendor.js'
import { query } from './ponder.js'
import { t } from './i18n.js'
import { getPublicClient, isBlocked, blockUser, unblockUser, registerPage, requireUser, escapeHtml , getWalletProvider } from './utils.js'

const REGISTRY_V1_ABI = [
  {
    name: 'register',
    type: 'function',
    inputs: [{ name: 'domain', type: 'string' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'artists',
    type: 'function',
    inputs: [{ name: '', type: 'address' }],
    outputs: [
      { name: 'domain', type: 'string' },
      { name: 'registeredAt', type: 'uint256' },
    ],
    stateMutability: 'view',
  },
]

import { REGISTRY_ABI, INVITES_ABI, INVITES_ADDR, ARTIST_SPONSOR_ABI, ARTIST_SPONSOR_ADDR } from './contracts.js'
const INVITES_ADDRESS = INVITES_ADDR

const PAGE_SIZE = 100

let networkData = null
let _initGen = 0

registerPage('network-data', () => {
  // if ?artist= param is present, profile.js handles it — skip network init
  if (new URLSearchParams(window.location.search).get('artist')) return
  networkData = document.getElementById('network-data')
  // timeout protection: if init takes > 15s, show error instead of infinite loading
  const timeout = setTimeout(() => {
    const s = document.getElementById('network-status')
    if (s && s.querySelector('.praxis-loader')) s.textContent = 'loading timed out — try refreshing'
  }, 15000)
  init().catch(e => {
    console.error('network init failed:', e)
    const statusEl = document.getElementById('network-status')
    if (statusEl) statusEl.textContent = 'could not load network'
  }).finally(() => clearTimeout(timeout))
})

async function init() {
  const thisGen = ++_initGen
  const registryAddress = networkData?.dataset?.registry
  const statusEl = document.getElementById('network-status')
  const listEl = document.getElementById('network-list')

  if (!statusEl || !listEl) return // DOM not ready
  listEl.className = 'nc-grid'
  if (!registryAddress) {
    statusEl.textContent = t('network.registryNotDeployed')
    return
  }

  statusEl.innerHTML = '<span class="praxis-loader"></span>'

  const publicClient = await getPublicClient()

  // follow state cache: address → bool (loaded per page batch, not all at once)
  let followState = {}
  let followersState = {}

  async function loadFollowStateForAddresses(myAddr, addresses) {
    if (!myAddr || !registryAddress || addresses.length === 0) return
    try {
      const addrs = addresses.map(a => a.toLowerCase())
      const me = myAddr.toLowerCase()

      // paginate both directions — capped at 5 pages with 10s overall timeout
      const MAX_PAGES = 5
      const TIMEOUT_MS = 10000
      async function fetchAllFollowState(where, field, fragment, signal) {
        let all = [], cursor = null, page = 0
        try {
          while (true) {
            if (signal?.aborted) break
            if (++page > MAX_PAGES) break
            const vars = { me, addrs, ...(cursor ? { after: cursor } : {}) }
            const data = await query(`
              query FollowState($me: String!, $addrs: [String!]!, $after: String) {
                follows(where: { ${where} }, limit: 200, after: $after) {
                  items { ${fragment} }
                  ${F.pageInfo}
                }
              }
            `, vars)
            all.push(...data.follows.items)
            if (!data.follows.pageInfo?.hasNextPage) break
            cursor = data.follows.pageInfo.endCursor
          }
        } catch (e) {
          if (e?.name !== 'AbortError') console.warn('praxis: follow state page error:', e?.message)
        }
        return all
      }

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)

      const [followingItems, followerItems] = await Promise.race([
        Promise.all([
          fetchAllFollowState('follower: $me, followed_in: $addrs', 'followed', F.followOut, controller.signal),
          fetchAllFollowState('followed: $me, follower_in: $addrs', 'follower', F.followIn, controller.signal),
        ]),
        new Promise((resolve) => {
          controller.signal.addEventListener('abort', () => resolve([[], []]))
        }),
      ]).finally(() => clearTimeout(timeout))

      for (const f of followingItems) {
        followState[f.followed.toLowerCase()] = true
      }
      for (const f of followerItems) {
        followersState[f.follower.toLowerCase()] = true
      }
    } catch (e) { if (e?.message) console.warn("praxis:", e.message) }
  }

  function isMutualFollow(addr) {
    return followState[addr.toLowerCase()] && followersState[addr.toLowerCase()]
  }

  async function toggleFollow(targetAddr) {
    if (!registryAddress) return
    const userAddr = await requireUser('follow artists')
    if (!userAddr) return

    const btn = document.querySelector(`[data-follow-addr="${targetAddr.toLowerCase()}"]`)
    if (btn) btn.disabled = true

    const isFollowing = followState[targetAddr.toLowerCase()]

    // optimistic update: change state + button text immediately
    followState[targetAddr.toLowerCase()] = !isFollowing
    if (btn) {
      btn.textContent = isFollowing ? t('network.follow') : t('network.unfollow')
      btn.classList.toggle('nc-btn-filled', !isFollowing)
    }

    try {
      const currentAccount = await window.ensureAuthorized?.() || window.getWalletAddress()
      if (!await window.ensureOptimism?.()) return
      const walletClient = createWalletClient({
        chain: optimism,
        transport: custom(getWalletProvider()),
      })
      const action = walletClient.writeContract({
        address: registryAddress,
        abi: REGISTRY_ABI,
        functionName: isFollowing ? 'unfollow' : 'follow',
        args: [targetAddr],
        account: currentAccount,
      })
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('transaction timed out')), 15000))
      const hash = await Promise.race([action, timeout])
      await publicClient.waitForTransactionReceipt({ hash })
    } catch (e) {
      const msg = e?.shortMessage || e?.message || ''
      // session expired — prompt unlock and retry once
      if (msg.includes('session expired') && window.showUnlockPrompt) {
        const addr = await window.showUnlockPrompt()
        if (addr) {
          if (btn) btn.disabled = false
          return toggleFollow(targetAddr, btn)
        }
      }
      // if "already following" or "not following" — state was stale, correct it
      if (msg.includes('already following')) {
        followState[targetAddr.toLowerCase()] = true
        if (btn) { btn.textContent = t('network.unfollow'); btn.classList.add('nc-btn-filled') }
      } else if (msg.includes('not following')) {
        followState[targetAddr.toLowerCase()] = false
        if (btn) { btn.textContent = t('network.follow'); btn.classList.remove('nc-btn-filled') }
      } else {
        // revert optimistic update on other errors
        followState[targetAddr.toLowerCase()] = isFollowing
        if (btn) { btn.textContent = isFollowing ? t('network.unfollow') : t('network.follow'); btn.classList.toggle('nc-btn-filled', isFollowing) }
      }
      if (e.code !== 4001 && !msg.includes('already following') && !msg.includes('not following') && !msg.includes('session expired')) {
        console.error('follow error:', e)
        const errDisplay = msg.includes('underpriced') ? 'transaction stuck — try again in a moment'
          : msg.includes('rejected') || msg.includes('denied') ? 'cancelled'
          : msg.includes('insufficient') ? 'insufficient funds for gas'
          : 'follow failed — try again'
        import('./toast.js').then(({ toast }) => toast.error(errDisplay)).catch(() => {})
      }
    } finally {
      if (btn) btn.disabled = false
    }
  }

  // search input above list (remove existing on SPA re-nav)
  document.getElementById('network-search')?.remove()
  const searchHtml = `<div style="display:flex;justify-content:center;margin-bottom:1.25em"><input type="text" id="network-search" class="network-search-input" placeholder="search by name or address..."></div>`
  listEl.insertAdjacentHTML('beforebegin', searchHtml)

  let _searchDebounce = null
  let _searchActive = false
  document.getElementById('network-search')?.addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase()
    if (_searchDebounce) clearTimeout(_searchDebounce)

    // short queries or empty: revert to client-side filter on loaded items
    if (!q || q.length < 2) {
      _searchActive = false
      listEl.querySelectorAll('li').forEach(li => { li.style.display = '' })
      return
    }

    // immediate client-side filter for responsiveness
    listEl.querySelectorAll('li').forEach(li => {
      const text = li.textContent.toLowerCase()
      li.style.display = text.includes(q) ? '' : 'none'
    })

    // debounced server-side search for full index coverage
    _searchDebounce = setTimeout(async () => {
      try {
        const res = await fetch(`/api/network/search?q=${encodeURIComponent(q)}&limit=30`)
        if (!res.ok) return
        const data = await res.json()
        if (!data.results?.length) return
        _searchActive = true

        // build set of IDs already visible in list
        const visibleIds = new Set()
        listEl.querySelectorAll('li[data-addr]').forEach(li => {
          visibleIds.add(li.getAttribute('data-addr').toLowerCase())
        })

        // append server results not already in list
        for (const r of data.results) {
          const id = r.id.toLowerCase()
          if (visibleIds.has(id)) continue
          // M2: reject malformed ids before rendering into href / slice
          if (!/^0x[0-9a-f]{40}$/.test(id)) continue
          // tag is now rendered inside the card via rTag below
          const li = document.createElement('li')
          li.className = r.type === 'audience' ? 'nc-item supporter-item search-result' : 'nc-item search-result'
          li.setAttribute('data-addr', id)
          const badgeClass = r.type === 'audience' ? 'nc-badge-audience' : 'nc-badge-artist'
          const badgeLabel = r.type === 'audience' ? 'audience' : 'artist'
          const ogImg = r.type !== 'audience' ? `<img src="https://${escapeHtml(r.name)}/og/index.png" class="nc-og" loading="lazy" onerror="this.style.display='none'" alt="">` : ''
          li.innerHTML = `${ogImg}<div class="nc-body"><a href="/network?${r.type === 'audience' ? 'audience' : 'artist'}=${id}" class="nc-domain">${escapeHtml(r.name)}</a><div class="nc-actions"><span class="nc-btns"></span><span class="nc-badge ${badgeClass}">${badgeLabel}</span></div></div>`
          listEl.prepend(li)
        }
      } catch (err) {
        console.warn('network search:', err?.message)
      }
    }, 300)
  })

  // load artists from Ponder
  let afterCursor = null
  let allLoaded = false
  let _artistObserver = null
  let _artistLoading = false
  let _orgCount = 0

  async function loadPage() {
    if (_artistLoading) return
    _artistLoading = true
    try {
      const data = await query(`
        query($after: String) {
          artists(limit: ${PAGE_SIZE}, after: $after, orderBy: "registeredAt", orderDirection: "desc") {
            items { ${F.artistFull} }
            ${F.pageInfo}
            totalCount
          }
          organizations(where: { dissolved: false }, limit: 1) { totalCount }
        }
      `, { after: afterCursor })

      const { items, totalCount, pageInfo } = data.artists
      _orgCount = data.organizations?.totalCount || 0
      const orgCount = _orgCount

      // batch-load follow state for this page of artists
      const connectedAddr = window.getWalletAddress?.()
      if (connectedAddr) {
        await loadFollowStateForAddresses(connectedAddr, items.map(a => a.id))
      }

      if (!afterCursor) {
        if (totalCount === 0) {
          statusEl.textContent = t('network.noArtists')
          _artistLoading = false
          return
        }
        statusEl.className = 'nc-stats'
        const artistLabel = totalCount === 1
          ? t('network.artistCountSingular')
          : t('network.artistCount', { count: totalCount })
        statusEl.textContent = orgCount > 0
          ? `${artistLabel} · ${orgCount} organization${orgCount !== 1 ? 's' : ''}`
          : artistLabel
        listEl.innerHTML = ''
      }

      // remove old sentinel before appending
      listEl.querySelector('#artist-sentinel')?.remove()

      const myAddr = window.getWalletAddress?.()?.toLowerCase()
      listEl.insertAdjacentHTML('beforeend', items
        .map(a => {
          const addr = a.id
          const isMe = myAddr && addr.toLowerCase() === myAddr
          const followBtn = registryAddress && !isMe
            ? `<button class="buy-btn follow-btn nc-btn${followState[addr.toLowerCase()] ? ' nc-btn-filled' : ''}" data-follow-addr="${addr.toLowerCase()}">${followState[addr.toLowerCase()] ? t('network.unfollow') : t('network.follow')}</button>`
            : ''
          const iFollowThem = followState[addr.toLowerCase()]
          const theyFollowMe = followersState[addr.toLowerCase()]
          const dmBtn = !isMe && iFollowThem && theyFollowMe
            ? `<button class="buy-btn dm-btn nc-btn" data-dm-addr="${addr.toLowerCase()}" data-dm-domain="${escapeHtml(a.domain)}"><i class="ph ph-chat-circle"></i></button>`
            : ''
          const ogImg = `<img src="https://${escapeHtml(a.domain)}/og/index.png" class="nc-og" loading="lazy" onerror="this.style.display='none'" alt="">`
          return `<li class="nc-item" data-addr="${addr.toLowerCase()}"><a href="/network?artist=${addr.toLowerCase()}" class="nc-link">${ogImg}<div class="nc-body"><div class="nc-header"><span class="nc-domain">${escapeHtml(a.domain)}</span>${followBtn}</div></div></a></li>`
        })
        .join(''))

      afterCursor = pageInfo.endCursor
      allLoaded = !pageInfo.hasNextPage

      // add sentinel for infinite scroll
      if (!allLoaded) {
        listEl.insertAdjacentHTML('beforeend', '<li id="artist-sentinel" class="nc-sentinel"></li>')
        const sentinel = document.getElementById('artist-sentinel')
        if (sentinel && _artistObserver) _artistObserver.observe(sentinel)
      }
    } catch (e) {
      console.error('network loadPage error:', e)
      statusEl.textContent = t('network.couldNotLoad')
    } finally {
      _artistLoading = false
    }
  }

  // set up IntersectionObserver for artists infinite scroll
  _artistObserver = new IntersectionObserver(async (entries) => {
    if (!entries[0]?.isIntersecting || _artistLoading || allLoaded) return
    const sentinel = document.getElementById('artist-sentinel')
    if (sentinel) sentinel.textContent = 'loading...'
    await loadPage()
  }, { rootMargin: '200px' })

  await loadPage()

  // load supporters (audience members) and append to list
  if (thisGen !== _initGen) return // stale init, newer one took over
  listEl.querySelectorAll('.supporter-item').forEach(el => el.remove())
  let supCursor = null
  let supAllLoaded = false
  let supTotalCount = 0
  let _supObserver = null
  let _supLoading = false

  async function loadSupportersPage() {
    if (_supLoading) return
    _supLoading = true
    try {
      const supData = await query(`
        query($after: String) {
          supporters(limit: 50, after: $after, orderBy: "registeredAt", orderDirection: "desc") {
            items { ${F.supporter} }
            ${F.pageInfo}
            totalCount
          }
        }
      `, { after: supCursor })
      const supItems = supData.supporters?.items || []
      const pageInfo = supData.supporters?.pageInfo || {}
      supTotalCount = supData.supporters?.totalCount || 0
      supCursor = pageInfo.endCursor
      supAllLoaded = !pageInfo.hasNextPage

      if (supItems.length > 0) {
        const connectedAddr = window.getWalletAddress?.()
        if (connectedAddr) {
          await loadFollowStateForAddresses(connectedAddr, supItems.map(s => s.id))
        }
        const artistCount = statusEl.textContent.match(/^(\d+)/)?.[1] || '0'
        let statsText = `${artistCount} artist${artistCount !== '1' ? 's' : ''}`
        if (_orgCount > 0) statsText += ` · ${_orgCount} organization${_orgCount !== 1 ? 's' : ''}`
        statsText += ` · ${supTotalCount} audience member${supTotalCount !== 1 ? 's' : ''}`
        statusEl.textContent = statsText

        // remove old sentinel before appending
        listEl.querySelector('#supporter-sentinel')?.remove()

        const myAddr = window.getWalletAddress?.()?.toLowerCase()
        const supHtml = supItems.map(s => {
          const addr = s.id
          const isMe = myAddr && addr.toLowerCase() === myAddr
          const followBtn = registryAddress && !isMe
            ? `<button class="buy-btn follow-btn nc-btn${followState[addr.toLowerCase()] ? ' nc-btn-filled' : ''}" data-follow-addr="${addr.toLowerCase()}">${followState[addr.toLowerCase()] ? t('network.unfollow') : t('network.follow')}</button>`
            : ''
          const iFollowThem = followState[addr.toLowerCase()]
          const theyFollowMe = followersState[addr.toLowerCase()]
          const dmBtn = !isMe && iFollowThem && theyFollowMe
            ? `<button class="buy-btn dm-btn nc-btn" data-dm-addr="${addr.toLowerCase()}" data-dm-domain="${escapeHtml(s.handle)}"><i class="ph ph-chat-circle"></i></button>`
            : ''
          const ogUrl = `https://${escapeHtml(s.handle)}.ourpraxis.network/og/index.png`
          return `<li class="nc-item supporter-item" data-addr="${addr.toLowerCase()}"><a href="/network?audience=${addr.toLowerCase()}" class="nc-link"><img src="${ogUrl}" class="nc-og" loading="lazy" onerror="this.style.display='none'" alt=""><div class="nc-body"><div class="nc-header"><span class="nc-domain">${escapeHtml(s.handle)}</span>${followBtn}</div></div></a></li>`
        }).join('')
        listEl.insertAdjacentHTML('beforeend', supHtml)

        // add sentinel for infinite scroll
        if (!supAllLoaded) {
          listEl.insertAdjacentHTML('beforeend', '<li id="supporter-sentinel" class="supporter-item nc-sentinel"></li>')
          const sentinel = document.getElementById('supporter-sentinel')
          if (sentinel && _supObserver) _supObserver.observe(sentinel)
        }
      }
    } catch (e) {
      console.warn('supporters load:', e?.message)
    } finally {
      _supLoading = false
    }
  }

  // set up IntersectionObserver for supporters infinite scroll
  _supObserver = new IntersectionObserver(async (entries) => {
    if (!entries[0]?.isIntersecting || _supLoading || supAllLoaded) return
    const sentinel = document.getElementById('supporter-sentinel')
    if (sentinel) sentinel.textContent = 'loading...'
    await loadSupportersPage()
  }, { rootMargin: '200px' })

  await loadSupportersPage()

  // list/graph toggle — default to list
  // reset on every init() so SPA re-navigation re-initializes the graph
  let graphInitialized = false

  function switchView(view) {
    document.querySelectorAll('.network-toggle').forEach(b => {
      b.classList.toggle('active', b.dataset.view === view)
    })
    const listView = document.getElementById('network-list-view')
    const graphView = document.getElementById('network-graph-view')
    // On the artist profile subview (?artist=...), the list/graph containers
    // don't exist. Navigate back to the main network page with the view param
    // so the toggle actually works.
    if (!listView || !graphView) {
      window.location.href = `/network${view === 'graph' ? '#graph' : ''}`
      return
    }
    listView.style.display = view === 'list' ? 'block' : 'none'
    graphView.style.display = view === 'graph' ? 'block' : 'none'
    if (view === 'graph' && !graphInitialized) {
      graphInitialized = true
      // defer one frame so the container is actually laid out (offsetParent
      // non-null) before graph.js measures the canvas — otherwise the canvas
      // resolves to zero width and can stay invisible / unresponsive on mobile
      requestAnimationFrame(() => {
        try { if (window.initGraph) window.initGraph() } catch (e) {
          console.warn('praxis: initGraph failed:', e?.message)
        }
      })
    }
  }

  document.querySelectorAll('.network-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      // If on a profile view, navigate back to network list first
      if (window.location.search.includes('artist=') || window.location.search.includes('audience=')) {
        window.location.href = '/network'
        return
      }
      switchView(btn.dataset.view)
    })
  })

  // default to list view
  switchView('list')

  if (!listEl._delegated) {
    listEl._delegated = true
    listEl.addEventListener('click', (e) => {
    const followBtn = e.target.closest('.follow-btn')
    if (followBtn) { e.preventDefault(); e.stopPropagation(); toggleFollow(followBtn.dataset.followAddr); return }

    const dmBtn = e.target.closest('.dm-btn')
    if (dmBtn) {
      const addr = dmBtn.dataset.dmAddr
      window.location.href = `/messages?dm=${addr}`
    }

  })
  }

  // clean up old load more buttons (replaced by IntersectionObserver)
  document.getElementById('load-more-btn')?.remove()
  document.getElementById('load-more-supporters-btn')?.remove()

  // check if user is already registered — show invite codes instead of join form
  const myAddr = window.getWalletAddress?.()?.toLowerCase()
  let isRegistered = false
  let isSupporter = false
  if (myAddr) {
    try {
      const checkData = await query(`query CheckUser($addr: String!) { artist(id: $addr) { ${F.artist} } supporter(id: $addr) { id handle } }`, { addr: myAddr })
      if (checkData?.artist?.domain) isRegistered = true
      if (checkData?.supporter?.handle) { isRegistered = true; isSupporter = true }
    } catch {}
  }

  if (isRegistered) {
    // show invites button for artists only (supporters can't create invites)
    if (!isSupporter) {
      const btnRow = document.getElementById('network-invites-btn-row')
      if (btnRow) btnRow.style.display = 'flex'
      document.getElementById('open-invites-btn')?.addEventListener('click', () => {
        openInvitesModal(myAddr, publicClient)
      })
    }
    return
  }

  // don't show register form on supporter sites or individual artist sites —
  // registration belongs on the landing page (ourpraxis.network). Showing the
  // full invite-code + domain-search form on every artist's /network page is
  // confusing for visitors and clutters the page.
  if (document.body.dataset.supporter === 'true') return
  if (window.location.hostname !== 'ourpraxis.network' && !window.location.hostname.endsWith('.ourpraxis.network')) return

  // render register form (only on ourpraxis.network for unregistered users)
  document.getElementById('register-form')?.remove()
  const formHtml = `
    <div id="register-form" style="margin-top:2em">
      <h3>${t('network.joinNetwork')}</h3>
      <p style="color:#999;margin-bottom:1em">${t('network.joinDesc')}</p>
      <div style="display:grid;gap:0.75em;max-width:500px">
        <input type="text" id="register-invite" placeholder="${t('network.inviteCodePlaceholder')}" style="background:#1a1a1a;border:1px solid #333;color:#c0c0c0;font-family:inherit;font-size:1em;padding:0.5em 1ch" autocomplete="off">
        <div style="display:flex;gap:1ch;align-items:center">
          <input type="text" id="register-handle" placeholder="${t('network.searchDomainsPlaceholder')}" style="background:#1a1a1a;border:1px solid #333;color:#c0c0c0;font-family:inherit;font-size:1em;padding:0.5em 1ch;flex:1" autocomplete="off">
          <button class="buy-btn" id="search-domains-btn">${t('network.search')}</button>
        </div>
      </div>
      <div id="domain-results" style="margin-top:1em"></div>
      <p id="register-status" class="status" style="color:#666;margin-top:0.5em"></p>
    </div>
  `
  networkData.insertAdjacentHTML('beforeend', formHtml)

  document.getElementById('search-domains-btn').addEventListener('click', async () => {
    const handle = document.getElementById('register-handle').value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '')
    const resultsEl = document.getElementById('domain-results')
    const regStatus = document.getElementById('register-status')

    if (!handle || handle.length < 2) { regStatus.textContent = t('network.enterChars'); return }

    regStatus.textContent = t('network.searching')
    resultsEl.innerHTML = ''

    try {
      // search NameSilo for available domains
      const res = await fetch(`/orchestrator/domains/search?handle=${handle}`)
      const data = await res.json()

      let html = ''

      // always show the "already have a domain" option first
      html += `
        <div class="domain-option-row">
          <div>
            <span style="color:#fff">${t('network.ownDomain')}</span>
            <div style="color:#666;font-size:0.85em">${t('network.ownDomainDesc')}</div>
          </div>
          <div style="display:flex;gap:0.5ch;align-items:center">
            <input type="text" id="own-domain-input" placeholder="${t('network.ownDomainPlaceholder')}" style="background:#1a1a1a;border:1px solid #333;color:#c0c0c0;font-family:inherit;font-size:0.9em;padding:0.3em 1ch;width:20ch">
            <button class="buy-btn domain-select-btn" data-domain="own" style="font-size:0.85em;padding:0.3em 1ch">${t('network.select')}</button>
          </div>
        </div>
      `

      // show available domains from NameSilo
      if (data.domains) {
        const available = data.domains.filter(d => d.available && !d.premium)
        if (available.length > 0) {
          for (const d of available) {
            if (d.tooExpensive) continue // skip domains over $15
            const priceLabel = d.priceUsd ? `$${d.priceUsd.toFixed(2)} ${t('network.perTwoYear')}` : ''
            const ethLabel = d.priceEth ? `${d.priceEth} ETH` : ''
            html += `
              <div class="domain-option-row">
                <div>
                  <span style="color:var(--accent)">${escapeHtml(d.domain)}</span>
                  ${priceLabel ? `<span style="color:var(--dim);font-size:0.8em;margin-left:1ch">${priceLabel} (${ethLabel})</span>` : ''}
                </div>
                <button class="buy-btn domain-buy-btn" data-domain="${escapeHtml(d.domain)}" data-price-eth="${d.priceEth || '0'}" style="font-size:0.85em;padding:0.3em 1ch">${t('network.buyDeploy')}</button>
              </div>
            `
          }
        }
      }

      resultsEl.innerHTML = html
      regStatus.textContent = ''

      // handle domain selection
      // "i already have a domain" handler — DNS must be verified
      resultsEl.querySelectorAll('.domain-select-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          let domain = btn.dataset.domain
          if (domain === 'own') {
            domain = document.getElementById('own-domain-input')?.value.trim()
            if (!domain) { regStatus.textContent = 'enter your domain'; return }
          }
          await registerAndDeploy(domain, regStatus, false) // BYO = verify DNS
        })
      })

      // "buy + deploy" handler — purchases via NameSilo then deploys
      resultsEl.querySelectorAll('.domain-buy-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const domain = btn.dataset.domain
          regStatus.textContent = ''

          // show contact form (required by ICANN for domain registration)
          const formHtml = `
            <div id="domain-contact-form" style="margin-top:1em;border:1px solid var(--border);padding:1em">
              <p style="color:var(--accent);margin-bottom:0.75em">${t('network.contactInfo', { domain })}</p>
              <p style="color:var(--dim);font-size:0.8em;margin-bottom:1em">${t('network.contactInfoDesc')}</p>
              <div style="display:grid;gap:0.5em;max-width:400px">
                <div style="display:flex;gap:0.5em">
                  <input type="text" id="contact-first" placeholder="${t('network.firstName')}" class="project-input" style="flex:1">
                  <input type="text" id="contact-last" placeholder="${t('network.lastName')}" class="project-input" style="flex:1">
                </div>
                <input type="email" id="contact-email" placeholder="${t('network.email')}" class="project-input">
                <input type="text" id="contact-address" placeholder="${t('network.address')}" class="project-input">
                <div style="display:flex;gap:0.5em">
                  <input type="text" id="contact-city" placeholder="${t('network.city')}" class="project-input" style="flex:1">
                  <input type="text" id="contact-state" placeholder="${t('network.state')}" class="project-input" style="flex:1">
                </div>
                <div style="display:flex;gap:0.5em">
                  <input type="text" id="contact-zip" placeholder="${t('network.zip')}" class="project-input" style="flex:1">
                  <input type="text" id="contact-country" placeholder="${t('network.country')}" class="project-input" style="flex:1" value="US">
                </div>
                <button class="buy-btn" id="confirm-buy-btn">${t('network.confirmPurchase')}</button>
              </div>
              <p id="buy-status" style="color:var(--muted);font-size:0.85em;margin-top:0.5em"></p>
            </div>
          `
          resultsEl.insertAdjacentHTML('beforeend', formHtml)

          document.getElementById('confirm-buy-btn')?.addEventListener('click', async () => {
            const buyStatus = document.getElementById('buy-status')
            const contactInfo = {
              firstName: document.getElementById('contact-first')?.value.trim(),
              lastName: document.getElementById('contact-last')?.value.trim(),
              email: document.getElementById('contact-email')?.value.trim(),
              address: document.getElementById('contact-address')?.value.trim(),
              city: document.getElementById('contact-city')?.value.trim(),
              state: document.getElementById('contact-state')?.value.trim(),
              zip: document.getElementById('contact-zip')?.value.trim(),
              country: document.getElementById('contact-country')?.value.trim() || 'US',
            }

            if (!contactInfo.firstName || !contactInfo.lastName || !contactInfo.email) {
              buyStatus.textContent = t('network.nameEmailRequired')
              return
            }

            const domainPriceEth = parseFloat(btn.dataset.priceEth || '0')
            // deploy fee is now paid on-chain via register() — only send domain cost here
            const totalEth = domainPriceEth
            buyStatus.textContent = t('network.purchasing', { eth: totalEth.toFixed(6) })

            try {
              const addr = window.getWalletAddress?.()
              if (!addr) { buyStatus.textContent = t('network.connectFirst'); return }

              if (!await window.ensureOptimism?.()) { buyStatus.textContent = t('network.connectFirst'); return }

              const totalWei = BigInt(Math.ceil(totalEth * 1e18))

              buyStatus.textContent = t('network.confirmPayment')
              const payAccount = await window.ensureAuthorized?.() || addr
              const walletClient = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })
              const payHash = await walletClient.sendTransaction({
                to: '0x46db55AD42dA6bA3c29a3C1522EBBF8e16960725',
                value: totalWei,
                account: payAccount,
              })
              buyStatus.textContent = t('status.tx', { hash: payHash.slice(0, 14) + '...' })
              await publicClient.waitForTransactionReceipt({ hash: payHash })

              // purchase domain via NameSilo
              buyStatus.textContent = t('network.registeringDomain')
              const regMsg = `Sign to register ${domain}`
              const authAccount = await window.ensureAuthorized?.() || addr
              const regSig = await walletClient.signMessage({ account: authAccount, message: regMsg })
              const res = await fetch('/orchestrator/domains/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ domain, contactInfo, wallet: addr, name: contactInfo.firstName, bio: '', signature: regSig, message: regMsg }),
              })
              const result = await res.json()

              if (result.error) {
                buyStatus.textContent = `domain error: ${result.error}`
                return
              }

              buyStatus.textContent = `${domain} purchased`
              document.getElementById('domain-contact-form')?.remove()

              // domain purchased + DNS set by us = verified
              await registerAndDeploy(domain, regStatus, true)
            } catch (e) {
              buyStatus.textContent = t('status.error', { msg: e.message })
            }
          })
        })
      })
    } catch (e) {
      regStatus.textContent = t('network.couldNotSearch')
    }
  })

  // domainVerified = true for purchased domains (DNS set by us), false for BYO
  async function registerAndDeploy(domain, statusEl, domainVerified = false) {
    const inviteCode = document.getElementById('register-invite')?.value.trim()

    const address = window.getWalletAddress?.()
    if (!address) {
      await window.connectWallet?.()
      if (!window.getWalletAddress?.()) { statusEl.textContent = t('network.connectFirst'); return }
    }

    const regTarget = registryAddress
    const regAbi = REGISTRY_ABI

    // check if already registered
    let alreadyRegistered = false
    try {
      const [existingDomain] = await publicClient.readContract({
        address: regTarget, abi: regAbi,
        functionName: 'artists', args: [window.getWalletAddress()],
      })
      if (existingDomain) {
        alreadyRegistered = true
        // check if already deployed
        try {
          const deployRes = await fetch(`/orchestrator/status/${window.getWalletAddress()}`)
          const deployData = await deployRes.json()
          if (deployData.status === 'live') {
            statusEl.textContent = `already deployed as ${existingDomain}`
            return
          }
        } catch (e) { if (e?.message) console.warn("praxis:", e.message) }
        // if domain changed, update it
        if (existingDomain !== domain) {
          domainVerified = false // need to verify the new domain
        }
      }
    } catch (e) { if (e?.message) console.warn("praxis:", e.message) }

    // STEP 1: verify domain ownership BEFORE any on-chain actions
    if (!domainVerified) {
      statusEl.textContent = 'verifying domain ownership...'
      try {
        const res = await fetch(`/orchestrator/domains/verify-dns?domain=${domain}`)
        const data = await res.json()
        if (!data.verified) {
          statusEl.textContent = `point ${domain} A record to ${data.expected} then try again`
          return
        }
      } catch (e) {
        statusEl.textContent = 'could not verify DNS'
        return
      }
    }

    if (!await window.ensureOptimism?.()) { statusEl.textContent = t('network.connectFirst'); return }

    // check if invite is sponsored (deploy fee pre-paid by deployer)
    let isSponsored = false
    if (inviteCode) {
      try {
        const sr = await fetch(`/orchestrator/check-sponsor?code=${encodeURIComponent(inviteCode)}`)
        const sd = await sr.json()
        if (sd.sponsored) isSponsored = true
      } catch {}
    }

    if (!alreadyRegistered) {
      // STEP 2: use invite (only if not already registered)
      if (!inviteCode) { statusEl.textContent = 'enter an invite code'; return }
      statusEl.textContent = 'validating invite...'
      try {
        if (!await window.ensureOptimism?.()) return
        const authAccount = await window.ensureAuthorized?.() || window.getWalletAddress()
        const walletClient = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })

        // v2: fetch EIP-712 signature from orchestrator before useInvite. The signature
        // binds (codeHash, msg.sender, expiry, nonce) so a mempool watcher cannot
        // replace the invitee on the in-flight tx. See orchestrator/api.js sign-use-invite.
        const sigRes = await fetch('/orchestrator/sign-use-invite', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: inviteCode, invitee: authAccount }),
        })
        const sigData = await sigRes.json()
        if (sigData.error) {
          if (sigData.error.includes('invalid code')) { statusEl.textContent = 'invalid invite code'; return }
          if (sigData.error.includes('already used')) { /* may be resuming */ }
          else { statusEl.textContent = `invite error: ${sigData.error.slice(0, 60)}`; return }
        }
        if (!sigData.error) {
          const inviteHash = await walletClient.writeContract({
            address: INVITES_ADDRESS, abi: INVITES_ABI,
            functionName: 'useInvite',
            args: [inviteCode, BigInt(sigData.expiry), sigData.nonce, sigData.signature],
            account: authAccount,
          })
          await publicClient.waitForTransactionReceipt({ hash: inviteHash })
        }
      } catch (e) {
        if (e.code === 4001) { statusEl.textContent = t('network.cancelled') + ' -- try again'; return }
        const msg = e.shortMessage || e.message || ''
        if (msg.includes('invalid code')) { statusEl.textContent = 'invalid invite code'; return }
        if (msg.includes('code used')) { /* already used, may be resuming */ }
        else { statusEl.textContent = `invite error: ${msg.slice(0, 60)}`; return }
      }

      // STEP 3: get orchestrator signature + deploy fee
      statusEl.textContent = 'getting registration signature...'
      let signature
      let deployFeeWei
      try {
        const [sigRes, priceRes] = await Promise.all([
          fetch(`/orchestrator/sign-registration?wallet=${window.getWalletAddress()}&domain=${domain}`),
          fetch('/orchestrator/deploy-price'),
        ])
        const sigData = await sigRes.json()
        const priceData = await priceRes.json()
        if (sigData.error) { statusEl.textContent = `signature error: ${sigData.error}`; return }
        signature = sigData.signature
        deployFeeWei = BigInt(Math.ceil(parseFloat(priceData.eth) * 1e18))
      } catch (e) {
        statusEl.textContent = 'could not get registration signature'
        return
      }

      // if sponsored, request deploy fee from orchestrator
      if (isSponsored) {
        statusEl.textContent = 'this invite includes free registration — requesting sponsored deploy...'
        try {
          const spRes = await fetch('/orchestrator/sponsor-deploy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ wallet: window.getWalletAddress(), code: inviteCode }),
          })
          const spData = await spRes.json()
          if (!spData.ok) { statusEl.textContent = `sponsored deploy failed: ${spData.error}`; return }
          // orchestrator already confirmed the tx — no need to double-wait
          statusEl.textContent = spData.alreadyFunded ? 'wallet already funded — proceeding...' : 'sponsored funds confirmed — registering...'
        } catch (e) {
          statusEl.textContent = `sponsored deploy error: ${e.message || 'unknown'}`
          return
        }
      }

      // check balance before register (need deploy fee + gas)
      const balance = await publicClient.getBalance({ address: window.getWalletAddress() })
      if (balance < deployFeeWei + BigInt('500000000000000')) {
        if (isSponsored) {
          statusEl.textContent = 'sponsored funds not yet available — please try again in a moment'
          return
        }
        statusEl.textContent = 'insufficient ETH on Optimism'
        showDeployOptions(domain, window.getWalletAddress(), null, true)
        return
      }

      // STEP 4: register on-chain with deploy fee (domain verified, invite used, signature obtained)
      statusEl.textContent = 'registering on-chain (includes deploy fee)...'
      let regAccount = window.getWalletAddress()
      try {
        if (!await window.ensureOptimism?.()) return
        regAccount = await window.ensureAuthorized?.() || window.getWalletAddress()
        const regWalletClient = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })
        const hash = await regWalletClient.writeContract({
          address: regTarget, abi: regAbi,
          functionName: 'register', args: [domain, signature],
          value: deployFeeWei,
          account: regAccount,
        })
        await publicClient.waitForTransactionReceipt({ hash })
      } catch (e) {
        if (e.code === 4001) { statusEl.textContent = t('network.cancelled') + ' -- try again'; return }
        const msg = e.shortMessage || e.message || ''
        if (!msg.includes('already registered')) {
          statusEl.textContent = t('status.error', { msg: msg.slice(0, 60) }); return
        }
      }

      // Self-claim 10 starter invites — best-effort, never blocks registration.
      // See landing.js for the full rationale (v2 fix for the missing-grant gap).
      try {
        const regWalletClient2 = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })
        const ch = await regWalletClient2.writeContract({
          address: INVITES_ADDRESS,
          abi: [{ name: 'claimInitialInvites', type: 'function', inputs: [], outputs: [], stateMutability: 'nonpayable' }],
          functionName: 'claimInitialInvites',
          args: [],
          account: regAccount,
        })
        await publicClient.waitForTransactionReceipt({ hash: ch })
      } catch (e) {
        console.warn('claimInitialInvites:', e?.shortMessage || e?.message)
      }

      // auto-follow inviter
      try {
        const inviter = await publicClient.readContract({
          address: INVITES_ADDRESS,
          abi: [{ name: 'invitedBy', type: 'function', inputs: [{ type: 'address' }], outputs: [{ type: 'address' }], stateMutability: 'view' }],
          functionName: 'invitedBy', args: [window.getWalletAddress()],
        })
        if (inviter && inviter !== '0x0000000000000000000000000000000000000000') {
          statusEl.textContent = 'following your inviter...'
          if (!await window.ensureOptimism?.()) return
          const followWc = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })
          const fh = await followWc.writeContract({
            address: regTarget, abi: REGISTRY_ABI,
            functionName: 'follow', args: [inviter],
            account: regAccount || window.getWalletAddress(),
          })
          await publicClient.waitForTransactionReceipt({ hash: fh })
        }
      } catch (e) { console.warn('auto-follow:', e?.message) }
    }

    statusEl.textContent = `domain verified, registered ${domain}`
    showDeployOptions(domain, window.getWalletAddress(), null)
  }
}

function appendSponsoredRow(container, code, redeemed = false, publicClient, myAddr, slotsEl) {
  const siteDomain = document.body.dataset.domain || window.location.hostname
  const link = `https://ourpraxis.network/?invite=${code}&from=${encodeURIComponent(siteDomain)}`
  const row = document.createElement('div')
  row.className = 'invite-row'
  row.dataset.code = code
  if (redeemed) {
    row.innerHTML = `
      <span class="invite-code redeemed">${escapeHtml(code.slice(0, 8))}...</span>
      <span class="invite-badge" style="color:var(--dim)">redeemed</span>
    `
  } else {
    row.innerHTML = `
      <span class="invite-code">${escapeHtml(code.slice(0, 8))}...</span>
      <span class="invite-badge sponsored">sponsored</span>
      <button class="invite-action copy-sp-btn">${t('invites.copyLink')}</button>
      <button class="invite-action revoke-sp-btn" style="color:#ef4444">revoke</button>
    `
    row.querySelector('.copy-sp-btn').addEventListener('click', (e) => {
      navigator.clipboard.writeText(link)
      e.target.textContent = t('invites.copied')
      setTimeout(() => { e.target.textContent = t('invites.copyLink') }, 2000)
    })
    row.querySelector('.revoke-sp-btn').addEventListener('click', async (e) => {
      e.target.disabled = true
      e.target.textContent = 'revoking...'
      try {
        const { keccak256, toBytes } = await import('./vendor.js')
        const codeHash = keccak256(toBytes(code))
        if (!await window.ensureOptimism?.()) return
        const currentAccount = await window.ensureAuthorized?.() || myAddr
        const walletClient = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })
        const rh = await walletClient.writeContract({
          address: ARTIST_SPONSOR_ADDR, abi: ARTIST_SPONSOR_ABI,
          functionName: 'revokeInvite', args: [codeHash],
          account: currentAccount,
        })
        await publicClient.waitForTransactionReceipt({ hash: rh })
        // remove from localStorage
        const stored = JSON.parse(localStorage.getItem('praxis-artist-sponsored') || '[]')
        const idx = stored.findIndex(s => s.code === code)
        if (idx >= 0) { stored.splice(idx, 1); localStorage.setItem('praxis-artist-sponsored', JSON.stringify(stored)) }
        row.remove()
        // update slots
        if (slotsEl) {
          try {
            const slots = Number(await publicClient.readContract({
              address: ARTIST_SPONSOR_ADDR, abi: ARTIST_SPONSOR_ABI,
              functionName: 'availableSlots', args: [myAddr],
            }))
            slotsEl.textContent = `available slots: ${slots}`
          } catch {}
        }
      } catch (err) {
        e.target.textContent = err.code === 4001 ? 'cancelled' : 'failed'
        setTimeout(() => { e.target.textContent = 'revoke'; e.target.disabled = false }, 2000)
      }
    })
  }
  container.appendChild(row)
}

// Invite card color palette (matches landing page swatches)
const INVITE_CARD_COLORS = [
  { bg: '#0a0a0a', fg: '#c0c0c0', label: 'black' },
  { bg: '#ffffff', fg: '#1a1a1a', label: 'white' },
  { bg: '#e63946', fg: '#1a1a1a', label: 'red' },
  { bg: '#2563eb', fg: '#1a1a1a', label: 'blue' },
  { bg: '#facc15', fg: '#1a1a1a', label: 'yellow' },
  { bg: '#ec4899', fg: '#1a1a1a', label: 'pink' },
]

function generateInviteCard(bgColor, fgColor, domain, message) {
  const canvas = document.createElement('canvas')
  canvas.width = 600
  canvas.height = 400
  const ctx = canvas.getContext('2d')

  // Background
  ctx.fillStyle = bgColor
  ctx.fillRect(0, 0, 600, 400)

  // Border
  ctx.strokeStyle = fgColor
  ctx.globalAlpha = 0.15
  ctx.lineWidth = 2
  ctx.strokeRect(16, 16, 568, 368)
  ctx.globalAlpha = 1

  // Domain name (large)
  ctx.fillStyle = fgColor
  ctx.font = 'bold 32px "JetBrains Mono", "SF Mono", "Fira Code", "Cascadia Code", monospace'
  ctx.textAlign = 'center'
  ctx.fillText(domain, 300, 140)

  // "invites you to" line
  ctx.globalAlpha = 0.6
  ctx.font = '16px "JetBrains Mono", "SF Mono", "Fira Code", "Cascadia Code", monospace'
  ctx.fillText('invites you to', 300, 180)
  ctx.globalAlpha = 1

  // Personal message
  if (message) {
    ctx.font = 'italic 18px "JetBrains Mono", "SF Mono", "Fira Code", "Cascadia Code", monospace'
    ctx.globalAlpha = 0.8
    // Wrap long messages
    const words = message.split(' ')
    let line = ''
    let y = 230
    for (const word of words) {
      const test = line + (line ? ' ' : '') + word
      if (ctx.measureText(test).width > 480 && line) {
        ctx.fillText(line, 300, y)
        line = word
        y += 28
        if (y > 290) break
      } else {
        line = test
      }
    }
    if (line) ctx.fillText(line, 300, y)
    ctx.globalAlpha = 1
  }

  // Bottom: "praxis" branding
  ctx.font = 'bold 20px "JetBrains Mono", "SF Mono", "Fira Code", "Cascadia Code", monospace'
  ctx.fillText('praxis', 300, 340)

  // Bottom: URL
  ctx.globalAlpha = 0.4
  ctx.font = '12px "JetBrains Mono", "SF Mono", "Fira Code", "Cascadia Code", monospace'
  ctx.fillText('ourpraxis.network', 300, 370)
  ctx.globalAlpha = 1

  return canvas
}

function openInviteCardModal(code) {
  // Remove any existing card modal
  document.getElementById('invite-card-modal')?.remove()

  const siteDomain = document.body.dataset.domain || window.location.hostname

  const overlay = document.createElement('div')
  overlay.id = 'invite-card-modal'
  overlay.style.cssText = 'position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center'
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })

  const modal = document.createElement('div')
  modal.style.cssText = 'background:var(--surface,#111);border:1px solid var(--border,#1a1a1a);border-radius:12px;padding:1.5em;max-width:420px;width:90%;max-height:90vh;overflow-y:auto'

  // Title
  const title = document.createElement('h3')
  title.style.cssText = 'margin:0 0 1em;font-size:1.1em;color:var(--fg)'
  title.textContent = 'create invite card'
  modal.appendChild(title)

  // Color picker
  const colorLabel = document.createElement('p')
  colorLabel.style.cssText = 'color:var(--dim);font-size:0.85em;margin:0 0 0.5em'
  colorLabel.textContent = 'choose a color'
  modal.appendChild(colorLabel)

  const colorRow = document.createElement('div')
  colorRow.style.cssText = 'display:flex;gap:10px;margin-bottom:1em;flex-wrap:wrap'
  let selectedColor = INVITE_CARD_COLORS[5] // default pink
  INVITE_CARD_COLORS.forEach((c, i) => {
    const dot = document.createElement('button')
    dot.style.cssText = `width:32px;height:32px;border-radius:50%;border:2px solid ${i === 5 ? 'var(--fg)' : 'transparent'};cursor:pointer;background:${c.bg};transition:border-color 0.2s`
    dot.title = c.label
    dot.addEventListener('click', () => {
      selectedColor = c
      colorRow.querySelectorAll('button').forEach(b => b.style.borderColor = 'transparent')
      dot.style.borderColor = 'var(--fg)'
    })
    colorRow.appendChild(dot)
  })
  modal.appendChild(colorRow)

  // Message input
  const msgLabel = document.createElement('p')
  msgLabel.style.cssText = 'color:var(--dim);font-size:0.85em;margin:0 0 0.5em'
  msgLabel.textContent = 'personal message (optional)'
  modal.appendChild(msgLabel)

  const msgInput = document.createElement('input')
  msgInput.type = 'text'
  msgInput.placeholder = 'join the network!'
  msgInput.maxLength = 100
  msgInput.style.cssText = 'width:100%;box-sizing:border-box;background:var(--bg,#0a0a0a);color:var(--fg);border:1px solid var(--border,#1a1a1a);border-radius:6px;padding:0.6em 0.8em;font-family:inherit;font-size:0.9em;margin-bottom:1em'
  modal.appendChild(msgInput)

  // Create card button
  const createBtn = document.createElement('button')
  createBtn.className = 'buy-btn'
  createBtn.textContent = 'create card'
  createBtn.style.cssText = 'margin-bottom:1em;width:100%'
  modal.appendChild(createBtn)

  // Preview container (hidden until created)
  const previewContainer = document.createElement('div')
  previewContainer.style.cssText = 'display:none'
  modal.appendChild(previewContainer)

  createBtn.addEventListener('click', () => {
    const canvas = generateInviteCard(selectedColor.bg, selectedColor.fg, siteDomain, msgInput.value.trim())
    const dataUrl = canvas.toDataURL('image/png')

    // Build the themed invite link
    const themeHex = selectedColor.bg.replace('#', '')
    const link = `https://ourpraxis.network/?invite=${code}&from=${encodeURIComponent(siteDomain)}&theme=${themeHex}`

    previewContainer.innerHTML = ''
    previewContainer.style.display = ''

    // Card image
    const img = document.createElement('img')
    img.src = dataUrl
    img.style.cssText = 'width:100%;border-radius:8px;margin-bottom:1em;display:block'
    img.alt = 'invite card'
    previewContainer.appendChild(img)

    // Action buttons row
    const actions = document.createElement('div')
    actions.style.cssText = 'display:flex;gap:0.5em'

    const dlBtn = document.createElement('button')
    dlBtn.className = 'buy-btn'
    dlBtn.style.cssText = 'flex:1'
    dlBtn.textContent = 'download'
    dlBtn.addEventListener('click', () => {
      const a = document.createElement('a')
      a.href = dataUrl
      a.download = `praxis-invite-${code.slice(0, 8)}.png`
      a.click()
    })
    actions.appendChild(dlBtn)

    const copyBtn = document.createElement('button')
    copyBtn.className = 'buy-btn'
    copyBtn.style.cssText = 'flex:1'
    copyBtn.textContent = 'copy link'
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(link)
      copyBtn.textContent = 'copied!'
      setTimeout(() => { copyBtn.textContent = 'copy link' }, 2000)
    })
    actions.appendChild(copyBtn)

    previewContainer.appendChild(actions)

    // Show the link below
    const linkEl = document.createElement('p')
    linkEl.style.cssText = 'color:var(--dim);font-size:0.75em;margin-top:0.75em;word-break:break-all;text-align:center'
    linkEl.textContent = link
    previewContainer.appendChild(linkEl)
  })

  overlay.appendChild(modal)
  document.body.appendChild(overlay)
}

function appendInviteLinkRow(container, code, claimed = false) {
  const siteDomain = document.body.dataset.domain || window.location.hostname
  const row = document.createElement('div')
  row.className = 'invite-row'
  row.dataset.code = code
  if (claimed) {
    // Show disabled card preview for claimed invites
    const canvas = generateInviteCard(INVITE_CARD_COLORS[0].bg, INVITE_CARD_COLORS[0].fg, siteDomain, '')
    row.innerHTML = `
      <div class="invite-card-inline claimed">
        <div class="invite-card-preview"><img src="${canvas.toDataURL('image/png')}" alt="claimed invite" style="width:100%;border-radius:6px;display:block"></div>
      </div>
    `
    container.appendChild(row)
    return
  }

  // Inline invite card with color selector — no modal
  let selectedColor = INVITE_CARD_COLORS[0]
  const themeHex = () => selectedColor.bg.replace('#', '')
  const getLink = () => `https://ourpraxis.network/?invite=${code}&from=${encodeURIComponent(siteDomain)}&theme=${themeHex()}`

  row.innerHTML = `
    <div class="invite-card-inline">
      <div class="invite-card-preview"></div>
      <div class="invite-card-controls">
        <div class="invite-card-colors" style="display:flex;gap:6px;align-items:center;margin:0.75em 0"></div>
        <input type="text" class="invite-card-msg" placeholder="personal message (optional)" maxlength="100" style="width:100%;box-sizing:border-box;background:var(--bg,#0a0a0a);color:var(--fg);border:1px solid var(--border,#1a1a1a);border-radius:4px;padding:0.4em 0.6em;font-family:inherit;font-size:0.8em;margin-bottom:0.5em">
        <div style="display:flex;gap:0.5em">
          <button class="invite-card-copy buy-btn" style="flex:1;font-size:0.8em;padding:0.3em 0.8ch">${t('invites.copyLink')}</button>
          <button class="invite-card-download buy-btn" style="font-size:0.8em;padding:0.3em 0.8ch"><i class="ph ph-download-simple"></i></button>
        </div>
      </div>
    </div>
  `

  const previewEl = row.querySelector('.invite-card-preview')
  const colorsEl = row.querySelector('.invite-card-colors')
  const msgInput = row.querySelector('.invite-card-msg')

  function renderPreview() {
    const canvas = generateInviteCard(selectedColor.bg, selectedColor.fg, siteDomain, msgInput.value.trim())
    previewEl.innerHTML = ''
    const img = document.createElement('img')
    img.src = canvas.toDataURL('image/png')
    img.style.cssText = 'width:100%;border-radius:6px;display:block'
    img.alt = 'invite card'
    previewEl.appendChild(img)
  }

  // Color dots
  INVITE_CARD_COLORS.forEach((c, i) => {
    const dot = document.createElement('button')
    dot.style.cssText = `width:24px;height:24px;border-radius:50%;border:2px solid ${i === 0 ? 'var(--fg)' : 'transparent'};cursor:pointer;background:${c.bg};padding:0;transition:border-color 0.15s`
    dot.title = c.label
    dot.addEventListener('click', () => {
      selectedColor = c
      colorsEl.querySelectorAll('button').forEach(b => b.style.borderColor = 'transparent')
      dot.style.borderColor = 'var(--fg)'
      renderPreview()
    })
    colorsEl.appendChild(dot)
  })

  // Message updates preview (debounced)
  let _msgTimer = null
  msgInput.addEventListener('input', () => {
    if (_msgTimer) clearTimeout(_msgTimer)
    _msgTimer = setTimeout(renderPreview, 300)
  })

  // Copy link
  row.querySelector('.invite-card-copy').addEventListener('click', (e) => {
    navigator.clipboard.writeText(getLink())
    e.target.textContent = t('invites.copied')
    setTimeout(() => { e.target.textContent = t('invites.copyLink') }, 2000)
  })

  // Download card image
  row.querySelector('.invite-card-download').addEventListener('click', () => {
    const canvas = generateInviteCard(selectedColor.bg, selectedColor.fg, siteDomain, msgInput.value.trim())
    const a = document.createElement('a')
    a.href = canvas.toDataURL('image/png')
    a.download = `praxis-invite-${code.slice(0, 8)}.png`
    a.click()
  })

  container.appendChild(row)
  renderPreview()
}

async function openInvitesModal(myAddr, publicClient) {
  // remove any existing modal
  document.getElementById('invites-modal-overlay')?.remove()

  const overlay = document.createElement('div')
  overlay.id = 'invites-modal-overlay'
  overlay.className = 'invites-overlay'

  const dialog = document.createElement('div')
  dialog.className = 'invites-sheet'

  // close button
  const closeBtn = document.createElement('button')
  closeBtn.className = 'invites-close'
  closeBtn.textContent = '\u00d7'
  closeBtn.addEventListener('click', () => {
    overlay.classList.add('closing')
    overlay.addEventListener('animationend', () => overlay.remove(), { once: true })
  })
  overlay.appendChild(closeBtn)

  // title
  const title = document.createElement('h3')
  title.className = 'invites-title'
  title.textContent = t('invites.title')
  dialog.appendChild(title)

  // load invite count
  let count = 0
  try {
    const remaining = await publicClient.readContract({
      address: INVITES_ADDRESS,
      abi: [{ name: 'invitesRemaining', type: 'function', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
      functionName: 'invitesRemaining', args: [myAddr],
    })
    count = Number(remaining)
  } catch {}

  const countEl = document.createElement('p')
  countEl.className = 'invites-count'
  countEl.textContent = t('invites.remaining', { count })
  dialog.appendChild(countEl)

  // --- v2 PraxisInvites: surface migration + initial claim if eligible ---
  // Pre-v2 only useInvite recipients ever received invites. v2 adds a one-time
  // self-claim of `invitesPerRegistration` for any registered artist (initialClaimed),
  // plus a Merkle migration of v1 balances within a 7-day window (claimMigration).
  // Both buttons appear inline so the user discovers them without docs.
  try {
    const [initialClaimed, migrationClaimed, migrationRoot, migrationDeadline] = await Promise.all([
      publicClient.readContract({
        address: INVITES_ADDRESS,
        abi: [{ name: 'initialClaimed', type: 'function', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }], stateMutability: 'view' }],
        functionName: 'initialClaimed', args: [myAddr],
      }).catch(() => true),
      publicClient.readContract({
        address: INVITES_ADDRESS,
        abi: [{ name: 'migrationClaimed', type: 'function', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }], stateMutability: 'view' }],
        functionName: 'migrationClaimed', args: [myAddr],
      }).catch(() => true),
      publicClient.readContract({
        address: INVITES_ADDRESS,
        abi: [{ name: 'migrationRoot', type: 'function', inputs: [], outputs: [{ type: 'bytes32' }], stateMutability: 'view' }],
        functionName: 'migrationRoot',
      }).catch(() => '0x0000000000000000000000000000000000000000000000000000000000000000'),
      publicClient.readContract({
        address: INVITES_ADDRESS,
        abi: [{ name: 'migrationDeadline', type: 'function', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
        functionName: 'migrationDeadline',
      }).catch(() => 0n),
    ])

    const claimContainer = document.createElement('div')
    claimContainer.style.cssText = 'margin:0.5em 0 1em'

    // Migration claim — only if root is set, deadline not passed, and user hasn't claimed
    const migrationOpen = migrationRoot && migrationRoot !== '0x0000000000000000000000000000000000000000000000000000000000000000'
      && Number(migrationDeadline) > Math.floor(Date.now() / 1000)
      && !migrationClaimed
    if (migrationOpen) {
      // Lazily fetch the snapshot JSON and look up this artist's proof
      let entry = null
      try {
        const snap = await fetch('/migration/invites-snapshot.json').then(r => r.ok ? r.json() : null)
        entry = snap?.entries?.find(e => e.artist?.toLowerCase() === myAddr.toLowerCase())
      } catch {}
      if (entry) {
        const migBtn = document.createElement('button')
        migBtn.className = 'buy-btn'
        migBtn.style.cssText = 'display:block;width:100%;margin-bottom:0.5em'
        migBtn.textContent = `claim ${entry.amount} migrated invites from v1`
        const migStatus = document.createElement('p')
        migStatus.style.cssText = 'color:var(--muted,#555);font-size:0.8em;margin:0 0 0.5em'
        migBtn.addEventListener('click', async () => {
          migBtn.disabled = true
          migStatus.textContent = 'claiming...'
          try {
            if (!await window.ensureOptimism?.()) return
            const acct = await window.ensureAuthorized?.() || myAddr
            const wc = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })
            const hash = await wc.writeContract({
              address: INVITES_ADDRESS,
              abi: [{ name: 'claimMigration', type: 'function', inputs: [
                { name: 'artist', type: 'address' },
                { name: 'amount', type: 'uint256' },
                { name: 'proof', type: 'bytes32[]' },
              ], outputs: [], stateMutability: 'nonpayable' }],
              functionName: 'claimMigration',
              args: [entry.artist, BigInt(entry.amount), entry.proof],
              account: acct,
            })
            await publicClient.waitForTransactionReceipt({ hash })
            count += Number(entry.amount)
            countEl.textContent = t('invites.remaining', { count })
            migBtn.remove()
            migStatus.textContent = `claimed ${entry.amount} ✓`
          } catch (e) {
            migStatus.textContent = e.code === 4001 ? 'cancelled' : (e.shortMessage || e.message || '').slice(0, 80)
            migBtn.disabled = false
          }
        })
        claimContainer.appendChild(migBtn)
        claimContainer.appendChild(migStatus)
      }
    }

    // Initial claim — any registered artist who hasn't claimed gets 10
    if (!initialClaimed) {
      const initBtn = document.createElement('button')
      initBtn.className = 'buy-btn'
      initBtn.style.cssText = 'display:block;width:100%;margin-bottom:0.5em'
      initBtn.textContent = 'claim 10 starter invites'
      const initStatus = document.createElement('p')
      initStatus.style.cssText = 'color:var(--muted,#555);font-size:0.8em;margin:0 0 0.5em'
      initBtn.addEventListener('click', async () => {
        initBtn.disabled = true
        initStatus.textContent = 'claiming...'
        try {
          if (!await window.ensureOptimism?.()) return
          const acct = await window.ensureAuthorized?.() || myAddr
          const wc = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })
          const hash = await wc.writeContract({
            address: INVITES_ADDRESS,
            abi: [{ name: 'claimInitialInvites', type: 'function', inputs: [], outputs: [], stateMutability: 'nonpayable' }],
            functionName: 'claimInitialInvites',
            args: [],
            account: acct,
          })
          await publicClient.waitForTransactionReceipt({ hash })
          count += 10
          countEl.textContent = t('invites.remaining', { count })
          initBtn.remove()
          initStatus.textContent = 'claimed 10 ✓'
          // Dynamically add the generate invite section without reopening
          if (!document.getElementById('invite-gen-section')) {
            const genSection = document.createElement('div')
            genSection.id = 'invite-gen-section'
            genSection.style.cssText = 'margin-top:1em'
            const hint = document.createElement('p')
            hint.style.cssText = 'color:var(--dim);font-size:0.85em;margin-bottom:0.75em'
            hint.textContent = t('invites.shareLink')
            genSection.appendChild(hint)
            const genBtn = document.createElement('button')
            genBtn.className = 'buy-btn'
            genBtn.textContent = t('invites.generate')
            genBtn.addEventListener('click', async () => {
              genBtn.disabled = true
              genBtn.textContent = 'generating...'
              try {
                const code = crypto.randomUUID?.() || Math.random().toString(36).slice(2)
                const { keccak256, toBytes } = await import('./vendor.js')
                const codeHash = keccak256(toBytes(code))
                const acct = await window.ensureAuthorized?.() || window.getWalletAddress()
                const wc = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })
                const hash = await wc.writeContract({
                  address: INVITES_ADDRESS,
                  abi: [{ name: 'createInvite', type: 'function', inputs: [{ type: 'bytes32' }], outputs: [], stateMutability: 'nonpayable' }],
                  functionName: 'createInvite', args: [codeHash], account: acct,
                })
                await publicClient.waitForTransactionReceipt({ hash })
                const siteDomain = document.body.dataset.domain || window.location.hostname
                const link = `https://ourpraxis.network/?invite=${code}&from=${encodeURIComponent(siteDomain)}`
                genBtn.textContent = t('invites.generate')
                genBtn.disabled = false
                // Show the link using shared row builder
                appendInviteLinkRow(genSection, code)
                count--
                countEl.textContent = t('invites.remaining', { count })
              } catch (e) {
                genBtn.textContent = e.code === 4001 ? 'cancelled' : 'error'
                genBtn.disabled = false
                setTimeout(() => { genBtn.textContent = t('invites.generate') }, 2000)
              }
            })
            genSection.appendChild(genBtn)
            claimContainer.after(genSection)
          }
        } catch (e) {
          initStatus.textContent = e.code === 4001 ? 'cancelled' : (e.shortMessage || e.message || '').slice(0, 80)
          initBtn.disabled = false
        }
      })
      claimContainer.appendChild(initBtn)
      claimContainer.appendChild(initStatus)
    }

    if (claimContainer.children.length > 0) {
      dialog.appendChild(claimContainer)
    }
  } catch (e) {
    console.warn('claim section:', e?.message)
  }

  if (count > 0) {
    const hint = document.createElement('p')
    hint.style.cssText = 'color:var(--dim,#666);font-size:0.85em;margin-bottom:1em'
    hint.textContent = t('invites.shareLink')
    dialog.appendChild(hint)

    const genBtn = document.createElement('button')
    genBtn.className = 'buy-btn'
    genBtn.style.cssText = 'margin-bottom:1em'
    genBtn.textContent = t('invites.generate')
    dialog.appendChild(genBtn)

    const statusEl = document.createElement('p')
    statusEl.style.cssText = 'color:var(--muted,#555);font-size:0.85em;margin-top:0.5em'
    dialog.appendChild(statusEl)

    const linksEl = document.createElement('div')
    linksEl.className = 'invite-cards-scroll'
    linksEl.style.cssText = 'margin-top:0.5em'
    dialog.appendChild(linksEl)

    // Clear stale invites from old contract deploys
    const INVITES_CONTRACT_KEY = 'praxis-invites-contract'
    if (localStorage.getItem(INVITES_CONTRACT_KEY) !== INVITES_ADDR) {
      localStorage.removeItem('praxis-invites')
      localStorage.setItem(INVITES_CONTRACT_KEY, INVITES_ADDR)
    }

    // render stored invite links — check on-chain claimed status
    const storedInvites = JSON.parse(localStorage.getItem('praxis-invites') || '[]')
    // batch check codeUsed status for all stored invites
    const claimedSet = new Set()
    try {
      const { keccak256, toBytes } = await import('./vendor.js')
      const checks = storedInvites.map(item =>
        publicClient.readContract({
          address: INVITES_ADDRESS,
          abi: [{ name: 'codeUsed', type: 'function', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'bool' }], stateMutability: 'view' }],
          functionName: 'codeUsed', args: [keccak256(toBytes(item.code))],
        }).then(used => { if (used) claimedSet.add(item.code) }).catch(() => {})
      )
      await Promise.all(checks)
      // persist claimed status to localStorage
      let dirty = false
      for (const item of storedInvites) {
        if (claimedSet.has(item.code) && !item.used) { item.used = true; dirty = true }
      }
      if (dirty) localStorage.setItem('praxis-invites', JSON.stringify(storedInvites))
    } catch {}
    const VISIBLE_LINKS = 5
    const recentInvites = storedInvites.slice(-VISIBLE_LINKS)
    const hiddenCount = storedInvites.length - recentInvites.length
    if (hiddenCount > 0) {
      const toggle = document.createElement('button')
      toggle.style.cssText = 'background:none;border:none;color:var(--muted,#555);font-family:inherit;font-size:0.8em;cursor:pointer;padding:0.3em 0;margin-bottom:0.5em'
      toggle.textContent = `${hiddenCount} older invite${hiddenCount > 1 ? 's' : ''}`
      const olderContainer = document.createElement('div')
      olderContainer.className = 'invite-cards-scroll'
      olderContainer.style.display = 'none'
      for (const item of storedInvites.slice(0, hiddenCount)) {
        appendInviteLinkRow(olderContainer, item.code, claimedSet.has(item.code))
      }
      toggle.addEventListener('click', () => {
        const showing = olderContainer.style.display !== 'none'
        olderContainer.style.display = showing ? 'none' : ''
        toggle.textContent = showing ? `${hiddenCount} older invite${hiddenCount > 1 ? 's' : ''}` : 'hide older'
      })
      linksEl.appendChild(toggle)
      linksEl.appendChild(olderContainer)
    }
    for (const item of recentInvites) {
      appendInviteLinkRow(linksEl, item.code, claimedSet.has(item.code))
    }

    genBtn.addEventListener('click', async () => {
      genBtn.disabled = true
      statusEl.textContent = t('network.creating')
      try {
        const { keccak256, toBytes } = await import('./vendor.js')
        const code = crypto.randomUUID().replace(/-/g, '').slice(0, 12)
        const codeHash = keccak256(toBytes(code))
        if (!await window.ensureOptimism?.()) return
        const currentAccount = await window.ensureAuthorized?.() || myAddr
        const walletClient = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })
        const hash = await walletClient.writeContract({
          address: INVITES_ADDRESS,
          abi: [{ name: 'createInvite', type: 'function', inputs: [{ type: 'bytes32' }], outputs: [], stateMutability: 'nonpayable' }],
          functionName: 'createInvite', args: [codeHash],
          account: currentAccount,
        })
        await publicClient.waitForTransactionReceipt({ hash })

        const invites = JSON.parse(localStorage.getItem('praxis-invites') || '[]')
        invites.push({ code, created: Date.now(), used: false })
        // cap at 100 entries — prune oldest claimed invites first
        if (invites.length > 100) {
          const claimedIdx = invites.findIndex(i => i.used)
          invites.splice(claimedIdx >= 0 ? claimedIdx : 0, invites.length - 100)
        }
        localStorage.setItem('praxis-invites', JSON.stringify(invites))

        appendInviteLinkRow(linksEl, code)
        statusEl.textContent = ''
        // update remaining count
        count--
        countEl.textContent = t('invites.remaining', { count })
      } catch (e) {
        statusEl.textContent = e.code === 4001 ? t('status.cancelled') : t('status.error', { msg: (e.shortMessage || e.message).slice(0, 60) })
      }
      genBtn.disabled = false
    })
  } else {
    const noInvites = document.createElement('p')
    noInvites.style.cssText = 'color:var(--dim,#666);font-size:0.85em'
    noInvites.textContent = t('invites.noInvites')
    dialog.appendChild(noInvites)

    // still show stored links with claimed status
    const storedInvites = JSON.parse(localStorage.getItem('praxis-invites') || '[]')
    if (storedInvites.length > 0) {
      const linksEl = document.createElement('div')
      linksEl.style.cssText = 'margin-top:1em'
      // check on-chain status
      const claimedSet2 = new Set()
      try {
        const { keccak256, toBytes } = await import('./vendor.js')
        await Promise.all(storedInvites.map(item =>
          publicClient.readContract({
            address: INVITES_ADDRESS,
            abi: [{ name: 'codeUsed', type: 'function', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'bool' }], stateMutability: 'view' }],
            functionName: 'codeUsed', args: [keccak256(toBytes(item.code))],
          }).then(used => { if (used) claimedSet2.add(item.code) }).catch(() => {})
        ))
      } catch {}
      for (const item of storedInvites.slice(-5)) {
        appendInviteLinkRow(linksEl, item.code, claimedSet2.has(item.code))
      }
      dialog.appendChild(linksEl)
    }
  }

  // --- Artist-sponsored invites (any registered artist can sponsor) ---
  {
    const divider = document.createElement('hr')
    divider.style.cssText = 'border:none;border-top:1px solid #333;margin:1.5em 0'
    dialog.appendChild(divider)

    const sponsorTitle = document.createElement('h4')
    sponsorTitle.style.cssText = 'color:var(--accent,#00ff41);margin:0 0 0.5em'
    sponsorTitle.textContent = 'sponsor an invite'
    dialog.appendChild(sponsorTitle)

    const sponsorHint = document.createElement('p')
    sponsorHint.style.cssText = 'color:var(--dim,#666);font-size:0.85em;margin-bottom:1em'
    sponsorHint.textContent = 'pay the deploy fee so someone you invite can register for free'
    dialog.appendChild(sponsorHint)

    // show available slots
    const slotsEl = document.createElement('p')
    slotsEl.style.cssText = 'color:var(--fg,#c0c0c0);font-size:0.85em;margin-bottom:0.5em'
    dialog.appendChild(slotsEl)

    let availableSlots = 0
    try {
      availableSlots = Number(await publicClient.readContract({
        address: ARTIST_SPONSOR_ADDR, abi: ARTIST_SPONSOR_ABI,
        functionName: 'availableSlots', args: [myAddr],
      }))
    } catch {}
    slotsEl.textContent = `available slots: ${availableSlots}`

    const sponsorStatus = document.createElement('p')
    sponsorStatus.style.cssText = 'color:var(--muted,#555);font-size:0.85em;margin-top:0.5em'
    dialog.appendChild(sponsorStatus)

    const sponsorLinksEl = document.createElement('div')
    sponsorLinksEl.style.cssText = 'margin-top:0.5em'
    dialog.appendChild(sponsorLinksEl)

    // Clear stale sponsored invites from old contract deploys
    const SPONSORED_CONTRACT_KEY = 'praxis-sponsored-contract'
    const currentSponsoredAddr = ARTIST_SPONSOR_ADDR || ''
    if (localStorage.getItem(SPONSORED_CONTRACT_KEY) !== currentSponsoredAddr) {
      localStorage.removeItem('praxis-artist-sponsored')
      localStorage.setItem(SPONSORED_CONTRACT_KEY, currentSponsoredAddr)
    }

    // render stored artist-sponsored invites
    const storedSponsored = JSON.parse(localStorage.getItem('praxis-artist-sponsored') || '[]')
    const { keccak256: k256, toBytes: tb } = await import('./vendor.js')
    // check redeemed status
    const redeemedSet = new Set()
    try {
      await Promise.all(storedSponsored.map(item =>
        publicClient.readContract({
          address: ARTIST_SPONSOR_ADDR, abi: ARTIST_SPONSOR_ABI,
          functionName: 'redeemed', args: [k256(tb(item.code))],
        }).then(used => { if (used) redeemedSet.add(item.code) }).catch(() => {})
      ))
    } catch {}
    for (const item of storedSponsored.slice(-5)) {
      appendSponsoredRow(sponsorLinksEl, item.code, redeemedSet.has(item.code), publicClient, myAddr, slotsEl)
    }

    // --- v3: read sponsorAmount + maxDomainBudget on chain so the UX shows the
    // accurate cap and total. Falls back to safe defaults if RPC is flaky.
    let sponsorAmountWei = BigInt('5200000000000000') // 0.0052 ETH default
    let maxDomainBudgetWei = 0n
    try {
      const [a, m] = await Promise.all([
        publicClient.readContract({ address: ARTIST_SPONSOR_ADDR, abi: ARTIST_SPONSOR_ABI, functionName: 'sponsorAmount' }),
        publicClient.readContract({ address: ARTIST_SPONSOR_ADDR, abi: ARTIST_SPONSOR_ABI, functionName: 'maxDomainBudget' }),
      ])
      sponsorAmountWei = a
      maxDomainBudgetWei = m
    } catch {}

    // Convert wei → USD via the shared fiat helper (cached + rate-limited)
    let ethPriceUsd = 4000
    try {
      const { getEthPrices } = await import('./fiat.js')
      const prices = await getEthPrices()
      if (prices?.usd) ethPriceUsd = Number(prices.usd)
    } catch {}
    const formatEth = wei => (Number(wei) / 1e18).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
    const formatUsd = wei => '$' + ((Number(wei) / 1e18) * ethPriceUsd).toFixed(2)

    // --- Domain budget toggle ---
    // Off by default if the contract has maxDomainBudget=0 (feature disabled)
    const budgetRow = document.createElement('div')
    budgetRow.style.cssText = 'margin:0.75em 0;padding:0.6em 1ch;border:1px solid var(--border);display:flex;align-items:center;gap:0.75ch;flex-wrap:wrap'
    const budgetEnabled = maxDomainBudgetWei > 0n
    budgetRow.innerHTML = `
      <label style="display:flex;align-items:center;gap:0.5ch;cursor:${budgetEnabled ? 'pointer' : 'default'};color:${budgetEnabled ? 'var(--fg)' : 'var(--dim)'};font-size:0.9em">
        <input type="checkbox" id="sponsor-include-domain" ${budgetEnabled ? '' : 'disabled'}>
        <span>also cover a domain</span>
      </label>
      <span id="sponsor-budget-hint" style="color:var(--muted);font-size:0.8em">
        ${budgetEnabled ? `up to ${formatUsd(maxDomainBudgetWei)} (${formatEth(maxDomainBudgetWei)} ETH) extra per slot` : 'domain sponsorship disabled'}
      </span>
    `
    dialog.appendChild(budgetRow)

    // deposit + sponsor button
    const sponsorBtn = document.createElement('button')
    sponsorBtn.className = 'buy-btn'
    sponsorBtn.style.cssText = 'margin-top:0.5em;width:100%'
    function refreshSponsorBtnLabel() {
      const includeDomain = budgetEnabled && document.getElementById('sponsor-include-domain')?.checked
      const budget = includeDomain ? maxDomainBudgetWei : 0n
      const total = sponsorAmountWei + budget
      sponsorBtn.textContent = `sponsor invite (${formatEth(total)} ETH${includeDomain ? ' incl. domain' : ''})`
    }
    refreshSponsorBtnLabel()
    budgetRow.querySelector('#sponsor-include-domain')?.addEventListener('change', refreshSponsorBtnLabel)
    dialog.appendChild(sponsorBtn)

    sponsorBtn.addEventListener('click', async () => {
      sponsorBtn.disabled = true
      sponsorStatus.textContent = 'depositing...'
      try {
        const { keccak256, toBytes } = await import('./vendor.js')
        if (!await window.ensureOptimism?.()) return
        const currentAccount = await window.ensureAuthorized?.() || myAddr
        const walletClient = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })

        // v3 deposit: 1 slot = sponsorAmount (deploy fee + gas) + optional domainBudget
        const includeDomain = budgetEnabled && document.getElementById('sponsor-include-domain')?.checked
        const domainBudget = includeDomain ? maxDomainBudgetWei : 0n
        const depositValue = sponsorAmountWei + domainBudget
        const dh = await walletClient.writeContract({
          address: ARTIST_SPONSOR_ADDR, abi: ARTIST_SPONSOR_ABI,
          functionName: 'deposit', args: [1n, domainBudget], value: depositValue,
          account: currentAccount,
        })
        sponsorStatus.textContent = 'confirming deposit...'
        await publicClient.waitForTransactionReceipt({ hash: dh })

        // generate code + hash, then sponsorInvite + createInvite
        const code = crypto.randomUUID().replace(/-/g, '').slice(0, 12)
        const codeHash = keccak256(toBytes(code))

        sponsorStatus.textContent = 'registering sponsored invite...'
        const sh = await walletClient.writeContract({
          address: ARTIST_SPONSOR_ADDR, abi: ARTIST_SPONSOR_ABI,
          functionName: 'sponsorInvite', args: [codeHash],
          account: currentAccount,
        })
        await publicClient.waitForTransactionReceipt({ hash: sh })
        // NOTE: previously we ALSO called createInvite() on PraxisInvites here so the
        // landing page would pre-validate the code. That dual-registration created a
        // failure mode where if the friend's later registration step failed, the code
        // got burned on PraxisInvites and was forever unusable, even though
        // ArtistSponsoredInvites.activeSponsor still said it was redeemable.
        // Sponsored codes now ONLY exist in ArtistSponsoredInvites — landing.js skips
        // PraxisInvites entirely for sponsored codes (see landing.js comment).

        // store locally
        const sponsored = JSON.parse(localStorage.getItem('praxis-artist-sponsored') || '[]')
        sponsored.push({ code, created: Date.now() })
        if (sponsored.length > 50) sponsored.splice(0, sponsored.length - 50)
        localStorage.setItem('praxis-artist-sponsored', JSON.stringify(sponsored))

        appendSponsoredRow(sponsorLinksEl, code, false, publicClient, myAddr, slotsEl)
        sponsorStatus.textContent = ''

        // update slots
        try {
          availableSlots = Number(await publicClient.readContract({
            address: ARTIST_SPONSOR_ADDR, abi: ARTIST_SPONSOR_ABI,
            functionName: 'availableSlots', args: [myAddr],
          }))
          slotsEl.textContent = `available slots: ${availableSlots}`
        } catch {}
      } catch (e) {
        sponsorStatus.textContent = e.code === 4001 ? 'cancelled' : `error: ${(e.shortMessage || e.message || '').slice(0, 60)}`
      }
      sponsorBtn.disabled = false
    })
  }

  // --- Sponsored invites admin section (deployer/treasury only) ---
  const TREASURY_ADDR = '0x46db55ad42da6ba3c29a3c1522ebbf8e16960725'
  if (myAddr === TREASURY_ADDR) {
    const divider = document.createElement('hr')
    divider.style.cssText = 'border:none;border-top:1px solid #333;margin:1.5em 0'
    dialog.appendChild(divider)

    const sponsoredTitle = document.createElement('h4')
    sponsoredTitle.style.cssText = 'color:var(--accent,#00ff41);margin:0 0 0.75em'
    sponsoredTitle.textContent = 'sponsored invites'
    dialog.appendChild(sponsoredTitle)

    const sponsoredHint = document.createElement('p')
    sponsoredHint.style.cssText = 'color:var(--dim,#666);font-size:0.85em;margin-bottom:1em'
    sponsoredHint.textContent = 'create invite codes that cover the deploy fee for new artists'
    dialog.appendChild(sponsoredHint)

    // auth helper — sign a message to prove deployer identity
    let _sponsoredAuthCache = null
    async function getSponsoredAuth() {
      if (_sponsoredAuthCache && Date.now() - _sponsoredAuthCache.ts < 4 * 60 * 1000) return _sponsoredAuthCache
      // Ensure wallet is unlocked — prompts password for embedded wallet
      const authedAddr = await window.ensureAuthorized?.()
      if (!authedAddr) throw new Error('unlock your wallet to continue')
      const ts = Date.now()
      const message = `sponsored-admin:${ts}`
      let signature
      try {
        if (getWalletProvider()?.isPraxis) {
          signature = await getWalletProvider().request({ method: 'personal_sign', params: [message, authedAddr] })
        } else {
          const walletClient = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })
          signature = await walletClient.signMessage({ account: authedAddr, message })
        }
      } catch (e) {
        // If signing fails (session expired mid-flow), retry ensureAuthorized once
        const retryAddr = await window.ensureAuthorized?.()
        if (!retryAddr) throw new Error('unlock your wallet to continue')
        if (getWalletProvider()?.isPraxis) {
          signature = await getWalletProvider().request({ method: 'personal_sign', params: [message, retryAddr] })
        } else {
          const walletClient = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })
          signature = await walletClient.signMessage({ account: retryAddr, message })
        }
      }
      _sponsoredAuthCache = { wallet: (authedAddr || myAddr).toLowerCase(), signature, message, ts }
      return _sponsoredAuthCache
    }

    // list container
    const sponsoredListEl = document.createElement('div')
    sponsoredListEl.style.cssText = 'margin-bottom:1em'
    dialog.appendChild(sponsoredListEl)

    const sponsoredStatus = document.createElement('p')
    sponsoredStatus.style.cssText = 'color:var(--muted,#555);font-size:0.85em'
    dialog.appendChild(sponsoredStatus)

    async function loadSponsoredCodes() {
      sponsoredListEl.innerHTML = ''
      sponsoredStatus.textContent = 'loading...'
      try {
        let auth
        try {
          auth = await getSponsoredAuth()
        } catch (authErr) {
          sponsoredStatus.textContent = authErr.message || 'unlock wallet to view'
          return
        }
        const r = await fetch('/api/sponsored-invites', {
          headers: { 'x-wallet': auth.wallet, 'x-signature': auth.signature, 'x-message': auth.message },
        })
        const data = await r.json()
        if (data.error) { sponsoredStatus.textContent = data.error; return }
        const codes = Object.entries(data.invites || {})
        if (codes.length === 0) { sponsoredStatus.textContent = 'no sponsored codes yet'; return }
        sponsoredStatus.textContent = `${codes.length} code${codes.length !== 1 ? 's' : ''}`
        for (const [code, info] of codes) {
          const row = document.createElement('div')
          row.className = 'invite-row'
          const used = info.uses >= info.maxUses
          row.innerHTML = `
            <span class="invite-code${used ? ' redeemed' : ''}">${code.slice(0, 8)}...</span>
            <span class="invite-badge" style="color:var(--dim)">${info.uses}/${info.maxUses}</span>
            ${used ? '' : '<button class="invite-action copy-admin-btn">copy link</button>'}
          `
          if (!used) {
            row.querySelector('.copy-admin-btn').addEventListener('click', (e) => {
              const fromDomain = document.body.dataset.domain || window.location.hostname
              navigator.clipboard.writeText(`https://ourpraxis.network/?invite=${code}&from=${encodeURIComponent(fromDomain)}`)
              e.target.textContent = 'copied'
              setTimeout(() => { e.target.textContent = 'copy link' }, 2000)
            })
          }
          sponsoredListEl.appendChild(row)
        }
      } catch (e) {
        sponsoredStatus.textContent = e.code === 4001 ? 'cancelled' : `error: ${(e.message || '').slice(0, 60)}`
      }
    }

    // create form
    const formEl = document.createElement('div')
    formEl.style.cssText = 'margin-top:1em;display:flex;flex-direction:column;gap:0.5em'
    formEl.innerHTML = `
      <button class="buy-btn" id="sponsored-create-btn" style="width:100%">generate sponsored link</button>
    `
    dialog.appendChild(formEl)

    formEl.querySelector('#sponsored-create-btn').addEventListener('click', async () => {
      const btn = formEl.querySelector('#sponsored-create-btn')
      btn.disabled = true
      sponsoredStatus.textContent = 'creating...'
      try {
        const codes = [crypto.randomUUID().replace(/-/g, '').slice(0, 10)]
        const maxUses = 1
        const auth = await getSponsoredAuth()
        const r = await fetch('/api/sponsored-invites', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-wallet': auth.wallet,
            'x-signature': auth.signature,
            'x-message': auth.message,
          },
          body: JSON.stringify({ codes, maxUses }),
        })
        const data = await r.json()
        if (data.error) { sponsoredStatus.textContent = data.error; return }
        sponsoredStatus.textContent = ''
        await loadSponsoredCodes()
      } catch (e) {
        sponsoredStatus.textContent = e.code === 4001 ? 'cancelled' : `error: ${(e.message || '').slice(0, 60)}`
      }
      btn.disabled = false
    })

    // load codes on open
    loadSponsoredCodes()
  }

  overlay.appendChild(dialog)
  document.body.appendChild(overlay)

  // close on overlay click outside sheet
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.classList.add('closing')
      overlay.addEventListener('animationend', () => overlay.remove(), { once: true })
    }
  })

  // close on Escape
  const onKey = (e) => {
    if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey) }
  }
  document.addEventListener('keydown', onKey)
}

function showDeployOptions(domain, wallet, txHash, onrampOnly = false) {
  // remove existing deploy section if present
  const existing = document.getElementById('deploy-section')
  if (existing) existing.remove()

  const html = `
    <div id="deploy-section" style="margin-top:2em;border-top:1px solid #333;padding-top:2em">
      <h3>deploy your site</h3>
      <div style="margin-bottom:1.5em">
        <label style="display:block;margin-bottom:1em;cursor:pointer">
          <input type="radio" name="deploy-method" value="hosted" checked style="margin-right:0.5em">
          host it for me (deploy fee paid on-chain)
        </label>
        <label style="display:block;cursor:pointer">
          <input type="radio" name="deploy-method" value="self" style="margin-right:0.5em">
          i'll self-host (clone repo, follow README)
        </label>
      </div>

      <div id="hosted-form">
        <div style="display:grid;gap:1em;max-width:400px">
          <input type="text" id="deploy-name" placeholder="display name" style="background:#1a1a1a;border:1px solid #333;color:#c0c0c0;font-family:inherit;font-size:1em;padding:0.5em 1ch">
          <textarea id="deploy-bio" placeholder="bio (optional)" rows="3" style="background:#1a1a1a;border:1px solid #333;color:#c0c0c0;font-family:inherit;font-size:1em;padding:0.5em 1ch;resize:vertical"></textarea>
          <div style="border:1px solid #1a1a1a;padding:1em;margin-top:0.5em">
            <p style="color:var(--accent);margin-bottom:0.5em">deploy fee included in registration</p>
            <p style="color:var(--muted);font-size:0.85em;margin-bottom:0.75em">your site stays live forever.</p>
            <button class="buy-btn" id="pay-deploy-btn">deploy</button>
            <div id="onramp-options" style="display:${onrampOnly ? 'block' : 'none'};margin-top:1em;border-top:1px solid var(--border);padding-top:1em">
              <p style="color:var(--muted);font-size:0.85em;margin-bottom:0.75em">need ETH? fund your wallet first:</p>
              <button class="buy-btn" id="onramp-peer-btn">fund with peer</button>
              <p id="onramp-status" style="color:var(--muted);font-size:0.85em;margin-top:0.5em"></p>
            </div>
          </div>
        </div>
        <p id="deploy-status" style="color:#666;margin-top:1em"></p>
      </div>

      <div id="selfhost-info" style="display:none">
        <p style="color:#999">1. fork the repo</p>
        <p style="color:#999">2. edit site.json with your info</p>
        <p style="color:#999">3. deploy on your server</p>
        <p style="margin-top:1em"><a href="https://github.com/taayyohh/praxis" style="color:#c0c0c0">github.com/taayyohh/praxis</a></p>
      </div>
    </div>
  `
  networkData.insertAdjacentHTML('beforeend', html)

  // wire onramp button (always available)
  document.getElementById('onramp-peer-btn')?.addEventListener('click', async () => {
    const onrampStatus = document.getElementById('onramp-status')
    onrampStatus.textContent = 'opening peer...'
    try {
      const ok = await window.peerOnrampOptimism?.(window.getWalletAddress(), 12)
      onrampStatus.textContent = ok ? 'funded -- click deploy' : t('network.cancelled')
    } catch (e) { onrampStatus.textContent = t('status.error', { msg: e.message }) }
  })

  // toggle between hosted and self-host
  document.querySelectorAll('input[name="deploy-method"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const hosted = document.querySelector('input[name="deploy-method"]:checked').value === 'hosted'
      document.getElementById('hosted-form').style.display = hosted ? 'block' : 'none'
      document.getElementById('selfhost-info').style.display = hosted ? 'none' : 'block'
    })
  })

  // deploy button handler — payment already happened on-chain via register()
  document.getElementById('pay-deploy-btn').addEventListener('click', async () => {
    const name = document.getElementById('deploy-name').value.trim()
    const bio = document.getElementById('deploy-bio').value.trim()
    const deployStatus = document.getElementById('deploy-status')
    const deployBtn = document.getElementById('pay-deploy-btn')

    const addr = window.getWalletAddress?.()
    if (!addr) {
      await window.connectWallet?.()
      if (!window.getWalletAddress?.()) { deployStatus.textContent = t('status.connectWallet'); return }
    }

    deployBtn.disabled = true

    // sign a message to prove wallet ownership
    deployStatus.textContent = 'signing wallet verification...'
    let signature, message
    try {
      const signAccount = await window.ensureAuthorized?.() || window.getWalletAddress()
      const walletClient = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })
      message = `deploy ${domain} at ${Date.now()}`
      signature = await walletClient.signMessage({ account: signAccount, message })
    } catch (e) {
      deployStatus.textContent = e.code === 4001 ? t('network.cancelled') + ' -- click to try again' : `signing error: ${(e.shortMessage || e.message).slice(0, 60)}`
      deployBtn.disabled = false
      return
    }

    // deploy — orchestrator verifies on-chain registration (which proves payment)
    deployStatus.textContent = 'deploying...'
    try {
      const res = await fetch('/orchestrator/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet, domain, name, bio, signature, message }),
      })
      const data = await res.json()

      if (data.error) {
        deployStatus.textContent = t('status.error', { msg: data.error })
        deployBtn.disabled = false
        return
      }

      // success — show result
      document.getElementById('hosted-form').innerHTML = `
        <div style="border:1px solid #333;padding:1.5em;margin-top:1em">
          <p style="color:#fff;margin-bottom:1em">your site is live</p>
          <p><strong>url:</strong> <a href="${escapeHtml(data.siteUrl)}" style="color:#c0c0c0">${escapeHtml(data.siteUrl)}</a></p>
          <p><strong>admin secret:</strong> <code style="background:#1a1a1a;padding:0.2em 0.5em;font-size:0.9em;word-break:break-all">${escapeHtml(data.adminSecret)}</code></p>
          <p style="color:#999;margin-top:0.5em;font-size:0.9em">save your admin secret — you need it to edit your site at ${escapeHtml(domain)}/admin</p>

          <div style="margin-top:1.5em;border-top:1px solid #333;padding-top:1em">
            <p style="color:#fff;margin-bottom:0.5em">DNS setup</p>
            <p style="color:#999">point your domain to: <code style="background:#1a1a1a;padding:0.2em 0.5em">${escapeHtml(data.serverIp)}</code></p>
            <p style="color:#999;font-size:0.9em;margin-top:0.5em">A record: @ &rarr; ${escapeHtml(data.serverIp)}</p>
            <p style="color:#999;font-size:0.9em">A record: www &rarr; ${escapeHtml(data.serverIp)}</p>
          </div>
        </div>
      `
    } catch (err) {
      deployStatus.textContent = t('status.error', { msg: err.message })
      deployBtn.disabled = false
    }
  })
}
