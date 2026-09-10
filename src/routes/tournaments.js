const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { requireAuth } = require("../auth");
const { calculateElo, calculateDoublesElo, getKFactor, PROVISIONAL_THRESHOLD, DEFAULT_TARGET_GAMES } = require("../elo");

const router = express.Router();
const prisma = new PrismaClient();

async function requireAdmin(req, res, next) {
  const player = await prisma.player.findUnique({ where: { id: req.playerId } });
  if (!player || !player.isAdmin) {
    return res.status(403).json({ error: { code: "NOT_ADMIN", message: "Hanya admin yang bisa akses ini" } });
  }
  next();
}

function nextPowerOfTwo(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

function participantLabel(p) {
  if (!p) return null;
  return p.player2 ? `${p.player1.name}/${p.player2.name}` : p.player1.name;
}

// POST /api/admin/tournaments - buat turnamen baru (Single atau Ganda)
// Untuk Ganda, participantIds berisi ARRAY PASANGAN: [[id1,id2], [id3,id4], ...]
// Untuk Single, participantIds berisi array id biasa: [id1, id2, id3, ...]
router.post("/admin/tournaments", requireAuth, requireAdmin, async (req, res) => {
  const { name, format, type, participantIds } = req.body;
  const tType = type === "doubles" ? "doubles" : "singles";

  if (!name || !format || !Array.isArray(participantIds) || participantIds.length < 2) {
    return res.status(400).json({ error: { code: "MISSING_FIELDS", message: "Nama, format, dan minimal 2 peserta wajib diisi" } });
  }
  if (format !== "round_robin" && format !== "bracket") {
    return res.status(400).json({ error: { code: "INVALID_FORMAT", message: "Format harus round_robin atau bracket" } });
  }

  let normalized;
  if (tType === "doubles") {
    if (!participantIds.every((pair) => Array.isArray(pair) && pair.length === 2)) {
      return res.status(400).json({ error: { code: "INVALID_TEAMS", message: "Untuk Ganda, tiap peserta harus berupa pasangan [id1, id2]" } });
    }
    normalized = participantIds.map(([p1, p2]) => ({ p1, p2 }));
    const allPlayerIds = normalized.flatMap((t) => [t.p1, t.p2]);
    if (new Set(allPlayerIds).size !== allPlayerIds.length) {
      return res.status(400).json({ error: { code: "DUPLICATE_PARTICIPANT", message: "Ada pemain yang dobel dipakai di lebih dari 1 tim" } });
    }
  } else {
    normalized = participantIds.map((p1) => ({ p1, p2: null }));
    if (new Set(participantIds).size !== participantIds.length) {
      return res.status(400).json({ error: { code: "DUPLICATE_PARTICIPANT", message: "Peserta tidak boleh dobel" } });
    }
  }

  const tournament = await prisma.$transaction(async (tx) => {
    const t = await tx.tournament.create({ data: { name, format, type: tType } });

    const createdParticipants = [];
    for (let i = 0; i < normalized.length; i++) {
      const cp = await tx.tournamentParticipant.create({
        data: { tournamentId: t.id, player1Id: normalized[i].p1, player2Id: normalized[i].p2, seed: i + 1 },
      });
      createdParticipants.push(cp);
    }
    const participantIdsOrdered = createdParticipants.map((p) => p.id);

    if (format === "round_robin") {
      let idx = 0;
      for (let i = 0; i < participantIdsOrdered.length; i++) {
        for (let j = i + 1; j < participantIdsOrdered.length; j++) {
          await tx.tournamentMatch.create({
            data: {
              tournamentId: t.id, round: 1, matchIndex: idx++,
              participant1Id: participantIdsOrdered[i], participant2Id: participantIdsOrdered[j],
              status: "pending",
            },
          });
        }
      }
    } else {
      const bracketSize = nextPowerOfTwo(participantIdsOrdered.length);
      const slots = [...participantIdsOrdered];
      while (slots.length < bracketSize) slots.push(null);

      const numRounds = Math.log2(bracketSize);
      const roundMatches = {};
      for (let r = 1; r <= numRounds; r++) {
        const matchesInRound = bracketSize / Math.pow(2, r);
        roundMatches[r] = [];
        for (let mi = 0; mi < matchesInRound; mi++) {
          const created = await tx.tournamentMatch.create({
            data: { tournamentId: t.id, round: r, matchIndex: mi, status: "pending" },
          });
          roundMatches[r].push(created);
        }
      }
      for (let mi = 0; mi < roundMatches[1].length; mi++) {
        const p1 = slots[mi * 2];
        const p2 = slots[mi * 2 + 1];
        const m = roundMatches[1][mi];
        if (p1 && p2) {
          await tx.tournamentMatch.update({ where: { id: m.id }, data: { participant1Id: p1, participant2Id: p2 } });
        } else if (p1 || p2) {
          const winner = p1 || p2;
          await tx.tournamentMatch.update({
            where: { id: m.id },
            data: { participant1Id: p1, participant2Id: p2, winnerParticipantId: winner, status: "bye" },
          });
          if (numRounds >= 2) {
            const nextMatch = roundMatches[2][Math.floor(mi / 2)];
            const slotField = mi % 2 === 0 ? "participant1Id" : "participant2Id";
            await tx.tournamentMatch.update({ where: { id: nextMatch.id }, data: { [slotField]: winner } });
          }
        }
      }
    }

    return t;
  });

  res.status(201).json({ tournamentId: tournament.id, message: "Turnamen berhasil dibuat" });
});

// GET /api/tournaments - daftar semua turnamen (publik)
router.get("/tournaments", async (req, res) => {
  const tournaments = await prisma.tournament.findMany({ orderBy: { createdAt: "desc" } });
  res.json({ tournaments });
});

// GET /api/tournaments/:id - detail turnamen
router.get("/tournaments/:id", async (req, res) => {
  const id = Number(req.params.id);
  const tournament = await prisma.tournament.findUnique({ where: { id } });
  if (!tournament) {
    return res.status(404).json({ error: { code: "TOURNAMENT_NOT_FOUND", message: "Turnamen tidak ditemukan" } });
  }

  const participants = await prisma.tournamentParticipant.findMany({
    where: { tournamentId: id },
    include: { player1: true, player2: true },
    orderBy: { seed: "asc" },
  });

  const matches = await prisma.tournamentMatch.findMany({
    where: { tournamentId: id },
    include: {
      participant1: { include: { player1: true, player2: true } },
      participant2: { include: { player1: true, player2: true } },
      winnerParticipant: { include: { player1: true, player2: true } },
    },
    orderBy: [{ round: "asc" }, { matchIndex: "asc" }],
  });

  const matchesOut = matches.map((m) => ({
    id: m.id,
    round: m.round,
    matchIndex: m.matchIndex,
    participant1: m.participant1 ? { id: m.participant1.id, label: participantLabel(m.participant1) } : null,
    participant2: m.participant2 ? { id: m.participant2.id, label: participantLabel(m.participant2) } : null,
    winner: m.winnerParticipant ? { id: m.winnerParticipant.id, label: participantLabel(m.winnerParticipant) } : null,
    status: m.status,
  }));

  let standings = null;
  if (tournament.format === "round_robin") {
    const wins = {};
    const losses = {};
    participants.forEach((p) => { wins[p.id] = 0; losses[p.id] = 0; });
    matches.forEach((m) => {
      if (m.status === "completed" && m.winnerParticipantId) {
        wins[m.winnerParticipantId] = (wins[m.winnerParticipantId] || 0) + 1;
        const loserId = m.participant1Id === m.winnerParticipantId ? m.participant2Id : m.participant1Id;
        losses[loserId] = (losses[loserId] || 0) + 1;
      }
    });
    standings = participants
      .map((p) => ({ participantId: p.id, label: participantLabel(p), wins: wins[p.id] || 0, losses: losses[p.id] || 0 }))
      .sort((a, b) => b.wins - a.wins);
  }

  res.json({
    tournament,
    participants: participants.map((p) => ({ id: p.id, label: participantLabel(p), seed: p.seed })),
    matches: matchesOut,
    standings,
  });
});

// POST /api/admin/tournaments/:id/matches/:tmId/submit
// Untuk Single: winnerId = playerId pemenang.
// Untuk Ganda: winnerId = participantId (ID tim) pemenang (bukan playerId individu).
router.post("/admin/tournaments/:id/matches/:tmId/submit", requireAuth, requireAdmin, async (req, res) => {
  const tournamentId = Number(req.params.id);
  const tmId = Number(req.params.tmId);
  const { winnerId, loserGames, targetGames } = req.body;
  const finalTargetGames = targetGames || DEFAULT_TARGET_GAMES;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const tournament = await tx.tournament.findUnique({ where: { id: tournamentId } });
      if (!tournament) throw Object.assign(new Error("Turnamen tidak ditemukan"), { status: 404 });

      const tm = await tx.tournamentMatch.findUnique({
        where: { id: tmId },
        include: { participant1: true, participant2: true },
      });
      if (!tm || tm.tournamentId !== tournamentId) {
        throw Object.assign(new Error("Match turnamen tidak ditemukan"), { status: 404 });
      }
      if (!tm.participant1Id || !tm.participant2Id) {
        throw Object.assign(new Error("Match ini belum siap dimainkan (menunggu pemenang babak sebelumnya)"), { status: 400 });
      }
      if (tm.status === "completed") {
        throw Object.assign(new Error("Match ini sudah ada hasilnya"), { status: 409 });
      }

      let elo;
      let winnerParticipantId;

      if (tournament.type === "singles") {
        if (winnerId !== tm.participant1Id && winnerId !== tm.participant2Id) {
          throw Object.assign(new Error("Pemenang harus salah satu dari kedua pemain di match ini"), { status: 400 });
        }
        winnerParticipantId = winnerId;
        const winnerPlayerId = winnerId === tm.participant1Id ? tm.participant1.player1Id : tm.participant2.player1Id;
        const loserPlayerId = winnerId === tm.participant1Id ? tm.participant2.player1Id : tm.participant1.player1Id;
        if (loserGames == null || loserGames < 0 || loserGames > finalTargetGames - 1) {
          throw Object.assign(new Error(`Skor harus 0-${finalTargetGames - 1}`), { status: 400 });
        }

        const ids = [winnerPlayerId, loserPlayerId].sort((a, b) => a - b);
        await tx.$executeRawUnsafe(`SELECT id FROM players WHERE id IN (${ids.join(",")}) FOR UPDATE`);
        const winner = await tx.player.findUnique({ where: { id: winnerPlayerId } });
        const loser = await tx.player.findUnique({ where: { id: loserPlayerId } });
        const kWinner = getKFactor(winner.matchesPlayed);
        const kLoser = getKFactor(loser.matchesPlayed);
        elo = calculateElo({
          ratingWinner: winner.currentRating, ratingLoser: loser.currentRating,
          loserGames, targetGames: finalTargetGames, kFactorWinner: kWinner, kFactorLoser: kLoser,
        });

        const match = await tx.match.create({
          data: {
            winnerId: winnerPlayerId, loserId: loserPlayerId, loserGames, targetGames: finalTargetGames,
            inputBy: req.playerId, confirmedByWinner: true, confirmedByLoser: true,
            status: "confirmed", confirmedAt: new Date(),
            ratingWinnerBefore: winner.currentRating, ratingLoserBefore: loser.currentRating,
            ratingWinnerAfter: elo.ratingWinnerAfter, ratingLoserAfter: elo.ratingLoserAfter,
            kFactorWinner: kWinner, kFactorLoser: kLoser, marginMultiplier: elo.marginMultiplier,
          },
        });
        await tx.player.update({
          where: { id: winner.id },
          data: { currentRating: elo.ratingWinnerAfter, matchesPlayed: { increment: 1 }, isProvisional: winner.matchesPlayed + 1 < PROVISIONAL_THRESHOLD },
        });
        await tx.player.update({
          where: { id: loser.id },
          data: { currentRating: elo.ratingLoserAfter, matchesPlayed: { increment: 1 }, isProvisional: loser.matchesPlayed + 1 < PROVISIONAL_THRESHOLD },
        });
        await tx.ratingHistory.createMany({
          data: [
            { playerId: winner.id, matchId: match.id, ratingBefore: winner.currentRating, ratingAfter: elo.ratingWinnerAfter },
            { playerId: loser.id, matchId: match.id, ratingBefore: loser.currentRating, ratingAfter: elo.ratingLoserAfter },
          ],
        });
        await tx.tournamentMatch.update({ where: { id: tmId }, data: { winnerParticipantId, singleMatchId: match.id, status: "completed" } });
      } else {
        if (winnerId !== tm.participant1Id && winnerId !== tm.participant2Id) {
          throw Object.assign(new Error("Pemenang harus salah satu dari kedua tim di match ini"), { status: 400 });
        }
        winnerParticipantId = winnerId;
        const winningIsTeam1 = winnerId === tm.participant1Id;
        const winTeam = winningIsTeam1 ? tm.participant1 : tm.participant2;
        const loseTeam = winningIsTeam1 ? tm.participant2 : tm.participant1;
        if (loserGames == null || loserGames < 0 || loserGames > 5) {
          throw Object.assign(new Error("Skor harus 0-5"), { status: 400 });
        }

        const ids = [winTeam.player1Id, winTeam.player2Id, loseTeam.player1Id, loseTeam.player2Id].sort((a, b) => a - b);
        await tx.$executeRawUnsafe(`SELECT id FROM players WHERE id IN (${ids.join(",")}) FOR UPDATE`);
        const [wp1, wp2, lp1, lp2] = await Promise.all([
          tx.player.findUnique({ where: { id: winTeam.player1Id } }),
          tx.player.findUnique({ where: { id: winTeam.player2Id } }),
          tx.player.findUnique({ where: { id: loseTeam.player1Id } }),
          tx.player.findUnique({ where: { id: loseTeam.player2Id } }),
        ]);
        const kFactors = {
          t1p1: getKFactor(wp1.doublesMatchesPlayed), t1p2: getKFactor(wp2.doublesMatchesPlayed),
          t2p1: getKFactor(lp1.doublesMatchesPlayed), t2p2: getKFactor(lp2.doublesMatchesPlayed),
        };
        elo = calculateDoublesElo({
          team1Player1Rating: wp1.doublesRating, team1Player2Rating: wp2.doublesRating,
          team2Player1Rating: lp1.doublesRating, team2Player2Rating: lp2.doublesRating,
          winningTeam: 1, loserGames, kFactors,
        });

        const dm = await tx.doublesMatch.create({
          data: {
            team1Player1Id: wp1.id, team1Player2Id: wp2.id, team2Player1Id: lp1.id, team2Player2Id: lp2.id,
            winningTeam: 1, loserGames, inputBy: req.playerId,
            confirmedT1P1: true, confirmedT1P2: true, confirmedT2P1: true, confirmedT2P2: true,
            status: "confirmed", confirmedAt: new Date(),
            team1RatingBefore: elo.team1Rating, team2RatingBefore: elo.team2Rating, marginMultiplier: elo.marginMultiplier,
            t1p1RatingBefore: wp1.doublesRating, t1p1RatingAfter: elo.t1p1After,
            t1p2RatingBefore: wp2.doublesRating, t1p2RatingAfter: elo.t1p2After,
            t2p1RatingBefore: lp1.doublesRating, t2p1RatingAfter: elo.t2p1After,
            t2p2RatingBefore: lp2.doublesRating, t2p2RatingAfter: elo.t2p2After,
          },
        });

        const updates = [
          { p: wp1, after: elo.t1p1After }, { p: wp2, after: elo.t1p2After },
          { p: lp1, after: elo.t2p1After }, { p: lp2, after: elo.t2p2After },
        ];
        for (const { p, after } of updates) {
          await tx.player.update({
            where: { id: p.id },
            data: { doublesRating: after, doublesMatchesPlayed: { increment: 1 }, doublesIsProvisional: p.doublesMatchesPlayed + 1 < PROVISIONAL_THRESHOLD },
          });
        }
        await tx.doublesRatingHistory.createMany({
          data: updates.map(({ p, after }) => ({ playerId: p.id, matchId: dm.id, ratingBefore: p.doublesRating, ratingAfter: after })),
        });

        await tx.tournamentMatch.update({ where: { id: tmId }, data: { winnerParticipantId, doublesMatchId: dm.id, status: "completed" } });
      }

      if (tournament.format === "bracket") {
        const nextMatch = await tx.tournamentMatch.findFirst({
          where: { tournamentId, round: tm.round + 1, matchIndex: Math.floor(tm.matchIndex / 2) },
        });
        if (nextMatch) {
          const slotField = tm.matchIndex % 2 === 0 ? "participant1Id" : "participant2Id";
          await tx.tournamentMatch.update({ where: { id: nextMatch.id }, data: { [slotField]: winnerParticipantId } });
        }
      }

      const remaining = await tx.tournamentMatch.count({
        where: { tournamentId, status: "pending", participant1Id: { not: null }, participant2Id: { not: null } },
      });
      if (remaining === 0) {
        await tx.tournament.update({ where: { id: tournamentId }, data: { status: "completed", completedAt: new Date() } });
      }

      return elo;
    });

    res.json({ message: "Hasil match turnamen tersimpan dan rating sudah diupdate.", elo: result });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: { code: "SUBMIT_FAILED", message: e.message } });
  }
});

// DELETE /api/admin/tournaments/:id - hapus turnamen (struktur turnamennya saja).
// TIDAK menghapus/reverse Match atau DoublesMatch yang sudah terjadi dari turnamen ini --
// hasil pertandingan & rating yang sudah berubah tetap ada di histori pemain.
router.delete("/admin/tournaments/:id", requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  try {
    await prisma.$transaction(async (tx) => {
      const tournament = await tx.tournament.findUnique({ where: { id } });
      if (!tournament) throw Object.assign(new Error("Turnamen tidak ditemukan"), { status: 404 });

      await tx.tournamentMatch.deleteMany({ where: { tournamentId: id } });
      await tx.tournamentParticipant.deleteMany({ where: { tournamentId: id } });
      await tx.tournament.delete({ where: { id } });
    });
    res.json({ message: "Turnamen berhasil dihapus. Hasil match & rating yang sudah terjadi tetap tersimpan." });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: { code: "DELETE_TOURNAMENT_FAILED", message: e.message } });
  }
});

module.exports = router;
