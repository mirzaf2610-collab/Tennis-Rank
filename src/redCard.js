// "Kartu Merah": setiap kali pemain tidak merespon (auto-confirm karena tidak konfirmasi/tolak),
// `noResponseCount`-nya naik 1 -- ini LANGSUNG jadi jumlah kartu merah 🟥 yang kelihatan di
// sebelah nama pemain di tabel ranking (noResponseCount=2 -> tampil 2 kartu merah).
// Begitu tembus 5, DIA TIDAK DI-BAN -- rating-nya dikurangi 50 poin, dan hitungannya direset ke 0
// (kartu merahnya hilang semua, siklus bisa berulang lagi kalau kebiasaannya tidak berubah).
// Kartu merah juga bisa hilang lebih cepat: begitu pemain itu aktif lagi -- konfirmasi ATAU
// input match (single maupun ganda, campur boleh) sebanyak 3 kali sejak kartu merah terakhirnya,
// noResponseCount langsung direset ke 0 juga (dianggap sudah aktif kembali).

const NO_RESPONSE_PENALTY_THRESHOLD = 5;
const NO_RESPONSE_RATING_PENALTY = 50;
const RED_CARD_CLEAR_THRESHOLD = 3;

// Dipanggil tiap kali ada match yang di-auto-confirm karena TIDAK direspon (lihat
// autoConfirmAbandonedMatches di server.js). matchType: "single" | "doubles" -- menentukan
// rating mana yang kena potong (currentRating utk single, doublesRating utk ganda), karena
// keduanya rating yang terpisah.
async function markNoResponse(tx, playerId, matchType) {
  // Dapat kartu merah baru -> reset progress pemulihan (mulai hitung 3x konfirmasi/input lagi dari 0)
  const updated = await tx.player.update({
    where: { id: playerId },
    data: { noResponseCount: { increment: 1 }, redCardProgress: 0 },
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
        redCardProgress: 0,
      },
    });
    console.log(
      `Player ${playerId} (${updated.name}) kena 5 Kartu Merah: -${NO_RESPONSE_RATING_PENALTY} poin ${ratingField}, ` +
      `hitungan kartu merah direset ke 0 (${matchType}).`
    );
  }
}

// Dipanggil tiap kali pemain melakukan aksi aktif (submit ATAU konfirmasi match, single maupun
// ganda). Kalau pemain itu lagi punya kartu merah (noResponseCount > 0), majukan progress
// pemulihannya; setelah 3x, semua kartu merahnya hilang (noResponseCount balik ke 0).
// Tidak melakukan apapun kalau pemain tidak sedang punya kartu merah.
async function advanceRedCardProgress(tx, playerId) {
  const player = await tx.player.findUnique({
    where: { id: playerId },
    select: { noResponseCount: true, redCardProgress: true },
  });
  if (!player || player.noResponseCount === 0) return;

  const newProgress = player.redCardProgress + 1;
  if (newProgress >= RED_CARD_CLEAR_THRESHOLD) {
    await tx.player.update({ where: { id: playerId }, data: { noResponseCount: 0, redCardProgress: 0 } });
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
