/* DSR+ app shell: keeps the interface available when the network is unavailable. */
var CACHE_NAME = 'dsr-web-v19-local-refresh';
var APP_SHELL = [
  './',
  './index.html',
  './dsr-local.js',
  './dsr-hybrid.js',
  './dsr-manual.js',
  './dsr-drive.js',
  './manifest.webmanifest',
  './assets/tailwind.css',
  './assets/lucide.min.js',
  './assets/xlsx.full.min.js',
  './assets/DSR_Offline.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE_NAME).then(function (cache) {
    return cache.addAll(APP_SHELL);
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (names) {
    return Promise.all(names.filter(function (name) { return name !== CACHE_NAME; }).map(function (name) {
      return caches.delete(name);
    }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  var requestUrl = new URL(request.url);
  if (request.method !== 'GET' || requestUrl.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then(function (response) {
      var copy = response.clone();
      caches.open(CACHE_NAME).then(function (cache) { cache.put('./index.html', copy); });
      return response;
    }).catch(function () { return caches.match('./index.html'); }));
    return;
  }

  // Prefer the installed files so an app update is visible immediately. The
  // cached copy is used only when the network/local server request fails.
  event.respondWith(fetch(request).then(function (response) {
    if (response && response.ok) {
      var copy = response.clone();
      caches.open(CACHE_NAME).then(function (cache) { cache.put(request, copy); });
    }
    return response;
  }).catch(function () { return caches.match(request); }));
});
