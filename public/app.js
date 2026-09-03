const API = "/api";
let state = { token: localStorage.getItem("token"), player: null, page: "leaderboard" };

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

function nav(active) {
  const items = [
    ["leaderboard", "Ranking"],
    ["submit", "Input match"],
    ["confirm", "Konfirmasi"],
    ["profile", "Profil"],
  ];
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
      let data;
      if (mode === "register") {
        if (!name) throw new Error("Nama wajib diisi");
        data = await api("/auth/register", { method: "POST", body: JSON.stringify({ name, email, password }) });
      } else {
        data = await api("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      }
      saveAuth(data.token, data.player);
      state.page = "leaderboard";
      render();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = "block";
    }
  });
  container.appendChild(box);
}

async function renderLeaderboard(container) {
  container.appendChild(nav("leaderboard"));
  const wrap = el(`<div class="card"><h2>Ranking</h2><div id="lb-list">Memuat...</div></div>`);
  container.appendChild(wrap);
  try {
    const { leaderboard } = await api("/leaderboard");
    const list = wrap.querySelector("#lb-list");
    if (leaderboard.length === 0) {
      list.innerHTML = `<p class="muted">Belum ada pemain dengan minimal 3 match.</p>`;
    } else {
      list.innerHTML = leaderboard
        .map(
          (p) => `
        <div class="row">
          <span><span class="rank-badge">#${p.rank}</span>${p.name}</span>
          <span>${Math.round(p.currentRating)} <span class="muted">(${p.matchesPlayed}x)</span></span>
        </div>`
        )
        .join("");
    }
  } catch (err) {
    wrap.querySelector("#lb-list").innerHTML = `<p class="error">${err.message}</p>`;
  }
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

async function renderConfirm(container) {
  container.appendChild(nav("confirm"));
  const wrap = el(`<div class="card"><h2>Menunggu konfirmasi</h2><div id="pending-list">Memuat...</div></div>`);
  container.appendChild(wrap);

  try {
    const { pending } = await api("/players/me/pending-confirmations");
    const list = wrap.querySelector("#pending-list");
    if (pending.length === 0) {
      list.innerHTML = `<p class="muted">Tidak ada match yang menunggu konfirmasi Anda.</p>`;
      return;
    }
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
  } catch (err) {
    wrap.querySelector("#pending-list").innerHTML = `<p class="error">${err.message}</p>`;
  }
}

async function renderProfile(container) {
  container.appendChild(nav("profile"));
  const wrap = el(`
    <div class="card">
      <h2>${state.player.name}</h2>
      <div id="profile-stats">Memuat...</div>
      <button id="logout-btn" class="btn secondary">Keluar</button>
    </div>
  `);
  container.appendChild(wrap);
  wrap.querySelector("#logout-btn").addEventListener("click", logout);

  try {
    const { player } = await api(`/players/${state.player.id}`);
    wrap.querySelector("#profile-stats").innerHTML = `
      <div class="row"><span>Rating</span><span>${Math.round(player.currentRating)}</span></div>
      <div class="row"><span>Jumlah match</span><span>${player.matchesPlayed}</span></div>
      <div class="row"><span>Status</span><span>${player.isProvisional ? "Provisional" : "Stabil"}</span></div>
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

  if (!state.token) {
    return renderLogin(app);
  }
  if (!state.player) loadAuth();

  if (state.page === "leaderboard") return renderLeaderboard(app);
  if (state.page === "submit") return renderSubmit(app);
  if (state.page === "confirm") return renderConfirm(app);
  if (state.page === "profile") return renderProfile(app);
}

render();
