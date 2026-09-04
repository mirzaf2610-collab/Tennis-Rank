// Modul perhitungan gelar (title) & prestasi (achievement) pemain.
// Dipakai bareng untuk leaderboard Single, Ganda, dan halaman Profil.

const GIANT_SLAYER_GAP = 100; // selisih rating minimal buat dianggap "raksasa"

// Gelar utama berdasarkan win rate & jumlah main
function getMainTitle(winRate, matchesPlayed) {
  if (winRate === 100 && matchesPlayed >= 3) return { emoji: "🏆", label: "Tak Terkalahkan" };
  if (winRate >= 70 && matchesPlayed >= 25) return { emoji: "👑", label: "Legenda" };
  if (winRate >= 70) return { emoji: "🌟", label: "Superstar" };
  if (winRate >= 60 && matchesPlayed >= 15) return { emoji: "🔥", label: "Konsisten" };
  if (matchesPlayed >= 20 && winRate < 40) return { emoji: "💪", label: "Pejuang Lapangan" };
  return null;
}

// Badge dari streak menang/kalah beruntun. streak positif = menang beruntun, negatif = kalah beruntun.
function getStreakBadge(streak) {
  if (streak >= 10) return { emoji: "🐐", label: "GOAT" };
  if (streak >= 5) return { emoji: "🔥🔥", label: "Super Unbeaten" };
  if (streak >= 3) return { emoji: "✅", label: "Unbeaten" };
  if (streak <= -3) return { emoji: "😅", label: "Looser" };
  return null;
}

// Gabungkan semua badge yang berlaku untuk 1 pemain jadi 1 array
function buildBadges({ winRate, matchesPlayed, streak, giantSlayer }) {
  const badges = [];
  const mainTitle = getMainTitle(winRate, matchesPlayed);
  if (mainTitle) badges.push(mainTitle);
  const streakBadge = getStreakBadge(streak);
  if (streakBadge) badges.push(streakBadge);
  if (giantSlayer) badges.push({ emoji: "🗡️", label: "Giant Slayer" });
  return badges;
}

// --- SINGLE ---
// sinceDate opsional: kalau diisi, cuma hitung match sejak tanggal itu (buat scoping per season)
async function computeSinglesStats(prisma, playerId, sinceDate = null) {
  const where = { status: "confirmed", OR: [{ winnerId: playerId }, { loserId: playerId }] };
  if (sinceDate) where.confirmedAt = { gte: sinceDate };

  const matches = await prisma.match.findMany({
    where,
    orderBy: { confirmedAt: "asc" },
    select: { winnerId: true, loserId: true, ratingWinnerBefore: true, ratingLoserBefore: true },
  });

  const wins = matches.filter((m) => m.winnerId === playerId).length;
  const losses = matches.filter((m) => m.loserId === playerId).length;
  const matchesPlayed = wins + losses;
  const winRate = matchesPlayed > 0 ? Math.round((wins / matchesPlayed) * 1000) / 10 : 0;

  // Streak: hitung dari match paling akhir mundur ke belakang, selama hasilnya sama
  let streak = 0;
  for (let i = matches.length - 1; i >= 0; i--) {
    const won = matches[i].winnerId === playerId;
    if (i === matches.length - 1) {
      streak = won ? 1 : -1;
    } else {
      const sameDirection = won ? streak > 0 : streak < 0;
      if (!sameDirection) break;
      streak += won ? 1 : -1;
    }
  }

  // Giant slayer: pernah menang lawan yang rating-nya jauh lebih tinggi
  let giantSlayer = false;
  for (const m of matches) {
    if (m.winnerId === playerId && m.ratingLoserBefore != null && m.ratingWinnerBefore != null) {
      const gap = Number(m.ratingLoserBefore) - Number(m.ratingWinnerBefore);
      if (gap >= GIANT_SLAYER_GAP) giantSlayer = true;
    }
  }

  return { matchesPlayed, wins, losses, winRate, streak, giantSlayer };
}

// --- GANDA ---
async function computeDoublesStats(prisma, playerId, sinceDate = null) {
  const where = {
    status: "confirmed",
    OR: [
      { team1Player1Id: playerId }, { team1Player2Id: playerId },
      { team2Player1Id: playerId }, { team2Player2Id: playerId },
    ],
  };
  if (sinceDate) where.confirmedAt = { gte: sinceDate };

  const matches = await prisma.doublesMatch.findMany({
    where,
    orderBy: { confirmedAt: "asc" },
    select: {
      team1Player1Id: true, team1Player2Id: true, team2Player1Id: true, team2Player2Id: true,
      winningTeam: true, team1RatingBefore: true, team2RatingBefore: true,
    },
  });

  let wins = 0, losses = 0;
  const results = []; // true = menang, false = kalah, urut kronologis
  for (const m of matches) {
    const myTeam = [m.team1Player1Id, m.team1Player2Id].includes(playerId) ? 1 : 2;
    const won = m.winningTeam === myTeam;
    results.push({ won, myTeam, team1RatingBefore: m.team1RatingBefore, team2RatingBefore: m.team2RatingBefore });
    if (won) wins++; else losses++;
  }
  const matchesPlayed = wins + losses;
  const winRate = matchesPlayed > 0 ? Math.round((wins / matchesPlayed) * 1000) / 10 : 0;

  let streak = 0;
  for (let i = results.length - 1; i >= 0; i--) {
    const won = results[i].won;
    if (i === results.length - 1) {
      streak = won ? 1 : -1;
    } else {
      const sameDirection = won ? streak > 0 : streak < 0;
      if (!sameDirection) break;
      streak += won ? 1 : -1;
    }
  }

  let giantSlayer = false;
  for (const r of results) {
    if (!r.won || r.team1RatingBefore == null || r.team2RatingBefore == null) continue;
    const myTeamRating = r.myTeam === 1 ? Number(r.team1RatingBefore) : Number(r.team2RatingBefore);
    const oppTeamRating = r.myTeam === 1 ? Number(r.team2RatingBefore) : Number(r.team1RatingBefore);
    if (oppTeamRating - myTeamRating >= GIANT_SLAYER_GAP) giantSlayer = true;
  }

  return { matchesPlayed, wins, losses, winRate, streak, giantSlayer };
}

module.exports = { computeSinglesStats, computeDoublesStats, buildBadges, getMainTitle, getStreakBadge };
