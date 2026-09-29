// Retirement worker at the original URL: existing PWA clients can update away
// from the cached app shell. New visitors never register a service worker.
self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await caches.delete(`workbox-precache-v2-${self.registration.scope}`).catch(() => undefined)
    await self.clients.claim()
    await self.registration.unregister()
  })())
})
