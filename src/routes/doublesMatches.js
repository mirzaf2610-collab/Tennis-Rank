const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { requireAuth } = require("../auth");
const { calculateDoublesElo, getKFactor, PROVISIONAL_THRESHOLD, MIN_MATCHES_LEADERBOARD } = require("../elo");
const { computeDoublesStats, buildBadges } = require("../achievements");
const { sendPushToPlayer } = require("../pushService");

const router = express.Router();
const prisma = new PrismaClient();

// GET /api/doubles/leaderboard - sortBy: rating (default), matches, winrate
router.get("/doubles/leaderboard", async (req, res) => {
  const sortBy = req.query.sortBy || "rating";

  const players = await prisma.player.findMany({
    where: { isActive: true, doublesMatchesPlayed: { gte: MIN_MATCHES_LEADERBOARD } },
    select: { id: true, name: true, doublesRating: true, doublesMatchesPlayed: true, doublesIsProvisional: true, photoUrl: true, noResponseCount: true },
  });

  let leaderboard = await Promise.all(
    players.map(async (p) => {
      const stats = await computeDoublesStats(prisma, p.id);
      const badges = buildBadges(stats);
      return {
        id: p.id,
        photoUrl: p.photoUrl,
        name: p.name,
        currentRating: p.doublesRating,
        matchesPlayed: p.doublesMatchesPlayed,
        isProvisional: p.doublesIsProvisional,
        wins: stats.wins,
        losses: stats.losses,
        winRate: stats.winRate,
        noResponseCount: p.noResponseCount,
        badges,
      };
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

// POST /api/doubles/matches - submit hasil doubles
// Body: { team1Player2Id, team2Player1Id, team2Player2Id, winningTeam, loserGames }
// Pemain yang submit otomatis jadi salah satu dari team1 (team1Player1).
router.post("/doubles/matches", requireAuth, async (req, res) => {
  const { team1Player2Id, team2Player1Id, team2Player2Id, winningTeam, loserGames } = req.body;
  const team1Player1Id = req.playerId;

  const ids = [team1Player1Id, team1Player2Id, team2Player1Id, team2Player2Id];
  if (ids.some((id) => id == null)) {
    return res.status(400).json({ error: { code: "MISSING_FIELDS", message: "Keempat pemain wajib diisi" } });
  }
  if (new Set(ids).size !== 4) {
    return res.status(400).json({ error: { code: "DUPLICATE_PLAYER", message: "Keempat pemain harus berbeda satu sama lain" } });
  }
  if (winningTeam !== 1 && winningTeam !== 2) {
    return res.status(400).json({ error: { code: "INVALID_WINNING_TEAM", message: "winningTeam harus 1 atau 2" } });
  }
  if (loserGames == null || loserGames < 0 || loserGames > 5 || !Number.isInteger(loserGames)) {
    return res.status(400).json({ error: { code: "INVALID_SCORE", message: "Skor game yang kalah harus 0-5" } });
  }

  const players = await prisma.player.findMany({ where: { id: { in: ids } } });
  if (players.length !== 4) {
    return res.status(404).json({ error: { code: "PLAYER_NOT_FOUND", message: "Salah satu pemain tidak ditemukan" } });
  }
  if (players.some((p) => !p.isActive)) {
    return res.status(422).json({ error: { code: "PLAYER_INACTIVE", message: "Salah satu pemain sudah tidak aktif" } });
  }

  const match = await prisma.doublesMatch.create({
    data: {
      team1Player1Id,
      team1Player2Id,
      team2Player1Id,
      team2Player2Id,
      winningTeam,
      loserGames,
      inputBy: team1Player1Id,
      matchDate: new Date(),
      confirmedT1P1: true, // yang submit otomatis dianggap konfirmasi
      status: "pending",
    },
  });

  const submitterName = players.find((p) => p.id === team1Player1Id).name;
  const otherPlayerIds = [team1Player2Id, team2Player1Id, team2Player2Id];
  for (const pid of otherPlayerIds) {
    sendPushToPlayer(pid, {
      title: "Konfirmasi Hasil Match Ganda",
      body: `${submitterName} melaporkan hasil match ganda. Yuk konfirmasi!`,
      url: "/?page=confirm",
    }).catch((err) => console.error("Push notification gagal:", err.message));
  }

  res.status(201).json({
    matchId: match.id,
    status: match.status,
    message: "Menunggu konfirmasi dari salah satu pemain tim lawan",
  });
});

// Fungsi inti: terapkan hasil ELO ke match ganda & keempat pemain. Dipakai baik untuk konfirmasi
// manual maupun auto-confirm setelah 7 hari (dengan halfPoints=true supaya poinnya dipotong setengah).
async function applyDoublesEloAndConfirm(tx, match, { halfPoints = false } = {}) {
  const matchId = match.id;
  const ids = [match.team1Player1Id, match.team1Player2Id, match.team2Player1Id, match.team2Player2Id].sort((a, b) => a - b);
  await tx.$executeRawUnsafe(`SELECT id FROM players WHERE id IN (${ids.join(",")}) FOR UPDATE`);

  const [t1p1, t1p2, t2p1, t2p2] = await Promise.all([
    tx.player.findUnique({ where: { id: match.team1Player1Id } }),
    tx.player.findUnique({ where: { id: match.team1Player2Id } }),
    tx.player.findUnique({ where: { id: match.team2Player1Id } }),
    tx.player.findUnique({ where: { id: match.team2Player2Id } }),
  ]);

  const halfFactor = halfPoints ? 0.5 : 1;
  const kFactors = {
    t1p1: getKFactor(t1p1.doublesMatchesPlayed) * halfFactor,
    t1p2: getKFactor(t1p2.doublesMatchesPlayed) * halfFactor,
    t2p1: getKFactor(t2p1.doublesMatchesPlayed) * halfFactor,
    t2p2: getKFactor(t2p2.doublesMatchesPlayed) * halfFactor,
  };

  const elo = calculateDoublesElo({
    team1Player1Rating: t1p1.doublesRating,
    team1Player2Rating: t1p2.doublesRating,
    team2Player1Rating: t2p1.doublesRating,
    team2Player2Rating: t2p2.doublesRating,
    winningTeam: match.winningTeam,
    loserGames: match.loserGames,
    kFactors,
  });

  await tx.doublesMatch.update({
    where: { id: matchId },
    data: {
      team1RatingBefore: elo.team1Rating,
      team2RatingBefore: elo.team2Rating,
      marginMultiplier: elo.marginMultiplier,
      t1p1RatingBefore: t1p1.doublesRating, t1p1RatingAfter: elo.t1p1After,
      t1p2RatingBefore: t1p2.doublesRating, t1p2RatingAfter: elo.t1p2After,
      t2p1RatingBefore: t2p1.doublesRating, t2p1RatingAfter: elo.t2p1After,
      t2p2RatingBefore: t2p2.doublesRating, t2p2RatingAfter: elo.t2p2After,
      status: "confirmed",
      confirmedAt: new Date(),
    },
  });

  const players = [
    { p: t1p1, after: elo.t1p1After },
    { p: t1p2, after: elo.t1p2After },
    { p: t2p1, after: elo.t2p1After },
    { p: t2p2, after: elo.t2p2After },
  ];
  for (const { p, after } of players) {
    await tx.player.update({
      where: { id: p.id },
      data: {
        doublesRating: after,
        doublesMatchesPlayed: { increment: 1 },
        doublesIsProvisional: p.doublesMatchesPlayed + 1 < PROVISIONAL_THRESHOLD,
      },
    });
  }
  await tx.doublesRatingHistory.createMany({
    data: players.map(({ p, after }) => ({
      playerId: p.id, matchId, ratingBefore: p.doublesRating, ratingAfter: after,
    })),
  });

  return elo;
}

// POST /api/doubles/matches/:id/confirm
router.post("/doubles/matches/:id/confirm", requireAuth, async (req, res) => {
  const matchId = Number(req.params.id);
  const playerId = req.playerId;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const match = await tx.doublesMatch.findUnique({ where: { id: matchId } });
      if (!match) {
        const err = new Error("Match tidak ditemukan");
        err.code = "MATCH_NOT_FOUND"; err.status = 404; throw err;
      }
      if (match.status === "confirmed") {
        const err = new Error("Match sudah dikonfirmasi sebelumnya");
        err.code = "MATCH_ALREADY_CONFIRMED"; err.status = 409; throw err;
      }
      if (match.status === "disputed") {
        const err = new Error("Match ini sudah dibatalkan (ditolak salah satu pihak). Submit ulang match baru kalau perlu dicatat lagi.");
        err.code = "MATCH_DISPUTED"; err.status = 409; throw err;
      }

      const slot = { [match.team1Player1Id]: "confirmedT1P1", [match.team1Player2Id]: "confirmedT1P2",
        [match.team2Player1Id]: "confirmedT2P1", [match.team2Player2Id]: "confirmedT2P2" }[playerId];
      if (!slot) {
        const err = new Error("Anda bukan bagian dari match ini");
        err.code = "NOT_PARTICIPANT"; err.status = 403; throw err;
      }
      if (match[slot]) {
        const err = new Error("Anda sudah mengonfirmasi match ini sebelumnya");
        err.code = "ALREADY_SELF_CONFIRMED"; err.status = 409; throw err;
      }

      await tx.doublesMatch.update({ where: { id: matchId }, data: { [slot]: true } });
      const updated = await tx.doublesMatch.findUnique({ where: { id: matchId } });

      const team1Confirmed = updated.confirmedT1P1 || updated.confirmedT1P2;
      const team2Confirmed = updated.confirmedT2P1 || updated.confirmedT2P2;
      const allConfirmed = team1Confirmed && team2Confirmed;
      if (!allConfirmed) {
        return { status: "pending" };
      }

      // Semua sudah konfirmasi -> apply ELO
      const elo = await applyDoublesEloAndConfirm(tx, updated);
      return { status: "confirmed", elo };
    });

    if (result.status === "confirmed") {
      return res.json({ matchId, status: "confirmed", ...result.elo });
    }
    return res.json({ matchId, status: "pending", message: "Konfirmasi Anda diterima, menunggu pemain lain" });
  } catch (err) {
    const status = err.status || 500;
    const code = err.code || "SERVER_ERROR";
    return res.status(status).json({ error: { code, message: err.message } });
  }
});

// POST /api/doubles/matches/:id/reject
router.post("/doubles/matches/:id/reject", requireAuth, async (req, res) => {
  const matchId = Number(req.params.id);
  const playerId = req.playerId;
  const { reason } = req.body;

  if (!reason) {
    return res.status(400).json({ error: { code: "REASON_REQUIRED", message: "Alasan penolakan wajib diisi" } });
  }
  const match = await prisma.doublesMatch.findUnique({ where: { id: matchId } });
  if (!match) {
    return res.status(404).json({ error: { code: "MATCH_NOT_FOUND", message: "Match tidak ditemukan" } });
  }
  if (match.status !== "pending") {
    return res.status(409).json({ error: { code: "MATCH_NOT_PENDING", message: "Match ini sudah tidak pending" } });
  }
  const validIds = [match.team1Player1Id, match.team1Player2Id, match.team2Player1Id, match.team2Player2Id];
  if (!validIds.includes(playerId)) {
    return res.status(403).json({ error: { code: "NOT_PARTICIPANT", message: "Anda bukan bagian dari match ini" } });
  }

  await prisma.doublesMatch.update({ where: { id: matchId }, data: { status: "disputed", rejectReason: reason } });
  res.json({ matchId, status: "disputed", message: "Match dibatalkan. Kalau perlu, submit ulang match baru dengan skor yang benar." });
});

// GET /api/doubles/matches/pending-for-me
router.get("/doubles/matches/pending-for-me", requireAuth, async (req, res) => {
  const playerId = req.playerId;
  const matches = await prisma.doublesMatch.findMany({
    where: {
      status: "pending",
      OR: [
        { team1Player1Id: playerId }, { team1Player2Id: playerId },
        { team2Player1Id: playerId }, { team2Player2Id: playerId },
      ],
    },
    include: { team1Player1: true, team1Player2: true, team2Player1: true, team2Player2: true },
    orderBy: { createdAt: "desc" },
  });

  const pending = matches
    .filter((m) => {
      const myTeam = [m.team1Player1Id, m.team1Player2Id].includes(playerId) ? 1 : 2;
      const myTeamConfirmed = myTeam === 1
        ? (m.confirmedT1P1 || m.confirmedT1P2)
        : (m.confirmedT2P1 || m.confirmedT2P2);
      // Tampilkan sebagai pending kalau TIM Anda belum ada satu pun yang konfirmasi
      return !myTeamConfirmed;
    })
    .map((m) => {
      const myTeam = [m.team1Player1Id, m.team1Player2Id].includes(playerId) ? 1 : 2;
      const partner = myTeam === 1
        ? (m.team1Player1Id === playerId ? m.team1Player2.name : m.team1Player1.name)
        : (m.team2Player1Id === playerId ? m.team2Player2.name : m.team2Player1.name);
      const opponents = myTeam === 1 ? [m.team2Player1.name, m.team2Player2.name] : [m.team1Player1.name, m.team1Player2.name];
      return {
        matchId: m.id,
        partner,
        opponents,
        score: `6-${m.loserGames}`,
        result: m.winningTeam === myTeam ? "menang" : "kalah",
        submittedAt: m.createdAt,
      };
    });

  res.json({ pending });
});

module.exports = router;
module.exports.applyDoublesEloAndConfirm = applyDoublesEloAndConfirm;
