// Perhitungan ELO untuk format singles: first-to-6-games, tanpa deuce/tiebreak.
// Skor akhir yang valid: 6-0, 6-1, 6-2, 6-3, 6-4, 6-5.

const MIN_MATCHES_LEADERBOARD = 3;
const PROVISIONAL_THRESHOLD = 10;
const K_PROVISIONAL = 32;
const K_STABLE = 20;

function getKFactor(matchesPlayed) {
  return matchesPlayed < PROVISIONAL_THRESHOLD ? K_PROVISIONAL : K_STABLE;
}

function calculateElo({ ratingWinner, ratingLoser, loserGames, kFactorWinner, kFactorLoser }) {
  if (loserGames < 0 || loserGames > 5) {
    throw new Error("loserGames harus di antara 0 dan 5");
  }

  const rWinner = Number(ratingWinner);
  const rLoser = Number(ratingLoser);
  const diff = 6 - loserGames;

  const eWinner = 1 / (1 + Math.pow(10, (rLoser - rWinner) / 400));
  const eLoser = 1 - eWinner;

  const m = 1 + (diff - 1) * 0.1; // 1.0 - 1.5
  const ratingGap = Math.abs(rWinner - rLoser);
  const d = 2.2 / (ratingGap * 0.001 + 2.2);
  const mFinal = 1 + (m - 1) * d;

  const ratingWinnerAfter = rWinner + kFactorWinner * mFinal * (1 - eWinner);
  const ratingLoserAfter = rLoser + kFactorLoser * mFinal * (0 - eLoser);

  return {
    diff,
    marginMultiplier: Math.round(mFinal * 1000) / 1000,
    ratingWinnerAfter: Math.round(ratingWinnerAfter * 100) / 100,
    ratingLoserAfter: Math.round(ratingLoserAfter * 100) / 100,
    ratingWinnerChange: Math.round((ratingWinnerAfter - rWinner) * 100) / 100,
    ratingLoserChange: Math.round((ratingLoserAfter - rLoser) * 100) / 100,
  };
}

// Perhitungan ELO untuk doubles: pakai rata-rata rating tim untuk menentukan expected outcome,
// tapi tiap pemain tetap punya rating individu sendiri yang diupdate dari titik awal masing-masing.
function calculateDoublesElo({
  team1Player1Rating, team1Player2Rating,
  team2Player1Rating, team2Player2Rating,
  winningTeam, // 1 atau 2
  loserGames,
  kFactors, // { t1p1, t1p2, t2p1, t2p2 }
}) {
  if (loserGames < 0 || loserGames > 5) {
    throw new Error("loserGames harus di antara 0 dan 5");
  }
  if (winningTeam !== 1 && winningTeam !== 2) {
    throw new Error("winningTeam harus 1 atau 2");
  }

  const t1p1 = Number(team1Player1Rating);
  const t1p2 = Number(team1Player2Rating);
  const t2p1 = Number(team2Player1Rating);
  const t2p2 = Number(team2Player2Rating);

  const team1Rating = (t1p1 + t1p2) / 2;
  const team2Rating = (t2p1 + t2p2) / 2;

  const diff = 6 - loserGames;
  const m = 1 + (diff - 1) * 0.1;
  const ratingGap = Math.abs(team1Rating - team2Rating);
  const d = 2.2 / (ratingGap * 0.001 + 2.2);
  const mFinal = 1 + (m - 1) * d;

  const eTeam1 = 1 / (1 + Math.pow(10, (team2Rating - team1Rating) / 400));
  const eTeam2 = 1 - eTeam1;

  const sTeam1 = winningTeam === 1 ? 1 : 0;
  const sTeam2 = winningTeam === 2 ? 1 : 0;

  const round2 = (n) => Math.round(n * 100) / 100;

  const t1p1After = t1p1 + kFactors.t1p1 * mFinal * (sTeam1 - eTeam1);
  const t1p2After = t1p2 + kFactors.t1p2 * mFinal * (sTeam1 - eTeam1);
  const t2p1After = t2p1 + kFactors.t2p1 * mFinal * (sTeam2 - eTeam2);
  const t2p2After = t2p2 + kFactors.t2p2 * mFinal * (sTeam2 - eTeam2);

  return {
    diff,
    marginMultiplier: Math.round(mFinal * 1000) / 1000,
    team1Rating: round2(team1Rating),
    team2Rating: round2(team2Rating),
    t1p1After: round2(t1p1After),
    t1p2After: round2(t1p2After),
    t2p1After: round2(t2p1After),
    t2p2After: round2(t2p2After),
  };
}

module.exports = {
  calculateElo,
  calculateDoublesElo,
  getKFactor,
  MIN_MATCHES_LEADERBOARD,
  PROVISIONAL_THRESHOLD,
};
