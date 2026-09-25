const API = "/api";

// Daftarkan service worker supaya browser mau menawarkan "Install App" (PWA)
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.log("Service worker gagal didaftarkan:", err);
    });
  });
}

let state = { token: localStorage.getItem("token"), player: null, page: "leaderboard" };

const urlParams = new URLSearchParams(window.location.search);
const resetTokenFromUrl = urlParams.get("resetToken");
const verifyTokenFromUrl = urlParams.get("verifyToken");
const pageFromUrl = urlParams.get("page");
if (resetTokenFromUrl) {
  state.page = "resetPassword";
} else if (verifyTokenFromUrl) {
  state.page = "verifyEmail";
} else if (pageFromUrl) {
  state.page = pageFromUrl;
}

function saveAuth(token, player) {
  state.token = token;
  state.player = player;
  localStorage.setItem("token", token);
  localStorage.setItem("player", JSON.stringify(player));
}
function loadAuth() {
  const p = localStorage.getItem("player");
  if (p) state.player = JSON.parse(p);
}
function logout() {
  localStorage.removeItem("token");
  localStorage.removeItem("player");
  state = { token: null, player: null, page: "leaderboard" };
  render();
}

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json" };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(API + path, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || "Terjadi kesalahan");
  return data;
}

function el(html) {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.firstElementChild;
}

