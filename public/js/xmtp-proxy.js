// xmtp-proxy.js — Multi-tab leader election + BroadcastChannel proxy for XMTP
// Only one tab can hold the OPFS database. This module coordinates which tab
// is the leader (runs the real XMTP client) and proxies operations from
// follower tabs through BroadcastChannel.

const REQUEST_TIMEOUT = 15000
const PENDING_MAX = 100

// --- Worker patching for XMTP ---
// Redirect XMTP SDK worker URLs to local bundles. Shared by messages.js,
// dm.js, and wallet.js so the patch logic lives in one place.
export function patchWorker() {
  if (typeof window === 'undefined' || window._workerPatched) return
  window._workerPatched = true
  const Orig = window.Worker
  window.Worker = function(url, opts) {
    const s = url instanceof URL ? url.href : url
    if (typeof s === 'string' && (s.includes('esm.sh') || s.includes('xmtp') || s.includes('workers/client') || s.includes('workers/opfs'))) {
      if (s.includes('client')) return new Orig('/js/xmtp-workers/client.js', { ...opts, type: 'module' })
      if (s.includes('opfs')) return new Orig('/js/xmtp-workers/opfs.js', { ...opts, type: 'module' })
    }
    return new Orig(url, opts)
  }
}

// --- Leadership acquisition ---

export async function acquireLeadership(lockName, { persistent = true } = {}) {
  const channel = new BroadcastChannel(lockName)
  let _resolvePromoted

  const onPromoted = new Promise(r => { _resolvePromoted = r })

  if (!navigator.locks) {
    return { isLeader: true, channel, onPromoted, release: () => {} }
  }

  let _releaseLock = null

  const gotLock = await new Promise(resolve => {
    navigator.locks.request(lockName, { ifAvailable: true }, lock => {
      if (!lock) { resolve(false); return Promise.resolve() }
      resolve(true)
      if (!persistent) return Promise.resolve() // release immediately
      return new Promise(r => { _releaseLock = r })
    }).catch(() => resolve(false))
  })

  if (gotLock) {
    return {
      isLeader: true, channel, onPromoted,
      release: () => { if (_releaseLock) { _releaseLock(); _releaseLock = null } }
    }
  }

  // Queue for auto-promotion
  navigator.locks.request(lockName, () => {
    _resolvePromoted(true)
    if (!persistent) return Promise.resolve()
    return new Promise(r => { _releaseLock = r })
  }).catch(() => {})

  return { isLeader: false, channel, onPromoted, release: () => { if (_releaseLock) { _releaseLock(); _releaseLock = null } } }
}

// --- Serialization helpers ---

export function serializeMessage(m) {
  if (!m) return null
  return {
    id: m.id,
    content: typeof m.content === 'string' ? m.content : (m.content != null ? JSON.stringify(m.content) : ''),
    contentType: m.contentType ? { typeId: m.contentType.typeId || m.contentType } : null,
    senderInboxId: m.senderInboxId,
    sentAtNs: String(m.sentAtNs || 0),
    conversationId: m.conversationId,
  }
}

async function serializeConvo(c, clientInboxId) {
  let lastMsg = null
  try { lastMsg = typeof c.lastMessage === 'function' ? await c.lastMessage() : c.lastMessage } catch {}

  let members = []
  try { members = typeof c.members === 'function' ? await c.members() : (c.members || []) } catch {}

  let peerInboxId = ''
  try {
    if (typeof c.peerInboxId === 'function') peerInboxId = await c.peerInboxId()
    else if (c.peerInboxId) peerInboxId = c.peerInboxId
    else {
      // derive from members
      for (const m of members) {
        if (m.inboxId !== clientInboxId) { peerInboxId = m.inboxId; break }
      }
    }
  } catch {}

  let isActive = true
  try {
    if (typeof c.isActive === 'function') isActive = await c.isActive()
    else if ('isActive' in c) isActive = c.isActive
  } catch {}

  return {
    id: c.id,
    _peerInboxId: peerInboxId,
    _lastMessage: serializeMessage(lastMsg),
    _isActive: isActive,
    _isGroup: c.isGroup ?? (members.length > 2),
    _members: members.map(m => ({
      inboxId: m.inboxId,
      addresses: m.addresses || m.accountAddresses || [],
      accountAddresses: m.accountAddresses || m.addresses || [],
    })),
  }
}

// --- Leader responder ---
// Leader tab listens for proxy-request messages and dispatches to real client

