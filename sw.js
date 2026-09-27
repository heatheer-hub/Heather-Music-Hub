/*
 * Offline support for the installed app. The app shell is cached on install; later requests are
 * answered from the cache immediately and refreshed in the background, so an update shows up on
 * the next launch. Bump VERSION when shipping changes to force a clean cache.
 */
const VERSION = 'heather-music-hub-v6';
const SHELL = [
  './',
  'index.html',
  'css/style.css',
  'js/util.js',
  'js/progress.js',
  'js/cloud.js',
  'js/analyzer.js',
  'js/chart.js',
  'js/audio.js',
  'js/game.js',
  'js/app.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const isFont = /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  // Songs are stored by the app itself (IndexedDB); never copy audio files into this cache.
  if ((!sameOrigin && !isFont) || /\/Songs\//.test(url.pathname) || /\.(mp3|m4a|aac|wav|ogg|flac)$/i.test(url.pathname)) return;

  e.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const key = req.mode === 'navigate' ? 'index.html' : req;
      const cached = await cache.match(key, { ignoreSearch: req.mode === 'navigate' });
      const refresh = fetch(req).then((res) => {
        if (res && (res.ok || res.type === 'opaque')) cache.put(key, res.clone());
        return res;
      }).catch(() => null);
      if (cached) {
        e.waitUntil(refresh);
        return cached;
      }
      const res = await refresh;
      return res || new Response('Offline', { status: 503, statusText: 'Offline' });
    })
  );
});
