const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { requireAuth } = require("../auth");

const router = express.Router();
const prisma = new PrismaClient();

// Middleware: hanya admin yang boleh lewat
async function requireAdmin(req, res, next) {
  const player = await prisma.player.findUnique({ where: { id: req.playerId } });
  if (!player || !player.isAdmin) {
    return res.status(403).json({ error: { code: "NOT_ADMIN", message: "Hanya admin yang bisa akses ini" } });
  }
  next();
}

// GET /api/admin/pending-players - daftar akun yang sudah verifikasi email tapi belum di-approve
router.get("/admin/pending-players", requireAuth, requireAdmin, async (req, res) => {
  const players = await prisma.player.findMany({
    where: { emailVerified: true, isApproved: false },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, email: true, unitKerja: true, createdAt: true },
  });
  res.json({ players });
});

// POST /api/admin/approve/:id
router.post("/admin/approve/:id", requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const player = await prisma.player.findUnique({ where: { id } });
  if (!player) {
    return res.status(404).json({ error: { code: "PLAYER_NOT_FOUND", message: "Pemain tidak ditemukan" } });
  }
  await prisma.player.update({ where: { id }, data: { isApproved: true } });
  res.json({ message: `${player.name} berhasil disetujui` });
});

// POST /api/admin/reject/:id - tolak & hapus akun (misal bukan bagian komunitas)
router.post("/admin/reject/:id", requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const player = await prisma.player.findUnique({ where: { id } });
  if (!player) {
    return res.status(404).json({ error: { code: "PLAYER_NOT_FOUND", message: "Pemain tidak ditemukan" } });
  }
  try {
    await prisma.$transaction([
      // Bersihkan dulu data terkait (token verifikasi/reset) supaya tidak kena foreign key constraint
      prisma.emailVerificationToken.deleteMany({ where: { playerId: id } }),
      prisma.passwordResetToken.deleteMany({ where: { playerId: id } }),
      prisma.player.delete({ where: { id } }),
    ]);
    res.json({ message: `Pendaftaran ${player.name} ditolak dan dihapus` });
  } catch (e) {
    res.status(500).json({ error: { code: "DELETE_FAILED", message: `Gagal menghapus akun: ${e.message}` } });
  }
});

// GET /api/admin/banned-players - daftar akun yang sedang diblokir
router.get("/admin/banned-players", requireAuth, requireAdmin, async (req, res) => {
  const players = await prisma.player.findMany({
    where: { isBanned: true },
    orderBy: { noResponseCount: "desc" },
    select: { id: true, name: true, email: true, noResponseCount: true },
  });
  res.json({ players });
});

// POST /api/admin/unban/:id
router.post("/admin/unban/:id", requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const player = await prisma.player.findUnique({ where: { id } });
  if (!player) {
    return res.status(404).json({ error: { code: "PLAYER_NOT_FOUND", message: "Pemain tidak ditemukan" } });
  }
  // Buka blokir DAN reset hitungan tidak-konfirmasi, supaya dia mulai bersih lagi
  await prisma.player.update({ where: { id }, data: { isBanned: false, noResponseCount: 0 } });
  res.json({ message: `Blokir ${player.name} sudah dibuka, hitungan tidak konfirmasi direset ke 0` });
});

module.exports = router;
