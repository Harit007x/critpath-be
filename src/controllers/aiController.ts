import type { NextFunction, Request, Response } from "express";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import type { ReadableStream as WebReadableStream } from "stream/web";
import { startChat } from "../lib/ai/service";
import type { ChatBody } from "../lib/ai/schemas";

export const aiController = {
  /** Passes critpath-ai's server-sent events through to the browser as they arrive. */
  async chat(req: Request, res: Response, next: NextFunction) {
    // The visitor closed the tab or asked something else: stop the answer (and its token spend).
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    try {
      const events = await startChat(req.body as ChatBody, abort.signal);
      res.status(200).set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();
      await pipeline(Readable.fromWeb(events as WebReadableStream<Uint8Array>), res);
    } catch (error) {
      if (abort.signal.aborted) return;
      if (res.headersSent) {
        res.end();
        return;
      }
      next(error);
    }
  },
};
