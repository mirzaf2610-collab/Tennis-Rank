// "Kartu Merah": pengganti sistem ban otomatis lama. Kalau seorang pemain tidak merespon
// (tidak konfirmasi/tolak) sampai 5x, DIA TIDAK DI-BAN -- rating-nya dikurangi 50 poin, hitungan
// tidak-respon direset ke 0 (siklus berulang terus kalau tidak berubah kebiasaan), dan pemain
// itu ditandai "kartu merah" supaya kelihatan di ranking (semua orang bisa lihat).
// Kartu merah otomatis hilang begitu pemain itu aktif lagi -- konfirmasi ATAU input match
// (single maupun ganda, campur boleh) sebanyak 3 kali.

const NO_RESPONSE_PENALTY_THRESHOLD = 5;
const NO_RESPONSE_RATING_PENALTY = 50;
const RED_CARD_CLEAR_THRESHOLD = 3;

// Dipanggil tiap kali ada match yang di-auto-confirm karena TIDAK direspon (lihat
// autoConfirmAbandonedMatches di server.js). matchType: "single" | "doubles" -- menentukan
// rating mana yang kena potong (currentRating utk single, doublesRating utk ganda), karena
// keduanya rating yang terpisah.
async function markNoResponse(tx, playerId, matchType) {
  const updated = await tx.player.update({
    where: { id: playerId },
    data: { noResponseCount: { increment: 1 } },
  });

  if (updated.noResponseCount >= NO_RESPONSE_PENALTY_THRESHOLD) {
    const isDoubles = matchType === "doubles";
    const ratingField = isDoubles ? "doublesRating" : "currentRating";
    const currentValue = Number(isDoubles ? updated.doublesRating : updated.currentRating);

    await tx.player.update({
      where: { id: playerId },
      data: {
        [ratingField]: currentValue - NO_RESPONSE_RATING_PENALTY,
        noResponseCount: 0,
        hasRedCard: true,
        redCardProgress: 0,
      },
    });
    console.log(
      `Player ${playerId} (${updated.name}) kena Kartu Merah: -${NO_RESPONSE_RATING_PENALTY} poin ${ratingField} ` +
      `setelah ${NO_RESPONSE_PENALTY_THRESHOLD}x tidak merespon (${matchType}). Hitungan direset ke 0.`
    );
  }
}

// Dipanggil tiap kali pemain melakukan aksi aktif (submit ATAU konfirmasi match, single maupun
// ganda). Kalau pemain itu lagi kena kartu merah, majukan progress pemulihannya; setelah 3x,
// kartu merah otomatis hilang. Tidak melakukan apapun kalau pemain tidak sedang kena kartu merah.
async function advanceRedCardProgress(tx, playerId) {
  const player = await tx.player.findUnique({
    where: { id: playerId },
    select: { hasRedCard: true, redCardProgress: true },
  });
  if (!player || !player.hasRedCard) return;

  const newProgress = player.redCardProgress + 1;
  if (newProgress >= RED_CARD_CLEAR_THRESHOLD) {
    await tx.player.update({ where: { id: playerId }, data: { hasRedCard: false, redCardProgress: 0 } });
  } else {
    await tx.player.update({ where: { id: playerId }, data: { redCardProgress: newProgress } });
  }
}

module.exports = {
  markNoResponse,
  advanceRedCardProgress,
  NO_RESPONSE_PENALTY_THRESHOLD,
  NO_RESPONSE_RATING_PENALTY,
  RED_CARD_CLEAR_THRESHOLD,
};
