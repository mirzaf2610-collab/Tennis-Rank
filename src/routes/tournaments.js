const express = require("express");
const { requireAuth } = require("../auth");
const { calculateElo, calculateDoublesElo, getKFactor, PROVISIONAL_THRESHOLD, DEFAULT_TARGET_GAMES } = require("../elo");

const router = express.Router();
const prisma = require("../db");

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

// Urutan seeding standar turnamen (sama seperti dipakai turnamen tenis sungguhan) --
// memastikan "bye" (menang otomatis) tersebar rata, TIDAK PERNAH ada 1 match yang
// kedua slotnya sama-sama kosong. Return array nomor seed (1-indexed) sesuai urutan slot bracket.
function standardSeedOrder(size) {
  let seeds = [1];
  while (seeds.length < size) {
    const n = seeds.length;
    const next = [];
    seeds.forEach((s) => {
      next.push(s);
      next.push(2 * n + 1 - s);
    });
    seeds = next;
  }
  return seeds;
}

function participantLabel(p) {
  if (!p) return null;
  return p.player2 ? `${p.player1.name}/${p.player2.name}` : p.player1.name;
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Hitung jumlah ronde IDEAL buat Sistem Cappuccino, supaya SEMUA pemain dijamin
// main jumlah yang PERSIS SAMA (tidak peduli genap/ganjil/berapapun jumlah peserta).
// Rumus: kelipatan dari n / FPB(n, jumlah_istirahat_per_ronde)
function gcd(a, b) { return b === 0 ? a : gcd(b, a % b); }
function computeIdealRounds(n, numCourts) {
  let active = Math.min(n, numCourts * 4);
  active = active - (active % 4);
  const sitOutPerRound = n - active;
  if (sitOutPerRound === 0) return Math.max(4, Math.ceil(n / 2)); // semua selalu main, pilih jumlah ronde wajar
  const g = gcd(n, sitOutPerRound);
  const minRoundsForFairness = n / g;
  // Jangan kependekan (variasi partner kurang) atau kepanjangan (kelamaan main) -- ambil kelipatan wajar
  let rounds = minRoundsForFairness;
  while (rounds < 5) rounds += minRoundsForFairness;
  while (rounds > 12) rounds -= minRoundsForFairness;
  return rounds;
}

// Coba beberapa kali urutan acak, ambil yang PALING SEDIKIT partner berulang
function pairUpRound(playersInRound, partnerCount, key) {
  let best = null, bestRepeats = Infinity;
  for (let attempt = 0; attempt < 40; attempt++) {
    const remaining = shuffleArray(playersInRound);
    const teams = [];
    let repeats = 0;
    while (remaining.length > 0) {
      const a = remaining.shift();
      let bestIdx = 0, bestCount = Infinity;
      remaining.forEach((b, idx) => {
        const c = partnerCount[key(a, b)];
        if (c < bestCount) { bestCount = c; bestIdx = idx; }
      });
      const b = remaining.splice(bestIdx, 1)[0];
      if (partnerCount[key(a, b)] > 0) repeats++;
      teams.push([a, b]);
    }
    if (repeats < bestRepeats) { bestRepeats = repeats; best = teams; }
    if (bestRepeats === 0) break;
  }
  return best;
}

// Bangun jadwal lengkap Sistem Cappuccino: rotasi partner otomatis, istirahat merata.
// participantIds = daftar ID peserta INDIVIDU (bukan tim, karena partner ganti-ganti tiap ronde).
// Return: array of { round, matches: [{p1, p1b, p2, p2b}] }
function generateCappuccinoSchedule(participantIds, numCourts, numRounds) {
  const n = participantIds.length;
  let active = Math.min(n, numCourts * 4);
  active = active - (active % 4);
  const sitOutNeeded = n - active;

  const sitOutCount = Object.fromEntries(participantIds.map((p) => [p, 0]));
  const partnerCount = {};
  const key = (a, b) => [a, b].sort((x, y) => x - y).join("-");
  participantIds.forEach((a) => participantIds.forEach((b) => { if (a < b) partnerCount[key(a, b)] = 0; }));

  const schedule = [];
  for (let r = 1; r <= numRounds; r++) {
    const sorted = shuffleArray(participantIds).sort((a, b) => sitOutCount[a] - sitOutCount[b]);
    const sittingOut = sorted.slice(0, sitOutNeeded);
    const playing = participantIds.filter((p) => !sittingOut.includes(p));
    sittingOut.forEach((p) => sitOutCount[p]++);

    const teams = pairUpRound(playing, partnerCount, key);
    teams.forEach(([a, b]) => { partnerCount[key(a, b)]++; });

    const matches = [];
    for (let i = 0; i < teams.length; i += 2) {
      if (teams[i + 1]) {
        matches.push({ p1: teams[i][0], p1b: teams[i][1], p2: teams[i + 1][0], p2b: teams[i + 1][1] });
      }
    }
    schedule.push({ round: r, matches });
  }
  return schedule;
}

// Buat match round-robin (semua lawan semua) untuk sekelompok participantId.
// stage: "main" (format Round Robin biasa) atau "group" (fase grup di Setengah Kompetisi)
async function generateRoundRobinMatches(tx, tournamentId, participantIds, stage, groupNumber) {
  let idx = 0;
  for (let i = 0; i < participantIds.length; i++) {
    for (let j = i + 1; j < participantIds.length; j++) {
      await tx.tournamentMatch.create({
        data: {
          tournamentId, stage, groupNumber: groupNumber ?? null,
          round: 0, matchIndex: idx++,
          participant1Id: participantIds[i], participant2Id: participantIds[j],
          status: "pending",
        },
      });
    }
  }
}

// Buat bracket eliminasi dari sekelompok participantId (urut = seeding, index 0 = seed terkuat).
// stage: "main" (format Bracket biasa) atau "knockout" (fase gugur di Setengah Kompetisi)
// Pakai standardSeedOrder supaya bye tersebar rata -- peserta yang dapat bye otomatis
// "menang" babak 1 tanpa tanding, langsung maju ke babak 2, TIDAK PERNAH ada match kosong lawan kosong.
async function generateBracketMatches(tx, tournamentId, participantIds, stage) {
  const bracketSize = nextPowerOfTwo(participantIds.length);
  const seedOrder = standardSeedOrder(bracketSize);
  const slots = seedOrder.map((seedNum) => (seedNum <= participantIds.length ? participantIds[seedNum - 1] : null));

  const numRounds = Math.log2(bracketSize);
  const roundMatches = {};
  for (let r = 1; r <= numRounds; r++) {
    const matchesInRound = bracketSize / Math.pow(2, r);
    roundMatches[r] = [];
    for (let mi = 0; mi < matchesInRound; mi++) {
      const created = await tx.tournamentMatch.create({
        data: { tournamentId, stage, round: r, matchIndex: mi, status: "pending" },
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
    // Kalau p1 dan p2 dua-duanya null, itu berarti ada bug seeding -- seharusnya
    // tidak pernah terjadi dengan standardSeedOrder di atas, dibiarkan pending kosong sebagai jaga-jaga.
  }
}

// POST /api/admin/tournaments - buat turnamen baru
// format: "round_robin" | "bracket" | "group_knockout"
// Untuk Ganda, participantIds berisi ARRAY PASANGAN: [[id1,id2], [id3,id4], ...]
// Untuk Single, participantIds berisi array id biasa: [id1, id2, id3, ...]
// Urutan array = urutan seed/posisi yang diatur admin.
router.post("/admin/tournaments", requireAuth, requireAdmin, async (req, res) => {
  const { name, format, type, participantIds, numGroups, numCourts } = req.body;
  const tType = format === "cappuccino" ? "doubles" : (type === "doubles" ? "doubles" : "singles");

  if (!name || !format || !Array.isArray(participantIds) || participantIds.length < 2) {
    return res.status(400).json({ error: { code: "MISSING_FIELDS", message: "Nama, format, dan minimal 2 peserta wajib diisi" } });
  }
  if (!["round_robin", "bracket", "group_knockout", "cappuccino"].includes(format)) {
    return res.status(400).json({ error: { code: "INVALID_FORMAT", message: "Format tidak valid" } });
  }
  if (format === "group_knockout" && (!numGroups || numGroups < 2)) {
    return res.status(400).json({ error: { code: "INVALID_GROUPS", message: "Jumlah grup minimal 2" } });
  }
  if (format === "cappuccino") {
    if (participantIds.length < 4) {
      return res.status(400).json({ error: { code: "MISSING_FIELDS", message: "Sistem Cappuccino butuh minimal 4 peserta" } });
    }
    if (![1, 2].includes(numCourts)) {
      return res.status(400).json({ error: { code: "INVALID_COURTS", message: "Jumlah lapangan harus 1 atau 2" } });
    }
  }

  let normalized;
  if (format === "cappuccino") {
    // Sistem Cappuccino: peserta individu (partner ganti-ganti tiap ronde, bukan tim tetap)
    normalized = participantIds.map((p1) => ({ p1, p2: null }));
    if (new Set(participantIds).size !== participantIds.length) {
      return res.status(400).json({ error: { code: "DUPLICATE_PARTICIPANT", message: "Peserta tidak boleh dobel" } });
    }
  } else if (tType === "doubles") {
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

  try {
    const tournament = await prisma.$transaction(async (tx) => {
      const t = await tx.tournament.create({ data: { name, format, type: tType } });

      const createdParticipants = [];
      for (let i = 0; i < normalized.length; i++) {
        const groupNumber = format === "group_knockout" ? (i % numGroups) + 1 : null;
        const cp = await tx.tournamentParticipant.create({
          data: { tournamentId: t.id, player1Id: normalized[i].p1, player2Id: normalized[i].p2, seed: i + 1, groupNumber },
        });
        createdParticipants.push(cp);
      }

      if (format === "round_robin") {
        await generateRoundRobinMatches(tx, t.id, createdParticipants.map((p) => p.id), "main", null);
      } else if (format === "bracket") {
        await generateBracketMatches(tx, t.id, createdParticipants.map((p) => p.id), "main");
      } else if (format === "cappuccino") {
        const participantIdsOnly = createdParticipants.map((p) => p.id);
        const numRounds = computeIdealRounds(participantIdsOnly.length, numCourts);
        const schedule = generateCappuccinoSchedule(participantIdsOnly, numCourts, numRounds);
        for (const { round, matches } of schedule) {
          for (let mi = 0; mi < matches.length; mi++) {
            const m = matches[mi];
            await tx.tournamentMatch.create({
              data: {
                tournamentId: t.id, stage: "main", round, matchIndex: mi,
                participant1Id: m.p1, participant1bId: m.p1b,
                participant2Id: m.p2, participant2bId: m.p2b,
                status: "pending",
              },
            });
          }
        }
      } else {
        // group_knockout: buat fase grup dulu, fase knockout menyusul manual lewat tombol admin
        for (let g = 1; g <= numGroups; g++) {
          const groupParticipantIds = createdParticipants.filter((p) => p.groupNumber === g).map((p) => p.id);
          if (groupParticipantIds.length >= 2) {
            await generateRoundRobinMatches(tx, t.id, groupParticipantIds, "group", g);
          }
        }
      }

      return t;
    });

    res.status(201).json({ tournamentId: tournament.id, message: "Turnamen berhasil dibuat" });
  } catch (e) {
    console.error("Gagal buat turnamen:", e);
    res.status(500).json({ error: { code: "CREATE_TOURNAMENT_FAILED", message: e.message } });
  }
});

// POST /api/admin/tournaments/:id/start-knockout
// Ambil top-N tiap grup (default 2), buat bracket fase knockout.
router.post("/admin/tournaments/:id/start-knockout", requireAuth, requireAdmin, async (req, res) => {
  const tournamentId = Number(req.params.id);
  const advancePerGroup = req.body.advancePerGroup || 2;

  try {
    await prisma.$transaction(async (tx) => {
      const tournament = await tx.tournament.findUnique({ where: { id: tournamentId } });
      if (!tournament) throw Object.assign(new Error("Turnamen tidak ditemukan"), { status: 404 });
      if (tournament.format !== "group_knockout") {
        throw Object.assign(new Error("Turnamen ini bukan format Setengah Kompetisi"), { status: 400 });
      }

      const existingKnockout = await tx.tournamentMatch.count({ where: { tournamentId, stage: "knockout" } });
      if (existingKnockout > 0) {
        throw Object.assign(new Error("Babak knockout sudah pernah dibuat untuk turnamen ini"), { status: 409 });
      }

      const pendingGroupMatches = await tx.tournamentMatch.count({
        where: { tournamentId, stage: "group", status: "pending" },
      });
      if (pendingGroupMatches > 0) {
        throw Object.assign(new Error("Masih ada match fase grup yang belum selesai. Selesaikan dulu semuanya."), { status: 400 });
      }

      const participants = await tx.tournamentParticipant.findMany({ where: { tournamentId } });
      const groupMatches = await tx.tournamentMatch.findMany({ where: { tournamentId, stage: "group" } });

      const numGroups = Math.max(...participants.map((p) => p.groupNumber || 0));
      const qualifiersByRank = []; // qualifiersByRank[0] = semua juara grup, [1] = semua runner-up, dst

      for (let g = 1; g <= numGroups; g++) {
        const groupParticipants = participants.filter((p) => p.groupNumber === g);
        const groupMatchesForG = groupMatches.filter((m) => m.groupNumber === g);
        const ranked = await computeStandings(tx, groupParticipants, groupMatchesForG);
        ranked.slice(0, advancePerGroup).forEach((entry, rankIdx) => {
          if (!qualifiersByRank[rankIdx]) qualifiersByRank[rankIdx] = [];
          qualifiersByRank[rankIdx].push(entry.participantId);
        });
      }

      // Urutan seeding bracket: semua juara grup dulu, baru semua runner-up, dst.
      const seededIds = qualifiersByRank.flat();
      if (seededIds.length < 2) {
        throw Object.assign(new Error("Peserta yang lolos kurang dari 2, tidak bisa buat knockout"), { status: 400 });
      }

      await generateBracketMatches(tx, tournamentId, seededIds, "knockout");
    });

    res.json({ message: "Babak knockout berhasil dibuat dari hasil fase grup." });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: { code: "START_KNOCKOUT_FAILED", message: e.message } });
  }
});

// GET /api/tournaments - daftar semua turnamen (publik)
router.get("/tournaments", async (req, res) => {
  try {
    const tournaments = await prisma.tournament.findMany({ orderBy: { createdAt: "desc" } });
    res.json({ tournaments });
  } catch (e) {
    console.error("Gagal ambil daftar turnamen:", e);
    res.status(500).json({ error: { code: "LIST_TOURNAMENTS_FAILED", message: e.message } });
  }
});

// Hitung klasemen grup/round-robin, dengan aturan tie-breaker kalau menang sama banyak:
// 1) Head-to-head (siapa menang saat mereka bertanding langsung)
// 2) Kalau masih seri (3+ orang seri), pakai selisih game total
async function computeStandings(db, participants, matches) {
  const wins = {};
  const losses = {};
  const gameDiff = {};
  const h2hWinner = {}; // key: "idKecil-idBesar" -> participantId yang menang
  participants.forEach((p) => { wins[p.id] = 0; losses[p.id] = 0; gameDiff[p.id] = 0; });

  const completed = matches.filter((m) => m.status === "completed" && m.winnerParticipantId);

  // Ambil skor asli dari Match/DoublesMatch yang terhubung, buat hitung selisih game
  const singleIds = completed.filter((m) => m.singleMatchId).map((m) => m.singleMatchId);
  const doublesIds = completed.filter((m) => m.doublesMatchId).map((m) => m.doublesMatchId);
  const [singleMatches, doublesMatchesData] = await Promise.all([
    singleIds.length ? db.match.findMany({ where: { id: { in: singleIds } } }) : [],
    doublesIds.length ? db.doublesMatch.findMany({ where: { id: { in: doublesIds } } }) : [],
  ]);
  const singleById = Object.fromEntries(singleMatches.map((m) => [m.id, m]));
  const doublesById = Object.fromEntries(doublesMatchesData.map((m) => [m.id, m]));

  completed.forEach((m) => {
    wins[m.winnerParticipantId] = (wins[m.winnerParticipantId] || 0) + 1;
    const loserId = m.participant1Id === m.winnerParticipantId ? m.participant2Id : m.participant1Id;
    losses[loserId] = (losses[loserId] || 0) + 1;

    const key = [m.participant1Id, m.participant2Id].sort((a, b) => a - b).join("-");
    h2hWinner[key] = m.winnerParticipantId;

    let winnerGames = 0, loserGames = 0;
    if (m.singleMatchId && singleById[m.singleMatchId]) {
      winnerGames = singleById[m.singleMatchId].targetGames;
      loserGames = singleById[m.singleMatchId].loserGames;
    } else if (m.doublesMatchId && doublesById[m.doublesMatchId]) {
      winnerGames = 6;
      loserGames = doublesById[m.doublesMatchId].loserGames;
    }
    const diff = winnerGames - loserGames;
    gameDiff[m.winnerParticipantId] = (gameDiff[m.winnerParticipantId] || 0) + diff;
    gameDiff[loserId] = (gameDiff[loserId] || 0) - diff;
  });

  const entries = participants.map((p) => ({
    participantId: p.id, label: participantLabel(p),
    wins: wins[p.id] || 0, losses: losses[p.id] || 0, gameDiff: gameDiff[p.id] || 0,
  }));

  // Kelompokkan berdasarkan jumlah menang, lalu urutkan yang seri pakai head-to-head + selisih game
  const byWins = {};
  entries.forEach((e) => { (byWins[e.wins] = byWins[e.wins] || []).push(e); });
  const winLevels = Object.keys(byWins).map(Number).sort((a, b) => b - a);
  let sorted = [];
  winLevels.forEach((w) => {
    const tied = byWins[w];
    if (tied.length > 1) {
      tied.forEach((e) => {
        e._h2hWins = tied.filter((o) => o.participantId !== e.participantId).filter((o) => {
          const key = [e.participantId, o.participantId].sort((a, b) => a - b).join("-");
          return h2hWinner[key] === e.participantId;
        }).length;
      });
      tied.sort((a, b) => b._h2hWins - a._h2hWins || b.gameDiff - a.gameDiff);
      tied.forEach((e) => { delete e._h2hWins; });
    }
    sorted = sorted.concat(tied);
  });

  return sorted;
}

// GET /api/tournaments/:id - detail turnamen
router.get("/tournaments/:id", async (req, res) => {
  const id = Number(req.params.id);
  try {
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
        participant1b: { include: { player1: true, player2: true } },
        participant2b: { include: { player1: true, player2: true } },
        winnerParticipant: { include: { player1: true, player2: true } },
      },
      orderBy: [{ round: "asc" }, { matchIndex: "asc" }],
    });

    // Ambil skor asli dari Match/DoublesMatch yang terhubung, buat ditampilkan di tiap kotak match
    const singleIds = matches.filter((m) => m.singleMatchId).map((m) => m.singleMatchId);
    const doublesIds = matches.filter((m) => m.doublesMatchId).map((m) => m.doublesMatchId);
    const [singleScores, doublesScores] = await Promise.all([
      singleIds.length ? prisma.match.findMany({ where: { id: { in: singleIds } }, select: { id: true, targetGames: true, loserGames: true } }) : [],
      doublesIds.length ? prisma.doublesMatch.findMany({ where: { id: { in: doublesIds } }, select: { id: true, loserGames: true } }) : [],
    ]);
    const singleScoreById = Object.fromEntries(singleScores.map((s) => [s.id, s]));
    const doublesScoreById = Object.fromEntries(doublesScores.map((s) => [s.id, s]));

    const toOut = (m) => {
      let score = null;
      if (m.singleMatchId && singleScoreById[m.singleMatchId]) {
        const s = singleScoreById[m.singleMatchId];
        score = `${s.targetGames}-${s.loserGames}`;
      } else if (m.doublesMatchId && doublesScoreById[m.doublesMatchId]) {
        score = `6-${doublesScoreById[m.doublesMatchId].loserGames}`;
      }
      // Untuk Cappuccino, gabungkan label participant1+1b jadi 1 nama tim "A/B"
      const team1Label = m.participant1b
        ? `${participantLabel(m.participant1)}/${participantLabel(m.participant1b)}`
        : (m.participant1 ? participantLabel(m.participant1) : null);
      const team2Label = m.participant2b
        ? `${participantLabel(m.participant2)}/${participantLabel(m.participant2b)}`
        : (m.participant2 ? participantLabel(m.participant2) : null);
      return {
      id: m.id,
      stage: m.stage,
      groupNumber: m.groupNumber,
      round: m.round,
      matchIndex: m.matchIndex,
      participant1: m.participant1 ? { id: m.participant1.id, label: team1Label } : null,
      participant2: m.participant2 ? { id: m.participant2.id, label: team2Label } : null,
      winner: m.winnerParticipant ? { id: m.winnerParticipant.id, label: m.winnerParticipant.id === (m.participant1 && m.participant1.id) ? team1Label : team2Label } : null,
      status: m.status,
      score,
      };
    };

    let standings = null;
    let groups = null;
    let knockoutMatches = null;
    let canStartKnockout = false;
    let cappuccinoRounds = null;
    let cappuccinoRanking = null;

    if (tournament.format === "round_robin") {
      standings = await computeStandings(prisma, participants, matches);
    } else if (tournament.format === "group_knockout") {
      const numGroups = Math.max(0, ...participants.map((p) => p.groupNumber || 0));
      groups = [];
      for (let g = 1; g <= numGroups; g++) {
        const groupParticipants = participants.filter((p) => p.groupNumber === g);
        const groupMatchesRaw = matches.filter((m) => m.stage === "group" && m.groupNumber === g);
        groups.push({
          groupNumber: g,
          standings: await computeStandings(prisma, groupParticipants, groupMatchesRaw),
          matches: groupMatchesRaw.map(toOut),
        });
      }
      const knockoutRaw = matches.filter((m) => m.stage === "knockout");
      knockoutMatches = knockoutRaw.length > 0 ? knockoutRaw.map(toOut) : null;
      const pendingGroup = matches.filter((m) => m.stage === "group" && m.status === "pending").length;
      canStartKnockout = pendingGroup === 0 && knockoutRaw.length === 0;
    } else if (tournament.format === "cappuccino") {
      // Kelompokkan match per ronde buat ditampilkan
      const roundNumbers = [...new Set(matches.map((m) => m.round))].sort((a, b) => a - b);
      cappuccinoRounds = roundNumbers.map((r) => ({
        round: r,
        matches: matches.filter((m) => m.round === r).sort((a, b) => a.matchIndex - b.matchIndex).map(toOut),
      }));

      // Hitung poin individu: menang = +selisih game, kalah = +0. Berlaku utk kedua anggota tim.
      // Tie-breaker kalau poin sama: 1) total menang, 2) total game yang dimenangkan (bukan head-to-head,
      // karena partner acak tiap ronde jadi 2 orang bisa saja tidak pernah lawan-lawanan langsung).
      const points = {};
      const winsCount = {};
      const gamesWon = {};
      const labelByParticipant = {};
      participants.forEach((p) => {
        points[p.id] = 0; winsCount[p.id] = 0; gamesWon[p.id] = 0;
        labelByParticipant[p.id] = participantLabel(p);
      });

      matches.filter((m) => m.status === "completed" && m.doublesMatchId && doublesScoreById[m.doublesMatchId]).forEach((m) => {
        const loserGames = doublesScoreById[m.doublesMatchId].loserGames;
        const margin = 6 - loserGames;
        const winIsTeam1 = m.winnerParticipantId === m.participant1Id;
        const winnerIds = winIsTeam1 ? [m.participant1Id, m.participant1bId] : [m.participant2Id, m.participant2bId];
        const loserIds = winIsTeam1 ? [m.participant2Id, m.participant2bId] : [m.participant1Id, m.participant1bId];
        winnerIds.forEach((pid) => {
          if (pid == null) return;
          points[pid] = (points[pid] || 0) + margin;
          winsCount[pid] = (winsCount[pid] || 0) + 1;
          gamesWon[pid] = (gamesWon[pid] || 0) + 6;
        });
        loserIds.forEach((pid) => {
          if (pid == null) return;
          gamesWon[pid] = (gamesWon[pid] || 0) + loserGames;
        });
      });

      cappuccinoRanking = participants
        .map((p) => ({
          participantId: p.id, label: labelByParticipant[p.id],
          points: points[p.id] || 0, wins: winsCount[p.id] || 0, gamesWon: gamesWon[p.id] || 0,
        }))
        .sort((a, b) => b.points - a.points || b.wins - a.wins || b.gamesWon - a.gamesWon);
    }

    res.json({
      tournament,
      participants: participants.map((p) => ({ id: p.id, label: participantLabel(p), seed: p.seed, groupNumber: p.groupNumber })),
      matches: tournament.format === "bracket" ? matches.filter((m) => m.stage === "main").map(toOut) : matches.map(toOut),
      standings,
      groups,
      knockoutMatches,
      canStartKnockout,
      cappuccinoRounds,
      cappuccinoRanking,
    });
  } catch (e) {
    console.error("Gagal ambil detail turnamen:", e);
    res.status(500).json({ error: { code: "TOURNAMENT_DETAIL_FAILED", message: e.message } });
  }
});