function avatarHtml(photoUrl, name, size = 32) {
  if (photoUrl) {
    return `<img src="${photoUrl}" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;flex-shrink:0" />`;
  }
  const initials = (name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  return `<span style="width:${size}px;height:${size}px;border-radius:50%;background:#ddd;display:inline-flex;align-items:center;justify-content:center;font-size:${Math.round(size * 0.4)}px;font-weight:600;color:#555;flex-shrink:0">${initials}</span>`;
}

function badgesToHtml(badges) {
  if (!badges || badges.length === 0) return "";
  return badges.map((b) => `${b.emoji} ${b.label}`).join("<br/>");
}

// Format waktu relatif sederhana ("baru saja", "5 menit lalu", "2 jam lalu", "3 hari lalu")
function timeAgo(dateStr) {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "baru saja";
  if (minutes < 60) return `${minutes} menit lalu`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} jam lalu`;
  const days = Math.floor(hours / 24);
  return `${days} hari lalu`;
}

// Bangun mapping nama->id untuk kotak input pemain yang bisa diketik (pakai <datalist>).
// Kalau ada nama kembar, kasih tanda pembeda di belakang nama (misal "Budi (2)").
function buildPlayerNameMap(players) {
  const nameCount = {};
  players.forEach((p) => { nameCount[p.name] = (nameCount[p.name] || 0) + 1; });
  const nameToId = {};
  const options = players.map((p) => {
    const displayName = nameCount[p.name] > 1 ? `${p.name} (${p.id})` : p.name;
    nameToId[displayName] = p.id;
    return displayName;
  });
  return { nameToId, options };
}

// Cari ID pemain dari teks yang diketik, TIDAK peduli huruf besar/kecil ataupun
// spasi berlebih di awal/akhir (HP sering otomatis kapitalisasi huruf pertama).
function resolvePlayerId(nameToId, typedText) {
  const typed = (typedText || "").trim();
  if (nameToId[typed] != null) return nameToId[typed]; // cocok persis dulu (lebih cepat)
  const typedLower = typed.toLowerCase();
  const foundKey = Object.keys(nameToId).find((name) => name.toLowerCase() === typedLower);
  return foundKey ? nameToId[foundKey] : undefined;
}

// Komponen pencarian nama pemain custom (bukan <datalist> bawaan browser, supaya
// perilakunya konsisten baik di browser biasa maupun di PWA yang sudah di-install —
// <datalist> sering tidak muncul sama sekali di iOS saat mode standalone/installed).
function setupPlayerAutocomplete(wrapperEl, nameToId) {
  const input = wrapperEl.querySelector("input");
  const list = wrapperEl.querySelector(".autocomplete-list");
  const names = Object.keys(nameToId);

  function renderList(filterText) {
    const q = filterText.trim().toLowerCase();
    const matches = q ? names.filter((n) => n.toLowerCase().includes(q)) : names;
    if (matches.length === 0) {
      list.style.display = "none";
      return;
    }
    list.innerHTML = matches
      .slice(0, 8)
      .map((n) => `<div class="autocomplete-item" data-name="${n}">${n}</div>`)
      .join("");
    list.style.display = "block";
    list.querySelectorAll(".autocomplete-item").forEach((item) => {
      // mousedown (bukan click) supaya kepilih SEBELUM event blur nutup dropdown-nya
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        input.value = item.dataset.name;
        list.style.display = "none";
      });
    });
  }

  input.addEventListener("input", () => renderList(input.value));
  input.addEventListener("focus", () => renderList(input.value));
  input.addEventListener("blur", () => {
    setTimeout(() => { list.style.display = "none"; }, 150);
  });
}

function nav(active) {
  const items = [["leaderboard", "Ranking"], ["tournaments", "Turnamen"]];
  if (state.token) {
    items.push(["submit", "Input Single"], ["submitDoubles", "Input Ganda"], ["confirm", "Konfirmasi"], ["profile", "Profil"]);
    if (state.player && state.player.isAdmin) {
      items.push(["admin", "Admin"]);
    }
  } else {
    items.push(["login", "Masuk / Daftar"]);
  }
  const buttons = items
    .map(([key, label]) => `<button data-page="${key}" class="${key === active ? "active" : ""}">${label}</button>`)
    .join("");
  const wrap = el(`<div class="nav">${buttons}</div>`);
  wrap.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      state.page = b.dataset.page;
      render();
    });
  });
  return wrap;
}

async function renderLogin(container) {
  const box = el(`
    <div class="card">
      <h2>Masuk / Daftar</h2>
      <div id="mode-toggle" class="nav" style="margin-bottom:1rem">
        <button data-mode="login" class="active">Masuk</button>
        <button data-mode="register">Daftar</button>
      </div>
      <div id="name-field" style="display:none">
        <label>Nama</label>
        <input id="f-name" type="text" placeholder="Nama lengkap" />
      </div>
      <label>Email</label>
      <input id="f-email" type="email" placeholder="Isi email anda" />
      <label>Password</label>
      <input id="f-password" type="password" placeholder="Minimal 6 karakter" />
      <div id="f-error" class="error" style="display:none"></div>
      <button id="f-submit" class="btn">Masuk</button>
      <button id="forgot-btn" class="btn secondary" type="button" style="margin-top:0.5rem">Lupa password?</button>
    </div>
  `);
  let mode = "login";
  box.querySelectorAll("[data-mode]").forEach((b) => {
    b.addEventListener("click", () => {
      mode = b.dataset.mode;
      box.querySelectorAll("[data-mode]").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      box.querySelector("#name-field").style.display = mode === "register" ? "block" : "none";
      box.querySelector("#f-submit").textContent = mode === "register" ? "Daftar" : "Masuk";
    });
  });
  box.querySelector("#f-submit").addEventListener("click", async () => {
    const email = box.querySelector("#f-email").value.trim();
    const password = box.querySelector("#f-password").value;
    const name = box.querySelector("#f-name").value.trim();
    const errorEl = box.querySelector("#f-error");
    errorEl.style.display = "none";
    try {
      if (mode === "register") {
        if (!name) throw new Error("Nama wajib diisi");
        const data = await api("/auth/register", { method: "POST", body: JSON.stringify({ name, email, password }) });
        alert(data.message || "Akun berhasil dibuat. Silakan cek email Anda untuk verifikasi sebelum login.");
        mode = "login";
        box.querySelectorAll("[data-mode]").forEach((x) => x.classList.remove("active"));
        box.querySelector('[data-mode="login"]').classList.add("active");
        box.querySelector("#name-field").style.display = "none";
        box.querySelector("#f-submit").textContent = "Masuk";
        return;
      }
      const data = await api("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      saveAuth(data.token, data.player);
      state.page = "leaderboard";
      render();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = "block";
      if (err.message && err.message.includes("belum diverifikasi")) {
        const existing = box.querySelector("#resend-verify-btn");
        if (existing) existing.remove();
        const resendBtn = el(`<button id="resend-verify-btn" class="btn secondary" type="button" style="margin-top:0.5rem">Kirim ulang email verifikasi</button>`);
        resendBtn.addEventListener("click", async () => {
          try {
            const data = await api("/auth/resend-verification", { method: "POST", body: JSON.stringify({ email }) });
            alert(data.message || "Email verifikasi sudah dikirim ulang.");
          } catch (e) {
            alert(e.message);
          }
        });
        errorEl.after(resendBtn);
      }
    }
  });
  box.querySelector("#forgot-btn").addEventListener("click", async () => {
    const email = box.querySelector("#f-email").value.trim();
    const errorEl = box.querySelector("#f-error");
    errorEl.style.display = "none";
    if (!email) {
      errorEl.textContent = "Isi email Anda dulu di atas, lalu klik 'Lupa password?' lagi";
      errorEl.style.display = "block";
      return;
    }
    try {
      const data = await api("/auth/forgot-password", { method: "POST", body: JSON.stringify({ email }) });
      alert(data.message || "Kalau email terdaftar, link reset password sudah dikirim. Cek inbox/spam email Anda.");
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = "block";
    }
  });
  container.appendChild(box);
}

async function renderResetPassword(container) {
  const box = el(`
    <div class="card">
      <h2>Buat Password Baru</h2>
      <label>Password baru</label>
      <input id="new-password" type="password" placeholder="Minimal 6 karakter" />
      <div id="f-error" class="error" style="display:none"></div>
      <button id="reset-submit" class="btn">Simpan Password Baru</button>
    </div>
  `);
  box.querySelector("#reset-submit").addEventListener("click", async () => {
    const newPassword = box.querySelector("#new-password").value;
    const errorEl = box.querySelector("#f-error");
    errorEl.style.display = "none";
    try {
      const data = await api("/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({ token: resetTokenFromUrl, newPassword }),
      });
      alert(data.message || "Password berhasil diubah, silakan login.");
      window.history.replaceState({}, "", window.location.pathname);
      state.page = "login";
      render();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = "block";
    }
  });
  container.appendChild(box);
}

async function renderVerifyEmail(container) {
  const box = el(`<div class="card"><h2>Verifikasi Email</h2><p id="verify-status" class="muted">Memverifikasi email Anda...</p></div>`);
  container.appendChild(box);
  try {
    const data = await api("/auth/verify-email", {
      method: "POST",
      body: JSON.stringify({ token: verifyTokenFromUrl }),
    });
    box.querySelector("#verify-status").innerHTML = `${data.message || "Email berhasil diverifikasi."} <br/><br/>`;
    const loginBtn = el(`<button class="btn">Ke Halaman Masuk</button>`);
    loginBtn.addEventListener("click", () => {
      window.history.replaceState({}, "", window.location.pathname);
      state.page = "login";
      render();
    });
    box.appendChild(loginBtn);
  } catch (err) {
    box.querySelector("#verify-status").innerHTML = `<span class="error">${err.message}</span>`;
  }
}

async function renderLeaderboard(container) {
  container.appendChild(nav("leaderboard"));
  const wrap = el(`
    <div class="card">
      <h2>Ranking</h2>
      <div class="nav" style="margin-bottom:0.75rem">
        <button data-mode="single">Single</button>
        <button data-mode="double" class="active">Ganda</button>
      </div>
      <div style="margin-bottom:1rem">
        <label style="font-size:12px">Season</label>
        <select id="season-select"><option>Memuat...</option></select>
      </div>
      <div style="margin-bottom:1rem">
        <label style="font-size:12px">Urutkan berdasarkan</label>
        <select id="sort-select">
          <option value="rating">Poin</option>
          <option value="matches">Jumlah Main</option>
          <option value="winrate">Win Rate</option>
        </select>
      </div>
      <div id="lb-list">Memuat...</div>
      <div class="muted" style="font-size:11px;margin-top:0.5rem">
        🟥 Kartu merah berarti player tidak respon konfirmasi dalam 2x24 jam.
        <ul style="margin:4px 0 0;padding-left:18px">
          <li>5x kartu merah, poin akan dikurang 50.</li>
          <li>Kartu merah akan hilang jika player Input / Konfirmasi hasil pertandingan minimal 3 kali.</li>
        </ul>
      </div>
    </div>
  `);
  container.appendChild(wrap);

  // Isi dropdown Season
  let seasons = [];
  try {
    const data = await api("/seasons");
    seasons = data.seasons;
    wrap.querySelector("#season-select").innerHTML = seasons
      .map((s) => `<option value="${s.id}">${s.name}${s.isActive ? " (Aktif)" : ""}</option>`)
      .join("");
  } catch (err) {
    wrap.querySelector("#season-select").innerHTML = `<option>Gagal memuat season</option>`;
  }

  const tourneyPreviewWrap = el(`<div class="card"><h2>🏆 Turnamen Berlangsung</h2><div id="tourney-preview-list">Memuat...</div></div>`);
  container.appendChild(tourneyPreviewWrap);
  try {
    const { tournaments } = await api("/tournaments");
    const ongoing = tournaments.filter((t) => t.status !== "completed");
    const list = tourneyPreviewWrap.querySelector("#tourney-preview-list");
    if (ongoing.length === 0) {
      list.innerHTML = `<p class="muted">Tidak ada turnamen yang sedang berlangsung.</p>`;
    } else {
      list.innerHTML = "";
      ongoing.forEach((t) => {
        const formatLabel = { bracket: "Bracket/Eliminasi", group_knockout: "Setengah Kompetisi", cappuccino: "Sistem Cappuccino", cappuccino_external: "Cappuccino External" }[t.format] || "Round Robin";
        const typeLabel = t.type === "doubles" ? "Ganda" : "Single";
        const item = el(`
          <div class="row" style="cursor:pointer">
            <span><strong>${t.name}</strong><br/><span class="muted" style="font-size:12px">${typeLabel} &middot; ${formatLabel}</span></span>
            <span class="muted" style="font-size:13px">Lihat &rarr;</span>
          </div>
        `);
        item.addEventListener("click", () => {
          state.selectedTournamentId = t.id;
          state.page = "tournamentDetail";
          render();
        });
        list.appendChild(item);
      });
    }
  } catch (err) {
    tourneyPreviewWrap.querySelector("#tourney-preview-list").innerHTML = `<p class="error">${err.message}</p>`;
  }

  const pendingWrap = el(`<div class="card" style="display:none"><div style="display:flex;justify-content:space-between;align-items:center"><h2 style="margin:0">⏳ Menunggu Konfirmasi</h2><button id="pending-refresh-btn" class="btn secondary" style="margin-top:0;width:auto;padding:4px 10px;font-size:11px">🔄 Refresh</button></div><p class="muted" style="font-size:12px;margin-top:0.25rem">Hasil di bawah ini baru klaim sepihak dan BELUM masuk ke rating. Kalau match-nya menunggu konfirmasi Anda, tombol kuning akan muncul supaya bisa langsung konfirmasi di sini juga (selain lewat tab "Konfirmasi").</p><div id="pending-reminder-list"></div></div>`);
  container.appendChild(pendingWrap);

  function needsMyConfirm(m) {
    if (!state.player) return false;
    const myId = state.player.id;
    if (m.type === "single") {
      if (myId === m.winnerId && !m.confirmedByWinner) return true;
      if (myId === m.loserId && !m.confirmedByLoser) return true;
      return false;
    }
    if (myId === m.team1Player1Id && !m.confirmedT1P1) return true;
    if (myId === m.team1Player2Id && !m.confirmedT1P2) return true;
    if (myId === m.team2Player1Id && !m.confirmedT2P1) return true;
    if (myId === m.team2Player2Id && !m.confirmedT2P2) return true;
    return false;
  }

  async function loadPendingReminder() {
    const listEl = pendingWrap.querySelector("#pending-reminder-list");
    listEl.innerHTML = "Memuat...";
    try {
      const { matches } = await api("/pending-matches");
      if (matches.length === 0) {
        pendingWrap.style.display = "none";
        return;
      }
      pendingWrap.style.display = "block";
      listEl.innerHTML = matches
        .map((m) => {
          const badge = m.type === "double"
            ? `<span style="font-size:10px;background:#e3f2fd;color:#1565c0;padding:2px 6px;border-radius:6px;font-weight:600">GANDA</span>`
            : `<span style="font-size:10px;background:#fff3cd;color:#8a6d00;padding:2px 6px;border-radius:6px;font-weight:600">SINGLE</span>`;
          const mine = needsMyConfirm(m);
          return `
            <div class="row" style="align-items:flex-start;flex-direction:column;gap:4px;${mine ? "background:#fff9db;border-radius:8px;padding:8px;margin:2px 0" : ""}">
              <div style="display:flex;align-items:center;gap:6px;font-size:13px">
                ${badge} <span class="muted" style="font-size:11px">${timeAgo(m.createdAt)}</span>
              </div>
              <div style="font-size:14px"><strong>${m.claimedWinnerText}</strong> klaim menang vs ${m.claimedLoserText} <span class="muted">(${m.score})</span> <span class="muted" style="font-size:12px">— menunggu konfirmasi</span></div>
              ${mine ? `
                <div style="display:flex;gap:6px;width:100%;margin-top:2px">
                  <button class="btn" style="flex:1;background:#ffd43b;color:#1a1a1a;font-weight:700" data-confirm-pending="${m.matchId}" data-pending-type="${m.type}">✅ Konfirmasi</button>
                  <button class="btn secondary" style="flex:1;color:#c62828;border-color:#c62828" data-reject-pending="${m.matchId}" data-pending-type="${m.type}">❌ Tolak</button>
                </div>
              ` : ""}
            </div>`;
        })
        .join("");
      listEl.querySelectorAll("[data-confirm-pending]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          btn.textContent = "Mengirim...";
          const type = btn.dataset.pendingType;
          const mid = btn.dataset.confirmPending;
          try {
            const endpoint = type === "double" ? `/doubles/matches/${mid}/confirm` : `/matches/${mid}/confirm`;
            const data = await api(endpoint, { method: "POST" });
            alert(data.message || "Konfirmasi berhasil dikirim.");
            loadPendingReminder();
          } catch (err) {
            alert(err.message);
            btn.disabled = false;
            btn.textContent = "✅ Konfirmasi";
          }
        });
      });
      listEl.querySelectorAll("[data-reject-pending]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const reason = prompt("Alasan menolak hasil ini (wajib diisi)?");
          if (!reason) return;
          btn.disabled = true;
          btn.textContent = "Mengirim...";
          const type = btn.dataset.pendingType;
          const mid = btn.dataset.rejectPending;
          try {
            const endpoint = type === "double" ? `/doubles/matches/${mid}/reject` : `/matches/${mid}/reject`;
            const data = await api(endpoint, { method: "POST", body: JSON.stringify({ reason }) });
            alert(data.message || "Match ditolak, tidak masuk ke rating.");
            loadPendingReminder();
          } catch (err) {
            alert(err.message);
            btn.disabled = false;
            btn.textContent = "❌ Tolak";
          }
        });
      });
    } catch (err) {
      // Diam saja kalau gagal -- ini cuma pengingat tambahan, tidak kritikal
    }
  }
  pendingWrap.querySelector("#pending-refresh-btn").addEventListener("click", loadPendingReminder);
  loadPendingReminder();

  const liveWrap = el(`<div class="card"><h2>🎾 Score Update</h2><div id="live-score-list">Memuat...</div></div>`);
  container.appendChild(liveWrap);
  try {
    const { matches } = await api("/recent-matches");
    const list = liveWrap.querySelector("#live-score-list");
    if (matches.length === 0) {
      list.innerHTML = `<p class="muted">Belum ada pertandingan yang tercatat.</p>`;
    } else {
      list.innerHTML = matches
        .map((m) => {
          const badge = m.type === "double"
            ? `<span style="font-size:10px;background:#e3f2fd;color:#1565c0;padding:2px 6px;border-radius:6px;font-weight:600">GANDA</span>`
            : `<span style="font-size:10px;background:#fff3cd;color:#8a6d00;padding:2px 6px;border-radius:6px;font-weight:600">SINGLE</span>`;
          return `
            <div class="row" style="align-items:flex-start;flex-direction:column;gap:2px">
              <div style="display:flex;align-items:center;gap:6px;font-size:13px">
                ${badge} <span class="muted" style="font-size:11px">${timeAgo(m.confirmedAt)}</span>
              </div>
              <div style="font-size:14px"><strong>${m.winnerText}</strong> menang vs ${m.loserText} <span class="muted">(${m.score})</span></div>
            </div>`;
        })
        .join("");
    }
  } catch (err) {
    liveWrap.querySelector("#live-score-list").innerHTML = `<p class="error">${err.message}</p>`;
  }

  let currentMode = "double";
  const PAGE_SIZE = 10;
  const TRACK_HEIGHT = 180;
  let fullLeaderboard = [];

  function renderPage() {
    const list = wrap.querySelector("#lb-list");
    if (fullLeaderboard.length === 0) {
      const minText = currentMode === "double" ? "minimal 2 match" : "minimal 1 match";
      list.innerHTML = `<p class="muted">Belum ada pemain dengan ${minText}.</p>`;
      return;
    }
    const maxMatches = Math.max(...fullLeaderboard.map((p) => p.matchesPlayed));

    // Render SEMUA baris (tidak di-slice) -> body-nya di-scroll native oleh browser,
    // persis seperti scroll horizontal yang sudah smooth, bukan lompat per baris.
    const rows = fullLeaderboard
      .map((p) => {
        const badgeTexts = (p.badges || []).map((b) => `${b.emoji} ${b.label}`);
        if (p.matchesPlayed === maxMatches && p.matchesPlayed > 15) badgeTexts.push(`⚡ Antu Lapangan`);
        const gelarText = badgeTexts.length ? badgeTexts.join("<br/>") : `<span class="muted">-</span>`;
        const redCards = p.noResponseCount > 0
          ? ` <span title="${p.noResponseCount}x tidak respon konfirmasi" style="font-size:11px">${"🟥".repeat(p.noResponseCount)}</span>`
          : "";
        return `
          <tr>
            <td>${p.rank}</td>
            <td>${avatarHtml(p.photoUrl, p.name, 22)} ${p.name}${redCards}</td>
            <td>${Math.round(p.currentRating)}</td>
            <td>${p.matchesPlayed}</td>
            <td>${p.wins}</td>
            <td>${p.losses}</td>
            <td>${p.winRate}%</td>
            <td style="font-size:11px">${gelarText}</td>
          </tr>`;
      })
      .join("");

    const needsScrollbar = fullLeaderboard.length > PAGE_SIZE;
    const sliderHtml = needsScrollbar
      ? `
        <div style="display:flex;flex-direction:column;align-items:center;gap:4px;flex-shrink:0;user-select:none">
          <button id="lb-scroll-up" type="button" style="border:none;background:none;color:#888;cursor:pointer;padding:2px;font-size:10px;line-height:1">▲</button>
          <div id="lb-scroll-track" style="position:relative;width:14px;height:${TRACK_HEIGHT}px;background:#e6e6e6;border-radius:7px;touch-action:none">
            <div id="lb-scroll-thumb" style="position:absolute;left:1px;width:12px;background:#9a9a9a;border-radius:6px;cursor:grab"></div>
          </div>
          <button id="lb-scroll-down" type="button" style="border:none;background:none;color:#888;cursor:pointer;padding:2px;font-size:10px;line-height:1">▼</button>
          <span id="lb-scroll-label" class="muted" style="font-size:11px;white-space:nowrap;writing-mode:vertical-lr;margin-top:2px"></span>
        </div>`
      : "";

    list.innerHTML = `
      <div style="display:flex;gap:0.75rem;align-items:flex-start">
        <div id="lb-scroll-container" class="lb-scroll-hide" style="flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch">
          <div id="lb-table-wrap" style="overflow-x:auto">
            <table class="lb-table">
              <thead style="position:sticky;top:0;background:#fff;z-index:1">
                <tr><th>#</th><th>Pemain</th><th>Poin</th><th>Main</th><th>W</th><th>L</th><th>Win Rate</th><th>Gelar</th></tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>
        ${sliderHtml}
      </div>`;

    if (!needsScrollbar) return;

    const scrollContainer = list.querySelector("#lb-scroll-container");
    const track = list.querySelector("#lb-scroll-track");
    const thumb = list.querySelector("#lb-scroll-thumb");
    const label = list.querySelector("#lb-scroll-label");

    const updateThumb = () => {
      const scrollable = scrollContainer.scrollHeight - scrollContainer.clientHeight;
      const ratio = scrollable > 0 ? scrollContainer.scrollTop / scrollable : 0;
      const thumbRatio = Math.min(1, scrollContainer.clientHeight / scrollContainer.scrollHeight);
      const thumbHeight = Math.max(24, Math.round(TRACK_HEIGHT * thumbRatio));
      const thumbTop = Math.round(ratio * (TRACK_HEIGHT - thumbHeight));
      thumb.style.height = thumbHeight + "px";
      thumb.style.top = thumbTop + "px";
      const approxStart = Math.round(ratio * (fullLeaderboard.length - PAGE_SIZE));
      const rangeStart = approxStart + 1;
      const rangeEnd = Math.min(approxStart + PAGE_SIZE, fullLeaderboard.length);
      label.textContent = `${rangeStart}-${rangeEnd} / ${fullLeaderboard.length}`;
    };

    // Set tinggi container persis sebesar header + 10 baris, lalu hitung thumb.
    requestAnimationFrame(() => {
      const theadEl = scrollContainer.querySelector("thead");
      const bodyRows = scrollContainer.querySelectorAll("tbody tr");
      let h = theadEl ? theadEl.offsetHeight : 0;
      for (let i = 0; i < Math.min(PAGE_SIZE, bodyRows.length); i++) h += bodyRows[i].offsetHeight;
      if (h > 0) scrollContainer.style.height = h + "px";
      updateThumb();
    });

    scrollContainer.addEventListener("scroll", updateThumb);

    const setScrollFromDelta = (deltaPx, dragStartScrollTop) => {
      const travel = TRACK_HEIGHT - thumb.offsetHeight;
      const scrollable = scrollContainer.scrollHeight - scrollContainer.clientHeight;
      if (travel <= 0) return;
      scrollContainer.scrollTop = dragStartScrollTop + (deltaPx / travel) * scrollable;
    };

    let dragStartY = 0;
    let dragStartScrollTop = 0;
    const onMouseMove = (e) => setScrollFromDelta(e.clientY - dragStartY, dragStartScrollTop);
    const onTouchMove = (e) => {
      if (e.touches && e.touches[0]) {
        e.preventDefault();
        setScrollFromDelta(e.touches[0].clientY - dragStartY, dragStartScrollTop);
      }
    };
    const stopDrag = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", stopDrag);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", stopDrag);
    };

    thumb.addEventListener("mousedown", (e) => {
      e.preventDefault();
      dragStartY = e.clientY;
      dragStartScrollTop = scrollContainer.scrollTop;
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", stopDrag);
    });
    thumb.addEventListener("touchstart", (e) => {
      if (e.touches && e.touches[0]) {
        dragStartY = e.touches[0].clientY;
        dragStartScrollTop = scrollContainer.scrollTop;
        document.addEventListener("touchmove", onTouchMove, { passive: false });
        document.addEventListener("touchend", stopDrag);
      }
    });

    // Klik langsung di track (bukan di thumb) -> lompat ke posisi tsb
    track.addEventListener("mousedown", (e) => {
      if (e.target === thumb) return;
      const rect = track.getBoundingClientRect();
      const travel = TRACK_HEIGHT - thumb.offsetHeight;
      const clickTop = e.clientY - rect.top - thumb.offsetHeight / 2;
      const ratio = travel > 0 ? Math.min(Math.max(0, clickTop), travel) / travel : 0;
      const scrollable = scrollContainer.scrollHeight - scrollContainer.clientHeight;
      scrollContainer.scrollTop = ratio * scrollable;
    });

    list.querySelector("#lb-scroll-up").addEventListener("click", () => {
      scrollContainer.scrollBy({ top: -44, behavior: "smooth" });
    });
    list.querySelector("#lb-scroll-down").addEventListener("click", () => {
      scrollContainer.scrollBy({ top: 44, behavior: "smooth" });
    });
  }

  async function loadBoard() {
    const list = wrap.querySelector("#lb-list");
    list.innerHTML = "Memuat...";
    const sortBy = wrap.querySelector("#sort-select").value;
    const seasonSelect = wrap.querySelector("#season-select");
    const seasonId = seasonSelect.value;
    const selectedSeason = seasons.find((s) => String(s.id) === String(seasonId));
    try {
      let leaderboard;
      if (selectedSeason && !selectedSeason.isActive) {
        // Season lama -> pakai endpoint arsip
        const type = currentMode === "double" ? "doubles" : "singles";
        const data = await api(`/seasons/${seasonId}/leaderboard?type=${type}&sortBy=${sortBy}`);
        leaderboard = data.leaderboard;
      } else {
        const endpoint = currentMode === "double" ? "/doubles/leaderboard" : "/leaderboard";
        const data = await api(`${endpoint}?sortBy=${sortBy}`);
        leaderboard = data.leaderboard;
      }
      fullLeaderboard = leaderboard;
      renderPage();
    } catch (err) {
      list.innerHTML = `<p class="error">${err.message}</p>`;
    }
  }

  wrap.querySelectorAll("[data-mode]").forEach((b) => {
    b.addEventListener("click", () => {
      wrap.querySelectorAll("[data-mode]").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      currentMode = b.dataset.mode;
      loadBoard();
    });
  });
  wrap.querySelector("#sort-select").addEventListener("change", loadBoard);
  wrap.querySelector("#season-select").addEventListener("change", loadBoard);

  loadBoard();
}

async function renderSubmit(container) {
  container.appendChild(nav("submit"));
  const wrap = el(`
    <div class="card">
      <h2>Input hasil match</h2>
      <label style="font-size:16px;font-weight:600;color:#1a1a1a">Lawan</label>
      <select id="opponent"></select>
      <label>Format (main sampai berapa game)</label>
      <select id="target-games">
        <option value="4">First to 4</option>
        <option value="6" selected>First to 6 (standar)</option>
        <option value="8">First to 8</option>
      </select>
      <label>Siapa yang menang?</label>
      <select id="who-won">
        <option value="me">Saya menang</option>
        <option value="opponent">Lawan menang</option>
      </select>
      <label>Game yang didapat pihak kalah</label>
      <select id="loser-games"></select>
      <div id="f-error" class="error" style="display:none"></div>
      <button id="submit-btn" class="btn">Submit hasil</button>
    </div>
  `);
  container.appendChild(wrap);

  function refreshLoserGamesOptions() {
    const targetGames = Number(wrap.querySelector("#target-games").value);
    const loserGamesSelect = wrap.querySelector("#loser-games");
    const options = [];
    for (let n = 0; n < targetGames; n++) options.push(n);
    loserGamesSelect.innerHTML = options.map((n) => `<option value="${n}">${n}</option>`).join("");
  }
  wrap.querySelector("#target-games").addEventListener("change", refreshLoserGamesOptions);
  refreshLoserGamesOptions();

  try {
    const { players } = await api("/players");
    const select = wrap.querySelector("#opponent");
    const options = players
      .filter((p) => p.id !== state.player.id)
      .map((p) => `<option value="${p.id}">${p.name}</option>`)
      .join("");
    select.innerHTML = `<option value="" selected disabled>-- Pilih lawan --</option>${options}`;
  } catch (err) {
    wrap.querySelector("#f-error").textContent = err.message;
    wrap.querySelector("#f-error").style.display = "block";
  }

  wrap.querySelector("#submit-btn").addEventListener("click", async () => {
    const opponentValue = wrap.querySelector("#opponent").value;
    const targetGames = Number(wrap.querySelector("#target-games").value);
    const iWon = wrap.querySelector("#who-won").value === "me";
    const loserGames = Number(wrap.querySelector("#loser-games").value);
    const errorEl = wrap.querySelector("#f-error");
    errorEl.style.display = "none";

    if (!opponentValue) {
      errorEl.textContent = "Pilih lawan terlebih dahulu";
      errorEl.style.display = "block";
      return;
    }
    const opponentId = Number(opponentValue);

    const winnerId = iWon ? state.player.id : opponentId;
    const loserId = iWon ? opponentId : state.player.id;

    try {
      const data = await api("/matches", {
        method: "POST",
        body: JSON.stringify({ winnerId, loserId, loserGames, targetGames }),
      });
      alert(data.message || "Hasil match berhasil dikirim, menunggu konfirmasi lawan.");
      state.page = "leaderboard";
      render();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = "block";
    }
  });
}

async function renderSubmitDoubles(container) {
  container.appendChild(nav("submitDoubles"));
  const wrap = el(`
    <div class="card">
      <h2>Input hasil ganda</h2>
      <p class="muted">Anda otomatis jadi pemain 1 di Tim Anda.</p>
      <label style="font-size:16px;font-weight:600;color:#1a1a1a">Partner Anda (Tim Anda)</label>
      <select id="partner"></select>
      <label style="font-size:16px;font-weight:600;color:#1a1a1a">Lawan 1</label>
      <select id="opp1"></select>
      <label style="font-size:16px;font-weight:600;color:#1a1a1a">Lawan 2</label>
      <select id="opp2"></select>
      <label>Format (main sampai berapa game)</label>
      <select id="target-games">
        <option value="4">First to 4</option>
        <option value="6" selected>First to 6 (standar)</option>
      </select>
      <label>Tim mana yang menang?</label>
      <select id="who-won">
        <option value="team1">Tim saya menang</option>
        <option value="team2">Tim lawan menang</option>
      </select>
      <label>Game yang didapat tim yang kalah</label>
      <select id="loser-games"></select>
      <div id="f-error" class="error" style="display:none"></div>
      <button id="submit-btn" class="btn">Submit hasil</button>
    </div>
  `);
  container.appendChild(wrap);

  function refreshLoserGamesOptions() {
    const targetGames = Number(wrap.querySelector("#target-games").value);
    const loserGamesSelect = wrap.querySelector("#loser-games");
    const options = [];
    for (let n = 0; n < targetGames; n++) options.push(n);
    loserGamesSelect.innerHTML = options.map((n) => `<option value="${n}">${n}</option>`).join("");
  }
  wrap.querySelector("#target-games").addEventListener("change", refreshLoserGamesOptions);
  refreshLoserGamesOptions();


  try {
    const { players } = await api("/players?includeDummy=true");
    const others = players.filter((p) => p.id !== state.player.id);
    const options = others.map((p) => `<option value="${p.id}">${p.name}</option>`).join("");
    wrap.querySelector("#partner").innerHTML = `<option value="" selected disabled>-- Pilih partner --</option>${options}`;
    wrap.querySelector("#opp1").innerHTML = `<option value="" selected disabled>-- Pilih lawan 1 --</option>${options}`;
    wrap.querySelector("#opp2").innerHTML = `<option value="" selected disabled>-- Pilih lawan 2 --</option>${options}`;
  } catch (err) {
    wrap.querySelector("#f-error").textContent = err.message;
    wrap.querySelector("#f-error").style.display = "block";
  }

  wrap.querySelector("#submit-btn").addEventListener("click", async () => {
    const partnerValue = wrap.querySelector("#partner").value;
    const opp1Value = wrap.querySelector("#opp1").value;
    const opp2Value = wrap.querySelector("#opp2").value;
    const iWon = wrap.querySelector("#who-won").value === "team1";
    const loserGames = Number(wrap.querySelector("#loser-games").value);
    const targetGames = Number(wrap.querySelector("#target-games").value);
    const errorEl = wrap.querySelector("#f-error");
    errorEl.style.display = "none";

    if (!partnerValue || !opp1Value || !opp2Value) {
      errorEl.textContent = "Pilih partner dan kedua lawan terlebih dahulu";
      errorEl.style.display = "block";
      return;
    }

    const team1Player2Id = Number(partnerValue);
    const team2Player1Id = Number(opp1Value);
    const team2Player2Id = Number(opp2Value);

    const ids = [team1Player2Id, team2Player1Id, team2Player2Id];
    if (new Set(ids).size !== 3) {
      errorEl.textContent = "Partner dan kedua lawan harus berbeda orang";
      errorEl.style.display = "block";
      return;
    }

    try {
      const data = await api("/doubles/matches", {
        method: "POST",
        body: JSON.stringify({
          team1Player2Id, team2Player1Id, team2Player2Id,
          winningTeam: iWon ? 1 : 2,
          loserGames,
          targetGames,
        }),
      });
      alert(data.message || "Hasil match ganda dikirim, menunggu konfirmasi salah satu pemain tim lawan.");
      state.page = "leaderboard";
      render();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = "block";
    }
  });
}
async function renderConfirm(container) {
  container.appendChild(nav("confirm"));
  const wrap = el(`<div class="card"><h2>Menunggu konfirmasi (Single)</h2><div id="pending-list">Memuat...</div></div>`);
  container.appendChild(wrap);

  try {
    const { pending } = await api("/players/me/pending-confirmations");
    const list = wrap.querySelector("#pending-list");
    if (pending.length === 0) {
      list.innerHTML = `<p class="muted">Tidak ada match single yang menunggu konfirmasi Anda.</p>`;
    } else {
    list.innerHTML = "";
    pending.forEach((m) => {
      const item = el(`
        <div class="row" style="flex-direction:column; align-items:stretch; gap:6px;">
          <div>vs <strong>${m.opponent}</strong> — skor ${m.score} (Anda ${m.result})</div>
          <div style="display:flex; gap:8px;">
            <button class="btn" style="margin-top:0" data-action="confirm" data-id="${m.matchId}">Konfirmasi</button>
            <button class="btn danger" style="margin-top:0" data-action="reject" data-id="${m.matchId}">Tolak</button>
          </div>
        </div>
      `);
      item.querySelector('[data-action="confirm"]').addEventListener("click", async () => {
        try {
          await api(`/matches/${m.matchId}/confirm`, { method: "POST" });
          render();
        } catch (err) {
          alert(err.message);
        }
      });
      item.querySelector('[data-action="reject"]').addEventListener("click", async () => {
        const reason = prompt("Alasan penolakan:");
        if (!reason) return;
        try {
          await api(`/matches/${m.matchId}/reject`, { method: "POST", body: JSON.stringify({ reason }) });
          render();
        } catch (err) {
          alert(err.message);
        }
      });
      list.appendChild(item);
    });
    }
  } catch (err) {
    wrap.querySelector("#pending-list").innerHTML = `<p class="error">${err.message}</p>`;
  }

  const dWrap = el(`<div class="card"><h2>Menunggu konfirmasi (Ganda)</h2><div id="pending-list-d">Memuat...</div></div>`);
  container.appendChild(dWrap);
  try {
    const { pending } = await api("/doubles/matches/pending-for-me");
    const list = dWrap.querySelector("#pending-list-d");
    if (pending.length === 0) {
      list.innerHTML = `<p class="muted">Tidak ada match ganda yang menunggu konfirmasi Anda.</p>`;
      return;
    }
    list.innerHTML = "";
    pending.forEach((m) => {
      const item = el(`
        <div class="row" style="flex-direction:column; align-items:stretch; gap:6px;">
          <div>Anda & <strong>${m.partner}</strong> vs <strong>${m.opponents.join(" & ")}</strong> — skor ${m.score} (Tim Anda ${m.result})</div>
          <div style="display:flex; gap:8px;">
            <button class="btn" style="margin-top:0" data-action="confirm" data-id="${m.matchId}">Konfirmasi</button>
            <button class="btn danger" style="margin-top:0" data-action="reject" data-id="${m.matchId}">Tolak</button>
          </div>
        </div>
      `);
      item.querySelector('[data-action="confirm"]').addEventListener("click", async () => {
        try {
          await api(`/doubles/matches/${m.matchId}/confirm`, { method: "POST" });
          render();
        } catch (err) {
          alert(err.message);
        }
      });
      item.querySelector('[data-action="reject"]').addEventListener("click", async () => {
        const reason = prompt("Alasan penolakan:");
        if (!reason) return;
        try {
          await api(`/doubles/matches/${m.matchId}/reject`, { method: "POST", body: JSON.stringify({ reason }) });
          render();
        } catch (err) {
          alert(err.message);
        }
      });
      list.appendChild(item);
    });
  } catch (err) {
    dWrap.querySelector("#pending-list-d").innerHTML = `<p class="error">${err.message}</p>`;
  }
}

async function renderAdmin(container) {
  container.appendChild(nav("admin"));

  const seasonWrap = el(`
    <div class="card">
      <h2>Kelola Season</h2>
      <p id="current-season-info" class="muted" style="font-size:13px">Memuat...</p>
      <label>Nama season baru (opsional, kosongkan untuk default)</label>
      <input id="new-season-name" type="text" placeholder="misal: Season 2027" />
      <div id="season-error" class="error" style="display:none"></div>
      <button id="end-season-btn" class="btn danger">Akhiri Season & Mulai Season Baru</button>
    </div>
  `);
  container.appendChild(seasonWrap);
  try {
    const { seasons } = await api("/seasons");
    const active = seasons.find((s) => s.isActive);
    seasonWrap.querySelector("#current-season-info").textContent = active
      ? `Season aktif sekarang: "${active.name}" (mulai ${new Date(active.startedAt).toLocaleDateString("id-ID")})`
      : "Belum ada season aktif";
  } catch (err) {
    seasonWrap.querySelector("#current-season-info").textContent = "Gagal memuat info season";
  }
  seasonWrap.querySelector("#end-season-btn").addEventListener("click", async () => {
    if (!confirm("Yakin akhiri season sekarang? Semua rating akan direset ke 1500 dan season ini diarsipkan permanen. Tindakan ini TIDAK BISA dibatalkan.")) return;
    const newSeasonName = seasonWrap.querySelector("#new-season-name").value.trim();
    const errorEl = seasonWrap.querySelector("#season-error");
    errorEl.style.display = "none";
    try {
      const data = await api("/admin/end-season", { method: "POST", body: JSON.stringify({ newSeasonName: newSeasonName || undefined }) });
      alert(data.message);
      render();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = "block";
    }
  });

  const tournamentCreateWrap = el(`
    <div class="card">
      <h2>Buat Turnamen</h2>
      <label>Nama turnamen</label>
      <input id="tourney-name" type="text" placeholder="misal: Turnamen Agustusan 2026" />
      <div id="tourney-type-section">
        <label>Tipe</label>
        <select id="tourney-type">
          <option value="singles">Single</option>
          <option value="doubles">Ganda</option>
        </select>
      </div>
      <label>Format</label>
      <select id="tourney-format">
        <option value="round_robin">Round Robin (semua lawan semua)</option>
        <option value="bracket">Bracket/Eliminasi</option>
        <option value="group_knockout">Setengah Kompetisi (Fase Grup + Knockout)</option>
        <option value="cappuccino">Sistem Cappuccino (partner ganti-ganti tiap ronde)</option>
        <option value="cappuccino_external">Sistem Cappuccino External (boleh peserta tamu, TIDAK pengaruhi rating)</option>
      </select>
      <div id="tourney-groups-section" style="display:none">
        <label>Jumlah grup</label>
        <input id="tourney-num-groups" type="number" min="2" value="2" />
      </div>
      <div id="tourney-courts-section" style="display:none">
        <label>Jumlah lapangan tersedia</label>
        <select id="tourney-num-courts">
          <option value="1">1 Lapangan</option>
          <option value="2" selected>2 Lapangan</option>
        </select>
        <label style="margin-top:0.5rem">Format (main sampai berapa game)</label>
        <select id="tourney-target-games">
          <option value="4">First to 4</option>
          <option value="6" selected>First to 6 (standar)</option>
        </select>
        <label style="margin-top:0.5rem">Berapa kali main (ganti pasangan)</label>
        <select id="tourney-rounds-mode">
          <option value="auto">Otomatis (jamin semua main sama rata -- bisa banyak kali)</option>
          <option value="manual" selected>Tentukan sendiri</option>
        </select>
        <div id="tourney-manual-rounds-wrap">
          <label style="font-size:12px">Target main tiap peserta</label>
          <input id="tourney-target-plays" type="number" min="1" max="30" value="4" />
          <label style="font-size:12px;display:flex;align-items:center;gap:6px;margin-top:0.4rem;font-weight:normal">
            <input id="tourney-fair-mix" type="checkbox" style="width:auto" />
            Rata Sempurna (semua peserta dijamin PERSIS segini kali main, pakai Golden Round kalau perlu)
          </label>
          <p class="muted" style="font-size:12px;margin-top:-0.5rem" id="tourney-rounds-estimate">Tambah peserta dulu buat lihat perkiraan.</p>
        </div>
        <p class="muted" style="font-size:12px;margin-top:-0.5rem">Tidak perlu main bersamaan real-time — ini cuma menentukan berapa match yang dijadwalkan.</p>
        <label style="font-size:12px">Estimasi menit per match (buat perkiraan total durasi)</label>
        <input id="tourney-minutes-per-match" type="number" min="1" max="120" value="15" />
        <p class="muted" style="font-size:11px;margin-top:-0.5rem" id="tourney-minutes-hint">Rata-rata format 4 game (tanpa deuce) ≈15 menit, format 6 game ≈25 menit -- sesuaikan dengan kecepatan main klub Anda.</p>
        <button id="tourney-simulate-btn" type="button" class="btn secondary" style="margin-top:0.5rem">🔍 Simulasikan Dulu</button>
        <div id="tourney-simulate-result" style="display:none;margin-top:0.5rem;background:#f7f7f5;border-radius:8px;padding:10px;font-size:13px"></div>
      </div>
      <label style="margin-top:0.5rem">Susun peserta (urutan = posisi/seed, bisa diatur naik-turun)</label>
      <p class="muted" style="font-size:12px;margin-top:-0.5rem" id="tourney-participant-hint">Untuk Bracket/Setengah Kompetisi, urutan ini menentukan posisi peserta di bagan.</p>
      <div id="tourney-participant-rows"></div>
      <button id="tourney-shuffle-btn" class="btn secondary" style="display:none;margin-top:0.5rem">🔀 Acak Urutan</button>
      <select id="tourney-add-picker" style="margin-top:0.5rem"></select>
      <select id="tourney-add-picker2" style="display:none;margin-top:0.5rem"></select>
      <button id="tourney-add-participant-btn" class="btn secondary" style="margin-top:0.5rem">+ Tambah Peserta</button>
      <div id="tourney-guest-section" style="display:none;margin-top:0.5rem">
        <p class="muted" style="font-size:12px;margin-bottom:0.25rem">Atau tambah peserta tamu (nama manual, tidak terdaftar di aplikasi, hasilnya tidak pengaruh ke rating siapapun):</p>
        <input id="tourney-guest-name" type="text" placeholder="Nama tamu" />
        <button id="tourney-add-guest-btn" class="btn secondary" style="margin-top:0.5rem">+ Tambah Peserta Tamu</button>
      </div>
      <div id="tourney-error" class="error" style="display:none;margin-top:0.75rem"></div>
      <button id="tourney-create-btn" class="btn">Buat Turnamen</button>
    </div>
  `);
  container.appendChild(tournamentCreateWrap);

  let allPlayersForTourney = [];
  try {
    const { players } = await api("/players");
    allPlayersForTourney = players;
  } catch (err) {
    tournamentCreateWrap.querySelector("#tourney-error").textContent = err.message;
    tournamentCreateWrap.querySelector("#tourney-error").style.display = "block";
  }

  function playerOptionsHtml() {
    return `<option value="" selected disabled>-- Pilih pemain --</option>` +
      allPlayersForTourney.map((p) => `<option value="${p.id}">${p.name}</option>`).join("");
  }
  tournamentCreateWrap.querySelector("#tourney-add-picker").innerHTML = playerOptionsHtml();
  tournamentCreateWrap.querySelector("#tourney-add-picker2").innerHTML = playerOptionsHtml();

  // participantEntries: array of { p1Id, p1Name, p2Id, p2Name, isGuest } -- p2 null untuk
  // Single/Cappuccino; isGuest=true kalau nama tamu manual (p1Id null), khusus Cappuccino External.
  let participantEntries = [];

  function renderParticipantRows() {
    const rowsWrap = tournamentCreateWrap.querySelector("#tourney-participant-rows");
    rowsWrap.innerHTML = "";
    participantEntries.forEach((entry, idx) => {
      const guestBadge = entry.isGuest ? `<span style="font-size:10px;background:#f3e5f5;color:#6a1b9a;padding:2px 6px;border-radius:6px;font-weight:600;margin-right:4px">TAMU</span>` : "";
      const label = entry.p2Name ? `${entry.p1Name}/${entry.p2Name}` : entry.p1Name;
      const row = el(`
        <div class="row" style="gap:8px;align-items:center;padding:6px 0">
          <span style="width:22px;color:#999;font-size:12px">#${idx + 1}</span>
          <span style="flex:1">${guestBadge}${label}</span>
          <button type="button" class="btn secondary move-up-btn" style="margin-top:0;width:auto;padding:4px 8px" ${idx === 0 ? "disabled" : ""}>↑</button>
          <button type="button" class="btn secondary move-down-btn" style="margin-top:0;width:auto;padding:4px 8px" ${idx === participantEntries.length - 1 ? "disabled" : ""}>↓</button>
          <button type="button" class="btn danger remove-btn" style="margin-top:0;width:auto;padding:4px 8px">✕</button>
        </div>
      `);
      row.querySelector(".move-up-btn").addEventListener("click", () => {
        if (idx === 0) return;
        [participantEntries[idx - 1], participantEntries[idx]] = [participantEntries[idx], participantEntries[idx - 1]];
        renderParticipantRows();
      });
      row.querySelector(".move-down-btn").addEventListener("click", () => {
        if (idx === participantEntries.length - 1) return;
        [participantEntries[idx + 1], participantEntries[idx]] = [participantEntries[idx], participantEntries[idx + 1]];
        renderParticipantRows();
      });
      row.querySelector(".remove-btn").addEventListener("click", () => {
        participantEntries.splice(idx, 1);
        renderParticipantRows();
      });
      rowsWrap.appendChild(row);
    });
    updateRoundsEstimate();
  }

  function isCappuccino() {
    const f = tournamentCreateWrap.querySelector("#tourney-format").value;
    return f === "cappuccino" || f === "cappuccino_external";
  }
  function isCappuccinoExternal() {
    return tournamentCreateWrap.querySelector("#tourney-format").value === "cappuccino_external";
  }

  // Format menit jadi "X jam Y menit" biar gampang dibaca
  function formatDuration(totalMinutes) {
    const h = Math.floor(totalMinutes / 60);
    const m = Math.round(totalMinutes % 60);
    if (h === 0) return `${m} menit`;
    if (m === 0) return `${h} jam`;
    return `${h} jam ${m} menit`;
  }

  // Default menit per match berdasarkan format game -- referensi FAST4 Tennis (Tennis Australia):
  // format 4 game tanpa deuce rata-rata ~15 menit, format 6 game tanpa deuce ~25 menit.
  // Ini cuma perkiraan awal, admin bisa sesuaikan sendiri dengan kecepatan main klubnya.
  tournamentCreateWrap.querySelector("#tourney-target-games").addEventListener("change", (e) => {
    tournamentCreateWrap.querySelector("#tourney-minutes-per-match").value = e.target.value === "4" ? 15 : 25;
    tournamentCreateWrap.querySelector("#tourney-simulate-result").style.display = "none";
  });

  // Perkiraan berapa kali tiap peserta main, berdasarkan jumlah peserta, lapangan,
  // dan jumlah ronde yang dipilih -- cuma informasi buat bantu admin, bukan patokan pasti
  // (jumlah pastinya bisa beda 1 kali antar peserta tergantung rotasi istirahat).
  // Konversi "target main per peserta" -> jumlah ronde yang dibutuhkan, lalu tampilkan
  // perkiraan hasil akhirnya (min-max kali main, karena kalau jumlah peserta tidak pas
  // kelipatan lapangan, bisa selisih 1x antar peserta -- sudah disimulasikan, ini wajar).
  function computeRoundsFromTarget(n, numCourts, target) {
    let active = Math.min(n, numCourts * 4);
    active = active - (active % 4);
    if (active <= 0) return 1;
    return Math.max(1, Math.round((target * n) / active));
  }

  // Hitung perkiraan (matematis, tanpa simulasi jadwal penuh) untuk mode "Rata Sempurna":
  // berapa ronde penuh + apakah perlu ronde tambahan "Golden Round", dan berapa peserta yang
  // bakal jadi "pengisi" (sudah capai target, dipanggil lagi biar formatnya tetap ganda normal).
  function estimateFairGolden(n, maxCourts, target) {
    let active = Math.min(n, maxCourts * 4);
    active = active - (active % 4);
    if (active <= 0) return null;
    const totalSlotsNeeded = n * target;
    const fullRounds = Math.floor(totalSlotsNeeded / active);
    const leftoverCount = totalSlotsNeeded - fullRounds * active;
    let extraRounds = 0;
    let fillerCount = 0;
    if (leftoverCount > 0) {
      extraRounds = 1;
      let pool = leftoverCount;
      if (pool % 2 !== 0) { pool += 1; fillerCount += 1; }
      const teams = pool / 2;
      if (teams % 2 !== 0) fillerCount += 2;
    }
    return { fullRounds, extraRounds, totalRounds: fullRounds + extraRounds, leftoverCount, fillerCount };
  }

  function updateRoundsEstimate() {
    const estimateEl = tournamentCreateWrap.querySelector("#tourney-rounds-estimate");
    if (!estimateEl) return;
    const n = participantEntries.length;
    if (n < 4) {
      estimateEl.textContent = "Tambah peserta dulu buat lihat perkiraan.";
      return;
    }
    const numCourts = Number(tournamentCreateWrap.querySelector("#tourney-num-courts").value) || 1;
    const target = Number(tournamentCreateWrap.querySelector("#tourney-target-plays").value) || 0;
    const fairMix = tournamentCreateWrap.querySelector("#tourney-fair-mix").checked;

    if (fairMix) {
      const info = estimateFairGolden(n, numCourts, target);
      const goldenNote = info.fillerCount > 0
        ? ` (ronde terakhir jadi <strong>Golden Round</strong>: ${info.fillerCount} peserta yang sudah capai target dipanggil lagi cuma buat lengkapi format ganda -- poin mereka di ronde itu TIDAK dihitung ke turnamen, tapi rating umum tetap update normal)`
        : "";
      estimateEl.innerHTML = `-> akan jadi ${info.totalRounds}x ganti pasangan${info.extraRounds > 0 ? ` (${info.fullRounds} ronde penuh + 1 Golden Round)` : ""}, hasil akhirnya <strong>tepat ${target}x</strong> semua peserta main dihitung ke turnamen${goldenNote}`;
      return;
    }

    let active = Math.min(n, numCourts * 4);
    active = active - (active % 4);
    const numRounds = computeRoundsFromTarget(n, numCourts, target);
    const sitOutPerRound = n - active;
    // Perkiraan sebaran: total sit-out selama numRounds ronde didistribusikan serata
    // mungkin ke semua peserta -> beda paling banter 1x main antar peserta.
    const totalSitOuts = sitOutPerRound * numRounds;
    const minSitOut = Math.floor(totalSitOuts / n);
    const maxSitOut = Math.ceil(totalSitOuts / n);
    const maxPlays = numRounds - minSitOut;
    const minPlays = numRounds - maxSitOut;
    const rangeText = minPlays === maxPlays ? `tepat ${minPlays}x` : `${minPlays}-${maxPlays}x`;
    estimateEl.textContent = `-> akan jadi ${numRounds}x ganti pasangan, hasil akhirnya tiap peserta main ${rangeText} (dari ${n} peserta, ${numCourts} lapangan)`;
  }

  tournamentCreateWrap.querySelector("#tourney-fair-mix").addEventListener("change", () => {
    updateRoundsEstimate();
    tournamentCreateWrap.querySelector("#tourney-simulate-result").style.display = "none";
  });

  function toggleRoundsMode() {
    const mode = tournamentCreateWrap.querySelector("#tourney-rounds-mode").value;
    tournamentCreateWrap.querySelector("#tourney-manual-rounds-wrap").style.display = mode === "manual" ? "block" : "none";
  }
  tournamentCreateWrap.querySelector("#tourney-rounds-mode").addEventListener("change", toggleRoundsMode);
  tournamentCreateWrap.querySelector("#tourney-target-plays").addEventListener("input", () => {
    updateRoundsEstimate();
    tournamentCreateWrap.querySelector("#tourney-simulate-result").style.display = "none";
  });
  tournamentCreateWrap.querySelector("#tourney-num-courts").addEventListener("change", () => {
    updateRoundsEstimate();
    tournamentCreateWrap.querySelector("#tourney-simulate-result").style.display = "none";
  });
  toggleRoundsMode();

  // --- Simulasi jadwal Cappuccino di sisi client, PERSIS meniru algoritma backend
  // (src/routes/tournaments.js: gcd/pairUpRound/generateCappuccinoSchedule/computeIdealRounds)
  // supaya admin bisa cek dulu berapa ronde/match yang bakal kejadi SEBELUM benar-benar
  // membuat turnamennya -- terutama buat nangkep kasus kayak "1 lapangan" yang bisa bikin
  // rondenya membengkak jauh dari perkiraan.
  function simGcd(a, b) { return b === 0 ? a : simGcd(b, a % b); }
  function simShuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  function simComputeIdealRounds(n, numCourts) {
    let active = Math.min(n, numCourts * 4);
    active = active - (active % 4);
    const sitOutPerRound = n - active;
    if (sitOutPerRound === 0) return Math.max(4, Math.ceil(n / 2));
    const g = simGcd(n, sitOutPerRound);
    let rounds = n / g;
    while (rounds < 5) rounds += n / g;
    while (rounds > 12) rounds -= n / g;
    return rounds;
  }
  function simPairTeamsIntoMatches(teamsList, opponentCount, key) {
    const crossCost = (t1, t2) => (
      opponentCount[key(t1[0], t2[0])] + opponentCount[key(t1[0], t2[1])]
      + opponentCount[key(t1[1], t2[0])] + opponentCount[key(t1[1], t2[1])]
    );
    let best = null, bestCost = Infinity;
    for (let attempt = 0; attempt < 25; attempt++) {
      const remaining = simShuffle(teamsList);
      const matches = [];
      let cost = 0;
      while (remaining.length > 1) {
        const t1 = remaining.shift();
        let bestIdx = 0, bIdxCost = Infinity;
        remaining.forEach((t2, idx) => {
          const c = crossCost(t1, t2);
          if (c < bIdxCost) { bIdxCost = c; bestIdx = idx; }
        });
        const t2 = remaining.splice(bestIdx, 1)[0];
        cost += bIdxCost;
        matches.push([t1, t2]);
      }
      if (cost < bestCost) { bestCost = cost; best = matches; }
      if (bestCost === 0) break;
    }
    return { matches: best, cost: bestCost };
  }
  function simBuildRoundMatches(playersInRound, partnerCount, opponentCount, key) {
    let best = null, bestScore = Infinity;
    for (let attempt = 0; attempt < 60; attempt++) {
      const remaining = simShuffle(playersInRound);
      const teams = [];
      let partnerRepeats = 0;
      while (remaining.length > 0) {
        const a = remaining.shift();
        let bestIdx = 0, bestCount = Infinity;
        remaining.forEach((b, idx) => {
          const c = partnerCount[key(a, b)];
          if (c < bestCount) { bestCount = c; bestIdx = idx; }
        });
        const b = remaining.splice(bestIdx, 1)[0];
        if (partnerCount[key(a, b)] > 0) partnerRepeats++;
        teams.push([a, b]);
      }
      const { matches, cost } = simPairTeamsIntoMatches(teams, opponentCount, key);
      const score = partnerRepeats * 1000 + cost;
      if (score < bestScore) { bestScore = score; best = { teams, matches, score }; }
      if (bestScore === 0) break;
    }
    return best;
  }
  function simGenerateSchedule(participantIds, courtsPerRound) {
    const n = participantIds.length;
    const sitOutCount = Object.fromEntries(participantIds.map((p) => [p, 0]));
    const partnerCount = {};
    const opponentCount = {};
    const key = (a, b) => [a, b].sort((x, y) => x - y).join("-");
    participantIds.forEach((a) => participantIds.forEach((b) => { if (a < b) { partnerCount[key(a, b)] = 0; opponentCount[key(a, b)] = 0; } }));
    const schedule = [];
    courtsPerRound.forEach((courts, idx) => {
      let active = Math.min(n, courts * 4);
      active = active - (active % 4);
      const sitOutNeeded = n - active;
      const sorted = simShuffle(participantIds).sort((a, b) => sitOutCount[a] - sitOutCount[b]);
      const sittingOut = sorted.slice(0, sitOutNeeded);
      const playing = participantIds.filter((p) => !sittingOut.includes(p));
      sittingOut.forEach((p) => sitOutCount[p]++);
      const { teams, matches: teamMatches } = simBuildRoundMatches(playing, partnerCount, opponentCount, key);
      teams.forEach(([a, b]) => { partnerCount[key(a, b)]++; });
      const matches = [];
      teamMatches.forEach(([t1, t2]) => {
        opponentCount[key(t1[0], t2[0])]++; opponentCount[key(t1[0], t2[1])]++;
        opponentCount[key(t1[1], t2[0])]++; opponentCount[key(t1[1], t2[1])]++;
        matches.push([t1, t2]);
      });
      schedule.push({ round: idx + 1, matches, sittingOut });
    });
    return { schedule };
  }

  // Simulasi mode "Rata Sempurna" (meniru generateCappuccinoScheduleFair backend persis):
  // ronde penuh dulu sebanyak mungkin, sisanya (kalau ada) ditutup pakai Golden Round.
  function simGenerateScheduleFair(participantIds, maxCourts, target) {
    const n = participantIds.length;
    let active = Math.min(n, maxCourts * 4);
    active = active - (active % 4);
    const totalSlotsNeeded = n * target;
    const fullRounds = Math.floor(totalSlotsNeeded / active);

    const sitOutCount = Object.fromEntries(participantIds.map((p) => [p, 0]));
    const partnerCount = {};
    const opponentCount = {};
    const key = (a, b) => [a, b].sort((x, y) => x - y).join("-");
    participantIds.forEach((a) => participantIds.forEach((b) => { if (a < b) { partnerCount[key(a, b)] = 0; opponentCount[key(a, b)] = 0; } }));
    const playCount = Object.fromEntries(participantIds.map((p) => [p, 0]));
    const schedule = [];

    const commitMatches = (teamMatches, roundNum, goldenSet) => {
      const matches = teamMatches.map(([t1, t2]) => {
        opponentCount[key(t1[0], t2[0])]++; opponentCount[key(t1[0], t2[1])]++;
        opponentCount[key(t1[1], t2[0])]++; opponentCount[key(t1[1], t2[1])]++;
        [t1[0], t1[1], t2[0], t2[1]].forEach((p) => playCount[p]++);
        return {
          t1, t2,
          golden1: goldenSet ? goldenSet.has(t1[0]) : false,
          golden1b: goldenSet ? goldenSet.has(t1[1]) : false,
          golden2: goldenSet ? goldenSet.has(t2[0]) : false,
          golden2b: goldenSet ? goldenSet.has(t2[1]) : false,
        };
      });
      schedule.push({ round: roundNum, matches });
    };

    for (let r = 1; r <= fullRounds; r++) {
      const sitOutNeeded = n - active;
      const sorted = simShuffle(participantIds).sort((a, b) => sitOutCount[a] - sitOutCount[b]);
      const sittingOut = sorted.slice(0, sitOutNeeded);
      const playing = participantIds.filter((p) => !sittingOut.includes(p));
      sittingOut.forEach((p) => sitOutCount[p]++);
      const { teams, matches: teamMatches } = simBuildRoundMatches(playing, partnerCount, opponentCount, key);
      teams.forEach(([a, b]) => { partnerCount[key(a, b)]++; });
      commitMatches(teamMatches, r, null);
    }

    let leftover = participantIds.filter((p) => playCount[p] < target);
    let roundNum = fullRounds;
    while (leftover.length > 0) {
      roundNum++;
      const neededTotal = Math.ceil(leftover.length / 4) * 4;
      const fillersNeeded = Math.max(0, neededTotal - leftover.length);
      const satisfiedPool = participantIds.filter((p) => playCount[p] >= target && !leftover.includes(p));

      // Sama seperti backend: tidak dipatok siapa pasangan/lawan siapa -- dicoba beberapa
      // kombinasi pengisi, dipilih yang paling sedikit mengulang partner/lawan.
      let bestPool = null, bestResult = null, bestScore = Infinity;
      const attempts = fillersNeeded > 0 ? 30 : 1;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const fillers = fillersNeeded > 0 ? simShuffle(satisfiedPool).slice(0, fillersNeeded) : [];
        if (fillers.length < fillersNeeded) break;
        const trialPool = [...leftover, ...fillers];
        const result = simBuildRoundMatches(trialPool, partnerCount, opponentCount, key);
        if (result.score < bestScore) { bestScore = result.score; bestPool = trialPool; bestResult = result; }
        if (bestScore === 0) break;
      }
      const pool = bestPool || leftover;
      const { teams } = bestResult || simBuildRoundMatches(pool, partnerCount, opponentCount, key);
      teams.forEach(([a, b]) => { partnerCount[key(a, b)]++; });
      const goldenSet = new Set(pool.filter((p) => !leftover.includes(p)));

      let teamsPool = [...teams];
      if (teamsPool.length % 2 !== 0) {
        const satisfied2 = simShuffle(participantIds.filter((p) => playCount[p] >= target && !pool.includes(p)));
        const fillerTeam = [satisfied2[0], satisfied2[1]];
        teamsPool.push(fillerTeam);
        goldenSet.add(fillerTeam[0]); goldenSet.add(fillerTeam[1]);
      }
      const { matches: teamMatches } = simPairTeamsIntoMatches(teamsPool, opponentCount, key);
      commitMatches(teamMatches, roundNum, goldenSet);
      leftover = participantIds.filter((p) => playCount[p] < target);
    }
    return { schedule };
  }

  tournamentCreateWrap.querySelector("#tourney-simulate-btn").addEventListener("click", () => {
    const resultEl = tournamentCreateWrap.querySelector("#tourney-simulate-result");
    const n = participantEntries.length;
    if (n < 4) {
      resultEl.style.display = "block";
      resultEl.innerHTML = `<span class="muted">Tambah peserta dulu (minimal 4) buat bisa disimulasikan.</span>`;
      return;
    }
    const numCourts = Number(tournamentCreateWrap.querySelector("#tourney-num-courts").value) || 1;
    const roundsMode = tournamentCreateWrap.querySelector("#tourney-rounds-mode").value;
    const targetPlays = Number(tournamentCreateWrap.querySelector("#tourney-target-plays").value);
    const fairMix = tournamentCreateWrap.querySelector("#tourney-fair-mix").checked;
    const minutesPerMatch = Number(tournamentCreateWrap.querySelector("#tourney-minutes-per-match").value) || 15;
    const ids = participantEntries.map((_, i) => i + 1);
    const names = Object.fromEntries(participantEntries.map((e, i) => [i + 1, e.p1Name]));

    if (roundsMode === "manual" && fairMix) {
      const { schedule } = simGenerateScheduleFair(ids, numCourts, targetPlays);
      const playCount = Object.fromEntries(ids.map((p) => [p, 0]));
      const tournamentPlayCount = Object.fromEntries(ids.map((p) => [p, 0]));
      let totalMatches = 0;
      const roundLines = [];
      schedule.forEach(({ round, matches }) => {
        totalMatches += matches.length;
        const isGoldenRound = matches.some((m) => m.golden1 || m.golden1b || m.golden2 || m.golden2b);
        matches.forEach((m) => {
          const gTag = (p, g) => g ? `${names[p]}<span class="muted" style="font-size:10px">(pengisi)</span>` : names[p];
          [[m.t1[0], m.golden1], [m.t1[1], m.golden1b], [m.t2[0], m.golden2], [m.t2[1], m.golden2b]].forEach(([p, golden]) => {
            playCount[p]++;
            if (!golden) tournamentPlayCount[p]++;
          });
          roundLines.push(`<div style="margin:2px 0">R${round}${isGoldenRound ? " 🏅" : ""}: ${gTag(m.t1[0], m.golden1)}/${gTag(m.t1[1], m.golden1b)} vs ${gTag(m.t2[0], m.golden2)}/${gTag(m.t2[1], m.golden2b)}</div>`);
        });
      });
      const tCounts = Object.values(tournamentPlayCount);
      const minT = Math.min(...tCounts), maxT = Math.max(...tCounts);
      const perPlayerRows = ids
        .map((p) => `<span style="display:inline-block;margin:2px 8px 2px 0">${names[p]}: <strong>${tournamentPlayCount[p]}x</strong>${playCount[p] > tournamentPlayCount[p] ? ` <span class="muted" style="font-size:10px">(+${playCount[p] - tournamentPlayCount[p]} golden)</span>` : ""}</span>`)
        .join("");
      // Durasi: tiap ronde matches-nya jalan BARENGAN (paralel per lapangan), jadi total durasi
      // = jumlah RONDE x menit per match, bukan dikali jumlah match (match dalam 1 ronde tidak
      // menambah waktu kalau lapangannya cukup, cuma nambah kalau 1 lapangan gantian).
      const totalDuration = schedule.length * minutesPerMatch;

      resultEl.style.display = "block";
      resultEl.innerHTML = `
        <div style="margin-bottom:6px"><strong>${schedule.length} ronde</strong>, total <strong>${totalMatches} match</strong> — poin turnamen: ${minT === maxT ? `tepat ${minT}x` : `${minT}-${maxT}x`} semua peserta.</div>
        <div style="margin-bottom:6px">⏱️ Perkiraan total durasi: <strong>${formatDuration(totalDuration)}</strong> <span class="muted" style="font-size:11px">(${schedule.length} ronde &times; ${minutesPerMatch} menit/match, dengan asumsi tiap ronde lapangan-lapangannya jalan bareng)</span></div>
        <div style="margin-bottom:6px">Detail per peserta:<br/>${perPlayerRows}</div>
        <div style="margin-bottom:6px;font-size:12px;max-height:160px;overflow-y:auto;border-top:1px solid #e5e5e0;padding-top:4px">${roundLines.join("")}</div>
        <p class="muted" style="font-size:11px;margin:0">🏅 = Golden Round -- pasangan/lawan yang ditandai "(pengisi)" sudah capai target, poinnya di match itu tidak dihitung ke turnamen (tapi rating umum tetap update). Kombinasi pasangan sebenarnya nanti bisa beda, tapi jumlah ronde &amp; hasil akhirnya akan sama.</p>
      `;
      return;
    }

    const numRounds = roundsMode === "manual" && Number.isInteger(targetPlays) && targetPlays > 0
      ? computeRoundsFromTarget(n, numCourts, targetPlays)
      : simComputeIdealRounds(n, numCourts);
    const courtsPerRound = Array(numRounds).fill(numCourts);
    const { schedule } = simGenerateSchedule(ids, courtsPerRound);

    const playCount = Object.fromEntries(ids.map((p) => [p, 0]));
    let totalMatches = 0;
    schedule.forEach(({ matches }) => {
      totalMatches += matches.length;
      matches.forEach(([team1, team2]) => {
        [...team1, ...team2].forEach((p) => playCount[p]++);
      });
    });
    const counts = Object.values(playCount);
    const minPlay = Math.min(...counts), maxPlay = Math.max(...counts);
    const playRangeText = minPlay === maxPlay ? `tepat ${minPlay}x` : `${minPlay}-${maxPlay}x`;

    const perPlayerRows = ids
      .map((p) => `<span style="display:inline-block;margin:2px 8px 2px 0">${names[p]}: <strong>${playCount[p]}x</strong></span>`)
      .join("");

    const totalDuration = courtsPerRound.length * minutesPerMatch;

    resultEl.style.display = "block";
    const courtsSummary = courtsPerRound.join(", ");
    resultEl.innerHTML = `
      <div style="margin-bottom:6px"><strong>${courtsPerRound.length} ronde</strong>, total <strong>${totalMatches} match</strong> — tiap peserta main ${playRangeText}.</div>
      <div style="margin-bottom:6px">⏱️ Perkiraan total durasi: <strong>${formatDuration(totalDuration)}</strong> <span class="muted" style="font-size:11px">(${courtsPerRound.length} ronde &times; ${minutesPerMatch} menit/match)</span></div>
      <div style="margin-bottom:6px;font-size:12px" class="muted">Susunan lapangan per ronde: ${courtsSummary}</div>
      <div style="margin-bottom:6px">Detail per peserta:<br/>${perPlayerRows}</div>
      <p class="muted" style="font-size:11px;margin:0">Catatan: ini simulasi pasangan/jadwal acak -- pasangan sebenarnya nanti (pas turnamen benar-benar dibuat) bisa beda kombinasi, tapi jumlah ronde &amp; sebaran main per orang akan sama.</p>
    `;
  });

  function toggleTourneyTypeSection() {
    const cappuccino = isCappuccino();
    const type = tournamentCreateWrap.querySelector("#tourney-type").value;
    tournamentCreateWrap.querySelector("#tourney-type-section").style.display = cappuccino ? "none" : "block";
    tournamentCreateWrap.querySelector("#tourney-add-picker2").style.display = (!cappuccino && type === "doubles") ? "inline-block" : "none";
    tournamentCreateWrap.querySelector("#tourney-shuffle-btn").style.display = cappuccino ? "inline-block" : "none";
    tournamentCreateWrap.querySelector("#tourney-guest-section").style.display = isCappuccinoExternal() ? "block" : "none";
  }
  tournamentCreateWrap.querySelector("#tourney-type").addEventListener("change", toggleTourneyTypeSection);

  tournamentCreateWrap.querySelector("#tourney-format").addEventListener("change", (e) => {
    tournamentCreateWrap.querySelector("#tourney-groups-section").style.display = e.target.value === "group_knockout" ? "block" : "none";
    tournamentCreateWrap.querySelector("#tourney-courts-section").style.display = isCappuccino() ? "block" : "none";
    tournamentCreateWrap.querySelector("#tourney-participant-hint").textContent = isCappuccino()
      ? "Untuk Sistem Cappuccino, ini cuma daftar peserta -- partner akan diacak otomatis tiap ronde, urutan tidak terlalu penting (bisa dipakai tombol Acak Urutan)."
      : "Untuk Bracket/Setengah Kompetisi, urutan ini menentukan posisi peserta di bagan.";
    toggleTourneyTypeSection();
    updateRoundsEstimate();
  });

  tournamentCreateWrap.querySelector("#tourney-add-guest-btn").addEventListener("click", () => {
    const errorEl = tournamentCreateWrap.querySelector("#tourney-error");
    errorEl.style.display = "none";
    const nameInput = tournamentCreateWrap.querySelector("#tourney-guest-name");
    const guestName = nameInput.value.trim();
    if (!guestName) {
      errorEl.textContent = "Nama tamu tidak boleh kosong";
      errorEl.style.display = "block";
      return;
    }
    participantEntries.push({ p1Id: null, p1Name: guestName, p2Id: null, p2Name: null, isGuest: true });
    renderParticipantRows();
    nameInput.value = "";
  });

  tournamentCreateWrap.querySelector("#tourney-shuffle-btn").addEventListener("click", () => {
    for (let i = participantEntries.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [participantEntries[i], participantEntries[j]] = [participantEntries[j], participantEntries[i]];
    }
    renderParticipantRows();
  });

  tournamentCreateWrap.querySelector("#tourney-add-participant-btn").addEventListener("click", () => {
    const type = tournamentCreateWrap.querySelector("#tourney-type").value;
    const errorEl = tournamentCreateWrap.querySelector("#tourney-error");
    errorEl.style.display = "none";
    const picker1 = tournamentCreateWrap.querySelector("#tourney-add-picker");
    const p1Id = Number(picker1.value);
    if (!p1Id) {
      errorEl.textContent = "Pilih pemain dulu";
      errorEl.style.display = "block";
      return;
    }
    let p2Id = null;
    if (type === "doubles" && !isCappuccino()) {
      const picker2 = tournamentCreateWrap.querySelector("#tourney-add-picker2");
      p2Id = Number(picker2.value);
      if (!p2Id) {
        errorEl.textContent = "Pilih 2 pemain untuk 1 tim";
        errorEl.style.display = "block";
        return;
      }
      if (p1Id === p2Id) {
        errorEl.textContent = "Partner tidak boleh orang yang sama";
        errorEl.style.display = "block";
        return;
      }
    }
    const usedIds = participantEntries.flatMap((e) => [e.p1Id, e.p2Id].filter(Boolean));
    if (usedIds.includes(p1Id) || (p2Id && usedIds.includes(p2Id))) {
      errorEl.textContent = "Pemain ini sudah dipakai di peserta/tim lain";
      errorEl.style.display = "block";
      return;
    }
    const p1Name = allPlayersForTourney.find((p) => p.id === p1Id)?.name || "?";
    const p2Name = p2Id ? (allPlayersForTourney.find((p) => p.id === p2Id)?.name || "?") : null;
    participantEntries.push({ p1Id, p1Name, p2Id, p2Name });
    renderParticipantRows();
    picker1.value = "";
    if (type === "doubles") tournamentCreateWrap.querySelector("#tourney-add-picker2").value = "";
  });

  tournamentCreateWrap.querySelector("#tourney-create-btn").addEventListener("click", async () => {
    const name = tournamentCreateWrap.querySelector("#tourney-name").value.trim();
    const type = tournamentCreateWrap.querySelector("#tourney-type").value;
    const format = tournamentCreateWrap.querySelector("#tourney-format").value;
    const numGroups = Number(tournamentCreateWrap.querySelector("#tourney-num-groups").value);
    const numCourts = Number(tournamentCreateWrap.querySelector("#tourney-num-courts").value);
    const cappuccinoTargetGames = Number(tournamentCreateWrap.querySelector("#tourney-target-games").value) || 6;
    const roundsMode = tournamentCreateWrap.querySelector("#tourney-rounds-mode").value;
    const targetPlays = Number(tournamentCreateWrap.querySelector("#tourney-target-plays").value);
    const fairMix = tournamentCreateWrap.querySelector("#tourney-fair-mix").checked;
    const fairTargetToSend = (isCappuccino() && roundsMode === "manual" && fairMix) ? targetPlays : null;
    const numRounds = roundsMode === "manual" && Number.isInteger(targetPlays) && targetPlays > 0
      ? computeRoundsFromTarget(participantEntries.length, numCourts, targetPlays)
      : null;
    const errorEl = tournamentCreateWrap.querySelector("#tourney-error");
    errorEl.style.display = "none";

    if (!name) {
      errorEl.textContent = "Nama turnamen wajib diisi";
      errorEl.style.display = "block";
      return;
    }
    if (isCappuccino() && participantEntries.length < 4) {
      errorEl.textContent = "Sistem Cappuccino butuh minimal 4 peserta";
      errorEl.style.display = "block";
      return;
    }
    if (isCappuccino() && roundsMode === "manual" && (!Number.isInteger(targetPlays) || targetPlays < 1 || targetPlays > 30)) {
      errorEl.textContent = "Target main per peserta harus bilangan bulat 1-30";
      errorEl.style.display = "block";
      return;
    }
    if (isCappuccino() && roundsMode === "manual" && !fairMix && numRounds > 30) {
      errorEl.textContent = `Target ${targetPlays}x main butuh ${numRounds} kali ganti pasangan (kebanyakan, maks 30) -- turunkan targetnya atau tambah lapangan`;
      errorEl.style.display = "block";
      return;
    }
    if (isCappuccino() && roundsMode === "manual" && fairMix) {
      const info = estimateFairGolden(participantEntries.length, numCourts, targetPlays);
      if (info && info.totalRounds > 30) {
        errorEl.textContent = `Target ${targetPlays}x butuh ${info.totalRounds} kali ganti pasangan (kebanyakan, maks 30) -- turunkan targetnya`;
        errorEl.style.display = "block";
        return;
      }
    }
    if (!isCappuccino() && participantEntries.length < 2) {
      errorEl.textContent = "Tambahkan minimal 2 peserta";
      errorEl.style.display = "block";
      return;
    }
    if (format === "group_knockout" && (!numGroups || numGroups < 2)) {
      errorEl.textContent = "Jumlah grup minimal 2";
      errorEl.style.display = "block";
      return;
    }
    if (format === "group_knockout" && participantEntries.length < numGroups * 2) {
      errorEl.textContent = `Minimal 2 peserta per grup (butuh minimal ${numGroups * 2} peserta untuk ${numGroups} grup)`;
      errorEl.style.display = "block";
      return;
    }

    const participantIds = isCappuccino()
      ? participantEntries.map((e) => (e.isGuest ? { guestName: e.p1Name } : e.p1Id))
      : (type === "doubles" ? participantEntries.map((e) => [e.p1Id, e.p2Id]) : participantEntries.map((e) => e.p1Id));

    try {
      const data = await api("/admin/tournaments", {
        method: "POST",
        body: JSON.stringify({
          name, format, type, participantIds,
          numGroups: format === "group_knockout" ? numGroups : undefined,
          numCourts: isCappuccino() ? numCourts : undefined,
          cappuccinoTargetGames: isCappuccino() ? cappuccinoTargetGames : undefined,
          numRounds: isCappuccino() ? numRounds : undefined,
          fairTarget: fairTargetToSend || undefined,
        }),
      });
      alert(data.message);
      state.selectedTournamentId = data.tournamentId;
      state.page = "tournamentDetail";
      render();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = "block";
    }
  });

  const matchWrap = el(`
    <div class="card">
      <h2>Kelola Match</h2>
      <div class="nav" style="margin-bottom:0.75rem">
        <button data-mtype="singles" class="active">Single</button>
        <button data-mtype="doubles">Ganda</button>
      </div>
      <div id="admin-match-list">Memuat...</div>
    </div>
  `);
  container.appendChild(matchWrap);

  const statusLabelAdmin = { pending: "Menunggu konfirmasi", confirmed: "Confirmed", disputed: "Dibatalkan", expired: "Kedaluwarsa" };

  async function loadAdminMatches(mtype) {
    const list = matchWrap.querySelector("#admin-match-list");
    list.innerHTML = "Memuat...";
    try {
      const { matches } = await api(`/admin/matches?type=${mtype}&limit=20`);
      if (matches.length === 0) {
        list.innerHTML = `<p class="muted">Belum ada match.</p>`;
        return;
      }
      list.innerHTML = "";
      matches.forEach((m) => {
        const item = el(`
          <div class="row" style="flex-direction:column; align-items:stretch; gap:4px;">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
              <div>
                <div style="font-size:14px">${m.label}</div>
                <div class="muted" style="font-size:11px">${statusLabelAdmin[m.status] || m.status} &middot; ${new Date(m.date).toLocaleDateString("id-ID")}</div>
              </div>
              <button class="btn danger" style="margin-top:0; width:auto; padding:6px 14px; font-size:12px" data-id="${m.id}">Hapus</button>
            </div>
          </div>
        `);
        item.querySelector("button").addEventListener("click", async () => {
          const confirmMsg = m.status === "confirmed"
            ? `Yakin hapus match ini? Rating yang sudah berubah akan DIKEMBALIKAN otomatis.\n\n${m.label}`
            : `Yakin hapus match ini?\n\n${m.label}`;
          if (!confirm(confirmMsg)) return;
          try {
            const data = await api(`/admin/matches/${m.id}?type=${mtype}`, { method: "DELETE" });
            alert(data.message);
            loadAdminMatches(mtype);
          } catch (err) {
            alert(err.message);
          }
        });
        list.appendChild(item);
      });
    } catch (err) {
      list.innerHTML = `<p class="error">${err.message}</p>`;
    }
  }
  matchWrap.querySelectorAll("[data-mtype]").forEach((b) => {
    b.addEventListener("click", () => {
      matchWrap.querySelectorAll("[data-mtype]").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      loadAdminMatches(b.dataset.mtype);
    });
  });
  loadAdminMatches("singles");

  const wrap = el(`<div class="card"><h2>Persetujuan Pendaftar Baru</h2><div id="pending-players-list">Memuat...</div></div>`);
  container.appendChild(wrap);

  try {
    const { players } = await api("/admin/pending-players");
    const list = wrap.querySelector("#pending-players-list");
    if (players.length === 0) {
      list.innerHTML = `<p class="muted">Tidak ada pendaftar yang menunggu persetujuan.</p>`;
    } else {
    list.innerHTML = "";
    players.forEach((p) => {
      const item = el(`
        <div class="row" style="flex-direction:column; align-items:stretch; gap:6px;">
          <div><strong>${p.name}</strong> — ${p.email}${p.unitKerja ? ` (${p.unitKerja})` : ""}</div>
          <div style="display:flex; gap:8px;">
            <button class="btn" style="margin-top:0" data-action="approve" data-id="${p.id}">Setujui</button>
            <button class="btn danger" style="margin-top:0" data-action="reject" data-id="${p.id}">Tolak</button>
          </div>
        </div>
      `);
      item.querySelector('[data-action="approve"]').addEventListener("click", async () => {
        try {
          await api(`/admin/approve/${p.id}`, { method: "POST" });
          render();
        } catch (err) {
          alert(err.message);
        }
      });
      item.querySelector('[data-action="reject"]').addEventListener("click", async () => {
        if (!confirm(`Yakin tolak pendaftaran ${p.name}? Akun akan dihapus.`)) return;
        try {
          await api(`/admin/reject/${p.id}`, { method: "POST" });
          render();
        } catch (err) {
          alert(err.message);
        }
      });
      list.appendChild(item);
    });
    }
  } catch (err) {
    wrap.querySelector("#pending-players-list").innerHTML = `<p class="error">${err.message}</p>`;
  }

  const nameChangeApprovalWrap = el(`<div class="card"><h2>Persetujuan Ganti Nama</h2><div id="pending-name-changes-list">Memuat...</div></div>`);
  container.appendChild(nameChangeApprovalWrap);
  try {
    const { players } = await api("/admin/pending-name-changes");
    const list = nameChangeApprovalWrap.querySelector("#pending-name-changes-list");
    if (players.length === 0) {
      list.innerHTML = `<p class="muted">Tidak ada pengajuan ganti nama.</p>`;
    } else {
      list.innerHTML = "";
      players.forEach((p) => {
        const item = el(`
          <div class="row" style="flex-direction:column; align-items:stretch; gap:6px;">
            <div><strong>${p.name}</strong> &rarr; <strong>${p.pendingName}</strong> (${p.email})</div>
            <div style="display:flex; gap:8px;">
              <button class="btn" style="margin-top:0" data-action="approve-name" data-id="${p.id}">Setujui</button>
              <button class="btn danger" style="margin-top:0" data-action="reject-name" data-id="${p.id}">Tolak</button>
            </div>
          </div>
        `);
        item.querySelector('[data-action="approve-name"]').addEventListener("click", async () => {
          try {
            const data = await api(`/admin/approve-name-change/${p.id}`, { method: "POST" });
            alert(data.message);
            render();
          } catch (err) {
            alert(err.message);
          }
        });
        item.querySelector('[data-action="reject-name"]').addEventListener("click", async () => {
          try {
            const data = await api(`/admin/reject-name-change/${p.id}`, { method: "POST" });
            alert(data.message);
            render();
          } catch (err) {
            alert(err.message);
          }
        });
        list.appendChild(item);
      });
    }
  } catch (err) {
    nameChangeApprovalWrap.querySelector("#pending-name-changes-list").innerHTML = `<p class="error">${err.message}</p>`;
  }

  const bannedWrap = el(`<div class="card"><h2>Akun Diblokir (Tidak Merespon 5x+)</h2><div id="banned-players-list">Memuat...</div></div>`);
  container.appendChild(bannedWrap);
  try {
    const { players } = await api("/admin/banned-players");
    const list = bannedWrap.querySelector("#banned-players-list");
    if (players.length === 0) {
      list.innerHTML = `<p class="muted">Tidak ada akun yang diblokir.</p>`;
      return;
    }
    list.innerHTML = "";
    players.forEach((p) => {
      const item = el(`
        <div class="row" style="flex-direction:column; align-items:stretch; gap:6px;">
          <div><strong>${p.name}</strong> — ${p.email} (${p.noResponseCount}x tidak konfirmasi)</div>
          <button class="btn" style="margin-top:0" data-action="unban" data-id="${p.id}">Buka Blokir</button>
        </div>
      `);
      item.querySelector('[data-action="unban"]').addEventListener("click", async () => {
        try {
          await api(`/admin/unban/${p.id}`, { method: "POST" });
          render();
        } catch (err) {
          alert(err.message);
        }
      });
      list.appendChild(item);
    });
  } catch (err) {
    bannedWrap.querySelector("#banned-players-list").innerHTML = `<p class="error">${err.message}</p>`;
  }
}

async function renderTournaments(container) {
  container.appendChild(nav("tournaments"));
  const wrap = el(`
    <div class="card">
      <h2>🏆 Turnamen</h2>
      <label style="font-size:12px">Filter</label>
      <select id="tourney-status-filter">
        <option value="all">Semua Turnamen</option>
        <option value="ongoing">Sedang Berlangsung</option>
        <option value="completed">Selesai (Arsip)</option>
      </select>
      <div id="tournament-list">Memuat...</div>
    </div>
  `);
  container.appendChild(wrap);

  let allTournaments = [];

  function renderList(filter) {
    const list = wrap.querySelector("#tournament-list");
    const filtered = filter === "all"
      ? allTournaments
      : allTournaments.filter((t) => (filter === "completed" ? t.status === "completed" : t.status !== "completed"));

    if (filtered.length === 0) {
      list.innerHTML = `<p class="muted">Tidak ada turnamen di kategori ini.</p>`;
      return;
    }
    list.innerHTML = "";
    filtered.forEach((t) => {
      const formatLabel = { bracket: "Bracket/Eliminasi", group_knockout: "Setengah Kompetisi", cappuccino: "Sistem Cappuccino", cappuccino_external: "Cappuccino External" }[t.format] || "Round Robin";
      const typeLabel = t.type === "doubles" ? "Ganda" : "Single";
      const statusBadge = t.status === "completed"
        ? `<span style="font-size:11px;background:#e0e0e0;color:#555;padding:2px 8px;border-radius:6px">Selesai</span>`
        : `<span style="font-size:11px;background:#c8e6c9;color:#1b5e20;padding:2px 8px;border-radius:6px">Berlangsung</span>`;
      const startDate = new Date(t.createdAt).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" });
      const dateInfo = t.status === "completed" && t.completedAt
        ? `${startDate} &ndash; ${new Date(t.completedAt).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" })}`
        : `Mulai ${startDate}`;
      const item = el(`
        <div class="row" style="cursor:pointer">
          <span><strong>${t.name}</strong><br/><span class="muted" style="font-size:12px">${typeLabel} &middot; ${formatLabel}</span><br/><span class="muted" style="font-size:11px">${dateInfo}</span></span>
          <span>${statusBadge}</span>
        </div>
      `);
      item.addEventListener("click", () => {
        state.selectedTournamentId = t.id;
        state.page = "tournamentDetail";
        render();
      });
      list.appendChild(item);
    });
  }

  try {
    const { tournaments } = await api("/tournaments");
    allTournaments = tournaments;
    renderList("all");
  } catch (err) {
    wrap.querySelector("#tournament-list").innerHTML = `<p class="error">${err.message}</p>`;
  }
  wrap.querySelector("#tourney-status-filter").addEventListener("change", (e) => renderList(e.target.value));
}

