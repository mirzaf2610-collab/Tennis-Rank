const webpush = require("web-push");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

function configureWebPush() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) {
    throw new Error("VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY belum diatur di environment variables");
  }
  webpush.setVapidDetails("mailto:PSPClub2026@gmail.com", publicKey, privateKey);
}

let configured = false;
function ensureConfigured() {
  if (!configured) {
    configureWebPush();
    configured = true;
  }
}

// Kirim notifikasi ke SEMUA device yang subscribe milik 1 pemain.
// Kalau ada subscription yang sudah kadaluarsa/tidak valid (device uninstall app dll),
// otomatis dihapus dari database supaya tidak dicoba lagi ke depannya.
async function sendPushToPlayer(playerId, { title, body, url }) {
  ensureConfigured();
  const subscriptions = await prisma.pushSubscription.findMany({ where: { playerId } });
  if (subscriptions.length === 0) return;

  const payload = JSON.stringify({ title, body, url: url || "/" });

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload
        );
      } catch (err) {
        // 404/410 = subscription sudah tidak valid lagi, bersihkan dari database
        if (err.statusCode === 404 || err.statusCode === 410) {
          await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
        } else {
          console.error(`Gagal kirim push ke player ${playerId}:`, err.message);
        }
      }
    })
  );
}

module.exports = { sendPushToPlayer, configureWebPush };
