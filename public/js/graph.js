import { F } from './fragments.js'
import { query } from './ponder.js'
import { resolveAddresses, registerPage } from './utils.js'

registerPage('graph-container', () => {
  const graphContainer = document.getElementById('graph-container')
  if (graphContainer.offsetParent !== null) initGraph()
})

// allow external trigger (e.g., from network.js toggle)
window.initGraph = initGraph

// tear down the graph when navigating away so stray pointer state / listeners
// don't leak across SPA pages (e.g. an isPanning flag stuck from a mobile tap
// can make the canvas act as an invisible drag zone on the next page).
window.addEventListener('spa-navigate', () => {
  // if the graph-container no longer exists in the new DOM, abort old listeners
  const stillPresent = document.getElementById('graph-container')
  if (!stillPresent && _graphAbort) {
    try { _graphAbort.abort() } catch {}
    _graphAbort = null
  }
})

let _graphAbort = null

async function initGraph() {
  const container = document.getElementById('graph-container')
  if (!container) return

  // abort previous instance to prevent listener accumulation
  if (_graphAbort) _graphAbort.abort()
  _graphAbort = new AbortController()
  const signal = _graphAbort.signal
  const canvas = document.getElementById('graph-canvas')
  const statusEl = document.getElementById('graph-status')
  const registryAddress = container.dataset.registry

  if (!registryAddress) { statusEl.textContent = 'registry not configured'; return }

  const ctx = canvas.getContext('2d')
  const dpr = window.devicePixelRatio || 1

  // Allow native scroll/tap gestures to pass through the canvas on touch
  // devices. Without this, mobile browsers can get confused about who owns
  // a drag gesture — especially when combined with our mousedown->pan logic,
  // which can leave the canvas in a "panning" state that swallows subsequent
  // taps. `manipulation` disables double-tap zoom but allows scroll + click.
  try { canvas.style.touchAction = 'manipulation' } catch {}

  function resize() {
    const rect = canvas.parentElement.getBoundingClientRect()
    canvas.width = rect.width * dpr
    canvas.height = 500 * dpr
    canvas.style.width = rect.width + 'px'
    canvas.style.height = '500px'
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0) // reset then scale (prevents compound scaling)
  }
  resize()

  const W = canvas.width / dpr
  const H = canvas.height / dpr

  // --- ego-graph state ---
  let nodes = []
  let edges = []
  let addrToIdx = {}
  let centerAddr = null
  let maxHops = 2
  let hoveredNode = null
  let degrees = new Map()
  let iteration = 0
  const maxIter = 150
  let _simulating = false
  let _rafId = null

  // --- pan/zoom state ---
  let panX = 0, panY = 0, zoom = 1
  let isPanning = false, panStartX = 0, panStartY = 0

  // --- hover spatial index ---
  const CELL_SIZE = 50
  let hoverGrid = {}

  function rebuildHoverGrid() {
    hoverGrid = {}
    for (let i = 0; i < nodes.length; i++) {
      const cx = Math.floor(nodes[i].x / CELL_SIZE)
      const cy = Math.floor(nodes[i].y / CELL_SIZE)
      const key = `${cx},${cy}`
      if (!hoverGrid[key]) hoverGrid[key] = []
      hoverGrid[key].push(i)
    }
  }

  function findNodeAt(mx, my) {
    const cx = Math.floor(mx / CELL_SIZE)
    const cy = Math.floor(my / CELL_SIZE)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cell = hoverGrid[`${cx+dx},${cy+dy}`]
        if (!cell) continue
        for (const i of cell) {
          const ndx = mx - nodes[i].x, ndy = my - nodes[i].y
          if (ndx * ndx + ndy * ndy < 200) return i
        }
      }
    }
    return null
  }

  // --- controls ---
  const controlsHtml = `
    <div id="graph-controls" style="margin-bottom:1em;display:flex;gap:1ch;align-items:center;flex-wrap:wrap">
      <span style="color:#999">hops:</span>
      <button class="buy-btn hop-btn" data-hops="1">1</button>
      <button class="buy-btn hop-btn active" data-hops="2">2</button>
      <button class="buy-btn hop-btn" data-hops="3">3</button>
      <span style="color:#666;margin:0 1ch">|</span>
      <input type="text" id="graph-search" placeholder="search by domain" style="background:#1a1a1a;border:1px solid #333;color:#c0c0c0;font-family:inherit;font-size:0.9em;padding:0.3em 1ch;width:20ch">
      <button class="buy-btn" id="graph-search-btn">go</button>
    </div>
  `
  document.getElementById('graph-controls')?.remove()
  canvas.insertAdjacentHTML('beforebegin', controlsHtml)

  document.querySelectorAll('.hop-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      maxHops = parseInt(btn.dataset.hops)
      document.querySelectorAll('.hop-btn').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      loadEgoGraph(centerAddr)
    }, { signal })
  })

  document.getElementById('graph-search-btn').addEventListener('click', async () => {
    const domain = document.getElementById('graph-search').value.trim().toLowerCase()
    if (!domain) return
    // query Ponder for artist by domain name
    try {
      const data = await query(`query SearchDomain($domain: String!) { artists(where: { domain: $domain }, limit: 1) { items { ${F.artist} } } }`, { domain })
      const artist = data.artists?.items?.[0]
      if (artist) {
        loadEgoGraph(artist.id.toLowerCase())
      } else {
        statusEl.textContent = `"${domain}" not found`
      }
    } catch {
      statusEl.textContent = `"${domain}" not found`
    }
  }, { signal })

  document.getElementById('graph-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('graph-search-btn').click()
  }, { signal })

  // --- data loading ---
  const MAX_NODES = 500
  const MAX_ADDRS_PER_QUERY = 200

  async function fetchEdgesForAddresses(addresses) {
    // fetch edges where source or target is in the address set
    // Paginate both directions to avoid silent data loss for popular artists
    const addrList = addresses.map(a => a.toLowerCase()).slice(0, MAX_ADDRS_PER_QUERY)

    const MAX_PAGES = 5
    let _totalQueries = 0
    async function fetchAllEdges(direction) {
      let all = [], cursor = null, page = 0
      while (true) {
        if (++page > MAX_PAGES) break
        if (_totalQueries >= 30) break
        _totalQueries++
        const vars = { addrs: addrList, ...(cursor ? { after: cursor } : {}) }
        const data = await query(`
          query Edges($addrs: [String!]!, $after: String) {
            edges(where: { ${direction}_in: $addrs }, limit: 200, after: $after) {
              items { ${F.edge} }
              ${F.pageInfo}
            }
          }
        `, vars)
        all.push(...data.edges.items)
        if (!data.edges.pageInfo?.hasNextPage) break
        cursor = data.edges.pageInfo.endCursor
      }
      return all
    }

    const [sourceEdges, targetEdges] = await Promise.all([
      fetchAllEdges('source'),
      fetchAllEdges('target'),
    ])

    const edgeMap = new Map()
    for (const e of [...sourceEdges, ...targetEdges]) {
      edgeMap.set(e.id, e)
    }
    return [...edgeMap.values()]
  }

  async function loadArtistDomains(addresses) {
    return resolveAddresses(query, addresses).catch(() => ({}))
  }

  async function loadEgoGraph(center) {
    centerAddr = center
    statusEl.innerHTML = '<div class="praxis-loader"></div>'
    iteration = 0
    _simulating = true
    if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null }

    // BFS expansion: start from center, expand N hops via edge queries
    let frontier = new Set([center])
    let visited = new Set([center])
    let allEdges = []

    for (let hop = 0; hop < maxHops; hop++) {
      if (frontier.size === 0) break
      if (visited.size >= MAX_NODES) break
      const edgeBatch = await fetchEdgesForAddresses([...frontier])
      allEdges.push(...edgeBatch)

      const nextFrontier = new Set()
      for (const e of edgeBatch) {
        if (visited.size >= MAX_NODES) break
        const s = e.source.toLowerCase()
        const t = e.target.toLowerCase()
        if (!visited.has(s)) { visited.add(s); nextFrontier.add(s) }
        if (!visited.has(t)) { visited.add(t); nextFrontier.add(t) }
      }
      frontier = nextFrontier
    }

    // deduplicate edges
    const edgeMap = new Map()
    for (const e of allEdges) edgeMap.set(e.id, e)
    const uniqueEdges = [...edgeMap.values()]

    // collect all node addresses from edges + center
    const nodeAddrs = new Set([center])
    for (const e of uniqueEdges) {
      nodeAddrs.add(e.source.toLowerCase())
      nodeAddrs.add(e.target.toLowerCase())
    }

    // fetch domain names
    const domainMap = await loadArtistDomains([...nodeAddrs])

    // build nodes
    addrToIdx = {}
    nodes = [...nodeAddrs].map((addr, i) => {
      addrToIdx[addr] = i
      return {
        addr,
        domain: domainMap[addr] || `${addr.slice(0, 6)}...${addr.slice(-4)}`,
        x: Math.random() * (W - 100) + 50,
        y: Math.random() * 400 + 50,
        vx: 0, vy: 0,
      }
    })

    // build edges (index-based)
    edges = []
    const edgeSet = new Set()
    for (const e of uniqueEdges) {
      const s = e.source.toLowerCase()
      const t = e.target.toLowerCase()
      const ia = addrToIdx[s]
      const ib = addrToIdx[t]
      if (ia !== undefined && ib !== undefined && ia !== ib) {
        // follow edges are directed — keep both A→B and B→A
        // collab/funded edges are undirected — dedup with sorted key
        const key = e.type === 'follow'
          ? `${ia}-${ib}-follow`
          : `${Math.min(ia, ib)}-${Math.max(ia, ib)}-${e.type}`
        if (!edgeSet.has(key)) {
          edgeSet.add(key)
          edges.push({ source: ia, target: ib, type: e.type })
        }
      }
    }

    // BFS for degrees from center
    const centerIdx = addrToIdx[center]
    degrees = new Map()
    if (centerIdx !== undefined) {
      const adj = new Map()
      for (let i = 0; i < nodes.length; i++) adj.set(i, [])
      for (const e of edges) {
        adj.get(e.source).push(e.target)
        adj.get(e.target).push(e.source)
      }
      const queue = [centerIdx]
      degrees.set(centerIdx, 0)
      while (queue.length) {
        const cur = queue.shift()
        const d = degrees.get(cur)
        for (const neighbor of (adj.get(cur) || [])) {
          if (!degrees.has(neighbor)) {
            degrees.set(neighbor, d + 1)
            queue.push(neighbor)
          }
        }
      }
    }

    const edgeCounts = {}
    for (const e of edges) edgeCounts[e.type] = (edgeCounts[e.type] || 0) + 1
    const countParts = Object.entries(edgeCounts).map(([type, count]) => `${count} ${type}${count !== 1 ? 's' : ''}`)
    // count artists vs supporters (supporters have handle from resolveAddresses, artists have domain with dots)
    const artistNodes = nodes.filter(n => n.domain.includes('.'))
    const supporterNodes = nodes.filter(n => !n.domain.includes('.') && !n.domain.startsWith('0x'))
    const unknownNodes = nodes.filter(n => n.domain.startsWith('0x'))
    let memberLabel = `${artistNodes.length + unknownNodes.length} artist${artistNodes.length + unknownNodes.length !== 1 ? 's' : ''}`
    if (supporterNodes.length > 0) memberLabel += ` · ${supporterNodes.length} audience`
    statusEl.textContent = memberLabel + (countParts.length ? ` · ${countParts.join(' · ')}` : '')
    if (centerAddr) {
      const centerDomain = domainMap[center] || center.slice(0, 10)
      statusEl.textContent += ` · centered on ${centerDomain}`
    }

    // restart simulation so the graph animates and _simulating resets after convergence
    iteration = 0
    _simulating = true
    draw()
  }

  // --- force-directed simulation ---
  function simulate() {
    if (nodes.length === 0) return
    const repulsion = 2000
    const attraction = 0.005
    const damping = 0.9
    const centerGravity = 0.03

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        let dx = nodes[i].x - nodes[j].x
        let dy = nodes[i].y - nodes[j].y
        let dist = Math.sqrt(dx * dx + dy * dy) || 1
        let force = repulsion / (dist * dist)
        let fx = (dx / dist) * force
        let fy = (dy / dist) * force
        nodes[i].vx += fx
        nodes[i].vy += fy
        nodes[j].vx -= fx
        nodes[j].vy -= fy
      }
    }

    for (const e of edges) {
      let dx = nodes[e.target].x - nodes[e.source].x
      let dy = nodes[e.target].y - nodes[e.source].y
      let dist = Math.sqrt(dx * dx + dy * dy) || 1
      let force = dist * attraction
      let fx = (dx / dist) * force
      let fy = (dy / dist) * force
      nodes[e.source].vx += fx
      nodes[e.source].vy += fy
      nodes[e.target].vx -= fx
      nodes[e.target].vy -= fy
    }

    for (const n of nodes) {
      n.vx += (W / 2 - n.x) * centerGravity
      n.vy += (H / 2 - n.y) * centerGravity
    }

    for (const n of nodes) {
      n.vx *= damping
      n.vy *= damping
      n.x += n.vx
      n.y += n.vy
      n.x = Math.max(30, Math.min(W - 30, n.x))
      n.y = Math.max(30, Math.min(H - 30, n.y))
    }
  }

  // --- interaction ---
  function redrawOnce() {
    if (!_simulating) draw()
  }

  let _graphRafPending = false
  canvas.addEventListener('mousemove', (e) => {
    if (_graphRafPending) return
    _graphRafPending = true
    requestAnimationFrame(() => {
      _graphRafPending = false
      const rect = canvas.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top

      // handle panning
      if (isPanning) {
        panX = mx - panStartX
        panY = my - panStartY
        redrawOnce()
        return
      }

      // transform screen coords to graph coords for hover detection
      const gx = (mx - panX) / zoom
      const gy = (my - panY) / zoom
      hoveredNode = findNodeAt(gx, gy)
      canvas.style.cursor = hoveredNode !== null ? 'pointer' : 'default'
      redrawOnce()
    })
  }, { signal })

  canvas.addEventListener('mousedown', (e) => {
    // only pan if not hovering a node
    if (hoveredNode === null) {
      isPanning = true
      const rect = canvas.getBoundingClientRect()
      panStartX = (e.clientX - rect.left) - panX
      panStartY = (e.clientY - rect.top) - panY
      canvas.style.cursor = 'grabbing'
    }
  }, { signal })

  canvas.addEventListener('mouseup', () => {
    isPanning = false
    canvas.style.cursor = hoveredNode !== null ? 'pointer' : 'default'
  }, { signal })

  canvas.addEventListener('mouseleave', () => {
    isPanning = false
  }, { signal })

  // Global safety net: if a pointer/mouse up happens anywhere (mobile
  // synthesises mouse events from taps and can fire mouseup off-canvas),
  // always clear the panning flag so the canvas doesn't stay in drag mode
  // and swallow subsequent taps.
  window.addEventListener('pointerup', () => { isPanning = false }, { signal })
  window.addEventListener('pointercancel', () => { isPanning = false }, { signal })
  window.addEventListener('mouseup', () => { isPanning = false }, { signal })
  window.addEventListener('blur', () => { isPanning = false }, { signal })

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault()
    const rect = canvas.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const oldZoom = zoom
    const delta = e.deltaY > 0 ? 0.9 : 1.1
    zoom = Math.max(0.2, Math.min(5, zoom * delta))
    // zoom toward cursor position
    panX = mx - (mx - panX) * (zoom / oldZoom)
    panY = my - (my - panY) * (zoom / oldZoom)
    redrawOnce()
  }, { signal, passive: false })

  window.addEventListener('resize', () => { resize(); redrawOnce() }, { signal })

  canvas.addEventListener('click', () => {
    if (signal.aborted) return
    if (hoveredNode !== null) {
      const addr = nodes[hoveredNode].addr
      if (addr !== centerAddr) {
        // navigate to that artist's ego-graph
        loadEgoGraph(addr)
      } else {
        // click center node → open their site
        const domain = nodes[hoveredNode].domain
        if (domain && !domain.includes('...')) {
          const url = domain.includes('.') ? `https://${domain}` : `https://${domain}.ourpraxis.network`
          window.open(url, '_blank')
        }
      }
    }
  }, { signal })

  // --- render loop ---
  function draw() {
    // clear with identity transform, then apply pan/zoom
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)
    ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, panX * dpr, panY * dpr)

    // viewport bounds in graph coordinates for culling
    const vpLeft = -panX / zoom - 50
    const vpRight = (W - panX) / zoom + 50
    const vpTop = -panY / zoom - 50
    const vpBottom = (H - panY) / zoom + 50

    function isVisible(x, y) {
      return x >= vpLeft && x <= vpRight && y >= vpTop && y <= vpBottom
    }

    // check for mutual follows to render solid purple
    const followEdgeKeys = new Set()
    for (const e of edges) {
      if (e.type === 'follow') followEdgeKeys.add(`${e.source}-${e.target}`)
    }

    // Theme-aware colors: detect light/dark background once per frame
    const _bgHex = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim().replace('#', '')
    const _lum = _bgHex.length >= 6 ? (0.299 * parseInt(_bgHex.slice(0,2),16) + 0.587 * parseInt(_bgHex.slice(2,4),16) + 0.114 * parseInt(_bgHex.slice(4,6),16)) / 255 : 0
    const _light = _lum > 0.5

    // draw edges (skip if both endpoints off-screen)
    for (const e of edges) {
      const sn = nodes[e.source], tn = nodes[e.target]
      if (!isVisible(sn.x, sn.y) && !isVisible(tn.x, tn.y)) continue

      ctx.beginPath()
      ctx.moveTo(sn.x, sn.y)
      ctx.lineTo(tn.x, tn.y)

      if (e.type === 'follow') {
        const isMutual = followEdgeKeys.has(`${e.target}-${e.source}`)
        ctx.strokeStyle = _light ? '#9966cc' : '#553388'
        ctx.lineWidth = 0.8
        if (isMutual) {
          ctx.setLineDash([])
        } else {
          ctx.setLineDash([2, 6])
        }
      } else if (e.type === 'funded') {
        ctx.strokeStyle = _light ? '#bbb' : '#333'
        ctx.lineWidth = 0.5
        ctx.setLineDash([4, 4])
      } else {
        ctx.strokeStyle = _light ? '#aaa' : '#444'
        ctx.lineWidth = 1
        ctx.setLineDash([])
      }
      ctx.stroke()
      ctx.setLineDash([])
    }

    // draw nodes (skip if off-screen)
    const centerIdx = centerAddr ? addrToIdx[centerAddr] : undefined
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]
      if (!isVisible(n.x, n.y)) continue

      const isCenter = centerIdx !== undefined && i === centerIdx
      const isHovered = i === hoveredNode
      const isAudience = !n.domain.includes('.') && !n.domain.startsWith('0x')
      const radius = isCenter ? 8 : (isAudience ? 4 : (isHovered ? 7 : 5))

      ctx.beginPath()
      ctx.arc(n.x, n.y, radius, 0, Math.PI * 2)
      ctx.fillStyle = isCenter ? (_light ? '#111' : '#fff') : (isAudience ? (_light ? '#886644' : '#886644') : (isHovered ? (_light ? '#222' : '#ddd') : (_light ? '#333' : '#ccc')))
      ctx.fill()

      // label
      const label = n.domain.length > 16 ? n.domain.slice(0, 14) + '...' : n.domain
      ctx.font = isHovered ? '12px -apple-system, sans-serif' : (isAudience ? '9px -apple-system, sans-serif' : '10px -apple-system, sans-serif')
      ctx.fillStyle = isHovered ? (_light ? '#000' : '#fff') : (isAudience ? (_light ? '#665544' : '#887766') : (_light ? '#444' : '#999'))
      ctx.textAlign = 'center'
      ctx.fillText(label, n.x, n.y - radius - 4)

      // degrees tooltip on hover
      if (isHovered && centerIdx !== undefined && degrees.has(i) && i !== centerIdx) {
        const d = degrees.get(i)
        ctx.font = '10px -apple-system, sans-serif'
        ctx.fillStyle = _light ? '#555' : '#666'
        ctx.fillText(`${d} degree${d === 1 ? '' : 's'} from you`, n.x, n.y + radius + 14)
      }
    }

    // reset transform for next frame
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    if (iteration < maxIter) {
      simulate()
      rebuildHoverGrid()
      iteration++
      _rafId = requestAnimationFrame(draw)
    } else {
      rebuildHoverGrid()
      _simulating = false
    }
  }

  // --- initial load ---
  // Center on the SITE OWNER (whose site we're viewing), not the connected wallet.
  // Visitors to canteenkilla.space should see canteenkilla's neighborhood.
  const siteOwnerAddr = document.body.dataset.owner?.toLowerCase()
  const connectedWallet = window.getWalletAddress?.()?.toLowerCase()
  const initialCenter = siteOwnerAddr || connectedWallet
  if (initialCenter) {
    await loadEgoGraph(initialCenter)
  } else {
    // no wallet connected — show a random artist's neighborhood or prompt
    try {
      const data = await query(`
        query FirstArtist {
          artists(limit: 1) { items { ${F.artist} } }
        }
      `)
      if (data.artists.items.length > 0) {
        await loadEgoGraph(data.artists.items[0].id.toLowerCase())
      } else {
        statusEl.textContent = 'no artists in the network'
      }
    } catch {
      statusEl.textContent = 'could not load graph data'
    }
  }
}