// Bangun HTML diagram bracket visual (kolom per babak, gap membesar 2x tiap babak
// biar kelihatan efek "corong" khas bagan turnamen, bisa di-scroll ke samping di HP)
function buildBracketDiagramHtml(matches, isAdmin, allowParticipantSubmit = false, currentPlayerId = null, podium = null) {
  const numRounds = matches.length ? Math.max(...matches.map((m) => m.round)) : 0;
  const podiumBadge = (label) => {
    if (!podium) return "";
    if (podium.gold.includes(label)) return " 🥇";
    if (podium.silver.includes(label)) return " 🥈";
    if (podium.bronze.includes(label)) return " 🥉";
    return "";
  };
  let html = `<div style="overflow-x:auto"><div style="display:flex;gap:28px;padding:1rem 0.25rem;min-width:max-content">`;
  for (let r = 1; r <= numRounds; r++) {
    const gap = 14 * Math.pow(2, r - 1);
    const roundLabel = r === numRounds ? "Final" : (r === numRounds - 1 ? "Semifinal" : `Babak ${r}`);
    html += `<div style="display:flex;flex-direction:column;justify-content:space-around;gap:${gap}px;min-width:150px">`;
    html += `<div style="text-align:center;font-size:11px;font-weight:600;color:#777;margin-bottom:4px">${roundLabel}</div>`;
    matches.filter((m) => m.round === r).sort((a, b) => a.matchIndex - b.matchIndex).forEach((m) => {
      const p1 = m.participant1 ? m.participant1.label : "?";
      const p2 = m.participant2 ? m.participant2.label : "-";
      const p1Won = m.winner && m.participant1 && m.winner.id === m.participant1.id;
      const p2Won = m.winner && m.participant2 && m.winner.id === m.participant2.id;
      html += `<div style="border:1px solid #ddd;border-radius:8px;overflow:hidden;font-size:12px">
        <div style="padding:6px 8px;border-bottom:1px solid #eee;${p1Won ? "font-weight:700;background:#f4f4f2" : ""}">${p1}${podiumBadge(p1)}</div>
        <div style="padding:6px 8px;${p2Won ? "font-weight:700;background:#f4f4f2" : ""}">${p2}${podiumBadge(p2)}</div>
        ${m.score ? `<div style="padding:3px 8px;font-size:11px;color:#777;text-align:center;background:#fafafa;border-top:1px solid #eee">${m.score}</div>` : ""}
      </div>`;
      const isMatchParticipant = allowParticipantSubmit && currentPlayerId != null && (
        (m.team1PlayerIds || []).includes(currentPlayerId) || (m.team2PlayerIds || []).includes(currentPlayerId)
      );
      const canSubmit = (isAdmin || isMatchParticipant) && m.status === "pending" && m.participant1 && m.participant2;
      const canCorrect = isAdmin && m.status === "completed" && m.participant1 && m.participant2;
      if (canSubmit) {
        html += `<button class="btn secondary" style="margin-top:2px;font-size:11px;padding:4px" data-submit-tm="${m.id}" data-p1="${m.participant1.id}" data-p2="${m.participant2.id}" data-p1name="${m.participant1.label}" data-p2name="${m.participant2.label}">Input Hasil</button>`;
      } else if (canCorrect) {
        html += `<button class="btn secondary" style="margin-top:2px;font-size:10px;padding:3px;color:#c62828" data-correct-tm="${m.id}" data-p1="${m.participant1.id}" data-p2="${m.participant2.id}" data-p1name="${m.participant1.label}" data-p2name="${m.participant2.label}">✏️ Koreksi</button>`;
      }
    });
    html += `</div>`;
  }
  html += `</div></div>`;
  return html;
}

