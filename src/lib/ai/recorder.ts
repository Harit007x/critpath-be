/**
 * Reads critpath-ai's server-sent events as they pass through to the browser, to keep the answer
 * for the saved chat. The bytes themselves are passed on unchanged.
 */

export type RecordedAnswer = { content: string; error: string | null };

export const STOPPED = "Stopped.";
export const CUT_OFF = "The answer stopped early. Try again.";

export class AnswerRecorder {
  private text = "";
  private error: string | null = null;
  private done = false;
  /** A tool ran since the last text: the next text starts a new paragraph, as the web app shows it. */
  private breakBeforeText = false;
  private buffer = "";
  private readonly decoder = new TextDecoder();

  push(chunk: Uint8Array) {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    for (let end = this.buffer.indexOf("\n\n"); end >= 0; end = this.buffer.indexOf("\n\n")) {
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      this.read(block);
    }
  }

  /** The answer as far as it got. `stopped`: the visitor stopped it (or left) before the end. */
  result(stopped: boolean): RecordedAnswer {
    const content = this.text.trim();
    if (this.error) return { content, error: this.error };
    if (this.done) return { content, error: null };
    return { content, error: stopped ? STOPPED : CUT_OFF };
  }

  private read(block: string) {
    const event = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
    const raw = /^data: (.*)$/m.exec(block)?.[1];
    if (raw === undefined) return;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (event === "text" && typeof data.text === "string") {
      if (this.breakBeforeText && this.text) this.text += "\n\n";
      this.text += data.text;
      this.breakBeforeText = false;
    } else if (event === "tool") {
      this.breakBeforeText = true;
    } else if (event === "done") {
      this.done = true;
    } else if (event === "error") {
      this.error = typeof data.message === "string" && data.message ? data.message : CUT_OFF;
    }
  }
}
