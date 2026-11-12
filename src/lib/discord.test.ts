import http from "http";
import type { AddressInfo } from "net";
import type { NextFunction, Request, Response } from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../utils/db", () => ({ prisma: { user: { count: async () => 42 } } }));
const {
  notify,
  notifyOps,
  notifySignup,
  resetOpsAlerts,
  signupPayload,
} = await import("./discord");
const { errorHandler } = await import("../middlewares/errorHandler");
const { HttpError } = await import("../utils/http");

const user = { name: "Ada", email: "ada@example.com", emailVerified: false };

/** A stand-in for Discord's webhook endpoint that records what it receives. */
let status = 204;
const received: { url: string; body: any }[] = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", chunk => (body += chunk));
  req.on("end", () => {
    received.push({ url: req.url!, body: JSON.parse(body) });
    res.writeHead(status).end();
  });
});
let base = "";

beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const ENV = ["NODE_ENV", "DISCORD_WEBHOOK_SIGNUPS", "DISCORD_WEBHOOK_OPS"] as const;
const saved = Object.fromEntries(ENV.map(name => [name, process.env[name]]));
const sending = () => {
  process.env.NODE_ENV = "production";
  process.env.DISCORD_WEBHOOK_SIGNUPS = `${base}/signups`;
  process.env.DISCORD_WEBHOOK_OPS = `${base}/ops`;
};
afterEach(() => {
  for (const name of ENV)
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  delete process.env.DISCORD_NOTIFY_NON_PRODUCTION;
  received.length = 0;
  status = 204;
  resetOpsAlerts();
  vi.restoreAllMocks();
});

describe("signupPayload", () => {
  it("says how the account signed up", () => {
    const email = signupPayload({ ...user, path: "/sign-up/email", total: 42 });
    expect(email.embeds[0].title).toBe("🎉 New sign-up · #42");
    expect(email.embeds[0].fields[2].value).toBe("Email (awaiting verification)");
    const verified = signupPayload({
      ...user,
      emailVerified: true,
      path: "/sign-up/email",
      total: 1,
    });
    expect(verified.embeds[0].fields[2].value).toBe("Email (verified)");
    const google = signupPayload({ ...user, path: "/callback/:id", total: null });
    expect(google.embeds[0].title).toBe("🎉 New sign-up");
    expect(google.embeds[0].fields[2].value).toBe("Google");
  });

  it("escapes Markdown in what the person typed", () => {
    const body = signupPayload({
      ...user,
      name: "[x](https://evil.test)",
      path: "/sign-up/email",
      total: 1,
    });
    expect(body.embeds[0].fields[0].value).toBe("\\[x\\]\\(https://evil.test\\)");
  });
});

describe("notify", () => {
  it("posts to the channel's webhook and never pings anyone", async () => {
    sending();
    expect(await notifySignup(user, "/sign-up/email")).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0].url).toBe("/signups");
    expect(received[0].body.allowed_mentions).toEqual({ parse: [] });
    expect(received[0].body.embeds[0].title).toBe("🎉 New sign-up · #42");
  });

  it("sends only in production, unless told to", async () => {
    sending();
    process.env.NODE_ENV = "development";
    expect(await notify("ops", { content: "x" })).toBe(false);
    process.env.DISCORD_NOTIFY_NON_PRODUCTION = "true";
    expect(await notify("ops", { content: "x" })).toBe(true);
    expect(received).toHaveLength(1);
  });

  it("skips test accounts and unset channels", async () => {
    sending();
    expect(await notifySignup({ ...user, email: "apitest+x@example.test" }, "/sign-up/email")).toBe(
      false
    );
    delete process.env.DISCORD_WEBHOOK_SIGNUPS;
    expect(await notifySignup(user, "/sign-up/email")).toBe(false);
    expect(received).toHaveLength(0);
  });

  it("logs a refused or deleted webhook instead of throwing", async () => {
    sending();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    status = 404;
    expect(await notify("ops", { content: "x" })).toBe(false);
    expect(log).toHaveBeenCalledWith("[Discord] ops: the webhook no longer exists");
    process.env.DISCORD_WEBHOOK_OPS = "http://127.0.0.1:1/nothing-listens";
    expect(await notify("ops", { content: "x" })).toBe(false);
  });
});

describe("notifyOps", () => {
  it("posts the alert once per kind until the quiet period ends", async () => {
    sending();
    expect(await notifyOps("backup", "The nightly backup failed", "R2 said no")).toBe(true);
    expect(await notifyOps("backup", "The nightly backup failed", "R2 said no")).toBe(false);
    expect(await notifyOps("email", "Resend refused an auth email", "401")).toBe(true);
    expect(received.map(r => r.url)).toEqual(["/ops", "/ops"]);
    expect(received[0].body.embeds[0]).toMatchObject({
      title: "🚨 The nightly backup failed",
      fields: [{ name: "Detail", value: "R2 said no" }],
    });
  });

  it("is told of a 500 from a bug, once per route, and not of a chosen 5xx", async () => {
    sending();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = { status: () => res, json: () => res } as unknown as Response;
    const req = (path: string) =>
      ({ method: "GET", baseUrl: "/api/tasks", route: { path: "/:taskId" }, path }) as Request;
    const next = (() => {}) as NextFunction;
    errorHandler(new TypeError("x is undefined"), req("/1"), res, next);
    errorHandler(new TypeError("x is undefined"), req("/2"), res, next);
    errorHandler(new HttpError(502, "GitHub didn't answer", "GITHUB_ERROR"), req("/3"), res, next);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0].body.embeds[0].fields[0].value).toBe(
      "GET /api/tasks/:taskId: TypeError: x is undefined"
    );
  });
});