// Daftar match datar (buat Round Robin & fase grup) -- tanpa diagram, cuma list biasa.
// allowParticipantSubmit + currentPlayerId: khusus dipakai buat Sistem Cappuccino, supaya
// pemain yang tampil di match tsb (bukan cuma admin) juga bisa input hasilnya sendiri.
function buildMatchListHtml(matches, isAdmin, allowParticipantSubmit = false, currentPlayerId = null) {
  let html = "";
  matches.forEach((m) => {
    const p1 = m.participant1 ? m.participant1.label : "?";
    const p2 = m.participant2 ? m.participant2.label : "(menunggu)";
    let resultText = m.status === "completed" || m.status === "bye"
      ? `<strong>${m.winner ? m.winner.label : "-"}</strong> menang${m.score ? ` (${m.score})` : ""}`
      : `<span class="muted">Belum main</span>`;
    const isMatchParticipant = allowParticipantSubmit && currentPlayerId != null && (
      (m.team1PlayerIds || []).includes(currentPlayerId) || (m.team2PlayerIds || []).includes(currentPlayerId)
    );
    const canSubmit = (isAdmin || isMatchParticipant) && m.status === "pending" && m.participant1 && m.participant2;
    const canCorrect = isAdmin && m.status === "completed" && m.participant1 && m.participant2;
    const p1Tag = m.goldenTeam1 ? ` <span class="muted" style="font-size:10px">(pengisi)</span>` : "";
    const p2Tag = m.goldenTeam2 ? ` <span class="muted" style="font-size:10px">(pengisi)</span>` : "";
    const goldenBadge = m.isGolden ? `<span style="font-size:10px;background:#fff8e1;color:#8a6d00;padding:2px 6px;border-radius:6px;font-weight:600;margin-left:4px">🏅 Golden Round</span>` : "";
    html += `<div class="row" style="flex-direction:column;align-items:stretch;gap:4px">
      <div style="display:flex;justify-content:space-between">
        <span>${p1}${p1Tag} vs ${p2}${p2Tag}${goldenBadge}</span><span>${resultText}</span>
      </div>
      ${canSubmit ? `<button class="btn secondary" style="margin-top:0" data-submit-tm="${m.id}" data-p1="${m.participant1.id}" data-p2="${m.participant2.id}" data-p1name="${m.participant1.label}" data-p2name="${m.participant2.label}">Input Hasil</button>` : ""}
      ${canCorrect ? `<button class="btn secondary" style="margin-top:0;font-size:11px;padding:4px;color:#c62828" data-correct-tm="${m.id}" data-p1="${m.participant1.id}" data-p2="${m.participant2.id}" data-p1name="${m.participant1.label}" data-p2name="${m.participant2.label}">✏️ Koreksi Hasil</button>` : ""}
    </div>`;
  });
  return html;
}

