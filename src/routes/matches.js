const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { requireAuth } = require("../auth");
const { calculateElo, getKFactor, PROVISIONAL_THRESHOLD, isValidTargetGames, DEFAULT_TARGET_GAMES, MIN_TARGET_GAMES, MAX_TARGET_GAMES } = require("../elo");
const { sendPushToPlayer } = require("../pushService");

const router = express.Router();
const prisma = new PrismaClient();

// POST /api/matches - submit hasil pertandingan
// submittedBy diambil dari token (req.playerId), bukan dari body.
router.post("/matches", requireAuth, async (req, res) => {
  const { winnerId, loserId, loserGames, matchDate } = req.body;
  const targetGames = req.body.targetGames ?? DEFAULT_TARGET_GAMES;
  const submittedBy = req.playerId;

  if (winnerId == null || loserId == null || loserGames == null) {
    return res.status(400).json({
      error: { code: "MISSING_FIELDS", message: "winnerId, loserId, dan loserGames wajib diisi" },
    });
  }
  if (winnerId === loserId) {
    return res.status(400).json({
      error: { code: "SAME_PLAYER", message: "Pemenang dan yang kalah tidak boleh sama" },
    });
  }
  if (!isValidTargetGames(targetGames)) {
    return res.status(400).json({
      error: { code: "INVALID_TARGET_GAMES", message: `Format target game harus antara ${MIN_TARGET_GAMES} dan ${MAX_TARGET_GAMES}` },
    });
  }
  if (loserGames < 0 || loserGames > targetGames - 1 || !Number.isInteger(loserGames)) {
    return res.status(400).json({
      error: { code: "INVALID_SCORE", message: `Skor game yang kalah harus 0-${targetGames - 1}` },
    });
  }
  if (submittedBy !== winnerId && submittedBy !== loserId) {
    return res.status(403).json({
      error: { code: "UNAUTHORIZED_SUBMITTER", message: "Hanya pemain yang terlibat yang bisa submit skor" },
    });
  }

  const [winner, loser] = await Promise.all([
    prisma.player.findUnique({ where: { id: winnerId } }),
    prisma.player.findUnique({ where: { id: loserId } }),
  ]);
  if (!winner || !loser) {
    return res.status(404).json({ error: { code: "PLAYER_NOT_FOUND", message: "Salah satu pemain tidak ditemukan" } });
  }
  if (!winner.isActive || !loser.isActive) {
    return res.status(422).json({ error: { code: "PLAYER_INACTIVE", message: "Salah satu pemain sudah tidak aktif" } });
  }

  const isWinnerSubmitting = submittedBy === winnerId;

  const match = await prisma.match.create({
    data: {
      winnerId,
      loserId,
      loserGames,
      targetGames,
      matchDate: matchDate ? new Date(matchDate) : new Date(),
      inputBy: submittedBy,
      confirmedByWinner: isWinnerSubmitting,
      confirmedByLoser: !isWinnerSubmitting,
      status: "pending",
    },
  });

  const submitterName = isWinnerSubmitting ? winner.name : loser.name;
  const targetPlayerId = isWinnerSubmitting ? loserId : winnerId;
  sendPushToPlayer(targetPlayerId, {
    title: "Konfirmasi Hasil Match",
    body: `${submitterName} melaporkan hasil match single melawan Anda. Yuk konfirmasi!`,
    url: "/?page=confirm",
  }).catch((err) => console.error("Push notification gagal:", err.message));

  res.status(201).json({
    matchId: match.id,
    status: match.status,
    confirmedByWinner: match.confirmedByWinner,
    confirmedByLoser: match.confirmedByLoser,
    message: `Menunggu konfirmasi dari ${isWinnerSubmitting ? loser.name : winner.name}`,
  });
});

