const API = "/api";
let state = { token: localStorage.getItem("token"), player: null, page: "leaderboard" };

const urlParams = new URLSearchParams(window.location.search);
const resetTokenFromUrl = urlParams.get("resetToken");
const verifyTokenFromUrl = urlParams.get("verifyToken");
if (resetTokenFromUrl) {
  state.page = "resetPassword";
}
if (verifyTokenFromUrl) {
  state.page = "verifyEmail";
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

function nav(active) {
  const items = [["leaderboard", "Ranking"]];
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
        <label>Nama Lengkap</label>
        <input id="f-name" type="text" placeholder="Isi Nama lengkap (akan tampil di tabel rank)" />
      </div>
      <label>Email</label>
      <input id="f-email" type="email" placeholder="disarankan pakai Gmail" />
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
        <button data-mode="single" class="active">Single</button>
        <button data-mode="double">Ganda</button>
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
    </div>
  `);
  container.appendChild(wrap);

  let currentMode = "single";

  async function loadBoard() {
    const list = wrap.querySelector("#lb-list");
    list.innerHTML = "Memuat...";
    const sortBy = wrap.querySelector("#sort-select").value;
    try {
      const endpoint = currentMode === "double" ? "/doubles/leaderboard" : "/leaderboard";
      const { leaderboard } = await api(`${endpoint}?sortBy=${sortBy}`);
      if (leaderboard.length === 0) {
        list.innerHTML = `<p class="muted">Belum ada pemain dengan minimal 3 match.</p>`;
      } else {
        const maxMatches = Math.max(...leaderboard.map((p) => p.matchesPlayed));
        const rows = leaderboard
          .map((p) => {
            const badgeTexts = (p.badges || []).map((b) => `${b.emoji} ${b.label}`);
            if (p.matchesPlayed === maxMatches) badgeTexts.push(`⚡ Antu Lapangan`);
            const gelarText = badgeTexts.length ? badgeTexts.join("<br/>") : `<span class="muted">-</span>`;
            const noRespText = p.noResponseCount > 0
              ? `<span style="color:#c62828">${p.noResponseCount}x</span>`
              : `<span class="muted">0</span>`;
            return `
              <tr>
                <td>${avatarHtml(p.photoUrl, p.name, 22)} ${p.name}</td>
                <td>${Math.round(p.currentRating)}</td>
                <td>${p.matchesPlayed}</td>
                <td>${p.wins}</td>
                <td>${p.losses}</td>
                <td>${p.winRate}%</td>
                <td>${noRespText}</td>
                <td style="font-size:11px">${gelarText}</td>
              </tr>`;
          })
          .join("");
        list.innerHTML = `
          <div style="overflow-x:auto">
            <table class="lb-table">
              <thead>
                <tr><th>Pemain</th><th>Poin</th><th>Main</th><th>W</th><th>L</th><th>Win Rate</th><th>Tdk Respon</th><th>Gelar</th></tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>`;
      }
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

  loadBoard();
}

async function renderSubmit(container) {
  container.appendChild(nav("submit"));
  const wrap = el(`
    <div class="card">
      <h2>Input hasil match</h2>
      <label>Lawan</label>
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
    select.innerHTML = players
      .filter((p) => p.id !== state.player.id)
      .map((p) => `<option value="${p.id}">${p.name}</option>`)
      .join("");
  } catch (err) {
    wrap.querySelector("#f-error").textContent = err.message;
    wrap.querySelector("#f-error").style.display = "block";
  }

  wrap.querySelector("#submit-btn").addEventListener("click", async () => {
    const opponentId = Number(wrap.querySelector("#opponent").value);
    const targetGames = Number(wrap.querySelector("#target-games").value);
    const iWon = wrap.querySelector("#who-won").value === "me";
    const loserGames = Number(wrap.querySelector("#loser-games").value);
    const errorEl = wrap.querySelector("#f-error");
    errorEl.style.display = "none";

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
      <label>Partner Anda (Tim Anda)</label>
      <select id="partner"></select>
      <label>Lawan 1</label>
      <select id="opp1"></select>
      <label>Lawan 2</label>
      <select id="opp2"></select>
      <label>Tim mana yang menang?</label>
      <select id="who-won">
        <option value="team1">Tim saya menang</option>
        <option value="team2">Tim lawan menang</option>
      </select>
      <label>Game yang didapat tim yang kalah (0-5)</label>
      <select id="loser-games">
        ${[0, 1, 2, 3, 4, 5].map((n) => `<option value="${n}">${n}</option>`).join("")}
      </select>
      <div id="f-error" class="error" style="display:none"></div>
      <button id="submit-btn" class="btn">Submit hasil</button>
    </div>
  `);
  container.appendChild(wrap);

  try {
    const { players } = await api("/players");
    const others = players.filter((p) => p.id !== state.player.id);
    const options = others.map((p) => `<option value="${p.id}">${p.name}</option>`).join("");
    wrap.querySelector("#partner").innerHTML = options;
    wrap.querySelector("#opp1").innerHTML = options;
    wrap.querySelector("#opp2").innerHTML = options;
  } catch (err) {
    wrap.querySelector("#f-error").textContent = err.message;
    wrap.querySelector("#f-error").style.display = "block";
  }

  wrap.querySelector("#submit-btn").addEventListener("click", async () => {
    const team1Player2Id = Number(wrap.querySelector("#partner").value);
    const team2Player1Id = Number(wrap.querySelector("#opp1").value);
    const team2Player2Id = Number(wrap.querySelector("#opp2").value);
    const iWon = wrap.querySelector("#who-won").value === "team1";
    const loserGames = Number(wrap.querySelector("#loser-games").value);
    const errorEl = wrap.querySelector("#f-error");
    errorEl.style.display = "none";

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
  const wrap = el(`<div class="card"><h2>Persetujuan Pendaftar Baru</h2><div id="pending-players-list">Memuat...</div></div>`);
  container.appendChild(wrap);

  try {
    const { players } = await api("/admin/pending-players");
    const list = wrap.querySelector("#pending-players-list");
    if (players.length === 0) {
      list.innerHTML = `<p class="muted">Tidak ada pendaftar yang menunggu persetujuan.</p>`;
      return;
    }
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
  } catch (err) {
    wrap.querySelector("#pending-players-list").innerHTML = `<p class="error">${err.message}</p>`;
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

async function renderRules(container) {
  container.appendChild(nav("rules"));
  const wrap = el(`
    <div class="card">
      <h2>Aturan Main</h2>

      <p style="font-size:16px;line-height:1.7">
      Main → Catat → Konfirmasi → Poin Bertambah!<br/>
      Pastikan kamu dan lawan sudah terdaftar di Tennis-Rank.<br/>
      Sebelum bermain, sepakati apakah pertandingan akan dicatat di aplikasi atau tidak.<br/><br/>
      Setelah pertandingan:<br/>
      Input hasil → Lawan konfirmasi → Poin ter-update otomatis.<br/>
      🔔 Jangan lupa ingatkan lawan untuk konfirmasi hasil pertandingan di aplikasi!
      </p>

      <h3 style="margin-top:1.25rem;margin-bottom:0.4rem;font-size:19px;font-weight:700">1. Cara Daftar</h3>
      <p style="font-size:16px;line-height:1.7">
        Pendaftaran terbuka untuk Seluruh Anggota PSP Tennis Club (Karyawan,TKNO, Coach, Caddy dan yang sering main di bersama Tim PSP Tennis Club)
        Daftar akun → verifikasi email → tunggu persetujuan admin . Baru setelah disetujui, akun bisa dipakai Login.
      </p>

      <h3 style="margin-top:1.25rem;margin-bottom:0.4rem;font-size:19px;font-weight:700">2. Format Pertandingan</h3>
      <p style="font-size:16px;line-height:1.7">
        <strong>Single:</strong> bisa pilih format First to 4, 6 (standar), atau 8 game, .
        Format game lebih pendek otomatis dapat poin lebih kecil dibanding format standar, meski dominasinya sama.<br/><br/>
        <strong>Ganda:</strong> format tetap First to 6, tidak ada pilihan format.
      </p>

      <h3 style="margin-top:1.25rem;margin-bottom:0.4rem;font-size:19px;font-weight:700">3. Sistem Poin (ELO)</h3>
      <p style="font-size:16px;line-height:1.7">
        Semua mulai dari rating 1500. Naik-turun tergantung: seberapa kuat lawan (menang lawan lebih kuat = poin lebih besar),
        seberapa telak kemenangan (6-0 lebih besar poinnya dari 6-5), dan status provisional (10 match pertama tiap orang,
        rating bergerak lebih cepat; setelah itu lebih stabil).<br/><br/>
        Untuk Ganda, poin dihitung dari rata-rata rating tim, tapi tiap pemain tetap punya rating individu sendiri.<br/><br/>
        Untuk menjaga keseimbangan kompetisi dan mempertahankan gap antar pemain, poin akan di-reset pada setiap awal season baru (akhir tahun). <br/>
        Namun, seluruh data dan riwayat poin dari season sebelumnya tetap tersimpan dan dapat dilihat kembali dengan memilih season yang diinginkan..
      </p>

      <h3 style="margin-top:1.25rem;margin-bottom:0.4rem;font-size:19px;font-weight:700">4. Konfirmasi Hasil Match</h3>
      <p style="font-size:16px;line-height:1.7">
        <strong>Single:</strong> wajib dikonfirmasi lawan (2 pihak).<br/>
        <strong>Ganda:</strong> cukup 1 wakil dari tiap tim yang konfirmasi (total 2 orang, bebas siapa saja).<br/><br/>
        Kalau ditolak salah satu pihak, match otomatis dibatalkan (tidak mempengaruhi rating). Submit ulang kalau perlu dicatat lagi.<br/><br/>
        Kalau tidak direspon sama sekali dalam <strong>7 hari</strong>, match otomatis dianggap confirmed (yang menang tetap dapat haknya),
        tapi poinnya cuma <strong>setengah</strong> dari perhitungan normal.
      </p>

      <h3 style="margin-top:1.25rem;margin-bottom:0.4rem;font-size:19px;font-weight:700">5. Sanksi Tidak Merespon</h3>
      <p style="font-size:16px;line-height:1.7">
        Setiap kali match auto-confirmed karena Anda tidak merespon dalam 7 hari, tercatat 1x "tidak konfirmasi" di profil anda
        dan di tabel ranking. Kalau sudah 5x, akun otomatis terblokir dan hanya bisa dibuka kembali oleh admin.
      </p>

      <h3 style="margin-top:1.25rem;margin-bottom:0.4rem;font-size:19px;font-weight:700">6. Leaderboard</h3>
      <p style="font-size:16px;line-height:1.7">
        Minimal sudah main 3 kali (Single dan Ganda dihitung terpisah) baru muncul di papan ranking.
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
        ⚡ <strong>Antu Lapangan</strong> — jumlah main terbanyak saat ini
      </p>

      <h3 style="margin-top:1.25rem;margin-bottom:0.4rem;font-size:19px;font-weight:700">8. Etika Bermain</h3>
      <p style="font-size:16px;line-height:1.9">
        ✅ Isi skor jujur sesuai kejadian sebenarnya<br/>
        ✅ Segera konfirmasi kalau dapat notifikasi hasil match<br/>
        ✅ Tetap sportif — ini buat seru-seruan bareng, bukan ajang gengsi
      </p>

      <p class="muted" style="font-size:14px;margin-top:1.25rem;line-height:1.6">
        Rank ini hanya untuk seru-seruan dan motivasi main, bukan patokan skill yang presisi.
      </p>

      <p class="muted" style="font-size:14px;margin-top:1rem;border-top:1px solid #eee;padding-top:1rem;line-height:1.6">
        Aplikasi ini khusus internal PSP Tennis Club. Kalau ingin dibuatkan untuk komunitas lain,
        silakan kontak admin via email PSPClub2026@gmail.com.
      </p>
    </div>
  `);
  container.appendChild(wrap);
}

async function renderProfile(container) {
  container.appendChild(nav("profile"));
  const wrap = el(`
    <div class="card">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:1rem">
        <div id="avatar-preview">${avatarHtml(state.player.photoUrl, state.player.name, 56)}</div>
        <h2 style="margin:0">${state.player.name}</h2>
      </div>
      <label>Ganti foto profil (JPG/PNG, maks 2MB)</label>
      <input id="photo-input" type="file" accept="image/jpeg,image/png" />
      <div id="photo-error" class="error" style="display:none"></div>
      <button id="photo-upload-btn" class="btn secondary">Upload Foto</button>
      <div id="profile-stats" style="margin-top:1rem">Memuat...</div>
      <button id="logout-btn" class="btn secondary">Keluar</button>
    </div>
  `);
  container.appendChild(wrap);
  wrap.querySelector("#logout-btn").addEventListener("click", logout);

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
    const singleBadgesHtml = (player.singlesBadges || [])
      .map((b) => `<span style="display:inline-block;background:#fff3cd;border:1px solid #f0d68a;border-radius:20px;padding:4px 12px;font-size:12px;margin:2px 4px 2px 0">${b.emoji} ${b.label}</span>`)
      .join("");
    const doubleBadgesHtml = (player.doublesBadges || [])
      .map((b) => `<span style="display:inline-block;background:#fff3cd;border:1px solid #f0d68a;border-radius:20px;padding:4px 12px;font-size:12px;margin:2px 4px 2px 0">${b.emoji} ${b.label}</span>`)
      .join("");

    wrap.querySelector("#profile-stats").innerHTML = `
      <div style="background:linear-gradient(135deg,#1a1a1a,#3a3a3a);border-radius:14px;padding:1.25rem;color:#fff;margin-bottom:1rem">
        <div style="font-size:13px;opacity:0.7;margin-bottom:8px">KARTU STATISTIK</div>
        <div style="display:flex;justify-content:space-between;margin-bottom:12px">
          <div>
            <div style="font-size:11px;opacity:0.7">Single</div>
            <div style="font-size:22px;font-weight:600">${Math.round(player.currentRating)}</div>
            <div style="font-size:11px;opacity:0.8">${player.matchesPlayed}x main &middot; ${player.singlesWins}M-${player.singlesLosses}K &middot; ${player.singlesWinRate}%</div>
          </div>
          <div style="text-align:right">
            <div style="font-size:11px;opacity:0.7">Ganda</div>
            <div style="font-size:22px;font-weight:600">${Math.round(player.doublesRating)}</div>
            <div style="font-size:11px;opacity:0.8">${player.doublesMatchesPlayed}x main &middot; ${player.doublesWins}M-${player.doublesLosses}K &middot; ${player.doublesWinRate}%</div>
          </div>
        </div>
        ${singleBadgesHtml || doubleBadgesHtml ? `
          <div style="border-top:1px solid rgba(255,255,255,0.2);padding-top:10px;margin-top:4px">
            ${singleBadgesHtml ? `<div style="margin-bottom:6px">${singleBadgesHtml}</div>` : ""}
            ${doubleBadgesHtml ? `<div>${doubleBadgesHtml}</div>` : ""}
          </div>
        ` : `<div style="font-size:12px;opacity:0.6;border-top:1px solid rgba(255,255,255,0.2);padding-top:10px">Belum ada gelar. Terus main untuk dapat gelar!</div>`}
      </div>
      <div class="row"><span>Status Single</span><span>${player.isProvisional ? "Provisional" : "Stabil"}</span></div>
      <div class="row"><span>Status Ganda</span><span>${player.doublesIsProvisional ? "Provisional" : "Stabil"}</span></div>
    `;
  } catch (err) {
    wrap.querySelector("#profile-stats").innerHTML = `<p class="error">${err.message}</p>`;
  }

  const historyWrap = el(`<div class="card"><h2>Histori match</h2><div id="history-list">Memuat...</div></div>`);
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
          return `<div class="row"><span>${won ? "Menang" : "Kalah"} vs ${opponent} (${m.score})</span><span>${changeText}</span></div>`;
        })
        .join("");
    }
  } catch (err) {
    historyWrap.querySelector("#history-list").innerHTML = `<p class="error">${err.message}</p>`;
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