function wireSubmitButtons(detail, tId, render, defaultTargetGames = 6) {
  detail.querySelectorAll("[data-submit-tm]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const tmId = btn.dataset.submitTm;
      const p1Id = Number(btn.dataset.p1);
      const p2Id = Number(btn.dataset.p2);
      const p1Name = btn.dataset.p1name;
      const p2Name = btn.dataset.p2name;
      const winnerChoice = prompt(`Siapa yang menang?\n1 = ${p1Name}\n2 = ${p2Name}`);
      if (winnerChoice !== "1" && winnerChoice !== "2") return;
      const loserGamesStr = prompt(`Game yang didapat pihak kalah (0-${defaultTargetGames - 1})?`);
      const loserGames = Number(loserGamesStr);
      if (Number.isNaN(loserGames) || loserGames < 0 || loserGames > defaultTargetGames - 1) {
        alert("Skor tidak valid");
        return;
      }
      const winnerId = winnerChoice === "1" ? p1Id : p2Id;
      try {
        const data = await api(`/admin/tournaments/${tId}/matches/${tmId}/submit`, {
          method: "POST",
          body: JSON.stringify({ winnerId, loserGames, targetGames: defaultTargetGames }),
        });
        alert(data.message);
        render();
      } catch (err) {
        alert(err.message);
      }
    });
  });

  // Tombol koreksi (admin) buat match yang sudah completed tapi salah input --
  // membalikkan dulu dampak rating hasil lama, baru simpan hasil yang baru
  detail.querySelectorAll("[data-correct-tm]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const tmId = btn.dataset.correctTm;
      const p1Id = Number(btn.dataset.p1);
      const p2Id = Number(btn.dataset.p2);
      const p1Name = btn.dataset.p1name;
      const p2Name = btn.dataset.p2name;
      if (!confirm(`Koreksi hasil match ${p1Name} vs ${p2Name}?\n\nRating yang sudah terlanjur berubah dari hasil lama akan dikembalikan dulu, baru dihitung ulang pakai hasil yang baru.`)) return;
      const winnerChoice = prompt(`Siapa yang SEHARUSNYA menang?\n1 = ${p1Name}\n2 = ${p2Name}`);
      if (winnerChoice !== "1" && winnerChoice !== "2") return;
      const loserGamesStr = prompt(`Game yang didapat pihak kalah yang benar (0-${defaultTargetGames - 1})?`);
      const loserGames = Number(loserGamesStr);
      if (Number.isNaN(loserGames) || loserGames < 0 || loserGames > defaultTargetGames - 1) {
        alert("Skor tidak valid");
        return;
      }
      const winnerId = winnerChoice === "1" ? p1Id : p2Id;
      try {
        const data = await api(`/admin/tournaments/${tId}/matches/${tmId}/correct`, {
          method: "POST",
          body: JSON.stringify({ winnerId, loserGames, targetGames: defaultTargetGames }),
        });
        alert(data.message);
        render();
      } catch (err) {
        alert(err.message);
      }
    });
  });
}

