import { z } from "zod";

/** Same limits as critpath-ai's ChatRequest, checked here first so bad requests stop at the edge. */
export const MAX_TURNS = 20;
export const MAX_CHARS = 4000;

const message = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(MAX_CHARS),
});

export const chatSchema = z.object({
  body: z
    .object({
      /** The stored upload the chat is about (`XerFile.id`); null = any stored upload. */
      fileId: z
        .string()
        .regex(/^[a-z0-9]{20,40}$/, "Invalid file id")
        .nullish(),
      messages: z.array(message).min(1).max(MAX_TURNS),
    })
    .strict()
    .refine(
      // Zod runs this even when `messages` already failed `min(1)`, so it may be empty.
      ({ messages }) => messages[0]?.role === "user" && messages.at(-1)?.role === "user",
      { message: "The conversation must start and end with a user message", path: ["messages"] }
    ),
});

export type ChatBody = z.infer<typeof chatSchema>["body"];
