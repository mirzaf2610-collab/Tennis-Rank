// Service worker — sekarang juga menangani push notification.

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