// Tentukan juara 1/2/3 turnamen (murni buat penanda visual 🥇🥈🥉, TIDAK pengaruhi rating/poin
// apapun) -- cuma dihitung kalau turnamen sudah selesai. Return null kalau belum bisa ditentukan.
function getTournamentPodium(tournament, { standings, matches, knockoutMatches, cappuccinoRanking }) {
  if (tournament.status !== "completed") return null;

  if (tournament.format === "round_robin") {
    if (!standings || standings.length === 0) return null;
    return {
      gold: standings[0] ? [standings[0].label] : [],
      silver: standings[1] ? [standings[1].label] : [],
      bronze: standings[2] ? [standings[2].label] : [],
    };
  }

  if (tournament.format === "cappuccino" || tournament.format === "cappuccino_external") {
    if (!cappuccinoRanking || cappuccinoRanking.length === 0) return null;
    return {
      gold: cappuccinoRanking[0] ? [cappuccinoRanking[0].label] : [],
      silver: cappuccinoRanking[1] ? [cappuccinoRanking[1].label] : [],
      bronze: cappuccinoRanking[2] ? [cappuccinoRanking[2].label] : [],
    };
  }

  // Bracket & babak Knockout-nya Setengah Kompetisi: sama-sama diagram bagan
  const bracketMatches = tournament.format === "bracket" ? matches : knockoutMatches;
  if (!bracketMatches || bracketMatches.length === 0) return null;
  const maxRound = Math.max(...bracketMatches.map((m) => m.round));
  const final = bracketMatches.find((m) => m.round === maxRound);
  if (!final || !final.winner || final.status !== "completed") return null;
  const finalLoser = final.winner.id === (final.participant1 && final.participant1.id) ? final.participant2 : final.participant1;
  const semis = bracketMatches.filter((m) => m.round === maxRound - 1 && m.status === "completed" && m.winner);
  const bronze = semis.map((m) => {
    const loser = m.winner.id === (m.participant1 && m.participant1.id) ? m.participant2 : m.participant1;
    return loser ? loser.label : null;
  }).filter(Boolean);
  return {
    gold: [final.winner.label],
    silver: finalLoser ? [finalLoser.label] : [],
    bronze,
  };
}

async function renderTournamentDetail(container) {
  container.appendChild(nav("tournaments"));
  const backBtn = el(`<button class="btn secondary" style="margin-bottom:0.5rem">&larr; Kembali ke daftar turnamen</button>`);
  backBtn.addEventListener("click", () => { state.page = "tournaments"; render(); });
  container.appendChild(backBtn);

  const wrap = el(`<div class="card"><div id="tournament-detail">Memuat...</div></div>`);
  container.appendChild(wrap);

  const tId = state.selectedTournamentId;
  if (!tId) {
    wrap.querySelector("#tournament-detail").innerHTML = `<p class="error">Turnamen tidak dipilih.</p>`;
    return;
  }

  try {
    const { tournament, matches, standings, groups, knockoutMatches, canStartKnockout, cappuccinoRounds, cappuccinoRanking } = await api(`/tournaments/${tId}`);
    const isAdmin = state.player && state.player.isAdmin;
    const currentPlayerId = state.player ? state.player.id : null;
    const detail = wrap.querySelector("#tournament-detail");

    const formatLabel = { round_robin: "Round Robin", bracket: "Bracket/Eliminasi", group_knockout: "Setengah Kompetisi (Grup + Knockout)", cappuccino: "Sistem Cappuccino", cappuccino_external: "Sistem Cappuccino External (tidak pengaruhi rating)" }[tournament.format];
    let html = `<h2>🏆 ${tournament.name}</h2>`;
    html += `<p class="muted" style="font-size:13px">${formatLabel}${tournament.cappuccinoTargetGames ? ` (First to ${tournament.cappuccinoTargetGames})` : ""} &middot; ${tournament.status === "completed" ? "Selesai" : "Berlangsung"}</p>`;
    const detailStartDate = new Date(tournament.createdAt).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" });
    const detailDateInfo = tournament.status === "completed" && tournament.completedAt
      ? `Mulai ${detailStartDate} &middot; Selesai ${new Date(tournament.completedAt).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" })}`
      : `Mulai ${detailStartDate}`;
    html += `<p class="muted" style="font-size:12px;margin-top:-0.5rem">${detailDateInfo}</p>`;
    if (tournament.format === "cappuccino_external") {
      html += `<p class="muted" style="font-size:12px;background:#f3e5f5;padding:6px 10px;border-radius:8px">☕ Turnamen ini murni buat seru-seruan -- boleh ada peserta tamu (tidak terdaftar di aplikasi), dan hasilnya TIDAK pengaruh ke rating siapapun.</p>`;
    }

    const podium = getTournamentPodium(tournament, { standings, matches, knockoutMatches, cappuccinoRanking });
    if (podium && (podium.gold.length || podium.silver.length || podium.bronze.length)) {
      html += `<div style="margin-top:0.75rem;background:#fffaf0;border:1px solid #f0e4c8;border-radius:10px;padding:10px 12px">
        <div style="font-weight:700;font-size:13px;margin-bottom:4px">🏆 Hasil Akhir</div>
        ${podium.gold.length ? `<div style="font-size:13px">🥇 <strong>${podium.gold.join(", ")}</strong></div>` : ""}
        ${podium.silver.length ? `<div style="font-size:13px">🥈 <strong>${podium.silver.join(", ")}</strong></div>` : ""}
        ${podium.bronze.length ? `<div style="font-size:13px">🥉 <strong>${podium.bronze.join(", ")}</strong></div>` : ""}
      </div>`;
    }

    const podiumBadge = (label) => {
      if (!podium) return "";
      if (podium.gold.includes(label)) return " 🥇";
      if (podium.silver.includes(label)) return " 🥈";
      if (podium.bronze.includes(label)) return " 🥉";
      return "";
    };

    if (tournament.format === "round_robin") {
      html += `<h3 style="margin-top:1rem;font-size:15px">Klasemen</h3>`;
      html += `<table class="lb-table"><thead><tr><th>Peserta</th><th>Menang</th><th>Kalah</th><th>Sel. Game</th></tr></thead><tbody>`;
      standings.forEach((s) => { html += `<tr><td>${s.label}${podiumBadge(s.label)}</td><td>${s.wins}</td><td>${s.losses}</td><td>${s.gameDiff >= 0 ? "+" : ""}${s.gameDiff}</td></tr>`; });
      html += `</tbody></table>`;
      html += `<h3 style="margin-top:1rem;font-size:15px">Pertandingan</h3>`;
      html += buildMatchListHtml(matches, isAdmin, true, currentPlayerId);
    } else if (tournament.format === "bracket") {
      html += `<h3 style="margin-top:1rem;font-size:15px">Bagan Turnamen</h3>`;
      html += buildBracketDiagramHtml(matches, isAdmin, true, currentPlayerId, podium);
    } else if (tournament.format === "group_knockout") {
      groups.forEach((g) => {
        html += `<h3 style="margin-top:1.25rem;font-size:15px">Grup ${g.groupNumber}</h3>`;
        html += `<table class="lb-table"><thead><tr><th>Peserta</th><th>Menang</th><th>Kalah</th><th>Sel. Game</th></tr></thead><tbody>`;
        g.standings.forEach((s) => { html += `<tr><td>${s.label}</td><td>${s.wins}</td><td>${s.losses}</td><td>${s.gameDiff >= 0 ? "+" : ""}${s.gameDiff}</td></tr>`; });
        html += `</tbody></table>`;
        html += buildMatchListHtml(g.matches, isAdmin, true, currentPlayerId);
      });
      if (knockoutMatches) {
        html += `<h3 style="margin-top:1.25rem;font-size:15px">🏆 Babak Knockout</h3>`;
        html += buildBracketDiagramHtml(knockoutMatches, isAdmin, true, currentPlayerId, podium);
      }
    } else if (tournament.format === "cappuccino" || tournament.format === "cappuccino_external") {
      html += `<h3 style="margin-top:1rem;font-size:15px">☕ Peringkat Individu</h3>`;
      html += `<table class="lb-table"><thead><tr><th>#</th><th>Peserta</th><th>Menang</th><th>Poin</th><th>Game Menang</th></tr></thead><tbody>`;
      cappuccinoRanking.forEach((r, i) => { html += `<tr><td>${i + 1}</td><td>${r.label}${podiumBadge(r.label)}</td><td>${r.wins}</td><td>+${r.points}</td><td>${r.gamesWon}</td></tr>`; });
      html += `</tbody></table>`;
      cappuccinoRounds.forEach((rd) => {
        html += `<h3 style="margin-top:1.25rem;font-size:15px">Ronde ${rd.round}</h3>`;
        html += buildMatchListHtml(rd.matches, isAdmin, true, currentPlayerId);
      });
    }

    detail.innerHTML = html;
    const wireTargetGames = (tournament.format === "cappuccino" || tournament.format === "cappuccino_external")
      ? (tournament.cappuccinoTargetGames || 6)
      : 6;
    wireSubmitButtons(detail, tId, render, wireTargetGames);

    if (isAdmin && tournament.format === "group_knockout" && canStartKnockout) {
      const startKoBtn = el(`<button class="btn" style="margin-top:1rem">Mulai Babak Knockout (Top 2 tiap grup)</button>`);
      startKoBtn.addEventListener("click", async () => {
        if (!confirm("Semua match fase grup sudah selesai. Mulai babak knockout dengan 2 peserta teratas tiap grup?")) return;
        try {
          const data = await api(`/admin/tournaments/${tId}/start-knockout`, {
            method: "POST",
            body: JSON.stringify({ advancePerGroup: 2 }),
          });
          alert(data.message);
          render();
        } catch (err) {
          alert(err.message);
        }
      });
      detail.appendChild(startKoBtn);
    }

    if (isAdmin) {
      const deleteBtn = el(`<button class="btn danger" style="margin-top:1rem">Hapus Turnamen Ini</button>`);
      deleteBtn.addEventListener("click", async () => {
        if (!confirm(`Yakin hapus turnamen "${tournament.name}"?\n\nHasil match & rating yang sudah terjadi TETAP TERSIMPAN, cuma struktur turnamennya yang dihapus. Tindakan ini tidak bisa dibatalkan.`)) return;
        try {
          const data = await api(`/admin/tournaments/${tId}`, { method: "DELETE" });
          alert(data.message);
          state.page = "tournaments";
          render();
        } catch (err) {
          alert(err.message);
        }
      });
      detail.appendChild(deleteBtn);
    }
  } catch (err) {
    wrap.querySelector("#tournament-detail").innerHTML = `<p class="error">${err.message}</p>`;
  }
}

