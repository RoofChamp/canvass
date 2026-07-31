/* CanvassEaze — service worker
   App shell is cache-first so the app opens instantly with no signal.
   Map tiles and Leaflet are cached as you use them.
   Parcel queries are network-first with a cache fallback, so a street you
   have already walked still shows its lot lines in a dead zone. */

const SHELL = 'canvass-shell-v24';
const TILES = 'canvass-tiles-v1';
const DATA  = 'canvass-data-v1';

/* WITHOUT THESE FILES THE APP DOES NOT OPEN. All of them are this app's own, off the
   same server the phone just fetched sw.js from, so if any one of them cannot be had,
   the connection is not good enough to be replacing a working app with. */
const CORE_FILES = [
  './', './index.html', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './icon-180.png',
];
/* Leaflet, off a CDN we do not control. Missing it costs him the big map's lot lines in
   a dead zone — real, but not the app refusing to open — and unpkg being slow for ten
   seconds is not a reason to hold a build off his phone for a week. Tried, carried over
   from the last shell if it fails, and never fatal. */
const EXTRA_FILES = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];
const SHELL_FILES = CORE_FILES.concat(EXTRA_FILES);

const isShellCache = k => k.startsWith('canvass-shell-');

/* A SHELL THAT FINISHED INSTALLING SAYS SO, IN WRITING.
   Without this there is no way to tell a complete shell from the wreckage of an install
   that failed halfway — and the wreckage always carries the HIGHER version number, so
   "keep the newest one as a lifeboat" reliably kept the broken one and deleted the last
   good one. Sequence: v25 fails on bad signal and leaves a part-built cache behind; v26
   installs but misses Leaflet; v26's activate then keeps v25 (newest) and deletes v24,
   the only shell on the phone that could actually open the app.
   It is a same-origin path nothing ever requests, so it can never be served by mistake,
   and it is not in SHELL_FILES so it is never counted as a file the shell owes. */
const MARK = './__shell-complete';
async function markComplete(c) {
  try { await c.put(MARK, new Response('ok', { status:200 })); } catch (err) { /* storage full: it just stays unmarked */ }
}
async function isMarked(name) {
  try { const c = await caches.open(name); return !!await c.match(MARK); } catch (err) { return false; }
}

/* THE UPDATE THAT LEFT THE TRUCK WITH NO APP AT ALL.
   This used to be one Promise.allSettled, which never rejects. On a bad signal — the
   ordinary case on the road out to Mount Sterling — index.html could fail to download
   and the install still reported SUCCESS. The worker activated, activate deleted every
   cache that was not this one, and the phone was left holding a shell with no index.html
   in it and no previous shell to fall back on. Next time he opened the app with no
   signal, the fetch handler found nothing, could not reach the network, and served the
   503. Not lost data — the doors are in the database — but no way in to them, in a truck,
   with no signal, which is the one situation the whole cache exists for.
   An install that did not get everything must FAIL. A failed install is thrown away by
   the browser, the worker already running keeps running, and its complete cache with it.
   He stays on the previous build and does not know it, which is the correct outcome: the
   next open with real signal brings the update down properly. */
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    const got = await Promise.allSettled(CORE_FILES.map(f => c.add(new Request(f, {cache:'reload'}))));
    const missed = CORE_FILES.filter((f, i) => got[i].status === 'rejected');
    if (missed.length) {
      /* The partial cache is LEFT ALONE on purpose. Deleting it here reads as tidy and is
         a trap: `caches.open(SHELL)` finds the cache BY NAME, so a build that shipped
         without bumping the name would be deleting the very cache the live app is being
         served out of. It is left unmarked instead, which is what keeps it from ever
         being mistaken for a working shell, and the next activate that gets that far
         clears it away.
         Worth being straight about what this does NOT save him from: on a build that
         forgot to bump the name, `c.add` above has already overwritten some entries of
         the live cache in place, so it can be left holding a new index.html beside old
         icons. Bumping the name every deploy is the thing that prevents that, and it is
         in the working rules for this reason. */
      throw new Error('shell incomplete, install refused: ' + missed.join(', '));
    }
    await Promise.allSettled(EXTRA_FILES.map(f => c.add(new Request(f, {cache:'reload'}))));
    /* Marked once the app's own files are all in. Leaflet is deliberately not part of
       this test: a shell without it still opens and still works the doors. */
    await markComplete(c);
    self.skipWaiting();
  })());
});

