import { describe, expect, it } from "vitest";
import { chatSchema, MAX_CHARS } from "./schemas";

const parse = (body: unknown) => chatSchema.safeParse({ body });
const FILE = "cmwdiq3x60000s77dyqh7j2it";
const CHAT = "cmwe0a1b20000ab12cd34ef56";

describe("chatSchema", () => {
  it("takes a question that starts a chat, about a file or any file, or continues one", () => {
    expect(parse({ fileId: FILE, message: "How many rows are broken?" }).success).toBe(true);
    expect(parse({ message: "Which files are stored?" }).success).toBe(true);
    expect(parse({ chatId: CHAT, message: "And the float?" }).success).toBe(true);
  });

  it("caps and trims the question", () => {
    expect(parse({ message: "x".repeat(MAX_CHARS + 1) }).success).toBe(false);
    expect(parse({ message: "   " }).success).toBe(false);
    expect(parse({}).success).toBe(false);
    const parsed = parse({ message: "  Why?  " });
    expect(parsed.success && parsed.data.body.message).toBe("Why?");
  });

  it("rejects odd ids and fields it does not know", () => {
    expect(parse({ fileId: "../etc/passwd", message: "Hi" }).success).toBe(false);
    expect(parse({ chatId: "1 OR 1=1", message: "Hi" }).success).toBe(false);
    expect(parse({ message: "Hi", messages: [] }).success).toBe(false);
  });
});
