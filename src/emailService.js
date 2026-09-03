// Kirim email lewat Resend API (HTTPS, kompatibel dengan Railway free plan yang blokir SMTP).

async function sendMail({ to, subject, html }) {
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
      from: process.env.EMAIL_FROM || "PSP Tennis Rank <noreply@mail.bicycle-miniature.com>",
      to: [to],
      subject,
      html,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Gagal mengirim email: ${errBody}`);
  }
}

async function sendPasswordResetEmail(toEmail, toName, resetLink) {
  await sendMail({
    to: toEmail,
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
  });
}

async function sendVerificationEmail(toEmail, toName, verifyLink) {
  await sendMail({
    to: toEmail,
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
  });
}

module.exports = { sendPasswordResetEmail, sendVerificationEmail };