/* EVERY STEP IN HERE IS GUARDED, and that is not belt and braces.
   `activate` fires exactly ONCE per worker and is never retried, and a rejected activate
   does not stop the worker activating — it just abandons whatever was left to do, for
   good. A phone near its storage limit throws `QuotaExceededError` on a single cache
   write; unguarded, that one throw meant the carry-over stopped at the first missing
   file, the completeness proof never ran, not one stale cache was ever cleared, and
   `clients.claim()` never happened — silently, permanently, until the next deploy.
   Each step is allowed to fail on its own and the ones after it still run. */
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    try {
      const c = await caches.open(SHELL);
      const keys = await caches.keys();
      /* Newest first, so a file is carried over — and later served — from the most recent
         shell that has it, not from whichever the browser happens to list first.
         `caches.keys()` comes back in CREATION order, not sorted. */
      const olderShells = byNewest(keys.filter(k => isShellCache(k) && k !== SHELL));

      /* Anything this install could not get, taken out of a shell it is replacing. */
      for (const f of SHELL_FILES) {
        try {
          if (await c.match(f, {ignoreSearch:true})) continue;
          for (const k of olderShells) {
            const old = await caches.open(k);
            const hit = await old.match(f, {ignoreSearch:true});
            if (hit) { await c.put(f, hit.clone()); break; }
          }
        } catch (err) { /* this one file could not be carried; the rest still can */ }
      }

      /* PROVED, not assumed. Only a shell that holds everything earns the right to have
         the last one deleted. */
      let complete = true;
      for (const f of SHELL_FILES) {
        try { if (!await c.match(f, {ignoreSearch:true})) { complete = false; break; } }
        catch (err) { complete = false; break; }
      }
      if (complete) await markComplete(c);

      /* One lifeboat, and only one — a shell is about a megabyte and he is not giving up
         his phone's storage to a stack of them. A shell that FINISHED installing is
         preferred over a newer one that did not, because the newer one is, by definition,
         the wreckage of a failed update. Falling back to the plain newest covers the one
         changeover where no shell on the phone carries a mark yet, because it was built
         by the version of this file that had no marks. */
      let keep = null;
      if (!complete) {
        for (const k of olderShells) if (await isMarked(k)) { keep = k; break; }
        if (!keep) keep = olderShells[0] || null;
      }

      for (const k of keys) {
        if (k === SHELL || k === TILES || k === DATA || k === keep) continue;
        try { await caches.delete(k); } catch (err) { /* leave it; it costs storage, not correctness */ }
      }
    } catch (err) {
      /* Whatever went wrong above, the worker is active either way. Better it takes the
         clients than leaves them on a worker the browser has already replaced. */
    }
    try { await self.clients.claim(); } catch (err) {}
  })());
});

/* Shell names are `canvass-shell-vN`. Sorted as numbers, because v9 sorts after v10 as
   text and would put the older of the two first. */
function byNewest(names) {
  const num = n => { const m = /canvass-shell-v(\d+)/.exec(n); return m ? Number(m[1]) : -1; };
  return names.slice().sort((a, b) => num(b) - num(a));
}

/* The last resort in the fetch handler: any shell still on the phone beats the offline
   page. An older index.html opens, reads the very same database, and he can work.
   Newest first — the stalest copy on the phone is the worst answer available, and
   `caches.keys()` would hand it over first. */
async function olderShellMatch(req) {
  const keys = await caches.keys();
  for (const k of byNewest(keys.filter(k => isShellCache(k) && k !== SHELL))) {
    try {
      const c = await caches.open(k);
      const hit = await c.match(req, {ignoreSearch:true});
      if (hit) return hit;
    } catch (err) { /* try the next one */ }
  }
  return null;
}

const isTile = u =>
  /tile\.openstreetmap\.org/.test(u) ||
  /server\.arcgisonline\.com\/ArcGIS\/rest\/services\/World_Imagery/.test(u);

const isParcelQuery = u => /\/(MapServer|FeatureServer)\/\d+\/query/i.test(u);

/* What the shell cache is allowed to touch: this app's own files, and Leaflet from the
   CDN. Everything else goes straight to the network and is never looked up, never stored.

   Why this guard exists, and it is not hypothetical. The shell lookup below uses
   {ignoreSearch:true} on purpose, so a reload of index.html carrying a cache-buster still
   finds the cached copy and the app still opens with no signal. Without this guard that
   same setting was applied to EVERY request that was not a tile or a parcel query — so
   any two URLs differing only in their query string matched each other. A per-house
   lookup, where the house IS the query string, would answer with the FIRST house's result
   for every house after it, and would keep doing it after a restart, because by then the
   wrong answer is in the cache. The old catch-all also called cache.put() on requests of
   any scheme, and a chrome-extension:// request throws there.

   One thing to watch when same-origin DATA files arrive — the storm layer would be the
   first: they pass this guard, so they must differ by PATH and never by query string, or
   they will collide with each other in exactly the same way. */
const isShellScope = u => {
  let url;
  try { url = new URL(u); } catch (err) { return false; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (url.origin === self.location.origin) return true;
  return url.hostname === 'unpkg.com' && url.pathname.startsWith('/leaflet@');
};

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

  /* Anything that is not this app's own file or Leaflet: hands off entirely. No cache
     lookup, no store, no respondWith — the browser does what it would have done with no
     service worker at all. */
  if (!isShellScope(url)) return;

  // App shell + Leaflet: cache-first, refresh in the background.
  e.respondWith((async () => {
    const c = await caches.open(SHELL);
    const hit = await c.match(req, {ignoreSearch:true});
    const net = fetch(req).then(res => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => null);
    if (hit) return hit;
    const res = await net;
    if (res) return res;
    /* This build's shell has not got it and there is no signal to go and fetch it. Before
       handing him a blank offline page, look in whatever shell is still on the phone. */
    return (await olderShellMatch(req)) || new Response('Offline', {status:503});
  })());
});

async function trim(name, max) {
  const c = await caches.open(name);
  const keys = await c.keys();
  if (keys.length <= max) return;
  for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]);
}