// POST /api/admin/tournaments/:id/matches/:tmId/submit
// Untuk Single: winnerId = participantId pemenang.
// Untuk Ganda: winnerId = participantId (ID tim) pemenang.
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
        include: { participant1: true, participant2: true, participant1b: true, participant2b: true },
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
      } else if (tournament.format === "cappuccino") {
        if (winnerId !== tm.participant1Id && winnerId !== tm.participant2Id) {
          throw Object.assign(new Error("Pemenang harus salah satu dari kedua tim di match ini"), { status: 400 });
        }
        winnerParticipantId = winnerId;
        const winningIsSide1 = winnerId === tm.participant1Id;
        const winP1 = winningIsSide1 ? tm.participant1 : tm.participant2;
        const winP2 = winningIsSide1 ? tm.participant1b : tm.participant2b;
        const loseP1 = winningIsSide1 ? tm.participant2 : tm.participant1;
        const loseP2 = winningIsSide1 ? tm.participant2b : tm.participant1b;
        if (loserGames == null || loserGames < 0 || loserGames > 5) {
          throw Object.assign(new Error("Skor harus 0-5"), { status: 400 });
        }

        const ids = [winP1.player1Id, winP2.player1Id, loseP1.player1Id, loseP2.player1Id].sort((a, b) => a - b);
        await tx.$executeRawUnsafe(`SELECT id FROM players WHERE id IN (${ids.join(",")}) FOR UPDATE`);
        const [wp1, wp2, lp1, lp2] = await Promise.all([
          tx.player.findUnique({ where: { id: winP1.player1Id } }),
          tx.player.findUnique({ where: { id: winP2.player1Id } }),
          tx.player.findUnique({ where: { id: loseP1.player1Id } }),
          tx.player.findUnique({ where: { id: loseP2.player1Id } }),
        ]);
        const kFactorsCap = {
          t1p1: getKFactor(wp1.doublesMatchesPlayed), t1p2: getKFactor(wp2.doublesMatchesPlayed),
          t2p1: getKFactor(lp1.doublesMatchesPlayed), t2p2: getKFactor(lp2.doublesMatchesPlayed),
        };
        elo = calculateDoublesElo({
          team1Player1Rating: wp1.doublesRating, team1Player2Rating: wp2.doublesRating,
          team2Player1Rating: lp1.doublesRating, team2Player2Rating: lp2.doublesRating,
          winningTeam: 1, loserGames, kFactors: kFactorsCap,
        });

        const dmCap = await tx.doublesMatch.create({
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

        const updatesCap = [
          { p: wp1, after: elo.t1p1After }, { p: wp2, after: elo.t1p2After },
          { p: lp1, after: elo.t2p1After }, { p: lp2, after: elo.t2p2After },
        ];
        for (const { p, after } of updatesCap) {
          await tx.player.update({
            where: { id: p.id },
            data: { doublesRating: after, doublesMatchesPlayed: { increment: 1 }, doublesIsProvisional: p.doublesMatchesPlayed + 1 < PROVISIONAL_THRESHOLD },
          });
        }
        await tx.doublesRatingHistory.createMany({
          data: updatesCap.map(({ p, after }) => ({ playerId: p.id, matchId: dmCap.id, ratingBefore: p.doublesRating, ratingAfter: after })),
        });

        await tx.tournamentMatch.update({ where: { id: tmId }, data: { winnerParticipantId, doublesMatchId: dmCap.id, status: "completed" } });
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

      // Auto-advance ke babak berikutnya, cuma untuk match yang bagian dari sistem gugur
      // (format Bracket biasa, atau stage="knockout" di Setengah Kompetisi). Fase grup tidak ada auto-advance.
      const isEliminationStage = tm.stage === "knockout" || (tm.stage === "main" && tournament.format === "bracket");
      if (isEliminationStage) {
        const nextMatch = await tx.tournamentMatch.findFirst({
          where: { tournamentId, stage: tm.stage, round: tm.round + 1, matchIndex: Math.floor(tm.matchIndex / 2) },
        });
        if (nextMatch) {
          const slotField = tm.matchIndex % 2 === 0 ? "participant1Id" : "participant2Id";
          await tx.tournamentMatch.update({ where: { id: nextMatch.id }, data: { [slotField]: winnerParticipantId } });
        }
      }

      const remaining = await tx.tournamentMatch.count({
        where: { tournamentId, status: "pending", participant1Id: { not: null }, participant2Id: { not: null } },
      });
      // Untuk group_knockout, jangan tandai selesai kalau knockout belum pernah dibuat sama sekali
      // (supaya tidak "selesai" cuma karena fase grup kelar tapi belum sempat mulai knockout)
      const t2 = await tx.tournament.findUnique({ where: { id: tournamentId } });
      const knockoutExists = t2.format !== "group_knockout" || (await tx.tournamentMatch.count({ where: { tournamentId, stage: "knockout" } })) > 0;
      if (remaining === 0 && knockoutExists) {
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
