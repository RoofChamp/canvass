/* CanvassEaze — service worker
   App shell is cache-first so the app opens instantly with no signal.
   Map tiles and Leaflet are cached as you use them.
   Parcel queries are network-first with a cache fallback, so a street you
   have already walked still shows its lot lines in a dead zone. */

const SHELL = 'canvass-shell-v36';
const TILES = 'canvass-tiles-v1';
const DATA  = 'canvass-data-v1';
/* STORM DAY FILES AND THEIR INDEX. Its own cache, and both reasons are load-bearing.
   NOT the shell: the shell name is bumped every deploy and everything outside the keep
   list is deleted at activate, and this cache will hold days THE PHONE BUILT ITSELF that
   exist nowhere else until a later deploy republishes them. Losing those is losing work.
   NOT `canvass-data-v1`: that one is trimmed to 900 entries by insertion order on every
   parcel query, so an afternoon of lot lookups would quietly evict storm days.
   The name must never begin `canvass-shell-` — `isShellCache` below matches that prefix,
   and a cache caught by it can be kept as a lifeboat and searched for shell files. */
const STORMS = 'canvass-storms-v1';

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

/* THE SHELL HOLDS ONE ENTRY PER FILE, FILED UNDER ITS PLAIN ADDRESS.
   The LOOKUP has always matched with {ignoreSearch:true}, which is right — a reload
   carrying a cache-buster still finds the cached copy, and that is what lets the app open
   with no signal. The STORE did not match it: `c.put(req, …)` filed the response under
   the full address, question mark and all. So every load of `index.html?anything` added
   ANOTHER ~690 KB copy that nothing would ever look up by name and nothing would ever
   remove. Four verification fetches during one deploy left about 2 MB of duplicates in
   one browser, and it is invisible from inside the app, because the lookup ignores the
   query string and answers out of the first entry regardless.

   THE FIX IS TO STORE NOTHING FOR A CACHE-BUSTED LOAD, and the first attempt at it was
   worse than the bug. Filing the refreshed copy under the plain address does stop the
   duplicates — and it also turns a write that used to land on an inert junk key into a
   write straight over the live copy of index.html. The load used to verify a deploy is
   exactly that shape, and it is made at the one moment the server is least trustworthy:
   `_PROGRESS.md` has GitHub's edge serving the old build for four minutes after a push
   with the deployments API already reporting success. That would have left a phone
   opening the wrong build in a dead zone, permanently, with the cache marked complete and
   every check reporting healthy. Two review agents found it independently.
   So: a plain load refreshes the shell, exactly as it always has. A cache-busted load is
   served from the cache and stores nothing at all. No duplicates, and the live copy is
   only ever replaced by the same request that replaced it before this change.

   `bareKey(u) === u` is the test for "no query string", and it is written that way rather
   than as `!new URL(u).search` on purpose: a URL ending in a bare `?` has an EMPTY search
   and is still a distinct cache key, so the obvious test lets that one shape through.

   Why `trim()` is not simply pointed at this cache, and the first version of this comment
   had the reason WRONG — it said the oldest entry is index.html. It is not. The precache
   runs `Promise.allSettled`, so entries land in completion order, and index.html at
   690 KB is among the LAST to arrive, not the first; a background refresh then moves it
   later still. The real reason is better: everything in this cache is a file the app
   cannot open without, so a size cap on it is a cap on whether the app opens, and
   "oldest" here means "longest since it was successfully refreshed" — which is precisely
   the file that failed to come down in a dead zone. Bounding the cache by what may be
   stored, rather than by count, is the right instrument. */
const bareKey = u => {
  try { const x = new URL(u); return x.origin + x.pathname; } catch (err) { return u; }
};

/* A RESPONSE THAT ARRIVED BY REDIRECT CANNOT BE SERVED TO A NAVIGATION.
   The browser rejects it outright — the app does not open, every time, with signal or
   without. `./` is precached, and a host that redirects `/` to `/index.html` is an
   ordinary hosting change; `c.add` follows the redirect and stores what it landed on,
   redirect flag and all. Harmless today only because `start_url` is `./index.html`, so
   nothing navigates to `./`. One hosting change away from the app never opening again.
   Rebuilding the response around the same body, status and headers clears the flag.
   Used by the precache and by the carry-over in activate. The background refresh does not
   use it — it declines to store a redirected response at all, which is the conservative
   half of the same question: the precache has already dealt with the legitimate case, and
   stripping the flag off a runtime response would make a redirect the app never asked for
   servable to a navigation.
   `res` is CLONED before its body is read. Reading it directly and then handing `res`
   back from the catch returns a response whose body is already used, and the caller's
   `c.put` rejects on it — so the guard that reads as "leave that one as it came" would
   quietly have stored nothing at all.
   `content-encoding`, `content-length` and `content-range` are dropped: the body here has
   already been decoded, and carrying a header that says otherwise onto it is a mismatch
   waiting for a browser that trusts it. */
