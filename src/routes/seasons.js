const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { requireAuth } = require("../auth");
const { computeSinglesStats, computeDoublesStats, buildBadges } = require("../achievements");
const { PROVISIONAL_THRESHOLD, MIN_MATCHES_LEADERBOARD } = require("../elo");

const router = express.Router();
const prisma = new PrismaClient();

async function requireAdmin(req, res, next) {
  const player = await prisma.player.findUnique({ where: { id: req.playerId } });
  if (!player || !player.isAdmin) {
    return res.status(403).json({ error: { code: "NOT_ADMIN", message: "Hanya admin yang bisa akses ini" } });
  }
  next();
}

async function getActiveSeason() {
  let season = await prisma.season.findFirst({ where: { isActive: true } });
  if (!season) {
    // Bootstrap: kalau belum pernah ada season sama sekali, buat yang pertama otomatis
    season = await prisma.season.create({ data: { name: `Season ${new Date().getFullYear()}` } });
  }
  return season;
}

// GET /api/seasons - daftar semua season (publik, buat dropdown pilihan)
router.get("/seasons", async (req, res) => {
  await getActiveSeason(); // pastikan minimal ada 1 season aktif
  const seasons = await prisma.season.findMany({ orderBy: { startedAt: "desc" } });
  res.json({ seasons });
});

// GET /api/seasons/:id/leaderboard?type=singles|doubles
// Kalau season yang dipilih masih AKTIF -> pakai data live (sama seperti /leaderboard biasa).
// Kalau season LAMA (sudah berakhir) -> ambil dari arsip season_records.
router.get("/seasons/:id/leaderboard", async (req, res) => {
  const seasonId = Number(req.params.id);
  const type = req.query.type === "doubles" ? "doubles" : "singles";
  const sortBy = req.query.sortBy || "rating";

  function sortLeaderboard(list) {
    if (sortBy === "matches") return list.sort((a, b) => b.matchesPlayed - a.matchesPlayed);
    if (sortBy === "winrate") return list.sort((a, b) => b.winRate - a.winRate || b.matchesPlayed - a.matchesPlayed);
    return list.sort((a, b) => Number(b.currentRating) - Number(a.currentRating));
  }

  const season = await prisma.season.findUnique({ where: { id: seasonId } });
  if (!season) {
    return res.status(404).json({ error: { code: "SEASON_NOT_FOUND", message: "Season tidak ditemukan" } });
  }

  if (season.isActive) {
    // Season aktif -> hitung dari data live, dibatasi sejak season ini mulai
    const players = await prisma.player.findMany({
      where: { isActive: true, isApproved: true },
      select: { id: true, name: true, photoUrl: true, currentRating: true, matchesPlayed: true, isProvisional: true,
        doublesRating: true, doublesMatchesPlayed: true, doublesIsProvisional: true, noResponseCount: true },
    });

    const results = await Promise.all(
      players.map(async (p) => {
        const stats = type === "doubles"
          ? await computeDoublesStats(prisma, p.id, season.startedAt)
          : await computeSinglesStats(prisma, p.id, season.startedAt);
        const rating = type === "doubles" ? p.doublesRating : p.currentRating;
        const matchesPlayed = type === "doubles" ? p.doublesMatchesPlayed : p.matchesPlayed;
        const isProvisional = type === "doubles" ? p.doublesIsProvisional : p.isProvisional;
        return {
          id: p.id, name: p.name, photoUrl: p.photoUrl,
          currentRating: rating, matchesPlayed, isProvisional,
          wins: stats.wins, losses: stats.losses, winRate: stats.winRate,
          noResponseCount: p.noResponseCount,
          badges: buildBadges(stats),
        };
      })
    );

    let leaderboard = results.filter((p) => p.matchesPlayed >= MIN_MATCHES_LEADERBOARD);
    leaderboard = sortLeaderboard(leaderboard).map((p, i) => ({ rank: i + 1, ...p }));

    return res.json({ season, leaderboard });
  }

  // Season sudah berakhir -> baca dari arsip
  const records = await prisma.seasonRecord.findMany({ where: { seasonId } });

  let leaderboard = records
    .filter((r) => (type === "doubles" ? r.doublesMatchesPlayed : r.singlesMatchesPlayed) >= MIN_MATCHES_LEADERBOARD)
    .map((r) => ({
      id: r.playerId,
      name: r.playerName,
      photoUrl: null,
      currentRating: type === "doubles" ? r.doublesRating : r.singlesRating,
      matchesPlayed: type === "doubles" ? r.doublesMatchesPlayed : r.singlesMatchesPlayed,
      wins: type === "doubles" ? r.doublesWins : r.singlesWins,
      losses: type === "doubles" ? r.doublesLosses : r.singlesLosses,
      winRate: (type === "doubles" ? r.doublesMatchesPlayed : r.singlesMatchesPlayed) > 0
        ? Math.round(((type === "doubles" ? r.doublesWins : r.singlesWins) / (type === "doubles" ? r.doublesMatchesPlayed : r.singlesMatchesPlayed)) * 1000) / 10
        : 0,
      isProvisional: false,
      noResponseCount: 0,
      badges: [],
    }));
  leaderboard = sortLeaderboard(leaderboard).map((p, i) => ({ rank: i + 1, ...p }));

  res.json({ season, leaderboard });
});

// POST /api/admin/end-season - arsipkan season sekarang, mulai season baru, reset semua rating
router.post("/admin/end-season", requireAuth, requireAdmin, async (req, res) => {
  const { newSeasonName } = req.body;
  const currentSeason = await getActiveSeason();

  const players = await prisma.player.findMany({ where: { isActive: true } });

  try {
    await prisma.$transaction(async (tx) => {
      // 1. Arsipkan statistik tiap pemain ke season_records
      for (const p of players) {
        const [singlesStats, doublesStats] = await Promise.all([
          computeSinglesStats(tx, p.id, currentSeason.startedAt),
          computeDoublesStats(tx, p.id, currentSeason.startedAt),
        ]);
        await tx.seasonRecord.upsert({
          where: { seasonId_playerId: { seasonId: currentSeason.id, playerId: p.id } },
          update: {},
          create: {
            seasonId: currentSeason.id,
            playerId: p.id,
            playerName: p.name,
            singlesRating: p.currentRating,
            singlesMatchesPlayed: singlesStats.matchesPlayed,
            singlesWins: singlesStats.wins,
            singlesLosses: singlesStats.losses,
            doublesRating: p.doublesRating,
            doublesMatchesPlayed: doublesStats.matchesPlayed,
            doublesWins: doublesStats.wins,
            doublesLosses: doublesStats.losses,
          },
        });
      }

      // 2. Tutup season sekarang
      await tx.season.update({ where: { id: currentSeason.id }, data: { isActive: false, endedAt: new Date() } });

      // 3. Buat season baru
      const newSeason = await tx.season.create({
        data: { name: newSeasonName || `Season ${new Date().getFullYear() + 1}` },
      });

      // 4. Reset rating semua pemain ke 1500
      await tx.player.updateMany({
        data: {
          currentRating: 1500,
          matchesPlayed: 0,
          isProvisional: true,
          doublesRating: 1500,
          doublesMatchesPlayed: 0,
          doublesIsProvisional: true,
        },
      });

      return newSeason;
    }, { timeout: 30000, maxWait: 10000 });
  } catch (e) {
    return res.status(500).json({ error: { code: "END_SEASON_FAILED", message: `Gagal mengakhiri season: ${e.message}` } });
  }

  res.json({ message: `Season "${currentSeason.name}" diarsipkan. Season baru dimulai, semua rating direset ke 1500.` });
});

module.exports = router;
