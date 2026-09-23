/*
 * Service worker for CAE Learning Hub.
 *
 * The app is 100% static and keeps every byte of progress in LocalStorage, so
 * once its shell and chunks are cached there is nothing left that needs the
 * network. That makes full offline use genuinely achievable here.
 *
 * Strategy:
 *   navigations        network-first  — a redeploy is picked up on the next load,
 *                                       and the cached copy answers when offline
 *   /_next/static/*    cache-first    — content-hashed by the bundler, immutable
 *   everything else    stale-while-revalidate
 *
 * On install we also parse each route's HTML for its `/_next/static/...` URLs and
 * precache those, so the app works offline after a single online visit rather
 * than needing one visit per page.
 *
 * Bump CACHE_VERSION on every deploy.
 */

const CACHE_VERSION = "2026-09-23";
const CACHE_PREFIX = "cae-hub-";
const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`;

/** How many previous caches to keep alive. See `activate` for why more than one. */
const KEEP_OLD_CACHES = 1;

/** Every route in the app. `trailingSlash` is on, so each one ends in a slash. */
const ROUTES = [
  "/",
  "/vocabulary/",
  "/reading/",
  "/quiz/",
  "/speaking/",
  "/mistakes/",
  "/statistics/",
  "/settings/",
];

/** Small, fixed assets worth having before the first navigation. */
const STATIC_ASSETS = [
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
];

// ── install ──────────────────────────────────────────────────────────────────

/**
 * Cache every route, plus the hashed chunks each one references.
 *
 * Reading the chunk URLs out of the HTML is what lets the whole app — including
 * the lazily-loaded 180-article bundle — work offline after one visit.
 */
async function precache(cache) {
  const extra = new Set();

  await Promise.all(
    ROUTES.map(async (route) => {
      try {
        const res = await fetch(route, { cache: "reload" });
        if (!res.ok) return;
        const html = await res.clone().text();
        await cache.put(route, res);
        for (const match of html.matchAll(/(?:src|href)="(\/_next\/[^"]+)"/g)) {
          extra.add(match[1]);
        }
      } catch {
        // A route that fails to fetch must not abort the whole install.
      }
    }),
  );

  await Promise.all(
    [...STATIC_ASSETS, ...extra].map(async (url) => {
      try {
        const res = await fetch(url, { cache: "reload" });
        if (res.ok) await cache.put(url, res);
      } catch {
        // Same here — best effort.
      }
    }),
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await precache(cache);
      // Activate immediately so a first-time visitor is offline-capable at once.
      await self.skipWaiting();
    })(),
  );
});

// ── activate ─────────────────────────────────────────────────────────────────

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = (await caches.keys()).filter((n) => n.startsWith(CACHE_PREFIX));
      // Cache names are version strings, so a plain sort is chronological.
      const stale = names.sort().slice(0, Math.max(0, names.length - 1 - KEEP_OLD_CACHES));
      await Promise.all(stale.map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

// ── fetch ────────────────────────────────────────────────────────────────────

self.addEventListener("fetch", (event) => {
  const request = event.request;

  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Never touch another origin, and never serve the worker itself from cache —
  // that is how a bad deploy becomes permanent.
  if (url.origin !== self.location.origin) return;
  if (url.pathname === "/sw.js") return;

  // SPA navigations: try the network so a redeploy lands, fall back to the
  // cached route, then to the cached shell.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(request);
          if (res && res.ok) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, res.clone());
          }
          return res;
        } catch {
          const cached =
            (await caches.match(request)) ?? (await caches.match("/"));
          return cached ?? Response.error();
        }
      })(),
    );
    return;
  }

  // Content-hashed build output never changes under a given name.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        const res = await fetch(request);
        if (res && res.ok) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(request, res.clone());
        }
        return res;
      })(),
    );
    return;
  }

  // Everything else: answer from cache at once, refresh in the background.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);

      const network = fetch(request)
        .then((res) => {
          if (res && res.ok) cache.put(request, res.clone());
          return res;
        })
        .catch(() => undefined);

      return cached ?? (await network) ?? Response.error();
    })(),
  );
});
