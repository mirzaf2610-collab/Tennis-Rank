require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const { PrismaClient } = require("@prisma/client");

const authRoutes = require("./routes/auth");
const playerRoutes = require("./routes/players");
const matchRoutes = require("./routes/matches");
const doublesMatchRoutes = require("./routes/doublesMatches");
const adminRoutes = require("./routes/admin");
const pushRoutes = require("./routes/push");

const app = express();
app.use(cors());
app.use(express.json());

// Serve halaman frontend statis (public/) dari server yang sama,
// jadi Anda hanya perlu deploy 1 aplikasi, bukan 2 terpisah.
app.use(express.static(path.join(__dirname, "..", "public")));

app.use("/api/auth", authRoutes);
app.use("/api", playerRoutes);
app.use("/api", matchRoutes);
app.use("/api", doublesMatchRoutes);
app.use("/api", adminRoutes);
app.use("/api", pushRoutes);

app.get("/api/health", (req, res) => res.json({ status: "ok" }));

const { applyEloAndConfirm } = require("./routes/matches");
const { applyDoublesEloAndConfirm } = require("./routes/doublesMatches");

const NO_RESPONSE_BAN_THRESHOLD = 5;

// Tandai 1 pemain "tidak merespon", naikkan hitungannya, ban otomatis kalau sudah 5x.
async function markNoResponse(tx, playerId) {
  const updated = await tx.player.update({
    where: { id: playerId },
    data: { noResponseCount: { increment: 1 } },
  });
  if (updated.noResponseCount >= NO_RESPONSE_BAN_THRESHOLD && !updated.isBanned) {
    await tx.player.update({ where: { id: playerId }, data: { isBanned: true } });
    console.log(`Player ${playerId} (${updated.name}) auto-banned setelah ${updated.noResponseCount}x tidak merespon.`);
  }
}

// Auto-confirm match yang statusnya masih "pending" lebih dari 7 hari (misal lawan tidak
// pernah konfirmasi). Yang menang tetap dapat poin, tapi cuma SETENGAH dari perhitungan normal.
// Pihak yang tidak merespon dicatat "tidak konfirmasi"-nya, dan di-ban otomatis kalau sudah 5x.
const prismaForAutoConfirm = new PrismaClient();
async function autoConfirmAbandonedMatches() {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  try {
    // --- SINGLE ---
    const pendingSingles = await prismaForAutoConfirm.match.findMany({
      where: { status: "pending", createdAt: { lt: cutoff } },
    });
    for (const match of pendingSingles) {
      await prismaForAutoConfirm.$transaction(async (tx) => {
        const nonResponderId = !match.confirmedByWinner ? match.winnerId : match.loserId;
        await markNoResponse(tx, nonResponderId);
        await applyEloAndConfirm(tx, match, { halfPoints: true });
      });
      console.log(`Match single #${match.id} auto-confirmed (7 hari tidak direspon, poin setengah).`);
    }

    // --- GANDA ---
    const pendingDoubles = await prismaForAutoConfirm.doublesMatch.findMany({
      where: { status: "pending", createdAt: { lt: cutoff } },
    });
    for (const match of pendingDoubles) {
      await prismaForAutoConfirm.$transaction(async (tx) => {
        const team1Confirmed = match.confirmedT1P1 || match.confirmedT1P2;
        const nonRespondingTeamIds = team1Confirmed
          ? [match.team2Player1Id, match.team2Player2Id]
          : [match.team1Player1Id, match.team1Player2Id];
        for (const pid of nonRespondingTeamIds) {
          await markNoResponse(tx, pid);
        }
        await applyDoublesEloAndConfirm(tx, match, { halfPoints: true });
      });
      console.log(`Match ganda #${match.id} auto-confirmed (7 hari tidak direspon, poin setengah).`);
    }
  } catch (err) {
    console.error("Auto-confirm gagal:", err.message);
  }
}
// Jalankan sekali saat startup, lalu ulangi tiap 1 jam.
autoConfirmAbandonedMatches();
setInterval(autoConfirmAbandonedMatches, 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Tennis ranking app jalan di port ${PORT}`);
});
