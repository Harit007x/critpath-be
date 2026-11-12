// Every email CritPath sends, in one layout. Email clients are not browsers: Gmail drops
// <style> in some views and never shows SVG, Outlook ignores padding on links and most of CSS. So
// layout is tables, every style is inline, the button is a table cell with `bgcolor`, the logo is
// a PNG, and the <style> block only adds dark mode where a client honours it (Apple Mail; Gmail
// recolours on its own). Content is plain text, escaped here, so a stranger's workspace or
// display name can never become markup.

// lib/oauth.ts has the same, but importing it would bring the database into `email:preview`.
const frontendUrl = () => (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/$/, "");
/** The product's name and site, as every email names them; the site is the app unless SITE_URL is set. */
const APP_NAME = process.env.APP_NAME || "CritPath";
const siteUrl = () => (process.env.SITE_URL || frontendUrl()).replace(/\/$/, "");

/** What one email says; the layout decides how it looks. */
export type EmailContent = {
  subject: string;
  /** The line inboxes show after the subject. */
  preheader: string;
  heading: string;
  paragraphs: string[];
  button: { label: string; url: string };
  /** Small print under the button: how long the link lasts, what to do if unexpected. */
  note: string;
  /** The footer's "why you got this". */
  reason: string;
};

export type RenderedEmail = { subject: string; html: string; text: string };

export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

// The app's tokens (critpath-fe/src/index.css) in hex: zinc, and primary = green-700.
const C = {
  page: "#f4f4f5",
  card: "#ffffff",
  border: "#e4e4e7",
  heading: "#18181b",
  body: "#3f3f46",
  muted: "#71717a",
  primary: "#15803d",
  onPrimary: "#ffffff",
};
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const DARK_MODE = `
:root{color-scheme:light dark;supported-color-schemes:light dark}
@media (prefers-color-scheme:dark){
  .s-page{background:#09090b!important}
  .s-card{background:#18181b!important;border-color:#27272a!important}
  .s-heading{color:#fafafa!important}
  .s-body{color:#d4d4d8!important}
  .s-muted{color:#a1a1aa!important}
  .s-rule{border-color:#27272a!important}
  .s-link{color:#4ade80!important}
}`;

