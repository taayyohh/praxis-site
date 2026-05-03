// Lightweight client-side cache for RPC/Ponder data
// Reduces redundant network calls across page loads and SPA navigation
// Backed by sessionStorage for persistence across navigations

const CACHE = new Map()
const CACHE_MAX = 500
const TTL = {
  short: 30 * 1000,      // 30s — for rapidly changing data (balances, owned state)
  medium: 5 * 60 * 1000, // 5min — for moderately changing data (collections, listings)
  long: 30 * 60 * 1000,  // 30min — for rarely changing data (artist domains, media details)
}

export function getCached(key) {
  const mem = CACHE.get(key)
  if (mem && Date.now() < mem.expires) return mem.data
  if (mem) CACHE.delete(key)
  try {
    const stored = sessionStorage.getItem('cache:' + key)
    if (stored) {
      const p = JSON.parse(stored)
      if (Date.now() < p.expires) { CACHE.set(key, p); return p.data }
      sessionStorage.removeItem('cache:' + key)
    }
  } catch {}
  return null
}

export function setCache(key, data, ttl = TTL.medium) {
  const entry = { data, expires: Date.now() + ttl }
  // LRU eviction: if at capacity and key is new, remove oldest entry
  if (CACHE.size >= CACHE_MAX && !CACHE.has(key)) {
    const oldest = CACHE.keys().next().value
    CACHE.delete(oldest)
  }
  CACHE.set(key, entry)
  try {
    sessionStorage.setItem('cache:' + key, JSON.stringify(entry))
  } catch {
    // sessionStorage full — evict oldest 5 cache entries and retry once
    try {
      const cacheKeys = []
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i)
        if (k && k.startsWith('cache:')) {
          try {
            const parsed = JSON.parse(sessionStorage.getItem(k))
            cacheKeys.push({ key: k, expires: parsed.expires || 0 })
          } catch {
            cacheKeys.push({ key: k, expires: 0 })
          }
        }
      }
      // sort by expires ascending (oldest first)
      cacheKeys.sort((a, b) => a.expires - b.expires)
      const toRemove = cacheKeys.slice(0, 5)
      for (const item of toRemove) {
        sessionStorage.removeItem(item.key)
        // also remove from in-memory cache
        const memKey = item.key.replace(/^cache:/, '')
        CACHE.delete(memKey)
      }
      // retry once
      sessionStorage.setItem('cache:' + key, JSON.stringify(entry))
    } catch {}
  }
}

export function invalidate(prefix) {
  for (const key of CACHE.keys()) {
    if (key.startsWith(prefix)) {
      CACHE.delete(key)
      try { sessionStorage.removeItem('cache:' + key) } catch {}
    }
  }
}

export { TTL }
