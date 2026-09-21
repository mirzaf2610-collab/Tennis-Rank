const express = require("express");
const { requireAuth } = require("../auth");
const { calculateElo, calculateDoublesElo, getKFactor, PROVISIONAL_THRESHOLD, DEFAULT_TARGET_GAMES, isValidTargetGames } = require("../elo");

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
  const name1 = p.player1 ? p.player1.name : (p.guestName || "?");
  return p.player2 ? `${name1}/${p.player2.name}` : name1;
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
// Susun tim-tim yang sudah terbentuk jadi match tim-vs-tim, DIUTAMAKAN supaya tiap orang
// belum pernah ketemu sebagai LAWAN sebelumnya. Kalau memang sudah tidak ada pilihan lain
// (semua kombinasi sudah pernah ketemu), tetap jalan -- ini best-effort, bukan syarat mutlak.
// Return { matches, cost } -- cost dipakai buildRoundMatches buat bandingkan opsi split partner.
function pairTeamsIntoMatches(teamsList, opponentCount, key) {
  const crossCost = (t1, t2) => (
    opponentCount[key(t1[0], t2[0])] + opponentCount[key(t1[0], t2[1])]
    + opponentCount[key(t1[1], t2[0])] + opponentCount[key(t1[1], t2[1])]
  );
  let best = null, bestCost = Infinity;
  for (let attempt = 0; attempt < 25; attempt++) {
    const remaining = shuffleArray(teamsList);
    const matches = [];
    let cost = 0;
    while (remaining.length > 1) {
      const t1 = remaining.shift();
      let bestIdx = 0, bIdxCost = Infinity;
      remaining.forEach((t2, idx) => {
        const c = crossCost(t1, t2);
        if (c < bIdxCost) { bIdxCost = c; bestIdx = idx; }
      });
      const t2 = remaining.splice(bestIdx, 1)[0];
      cost += bIdxCost;
      matches.push([t1, t2]);
    }
    if (cost < bestCost) { bestCost = cost; best = matches; }
    if (bestCost === 0) break;
  }
  return { matches: best, cost: bestCost };
}

// Bentuk 1 ronde penuh (partner + lawan) SEKALIGUS -- coba banyak kombinasi split partner,
// tiap kombinasi dicoba dipasangkan jadi match (pairTeamsIntoMatches) dan skornya dibandingkan.
// Prioritas: 1) jangan sampai ada partner yang berulang (mahal banget kalau kejadian),
// 2) di antara opsi yang partnernya sudah oke, pilih yang lawannya paling sedikit berulang.
function buildRoundMatches(playersInRound, partnerCount, opponentCount, key) {
  let best = null, bestScore = Infinity;
  for (let attempt = 0; attempt < 60; attempt++) {
    const remaining = shuffleArray(playersInRound);
    const teams = [];
    let partnerRepeats = 0;
    while (remaining.length > 0) {
      const a = remaining.shift();
      let bestIdx = 0, bestCount = Infinity;
      remaining.forEach((b, idx) => {
        const c = partnerCount[key(a, b)];
        if (c < bestCount) { bestCount = c; bestIdx = idx; }
      });
      const b = remaining.splice(bestIdx, 1)[0];
      if (partnerCount[key(a, b)] > 0) partnerRepeats++;
      teams.push([a, b]);
    }
    const { matches, cost } = pairTeamsIntoMatches(teams, opponentCount, key);
    const score = partnerRepeats * 1000 + cost; // hindari partner berulang jauh lebih diutamakan
    if (score < bestScore) { bestScore = score; best = { teams, matches, score }; }
    if (bestScore === 0) break;
  }
  return best;
}

