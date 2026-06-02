const CACHE = 'ultranote-lite-v109-research-refresh-fix';
const ASSETS = ['/', '/index.html', '/manifest.json', '/styles.css', '/app.js', '/autosync.js', '/ui-polish.js', '/ui-extras.js', '/editor-extras.js', '/power-features.js', '/research-mode.js', '/fonts/fonts.css'];
self.addEventListener('install', e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate', e=>{
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
  )
});
// Routing strategy:
//  • /api/* — never touched by SW (always go to network so auth + sync work)
//  • HTML / JS / CSS / manifest — network-first with cache fallback, so a
//    server-side fix reaches users on the next reload without forcing a hard
//    refresh. If the network is down, the cached copy is used.
//  • Everything else (images, fonts, etc.) — cache-first (the old behaviour).
self.addEventListener('fetch', e=>{
  const req = e.request;
  if (req.method !== 'GET') return; // POST/PUT etc. must hit network
  const url = new URL(req.url);
  // Never intercept API calls
  if (url.pathname.startsWith('/api/') || url.pathname === '/login' || url.pathname === '/logout') return;

  const isCode = /\.(?:html|js|css|json)$/i.test(url.pathname) || url.pathname === '/' || url.pathname === '/index.html';
  if (isCode) {
    // Network-first
    e.respondWith(
      fetch(req).then(res => {
        // Only cache successful, basic responses
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(()=>{});
        }
        return res;
      }).catch(() => caches.match(req).then(r => r || Response.error()))
    );
    return;
  }
  // Cache-first for everything else
  e.respondWith(caches.match(req).then(res => res || fetch(req)));
});
