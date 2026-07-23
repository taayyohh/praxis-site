const CACHE_VERSION = 'praxis-v119'
const IMMUTABLE = /\.[a-f0-9]{8}\.(js|css|woff2?|png|jpg|svg)$/
const FONTS = /\.(woff2?|ttf|otf)$/i
const IMAGES = /\.(png|jpg|jpeg|gif|webp|avif|svg|ico)$/i
const API_PATHS = ['/api/', '/ponder/', '/orchestrator/']

self.addEventListener('install', e => { self.skipWaiting() })
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()))
})

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET') return
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
      })).catch(() => caches.match(e.request))
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
      })).catch(() => caches.match(e.request))
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
      })
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
    }).catch(() => caches.match(e.request))
  )
})
