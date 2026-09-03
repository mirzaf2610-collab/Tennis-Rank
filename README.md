# Tennis Ranking Pusri

Aplikasi ranking komunitas tenis berbasis ELO. Format match: first-to-6-games
tanpa deuce/tiebreak (skor akhir 6-0 s.d 6-5), dengan bonus poin berdasarkan
selisih game dan redaman untuk mismatch rating.

## Cara deploy (tanpa perlu instal apapun di komputer sendiri)

Ikuti langkah ini persis urutannya. Total waktu sekitar 20-30 menit.

### Langkah 1 — Buat akun GitHub (kalau belum punya)
1. Buka https://github.com/signup
2. Daftar dengan email Anda

### Langkah 2 — Upload kode ini ke GitHub
1. Buka https://github.com/new
2. Isi nama repository, misal `tennis-ranking-pusri`, set ke **Private**
3. Klik "Create repository"
4. Di halaman repository baru, klik "uploading an existing file"
5. Upload semua file dan folder dari project ini (drag semua isi folder `tennis-ranking-app`)
6. Klik "Commit changes"

### Langkah 3 — Buat database PostgreSQL gratis di Supabase
1. Buka https://supabase.com, daftar/login (bisa pakai akun GitHub)
2. Klik "New project"
3. Isi nama project, buat password database (simpan baik-baik, akan dipakai lagi)
4. Tunggu 1-2 menit sampai project selesai dibuat
5. Buka menu **Project Settings → Database**
6. Cari bagian "Connection string" → pilih tab **URI**, copy string-nya
   (bentuknya seperti `postgresql://postgres:[PASSWORD]@...supabase.co:5432/postgres`)
7. Ganti `[PASSWORD]` dengan password yang Anda buat di langkah 3 — ini akan
   jadi nilai `DATABASE_URL` nanti

### Langkah 4 — Deploy aplikasi ke Railway
1. Buka https://railway.app, daftar/login pakai akun GitHub
2. Klik "New Project" → "Deploy from GitHub repo"
3. Pilih repository `tennis-ranking-pusri` yang tadi diupload
4. Railway akan otomatis mendeteksi ini aplikasi Node.js
5. Buka tab **Variables**, tambahkan:
   - `DATABASE_URL` = connection string dari Supabase (langkah 3)
   - `JWT_SECRET` = ketik teks acak apapun, contoh: `pusri-tenis-rahasia-2026-xyz`
6. Buka tab **Settings** → cari "Deploy" → set **Start Command** menjadi:
   ```
   npx prisma migrate deploy && npx prisma generate && node src/server.js
   ```
7. Klik "Deploy" — tunggu beberapa menit
8. Setelah selesai, buka tab **Settings → Networking**, klik "Generate Domain"
   untuk mendapat URL publik (misal `tennis-ranking-pusri.up.railway.app`)

### Langkah 5 — Coba buka aplikasinya
Buka URL yang didapat dari langkah 4 di browser HP atau laptop. Anda akan
melihat halaman "Masuk / Daftar" — klik "Daftar" untuk membuat akun pertama.

### Kalau ada error saat deploy
- Cek tab **Deploy Logs** di Railway, biasanya errornya jelas terbaca
  (misal `DATABASE_URL` salah format, atau lupa generate domain)
- Error paling umum: lupa mengganti `[PASSWORD]` di connection string Supabase

## Struktur project

```
src/
  server.js       - entry point aplikasi
  elo.js          - rumus perhitungan rating ELO
  auth.js         - middleware autentikasi (JWT)
  routes/
    auth.js       - register & login
    players.js    - leaderboard, profil, daftar pemain
    matches.js    - submit, konfirmasi, tolak hasil match
public/
  index.html      - halaman utama
  app.js          - logika frontend
  style.css       - styling
prisma/
  schema.prisma   - struktur database
```

## Aturan sistem poin (ringkasan)
- Rating awal semua pemain: 1500
- K-factor: 32 untuk 10 match pertama (provisional), turun ke 20 setelahnya
- Bonus margin berdasarkan selisih game menang (6-0 dapat 1.5x, 6-5 dapat 1.0x)
- Redaman otomatis kalau yang menang memang sudah jauh lebih tinggi rating-nya
- Minimal 3 match untuk muncul di leaderboard
- Hasil match baru berlaku (mengubah rating) setelah **kedua pemain** konfirmasi

## Menambah admin / mengatasi dispute
Untuk versi ini, dispute (match yang ditolak salah satu pihak) belum ada
halaman admin — silakan cek dan resolve langsung lewat dashboard Supabase
(menu **Table Editor** → tabel `matches`) untuk sementara. Bisa ditambahkan
fitur admin panel di fase berikutnya kalau dibutuhkan.
