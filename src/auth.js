const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "ganti-secret-ini-di-env";

function signToken(player) {
  return jwt.sign({ playerId: player.id, email: player.email }, JWT_SECRET, {
    expiresIn: "30d",
  });
}

// Middleware: mengambil playerId dari token, BUKAN dari request body.
// Ini penting supaya user A tidak bisa mengaku-ngaku sebagai user B.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({
      error: { code: "NO_TOKEN", message: "Token tidak ditemukan, silakan login kembali" },
    });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.playerId = payload.playerId;
    next();
  } catch (err) {
    return res.status(401).json({
      error: { code: "INVALID_TOKEN", message: "Token tidak valid atau kedaluwarsa" },
    });
  }
}

module.exports = { signToken, requireAuth };