export function startLeaderResponder(channel, getClient, { onYield, releaseLock } = {}) {
  const _convoCache = new Map()

  async function _findConvo(client, conversationId) {
    let convo = _convoCache.get(conversationId)
    if (convo) return convo
    // Cache miss — refresh from client
    const convos = await client.conversations.list()
    for (const c of convos) _convoCache.set(c.id, c)
    return _convoCache.get(conversationId) || null
  }

  const handler = async (e) => {
    // Handle yield-leadership request: read-only leader steps aside for /messages.
    // Only yield if this tab has a read-only client. Full Client.create leaders
    // (i.e. another /messages tab) refuse — the requester should use the proxy.
    if (e.data?.type === 'yield-leadership') {
      if (!window._xmtpClientIsReadOnly) {
        console.log('praxis: leader refusing yield (full client on /messages)')
        channel.postMessage({ type: 'yield-refused' })
        return
      }
      console.log('praxis: leader yielding for /messages tab')
      const c = getClient()
      try { c?.close?.() } catch {}
      window._xmtpClient = null
      window._xmtpLockHolder = false
      window._xmtpClientIsReadOnly = false
      if (typeof onYield === 'function') onYield()
      // Wait for WASM worker to release OPFS handles before releasing lock
      await new Promise(r => setTimeout(r, 1500))
      if (typeof releaseLock === 'function') releaseLock()
      return
    }
    if (e.data?.type !== 'proxy-request') return
    const { reqId, method, args } = e.data
    const client = getClient()

    if (!client) {
      channel.postMessage({ type: 'proxy-response', reqId, error: 'no client' })
      return
    }

    try {
      let result
      switch (method) {
        case 'get-conversations': {
          await (client.conversations.syncAll?.(['allowed', 'unknown']) || client.conversations.sync())
          const convos = await client.conversations.list()
          for (const c of convos) _convoCache.set(c.id, c)
          const limit = args?.limit || 100
          const serialized = []
          for (const c of convos.slice(0, limit)) {
            serialized.push(await serializeConvo(c, client.inboxId))
          }
          result = { conversations: serialized, inboxId: client.inboxId }
          break
        }
        case 'get-messages': {
          const convo = await _findConvo(client, args.conversationId)
          if (!convo) { result = { messages: [] }; break }
          await convo.sync()
          const msgs = await convo.messages()
          result = { messages: msgs.map(serializeMessage) }
          break
        }
        case 'send-message': {
          if (window._xmtpClientIsReadOnly) {
            channel.postMessage({ type: 'proxy-response', reqId, error: 'client is read-only' })
            return
          }
          const convo = await _findConvo(client, args.conversationId)
          if (!convo) throw new Error('conversation not found')
          await convo.sendText(args.text)
          result = { success: true }
          break
        }
        case 'create-dm': {
          if (window._xmtpClientIsReadOnly) {
            channel.postMessage({ type: 'proxy-response', reqId, error: 'client is read-only' })
            return
          }
          const newConvo = await client.conversations.newDm(args.peerAddress)
          await newConvo.sync()
          result = await serializeConvo(newConvo, client.inboxId)
          break
        }
        case 'sync-conversations': {
          await (client.conversations.syncAll?.(['allowed', 'unknown']) || client.conversations.sync())
          const synced = await client.conversations.list()
          for (const c of synced) _convoCache.set(c.id, c)
          result = { count: synced.length }
          break
        }
        case 'send-read-receipt': {
          const convo = await _findConvo(client, args.conversationId)
          if (convo) await convo.sendText(`\x00praxis:read:${args.sentAtNs}`)
          result = { success: true }
          break
        }
        case 'send-typing': {
          const convo = await _findConvo(client, args.conversationId)
          if (convo) await convo.sendText(`\x00praxis:typing:${Date.now()}`)
          result = { success: true }
          break
        }
        case 'get-inbox-state': {
          let installationCount = 0
          try {
            const state = await client.inboxState?.(true)
            installationCount = state?.installations?.length || 0
          } catch {}
          result = { inboxId: client.inboxId, installationCount }
          break
        }
        default:
          channel.postMessage({ type: 'proxy-response', reqId, error: `unknown method: ${method}` })
          return
      }
      channel.postMessage({ type: 'proxy-response', reqId, result })
    } catch (err) {
      channel.postMessage({ type: 'proxy-response', reqId, error: err?.message || 'unknown error' })
    }
  }

  channel.addEventListener('message', handler)

  // Return cleanup function
  return () => channel.removeEventListener('message', handler)
}

// Request the current leader to yield (used by /messages follower when leader is read-only)
export function requestYield(channel) {
  channel.postMessage({ type: 'yield-leadership' })
}

// Broadcast a new message event to all tabs (call from leader's stream handler)
export function broadcastNewMessage(channel, message) {
  channel.postMessage({ type: 'new-message', message: serializeMessage(message) })
}

// Broadcast unread notification
export function broadcastUnread(channel, conversationId) {
  channel.postMessage({ type: 'unread', conversationId })
}

// --- Proxy client (for follower tabs) ---

