import { createHash, timingSafeEqual } from "crypto";
import { isIP } from "net";
import type { Request, Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";

/** Our own proxy (the web app's `worker/index.ts`) names the visitor here, with the shared key beside it. */
export const VISITOR_IP_HEADER = "x-critpath-visitor-ip";
export const PROXY_KEY_HEADER = "x-critpath-proxy-key";

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Hashed first so the comparison is constant-time whatever the lengths. */
function fromOwnProxy(req: Request): boolean {
  const secret = process.env.EDGE_PROXY_SECRET;
  const key = req.header(PROXY_KEY_HEADER);
  return !!secret && !!key && timingSafeEqual(digest(key), digest(secret));
}

/**
 * The address a request came from: what our proxy names, else the leftmost X-Forwarded-For entry,
 * else the socket.
 *
 * Railway's edge replaces any X-Forwarded-For with the address that connected to it, which behind
 * a proxy is the proxy's (Vercel's AWS addresses, then Cloudflare's: seen in production's request
 * log, 2026-10-27). So the Cloudflare Worker sends the visitor in VISITOR_IP_HEADER, believed only
 * with EDGE_PROXY_SECRET in PROXY_KEY_HEADER, since anyone can call the Railway URL directly and
 * name any address. A request straight to Railway gets its own address from Railway's
 * X-Forwarded-For. Express's `trust proxy` is not used: it counts hops, and none of this is hops.
 * The request log prints this address, which is how to check it is the visitor and not a proxy.
 * Locally there is no proxy, so a client can choose its own address; the smoke test relies on that.
 */
export function clientIp(req: Request): string {
  const visitor = fromOwnProxy(req) ? (req.header(VISITOR_IP_HEADER)?.trim() ?? "") : "";
  const first = req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  const ip = isIP(visitor) ? visitor : isIP(first) ? first : (req.socket.remoteAddress ?? "");
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

/** Set on /api/auth requests from `clientIp`, and the only header Better Auth reads an IP from. */
export const CLIENT_IP_HEADER = "x-critpath-client-ip";

/** IPv6 is keyed by its /64, so one machine cannot get a fresh allowance per address. */
const byIp = (req: Request) => {
  const ip = clientIp(req);
  return isIP(ip) ? ipKeyGenerator(ip) : "unknown";
};

type Reply = (res: Response, message: string) => void;

const apiReply: Reply = (res, message) =>
  res.status(429).json({ success: false, message, code: "RATE_LIMITED" });

/**
 * A limiter for any route: `limit` requests per `minutes` per address (or per `key`). With
 * `onlySuccesses`, refused requests do not count. Use it beside a route's own checks, e.g.
 * `router.post("/contact", limiter(60, 10), validate(schema), handler)`.
 */
export const limiter = (
  minutes: number,
  limit: number,
  options: { key?: (req: Request) => string; onlySuccesses?: boolean; reply?: Reply } = {}
) =>
  rateLimit({
    windowMs: minutes * 60_000,
    limit,
    keyGenerator: options.key ?? byIp,
    skipFailedRequests: options.onlySuccesses ?? false,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    // clientIp reads X-Forwarded-For itself, so the check for a header without `trust proxy` is noise.
    validate: { xForwardedForHeader: false },
    handler: (_req, res) =>
      (options.reply ?? apiReply)(res, "Too many requests. Wait a little and try again."),
  });