// POST /api/matches/:id/confirm
// Fungsi inti: terapkan hasil ELO ke match & kedua pemain. Dipakai baik untuk konfirmasi manual
// maupun auto-confirm setelah 7 hari (dengan halfPoints=true supaya poinnya dipotong setengah).
async function applyEloAndConfirm(tx, match, { halfPoints = false } = {}) {
  const matchId = match.id;
  const ids = [match.winnerId, match.loserId].sort((a, b) => a - b);
  await tx.$executeRawUnsafe(`SELECT id FROM players WHERE id IN (${ids.join(",")}) FOR UPDATE`);

  const winner = await tx.player.findUnique({ where: { id: match.winnerId } });
  const loser = await tx.player.findUnique({ where: { id: match.loserId } });

  let kWinner = getKFactor(winner.matchesPlayed);
  let kLoser = getKFactor(loser.matchesPlayed);
  if (halfPoints) {
    kWinner = kWinner * 0.5;
    kLoser = kLoser * 0.5;
  }

  const elo = calculateElo({
    ratingWinner: winner.currentRating,
    ratingLoser: loser.currentRating,
    loserGames: match.loserGames,
    targetGames: match.targetGames,
    kFactorWinner: kWinner,
    kFactorLoser: kLoser,
  });

  await tx.match.update({
    where: { id: matchId },
    data: {
      ratingWinnerBefore: winner.currentRating,
      ratingLoserBefore: loser.currentRating,
      ratingWinnerAfter: elo.ratingWinnerAfter,
      ratingLoserAfter: elo.ratingLoserAfter,
      kFactorWinner: kWinner,
      kFactorLoser: kLoser,
      marginMultiplier: elo.marginMultiplier,
      status: "confirmed",
      confirmedAt: new Date(),
    },
  });

  await tx.player.update({
    where: { id: winner.id },
    data: {
      currentRating: elo.ratingWinnerAfter,
      matchesPlayed: { increment: 1 },
      isProvisional: winner.matchesPlayed + 1 < PROVISIONAL_THRESHOLD,
    },
  });
  await tx.player.update({
    where: { id: loser.id },
    data: {
      currentRating: elo.ratingLoserAfter,
      matchesPlayed: { increment: 1 },
      isProvisional: loser.matchesPlayed + 1 < PROVISIONAL_THRESHOLD,
    },
  });

  await tx.ratingHistory.createMany({
    data: [
      { playerId: winner.id, matchId, ratingBefore: winner.currentRating, ratingAfter: elo.ratingWinnerAfter },
      { playerId: loser.id, matchId, ratingBefore: loser.currentRating, ratingAfter: elo.ratingLoserAfter },
    ],
  });

  return elo;
}

