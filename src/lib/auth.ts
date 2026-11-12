import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "../utils/db";
import { sendEmail } from "./email";
import {
  existingAccountEmail,
  RenderedEmail,
  resetPasswordEmail,
  verifyEmail,
  welcomeEmail,
} from "./emails";
import { CLIENT_IP_HEADER } from "./rate-limit";
import { describeError, notifyOps, notifySignup } from "./discord";

const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";

/** The web app's origin, also reachable as 127.0.0.1 (CORS + trusted origins). */
export const frontendOrigins = [frontendUrl, frontendUrl.replace("://localhost", "://127.0.0.1")];
/**
 * Who may create an account: a comma-separated list of emails. Unset or empty = anyone (local
 * development). Deployed, set it to limit sign-ups (a private beta, an internal tool).
 */
const allowedSignups = (process.env.ALLOWED_SIGNUP_EMAILS ?? "")
  .split(",")
  .map(email => email.trim().toLowerCase())
  .filter(Boolean);
// Sign-up, an unverified sign-in, "Resend", a sign-up for an existing email and a password reset
// all send mail; Better Auth limits each route per address (production only), this limits each
// recipient, so a stranger cannot fill someone's inbox, or spend the email quota, from many
// addresses.
const EMAIL_GAP_MS = 60_000;
const EMAILS_A_DAY = 10;
const DAY_MS = 24 * 3600_000;
const sentTo = new Map<string, number[]>();
const mayEmail = (email: string) => {
  const now = Date.now();
  if (sentTo.size > 10_000)
    for (const [key, times] of sentTo) if (times.every(t => now - t > DAY_MS)) sentTo.delete(key);
  const times = (sentTo.get(email) ?? []).filter(t => now - t < DAY_MS);
  if (times.length >= EMAILS_A_DAY || now - (times.at(-1) ?? 0) < EMAIL_GAP_MS) return false;
  sentTo.set(email, [...times, now]);
  return true;
};
/** Sends an auth email unless the recipient had one too recently; a failed send is logged, not thrown. */
const sendAuthEmail = async (to: string, email: RenderedEmail) => {
  if (!mayEmail(to.toLowerCase())) {
    console.log(`[Email] Not sent to ${to}: one went there under a minute ago, or ten today.`);
    return;
  }
  // Thrown, it would fail the sign-up or sign-in after the account exists; "Resend" retries.
  await sendEmail({ to, ...email }).catch(error => {
    console.error("Could not send an auth email:", error);
    void notifyOps(
      "email",
      "Resend refused an auth email",
      `"${email.subject}" was not sent, so new accounts may not get their verification link. ${describeError(error)}`
    );
  });
};

/**
 * The welcome, once per account when it can first be used: at creation for a Google sign-up
 * (verified already), else on verification. Not through `sendAuthEmail`: it follows the
 * verification email by seconds, which that throttle would drop, and it cannot be triggered twice.
 */
const sendWelcome = (user: { email: string; name: string }) =>
  void sendEmail({ to: user.email, ...welcomeEmail(user.name) }).catch(error =>
    console.error("Could not send the welcome email:", error)
  );

const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  baseURL: `${process.env.BETTER_AUTH_URL || "http://localhost:5000"}/api/auth`,
  basePath: "/api/auth",
  trustedOrigins: frontendOrigins,
  advanced: {
    // SameSite=None requires Secure, so only use it when served over https.
    ...((process.env.BETTER_AUTH_URL ?? "").startsWith("https://")
      ? { defaultCookieAttributes: { sameSite: "none", secure: true } }
      : {}),
    // Set by authRoutes from the same address the API's own limits use (lib/rate-limit.ts).
    ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
  },
  emailAndPassword: {
    enabled: true,
    // No session until the address is verified. Sign-up never signs in, and a sign-up
    // for an email that has an account answers like a new one, so neither tells who has one.
    requireEmailVerification: true,
    onExistingUserSignUp: async ({ user }) => {
      // Unverified, the person may simply have lost the first link: a sign-in sends a new one.
      if (!user.emailVerified) return;
      await sendAuthEmail(user.email, existingAccountEmail());
    },
    // Throttled per recipient like the others: Better Auth's 3 a minute is per client
    // address, so many addresses could otherwise fill one inbox with reset links.
    sendResetPassword: async ({ user, url }) => {
      await sendAuthEmail(user.email, resetPasswordEmail(url));
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    // Signing in before verifying sends a fresh link (throttled), and is refused with
    // EMAIL_NOT_VERIFIED, which the web app turns into its "Check your email" screen.
    sendOnSignIn: true,
    autoSignInAfterVerification: true,
    expiresIn: 24 * 3600,
    sendVerificationEmail: async ({ user, url: link }) => {
      if (user.emailVerified) return;
      // Without a callbackURL (a sign-in, or a sign-up over the API) Better Auth sends the link
      // on to "/", the API's own root; the web app's /verify-email opens the app or explains.
      const url = new URL(link);
      if ((url.searchParams.get("callbackURL") ?? "/") === "/")
        url.searchParams.set("callbackURL", `${frontendUrl}/verify-email`);
      await sendAuthEmail(user.email, verifyEmail(url.href));
    },
    // Better Auth calls this only when an unverified account becomes verified, so once.
    afterEmailVerification: async user => sendWelcome(user),
  },
  databaseHooks: {
    user: {
      create: {
        // Covers every way in: email sign-up and a first Google sign-in.
        before: async user => {
          const email = user.email.toLowerCase();
          if (allowedSignups.length && !allowedSignups.includes(email))
            throw new APIError("FORBIDDEN", { message: "Sign-ups are closed." });
          return { data: user };
        },
        // Per-account setup belongs here (a default team, a plan, a billing customer…).
        after: async (user, ctx) => {
          // Not awaited: the owner's ping must not hold up the sign-up (it never rejects).
          void notifySignup(user, ctx?.path);
          if (user.emailVerified) sendWelcome(user);
        },
      },
    },
  },
  socialProviders:
    googleClientId && googleClientSecret
      ? { google: { clientId: googleClientId, clientSecret: googleClientSecret } }
      : {},
});
