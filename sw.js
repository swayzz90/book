const CACHE_NAME = 'blattwerk-shell-v2';
const SHELL = ['./','./index.html','./styles.css','./app.js','./db.js','./pdf-engine.js','./favicon.svg','./icon-192.png','./icon-512.png','./manifest.webmanifest'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('blattwerk-') && k !== CACHE_NAME).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    event.respondWith(fetch(request).then(response => {
      if (response.ok) {
        const copy=response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request,copy));
      }
      return response;
    }).catch(async () => (await caches.match(request)) || Response.error()));
    return;
  }
  // Cache the public PDF.js code after the first successful download.
  if (url.hostname === 'cdn.jsdelivr.net' && url.pathname.includes('pdfjs-dist@4.10.38/')) {
    event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
      if (response.ok || response.type === 'opaque') {
        const copy=response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request,copy));
      }
      return response;
    })));
  }
});
