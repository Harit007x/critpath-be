// End-to-end smoke test for the API's auth and profile routes. Needs the API running (pnpm dev)
// with ALLOW_ACCOUNT_DELETION=true, so the throwaway account it creates can be deleted at the end.
// Usage: pnpm smoke
import { verificationToken, verifyPath } from "./verify-email.mjs";

const base = process.env.API_URL || "http://localhost:5000/api";
const origin = process.env.WEB_ORIGIN || "http://localhost:5173";
let cookie = "";
let failed = 0;

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", origin, cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
const check = (label, ok, extra = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${extra ? " — " + extra : ""}`);
};

check("health: the API and database are up", (await call("GET", "/health")).status === 200);

// A fixed address; a run that died before deleting it left the account behind, so delete it first.
const email = "apitest+smoke@example.test";
const password = "smoke-test-pass-1";
if ((await call("POST", "/auth/sign-in/email", { email, password })).status === 200) {
  await call("DELETE", "/users/me", { email });
  cookie = "";
}

// Email verification: no session until the emailed link is opened (verify-email.mjs signs the same
// link). Sign-up and resend answer the same for any email, so neither tells who has an account.
const signedUp = await call("POST", "/auth/sign-up/email", { name: "Api Test", email, password });
check("verification: sign-up makes an unverified account and does not sign in", signedUp.status === 200 && signedUp.json.token === null && signedUp.json.user.emailVerified === false && (await call("GET", "/users/me")).status === 401, String(signedUp.status));
const earlySignIn = await call("POST", "/auth/sign-in/email", { email, password });
check("verification: signing in before verifying is refused", earlySignIn.status === 403 && earlySignIn.json.code === "EMAIL_NOT_VERIFIED", `${earlySignIn.status} ${earlySignIn.json?.code}`);
const signUpAgain = await call("POST", "/auth/sign-up/email", { name: "Someone Else", email, password: "another-pass-123" });
const resent = await Promise.all([email, `nobody-${email}`].map((to) => call("POST", "/auth/send-verification-email", { email: to })));
check("verification: a second sign-up and a resend answer like any other email", signUpAgain.status === 200 && signUpAgain.json.token === null && resent.every((r) => r.status === 200 && r.json.status === true), [signUpAgain, ...resent].map((r) => r.status).join(","));
const badLinks = await Promise.all([
  call("GET", "/auth/verify-email?token=not-a-token"),
  call("GET", `/auth/verify-email?token=${verificationToken(email, -60)}`),
  call("GET", `/auth/verify-email?token=${verificationToken(email).slice(0, -2)}xx`),
]);
check("verification: a bad, expired or forged link verifies nothing", badLinks.map((r) => r.json?.code).join(",") === "INVALID_TOKEN,TOKEN_EXPIRED,INVALID_TOKEN" && (await call("GET", "/users/me")).status === 401, badLinks.map((r) => r.json?.code).join(","));
const verified = await call("GET", verifyPath(email));
const me = await call("GET", "/users/me");
check("verification: the emailed link verifies and signs in", verified.status === 200 && me.status === 200 && me.json.data.emailVerified === true, `${verified.status},${me.status}`);
const passwordIn = await call("POST", "/auth/sign-in/email", { email, password });
check("sign-in: once verified, the password signs in", passwordIn.status === 200 && !!passwordIn.json.token, String(passwordIn.status));

const deletionCheck = await call("DELETE", "/users/me", { email: `not-${email}` });
if (deletionCheck.json?.code === "ACCOUNT_DELETION_DISABLED") {
  console.error(`Start the API with ALLOW_ACCOUNT_DELETION=true: ${email} was created and cannot be deleted.`);
  process.exit(1);
}
check("account: deleting needs the account's own email", deletionCheck.status === 400 && deletionCheck.json.code === "EMAIL_MISMATCH");

// Profile.
const renamed = await call("PATCH", "/users/me", { name: "  Ada Lovelace  " });
check("profile: the name is trimmed and saved", renamed.status === 200 && renamed.json.data.name === "Ada Lovelace");
check("profile: an empty name is refused", (await call("PATCH", "/users/me", { name: "   " })).status === 400);
check("profile: the photo URL must be a URL", (await call("PATCH", "/users/me", { image: "javascript:alert(1)" })).status === 400);

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const putPhoto = (blob, name) => {
  const form = new FormData();
  if (blob) form.append("image", blob, name);
  return fetch(`${base}/users/me/image`, { method: "PUT", body: form, headers: { origin, cookie } }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
};
const photoSet = await putPhoto(new Blob([PNG], { type: "image/png" }), "me.png");
const photoPath = (photoSet.json?.data?.image ?? "").replace(/^.*\/api/, "");
const fetchPhoto = (jar) => fetch(base + photoPath, { headers: { origin, cookie: jar } });
const selfPhoto = await fetchPhoto(cookie);
check("profile photo: set, and served sandboxed", photoSet.status === 200 && photoPath.startsWith(`/users/${me.json.data.id}/image?v=`) && !("imageKey" in photoSet.json.data) && selfPhoto.status === 200 && selfPhoto.headers.get("content-type") === "image/png" && selfPhoto.headers.get("content-security-policy")?.includes("sandbox"), `${photoSet.status} ${photoPath} ${selfPhoto.status}`);
check("profile photo: needs a session", (await fetchPhoto("")).status === 401);
const badPhotos = await Promise.all([
  putPhoto(new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], { type: "image/svg+xml" }), "me.svg"),
  putPhoto(new Blob(["not a png"], { type: "image/png" }), "me.png"),
  putPhoto(null),
  putPhoto(new Blob(["GIF89a\x01\x00\x01\x00\x00\x00\x00;"], { type: "image/gif" }), "me.gif"),
]);
check("profile photo: an SVG, a fake PNG, no file or a GIF is refused", badPhotos.every((r) => r.status === 400) && (await fetchPhoto(cookie)).status === 200, badPhotos.map((r) => r.status).join(","));
const photoGone = await call("DELETE", "/users/me/image");
check("profile photo: removing it", photoGone.status === 200 && photoGone.json.data.image === null && (await fetchPhoto(cookie)).status === 404);

// Sign-out, then delete the account.
const jar = cookie;
check("sign-out ends the session", (await call("POST", "/auth/sign-out", {})).status === 200 && (await call("GET", "/users/me")).status === 401);
cookie = jar;
await call("POST", "/auth/sign-in/email", { email, password });
const gone = await call("DELETE", "/users/me", { email });
check("account: deleted", gone.status === 200 && (await call("POST", "/auth/sign-in/email", { email, password })).status === 401);

console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
