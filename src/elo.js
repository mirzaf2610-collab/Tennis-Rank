// Perhitungan ELO.
// SINGLE: format fleksibel (targetGames = jumlah game untuk menang set: 4/6/8, dst).
//   Bonus margin pakai selisih game MENTAH (bukan rasio) + bobot panjang format,
//   supaya format lebih pendek otomatis dapat poin lebih kecil dibanding format standar,
//   meski dominasinya (rasio menang) sama.
// DOUBLES: tetap format tetap (first-to-6), tidak ada opsi format.

const MIN_MATCHES_LEADERBOARD = 3;
const PROVISIONAL_THRESHOLD = 10;
const K_PROVISIONAL = 32;
const K_STABLE = 20;
const DEFAULT_TARGET_GAMES = 6;
const MIN_TARGET_GAMES = 2;
const MAX_TARGET_GAMES = 12;

function getKFactor(matchesPlayed) {
  return matchesPlayed < PROVISIONAL_THRESHOLD ? K_PROVISIONAL : K_STABLE;
}

function isValidTargetGames(targetGames) {
  return Number.isInteger(targetGames) && targetGames >= MIN_TARGET_GAMES && targetGames <= MAX_TARGET_GAMES;
}

// --- SINGLE (format fleksibel) ---
function calculateElo({ ratingWinner, ratingLoser, loserGames, kFactorWinner, kFactorLoser, targetGames = DEFAULT_TARGET_GAMES }) {
  if (!isValidTargetGames(targetGames)) {
    throw new Error(`targetGames harus antara ${MIN_TARGET_GAMES} dan ${MAX_TARGET_GAMES}`);
  }
  if (loserGames < 0 || loserGames > targetGames - 1) {
    throw new Error(`loserGames harus di antara 0 dan ${targetGames - 1}`);
  }

  const rWinner = Number(ratingWinner);
  const rLoser = Number(ratingLoser);
  const diff = targetGames - loserGames; // selisih game mentah, 1 s.d targetGames

  const eWinner = 1 / (1 + Math.pow(10, (rLoser - rWinner) / 400));
  const eLoser = 1 - eWinner;

  // Bonus margin dari selisih game mentah (skala sama seperti format standar 6-game):
  // diff=1 -> M=1.0 (tipis), setiap +1 selisih game -> +0.1
  const m = 1 + (diff - 1) * 0.1;

  // Bobot panjang format: format lebih pendek dari standar (6) otomatis dapat bobot lebih kecil,
  // format lebih panjang dapat bobot lebih besar. Format 6-game (standar) = bobot 1.0 (tidak berubah).
  const lengthWeight = targetGames / DEFAULT_TARGET_GAMES;

  const ratingGap = Math.abs(rWinner - rLoser);
  const d = 2.2 / (ratingGap * 0.001 + 2.2);
  const mFinal = 1 + (m - 1) * d;

  const combinedFactor = mFinal * lengthWeight;

  const ratingWinnerAfter = rWinner + kFactorWinner * combinedFactor * (1 - eWinner);
  const ratingLoserAfter = rLoser + kFactorLoser * combinedFactor * (0 - eLoser);

  return {
    diff,
    marginMultiplier: Math.round(mFinal * 1000) / 1000,
    lengthWeight: Math.round(lengthWeight * 1000) / 1000,
    ratingWinnerAfter: Math.round(ratingWinnerAfter * 100) / 100,
    ratingLoserAfter: Math.round(ratingLoserAfter * 100) / 100,
    ratingWinnerChange: Math.round((ratingWinnerAfter - rWinner) * 100) / 100,
    ratingLoserChange: Math.round((ratingLoserAfter - rLoser) * 100) / 100,
  };
}

// --- DOUBLES (format tetap, first-to-6, TIDAK ada opsi format) ---
// Pakai rata-rata rating tim untuk menentukan expected outcome,
// tapi tiap pemain tetap punya rating individu sendiri yang diupdate dari titik awal masing-masing.
function calculateDoublesElo({
  team1Player1Rating, team1Player2Rating,
  team2Player1Rating, team2Player2Rating,
  winningTeam, // 1 atau 2
  loserGames,  // 0-5, format tetap first-to-6
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
  isValidTargetGames,
  MIN_MATCHES_LEADERBOARD,
  PROVISIONAL_THRESHOLD,
  DEFAULT_TARGET_GAMES,
  MIN_TARGET_GAMES,
  MAX_TARGET_GAMES,
};
