const CACHE = 'ultranote-lite-v4-full'; // bumped to force refresh after autosync adjustments
const ASSETS = ['/', '/index.html', '/manifest.json', '/styles.css', '/app.js'];
self.addEventListener('install', e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate', e=>{
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
  )
});
self.addEventListener('fetch', e=>{
  e.respondWith(caches.match(e.request).then(res=> res || fetch(e.request)));
});
