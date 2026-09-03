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

module.exports = {
  calculateElo,
  getKFactor,
  MIN_MATCHES_LEADERBOARD,
  PROVISIONAL_THRESHOLD,
};
