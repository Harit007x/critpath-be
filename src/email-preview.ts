// Writes every email CritPath sends to HTML and text files, to look at before changing one.
// `pnpm email:preview [dir]` (default .email-preview/); open index.html.
import fs from "fs";
import path from "path";
import {
  existingAccountEmail,
  resetPasswordEmail,
  verifyEmail,
  welcomeEmail,
} from "./lib/emails";

const dir = path.resolve(process.argv[2] ?? ".email-preview");
// Links as production has them; the logo from the file the web app serves it from.
process.env.FRONTEND_URL = "https://critpath.example.com";
const logo = `file://${path.resolve(__dirname, "../../critpath-fe/public/email/critpath-mark.png")}`;
const link =
  "https://critpath.example.com/api/auth/verify-email?token=eyJhbGciOiJIUzI1NiJ9.example&callbackURL=%2Fverify-email";

const emails = {
  verify: verifyEmail(link),
  welcome: welcomeEmail("Ada Lovelace"),
  reset: resetPasswordEmail(
    "https://critpath.example.com/api/auth/reset-password/Xk2example?callbackURL=%2Freset-password"
  ),
  "existing-account": existingAccountEmail(),
};

fs.mkdirSync(dir, { recursive: true });
for (const [name, email] of Object.entries(emails)) {
  fs.writeFileSync(
    path.join(dir, `${name}.html`),
    email.html.replace("https://critpath.example.com/email/critpath-mark.png", logo)
  );
  fs.writeFileSync(path.join(dir, `${name}.txt`), `Subject: ${email.subject}\n\n${email.text}\n`);
}
fs.writeFileSync(
  path.join(dir, "index.html"),
  `<!doctype html><meta charset="utf-8"><title>CritPath emails</title><body style="font-family:sans-serif;margin:24px">` +
    Object.entries(emails)
      .map(
        ([name, email]) =>
          `<h2 style="font-size:14px">${name} · ${email.subject.replace(/</g, "&lt;")}</h2><iframe src="${name}.html" style="width:640px;height:720px;border:1px solid #ddd"></iframe>`
      )
      .join("")
);
console.log(`Wrote ${Object.keys(emails).length} emails to ${dir}/ — open index.html`);
