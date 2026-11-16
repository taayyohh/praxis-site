const CACHE_VERSION = 'praxis-v146'
const IMMUTABLE = /\.[a-f0-9]{8}\.(js|css|woff2?|png|jpg|svg)$/
const FONTS = /\.(woff2?|ttf|otf)$/i
const IMAGES = /\.(png|jpg|jpeg|gif|webp|avif|svg|ico)$/i
const API_PATHS = ['/api/', '/ponder/', '/orchestrator/']

// respondWith() throws TypeError if the promise resolves to anything
// that isn't a Response — including undefined. Every fallback path has
// to end in a real Response, so wrap offline misses in a synthetic 504.
const offline = () => new Response('offline', { status: 504, statusText: 'Offline', headers: { 'Content-Type': 'text/plain' } })
const orOffline = (r) => r || offline()

self.addEventListener('install', e => { self.skipWaiting() })
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()))
})

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET') return
  // blob:/data: URLs are browser-local and have no network to fetch from.
  // Letting them fall into the cache-or-network fallback below caused image
  // decode failures during profile-pic uploads (createObjectURL → <img>.src
  // → sw intercept → network fetch fails → cache miss → old code returned
  // undefined, img.onerror fired).
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return
  if (url.origin !== location.origin) return
  if (API_PATHS.some(p => url.pathname.startsWith(p))) return

  // Fingerprinted assets: cache-first (hash in filename = immutable)
  if (IMMUTABLE.test(url.pathname)) {
    e.respondWith(
      caches.match(e.request).then(c => c || fetch(e.request).then(r => {
        if (!r.ok) return r
        const clone = r.clone()
        caches.open(CACHE_VERSION).then(cache => cache.put(e.request, clone))
        return r
      })).catch(() => caches.match(e.request)).then(orOffline)
    )
    return
  }

  // Fonts + images: cache-first (rarely change)
  if (FONTS.test(url.pathname) || IMAGES.test(url.pathname)) {
    e.respondWith(
      caches.match(e.request).then(c => c || fetch(e.request).then(r => {
        if (!r.ok) return r
        const clone = r.clone()
        caches.open(CACHE_VERSION).then(cache => cache.put(e.request, clone))
        return r
      })).catch(() => caches.match(e.request)).then(orOffline)
    )
    return
  }

  // Non-fingerprinted JS/CSS: stale-while-revalidate
  if (/\.(js|css)$/i.test(url.pathname)) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        const fresh = fetch(e.request).then(r => {
          if (r.ok) {
            const clone = r.clone()
            caches.open(CACHE_VERSION).then(cache => cache.put(e.request, clone))
          }
          return r
        }).catch(() => cached)
        return cached || fresh
      }).then(orOffline)
    )
    return
  }

  // HTML: network-first, cache fallback (offline shell)
  e.respondWith(
    fetch(e.request).then(r => {
      if (r.ok) {
        const clone = r.clone()
        caches.open(CACHE_VERSION).then(cache => cache.put(e.request, clone))
      }
      return r
    }).catch(() => caches.match(e.request)).then(orOffline)
  )
})
