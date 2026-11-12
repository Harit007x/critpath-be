import { describe, expect, it } from "vitest";
import { chatSchema, MAX_CHARS, MAX_TURNS } from "./schemas";

const parse = (body: unknown) => chatSchema.safeParse({ body });
const user = (content = "How many rows are broken?") => ({ role: "user", content });

describe("chatSchema", () => {
  it("takes a question about a stored file, or about any file", () => {
    expect(parse({ fileId: "cmwdiq3x60000s77dyqh7j2it", messages: [user()] }).success).toBe(true);
    expect(parse({ messages: [user()] }).success).toBe(true);
  });

  it("needs the conversation to start and end with the user", () => {
    expect(parse({ messages: [{ role: "assistant", content: "Hi" }] }).success).toBe(false);
    expect(parse({ messages: [user(), { role: "assistant", content: "4." }] }).success).toBe(false);
  });

  it("caps what one request can send", () => {
    expect(parse({ messages: [user("x".repeat(MAX_CHARS + 1))] }).success).toBe(false);
    expect(parse({ messages: Array(MAX_TURNS + 1).fill(user()) }).success).toBe(false);
    expect(parse({ messages: [user("   ")] }).success).toBe(false);
    expect(parse({ messages: [] }).success).toBe(false);
  });

  it("rejects odd ids and fields it does not know", () => {
    expect(parse({ fileId: "../etc/passwd", messages: [user()] }).success).toBe(false);
    expect(parse({ messages: [user()], model: "something-else" }).success).toBe(false);
  });
});
