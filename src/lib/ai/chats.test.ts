import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { historyFor, titleOf, visitorOf } from "./chats";
import { MAX_CHARS, MAX_TURNS } from "./schemas";

const user = (content: string) => ({ role: "user", content, error: null });
const answer = (content: string, error: string | null = null) => ({ role: "assistant", content, error });

describe("historyFor", () => {
  it("sends the saved turns, then the question", () => {
    expect(historyFor([user("Broken rows?"), answer("None.")], "And links?")).toEqual([
      { role: "user", content: "Broken rows?" },
      { role: "assistant", content: "None." },
      { role: "user", content: "And links?" },
    ]);
  });

  it("leaves out answers that failed or were empty, but keeps their questions", () => {
    const saved = [user("A?"), answer("Partly", "Busy."), user("B?"), answer("")];
    expect(historyFor(saved, "C?").map(t => t.content)).toEqual(["A?", "B?", "C?"]);
  });

  it("keeps the last turns, starting with a question", () => {
    const saved = Array.from({ length: 30 }, (_, i) => (i % 2 ? answer(`a${i}`) : user(`q${i}`)));
    const turns = historyFor(saved, "last?");
    expect(turns.length).toBeLessThanOrEqual(MAX_TURNS);
    expect(turns[0].role).toBe("user");
    expect(turns.at(-1)).toEqual({ role: "user", content: "last?" });
  });

  it("shortens answers longer than critpath-ai takes", () => {
    const [, long] = historyFor([user("Q?"), answer("x".repeat(MAX_CHARS + 500))], "Next?");
    expect(long.content).toHaveLength(MAX_CHARS);
  });
});

describe("titleOf", () => {
  it("puts the first question on one short line", () => {
    expect(titleOf("  Which   activities\nhave float?  ")).toBe("Which activities have float?");
    const long = titleOf("why ".repeat(40));
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("visitorOf", () => {
  const req = (key?: string) => ({ header: () => key }) as unknown as Request;

  it("stores a hash of the browser's key, never the key", () => {
    const key = "0d6f6c1e-5b1a-4b7e-9a0c-3f2d1e4c5b6a";
    expect(visitorOf(req(key))).toMatch(/^[0-9a-f]{64}$/);
    expect(visitorOf(req(key))).not.toContain(key);
    expect(visitorOf(req(key))).toBe(visitorOf(req(key)));
  });

  it("refuses a missing or odd key", () => {
    expect(() => visitorOf(req())).toThrow(/visitor key/);
    expect(() => visitorOf(req("short"))).toThrow(/visitor key/);
    expect(() => visitorOf(req("x".repeat(20) + "; drop"))).toThrow(/visitor key/);
  });
});
