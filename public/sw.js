// Service worker minimal — cukup untuk syarat "installable" PWA.
// Tidak melakukan caching agresif, supaya data selalu fresh dari server
// (skor pertandingan & ranking harus real-time, tidak boleh basi).

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  self.clients.claim();
});

// Pass-through saja — biarkan semua request langsung ke network seperti biasa.
self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
