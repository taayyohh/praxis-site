// Post-publish XMTP broadcast fanout.
//
// After a writer's `BlogRegistry.post` tx confirms, we enumerate their
// follower list on Ponder, resolve each follower's XMTP inbox ID, get
// or create a DM conversation with them, and send the broadcast
// envelope with the `praxis.network/broadcast:1.0` content type.
//
// Rate-limited to 5 sends/sec so we don't hammer the XMTP node. A
// follower whose XMTP identity can't be resolved is skipped silently —
// they'll still see the post in the in-app notification panel (that
// piece is a separate work stream). Progress is reported through the
// optional `onProgress({sent, total, skipped, currentDomain})` callback
// so a caller can surface a "notifying 47 readers…" toast.

import { query } from './ponder.js'

const BROADCAST_RATE_PER_SEC = 5

// Enumerate every follower of `writerAddr` (cursor-paginated up to
// 2000). Mirrors the fetchAllFollows pattern already used in
// messages.js for the mutual-follow filter.
async function _fetchFollowers(writerAddr) {
  const me = writerAddr.toLowerCase()
  const items = []
  let cursor = null
  for (let page = 0; page < 10; page++) {
    const vars = { me }
    if (cursor) vars.after = cursor
    let data
    try {
      data = await query(
        `query($me: String!${cursor ? ', $after: String' : ''}) {
          follows(where: { followed: $me }, limit: 200${cursor ? ', after: $after' : ''}) {
            items { follower }
            pageInfo { endCursor hasNextPage }
          }
        }`,
        vars
      )
    } catch {
      break
    }
    const page_items = data?.follows?.items || []
    for (const it of page_items) {
      if (it.follower) items.push(String(it.follower).toLowerCase())
    }
    if (items.length >= 2000 || !data.follows?.pageInfo?.hasNextPage) break
    cursor = data.follows.pageInfo.endCursor
  }
  return [...new Set(items)] // de-dupe
}

// Resolve one wallet address to its XMTP inbox ID. Uses the SDK's
// static getInboxIdForIdentifier when available (documented, no client
// state required). Returns null if the follower has never registered
// with XMTP — safe to skip.
async function _resolveInboxId(address, sdk) {
  const identifier = { identifier: address, identifierKind: sdk.IdentifierKind.Ethereum }
  try {
    if (sdk.createBackend && sdk.getInboxIdForIdentifier) {
      const backend = await sdk.createBackend('production')
      const inboxId = await sdk.getInboxIdForIdentifier(backend, identifier)
      if (inboxId) return inboxId
    }
  } catch {}
  return null
}

// Get or create a DM conversation with the follower's inbox. Prefers
// `getDmByInboxId` when the SDK exposes it (returns the existing
// active conversation), falls back to `createDm` (idempotent per XMTP
// docs — reuses existing when present).
async function _getOrCreateDm(client, inboxId) {
  try {
    if (client.conversations.getDmByInboxId) {
      const existing = await client.conversations.getDmByInboxId(inboxId)
      if (existing) return existing
    }
  } catch {}
  try {
    return await client.conversations.createDm(inboxId)
  } catch (e) {
    console.warn('praxis: createDm failed for', inboxId?.slice(0, 8), e?.message)
    return null
  }
}

// Build the envelope wire object. Caller supplies fields fresh from
// the writer's client state; nothing is inferred here.
export function buildBroadcastEnvelope({ postId, title, hero, excerpt, publishedAt, authorDomain }) {
  return {
    type: 'praxis:broadcast:v1',
    postId: postId != null ? String(postId) : '',
    title: title || '',
    hero: hero || '',
    excerpt: (excerpt || '').slice(0, 200),
    publishedAt: publishedAt || new Date().toISOString(),
    authorDomain: authorDomain || '',
  }
}

// Main entrypoint — send the envelope to every follower with an XMTP
// identity. Non-blocking on the caller thread beyond the initial
// follower fetch; the actual sends stream through with rate-limit
// pacing and progress callbacks.
//
// Returns { sent, skipped, total } once complete.
export async function broadcastPost({ writerAddr, envelope, onProgress }) {
  if (!writerAddr) return { sent: 0, skipped: 0, total: 0 }

  // Reuse the leader XMTP client owned by messages.js / dm.js. If no
  // client is available (writer hasn't visited /messages yet in this
  // session) we bail — they can still ship posts, followers just miss
  // the XMTP push. In-app notifications from Ponder events cover this.
  const client = window._xmtpClient
  const sdk = window._xmtpSdk
  if (!client?.inboxId || !sdk) {
    console.warn('praxis: broadcastPost skipped — no XMTP client available')
    return { sent: 0, skipped: 0, total: 0 }
  }

  const followers = await _fetchFollowers(writerAddr)
  const total = followers.length
  if (total === 0) return { sent: 0, skipped: 0, total: 0 }

  let sent = 0
  let skipped = 0
  const interval = Math.ceil(1000 / BROADCAST_RATE_PER_SEC)

  for (const followerAddr of followers) {
    const started = Date.now()
    try {
      const inboxId = await _resolveInboxId(followerAddr, sdk)
      if (!inboxId) { skipped++; continue }
      // Don't broadcast to yourself.
      if (inboxId === client.inboxId) { skipped++; continue }

      const convo = await _getOrCreateDm(client, inboxId)
      if (!convo) { skipped++; continue }

      // send with the custom content type so a receiver with the
      // codec registered (Praxis users) decodes it directly, and any
      // receiver without falls back to the codec's prose.
      const contentType = {
        authorityId: 'praxis.network',
        typeId: 'broadcast',
        versionMajor: 1,
        versionMinor: 0,
      }
      await convo.send(envelope, contentType)
      sent++
    } catch (e) {
      console.warn('praxis: broadcast send failed for', followerAddr.slice(0, 6), e?.message)
      skipped++
    }
    try { onProgress?.({ sent, skipped, total, currentDomain: followerAddr }) } catch {}
    // Rate-limit: hold to at most BROADCAST_RATE_PER_SEC sends/sec.
    const elapsed = Date.now() - started
    if (elapsed < interval) await new Promise(r => setTimeout(r, interval - elapsed))
  }

  return { sent, skipped, total }
}
