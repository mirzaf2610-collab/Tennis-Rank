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
  await prisma.player.delete({ where: { id } });
  res.json({ message: `Pendaftaran ${player.name} ditolak dan dihapus` });
});

module.exports = router;