// Bangun jadwal lengkap Sistem Cappuccino: rotasi partner otomatis, istirahat merata, dan
// sebisa mungkin tiap peserta ketemu LAWAN yang berbeda-beda juga (bukan cuma partner).
// participantIds = daftar ID peserta INDIVIDU (bukan tim, karena partner ganti-ganti tiap ronde).
// Return: array of { round, matches: [{p1, p1b, p2, p2b}] }
// courtsPerRound: array jumlah lapangan tiap ronde (misal [2,2,2,2,2,2,2,1]) -- boleh beda-beda
// tiap ronde, dipakai buat "Rata Sempurna" (mix jumlah lapangan supaya total main per peserta
// pas rata tanpa nambah total ronde). Panggilan lama (numCourts tetap tiap ronde) tinggal kirim
// array isi angka yang sama berulang sepanjang numRounds.
function generateCappuccinoSchedule(participantIds, courtsPerRound) {
  const n = participantIds.length;
  const sitOutCount = Object.fromEntries(participantIds.map((p) => [p, 0]));
  const partnerCount = {};
  const opponentCount = {};
  const key = (a, b) => [a, b].sort((x, y) => x - y).join("-");
  participantIds.forEach((a) => participantIds.forEach((b) => { if (a < b) { partnerCount[key(a, b)] = 0; opponentCount[key(a, b)] = 0; } }));

  const schedule = [];
  courtsPerRound.forEach((courts, idx) => {
    const r = idx + 1;
    let active = Math.min(n, courts * 4);
    active = active - (active % 4);
    const sitOutNeeded = n - active;

    const sorted = shuffleArray(participantIds).sort((a, b) => sitOutCount[a] - sitOutCount[b]);
    const sittingOut = sorted.slice(0, sitOutNeeded);
    const playing = participantIds.filter((p) => !sittingOut.includes(p));
    sittingOut.forEach((p) => sitOutCount[p]++);

    const { teams, matches: teamMatches } = buildRoundMatches(playing, partnerCount, opponentCount, key);
    teams.forEach(([a, b]) => { partnerCount[key(a, b)]++; });

    const matches = [];
    teamMatches.forEach(([t1, t2]) => {
      opponentCount[key(t1[0], t2[0])]++; opponentCount[key(t1[0], t2[1])]++;
      opponentCount[key(t1[1], t2[0])]++; opponentCount[key(t1[1], t2[1])]++;
      matches.push({ p1: t1[0], p1b: t1[1], p2: t2[0], p2b: t2[1] });
    });
    schedule.push({ round: r, matches });
  });
  return schedule;
}

