// lib/storage.js — Storage interface for IPFS operations
// Initial implementation delegates to existing Kubo endpoints.
// Interface is stable — swap to S3 or other backend later without changing callers.

import { randomBytes } from 'crypto'

const KUBO_WRITE_API = process.env.KUBO_WRITE_API || process.env.KUBO_API || 'http://localhost:5001'
const KUBO_READ_GATEWAY = process.env.KUBO_READ_GATEWAY || process.env.KUBO_GATEWAY || 'http://localhost:8080'

/**
 * Upload a buffer or file to IPFS via Kubo.
 * @param {Buffer} buffer - file contents
 * @param {string} filename - original filename (used for Content-Disposition)
 * @param {object} [opts] - options
 * @param {boolean} [opts.pin=true] - pin after upload
 * @returns {Promise<{ cid: string }>}
 */
export async function upload(buffer, filename, opts = {}) {
  const pin = opts.pin !== false
  const boundary = '----PraxisUpload' + Date.now() + randomBytes(8).toString('hex')
  const safeName = (filename || 'file').replace(/[\r\n"\\]/g, '').replace(/[^\x20-\x7E]/g, '').slice(0, 255)
  const header = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\nContent-Type: application/octet-stream\r\n\r\n`)
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`)
  const body = Buffer.concat([header, buffer, footer])

  const url = `${KUBO_WRITE_API}/api/v0/add?pin=${pin}&cid-version=1`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(body.length),
    },
    body,
    signal: AbortSignal.timeout(5 * 60 * 1000), // 5 min timeout for buffer uploads
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`storage upload failed: ${res.status} ${text.slice(0, 200)}`)
  }

  const data = await res.json()
  if (!data.Hash) throw new Error(data.Message || 'upload failed — no CID returned')

  return { cid: data.Hash }
}

/**
 * Get a gateway URL for accessing content by CID.
 * @param {string} cid - IPFS content identifier
 * @returns {string} full URL to access the content via the read gateway
 */
export function getUrl(cid) {
  return `${KUBO_READ_GATEWAY}/ipfs/${cid}`
}

/**
 * Ensure content is pinned on the local Kubo node.
 * @param {string} cid - IPFS content identifier
 * @returns {Promise<void>}
 */
export async function pin(cid) {
  const url = `${KUBO_WRITE_API}/api/v0/pin/add?arg=${encodeURIComponent(cid)}`
  const res = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`pin failed: ${res.status} ${text.slice(0, 200)}`)
  }
}

/**
 * Returns the server-side IPFS proxy URL for a CID.
 * Clients should use this instead of hitting the gateway directly
 * to benefit from caching, coalescing, and circuit breaking.
 * @param {string} cid - IPFS content identifier
 * @returns {string} relative URL path
 */
export function ipfsProxyUrl(cid) {
  return `/api/ipfs-proxy/${cid}`
}
