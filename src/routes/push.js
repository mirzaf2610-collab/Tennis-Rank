const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { requireAuth } = require("../auth");

const router = express.Router();
const prisma = new PrismaClient();

// GET /api/push/vapid-public-key - frontend butuh ini untuk subscribe
router.get("/push/vapid-public-key", (req, res) => {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  if (!publicKey) {
    return res.status(500).json({ error: { code: "NOT_CONFIGURED", message: "Notifikasi belum diaktifkan di server" } });
  }
  res.json({ publicKey });
});

// POST /api/push/subscribe - simpan/update langganan notifikasi device ini
router.post("/push/subscribe", requireAuth, async (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
    return res.status(400).json({ error: { code: "INVALID_SUBSCRIPTION", message: "Data langganan tidak lengkap" } });
  }

  await prisma.pushSubscription.upsert({
    where: { endpoint },
    update: { playerId: req.playerId, p256dh: keys.p256dh, auth: keys.auth },
    create: { playerId: req.playerId, endpoint, p256dh: keys.p256dh, auth: keys.auth },
  });

  res.json({ message: "Notifikasi berhasil diaktifkan" });
});

// POST /api/push/unsubscribe
router.post("/push/unsubscribe", requireAuth, async (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) {
    return res.status(400).json({ error: { code: "MISSING_FIELDS", message: "endpoint wajib diisi" } });
  }
  await prisma.pushSubscription.deleteMany({ where: { endpoint, playerId: req.playerId } });
  res.json({ message: "Notifikasi dinonaktifkan" });
});

module.exports = router;