export const renderEmail = (email: EmailContent): RenderedEmail => {
  const e = escapeHtml;
  const url = e(email.button.url);
  const paragraphs = email.paragraphs
    .map(
      p =>
        `<p class="s-body" style="margin:0 0 16px;font-size:15px;line-height:24px;color:${C.body}">${e(p)}</p>`
    )
    .join("");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${e(email.subject)}</title>
<style>${DARK_MODE}</style>
</head>
<body class="s-page" style="margin:0;padding:0;background:${C.page};font-family:${FONT}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${e(email.preheader)}${"&#847; &zwnj; ".repeat(40)}</div>
<table role="presentation" class="s-page" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.page}" style="background:${C.page}">
<tr><td align="center" style="padding:40px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px">
<tr><td style="padding:0 4px 20px">
<a href="${e(siteUrl())}" style="text-decoration:none"><img src="${e(frontendUrl())}/email/critpath-mark.png" width="32" height="32" alt="${e(APP_NAME)}" style="display:inline-block;vertical-align:middle;border:0"><span class="s-heading" style="display:inline-block;vertical-align:middle;margin-left:10px;font-size:18px;font-weight:600;letter-spacing:-0.2px;color:${C.heading}">${e(APP_NAME)}</span></a>
</td></tr>
<tr><td class="s-card" bgcolor="${C.card}" style="background:${C.card};border:1px solid ${C.border};border-radius:12px;padding:32px">
<h1 class="s-heading" style="margin:0 0 16px;font-size:22px;line-height:30px;font-weight:600;letter-spacing:-0.3px;color:${C.heading}">${e(email.heading)}</h1>
${paragraphs}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px">
<tr><td bgcolor="${C.primary}" style="background:${C.primary};border-radius:8px">
<a href="${url}" target="_blank" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;line-height:20px;color:${C.onPrimary};text-decoration:none;border-radius:8px">${e(email.button.label)}</a>
</td></tr>
</table>
<p class="s-muted" style="margin:0 0 4px;font-size:13px;line-height:20px;color:${C.muted}">Or paste this link into your browser:</p>
<p style="margin:0 0 24px;font-size:13px;line-height:20px;word-break:break-all"><a class="s-link" href="${url}" target="_blank" style="color:${C.primary};text-decoration:underline">${url}</a></p>
<p class="s-muted s-rule" style="margin:0;padding-top:20px;border-top:1px solid ${C.border};font-size:13px;line-height:20px;color:${C.muted}">${e(email.note)}</p>
</td></tr>
<tr><td style="padding:20px 4px 0">
<p class="s-muted" style="margin:0 0 6px;font-size:12px;line-height:18px;color:${C.muted}">${e(email.reason)}</p>
<p class="s-muted" style="margin:0;font-size:12px;line-height:18px;color:${C.muted}">${e(APP_NAME)} · <a class="s-muted" href="${e(siteUrl())}" style="color:${C.muted};text-decoration:underline">${e(siteUrl().replace(/^https?:\/\//, ""))}</a></p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  // The plain-text part: what text-only clients show, and what spam filters expect beside HTML.
  const text = [
    email.heading,
    ...email.paragraphs,
    `${email.button.label}: ${email.button.url}`,
    email.note,
    `--\n${email.reason}\n${APP_NAME} · ${siteUrl()}`,
  ].join("\n\n");

  return { subject: email.subject, html, text };
};

/** Sign-up, or a sign-in before verifying (lib/auth.ts). */
export const verifyEmail = (url: string) =>
  renderEmail({
    subject: `Verify your email for ${APP_NAME}`,
    preheader: `Confirm your address to open your ${APP_NAME} account.`,
    heading: "Verify your email",
    paragraphs: [`Welcome to ${APP_NAME}. Confirm this is your email address to finish signing up.`],
    button: { label: "Verify email", url },
    note: `The link works for 24 hours. If you didn't create a ${APP_NAME} account, you can ignore this email.`,
    reason: `You got this email because someone signed up for ${APP_NAME} with this address.`,
  });

/** Once per account, when it can first be used (lib/auth.ts, `sendWelcome`). */
export const welcomeEmail = (name: string) => {
  const first = name.trim().split(/\s+/)[0];
  return renderEmail({
    subject: `Welcome to ${APP_NAME}`,
    preheader: "Your account is ready.",
    heading: `Welcome to ${APP_NAME}`,
    paragraphs: [
      first ? `Hi ${first}, your ${APP_NAME} account is ready.` : `Your ${APP_NAME} account is ready.`,
    ],
    button: { label: `Open ${APP_NAME}`, url: frontendUrl() },
    note: "Reply to this email if you have any questions.",
    reason: `You got this email because you created a ${APP_NAME} account with this address.`,
  });
};

/** "Forgot password" (lib/auth.ts); Better Auth's reset links last an hour. */
export const resetPasswordEmail = (url: string) =>
  renderEmail({
    subject: `Reset your ${APP_NAME} password`,
    preheader: `Choose a new password for your ${APP_NAME} account.`,
    heading: "Reset your password",
    paragraphs: [
      `Someone asked to reset the password of your ${APP_NAME} account. Use the link below to choose a new one.`,
    ],
    button: { label: "Choose a new password", url },
    note: "The link works for 1 hour. If you didn't ask for this, you can ignore this email: your password stays the same.",
    reason: `You got this email because a password reset was requested for this address on ${APP_NAME}.`,
  });

/** A sign-up with an email that already has a verified account (lib/auth.ts). */
export const existingAccountEmail = () =>
  renderEmail({
    subject: `You already have a ${APP_NAME} account`,
    preheader: "Someone tried to sign up with this email, which already has an account.",
    heading: "You already have an account",
    paragraphs: [
      `Someone tried to create a ${APP_NAME} account with this email address, which already has one.`,
    ],
    button: { label: "Sign in", url: `${frontendUrl()}/login` },
    note: "Forgot your password? Reset it from the sign-in page. If this wasn't you, you can ignore this email.",
    reason: `You got this email because someone tried to sign up for ${APP_NAME} with this address.`,
  });