async function unredirected(res) {
  if (!res || !res.redirected) return res;
  try {
    const copy = res.clone();
    const h = new Headers(res.headers);
    h.delete('content-encoding'); h.delete('content-length'); h.delete('content-range');
    return new Response(await copy.blob(), { status: res.status, statusText: res.statusText, headers: h });
  } catch (err) { return res; }
}

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
    /* Strip the redirect flag off anything that came back through one. CORE only: these
       are the app's own files and any of them can be the target of a navigation. Leaflet
       is script and stylesheet — a redirected response is served to those without
       complaint, and unpkg does redirect. Each file is guarded on its own, because this
       is tidying, and tidying must never be the reason a complete shell is refused. */
    for (const f of CORE_FILES) {
      try {
        const hit = await c.match(f);
        if (hit && hit.redirected) await c.put(f, await unredirected(hit));
      } catch (err) { /* leave that one as it came; the shell is still complete */ }
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

      /* FOLD AWAY DUPLICATES A PREVIOUS BUILD LEFT IN THIS CACHE.
         BE EXACT ABOUT WHAT THIS DOES AND DOES NOT REACH. It opens SHELL and nothing
         else, so it touches only the cache this build is installing into. On the ordinary
         deploy that makes it a no-op: SHELL is brand new, the precache writes plain keys,
         and the bloated old shell — the one holding the ~2 MB — is reclaimed whole by
         `caches.delete` further down, which is code that was already here. The first
         version of this comment claimed it also cleaned up the ONE old shell kept as a
         lifeboat. It does not, and it deliberately will not: a lifeboat is only kept when
         this install came up SHORT, which makes it the only shell on the phone that can
         open the app. Tidying inside it is exactly the class of clever housekeeping that
         destroyed data three times in round eleven. Its duplicates cost storage and stay.
         What is left for this loop is the build that ships without bumping the cache name,
         where SHELL is the same cache it has always been, duplicates and all — and one
         migration off a build made before this change. From v25 on, nothing writes a
         query-keyed entry, so it finds nothing.
         It runs before the carry-over and the completeness proof so that every step after
         it reads plain keys instead of duplicates. That ordering is tidiness, NOT safety,
         and it is worth being exact about which is which: the safety is one line, and it
         is the `preserved` flag below. Nothing is deleted until a plain-address copy is
         confirmed to exist. When the copy cannot be made — a phone at its storage limit —
         the duplicate is left exactly where it is. That costs storage. Deleting it would
         cost the file.
         Measured, not assumed: moving this block below the completeness proof changes the
         outcome of none of the service-worker checks. It is written down because a
         comment claiming an ordering is load-bearing, when nothing can tell, is how the
         wrong thing survives the next edit. */
      try {
        for (const r of await c.keys()) {
          const bare = bareKey(r.url);
          /* Not `!new URL(r.url).search`: a URL ending in a bare `?` has an empty search
             and is still a separate cache key, so that test leaves the duplicate behind.
             An address that will not parse comes back unchanged and is skipped. */
          if (bare === r.url) continue;
          let preserved = false;
          try {
            if (await c.match(bare)) preserved = true;
            else {
              const hit = await c.match(r);
              if (hit) { await c.put(bare, await unredirected(hit.clone())); preserved = true; }
              else preserved = true;   /* nothing readable under it to lose */
            }
          } catch (err) { preserved = false; }
          if (preserved) { try { await c.delete(r); } catch (err) {} }
        }
      } catch (err) { /* could not list the shell; the steps below still run */ }

      /* Anything this install could not get, taken out of a shell it is replacing. */
      for (const f of SHELL_FILES) {
        try {
          if (await c.match(f, {ignoreSearch:true})) continue;
          for (const k of olderShells) {
            const old = await caches.open(k);
            const hit = await old.match(f, {ignoreSearch:true});
            /* Cleaned on the way in. A shell built before this change can be holding a
               redirected copy of './', and carrying it forward would carry the fault
               forward with it, into the shell that is about to become the only one. */
            if (hit) { await c.put(f, await unredirected(hit.clone())); break; }
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

      /* THIS LOOP USED TO DELETE BY A LIST OF FOUR NAMES, AND THAT WAS A TRAP.
         It read `if (k === SHELL || k === TILES || k === DATA || k === keep) continue;`
         — deny by default over the whole cache namespace. Every cache this file did not
         personally know about was destroyed, silently, inside the catch below.
         That was survivable while every cache was rebuildable from the network. It stopped
         being survivable the moment a cache could hold something the network does not have:
         `canvass-storms-v1` will carry storm days THE PHONE BUILT ITSELF, and until a later
         deploy republishes them they exist nowhere else. Under the old rule, adding that
         cache and forgetting to add its name here would have wiped them on the next ordinary
         deploy — no error, no warning, discovered at a door with no signal.
         So the rule is inverted. THIS LOOP ONLY EVER DELETES OLD APP SHELLS. Anything that is
         not a shell is left alone, whoever wrote it and whether or not this file knows the
         name. A cache that is genuinely dead now costs storage until someone removes it on
         purpose, and that is the correct side to err on: storage is cheap and his work is not.
         KEEP IT THIS WAY. If a future cache ever does need clearing, clear it by name, here,
         deliberately — do not turn this back into a list of survivors. */
      for (const k of keys) {
        if (!isShellCache(k)) continue;          // tiles, parcel answers, storms, anything new
        if (k === SHELL || k === keep) continue; // this build, and the one lifeboat
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

/* STORM FILES. Same origin AND under the storms folder — both halves are needed.
   The same-origin half is not decoration: this test runs BEFORE the shell-scope guard
   below, so without it any third-party address that happened to contain the word would be
   pulled into the storm cache and answered from it for ever.
   Matching on the PATH and never on a query string is the whole design, and the note below
   explains why it has to be. */
const isStormFile = u => {
  let url;
  try { url = new URL(u); } catch (err) { return false; }
  return url.origin === self.location.origin && /\/storms\/v\d+\//.test(url.pathname);
};

/* What a storm file that is not on the phone and cannot be fetched comes back as.
   A 504 so `res.ok` is false, and a JSON body so a reader that goes straight to .json()
   gets an object with a flag rather than a syntax error out of the word "Offline". */
const stormMiss = () => new Response(
  JSON.stringify({ offline: true, note: 'storm file not on this phone and no signal' }),
  { status: 504, headers: { 'Content-Type': 'application/json' } });

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

  /* STORM FILES. This branch must sit HERE — after the parcel queries and BEFORE the
     shell-scope guard below — and the position is not a style choice.
     Storm files are same-origin, so `isShellScope` says yes to them, so without this
     branch they fall into the app-shell handler at the bottom of this file and are written
     into `canvass-shell-vNN`. That looks fine and works fine right up until the next
     deploy bumps the shell name, at which point activate deletes the lot. There is a live
     example of the same fault already in the tree: icon-512-maskable.png is in the
     manifest but not in CORE_FILES, so it is a shell squatter with no lifecycle.

     THE INDEX is network-first with a short timeout and a cache fallback. It is the one
     mutable file — report counts change as people file late — and it is small. The timeout
     matters: on one bar a plain network-first hangs the whole storm panel until the phone
     gives up on its own, and he opens this in a truck.

     THE DAY FILES are cache-first and never revalidated here. A day that has been built is
     finished; its geometry will not change. Two things write into this cache: this branch,
     when a published file is fetched on a miss, and THE PAGE ITSELF, which puts the days it
     builds straight in through caches.open(). There is no message channel in this file and
     none is wanted — the page is a first-class writer here, which is exactly why the delete
     loop above had to stop being a list of four names.
     Because this branch never revalidates, the job of noticing that a published day has
     been rebuilt belongs to the page: it compares each day's build stamp against the index
     and re-fetches what changed. Doing it here would mean a network round trip per day on
     every draw, which is the opposite of what an offline-first layer is for.

     NOTHING IS TRIMMED. The tiles and parcel caches are capped because they grow without
     limit as he drives; this one is a finite library measured in hundreds of files, and a
     trim here would evict from the FRONT of the key list, which is oldest-written — so it
     would throw away real storm days and keep whatever junk arrived last. The size guard
     lives in the page, before the download, where it can say so on screen.

     A MISS WITH NO SIGNAL RETURNS A 504 CARRYING JSON, not the plain-text 503 the shell
     branch uses. Storm code reads these as data, and a text body would blow up in the JSON
     parser as a syntax error rather than reading as "not here yet". Both the status and the
     body say the same thing, so either check works. */
  if (isStormFile(url)) {
    e.respondWith((async () => {
      const c = await caches.open(STORMS);
      const isIndex = /\/manifest\.json$/.test(new URL(url).pathname);

      if (isIndex) {
        const timeout = new Promise(r => setTimeout(() => r(null), 4000));
        try {
          const res = await Promise.race([fetch(req), timeout]);
          if (res && res.ok && !res.redirected) { await c.put(req, res.clone()); return res; }
          if (res && res.ok) return res;   /* arrived via a redirect: serve it, do not store it */
        } catch (err) { /* fall through to whatever is on the phone */ }
        const hit = await c.match(req);
        return hit || stormMiss();
      }

      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        /* !res.redirected for the same reason the shell branch checks it: a stored
           redirected response cannot be served to a navigation later, and storing one is
           how a file gets permanently unusable with nothing on screen to say why. */
        if (res.ok && !res.redirected) await c.put(req, res.clone());
        if (res.ok) return res;
        return stormMiss();
      } catch (err) { return stormMiss(); }
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
    /* THREE CONDITIONS BEFORE ANYTHING IS WRITTEN BACK, and each one is load-bearing.
       `res.ok` — an error page is not the app.
       `bareKey(url) === url` — no query string. This is the whole cure for the cache
       growing without limit, and it is also what keeps a cache-busted load from writing
       over the live copy of index.html. A cache-busted load is answered out of the cache
       and stores nothing.
       `!res.redirected` — a redirected response is ambiguous at runtime. The precache has
       already handled the legitimate case, and laundering a redirect the app never asked
       for into a copy servable to a navigation is not a trade worth making. */
    const net = fetch(req).then(res => {
      if (res.ok && !res.redirected && bareKey(url) === url) refreshShell(c, req, res.clone());
      return res;
    }).catch(() => null);
    if (hit) return hit;
    const res = await net;
    if (res) return res;
    /* This build's shell has not got it and there is no signal to go and fetch it. Before
       handing him a blank offline page, look in whatever shell is still on the phone. */
    return (await olderShellMatch(req)) || new Response('Offline', {status:503});
  })());
});

/* The background refresh. Deliberately not awaited — the answer has already gone back to
   the page — so it must swallow its own failures. A phone at its storage limit rejects on
   `put`, and an unhandled rejection there surfaces as a page error for a request that was
   served perfectly well out of the cache. v24 had the bare `c.put` and that rejection.
   The REQUEST is passed, not a string built from its address. A request carries the
   headers an entry is matched against when the response names any of them in `Vary`, and
   a key built from a string carries none. GitHub Pages sends `Vary: Accept-Encoding`
   today, which is a forbidden header name and appears on neither side, so it matches
   either way — but a host that added `Vary: Accept` tomorrow would stop a string-keyed
   entry ever matching a navigation, and this is the only path that can re-store one under
   the real request. Keeping it that way is what leaves the shell able to heal itself.
   BE STRAIGHT ABOUT WHERE THAT IS NOT TRUE: the fold in `activate` writes `c.put(bare, …)`
   with a plain string, because folding a duplicate means writing it under a DIFFERENT
   address from the one the request names, and there is no request for that address to
   borrow. It is a migration path, it runs on duplicates only, and the first plain load
   with signal re-stores the file under the real request through this function. Said here
   because the sentence above, left alone, reads as a rule the file keeps everywhere. It
   does not.
   NOTHING IS STORED FOR A CACHE-BUSTED LOAD, and that gives up one thing v24 had by
   accident. A shell that was somehow missing index.html used to be healed by the next
   cache-busted load with signal, because the entry it left behind was found by the
   {ignoreSearch:true} lookup. That is gone. It is the price of not writing a stale edge
   over the live copy, it is the right way round, and the case is close to unreachable in
   any event — an install that fails is thrown away by the browser and the previous worker
   carries on with its complete cache. Written down so nobody rediscovers it as a bug. */
function refreshShell(c, req, res) {
  (async () => { await c.put(req, res); })().catch(() => {});
}

async function trim(name, max) {
  const c = await caches.open(name);
  const keys = await c.keys();
  if (keys.length <= max) return;
  for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]);
}
