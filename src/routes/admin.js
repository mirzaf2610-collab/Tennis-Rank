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

// GET /api/admin/matches?type=singles|doubles&limit=20 - daftar match terbaru buat dikelola
router.get("/admin/matches", requireAuth, requireAdmin, async (req, res) => {
  const type = req.query.type === "doubles" ? "doubles" : "singles";
  const limit = Math.min(Number(req.query.limit) || 20, 50);

  if (type === "singles") {
    const matches = await prisma.match.findMany({
      include: { winner: true, loser: true },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return res.json({
      matches: matches.map((m) => ({
        id: m.id,
        label: `${m.winner.name} menang vs ${m.loser.name} (${m.targetGames}-${m.loserGames})`,
        status: m.status,
        date: m.matchDate,
      })),
    });
  }

  const matches = await prisma.doublesMatch.findMany({
    include: { team1Player1: true, team1Player2: true, team2Player1: true, team2Player2: true },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  res.json({
    matches: matches.map((m) => {
      const team1 = `${m.team1Player1.name}/${m.team1Player2.name}`;
      const team2 = `${m.team2Player1.name}/${m.team2Player2.name}`;
      const winner = m.winningTeam === 1 ? team1 : team2;
      const loser = m.winningTeam === 1 ? team2 : team1;
      return {
        id: m.id,
        label: `${winner} menang vs ${loser} (6-${m.loserGames})`,
        status: m.status,
        date: m.matchDate,
      };
    }),
  });
});

// DELETE /api/admin/matches/:id?type=singles|doubles
// Kalau match sudah confirmed, rating yang sudah terlanjur berubah DIKEMBALIKAN dulu
// (dikurangi sesuai delta yang tersimpan), baru match-nya dihapus permanen.
router.delete("/admin/matches/:id", requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const type = req.query.type === "doubles" ? "doubles" : "singles";

  try {
    await prisma.$transaction(async (tx) => {
      if (type === "singles") {
        const match = await tx.match.findUnique({ where: { id } });
        if (!match) throw Object.assign(new Error("Match tidak ditemukan"), { status: 404 });

        if (match.status === "confirmed" && match.ratingWinnerAfter != null) {
          const winnerDelta = Number(match.ratingWinnerAfter) - Number(match.ratingWinnerBefore);
          const loserDelta = Number(match.ratingLoserAfter) - Number(match.ratingLoserBefore);
          await tx.player.update({
            where: { id: match.winnerId },
            data: { currentRating: { decrement: winnerDelta }, matchesPlayed: { decrement: 1 } },
          });
          await tx.player.update({
            where: { id: match.loserId },
            data: { currentRating: { decrement: loserDelta }, matchesPlayed: { decrement: 1 } },
          });
          await tx.ratingHistory.deleteMany({ where: { matchId: id } });
        }
        await tx.match.delete({ where: { id } });
      } else {
        const match = await tx.doublesMatch.findUnique({ where: { id } });
        if (!match) throw Object.assign(new Error("Match tidak ditemukan"), { status: 404 });

        if (match.status === "confirmed" && match.t1p1RatingAfter != null) {
          const deltas = [
            { playerId: match.team1Player1Id, before: match.t1p1RatingBefore, after: match.t1p1RatingAfter },
            { playerId: match.team1Player2Id, before: match.t1p2RatingBefore, after: match.t1p2RatingAfter },
            { playerId: match.team2Player1Id, before: match.t2p1RatingBefore, after: match.t2p1RatingAfter },
            { playerId: match.team2Player2Id, before: match.t2p2RatingBefore, after: match.t2p2RatingAfter },
          ];
          for (const d of deltas) {
            const delta = Number(d.after) - Number(d.before);
            await tx.player.update({
              where: { id: d.playerId },
              data: { doublesRating: { decrement: delta }, doublesMatchesPlayed: { decrement: 1 } },
            });
          }
          await tx.doublesRatingHistory.deleteMany({ where: { matchId: id } });
        }
        await tx.doublesMatch.delete({ where: { id } });
      }
    });
    res.json({ message: "Match berhasil dihapus, rating yang terlanjur berubah sudah dikembalikan." });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: { code: "DELETE_MATCH_FAILED", message: e.message } });
  }
});

module.exports = router;
