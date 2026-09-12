// Satu-satunya PrismaClient yang dipakai SELURUH aplikasi.
// PENTING: jangan buat `new PrismaClient()` lagi di file lain manapun --
// tiap instance PrismaClient buka kolam koneksi database sendiri-sendiri,
// dan Supabase (Session pooler) cuma izinkan maksimal 15 koneksi total.
// Dengan banyak file bikin instance sendiri-sendiri, batas itu gampang kelewat
// dan aplikasi crash dengan error "max clients reached in session mode".
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

module.exports = prisma;
