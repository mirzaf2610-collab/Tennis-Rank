const express = require("express");
const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");
const { signToken } = require("../auth");

const router = express.Router();
const prisma = new PrismaClient();

// POST /api/auth/register
router.post("/register", async (req, res) => {
  const { name, email, password, unitKerja } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({
      error: { code: "MISSING_FIELDS", message: "Nama, email, dan password wajib diisi" },
    });
  }
  if (password.length < 6) {
    return res.status(400).json({
      error: { code: "WEAK_PASSWORD", message: "Password minimal 6 karakter" },
    });
  }

  const existing = await prisma.player.findUnique({ where: { email } });
  if (existing) {
    return res.status(409).json({
      error: { code: "EMAIL_TAKEN", message: "Email sudah terdaftar" },
    });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const player = await prisma.player.create({
    data: { name, email, passwordHash, unitKerja: unitKerja || null },
  });

  const token = signToken(player);
  res.status(201).json({
    token,
    player: {
      id: player.id,
      name: player.name,
      email: player.email,
      currentRating: player.currentRating,
      matchesPlayed: player.matchesPlayed,
      isProvisional: player.isProvisional,
    },
  });
});

// POST /api/auth/login
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({
      error: { code: "MISSING_FIELDS", message: "Email dan password wajib diisi" },
    });
  }

  const player = await prisma.player.findUnique({ where: { email } });
  if (!player) {
    return res.status(401).json({
      error: { code: "INVALID_CREDENTIALS", message: "Email atau password salah" },
    });
  }

  const valid = await bcrypt.compare(password, player.passwordHash);
  if (!valid) {
    return res.status(401).json({
      error: { code: "INVALID_CREDENTIALS", message: "Email atau password salah" },
    });
  }

  const token = signToken(player);
  res.json({
    token,
    player: {
      id: player.id,
      name: player.name,
      email: player.email,
      currentRating: player.currentRating,
      matchesPlayed: player.matchesPlayed,
      isProvisional: player.isProvisional,
    },
  });
});

module.exports = router;
