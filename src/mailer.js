const nodemailer = require('nodemailer');

/**
 * SMTP mail. Turned on when SMTP_HOST and a sender (MAIL_FROM, or SMTP_USER) are set.
 * Read lazily so the values loaded from .env in server.js are picked up.
 */
let transport;
let transportKey;

function mailConfig() {
  const host = (process.env.SMTP_HOST || '').trim();
  const user = (process.env.SMTP_USER || '').trim();
  const from = (process.env.MAIL_FROM || '').trim() || user;
  if (!host || !from) return null;
  const port = Number(process.env.SMTP_PORT) || 587;
  const secureEnv = (process.env.SMTP_SECURE || '').trim().toLowerCase();
  const secure = secureEnv ? ['1', 'true', 'yes'].includes(secureEnv) : port === 465;
  return { host, port, secure, user, pass: process.env.SMTP_PASS || '', from };
}

function mailEnabled() {
  return mailConfig() !== null;
}

function getTransport(cfg) {
  const key = JSON.stringify(cfg);
  if (!transport || transportKey !== key) {
    transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure, // true = TLS from the start (465); false = STARTTLS when offered (587)
      auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    transportKey = key;
  }
  return transport;
}

async function sendMail({ to, subject, text, html }) {
  const cfg = mailConfig();
  if (!cfg) throw new Error('SMTP is not configured.');
  await getTransport(cfg).sendMail({ from: cfg.from, to, subject, text, html });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Welcome email for a newly added user, with their sign-in details. */
async function sendWelcomeEmail({ user, password, loginUrl, invitedBy }) {
  const lines = [
    `Hi ${user.name},`,
    '',
    `${invitedBy} added you to SecPatchlog, where the team tracks security findings from the scan pipeline.`,
    '',
    `Sign in:            ${loginUrl}`,
    `Email:              ${user.email}`,
    `Temporary password: ${password}`,
    '',
    'Please change your password after you sign in: click your name in the top bar, then Account.',
  ];
  const e = escapeHtml;
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1f2328;line-height:1.5">
<p>Hi ${e(user.name)},</p>
<p>${e(invitedBy)} added you to <strong>SecPatchlog</strong>, where the team tracks security findings from the scan pipeline.</p>
<table style="border-collapse:collapse;margin:12px 0">
<tr><td style="padding:2px 12px 2px 0;color:#59636e">Sign in</td><td><a href="${e(loginUrl)}">${e(loginUrl)}</a></td></tr>
<tr><td style="padding:2px 12px 2px 0;color:#59636e">Email</td><td>${e(user.email)}</td></tr>
<tr><td style="padding:2px 12px 2px 0;color:#59636e">Temporary password</td><td><code style="font-size:14px">${e(password)}</code></td></tr>
</table>
<p>Please change your password after you sign in: click your name in the top bar, then <strong>Account</strong>.</p>
</body></html>`;
  await sendMail({ to: user.email, subject: "You've been added to SecPatchlog", text: lines.join('\n'), html });
}

module.exports = { mailEnabled, sendMail, sendWelcomeEmail };
