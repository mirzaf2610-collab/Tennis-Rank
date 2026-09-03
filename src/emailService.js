// Kirim email pakai Resend (https://resend.com). Pakai fetch bawaan Node, tidak perlu library tambahan.

async function sendPasswordResetEmail(toEmail, toName, resetLink) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error("RESEND_API_KEY belum diatur di environment variables");
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM || "PSP Tennis Rank <onboarding@resend.dev>",
      to: [toEmail],
      subject: "Reset Password - PSP Tennis Rank",
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
          <h2>Reset Password</h2>
          <p>Halo ${toName},</p>
          <p>Kami menerima permintaan untuk reset password akun PSP Tennis Rank Anda. Klik tombol di bawah untuk membuat password baru:</p>
          <p style="margin: 24px 0;">
            <a href="${resetLink}" style="background:#1a1a1a;color:#fff;padding:12px 24px;text-decoration:none;border-radius:8px;display:inline-block;">
              Reset Password
            </a>
          </p>
          <p>Link ini berlaku selama 1 jam. Kalau Anda tidak meminta reset password, abaikan saja email ini.</p>
        </div>
      `,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Gagal mengirim email: ${errBody}`);
  }
}

async function sendVerificationEmail(toEmail, toName, verifyLink) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error("RESEND_API_KEY belum diatur di environment variables");
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM || "PSP Tennis Rank <onboarding@resend.dev>",
      to: [toEmail],
      subject: "Verifikasi Email - PSP Tennis Rank",
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
          <h2>Verifikasi Email Anda</h2>
          <p>Halo ${toName},</p>
          <p>Terima kasih sudah daftar di PSP Tennis Rank. Klik tombol di bawah untuk verifikasi email dan mengaktifkan akun Anda:</p>
          <p style="margin: 24px 0;">
            <a href="${verifyLink}" style="background:#1a1a1a;color:#fff;padding:12px 24px;text-decoration:none;border-radius:8px;display:inline-block;">
              Verifikasi Email
            </a>
          </p>
          <p>Link ini berlaku selama 24 jam. Kalau Anda tidak merasa mendaftar, abaikan saja email ini.</p>
        </div>
      `,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Gagal mengirim email: ${errBody}`);
  }
}

module.exports = { sendPasswordResetEmail, sendVerificationEmail };
