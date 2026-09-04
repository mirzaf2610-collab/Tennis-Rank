const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { PrismaClient } = require("@prisma/client");
const { signToken } = require("../auth");
const { sendPasswordResetEmail, sendVerificationEmail } = require("../emailService");

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

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 jam
  await prisma.emailVerificationToken.create({ data: { playerId: player.id, token, expiresAt } });

  const baseUrl = req.body.appUrl || `${req.protocol}://${req.get("host")}`;
  const verifyLink = `${baseUrl}/?verifyToken=${token}`;

  try {
    await sendVerificationEmail(player.email, player.name, verifyLink);
  } catch (e) {
    return res.status(500).json({ error: { code: "EMAIL_FAILED", message: `Akun dibuat, tapi gagal kirim email verifikasi: ${e.message}` } });
  }

  res.status(201).json({
    message: "Akun berhasil dibuat. Silakan cek email Anda untuk verifikasi sebelum login.",
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

  if (player.isBanned) {
    return res.status(403).json({
      error: { code: "ACCOUNT_BANNED", message: `Akun Anda diblokir karena terlalu sering tidak konfirmasi hasil match (${player.noResponseCount}x). Hubungi admin komunitas untuk membuka blokir.` },
    });
  }

  if (!player.emailVerified) {
    return res.status(403).json({
      error: { code: "EMAIL_NOT_VERIFIED", message: "Email belum diverifikasi. Cek inbox/spam Anda, atau minta kirim ulang." },
    });
  }

  if (!player.isApproved) {
    return res.status(403).json({
      error: { code: "NOT_APPROVED", message: "Akun Anda masih menunggu persetujuan admin komunitas. Coba lagi nanti." },
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
      photoUrl: player.photoUrl,
      isAdmin: player.isAdmin,
    },
  });
});

// POST /api/auth/forgot-password
router.post("/forgot-password", async (req, res) => {
  const { email, appUrl } = req.body;
  if (!email) {
    return res.status(400).json({ error: { code: "MISSING_FIELDS", message: "Email wajib diisi" } });
  }

  const player = await prisma.player.findUnique({ where: { email } });
  // Selalu balas sukses walau email tidak ditemukan, supaya orang tidak bisa "menebak" email mana yang terdaftar.
  if (!player) {
    return res.json({ message: "Kalau email terdaftar, link reset password sudah dikirim." });
  }

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 jam

  await prisma.passwordResetToken.create({
    data: { playerId: player.id, token, expiresAt },
  });

  const baseUrl = appUrl || `${req.protocol}://${req.get("host")}`;
  const resetLink = `${baseUrl}/?resetToken=${token}`;

  try {
    await sendPasswordResetEmail(player.email, player.name, resetLink);
  } catch (e) {
    return res.status(500).json({ error: { code: "EMAIL_FAILED", message: e.message } });
  }

  res.json({ message: "Kalau email terdaftar, link reset password sudah dikirim." });
});

// POST /api/auth/reset-password
router.post("/reset-password", async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) {
    return res.status(400).json({ error: { code: "MISSING_FIELDS", message: "Token dan password baru wajib diisi" } });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: { code: "WEAK_PASSWORD", message: "Password minimal 6 karakter" } });
  }

  const resetToken = await prisma.passwordResetToken.findUnique({ where: { token } });
  if (!resetToken || resetToken.used || resetToken.expiresAt < new Date()) {
    return res.status(400).json({ error: { code: "INVALID_TOKEN", message: "Link reset password tidak valid atau sudah kedaluwarsa" } });
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.$transaction([
    prisma.player.update({ where: { id: resetToken.playerId }, data: { passwordHash } }),
    prisma.passwordResetToken.update({ where: { id: resetToken.id }, data: { used: true } }),
  ]);

  res.json({ message: "Password berhasil diubah. Silakan login dengan password baru." });
});

// POST /api/auth/verify-email
router.post("/verify-email", async (req, res) => {
  const { token } = req.body;
  if (!token) {
    return res.status(400).json({ error: { code: "MISSING_FIELDS", message: "Token wajib diisi" } });
  }

  const verifyToken = await prisma.emailVerificationToken.findUnique({ where: { token } });
  if (!verifyToken || verifyToken.used || verifyToken.expiresAt < new Date()) {
    return res.status(400).json({ error: { code: "INVALID_TOKEN", message: "Link verifikasi tidak valid atau sudah kedaluwarsa" } });
  }

  await prisma.$transaction([
    prisma.player.update({ where: { id: verifyToken.playerId }, data: { emailVerified: true } }),
    prisma.emailVerificationToken.update({ where: { id: verifyToken.id }, data: { used: true } }),
  ]);

  res.json({ message: "Email berhasil diverifikasi. Silakan login." });
});

// POST /api/auth/resend-verification
router.post("/resend-verification", async (req, res) => {
  const { email, appUrl } = req.body;
  if (!email) {
    return res.status(400).json({ error: { code: "MISSING_FIELDS", message: "Email wajib diisi" } });
  }

  const player = await prisma.player.findUnique({ where: { email } });
  if (!player) {
    return res.json({ message: "Kalau email terdaftar, email verifikasi sudah dikirim ulang." });
  }
  if (player.emailVerified) {
    return res.status(400).json({ error: { code: "ALREADY_VERIFIED", message: "Email ini sudah terverifikasi, silakan login" } });
  }

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await prisma.emailVerificationToken.create({ data: { playerId: player.id, token, expiresAt } });

  const baseUrl = appUrl || `${req.protocol}://${req.get("host")}`;
  const verifyLink = `${baseUrl}/?verifyToken=${token}`;

  try {
    await sendVerificationEmail(player.email, player.name, verifyLink);
  } catch (e) {
    return res.status(500).json({ error: { code: "EMAIL_FAILED", message: e.message } });
  }

  res.json({ message: "Email verifikasi sudah dikirim ulang, silakan cek inbox/spam." });
});

module.exports = router;
