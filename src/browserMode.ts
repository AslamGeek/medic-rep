// Remove only MedRep's old app-shell worker/cache. Doctor records and queued
// edits in IndexedDB remain available to the regular browser website.
export async function retireLegacyServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return
  try {
    const registration = await navigator.serviceWorker.getRegistration('/')
    if (!registration || registration.scope !== new URL('/', location.origin).href) return
    const workers = [registration.active, registration.waiting, registration.installing]
    if (!workers.some(worker => worker?.scriptURL === new URL('/sw.js', location.origin).href)) return
    await registration.unregister()
    if ('caches' in window) await caches.delete(`workbox-precache-v2-${registration.scope}`)
  } catch {
    // Restricted browser storage must not prevent opening the website.
  }
}