async function renderRules(container) {
  container.appendChild(nav("rules"));
  const wrap = el(`
    <div class="card">
      <h2>Aturan Main</h2>

      <div style="background:#fff3cd;border-radius:10px;padding:1rem;margin-top:1rem">
        <p style="font-size:17px;font-weight:700;margin:0 0 0.5rem 0">Main → Catat → Konfirmasi → Poin Bertambah!</p>
        <p style="font-size:15px;line-height:1.7;margin:0">
          • Pastikan kamu dan lawan sudah terdaftar di Tennis-Rank.<br/>
          • Sebelum bermain, sepakati apakah pertandingan akan dicatat di aplikasi.<br/>
          • Setelah pertandingan: Input hasil → Lawan konfirmasi → Poin ter-update otomatis.
        </p>
        <p style="font-size:15px;line-height:1.7;margin:0.75rem 0 0 0">
          🔔 Jangan lupa ingatkan lawan untuk konfirmasi hasil pertandingan di aplikasi!
        </p>
      </div>

      <h3 style="margin-top:1.25rem;margin-bottom:0.4rem;font-size:19px;font-weight:700">1. Cara Daftar</h3>
      <p style="font-size:16px;line-height:1.7">
        Daftar akun → verifikasi email → tunggu persetujuan admin komunitas. Baru setelah disetujui, akun bisa dipakai Login.
      </p>

      <h3 style="margin-top:1.25rem;margin-bottom:0.4rem;font-size:19px;font-weight:700">2. Format Pertandingan</h3>
      <p style="font-size:16px;line-height:1.7">
        <strong>Single:</strong> bisa pilih format First to 4, 6 (standar), atau 8 game, tanpa deuce/tiebreak.
        Format lebih pendek otomatis dapat poin lebih kecil dibanding format standar, meski dominasinya sama.<br/><br/>
        <strong>Ganda:</strong> format tetap First to 6, tidak ada pilihan format.
      </p>

      <h3 style="margin-top:1.25rem;margin-bottom:0.4rem;font-size:19px;font-weight:700">3. Sistem Poin (ELO)</h3>
      <p style="font-size:16px;line-height:1.7">
        Semua mulai dari rating 1500. Naik-turun tergantung: seberapa kuat lawan (menang lawan lebih kuat = poin lebih besar),
        seberapa telak kemenangan (6-0 lebih besar poinnya dari 6-5), dan status provisional (10 match pertama tiap orang,
        rating bergerak lebih cepat; setelah itu lebih stabil).<br/><br/>
        Untuk Ganda, poin dihitung dari rata-rata rating tim, tapi tiap pemain tetap punya rating individu sendiri.<br/><br/>
        Untuk menjaga keseimbangan kompetisi dan mempertahankan gap antar pemain, poin akan di-reset pada setiap awal season baru
        (akhir tahun). Namun, seluruh data dan riwayat poin dari season sebelumnya tetap tersimpan dan dapat dilihat kembali
        dengan memilih season yang diinginkan lewat dropdown "Season" di halaman Ranking.
      </p>

      <h3 style="margin-top:1.25rem;margin-bottom:0.4rem;font-size:19px;font-weight:700">4. Konfirmasi Hasil Match</h3>
      <p style="font-size:16px;line-height:1.7">
        <strong>Single:</strong> wajib dikonfirmasi lawan (2 pihak) sebelum rating berubah.<br/>
        <strong>Ganda:</strong> cukup 1 wakil dari tiap tim yang konfirmasi (total 2 orang, bebas siapa saja).<br/><br/>
        Kalau ditolak salah satu pihak, match otomatis dibatalkan (tidak mempengaruhi rating). Submit ulang kalau perlu dicatat lagi.<br/><br/>
        Kalau tidak direspon sama sekali dalam <strong>2x24 jam</strong>, match otomatis dianggap confirmed (yang menang tetap dapat haknya),
        tapi poinnya cuma <strong>setengah</strong> dari perhitungan normal.
      </p>

      <h3 style="margin-top:1.25rem;margin-bottom:0.4rem;font-size:19px;font-weight:700">5. Sanksi Tidak Merespon</h3>
      <p style="font-size:16px;line-height:1.7">
        Setiap kali match auto-confirmed karena Anda tidak merespon dalam 2x24 jam, Anda dapat 1x <strong>🟥 Kartu Merah</strong> --
        langsung kelihatan di sebelah nama Anda di tabel ranking (bisa dilihat semua orang), bertambah tiap kali kejadian lagi.
        Kalau sudah sampai <strong>5 kartu merah</strong>, rating Anda dikurangi 50 poin dan semua kartu merahnya direset ke 0
        (siklusnya bisa berulang kalau kebiasaan tidak berubah).
        Kartu merah juga otomatis hilang lebih cepat begitu Anda aktif lagi -- konfirmasi atau input hasil match
        (single/ganda, boleh campur) sebanyak <strong>3 kali</strong>.
      </p>

      <h3 style="margin-top:1.25rem;margin-bottom:0.4rem;font-size:19px;font-weight:700">6. Leaderboard</h3>
      <p style="font-size:16px;line-height:1.7">
        Single: minimal sudah main 1 kali baru muncul di papan ranking. Ganda: minimal 2 kali.
        Bisa diurutkan berdasarkan Poin, Jumlah Main, atau Win Rate.
      </p>

      <h3 style="margin-top:1.25rem;margin-bottom:0.4rem;font-size:19px;font-weight:700">7. Gelar & Prestasi</h3>
      <p style="font-size:16px;line-height:1.9">
        🏆 <strong>Tak Terkalahkan</strong> — win rate 100% (min. 3 match)<br/>
        👑 <strong>Legenda</strong> — win rate ≥70% & main ≥25<br/>
        🌟 <strong>Superstar</strong> — win rate ≥70%, main <25<br/>
        🔥 <strong>Konsisten</strong> — win rate ≥60% & main ≥15<br/>
        💪 <strong>Pejuang Lapangan</strong> — main ≥20, win rate <40%<br/>
        🐐 <strong>GOAT</strong> — sedang menang 10x beruntun<br/>
        🔥🔥 <strong>Super Unbeaten</strong> — sedang menang 5x beruntun<br/>
        ✅ <strong>Unbeaten</strong> — sedang menang 3x beruntun<br/>
        😅 <strong>Loser</strong> — sedang kalah 3x beruntun<br/>
        🗡️ <strong>Giant Slayer</strong> — pernah menang lawan yang rating-nya jauh di atas<br/>
        ⚡ <strong>Antu Lapangan</strong> — jumlah main terbanyak saat ini (min. 16 match)
      </p>

      <h3 style="margin-top:1.25rem;margin-bottom:0.4rem;font-size:19px;font-weight:700">8. Etika Bermain</h3>
      <p style="font-size:16px;line-height:1.9">
        ✅ Isi skor jujur sesuai kejadian sebenarnya<br/>
        ✅ Segera konfirmasi kalau dapat notifikasi hasil match<br/>
        ❌ Jangan sengaja kalah biar rating turun terus cari lawan gampang<br/>
        ✅ Tetap sportif — ini buat seru-seruan bareng, bukan ajang gengsi
      </p>

      <p class="muted" style="font-size:14px;margin-top:1.25rem;line-height:1.6">
        Rank ini hanya untuk seru-seruan dan motivasi main, bukan patokan skill yang presisi.
      </p>

      <p class="muted" style="font-size:14px;margin-top:1rem;border-top:1px solid #eee;padding-top:1rem;line-height:1.6">
        (By MF)
      </p>
    </div>
  `);
  container.appendChild(wrap);
}

// Ubah base64 VAPID public key jadi format yang dipahami browser
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

async function setupNotificationButton(wrap) {
  const btn = wrap.querySelector("#notif-btn");
  const errorEl = wrap.querySelector("#notif-error");

  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    btn.textContent = "Notifikasi tidak didukung di browser ini";
    btn.disabled = true;
    return;
  }

  const registration = await navigator.serviceWorker.ready;
  const existingSubscription = await registration.pushManager.getSubscription();

  function setEnabledUI() {
    btn.textContent = "🔔 Notifikasi Aktif — Klik untuk Matikan";
    btn.classList.remove("secondary");
  }
  function setDisabledUI() {
    btn.textContent = "🔕 Aktifkan Notifikasi";
    btn.classList.add("secondary");
  }

  if (existingSubscription) {
    setEnabledUI();
  } else {
    setDisabledUI();
  }

  btn.addEventListener("click", async () => {
    errorEl.style.display = "none";
    btn.disabled = true;
    try {
      const current = await registration.pushManager.getSubscription();
      if (current) {
        // Matikan notifikasi
        await api("/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: current.endpoint }) });
        await current.unsubscribe();
        setDisabledUI();
      } else {
        // Aktifkan notifikasi
        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
          errorEl.textContent = "Izin notifikasi ditolak. Aktifkan lewat pengaturan browser/HP kalau berubah pikiran.";
          errorEl.style.display = "block";
          btn.disabled = false;
          return;
        }
        const { publicKey } = await api("/push/vapid-public-key");
        const subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });
        const subJson = subscription.toJSON();
        await api("/push/subscribe", {
          method: "POST",
          body: JSON.stringify({ endpoint: subJson.endpoint, keys: subJson.keys }),
        });
        setEnabledUI();
      }
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = "block";
    }
    btn.disabled = false;
  });
}

// Muat html2canvas dari CDN cuma sekali, pas benar-benar dibutuhkan (klik tombol download) --
// supaya halaman Profil biasa tetap ringan, tidak ikut nge-load library ini tiap kali dibuka.
let html2canvasPromise = null;
function ensureHtml2Canvas() {
  if (window.html2canvas) return Promise.resolve();
  if (html2canvasPromise) return html2canvasPromise;
  html2canvasPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Gagal memuat library pembuat gambar. Cek koneksi internet."));
    document.head.appendChild(script);
  });
  return html2canvasPromise;
}

// Skala rating (1000-an ELO) jadi angka gaya "OVR" 40-99, biar terasa seperti kartu game.
// Murni buat estetika kartu unduhan ini -- tidak dipakai di perhitungan rating manapun.
// Skala rating (ELO) jadi "OVR" gaya kartu game, 40-99, murni buat estetika kartu unduhan --
// tidak dipakai di perhitungan rating manapun. Pakai kurva exponential-approach (bukan garis
// lurus): makin tinggi rating, kenaikan OVR-nya makin melambat, MENDEKATI 99 terus tapi secara
// matematis tidak pernah benar-benar pas 99 -- baru dibulatkan jadi tampil "99" di rating yang
// sangat tinggi (~4800+), jauh di luar jangkauan wajar komunitas, jadi OVR-nya tetap bisa
// membedakan pemain top sekalipun rating-nya terus naik (beda dgn rumus garis lurus yang dulu
// sudah mentok 99 di rating ~1700).
function ratingToOvr(rating) {
  const lo = 40, hi = 99;
  const baseRating = 1500, baseTarget = 80, floor = 1000;
  const S = -(baseRating - floor) / Math.log((hi - baseTarget) / (hi - lo));
  const raw = hi - (hi - lo) * Math.exp(-(Number(rating) - floor) / S);
  return Math.max(lo, Math.min(hi, Math.round(raw)));
}

// Bangun elemen kartu bergaya "trading card" (di luar layar, gak kelihatan user) lalu di-screenshot
// jadi PNG pakai html2canvas dan didownload. Baru dipanggil pas tombol "Download Kartu Statistik"
// diklik -- jadi tidak membebani render halaman Profil normal.
async function downloadStatCard(player, btnEl) {
  const originalText = btnEl.textContent;
  btnEl.disabled = true;
  btnEl.textContent = "Menyiapkan...";
  try {
    await ensureHtml2Canvas();

    const ovrSingle = ratingToOvr(player.currentRating);
    const ovrDouble = ratingToOvr(player.doublesRating);
    const ovrOverall = Math.max(ovrSingle, ovrDouble);
    const rankText = (r) => (r ? `#${r}` : "Belum Peringkat");
    const allBadges = [...(player.singlesBadges || []), ...(player.doublesBadges || [])];
    const seenB = new Set();
    const uniqueBadges = allBadges.filter((b) => {
      const key = `${b.emoji}${b.label}`;
      if (seenB.has(key)) return false;
      seenB.add(key);
      return true;
    });
    const facetSvg = `data:image/svg+xml,${encodeURIComponent(`
      <svg xmlns="http://www.w3.org/2000/svg" width="400" height="320">
        <g fill="none" stroke="#3fd0e0" stroke-opacity="0.22" stroke-width="1.2">
          <path d="M0,40 L120,0 L260,60 L400,10" />
          <path d="M0,140 L150,90 L300,160 L400,110" />
          <path d="M0,240 L100,190 L250,260 L400,210" />
          <path d="M40,0 L60,320" /><path d="M180,0 L220,320" /><path d="M340,0 L300,320" />
        </g>
        <g fill="none" stroke="#d4af37" stroke-opacity="0.14" stroke-width="1">
          <path d="M0,90 L90,50 L200,110 L400,60" />
          <path d="M0,190 L110,150 L230,210 L400,160" />
        </g>
      </svg>`)}`;

    const badgeIconsHtml = uniqueBadges.length
      ? uniqueBadges.map((b) => `
          <div style="display:flex;flex-direction:column;align-items:center;gap:6px;width:76px">
            <div style="width:54px;height:54px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#2a3651,#141c2c 70%);border:2px solid #d4af37;box-shadow:0 0 0 1px rgba(255,255,255,0.15),0 0 14px rgba(212,175,55,0.65),inset 0 2px 3px rgba(255,255,255,0.15);display:flex;align-items:center;justify-content:center;font-size:24px">${b.emoji}</div>
            <div style="font-size:10px;font-weight:700;color:#e8e8e8;text-align:center;letter-spacing:0.5px">${b.label.toUpperCase()}</div>
          </div>`).join("")
      : `<div style="font-size:12px;color:#6d7890">Belum ada gelar</div>`;

    const card = document.createElement("div");
    card.style.cssText = "position:fixed;top:0;left:-9999px;width:410px;height:auto;";
    card.innerHTML = `
      <div style="width:410px;box-sizing:border-box;background:linear-gradient(135deg,#e8dca8,#d4af37 15%,#8a6d1f 35%,#d4af37 55%,#f5e28c 70%,#8a6d1f 90%,#d4af37);border-radius:22px;padding:5px;box-shadow:0 10px 30px rgba(0,0,0,0.55),0 0 26px rgba(212,175,55,0.4);font-family:Arial,Helvetica,sans-serif">
        <div style="background:linear-gradient(160deg,#0a1220,#141f33 55%,#0a1220);background-image:url('${facetSvg}'),linear-gradient(160deg,#0a1220,#141f33 55%,#0a1220);background-size:cover;border:1px solid rgba(255,255,255,0.15);border-radius:18px;padding:22px;position:relative;overflow:hidden;box-shadow:inset 0 1px 0 rgba(255,255,255,0.25),inset 0 0 40px rgba(0,0,0,0.4)">

          <div style="position:absolute;top:-60%;left:-20%;width:70%;height:220%;background:linear-gradient(75deg,rgba(255,255,255,0) 40%,rgba(255,255,255,0.10) 48%,rgba(255,255,255,0.22) 50%,rgba(255,255,255,0.10) 52%,rgba(255,255,255,0) 60%);transform:rotate(8deg);pointer-events:none"></div>

          <div style="display:flex;align-items:center;gap:16px;position:relative">
            <div style="width:86px;height:86px;border-radius:50%;flex-shrink:0;position:relative;box-shadow:0 0 0 1px rgba(255,255,255,0.5),0 0 0 4px #d4af37,0 0 0 5px rgba(255,255,255,0.25),0 0 22px rgba(212,175,55,0.85);overflow:hidden;background:#1c2431;display:flex;align-items:center;justify-content:center">
              ${player.photoUrl
                ? `<img src="${player.photoUrl}" crossorigin="anonymous" style="width:100%;height:100%;object-fit:cover" />`
                : `<span style="font-size:28px;font-weight:700;color:#d4af37">${(player.name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase()}</span>`}
              <div style="position:absolute;top:0;left:0;right:0;height:45%;background:linear-gradient(180deg,rgba(255,255,255,0.35),rgba(255,255,255,0) 100%);pointer-events:none"></div>
            </div>
            <div>
              <div style="font-size:26px;font-weight:800;color:#ffffff;letter-spacing:0.3px;text-shadow:0 2px 4px rgba(0,0,0,0.5)">${player.name}</div>
              <div style="display:inline-flex;align-items:center;margin-top:6px;background:linear-gradient(180deg,#f5e28c,#d4af37 45%,#a9821f);clip-path:polygon(0 0,88% 0,100% 100%,0 100%);padding:6px 26px 6px 14px;font-size:11px;font-weight:800;letter-spacing:2px;color:#2a2308;box-shadow:inset 0 1px 0 rgba(255,255,255,0.6),0 2px 4px rgba(0,0,0,0.35);position:relative;overflow:hidden">
                KARTU STATISTIK
                <div style="position:absolute;right:6px;top:0;bottom:0;width:14px;background:repeating-linear-gradient(115deg,rgba(255,255,255,0.55) 0 2px,transparent 2px 5px)"></div>
              </div>
            </div>
          </div>

          <div style="margin-top:18px;position:relative;display:flex;align-items:stretch;gap:12px">
            <div style="display:inline-block;background:linear-gradient(180deg,#f5e28c,#d4af37 40%,#9c7a1c);border-radius:6px;border-left:5px solid #fff8de;padding:12px 26px;box-shadow:0 4px 10px rgba(0,0,0,0.35)">
              <div style="font-size:10px;font-weight:800;color:#3a2f0b;letter-spacing:1px">OVR</div>
              <div style="font-size:34px;font-weight:800;color:#0a1220;line-height:1.2">${ovrOverall}</div>
            </div>
            <div style="flex:1;background:rgba(22,31,48,0.7);border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:10px 14px;display:flex;flex-direction:column;justify-content:center;gap:6px">
              <div style="display:flex;justify-content:space-between;font-size:12px">
                <span style="color:#9aa4b8">🎾 Total Main</span>
                <span style="color:#fff;font-weight:700">${player.matchesPlayed + player.doublesMatchesPlayed}x</span>
              </div>
              <div style="display:flex;justify-content:space-between;font-size:12px">
                <span style="color:#9aa4b8">🏆 Total Menang</span>
                <span style="color:#fff;font-weight:700">${player.singlesWins + player.doublesWins}x</span>
              </div>
            </div>
          </div>

          <div style="margin-top:20px;position:relative">
            <div style="font-size:11px;letter-spacing:2px;color:#3fd0e0;font-weight:800;margin-bottom:10px;text-shadow:0 0 8px rgba(63,208,224,0.6)">SPESIALISASI</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
              <div style="background:linear-gradient(160deg,rgba(34,46,70,0.9),rgba(16,22,35,0.9));border:1px solid rgba(255,255,255,0.1);border-left:4px solid #d4af37;border-radius:8px;padding:14px;box-shadow:inset 0 1px 0 rgba(255,255,255,0.08),0 3px 8px rgba(0,0,0,0.3)">
                <div style="display:flex;justify-content:space-between;align-items:baseline">
                  <div style="font-size:16px;font-weight:800;color:#fff;letter-spacing:1px">TUNGGAL</div>
                </div>
                <div style="display:flex;justify-content:space-between;margin-top:8px">
                  <div>
                    <div style="font-size:17px;font-weight:800;color:#fff">${Math.round(player.currentRating)}</div>
                    <div style="font-size:9px;color:#6d7890">POINT</div>
                  </div>
                  <div style="text-align:right">
                    <div style="font-size:17px;font-weight:800;color:#3fd0e0">${rankText(player.singlesRank)}</div>
                    <div style="font-size:9px;color:#6d7890">PERINGKAT</div>
                  </div>
                </div>
                <div style="font-size:11px;color:#9aa4b8;margin-top:8px;line-height:1.7">${player.matchesPlayed}x main | ${player.singlesWins}M-${player.singlesLosses}K<br>Win rate: ${player.singlesWinRate}%</div>
                <div style="margin-top:8px;font-size:9px;font-weight:800;letter-spacing:1px;color:#0a1220;background:linear-gradient(180deg,#6ee6f5,#3fd0e0);display:inline-block;padding:3px 10px;border-radius:3px;box-shadow:inset 0 1px 0 rgba(255,255,255,0.5)">${player.isProvisional ? "PROVISIONAL" : "STABIL"}</div>
              </div>
              <div style="background:linear-gradient(160deg,rgba(34,46,70,0.9),rgba(16,22,35,0.9));border:1px solid rgba(255,255,255,0.1);border-left:4px solid #d4af37;border-radius:8px;padding:14px;box-shadow:inset 0 1px 0 rgba(255,255,255,0.08),0 3px 8px rgba(0,0,0,0.3)">
                <div style="display:flex;justify-content:space-between;align-items:baseline">
                  <div style="font-size:16px;font-weight:800;color:#fff;letter-spacing:1px">GANDA</div>
                </div>
                <div style="display:flex;justify-content:space-between;margin-top:8px">
                  <div>
                    <div style="font-size:17px;font-weight:800;color:#fff">${Math.round(player.doublesRating)}</div>
                    <div style="font-size:9px;color:#6d7890">POINT</div>
                  </div>
                  <div style="text-align:right">
                    <div style="font-size:17px;font-weight:800;color:#d4af37">${rankText(player.doublesRank)}</div>
                    <div style="font-size:9px;color:#6d7890">PERINGKAT</div>
                  </div>
                </div>
                <div style="font-size:11px;color:#9aa4b8;margin-top:8px;line-height:1.7">${player.doublesMatchesPlayed}x main | ${player.doublesWins}M-${player.doublesLosses}K<br>Win rate: ${player.doublesWinRate}%</div>
                <div style="margin-top:8px;font-size:9px;font-weight:800;letter-spacing:1px;color:#0a1220;background:linear-gradient(180deg,#f5e28c,#d4af37);display:inline-block;padding:3px 10px;border-radius:3px;box-shadow:inset 0 1px 0 rgba(255,255,255,0.5)">${player.doublesIsProvisional ? "PROVISIONAL" : "STABIL"}</div>
              </div>
            </div>
          </div>

          <div style="margin-top:18px;position:relative">
            <div style="font-size:11px;letter-spacing:2px;color:#3fd0e0;font-weight:800;margin-bottom:10px;text-shadow:0 0 8px rgba(63,208,224,0.6)">GELAR</div>
            <div style="display:flex;gap:14px;flex-wrap:wrap">${badgeIconsHtml}</div>
          </div>

          <div style="margin-top:20px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.12);display:flex;justify-content:space-between;align-items:center;position:relative">
            <div style="font-size:11px;font-weight:800;letter-spacing:1px;color:#c7cfdd">PSP TENNIS RANK</div>
            <div style="font-size:10px;color:#4a5468">${new Date().toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" })}</div>
          </div>

        </div>
      </div>
    `;
    document.body.appendChild(card);

    // Tunggu foto avatar (kalau ada) selesai kemuat sebelum di-screenshot, biar gak kosong
    const img = card.querySelector("img");
    if (img && !img.complete) {
      await new Promise((resolve) => { img.onload = resolve; img.onerror = resolve; });
    }
    await new Promise((r) => setTimeout(r, 60));

    const canvas = await window.html2canvas(card.firstElementChild, { backgroundColor: null, scale: 2, useCORS: true });
    document.body.removeChild(card);

    canvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `kartu-statistik-${(player.name || "pemain").toLowerCase().replace(/\s+/g, "-")}.png`;
      a.click();
      URL.revokeObjectURL(url);
    }, "image/png");
  } catch (err) {
    alert("Gagal membuat gambar: " + err.message);
  } finally {
    btnEl.disabled = false;
    btnEl.textContent = originalText;
  }
}

