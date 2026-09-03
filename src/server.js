require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");

const authRoutes = require("./routes/auth");
const playerRoutes = require("./routes/players");
const matchRoutes = require("./routes/matches");
const doublesMatchRoutes = require("./routes/doublesMatches");
const adminRoutes = require("./routes/admin");

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

app.get("/api/health", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Tennis ranking app jalan di port ${PORT}`);
});