router.post("/matches/:id/confirm", requireAuth, async (req, res) => {
  const matchId = Number(req.params.id);
  const confirmingPlayerId = req.playerId;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const match = await tx.match.findUnique({ where: { id: matchId } });
      if (!match) {
        const err = new Error("Match tidak ditemukan");
        err.code = "MATCH_NOT_FOUND";
        err.status = 404;
        throw err;
      }
      if (match.status === "confirmed") {
        const err = new Error("Match sudah dikonfirmasi sebelumnya");
        err.code = "MATCH_ALREADY_CONFIRMED";
        err.status = 409;
        throw err;
      }
      if (match.status === "disputed") {
        const err = new Error("Match ini sudah dibatalkan (ditolak salah satu pihak). Submit ulang match baru kalau perlu dicatat lagi.");
        err.code = "MATCH_DISPUTED";
        err.status = 409;
        throw err;
      }
      if (confirmingPlayerId !== match.winnerId && confirmingPlayerId !== match.loserId) {
        const err = new Error("Anda bukan bagian dari match ini");
        err.code = "NOT_PARTICIPANT";
        err.status = 403;
        throw err;
      }

      const isWinner = confirmingPlayerId === match.winnerId;
      if (isWinner && match.confirmedByWinner) {
        const err = new Error("Anda sudah mengonfirmasi match ini sebelumnya");
        err.code = "ALREADY_SELF_CONFIRMED";
        err.status = 409;
        throw err;
      }
      if (!isWinner && match.confirmedByLoser) {
        const err = new Error("Anda sudah mengonfirmasi match ini sebelumnya");
        err.code = "ALREADY_SELF_CONFIRMED";
        err.status = 409;
        throw err;
      }

      await tx.match.update({
        where: { id: matchId },
        data: isWinner ? { confirmedByWinner: true } : { confirmedByLoser: true },
      });

      const updated = await tx.match.findUnique({ where: { id: matchId } });

      // Kalau kedua pihak sudah konfirmasi, apply ELO update sekarang
      if (updated.confirmedByWinner && updated.confirmedByLoser) {
        const elo = await applyEloAndConfirm(tx, updated);
        return { status: "confirmed", elo };
      }

      return { status: "pending" };
    });

    if (result.status === "confirmed") {
      return res.json({
        matchId,
        status: "confirmed",
        ratingWinnerAfter: result.elo.ratingWinnerAfter,
        ratingLoserAfter: result.elo.ratingLoserAfter,
        ratingWinnerChange: result.elo.ratingWinnerChange,
        ratingLoserChange: result.elo.ratingLoserChange,
      });
    }
    return res.json({ matchId, status: "pending", message: "Konfirmasi Anda diterima, menunggu pihak lain" });
  } catch (err) {
    const status = err.status || 500;
    const code = err.code || "SERVER_ERROR";
    return res.status(status).json({ error: { code, message: err.message } });
  }
});

// POST /api/matches/:id/reject
router.post("/matches/:id/reject", requireAuth, async (req, res) => {
  const matchId = Number(req.params.id);
  const rejectingPlayerId = req.playerId;
  const { reason } = req.body;

  if (!reason) {
    return res.status(400).json({ error: { code: "REASON_REQUIRED", message: "Alasan penolakan wajib diisi" } });
  }

  const match = await prisma.match.findUnique({ where: { id: matchId } });
  if (!match) {
    return res.status(404).json({ error: { code: "MATCH_NOT_FOUND", message: "Match tidak ditemukan" } });
  }
  if (match.status !== "pending") {
    return res.status(409).json({ error: { code: "MATCH_NOT_PENDING", message: "Match ini sudah tidak berstatus pending" } });
  }
  if (rejectingPlayerId !== match.winnerId && rejectingPlayerId !== match.loserId) {
    return res.status(403).json({ error: { code: "NOT_PARTICIPANT", message: "Anda bukan bagian dari match ini" } });
  }

  await prisma.match.update({
    where: { id: matchId },
    data: { status: "disputed", rejectReason: reason },
  });

  res.json({ matchId, status: "disputed", message: "Match dibatalkan. Kalau perlu, submit ulang match baru dengan skor yang benar." });
});

// GET /api/matches?player_id=X&status=Y
router.get("/matches", async (req, res) => {
  const { player_id, status } = req.query;
  const where = {};
  if (status) where.status = status;
  if (player_id) {
    where.OR = [{ winnerId: Number(player_id) }, { loserId: Number(player_id) }];
  }

  const matches = await prisma.match.findMany({
    where,
    include: { winner: true, loser: true },
    orderBy: { createdAt: "desc" },
    take: 5,
  });

  const result = matches.map((m) => ({
    id: m.id,
    winner: m.winner.name,
    loser: m.loser.name,
    score: `${m.targetGames}-${m.loserGames}`,
    status: m.status,
    ratingWinnerChange: m.ratingWinnerAfter && m.ratingWinnerBefore
      ? Number(m.ratingWinnerAfter) - Number(m.ratingWinnerBefore) : null,
    ratingLoserChange: m.ratingLoserAfter && m.ratingLoserBefore
      ? Number(m.ratingLoserAfter) - Number(m.ratingLoserBefore) : null,
    matchDate: m.matchDate,
  }));

  res.json({ matches: result });
});

module.exports = router;
module.exports.applyEloAndConfirm = applyEloAndConfirm;
