import { createServer } from 'http'
import { readFileSync, existsSync, statSync, createReadStream } from 'fs'
import { join, extname } from 'path'
import { handleSsr } from './routes/ssr.js'
import { handleBlog } from './routes/blog.js'

const PORT = process.env.PORT || 3000
const ROOT = import.meta.dirname
const PONDER = process.env.PONDER_URL || 'https://ourpraxis.network/ponder'
const IPFS_GW = process.env.IPFS_GATEWAY || 'https://ourpraxis.network/ipfs'

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webp': 'image/webp',
  '.webm': 'video/webm', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg',
}

let siteJson = null
try { siteJson = JSON.parse(readFileSync(join(ROOT, 'site.json'), 'utf8')) } catch {}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const path = url.pathname

  // Ponder proxy
  if (path === '/ponder' || path.startsWith('/ponder/')) {
    try {
      const target = PONDER + path.replace(/^\/ponder/, '')
      const pRes = await fetch(target, {
        method: req.method,
        headers: { 'Content-Type': 'application/json' },
        body: req.method === 'POST' ? await new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)) }) : undefined,
      })
      res.writeHead(pRes.status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(await pRes.text())
    } catch { res.writeHead(502); res.end('ponder proxy error') }
    return
  }

  // IPFS proxy
  if (path.startsWith('/ipfs/')) {
    try {
      const ipfsRes = await fetch(IPFS_GW + path)
      const ct = ipfsRes.headers.get('content-type') || 'application/octet-stream'
      res.writeHead(ipfsRes.status, { 'Content-Type': ct, 'Cache-Control': 'public, max-age=31536000, immutable' })
      const buf = Buffer.from(await ipfsRes.arrayBuffer())
      res.end(buf)
    } catch { res.writeHead(502); res.end('ipfs proxy error') }
    return
  }

  // Health check
  if (path === '/health') { res.writeHead(200); res.end('ok'); return }

  // SSR for blog posts, OG tags
  if (path.startsWith('/blog/') || path === '/blog') {
    return handleBlog(req, res, siteJson)
  }

  // Static files
  let filePath = join(ROOT, 'public', path === '/' ? 'index.html' : path)

  // SPA routes -> index.html
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(ROOT, 'public', 'index.html')
  }

  if (existsSync(filePath) && !statSync(filePath).isDirectory()) {
    const ext = extname(filePath)
    const mime = MIME[ext] || 'application/octet-stream'
    const stat = statSync(filePath)
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
    })
    createReadStream(filePath).pipe(res)
    return
  }

  res.writeHead(404)
  res.end('not found')
})

server.listen(PORT, () => console.log('praxis self-hosted on :' + PORT))
