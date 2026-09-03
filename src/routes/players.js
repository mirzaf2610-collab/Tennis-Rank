const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { requireAuth } = require("../auth");
const { MIN_MATCHES_LEADERBOARD } = require("../elo");

const router = express.Router();
const prisma = new PrismaClient();

// GET /api/leaderboard - min 3 match, urut rating tertinggi
router.get("/leaderboard", async (req, res) => {
  const players = await prisma.player.findMany({
    where: { isActive: true, matchesPlayed: { gte: MIN_MATCHES_LEADERBOARD } },
    orderBy: { currentRating: "desc" },
    select: { id: true, name: true, currentRating: true, matchesPlayed: true, isProvisional: true },
  });

  const leaderboard = players.map((p, i) => ({ rank: i + 1, ...p }));
  res.json({ leaderboard });
});

// GET /api/leaderboard/pending - pemain belum eligible (<3 match)
router.get("/leaderboard/pending", async (req, res) => {
  const players = await prisma.player.findMany({
    where: { isActive: true, matchesPlayed: { lt: MIN_MATCHES_LEADERBOARD } },
    orderBy: { matchesPlayed: "desc" },
    select: { id: true, name: true, currentRating: true, matchesPlayed: true },
  });

  const result = players.map((p) => ({
    ...p,
    matchesNeeded: MIN_MATCHES_LEADERBOARD - p.matchesPlayed,
  }));
  res.json({ pending: result });
});

// GET /api/players/me - profil pemain yang sedang login
router.get("/players/me", requireAuth, async (req, res) => {
  const player = await prisma.player.findUnique({ where: { id: req.playerId } });
  if (!player) {
    return res.status(404).json({ error: { code: "PLAYER_NOT_FOUND", message: "Pemain tidak ditemukan" } });
  }
  res.json({ player });
});

// GET /api/players/:id - profil publik pemain
router.get("/players/:id", async (req, res) => {
  const id = Number(req.params.id);
  const player = await prisma.player.findUnique({
    where: { id },
    select: {
      id: true, name: true, unitKerja: true, currentRating: true,
      matchesPlayed: true, isProvisional: true, createdAt: true,
    },
  });
  if (!player) {
    return res.status(404).json({ error: { code: "PLAYER_NOT_FOUND", message: "Pemain tidak ditemukan" } });
  }
  res.json({ player });
});

// GET /api/players - list semua pemain aktif (untuk pilih lawan saat submit match)
router.get("/players", requireAuth, async (req, res) => {
  const players = await prisma.player.findMany({
    where: { isActive: true },
    select: { id: true, name: true, currentRating: true },
    orderBy: { name: "asc" },
  });
  res.json({ players });
});

// GET /api/players/:id/rating-history
router.get("/players/:id/rating-history", async (req, res) => {
  const playerId = Number(req.params.id);
  const history = await prisma.ratingHistory.findMany({
    where: { playerId },
    orderBy: { recordedAt: "asc" },
    select: { matchId: true, ratingBefore: true, ratingAfter: true, recordedAt: true },
  });
  res.json({ playerId, history });
});

// GET /api/players/me/pending-confirmations
router.get("/players/me/pending-confirmations", requireAuth, async (req, res) => {
  const matches = await prisma.match.findMany({
    where: {
      status: "pending",
      OR: [{ winnerId: req.playerId }, { loserId: req.playerId }],
    },
    include: { winner: true, loser: true },
    orderBy: { createdAt: "desc" },
  });

  const pending = matches
    .filter((m) => {
      // hanya tampilkan yang BELUM dikonfirmasi oleh user ini
      const isWinner = m.winnerId === req.playerId;
      return isWinner ? !m.confirmedByWinner : !m.confirmedByLoser;
    })
    .map((m) => {
      const isWinner = m.winnerId === req.playerId;
      const opponent = isWinner ? m.loser.name : m.winner.name;
      const score = `6-${m.loserGames}`;
      return {
        matchId: m.id,
        opponent,
        score,
        result: isWinner ? "menang" : "kalah",
        submittedAt: m.createdAt,
      };
    });

  res.json({ pending });
});

module.exports = router;
