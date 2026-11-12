// Accounts must verify their email before they can sign in, and the test runs sign up
// throwaway ones. The link Better Auth emails is an HS256 JWT signed with BETTER_AUTH_SECRET, so
// this signs the same one: the API needs no test-only way around verification. The secret is the
// one the API under test reads: BETTER_AUTH_SECRET from this process, else critpath-be's .env files
// (read, not loaded, so nothing else in them reaches the script), else Better Auth's development
// default. Start the API and the script with the same value.
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenvFlow from "dotenv-flow";

const secret = () => {
  if (process.env.BETTER_AUTH_SECRET) return process.env.BETTER_AUTH_SECRET;
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const files = dotenvFlow.listFiles({ path: dir, node_env: process.env.NODE_ENV });
  return (files.length && dotenvFlow.parse(files).BETTER_AUTH_SECRET) || "better-auth-secret-12345678901234567890";
};

const b64 = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

/** A verification token for `email`, as Better Auth's own `createEmailVerificationToken` makes it. */
export function verificationToken(email, expiresIn = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: "HS256" })}.${b64({ email: email.toLowerCase(), iat: now, exp: now + expiresIn })}`;
  return `${unsigned}.${crypto.createHmac("sha256", secret()).update(unsigned).digest("base64url")}`;
}

/** The path (under /api) of the link in the verification email; opening it verifies and signs in. */
export const verifyPath = (email) => `/auth/verify-email?token=${verificationToken(email)}`;
