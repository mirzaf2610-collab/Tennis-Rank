// Kirim email lewat Gmail SMTP pakai nodemailer.
// Butuh 2 env var: EMAIL_USER (alamat Gmail pengirim) dan EMAIL_APP_PASSWORD (App Password, BUKAN password Gmail biasa).

const nodemailer = require("nodemailer");

let transporter = null;
function getTransporter() {
  if (!transporter) {
    const user = process.env.EMAIL_USER;
    const pass = process.env.EMAIL_APP_PASSWORD;
    if (!user || !pass) {
      throw new Error("EMAIL_USER / EMAIL_APP_PASSWORD belum diatur di environment variables");
    }
    transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user, pass },
    });
  }
  return transporter;
}

async function sendMail({ to, subject, html }) {
  const t = getTransporter();
  const fromName = process.env.EMAIL_FROM_NAME || "PSP Tennis Rank";
  await t.sendMail({
    from: `"${fromName}" <${process.env.EMAIL_USER}>`,
    to,
    subject,
    html,
  });
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
