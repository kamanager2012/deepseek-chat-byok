const CACHE_NAME = 'deepseek-chat-byok-v1'
const APP_SHELL_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL_URLS))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') {
    return
  }
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) {
    return
  }
  if (url.pathname.startsWith('/_proxy')) {
    return
  }

  if (url.pathname.includes('/static/')) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone()
              void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy))
            }
            return response
          })
      )
    )
    return
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone()
          void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy))
        }
        return response
      })
      .catch(async () => {
        const cached = await caches.match(request)
        if (cached) {
          return cached
        }
        if (request.mode === 'navigate') {
          const shell = await caches.match('./index.html')
          if (shell) {
            return shell
          }
        }
        return new Response('Offline', { status: 503, statusText: 'Offline' })
      })
  )
})
