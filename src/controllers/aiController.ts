import type { NextFunction, Request, Response } from "express";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import type { ReadableStream as WebReadableStream } from "stream/web";
import { startChat } from "../lib/ai/service";
import type { ChatBody } from "../lib/ai/schemas";
import { AnswerRecorder } from "../lib/ai/recorder";
import {
  assertFileExists,
  deleteChat,
  getChat,
  historyFor,
  listChats,
  saveAnswer,
  saveQuestion,
  visitorOf,
} from "../lib/ai/chats";
import { paramOf } from "../utils/http";

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export const aiController = {
  /**
   * Saves the question, then passes critpath-ai's server-sent events through to the browser as
   * they arrive, after a `chat` event naming the saved chat. The answer is saved as it ends, or
   * as far as it got when it stops.
   */
  async chat(req: Request, res: Response, next: NextFunction) {
    // The visitor closed the tab or asked something else: stop the answer (and its token spend).
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    const recorder = new AnswerRecorder();
    let chatId: string | null = null;
    let answerSaved = false;
    const finish = async () => {
      if (!chatId || answerSaved) return;
      answerSaved = true;
      try {
        await saveAnswer(chatId, recorder.result(abort.signal.aborted));
      } catch (error) {
        console.error("Could not save the assistant's answer:", error);
      }
    };

    try {
      const visitor = visitorOf(req);
      const body = req.body as ChatBody;
      const chat = body.chatId ? await getChat(visitor, body.chatId) : null;
      const fileId = chat ? chat.fileId : (body.fileId ?? null);
      if (!chat && fileId) await assertFileExists(fileId);

      const events = await startChat(
        { fileId, messages: historyFor(chat?.messages ?? [], body.message) },
        abort.signal
      );
      const saved = await saveQuestion(visitor, chat?.id ?? null, fileId, body.message);
      chatId = saved.id;

      res.status(200).set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();
      res.write(sse("chat", saved));
      // Saved before the response ends, so a list fetched when the stream closes includes it.
      const tap = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          recorder.push(chunk);
          done(null, chunk);
        },
        flush(done) {
          void finish().then(() => done());
        },
      });
      await pipeline(Readable.fromWeb(events as WebReadableStream<Uint8Array>), tap, res);
    } catch (error) {
      if (abort.signal.aborted) return;
      if (res.headersSent) {
        res.end();
        return;
      }
      next(error);
    } finally {
      await finish();
    }
  },

  async listChats(req: Request, res: Response, next: NextFunction) {
    try {
      const fileId = typeof req.query.fileId === "string" ? req.query.fileId : undefined;
      res.json({ success: true, data: await listChats(visitorOf(req), fileId) });
    } catch (error) {
      next(error);
    }
  },

  async getChat(req: Request, res: Response, next: NextFunction) {
    try {
      res.json({ success: true, data: await getChat(visitorOf(req), paramOf(req, "chatId")) });
    } catch (error) {
      next(error);
    }
  },

  async deleteChat(req: Request, res: Response, next: NextFunction) {
    try {
      await deleteChat(visitorOf(req), paramOf(req, "chatId"));
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  },
};
