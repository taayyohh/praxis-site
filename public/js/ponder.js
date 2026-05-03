// Local /ponder for milesxb.bio and ourpraxis.network (same server).
// All other artist sites use ourpraxis.network/ponder as the canonical indexer.
// All sites use the canonical Ponder indexer at ourpraxis.network
const PONDER_URL = (() => {
  if (typeof window !== 'undefined') {
    const host = window.location.hostname
    // Use local /ponder only on ourpraxis.network itself (same server)
    if (host === 'ourpraxis.network') return '/ponder'
  }
  return 'https://ourpraxis.network/ponder'
})()

const TIMEOUT_MS = 15000
const MAX_RETRIES = 2
const RETRY_DELAYS = [1000, 3000]  // exponential backoff base delays
const JITTER_MAX = 500             // random jitter 0-500ms

// Circuit breaker: after 5 consecutive failures in 30s, stop retrying for 10s
const CIRCUIT_FAIL_THRESHOLD = 5
const CIRCUIT_FAIL_WINDOW = 30000   // 30 seconds
const CIRCUIT_OPEN_DURATION = 10000 // 10 seconds
let _circuitFailures = []
let _circuitOpenUntil = 0
let _consecutiveSuccesses = 0

function _circuitBreakerCheck() {
  const now = Date.now()
  // if circuit is open, reject immediately
  if (now < _circuitOpenUntil) return false
  return true
}

function _circuitBreakerRecord() {
  _consecutiveSuccesses = 0
  const now = Date.now()
  _circuitFailures.push(now)
  // trim old failures outside the window + cap array size
  _circuitFailures = _circuitFailures.filter(t => now - t < CIRCUIT_FAIL_WINDOW)
  if (_circuitFailures.length > CIRCUIT_FAIL_THRESHOLD * 2) _circuitFailures = _circuitFailures.slice(-CIRCUIT_FAIL_THRESHOLD)
  if (_circuitFailures.length >= CIRCUIT_FAIL_THRESHOLD) {
    _circuitOpenUntil = now + CIRCUIT_OPEN_DURATION
    _circuitFailures = []
  }
}

function _circuitBreakerReset() {
  _consecutiveSuccesses++
  if (_consecutiveSuccesses >= 3) {
    _circuitFailures = []
    _circuitOpenUntil = 0
  }
}

// --- Query-level cache (30s TTL) ---
const _queryCache = new Map()
const QUERY_CACHE_TTL = 60000 // 60 seconds

function _queryCacheKey(gql, variables) {
  return gql + '\0' + JSON.stringify(variables)
}

function _queryCacheGet(key) {
  const entry = _queryCache.get(key)
  if (!entry) return undefined
  if (Date.now() - entry.ts > QUERY_CACHE_TTL) {
    _queryCache.delete(key)
    return undefined
  }
  return entry.data
}

const QUERY_CACHE_MAX = 500
function _queryCacheSet(key, data) {
  // evict stale entries if cache grows large
  if (_queryCache.size > 200) {
    const now = Date.now()
    for (const [k, v] of _queryCache) {
      if (now - v.ts > QUERY_CACHE_TTL) _queryCache.delete(k)
    }
  }
  // hard cap: evict oldest if still over max
  if (_queryCache.size >= QUERY_CACHE_MAX) {
    const oldest = _queryCache.keys().next().value
    _queryCache.delete(oldest)
  }
  _queryCache.set(key, { data, ts: Date.now() })
}

async function fetchWithTimeout(url, opts, timeout) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    return await fetch(url, { ...opts, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

// In-flight coalescing: identical concurrent queries share one upstream call.
// Bounded in case a flood of distinct queries never settle — old entries are
// evicted rather than allowed to grow forever. Promises get cleaned up on
// settle, so this limit only matters under pathological concurrency.
const _inflightQueries = new Map()
const INFLIGHT_MAX = 500

export async function query(gql, variables = {}) {
  // query-level cache check
  const cacheKey = _queryCacheKey(gql, variables)
  const cached = _queryCacheGet(cacheKey)
  if (cached !== undefined) return cached

  // coalesce concurrent identical queries — share the same in-flight promise
  if (_inflightQueries.has(cacheKey)) return _inflightQueries.get(cacheKey)

  // circuit breaker check
  if (!_circuitBreakerCheck()) {
    throw new Error('ponder circuit breaker open — too many recent failures')
  }

  const promise = (async () => {
    let lastError
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetchWithTimeout(PONDER_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: gql, variables }),
        }, TIMEOUT_MS)
        if (!res.ok) throw new Error(`ponder ${res.status}`)
        const json = await res.json()
        if (json.errors) throw new Error(json.errors[0]?.message || 'query error')
        _circuitBreakerReset()
        _queryCacheSet(cacheKey, json.data)
        return json.data
      } catch (e) {
        lastError = e
        _circuitBreakerRecord()
        if (attempt < MAX_RETRIES) {
          // check circuit breaker before retrying
          if (!_circuitBreakerCheck()) break
          const baseDelay = RETRY_DELAYS[attempt] || RETRY_DELAYS[RETRY_DELAYS.length - 1]
          const jitter = Math.random() * JITTER_MAX
          await new Promise(r => setTimeout(r, baseDelay + jitter))
        }
      }
    }
    throw lastError
  })()
  // Track in flight; remove after settles so future calls re-fetch fresh.
  // Use then(cleanup, cleanup) instead of finally() to avoid creating an unhandled
  // rejection chain when the original promise rejects.
  if (_inflightQueries.size >= INFLIGHT_MAX) {
    // evict oldest — Map preserves insertion order
    const oldest = _inflightQueries.keys().next().value
    if (oldest) _inflightQueries.delete(oldest)
  }
  _inflightQueries.set(cacheKey, promise)
  const cleanup = () => _inflightQueries.delete(cacheKey)
  promise.then(cleanup, cleanup)
  return promise
}
