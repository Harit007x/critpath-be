import { prisma } from "../utils/db";

// Notices to the owner's Discord channels through incoming webhooks: a URL you POST JSON to, no bot.
// The URL is the credential (anyone holding it can post), so it lives in the environment only.

/** Each channel and the variable holding its webhook; either can be unset without the other. */
const CHANNEL_ENV = {
  signups: "DISCORD_WEBHOOK_SIGNUPS",
  ops: "DISCORD_WEBHOOK_OPS",
} as const;

export type DiscordChannel = keyof typeof CHANNEL_ENV;

/** These hang off request handlers and Node's fetch has no useful timeout of its own. */
const TIMEOUT_MS = 3000;

// Read per call: dotenv-flow loads env in index.ts after imports are evaluated. Production only,
// or the local API's test sign-ups and dev 500s would fill the channels; the override is for
// proving the wiring from a laptop (`pnpm discord:check`).
const shouldSend = () =>
  process.env.NODE_ENV === "production" ||
  (process.env.DISCORD_NOTIFY_NON_PRODUCTION ?? "").toLowerCase() === "true";

const webhookFor = (channel: DiscordChannel) => process.env[CHANNEL_ENV[channel]]?.trim() || null;

// Embed fields render Markdown (masked links too), and a sign-up's name is typed by a stranger.
// Pings are stopped separately, by `allowed_mentions` on every request.
const escapeMarkdown = (text: string) => text.replace(/[\\`*_~|>[\]()#-]/g, "\\$&");

/** An embed field; Discord caps values at 1024 characters. */
const field = (name: string, value: string, inline = true) => {
  const text = escapeMarkdown(value);
  return { name, value: (text.length > 1024 ? `${text.slice(0, 1023)}…` : text) || "—", inline };
};

/**
 * Posts one message. Resolves false for every way it can fail (unset, not production, timeout,
 * refused, deleted webhook), logging which, and never rejects: safe to call without `await`.
 */
export const notify = async (
  channel: DiscordChannel,
  payload: Record<string, unknown>
): Promise<boolean> => {
  const url = webhookFor(channel);
  if (!url || !shouldSend()) return false;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowed_mentions: { parse: [] }, ...payload }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.ok) return true;
    // A deleted webhook looks exactly like a quiet channel, so say so.
    console.error(
      `[Discord] ${channel}: ${response.status === 404 ? "the webhook no longer exists" : `HTTP ${response.status}`}`
    );
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    console.error(`[Discord] ${channel}: ${timedOut ? "timed out" : String(error)}`);
  }
  return false;
};

/** The scripts' accounts (`apitest+…@example.test`), should a test ever run with sending on. */
const isTestAccount = (email: string) => email.toLowerCase().endsWith("@example.test");

/** The signups embed. Exported for the unit test and `pnpm discord:check`. */
export const signupPayload = (notice: {
  name: string;
  email: string;
  /** Better Auth's `ctx.path`: `/sign-up/email`, else Google's callback. */
  path: string | undefined;
  emailVerified: boolean;
  /** Accounts after this one was made, or null when counting failed. */
  total: number | null;
}) => {
  const how = !notice.path?.startsWith("/sign-up")
    ? "Google"
    : notice.emailVerified
      ? "Email (verified)"
      : "Email (awaiting verification)";
  return {
    embeds: [
      {
        title: notice.total ? `🎉 New sign-up · #${notice.total}` : "🎉 New sign-up",
        color: 0x22c55e,
        fields: [
          field("Name", notice.name),
          field("Email", notice.email),
          { name: "Signed up with", value: how, inline: false },
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  };
};

/**
 * Tells the owner someone signed up, from `user.create.after`: so an email sign-up is announced
 * before, and whether or not, it verifies. The hook drops the promise; it never rejects.
 */
export const notifySignup = async (
  user: { name: string; email: string; emailVerified: boolean },
  path: string | undefined
): Promise<boolean> => {
  if (!webhookFor("signups") || !shouldSend() || isTestAccount(user.email)) return false;
  const total = await prisma.user.count().catch(() => null);
  return notify("signups", signupPayload({ ...user, path, total }));
};

/** How long one kind of ops alert stays quiet after it was sent. */
const OPS_QUIET_MS = 6 * 60 * 60 * 1000;
const opsSentAt = new Map<string, number>();

/**
 * Tells the owner the server needs a person: something broken that no user can fix. Throttled to
 * one per `kind` per six hours, in memory, so a failure that repeats on every request (a refused
 * key, a dead mailer) is one message, not a muted channel. A restart forgets, which at worst
 * repeats an alert once per deploy.
 */
export const notifyOps = (kind: string, title: string, detail: string): Promise<boolean> => {
  const now = Date.now();
  const last = opsSentAt.get(kind);
  if (last !== undefined && now - last < OPS_QUIET_MS) return Promise.resolve(false);
  opsSentAt.set(kind, now);
  return notify("ops", {
    embeds: [
      {
        title: `🚨 ${title}`,
        color: 0xd9534f,
        fields: [field("Detail", detail, false)],
        timestamp: new Date().toISOString(),
      },
    ],
  });
};

/** An error as one line for an alert's Detail. */
export const describeError = (error: unknown) =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/** Test-only: forget which alerts were sent. */
export const resetOpsAlerts = () => opsSentAt.clear();
