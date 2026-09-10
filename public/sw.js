// Service worker — sekarang juga menangani push notification.

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  self.clients.claim();
});

// Sengaja TIDAK pakai event.respondWith() di sini. Sempat pakai
// event.respondWith(fetch(event.request)) tapi itu bisa bikin error di Safari/iOS
// khususnya untuk request POST yang bawa data (body-nya cuma bisa "dibaca" sekali,
// reconstruct ulang lewat fetch() kadang gagal). Cukup daftarkan listener ini saja
// (tanpa isi) supaya syarat PWA "installable" tetap terpenuhi, tapi biarkan
// browser tangani semua request secara normal seperti biasa.
self.addEventListener("fetch", (event) => {
  // sengaja dibiarkan kosong
});

// Terima push notification dari server, tampilkan ke pengguna
self.addEventListener("push", (event) => {
  let data = { title: "PSP Tennis Rank", body: "Ada update baru", url: "/" };
  try {
    data = event.data.json();
  } catch (e) {
    // kalau payload bukan JSON valid, pakai default di atas
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: data.url || "/" },
    })
  );
});

// Kalau notifikasi diklik, buka/fokuskan aplikasi
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data && event.notification.data.url ? event.notification.data.url : "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