async function renderProfile(container) {
  container.appendChild(nav("profile"));
  const wrap = el(`
    <div class="card">
      <div id="profile-stats">Memuat...</div>
      <button id="logout-btn" class="btn secondary" style="margin-top:1rem">Keluar</button>
      <div style="height:1px;background:#e5e5e0;margin:1rem 0"></div>
      <label>Ganti foto profil (JPG/PNG, maks 2MB)</label>
      <input id="photo-input" type="file" accept="image/jpeg,image/png" />
      <div id="photo-error" class="error" style="display:none"></div>
      <button id="photo-upload-btn" class="btn secondary">Upload Foto</button>
    </div>
  `);
  container.appendChild(wrap);
  wrap.querySelector("#logout-btn").addEventListener("click", logout);

  const nameChangeWrap = el(`
    <div class="card">
      <h2>Ganti Nama</h2>
      <div id="name-change-status"></div>
      <label>Nama baru</label>
      <input id="new-name-input" type="text" placeholder="Ketik nama baru..." />
      <div id="name-change-error" class="error" style="display:none"></div>
      <button id="request-name-change-btn" class="btn secondary">Ajukan Perubahan Nama</button>
    </div>
  `);
  container.appendChild(nameChangeWrap);
  try {
    const { player } = await api(`/players/${state.player.id}`);
    if (player.pendingName) {
      nameChangeWrap.querySelector("#name-change-status").innerHTML =
        `<p class="muted" style="font-size:13px;background:#fff3cd;padding:0.5rem;border-radius:8px">Menunggu persetujuan admin: <strong>${player.pendingName}</strong></p>`;
    }
  } catch (err) {
    // biarkan saja, tidak fatal kalau gagal cek status pending
  }
  nameChangeWrap.querySelector("#request-name-change-btn").addEventListener("click", async () => {
    const newName = nameChangeWrap.querySelector("#new-name-input").value.trim();
    const errorEl = nameChangeWrap.querySelector("#name-change-error");
    errorEl.style.display = "none";
    if (!newName) {
      errorEl.textContent = "Nama baru wajib diisi";
      errorEl.style.display = "block";
      return;
    }
    try {
      const data = await api("/players/me/request-name-change", {
        method: "POST",
        body: JSON.stringify({ newName }),
      });
      alert(data.message);
      render();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = "block";
    }
  });

  const notifWrap = el(`
    <div class="card">
      <h2>Notifikasi</h2>
      <p class="muted" style="font-size:13px">Dapat notifikasi langsung di HP saat ada match yang perlu Anda konfirmasi (perlu app sudah di-install ke homescreen).</p>
      <div id="notif-error" class="error" style="display:none"></div>
      <button id="notif-btn" class="btn secondary">Memeriksa status...</button>
    </div>
  `);
  container.appendChild(notifWrap);
  setupNotificationButton(notifWrap);

  wrap.querySelector("#photo-upload-btn").addEventListener("click", async () => {
    const fileInput = wrap.querySelector("#photo-input");
    const errorEl = wrap.querySelector("#photo-error");
    errorEl.style.display = "none";
    const file = fileInput.files[0];
    if (!file) {
      errorEl.textContent = "Pilih file foto dulu";
      errorEl.style.display = "block";
      return;
    }
    const formData = new FormData();
    formData.append("photo", file);
    try {
      const res = await fetch(`${API}/players/me/photo`, {
        method: "POST",
        headers: { Authorization: `Bearer ${state.token}` },
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || "Gagal upload foto");
      state.player.photoUrl = data.photoUrl;
      localStorage.setItem("player", JSON.stringify(state.player));
      wrap.querySelector("#avatar-preview").innerHTML = avatarHtml(data.photoUrl, state.player.name, 56);
      alert("Foto profil berhasil diupdate!");
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = "block";
    }
  });

  try {
    const { player } = await api(`/players/${state.player.id}`);
    const allBadges = [...(player.singlesBadges || []), ...(player.doublesBadges || [])];
    const seen = new Set();
    const badgeChips = allBadges
      .filter((b) => { const key = `${b.emoji}${b.label}`; if (seen.has(key)) return false; seen.add(key); return true; })
      .map((b) => `<span style="display:inline-block;background:#fff3cd;border:1px solid #f0d68a;border-radius:20px;padding:4px 12px;font-size:12px">${b.emoji} ${b.label}</span>`)
      .join("");
    const rankText = (r) => (r ? `#${r}` : "Belum Peringkat");
    const winRateText = (w) => `${Math.round(w * 10) / 10}`;

    wrap.querySelector("#profile-stats").innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:0.75rem">
        ${avatarHtml(player.photoUrl, player.name, 56)}
        <h2 style="margin:0">${player.name}</h2>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:0.75rem">
        <div class="row" style="flex-direction:column;align-items:flex-start;gap:4px">
          <span class="muted" style="font-size:12px;font-weight:600">TUNGGAL</span>
          <span style="font-size:24px;font-weight:700">${Math.round(player.currentRating)}</span>
          <span class="muted" style="font-size:12px">Peringkat: ${rankText(player.singlesRank)}</span>
          <span class="muted" style="font-size:12px">${player.matchesPlayed}x main &middot; ${player.singlesWins}M-${player.singlesLosses}K &middot; ${winRateText(player.singlesWinRate)}%</span>
          <span class="muted" style="font-size:11px">${player.isProvisional ? "Provisional" : "Stabil"}</span>
        </div>
        <div class="row" style="flex-direction:column;align-items:flex-start;gap:4px">
          <span class="muted" style="font-size:12px;font-weight:600">GANDA</span>
          <span style="font-size:24px;font-weight:700">${Math.round(player.doublesRating)}</span>
          <span class="muted" style="font-size:12px">Peringkat: ${rankText(player.doublesRank)}</span>
          <span class="muted" style="font-size:12px">${player.doublesMatchesPlayed}x main &middot; ${player.doublesWins}M-${player.doublesLosses}K &middot; ${winRateText(player.doublesWinRate)}%</span>
          <span class="muted" style="font-size:11px">${player.doublesIsProvisional ? "Provisional" : "Stabil"}</span>
        </div>
      </div>
      <div style="margin-bottom:0.5rem">
        <span class="muted" style="font-size:12px;font-weight:600">GELAR</span>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">
          ${badgeChips || `<span class="muted" style="font-size:12px">Belum ada gelar. Terus main untuk dapat gelar!</span>`}
        </div>
      </div>
      ${player.noResponseCount > 0 ? `
        <div class="row" style="background:#fdecea;border-radius:8px;margin-top:1rem;flex-direction:column;align-items:flex-start;gap:2px">
          <span style="font-weight:600;color:#c62828">${"🟥".repeat(player.noResponseCount)} ${player.noResponseCount}/5 Kartu Merah</span>
          <span style="font-size:12px;color:#555">Setiap kartu merah didapat karena tidak merespon konfirmasi match. Kalau sampai 5, rating dikurangi 50 poin. Konfirmasi/input match lagi ${3 - player.redCardProgress}x untuk menghapus semua kartu merah (progres: ${player.redCardProgress}/3).</span>
        </div>
      ` : ""}
      <button id="download-card-btn" class="btn secondary" style="margin-top:1rem">📥 Download Kartu Statistik</button>
    `;
    wrap.querySelector("#download-card-btn").addEventListener("click", (e) => downloadStatCard(player, e.target));
  } catch (err) {
    wrap.querySelector("#profile-stats").innerHTML = `<p class="error">${err.message}</p>`;
  }

  const historyWrap = el(`<div class="card"><h2>Histori Single</h2><div id="history-list">Memuat...</div></div>`);
  container.appendChild(historyWrap);
  try {
    const { matches } = await api(`/matches?player_id=${state.player.id}`);
    const list = historyWrap.querySelector("#history-list");
    if (matches.length === 0) {
      list.innerHTML = `<p class="muted">Belum ada histori match.</p>`;
    } else {
      list.innerHTML = matches
        .map((m) => {
          const won = m.winner === state.player.name;
          const opponent = won ? m.loser : m.winner;
          const change = won ? m.ratingWinnerChange : m.ratingLoserChange;
          const statusLabel = { pending: "Menunggu konfirmasi", disputed: "Dibatalkan", expired: "Kedaluwarsa" };
          const changeText = change != null ? (change >= 0 ? `+${Math.round(change)}` : Math.round(change)) : (statusLabel[m.status] || m.status);
          const reasonHtml = m.status === "disputed" && m.rejectReason
            ? `<div class="muted" style="font-size:12px;margin-top:2px">Alasan ditolak: ${m.rejectReason}</div>`
            : "";
          return `<div class="row" style="flex-direction:column;align-items:stretch">
            <div style="display:flex;justify-content:space-between">
              <span>${won ? "Menang" : "Kalah"} vs ${opponent} (${m.score})</span><span>${changeText}</span>
            </div>
            ${reasonHtml}
          </div>`;
        })
        .join("");
    }
  } catch (err) {
    historyWrap.querySelector("#history-list").innerHTML = `<p class="error">${err.message}</p>`;
  }

  const doublesHistoryWrap = el(`<div class="card"><h2>Histori Ganda</h2><div id="doubles-history-list">Memuat...</div></div>`);
  container.appendChild(doublesHistoryWrap);
  try {
    const { matches } = await api(`/doubles/matches?player_id=${state.player.id}`);
    const list = doublesHistoryWrap.querySelector("#doubles-history-list");
    if (matches.length === 0) {
      list.innerHTML = `<p class="muted">Belum ada histori match ganda.</p>`;
    } else {
      list.innerHTML = matches
        .map((m) => {
          const statusLabel = { pending: "Menunggu konfirmasi", disputed: "Dibatalkan", expired: "Kedaluwarsa" };
          const changeText = m.ratingChange != null
            ? (m.ratingChange >= 0 ? `+${Math.round(m.ratingChange)}` : Math.round(m.ratingChange))
            : (statusLabel[m.status] || m.status);
          const reasonHtml = m.status === "disputed" && m.rejectReason
            ? `<div class="muted" style="font-size:12px;margin-top:2px">Alasan ditolak: ${m.rejectReason}</div>`
            : "";
          return `<div class="row" style="flex-direction:column;align-items:stretch">
            <div style="display:flex;justify-content:space-between">
              <span>${m.won ? "Menang" : "Kalah"} (& ${m.partner}) vs ${m.opponents} (${m.score})</span><span>${changeText}</span>
            </div>
            ${reasonHtml}
          </div>`;
        })
        .join("");
    }
  } catch (err) {
    doublesHistoryWrap.querySelector("#doubles-history-list").innerHTML = `<p class="error">${err.message}</p>`;
  }
}

async function render() {
  const app = document.getElementById("app");
  app.innerHTML = "";
  app.appendChild(el(`
    <div style="margin-bottom:1rem">
      <h1 style="margin-bottom:0.25rem">PSP Tennis Rank</h1>
      <p class="muted" style="font-size:12px;margin:0">Disclaimer: Rank ini hanya untuk seru-seruan, menampilkan berdasarkan frekuensi main dan kemenangan, tidak bisa menjadi patokan skill sebenarnya.</p>
    </div>
  `));

  if (state.token && !state.player) loadAuth();

  if (state.page === "resetPassword") {
    await renderResetPassword(app);
  } else if (state.page === "verifyEmail") {
    await renderVerifyEmail(app);
  } else if (state.page === "rules") {
    await renderRules(app);
  } else if (state.page === "tournaments") {
    await renderTournaments(app);
  } else if (state.page === "tournamentDetail") {
    await renderTournamentDetail(app);
  } else if (!state.token && ["submit", "submitDoubles", "confirm", "profile", "admin"].includes(state.page)) {
    // Perlu login untuk halaman ini
    app.appendChild(nav("login"));
    await renderLogin(app);
  } else if (state.page === "login") {
    app.appendChild(nav("login"));
    await renderLogin(app);
  } else if (state.page === "submit") {
    await renderSubmit(app);
  } else if (state.page === "submitDoubles") {
    await renderSubmitDoubles(app);
  } else if (state.page === "confirm") {
    await renderConfirm(app);
  } else if (state.page === "profile") {
    await renderProfile(app);
  } else if (state.page === "admin") {
    await renderAdmin(app);
  } else {
    await renderLeaderboard(app);
  }

  app.appendChild(el(`
    <div style="text-align:center;margin-top:1.5rem;padding-bottom:1rem">
      <a href="#" id="rules-link" style="font-size:16px;color:#1a1a1a;text-decoration:underline;font-weight:600;background:#fff3cd;padding:8px 16px;border-radius:8px;display:inline-block">Aturan Main</a>
    </div>
  `));
  app.querySelector("#rules-link").addEventListener("click", (e) => {
    e.preventDefault();
    state.page = "rules";
    render();
  });
}

render();
