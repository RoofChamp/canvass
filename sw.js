/* CanvassEaze — service worker
   App shell is cache-first so the app opens instantly with no signal.
   Map tiles and Leaflet are cached as you use them.
   Parcel queries are network-first with a cache fallback, so a street you
   have already walked still shows its lot lines in a dead zone. */

const SHELL = 'canvass-shell-v15';
const TILES = 'canvass-tiles-v1';
const DATA  = 'canvass-data-v1';

const SHELL_FILES = [
  './', './index.html', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './icon-180.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    await Promise.allSettled(SHELL_FILES.map(f => c.add(new Request(f, {cache:'reload'}))));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => ![SHELL, TILES, DATA].includes(k)).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

const isTile = u =>
  /tile\.openstreetmap\.org/.test(u) ||
  /server\.arcgisonline\.com\/ArcGIS\/rest\/services\/World_Imagery/.test(u);

const isParcelQuery = u => /\/(MapServer|FeatureServer)\/\d+\/query/i.test(u);

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = req.url;

  // The OSRM bypass that used to sit here went with the "Getting back" screen in v8.

  // Map tiles: cache-first, capped so the phone does not fill up.
  if (isTile(url)) {
    e.respondWith((async () => {
      const c = await caches.open(TILES);
      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok) { c.put(req, res.clone()); trim(TILES, 2500); }
        return res;
      } catch (err) { return hit || Response.error(); }
    })());
    return;
  }

  // Parcel queries: fresh when there is signal, last known when there is not.
  if (isParcelQuery(url)) {
    e.respondWith((async () => {
      const c = await caches.open(DATA);
      try {
        const res = await fetch(req);
        if (res.ok) { c.put(req, res.clone()); trim(DATA, 900); }
        return res;
      } catch (err) {
        const hit = await c.match(req);
        if (hit) return hit;
        throw err;
      }
    })());
    return;
  }

  // App shell + Leaflet: cache-first, refresh in the background.
  e.respondWith((async () => {
    const c = await caches.open(SHELL);
    const hit = await c.match(req, {ignoreSearch:true});
    const net = fetch(req).then(res => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => null);
    return hit || (await net) || new Response('Offline', {status:503});
  })());
});

async function trim(name, max) {
  const c = await caches.open(name);
  const keys = await c.keys();
  if (keys.length <= max) return;
  for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]);
}
