import { z } from "zod";

/** critpath-ai's limits on what one request may send (its ChatRequest). */
export const MAX_TURNS = 20;
export const MAX_CHARS = 4000;

const fileId = z.string().regex(/^[a-z0-9]{20,40}$/, "Invalid file id");
const chatId = z.string().regex(/^[a-z0-9]{20,40}$/, "Invalid chat id");

/** A turn as critpath-ai takes it. */
export type Turn = { role: "user" | "assistant"; content: string };

export const chatSchema = z.object({
  body: z
    .object({
      /** The stored upload a new chat is about (`XerFile.id`); null = any stored upload. A saved
       * chat keeps the file it started with, so this is ignored when `chatId` is set. */
      fileId: fileId.nullish(),
      /** A saved chat to continue; leave it out to start one. */
      chatId: chatId.optional(),
      /** The question. Earlier turns come from the saved chat. */
      message: z.string().trim().min(1).max(MAX_CHARS),
    })
    .strict(),
});

export type ChatBody = z.infer<typeof chatSchema>["body"];

export const listChatsSchema = z.object({
  query: z.object({ fileId: fileId.optional() }),
});

export const chatParamsSchema = z.object({
  params: z.object({ chatId }),
});
