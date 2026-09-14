// XMTP custom content type for Praxis blog broadcasts.
//
// Broadcasts share the XMTP transport with personal DMs but wear a
// distinct content type so the inbox can bucket them into a separate
// "Subscriptions" tab and render post-preview cards instead of chat
// bubbles. Replies from a broadcast conversation fall back to the
// default text content type, moving the conversation into "Direct".
//
// Wire shape (JSON in the content bytes):
//   {
//     type: 'praxis:broadcast:v1',
//     postId: '<ponder blog post id>',
//     title: '<post title>',
//     hero: '<ipfs cid or /api/ipfs-proxy/... path>',
//     excerpt: '<first ~200 chars of body>',
//     publishedAt: '<ISO timestamp>',
//     authorDomain: '<writer domain>'
//   }
//
// Codec shape mirrors @xmtp/content-type-reaction (see
// vendor-xmtp-reaction.js): a ContentTypeId identifier + an encode /
// decode / fallback / shouldPush method set.
//
// authorityId is `praxis.network` so the type is namespaced away from
// XMTP-standard content types (reactions, attachments, etc.) and
// clients that don't register this codec fall back to
// `codec.fallback()` prose in their UI.

export const ContentTypeBroadcast = {
  authorityId: 'praxis.network',
  typeId: 'broadcast',
  versionMajor: 1,
  versionMinor: 0,
}

export class BroadcastCodec {
  get contentType() { return ContentTypeBroadcast }

  encode(envelope) {
    return {
      type: ContentTypeBroadcast,
      parameters: {},
      content: new TextEncoder().encode(JSON.stringify(envelope)),
    }
  }

  decode(encodedContent) {
    try {
      const raw = new TextDecoder().decode(encodedContent.content)
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') return parsed
    } catch {}
    return null
  }

  // Prose shown by clients that haven't registered this codec — a
  // Praxis reader on an old build sees "New post: <title>" as text,
  // not a JSON blob.
  fallback(envelope) {
    if (envelope?.title) {
      return `New post: ${envelope.title}${envelope.authorDomain ? ` — ${envelope.authorDomain}` : ''}`
    }
    return 'New post'
  }

  // XMTP push priority — true so followers get an inbox notification
  // dot on the "new post from <writer>" broadcast, same as a DM.
  shouldPush() { return true }
}

// Cheap sniffer used by inbox filtering so the tab-split can tell a
// broadcast from a personal message without touching the SDK's codec
// registry. Accepts either a decoded message or a raw envelope.
export function isBroadcastMessage(msg) {
  const ct = msg?.contentType
  if (ct?.authorityId === 'praxis.network' && ct?.typeId === 'broadcast') return true
  const c = msg?.content
  if (c && typeof c === 'object' && c.type === 'praxis:broadcast:v1') return true
  return false
}

// Extract the envelope from a decoded XMTP message, whether the
// client has the codec registered (typed decode) or not (JSON string
// in content).
export function extractBroadcastEnvelope(msg) {
  if (!msg) return null
  const c = msg.content
  if (c && typeof c === 'object' && c.type === 'praxis:broadcast:v1') return c
  if (typeof c === 'string') {
    try {
      const parsed = JSON.parse(c)
      if (parsed?.type === 'praxis:broadcast:v1') return parsed
    } catch {}
  }
  return null
}

// Slug helper for the "Read post →" link on the subscription card.
// Broadcasts carry postId + title, so we prefer /post?id=<postId>
// (canonical, always resolves) but include a slug link where the
// caller has one.
export function broadcastPostUrl(envelope) {
  if (!envelope) return '/'
  if (envelope.postId) return `/post?id=${encodeURIComponent(envelope.postId)}`
  if (envelope.title) return `/post/${encodeURIComponent(envelope.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))}`
  return '/'
}
