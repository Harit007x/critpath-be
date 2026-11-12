import type { Request } from "express";
import { afterEach, describe, expect, it } from "vitest";
import { PROXY_KEY_HEADER, VISITOR_IP_HEADER, clientIp } from "./rate-limit";

const request = (headers: Record<string, string>, socket = "10.0.0.9") =>
  ({
    header: (name: string) => headers[name.toLowerCase()],
    socket: { remoteAddress: socket },
  }) as unknown as Request;

describe("clientIp", () => {
  afterEach(() => {
    delete process.env.EDGE_PROXY_SECRET;
  });

  it("believes our proxy's visitor header only with the right key", () => {
    process.env.EDGE_PROXY_SECRET = "s3cret";
    const proxied = { "x-forwarded-for": "172.71.1.1", [VISITOR_IP_HEADER]: "103.176.11.84" };
    expect(clientIp(request({ ...proxied, [PROXY_KEY_HEADER]: "s3cret" }))).toBe("103.176.11.84");
    expect(clientIp(request({ ...proxied, [PROXY_KEY_HEADER]: "guess" }))).toBe("172.71.1.1");
    expect(clientIp(request(proxied))).toBe("172.71.1.1");
  });

  it("never believes the visitor header without a configured key", () => {
    const headers = { [VISITOR_IP_HEADER]: "6.6.6.6", [PROXY_KEY_HEADER]: "" };
    expect(clientIp(request(headers))).toBe("10.0.0.9");
  });

  it("falls back to X-Forwarded-For, then the socket, ignoring what is not an address", () => {
    process.env.EDGE_PROXY_SECRET = "s3cret";
    const keyed = { [PROXY_KEY_HEADER]: "s3cret", [VISITOR_IP_HEADER]: "nonsense" };
    expect(clientIp(request({ ...keyed, "x-forwarded-for": "5.5.5.5, 1.1.1.1" }))).toBe("5.5.5.5");
    expect(clientIp(request({}, "::ffff:127.0.0.1"))).toBe("127.0.0.1");
  });
});