// Bangun jadwal Sistem Cappuccino mode "Rata Sempurna": SEMUA peserta dijamin PERSIS `target`
// kali main (dihitung ke poin turnamen), tidak ada yang lebih atau kurang. Caranya: jalankan
// ronde penuh (pakai maxCourts) sebanyak mungkin dulu, lalu kekurangan sisanya (kalau ada)
// ditutup lewat "Golden Round" -- peserta yang masih kurang dipasangkan normal (2v2); kalau
// jumlahnya tidak pas kelipatan 4, ditambah pengisi (peserta yang SUDAH capai target, dipilih
// acak) supaya match tetap format ganda normal. Match/rating tetap normal buat semua (termasuk
// pengisi), tapi poin pengisi itu ditandai `golden*` = true supaya tidak dihitung ke ranking
// turnamen ini (lihat komentar di schema.prisma).
function generateCappuccinoScheduleFair(participantIds, maxCourts, target) {
  const n = participantIds.length;
  let active = Math.min(n, maxCourts * 4);
  active = active - (active % 4);
  const totalSlotsNeeded = n * target;
  const fullRounds = Math.floor(totalSlotsNeeded / active);

  const sitOutCount = Object.fromEntries(participantIds.map((p) => [p, 0]));
  const partnerCount = {};
  const opponentCount = {};
  const key = (a, b) => [a, b].sort((x, y) => x - y).join("-");
  participantIds.forEach((a) => participantIds.forEach((b) => { if (a < b) { partnerCount[key(a, b)] = 0; opponentCount[key(a, b)] = 0; } }));
  const playCount = Object.fromEntries(participantIds.map((p) => [p, 0]));
  const schedule = [];

  const commitMatches = (teamMatches, roundNum, goldenSet) => {
    const matches = teamMatches.map(([t1, t2]) => {
      opponentCount[key(t1[0], t2[0])]++; opponentCount[key(t1[0], t2[1])]++;
      opponentCount[key(t1[1], t2[0])]++; opponentCount[key(t1[1], t2[1])]++;
      [t1[0], t1[1], t2[0], t2[1]].forEach((p) => playCount[p]++);
      return {
        p1: t1[0], p1b: t1[1], p2: t2[0], p2b: t2[1],
        goldenP1: goldenSet ? goldenSet.has(t1[0]) : false,
        goldenP1b: goldenSet ? goldenSet.has(t1[1]) : false,
        goldenP2: goldenSet ? goldenSet.has(t2[0]) : false,
        goldenP2b: goldenSet ? goldenSet.has(t2[1]) : false,
      };
    });
    schedule.push({ round: roundNum, matches });
  };

  for (let r = 1; r <= fullRounds; r++) {
    const sitOutNeeded = n - active;
    const sorted = shuffleArray(participantIds).sort((a, b) => sitOutCount[a] - sitOutCount[b]);
    const sittingOut = sorted.slice(0, sitOutNeeded);
    const playing = participantIds.filter((p) => !sittingOut.includes(p));
    sittingOut.forEach((p) => sitOutCount[p]++);
    const { teams, matches: teamMatches } = buildRoundMatches(playing, partnerCount, opponentCount, key);
    teams.forEach(([a, b]) => { partnerCount[key(a, b)]++; });
    commitMatches(teamMatches, r, null);
  }

  let leftover = participantIds.filter((p) => playCount[p] < target);
  let roundNum = fullRounds;
  while (leftover.length > 0) {
    roundNum++;
    // Jumlah pengisi yang dibutuhkan supaya genap ke kelipatan 4 (1 match penuh)
    const neededTotal = Math.ceil(leftover.length / 4) * 4;
    const fillersNeeded = Math.max(0, neededTotal - leftover.length);
    const satisfiedPool = participantIds.filter((p) => playCount[p] >= target && !leftover.includes(p));

    // PENTING: siapa yang jadi partner/lawan siapa (termasuk G&K sesama peserta yang masih
    // kurang) TIDAK dipatok aturan tetap -- dicoba beberapa kombinasi pengisi, lalu dipilih
    // susunan yang paling sedikit mengulang partner/lawan (skor sama seperti ronde biasa).
    // Jadi bisa saja hasilnya G&K jadi partner, bisa juga jadi lawan, tergantung riwayat mereka.
    let bestPool = null, bestResult = null, bestScore = Infinity;
    const attempts = fillersNeeded > 0 ? 30 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const fillers = fillersNeeded > 0 ? shuffleArray(satisfiedPool).slice(0, fillersNeeded) : [];
      if (fillers.length < fillersNeeded) break; // kepepet kehabisan pengisi (kasus ekstrem, jarang terjadi)
      const trialPool = [...leftover, ...fillers];
      const result = buildRoundMatches(trialPool, partnerCount, opponentCount, key);
      if (result.score < bestScore) { bestScore = result.score; bestPool = trialPool; bestResult = result; }
      if (bestScore === 0) break;
    }
    const pool = bestPool || leftover;
    const { teams } = bestResult || buildRoundMatches(pool, partnerCount, opponentCount, key);
    teams.forEach(([a, b]) => { partnerCount[key(a, b)]++; });
    const goldenSet = new Set(pool.filter((p) => !leftover.includes(p)));

    // Genapkan jumlah TIM supaya bisa jadi match (2 tim/match): kalau masih ganjil (leftover
    // ganda kecil), tambah 1 tim pengisi lagi
    let teamsPool = [...teams];
    if (teamsPool.length % 2 !== 0) {
      const satisfied2 = shuffleArray(participantIds.filter((p) => playCount[p] >= target && !pool.includes(p)));
      const fillerTeam = [satisfied2[0], satisfied2[1]];
      teamsPool.push(fillerTeam);
      goldenSet.add(fillerTeam[0]); goldenSet.add(fillerTeam[1]);
    }
    const { matches: teamMatches } = pairTeamsIntoMatches(teamsPool, opponentCount, key);
    commitMatches(teamMatches, roundNum, goldenSet);
    leftover = participantIds.filter((p) => playCount[p] < target);
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
  const { name, format, type, participantIds, numGroups, numCourts, numRounds, fairTarget, cappuccinoTargetGames } = req.body;
  const tType = (format === "cappuccino" || format === "cappuccino_external") ? "doubles" : (type === "doubles" ? "doubles" : "singles");

  if (!name || !format || !Array.isArray(participantIds) || participantIds.length < 2) {
    return res.status(400).json({ error: { code: "MISSING_FIELDS", message: "Nama, format, dan minimal 2 peserta wajib diisi" } });
  }
  if (!["round_robin", "bracket", "group_knockout", "cappuccino", "cappuccino_external"].includes(format)) {
    return res.status(400).json({ error: { code: "INVALID_FORMAT", message: "Format tidak valid" } });
  }
  if (format === "group_knockout" && (!numGroups || numGroups < 2)) {
    return res.status(400).json({ error: { code: "INVALID_GROUPS", message: "Jumlah grup minimal 2" } });
  }
  if (format === "cappuccino" || format === "cappuccino_external") {
    if (participantIds.length < 4) {
      return res.status(400).json({ error: { code: "MISSING_FIELDS", message: "Sistem Cappuccino butuh minimal 4 peserta" } });
    }
    if (![1, 2].includes(numCourts)) {
      return res.status(400).json({ error: { code: "INVALID_COURTS", message: "Jumlah lapangan harus 1 atau 2" } });
    }
    if (numRounds != null && (!Number.isInteger(numRounds) || numRounds < 1 || numRounds > 30)) {
      return res.status(400).json({ error: { code: "INVALID_ROUNDS", message: "Jumlah ronde harus bilangan bulat 1-30" } });
    }
    // Format main sampai berapa game (4, 6 standar, dst) -- berlaku buat semua match di turnamen ini
    if (cappuccinoTargetGames != null && !isValidTargetGames(cappuccinoTargetGames)) {
      return res.status(400).json({ error: { code: "INVALID_TARGET_GAMES", message: "Format target game tidak valid" } });
    }
    // Mode "Rata Sempurna": fairTarget = target main tiap peserta, dijamin PERSIS lewat Golden Round.
    if (fairTarget != null && (!Number.isInteger(fairTarget) || fairTarget < 1 || fairTarget > 30)) {
      return res.status(400).json({ error: { code: "INVALID_FAIR_TARGET", message: "Target main harus bilangan bulat 1-30" } });
    }
    // Peserta tamu (nama manual, bukan pemain terdaftar) cuma boleh di Sistem Cappuccino
    // External -- Sistem Cappuccino biasa perlu semua peserta terdaftar karena hasilnya
    // pengaruh ke rating.
    const hasGuestEntry = participantIds.some((p) => typeof p === "object" && p !== null);
    if (hasGuestEntry && format !== "cappuccino_external") {
      return res.status(400).json({ error: { code: "GUEST_NOT_ALLOWED", message: "Peserta tamu (nama manual) cuma bisa dipakai di Sistem Cappuccino External" } });
    }
  }

  let normalized;
  if (format === "cappuccino" || format === "cappuccino_external") {
    // Sistem Cappuccino: peserta individu (partner ganti-ganti tiap ronde, bukan tim tetap).
    // Entry bisa berupa angka (playerId, pemain terdaftar) atau { guestName } (khusus External).
    normalized = participantIds.map((entry) => {
      if (typeof entry === "object" && entry !== null) {
        const guestName = String(entry.guestName || "").trim();
        return { p1: null, p2: null, guestName: guestName || null };
      }
      return { p1: entry, p2: null, guestName: null };
    });
    if (normalized.some((e) => e.p1 == null && !e.guestName)) {
      return res.status(400).json({ error: { code: "INVALID_PARTICIPANT", message: "Nama peserta tamu tidak boleh kosong" } });
    }
    const numericIds = normalized.filter((e) => e.p1 != null).map((e) => e.p1);
    if (new Set(numericIds).size !== numericIds.length) {
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
      const t = await tx.tournament.create({
        data: {
          name, format, type: tType,
          cappuccinoTargetGames: (format === "cappuccino" || format === "cappuccino_external") ? (cappuccinoTargetGames || DEFAULT_TARGET_GAMES) : null,
        },
      });

      const createdParticipants = [];
      for (let i = 0; i < normalized.length; i++) {
        const groupNumber = format === "group_knockout" ? (i % numGroups) + 1 : null;
        // PENTING: jangan kirim player1Id/player2Id/guestName sebagai `null` eksplisit --
        // Prisma bisa salah menginterpretasikan create() jadi butuh objek relasi `tournament`
        // penuh (bukan cukup tournamentId) kalau ada FK opsional yang di-null-kan eksplisit.
        // Aman: cuma sertakan field itu kalau memang ada isinya, biarkan default undefined kalau tidak.
        const participantData = { tournamentId: t.id, seed: i + 1, groupNumber };
        if (normalized[i].p1 != null) participantData.player1Id = normalized[i].p1;
        if (normalized[i].p2 != null) participantData.player2Id = normalized[i].p2;
        if (normalized[i].guestName) participantData.guestName = normalized[i].guestName;
        const cp = await tx.tournamentParticipant.create({ data: participantData });
        createdParticipants.push(cp);
      }

      if (format === "round_robin") {
        await generateRoundRobinMatches(tx, t.id, createdParticipants.map((p) => p.id), "main", null);
      } else if (format === "bracket") {
        await generateBracketMatches(tx, t.id, createdParticipants.map((p) => p.id), "main");
      } else if (format === "cappuccino" || format === "cappuccino_external") {
        const participantIdsOnly = createdParticipants.map((p) => p.id);
        let schedule;
        if (Number.isInteger(fairTarget) && fairTarget > 0) {
          // Mode "Rata Sempurna": semua peserta dijamin PERSIS fairTarget kali main lewat
          // mekanisme Golden Round (lihat komentar di generateCappuccinoScheduleFair).
          schedule = generateCappuccinoScheduleFair(participantIdsOnly, numCourts, fairTarget);
        } else {
          // Mode biasa: jumlah lapangan sama tiap ronde. Kalau admin sudah pilih jumlah ronde
          // sendiri, pakai itu. Kalau tidak diisi, fallback ke rumus "ideal" (jamin semua rata).
          const roundsToUse = Number.isInteger(numRounds) && numRounds > 0
            ? numRounds
            : computeIdealRounds(participantIdsOnly.length, numCourts);
          const courtsPerRound = Array(roundsToUse).fill(numCourts);
          schedule = generateCappuccinoSchedule(participantIdsOnly, courtsPerRound);
        }
        for (const { round, matches } of schedule) {
          for (let mi = 0; mi < matches.length; mi++) {
            const m = matches[mi];
            await tx.tournamentMatch.create({
              data: {
                tournamentId: t.id, stage: "main", round, matchIndex: mi,
                participant1Id: m.p1, participant1bId: m.p1b,
                participant2Id: m.p2, participant2bId: m.p2b,
                goldenP1: !!m.goldenP1, goldenP1b: !!m.goldenP1b,
                goldenP2: !!m.goldenP2, goldenP2b: !!m.goldenP2b,
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
      doublesIds.length ? prisma.doublesMatch.findMany({ where: { id: { in: doublesIds } }, select: { id: true, loserGames: true, targetGames: true } }) : [],
    ]);
    const singleScoreById = Object.fromEntries(singleScores.map((s) => [s.id, s]));
    const doublesScoreById = Object.fromEntries(doublesScores.map((s) => [s.id, s]));

    const toOut = (m) => {
      let score = null;
      if (m.singleMatchId && singleScoreById[m.singleMatchId]) {
        const s = singleScoreById[m.singleMatchId];
        score = `${s.targetGames}-${s.loserGames}`;
      } else if (m.doublesMatchId && doublesScoreById[m.doublesMatchId]) {
        const s = doublesScoreById[m.doublesMatchId];
        score = `${s.targetGames}-${s.loserGames}`;
      } else if (m.externalLoserGames != null) {
        score = `${m.externalTargetGames || 6}-${m.externalLoserGames}`;
      }
      // Untuk Cappuccino, gabungkan label participant1+1b jadi 1 nama tim "A/B"
      const team1Label = m.participant1b
        ? `${participantLabel(m.participant1)}/${participantLabel(m.participant1b)}`
        : (m.participant1 ? participantLabel(m.participant1) : null);
      const team2Label = m.participant2b
        ? `${participantLabel(m.participant2)}/${participantLabel(m.participant2b)}`
        : (m.participant2 ? participantLabel(m.participant2) : null);
      // Daftar playerId di tiap sisi match -- dipakai frontend buat cek apakah
      // pemain yang sedang login adalah salah satu peserta di match ini (khusus
      // Sistem Cappuccino, supaya peserta sendiri boleh input hasil, bukan cuma admin).
      const team1PlayerIds = [m.participant1?.player1Id, m.participant1?.player2Id, m.participant1b?.player1Id].filter(Boolean);
      const team2PlayerIds = [m.participant2?.player1Id, m.participant2?.player2Id, m.participant2b?.player1Id].filter(Boolean);
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
      team1PlayerIds,
      team2PlayerIds,
      // Golden Round (Sistem Cappuccino, mode Rata Sempurna): match ini punya peserta "pengisi"
      // (sudah capai target main-nya) yang poinnya tidak dihitung ke ranking turnamen.
      isGolden: !!(m.goldenP1 || m.goldenP1b || m.goldenP2 || m.goldenP2b),
      goldenTeam1: !!(m.goldenP1 || m.goldenP1b),
      goldenTeam2: !!(m.goldenP2 || m.goldenP2b),
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
    } else if (tournament.format === "cappuccino" || tournament.format === "cappuccino_external") {
      // Kelompokkan match per ronde buat ditampilkan
      const roundNumbers = [...new Set(matches.map((m) => m.round))].sort((a, b) => a - b);
      cappuccinoRounds = roundNumbers.map((r) => ({
        round: r,
        matches: matches.filter((m) => m.round === r).sort((a, b) => a.matchIndex - b.matchIndex).map(toOut),
      }));

      // Hitung poin individu: menang = +selisih game, kalah = +0. Berlaku utk kedua anggota tim.
      // Urutan ranking: 1) total menang (sinyal utama -- makin sering menang makin unggul),
      // 2) poin/margin kemenangan (pembeda kalau jumlah menang sama), 3) total game yang
      // dimenangkan (pembeda terakhir; bukan head-to-head karena partner acak tiap ronde jadi
      // 2 orang bisa saja tidak pernah lawan-lawanan langsung).
      // Untuk Cappuccino External, loserGames diambil langsung dari externalLoserGames (bukan
      // dari DoublesMatch, karena memang tidak ada Match/DoublesMatch yang dibuat sama sekali).
      const points = {};
      const winsCount = {};
      const gamesWon = {};
      const labelByParticipant = {};
      participants.forEach((p) => {
        points[p.id] = 0; winsCount[p.id] = 0; gamesWon[p.id] = 0;
        labelByParticipant[p.id] = participantLabel(p);
      });

      matches.filter((m) => m.status === "completed").forEach((m) => {
        const loserGames = m.doublesMatchId ? doublesScoreById[m.doublesMatchId]?.loserGames : m.externalLoserGames;
        const matchTargetGames = m.doublesMatchId ? (doublesScoreById[m.doublesMatchId]?.targetGames || 6) : (m.externalTargetGames || 6);
        if (loserGames == null) return;
        const margin = matchTargetGames - loserGames;
        const winIsTeam1 = m.winnerParticipantId === m.participant1Id;
        // Ikutkan status "golden" tiap slot -- kalau true, match ini cuma jadi PENGISI buat orang
        // itu (sudah capai target di mode Rata Sempurna), jadi tidak dihitung ke poin/menang/game
        // turnamen (walau ratingnya tetap update normal lewat DoublesMatch, tidak terpengaruh ini).
        const winnerSlots = winIsTeam1
          ? [[m.participant1Id, m.goldenP1], [m.participant1bId, m.goldenP1b]]
          : [[m.participant2Id, m.goldenP2], [m.participant2bId, m.goldenP2b]];
        const loserSlots = winIsTeam1
          ? [[m.participant2Id, m.goldenP2], [m.participant2bId, m.goldenP2b]]
          : [[m.participant1Id, m.goldenP1], [m.participant1bId, m.goldenP1b]];
        winnerSlots.forEach(([pid, golden]) => {
          if (pid == null || golden) return;
          points[pid] = (points[pid] || 0) + margin;
          winsCount[pid] = (winsCount[pid] || 0) + 1;
          gamesWon[pid] = (gamesWon[pid] || 0) + matchTargetGames;
        });
        loserSlots.forEach(([pid, golden]) => {
          if (pid == null || golden) return;
          gamesWon[pid] = (gamesWon[pid] || 0) + loserGames;
        });
      });

      cappuccinoRanking = participants
        .map((p) => ({
          participantId: p.id, label: labelByParticipant[p.id],
          points: points[p.id] || 0, wins: winsCount[p.id] || 0, gamesWon: gamesWon[p.id] || 0,
        }))
        .sort((a, b) => b.wins - a.wins || b.points - a.points || b.gamesWon - a.gamesWon);
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

// Logika inti input hasil match turnamen -- dipakai baik oleh endpoint /submit (match
// yang masih pending) maupun /correct (setelah hasil lama dibatalkan/di-reverse duluan).
// Sengaja dipisah jadi 1 fungsi supaya perhitungan ELO & auto-advance-nya PERSIS SAMA
// di kedua alur, tidak ada logika yang ke-duplikasi/berisiko beda.
async function submitTournamentMatchResult(tx, { tournamentId, tmId, winnerId, loserGames, targetGames, submittedBy }) {
  const finalTargetGames = targetGames || DEFAULT_TARGET_GAMES;

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
            inputBy: submittedBy, confirmedByWinner: true, confirmedByLoser: true,
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
      } else if (tournament.format === "cappuccino_external") {
        // Sistem Cappuccino External: skor dicatat LANGSUNG di TournamentMatch, TIDAK ada
        // Match/DoublesMatch yang dibuat, TIDAK ada perhitungan ELO/rating sama sekali --
        // baik peserta terdaftar maupun tamu, hasilnya murni buat leaderboard turnamen ini saja.
        const targetGamesCap = tournament.cappuccinoTargetGames || DEFAULT_TARGET_GAMES;
        if (winnerId !== tm.participant1Id && winnerId !== tm.participant2Id) {
          throw Object.assign(new Error("Pemenang harus salah satu dari kedua tim di match ini"), { status: 400 });
        }
        if (loserGames == null || loserGames < 0 || loserGames > targetGamesCap - 1) {
          throw Object.assign(new Error(`Skor harus 0-${targetGamesCap - 1}`), { status: 400 });
        }
        winnerParticipantId = winnerId;
        elo = null;
        await tx.tournamentMatch.update({
          where: { id: tmId },
          data: { winnerParticipantId, externalLoserGames: loserGames, externalTargetGames: targetGamesCap, status: "completed" },
        });
      } else if (tournament.format === "cappuccino") {
        const targetGamesCap = tournament.cappuccinoTargetGames || DEFAULT_TARGET_GAMES;
        if (winnerId !== tm.participant1Id && winnerId !== tm.participant2Id) {
          throw Object.assign(new Error("Pemenang harus salah satu dari kedua tim di match ini"), { status: 400 });
        }
        winnerParticipantId = winnerId;
        const winningIsSide1 = winnerId === tm.participant1Id;
        const winP1 = winningIsSide1 ? tm.participant1 : tm.participant2;
        const winP2 = winningIsSide1 ? tm.participant1b : tm.participant2b;
        const loseP1 = winningIsSide1 ? tm.participant2 : tm.participant1;
        const loseP2 = winningIsSide1 ? tm.participant2b : tm.participant1b;
        if (loserGames == null || loserGames < 0 || loserGames > targetGamesCap - 1) {
          throw Object.assign(new Error(`Skor harus 0-${targetGamesCap - 1}`), { status: 400 });
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
          winningTeam: 1, loserGames, targetGames: targetGamesCap, kFactors: kFactorsCap,
        });

        const dmCap = await tx.doublesMatch.create({
          data: {
            team1Player1Id: wp1.id, team1Player2Id: wp2.id, team2Player1Id: lp1.id, team2Player2Id: lp2.id,
            winningTeam: 1, loserGames, targetGames: targetGamesCap, inputBy: submittedBy,
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
            winningTeam: 1, loserGames, inputBy: submittedBy,
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
}

// POST /api/admin/tournaments/:id/matches/:tmId/submit
// Untuk Single: winnerId = participantId pemenang.
// Untuk Ganda: winnerId = participantId (ID tim) pemenang.
// Otorisasi: admin selalu boleh input untuk match manapun. Selain itu, salah satu
// pemain yang tampil langsung di match tsb (di format apapun -- Round Robin, Bracket,
// Setengah Kompetisi, atau Sistem Cappuccino) juga boleh input hasilnya sendiri tanpa
// perlu admin -- hasil tetap langsung terkonfirmasi (tidak perlu konfirmasi 2 pihak),
// sama seperti kalau admin yang input.
router.post("/admin/tournaments/:id/matches/:tmId/submit", requireAuth, async (req, res) => {
  const tournamentId = Number(req.params.id);
  const tmId = Number(req.params.tmId);
  const { winnerId, loserGames, targetGames } = req.body;

  try {
    const [requester, tournamentForAuth, tmForAuth] = await Promise.all([
      prisma.player.findUnique({ where: { id: req.playerId } }),
      prisma.tournament.findUnique({ where: { id: tournamentId } }),
      prisma.tournamentMatch.findUnique({
        where: { id: tmId },
        include: { participant1: true, participant2: true, participant1b: true, participant2b: true },
      }),
    ]);
    if (!tournamentForAuth) {
      return res.status(404).json({ error: { code: "NOT_FOUND", message: "Turnamen tidak ditemukan" } });
    }
    if (!tmForAuth || tmForAuth.tournamentId !== tournamentId) {
      return res.status(404).json({ error: { code: "NOT_FOUND", message: "Match turnamen tidak ditemukan" } });
    }

    const isAdmin = !!(requester && requester.isAdmin);
    const allowedPlayerIds = [
      tmForAuth.participant1 && tmForAuth.participant1.player1Id,
      tmForAuth.participant1 && tmForAuth.participant1.player2Id,
      tmForAuth.participant1b && tmForAuth.participant1b.player1Id,
      tmForAuth.participant2 && tmForAuth.participant2.player1Id,
      tmForAuth.participant2 && tmForAuth.participant2.player2Id,
      tmForAuth.participant2b && tmForAuth.participant2b.player1Id,
    ].filter(Boolean);
    const isMatchParticipant = allowedPlayerIds.includes(req.playerId);
    if (!isAdmin && !isMatchParticipant) {
      return res.status(403).json({ error: { code: "NOT_ALLOWED", message: "Hanya admin atau salah satu pemain di match ini yang bisa input hasil" } });
    }

    const result = await prisma.$transaction(async (tx) =>
      submitTournamentMatchResult(tx, { tournamentId, tmId, winnerId, loserGames, targetGames, submittedBy: req.playerId })
    );

    res.json({ message: "Hasil match turnamen tersimpan dan rating sudah diupdate.", elo: result });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: { code: "SUBMIT_FAILED", message: e.message } });
  }
});

// POST /api/admin/tournaments/:id/matches/:tmId/correct
// Khusus admin: koreksi hasil match turnamen yang SUDAH completed (misal salah pencet
// pemenang atau salah input skor). Alurnya: balikkan dulu semua dampak rating dari hasil
// lama (dengan cara yang sama seperti hapus match biasa di panel admin), kosongkan lagi
// match-nya jadi "pending", lalu input ulang hasil yang benar lewat logika submit yang
// sama persis -- jadi rating akhirnya PASTI konsisten dengan skor final yang baru.
router.post("/admin/tournaments/:id/matches/:tmId/correct", requireAuth, requireAdmin, async (req, res) => {
  const tournamentId = Number(req.params.id);
  const tmId = Number(req.params.tmId);
  const { winnerId, loserGames, targetGames } = req.body;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const tournament = await tx.tournament.findUnique({ where: { id: tournamentId } });
      if (!tournament) throw Object.assign(new Error("Turnamen tidak ditemukan"), { status: 404 });

      const tm = await tx.tournamentMatch.findUnique({ where: { id: tmId } });
      if (!tm || tm.tournamentId !== tournamentId) {
        throw Object.assign(new Error("Match turnamen tidak ditemukan"), { status: 404 });
      }
      if (tm.status !== "completed") {
        throw Object.assign(new Error("Match ini belum ada hasilnya -- gunakan Input Hasil biasa"), { status: 400 });
      }

      // Kalau match ini bagian dari sistem gugur (Bracket, atau babak Knockout di Setengah
      // Kompetisi) dan babak berikutnya SUDAH ada hasilnya, tolak koreksi -- harus koreksi/
      // hapus dulu hasil di babak berikutnya, baru boleh koreksi match ini, supaya rating
      // tidak jadi berantakan (efek berantai lintas babak).
      const isEliminationStage = tm.stage === "knockout" || (tm.stage === "main" && tournament.format === "bracket");
      let nextMatch = null;
      if (isEliminationStage) {
        nextMatch = await tx.tournamentMatch.findFirst({
          where: { tournamentId, stage: tm.stage, round: tm.round + 1, matchIndex: Math.floor(tm.matchIndex / 2) },
        });
        if (nextMatch && nextMatch.status !== "pending") {
          throw Object.assign(new Error("Match babak berikutnya sudah punya hasil. Koreksi/hapus dulu hasil di babak berikutnya, baru koreksi match ini."), { status: 409 });
        }
      }

      // Balikkan dampak rating dari hasil lama (pola sama seperti DELETE /admin/matches/:id)
      if (tm.singleMatchId) {
        const match = await tx.match.findUnique({ where: { id: tm.singleMatchId } });
        if (match && match.ratingWinnerAfter != null) {
          const winnerDelta = Number(match.ratingWinnerAfter) - Number(match.ratingWinnerBefore);
          const loserDelta = Number(match.ratingLoserAfter) - Number(match.ratingLoserBefore);
          await tx.player.update({ where: { id: match.winnerId }, data: { currentRating: { decrement: winnerDelta }, matchesPlayed: { decrement: 1 } } });
          await tx.player.update({ where: { id: match.loserId }, data: { currentRating: { decrement: loserDelta }, matchesPlayed: { decrement: 1 } } });
          await tx.ratingHistory.deleteMany({ where: { matchId: tm.singleMatchId } });
        }
        await tx.match.delete({ where: { id: tm.singleMatchId } });
      } else if (tm.doublesMatchId) {
        const dm = await tx.doublesMatch.findUnique({ where: { id: tm.doublesMatchId } });
        if (dm && dm.t1p1RatingAfter != null) {
          const deltas = [
            { playerId: dm.team1Player1Id, before: dm.t1p1RatingBefore, after: dm.t1p1RatingAfter },
            { playerId: dm.team1Player2Id, before: dm.t1p2RatingBefore, after: dm.t1p2RatingAfter },
            { playerId: dm.team2Player1Id, before: dm.t2p1RatingBefore, after: dm.t2p1RatingAfter },
            { playerId: dm.team2Player2Id, before: dm.t2p2RatingBefore, after: dm.t2p2RatingAfter },
          ];
          for (const d of deltas) {
            const delta = Number(d.after) - Number(d.before);
            await tx.player.update({ where: { id: d.playerId }, data: { doublesRating: { decrement: delta }, doublesMatchesPlayed: { decrement: 1 } } });
          }
          await tx.doublesRatingHistory.deleteMany({ where: { matchId: tm.doublesMatchId } });
        }
        await tx.doublesMatch.delete({ where: { id: tm.doublesMatchId } });
      }

      // Kosongkan match ini jadi pending lagi, lepas juga slot pemenang di babak
      // berikutnya (kalau ada) supaya bisa diisi ulang dengan pemenang yang benar
      await tx.tournamentMatch.update({
        where: { id: tmId },
        data: { winnerParticipantId: null, singleMatchId: null, doublesMatchId: null, externalLoserGames: null, status: "pending" },
      });
      if (nextMatch) {
        const slotField = tm.matchIndex % 2 === 0 ? "participant1Id" : "participant2Id";
        await tx.tournamentMatch.update({ where: { id: nextMatch.id }, data: { [slotField]: null } });
      }

      // Turnamen mungkin sempat ditandai "completed" -- buka lagi karena match ini
      // sekarang pending, biar konsisten dengan status match-nya
      await tx.tournament.update({ where: { id: tournamentId }, data: { status: "ongoing", completedAt: null } });

      // Input ulang hasil yang benar, pakai logika perhitungan ELO & auto-advance yang
      // PERSIS SAMA dengan submit biasa
      return submitTournamentMatchResult(tx, { tournamentId, tmId, winnerId, loserGames, targetGames, submittedBy: req.playerId });
    });

    res.json({ message: "Hasil match berhasil dikoreksi, rating sudah disesuaikan ulang.", elo: result });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: { code: "CORRECT_FAILED", message: e.message } });
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