export function createProxyClient(channel) {
  const _pending = new Map() // reqId -> { resolve, reject, timer }
  let _cachedInboxId = null

  // Listen for responses
  const _responseHandler = (e) => {
    if (e.data?.type === 'proxy-response') {
      const pending = _pending.get(e.data.reqId)
      if (pending) {
        clearTimeout(pending.timer)
        _pending.delete(e.data.reqId)
        if (e.data.error) pending.reject(new Error(e.data.error))
        else pending.resolve(e.data.result)
      }
    }
  }
  channel.addEventListener('message', _responseHandler)

  function request(method, args = {}) {
    return new Promise((resolve, reject) => {
      // Evict oldest if at limit
      if (_pending.size >= PENDING_MAX) {
        const oldest = _pending.keys().next().value
        const p = _pending.get(oldest)
        clearTimeout(p.timer)
        p.reject(new Error('evicted'))
        _pending.delete(oldest)
      }
      const reqId = crypto.randomUUID()
      const timer = setTimeout(() => {
        _pending.delete(reqId)
        reject(new Error(`proxy timeout: ${method}`))
      }, REQUEST_TIMEOUT)
      _pending.set(reqId, { resolve, reject, timer })
      channel.postMessage({ type: 'proxy-request', reqId, method, args })
    })
  }

  // Subscribe to new-message broadcasts from leader (capped at 50 to prevent leaks)
  const _messageListeners = new Set()
  function _addMessageListener(listener) {
    if (_messageListeners.size > 50) {
      const oldest = _messageListeners.values().next().value
      _messageListeners.delete(oldest)
    }
    _messageListeners.add(listener)
  }
  const _msgHandler = (e) => {
    if (e.data?.type === 'new-message' && e.data.message) {
      for (const cb of _messageListeners) cb(e.data.message)
    }
    if (e.data?.type === 'unread') {
      // Show unread dot
      const dot = document.getElementById('dock-msg-dot')
      if (dot) dot.style.display = ''
      try { sessionStorage.setItem('praxis-unread-msgs', '1') } catch {}
    }
  }
  channel.addEventListener('message', _msgHandler)

  function wrapConvo(data) {
    return {
      id: data.id,
      isGroup: data._isGroup,
      peerInboxId: () => Promise.resolve(data._peerInboxId),
      lastMessage: () => Promise.resolve(data._lastMessage),
      isActive: () => Promise.resolve(data._isActive),
      members: () => Promise.resolve(data._members || []),
      messages: () => request('get-messages', { conversationId: data.id }).then(r => r.messages || []),
      sync: () => Promise.resolve(), // no-op: leader syncs during get-conversations
      sendText: (text) => request('send-message', { conversationId: data.id, text }),
      stream: () => {
        // Return an async iterator that yields messages from BroadcastChannel
        let _queue = []
        let _resolve = null
        const listener = (msg) => {
          if (msg.conversationId === data.id) {
            if (_resolve) { const r = _resolve; _resolve = null; r(msg) }
            else { _queue.push(msg); if (_queue.length > 500) _queue.shift() }
          }
        }
        _addMessageListener(listener)
        return {
          [Symbol.asyncIterator]() { return this },
          next() {
            if (_queue.length > 0) return Promise.resolve({ value: _queue.shift(), done: false })
            return new Promise(r => { _resolve = (msg) => r({ value: msg, done: false }) })
          },
          return() {
            _messageListeners.delete(listener)
            return Promise.resolve({ done: true })
          }
        }
      },
    }
  }

  const proxyClient = {
    get inboxId() { return _cachedInboxId },
    _isProxy: true,

    // Stubs for methods that only work on real clients
    fetchInboxIdByIdentifier: () => Promise.resolve(null),
    findInboxIdByAddress: () => Promise.resolve(null),
    isRegistered: () => Promise.resolve(true),
    inboxState: () => Promise.resolve({ installations: [] }),

    conversations: {
      list: async (_opts) => {
        // Ignore opts (BigInt limit can't be serialized)
        const r = await request('get-conversations')
        _cachedInboxId = r.inboxId
        return (r.conversations || []).map(wrapConvo)
      },
      sync: () => request('sync-conversations').then(() => {}),
      syncAll: () => request('sync-conversations').then(() => {}),
      newDm: async (peerAddress) => {
        const r = await request('create-dm', { peerAddress })
        return wrapConvo(r)
      },
      streamAllMessages: () => {
        // Global stream across all conversations
        let _queue = []
        let _resolve = null
        const listener = (msg) => {
          if (_resolve) { const r = _resolve; _resolve = null; r(msg) }
          else { _queue.push(msg); if (_queue.length > 500) _queue.shift() }
        }
        _addMessageListener(listener)
        return {
          [Symbol.asyncIterator]() { return this },
          next() {
            if (_queue.length > 0) return Promise.resolve({ value: _queue.shift(), done: false })
            return new Promise(r => { _resolve = (msg) => r({ value: msg, done: false }) })
          },
          return() {
            _messageListeners.delete(listener)
            return Promise.resolve({ done: true })
          }
        }
      },
    },

    // Proxy has no real close — just stop listening
    close: () => {
      channel.removeEventListener('message', _responseHandler)
      channel.removeEventListener('message', _msgHandler)
      _messageListeners.clear()
      for (const [, p] of _pending) { clearTimeout(p.timer); p.reject(new Error('closed')) }
      _pending.clear()
    },

    // Helper: subscribe to new messages (for toast notifications etc.)
    onNewMessage: (cb) => { _addMessageListener(cb); return () => _messageListeners.delete(cb) },
  }

  return proxyClient
}
