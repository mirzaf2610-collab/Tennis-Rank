const express = require("express");
const multer = require("multer");
const { PrismaClient } = require("@prisma/client");
const { requireAuth } = require("../auth");
const { MIN_MATCHES_LEADERBOARD } = require("../elo");
const { uploadAvatar } = require("../supabaseStorage");
const { computeSinglesStats, computeDoublesStats, buildBadges } = require("../achievements");

const router = express.Router();
const prisma = new PrismaClient();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // maks 2MB
  fileFilter: (req, file, cb) => {
    if (!["image/jpeg", "image/png", "image/jpg"].includes(file.mimetype)) {
      return cb(new Error("Hanya file JPG/PNG yang diperbolehkan"));
    }
    cb(null, true);
  },
});

// GET /api/recent-matches - 10 pertandingan terbaru (single + ganda dicampur), publik tanpa login.
// Buat tampilan "live score" di halaman Ranking.
router.get("/recent-matches", async (req, res) => {
  const [singles, doubles] = await Promise.all([
    prisma.match.findMany({
      where: { status: "confirmed" },
      orderBy: { confirmedAt: "desc" },
      take: 15,
      include: { winner: true, loser: true },
    }),
    prisma.doublesMatch.findMany({
      where: { status: "confirmed" },
      orderBy: { confirmedAt: "desc" },
      take: 15,
      include: { team1Player1: true, team1Player2: true, team2Player1: true, team2Player2: true },
    }),
  ]);

  const singleItems = singles.map((m) => ({
    type: "single",
    confirmedAt: m.confirmedAt,
    winnerText: m.winner.name,
    loserText: m.loser.name,
    score: `${m.targetGames}-${m.loserGames}`,
  }));

  const doubleItems = doubles.map((m) => {
    const team1 = `${m.team1Player1.name}/${m.team1Player2.name}`;
    const team2 = `${m.team2Player1.name}/${m.team2Player2.name}`;
    const winnerText = m.winningTeam === 1 ? team1 : team2;
    const loserText = m.winningTeam === 1 ? team2 : team1;
    return {
      type: "double",
      confirmedAt: m.confirmedAt,
      winnerText,
      loserText,
      score: `6-${m.loserGames}`,
    };
  });

  const merged = [...singleItems, ...doubleItems]
    .sort((a, b) => new Date(b.confirmedAt) - new Date(a.confirmedAt))
    .slice(0, 15);

  res.json({ matches: merged });
});

// GET /api/leaderboard - min 3 match. sortBy: rating (default), matches, winrate
router.get("/leaderboard", async (req, res) => {
  const sortBy = req.query.sortBy || "rating";

  const players = await prisma.player.findMany({
    where: { isActive: true, isApproved: true, matchesPlayed: { gte: MIN_MATCHES_LEADERBOARD } },
    select: { id: true, name: true, currentRating: true, matchesPlayed: true, isProvisional: true, photoUrl: true, noResponseCount: true },
  });

  let leaderboard = await Promise.all(
    players.map(async (p) => {
      const stats = await computeSinglesStats(prisma, p.id);
      const badges = buildBadges(stats);
      return { ...p, wins: stats.wins, losses: stats.losses, winRate: stats.winRate, badges };
    })
  );

  if (sortBy === "matches") {
    leaderboard.sort((a, b) => b.matchesPlayed - a.matchesPlayed);
  } else if (sortBy === "winrate") {
    leaderboard.sort((a, b) => b.winRate - a.winRate || b.matchesPlayed - a.matchesPlayed);
  } else {
    leaderboard.sort((a, b) => Number(b.currentRating) - Number(a.currentRating));
  }

  leaderboard = leaderboard.map((p, i) => ({ rank: i + 1, ...p }));
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
      doublesRating: true, doublesMatchesPlayed: true, doublesIsProvisional: true,
      photoUrl: true,
    },
  });
  if (!player) {
    return res.status(404).json({ error: { code: "PLAYER_NOT_FOUND", message: "Pemain tidak ditemukan" } });
  }

  const [singlesStats, doublesStats] = await Promise.all([
    computeSinglesStats(prisma, id),
    computeDoublesStats(prisma, id),
  ]);

  res.json({
    player: {
      ...player,
      singlesWins: singlesStats.wins,
      singlesLosses: singlesStats.losses,
      singlesWinRate: singlesStats.winRate,
      singlesBadges: buildBadges(singlesStats),
      doublesWins: doublesStats.wins,
      doublesLosses: doublesStats.losses,
      doublesWinRate: doublesStats.winRate,
      doublesBadges: buildBadges(doublesStats),
    },
  });
});

// GET /api/players - list semua pemain aktif (untuk pilih lawan saat submit match)
router.get("/players", requireAuth, async (req, res) => {
  const players = await prisma.player.findMany({
    where: { isActive: true, isApproved: true },
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
      const score = `${m.targetGames}-${m.loserGames}`;
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

// POST /api/players/me/photo - upload foto profil
router.post("/players/me/photo", requireAuth, (req, res) => {
  upload.single("photo")(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: { code: "UPLOAD_ERROR", message: err.message } });
    }
    if (!req.file) {
      return res.status(400).json({ error: { code: "NO_FILE", message: "Tidak ada file foto yang dikirim" } });
    }
    try {
      const publicUrl = await uploadAvatar(req.playerId, req.file.buffer, req.file.mimetype);
      await prisma.player.update({ where: { id: req.playerId }, data: { photoUrl: publicUrl } });
      res.json({ photoUrl: publicUrl });
    } catch (e) {
      res.status(500).json({ error: { code: "SERVER_ERROR", message: e.message } });
    }
  });
});

module.exports = router;
