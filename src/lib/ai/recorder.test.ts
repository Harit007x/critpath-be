import { describe, expect, it } from "vitest";
import { AnswerRecorder, CUT_OFF, STOPPED } from "./recorder";

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const bytes = (text: string) => new TextEncoder().encode(text);

function record(stream: string, chunkSize = stream.length) {
  const recorder = new AnswerRecorder();
  const all = bytes(stream);
  for (let i = 0; i < all.length; i += chunkSize) recorder.push(all.subarray(i, i + chunkSize));
  return recorder;
}

const tool = (state: string) => sse("tool", { name: "get_check", label: "Reading", state });
const done = sse("done", { model: "m", rounds: 2, input_tokens: 1, output_tokens: 1 });

describe("AnswerRecorder", () => {
  it("keeps the answer's text, with a paragraph break where a tool ran between two parts", () => {
    const stream = sse("text", { text: "Let me look." }) + tool("started") + tool("finished") +
      sse("text", { text: "64 activities " }) + sse("text", { text: "lack a link." }) + done;
    expect(record(stream).result(false)).toEqual({
      content: "Let me look.\n\n64 activities lack a link.",
      error: null,
    });
  });

  it("reads events split across chunks anywhere, multi-byte characters included", () => {
    const stream = sse("text", { text: "Float ≥ 44 days — 5 activités" }) + done;
    expect(record(stream, 3).result(false)).toEqual({ content: "Float ≥ 44 days — 5 activités", error: null });
  });

  it("keeps the error the answer ended with", () => {
    const stream = sse("text", { text: "Partly" }) + sse("error", { code: "busy", message: "Busy. Try again." });
    expect(record(stream).result(false)).toEqual({ content: "Partly", error: "Busy. Try again." });
  });

  it("marks an answer that never finished: stopped by the visitor, or cut off", () => {
    const stream = sse("text", { text: "Half" });
    expect(record(stream).result(true)).toEqual({ content: "Half", error: STOPPED });
    expect(record(stream).result(false)).toEqual({ content: "Half", error: CUT_OFF });
  });

  it("ignores blocks it cannot read", () => {
    const stream = "event: text\ndata: {not json\n\n: comment\n\n" + sse("text", { text: "OK" }) + done;
    expect(record(stream).result(false)).toEqual({ content: "OK", error: null });
  });
});
