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

function nav(active) {
  const items = [["leaderboard", "Ranking"]];
  if (state.token) {
    items.push(["submit", "Input Single"], ["submitDoubles", "Input Ganda"], ["confirm", "Konfirmasi"], ["profile", "Profil"]);
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
      <input id="f-email" type="email" placeholder="nama@pusri.co.id" />
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
      <div class="nav" style="margin-bottom:1rem">
        <button data-mode="single" class="active">Single</button>
        <button data-mode="double">Ganda</button>
      </div>
      <div id="lb-list">Memuat...</div>
    </div>
  `);
  container.appendChild(wrap);

  async function loadBoard(mode) {
    const list = wrap.querySelector("#lb-list");
    list.innerHTML = "Memuat...";
    try {
      const endpoint = mode === "double" ? "/doubles/leaderboard" : "/leaderboard";
      const { leaderboard } = await api(endpoint);
      if (leaderboard.length === 0) {
        list.innerHTML = `<p class="muted">Belum ada pemain dengan minimal 3 match.</p>`;
      } else {
        list.innerHTML = leaderboard
          .map(
            (p) => `
          <div class="row">
            <span style="display:flex;align-items:center;gap:8px">
              <span class="rank-badge">#${p.rank}</span>
              ${avatarHtml(p.photoUrl, p.name, 28)}
              ${p.name}
            </span>
            <span>${Math.round(p.currentRating)} <span class="muted">(${p.matchesPlayed}x)</span></span>
          </div>`
          )
          .join("");
      }
    } catch (err) {
      list.innerHTML = `<p class="error">${err.message}</p>`;
    }
  }

  wrap.querySelectorAll("[data-mode]").forEach((b) => {
    b.addEventListener("click", () => {
      wrap.querySelectorAll("[data-mode]").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      loadBoard(b.dataset.mode);
    });
  });

  loadBoard("single");
}

async function renderSubmit(container) {
  container.appendChild(nav("submit"));
  const wrap = el(`
    <div class="card">
      <h2>Input hasil match</h2>
      <label>Lawan</label>
      <select id="opponent"></select>
      <label>Siapa yang menang?</label>
      <select id="who-won">
        <option value="me">Saya menang</option>
        <option value="opponent">Lawan menang</option>
      </select>
      <label>Game yang didapat pihak kalah (0-5)</label>
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
    const iWon = wrap.querySelector("#who-won").value === "me";
    const loserGames = Number(wrap.querySelector("#loser-games").value);
    const errorEl = wrap.querySelector("#f-error");
    errorEl.style.display = "none";

    const winnerId = iWon ? state.player.id : opponentId;
    const loserId = iWon ? opponentId : state.player.id;

    try {
      const data = await api("/matches", {
        method: "POST",
        body: JSON.stringify({ winnerId, loserId, loserGames }),
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
      alert(data.message || "Hasil match ganda dikirim, menunggu konfirmasi 3 pemain lain.");
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
    wrap.querySelector("#profile-stats").innerHTML = `
      <div class="row"><span><strong>Single</strong></span><span></span></div>
      <div class="row"><span>Rating</span><span>${Math.round(player.currentRating)}</span></div>
      <div class="row"><span>Jumlah match</span><span>${player.matchesPlayed}</span></div>
      <div class="row"><span>Status</span><span>${player.isProvisional ? "Provisional" : "Stabil"}</span></div>
      <div class="row" style="margin-top:0.5rem"><span><strong>Ganda</strong></span><span></span></div>
      <div class="row"><span>Rating</span><span>${Math.round(player.doublesRating)}</span></div>
      <div class="row"><span>Jumlah match</span><span>${player.doublesMatchesPlayed}</span></div>
      <div class="row"><span>Status</span><span>${player.doublesIsProvisional ? "Provisional" : "Stabil"}</span></div>
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
          const changeText = change != null ? (change >= 0 ? `+${Math.round(change)}` : Math.round(change)) : m.status;
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
  app.appendChild(el(`<h1>Tennis Ranking Pusri</h1>`));

  if (state.token && !state.player) loadAuth();

  if (state.page === "resetPassword") return renderResetPassword(app);
  if (state.page === "verifyEmail") return renderVerifyEmail(app);

  const protectedPages = ["submit", "submitDoubles", "confirm", "profile"];
  if (!state.token && protectedPages.includes(state.page)) {
    // Perlu login untuk halaman ini
    app.appendChild(nav("login"));
    return renderLogin(app);
  }

  if (state.page === "login") {
    app.appendChild(nav("login"));
    return renderLogin(app);
  }
  if (state.page === "submit") return renderSubmit(app);
  if (state.page === "submitDoubles") return renderSubmitDoubles(app);
  if (state.page === "confirm") return renderConfirm(app);
  if (state.page === "profile") return renderProfile(app);
  return renderLeaderboard(app);
}

render();
