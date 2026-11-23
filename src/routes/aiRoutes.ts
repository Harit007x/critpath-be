import express from "express";
import { aiController } from "../controllers/aiController";
import { limiter } from "../lib/rate-limit";
import { chatParamsSchema, chatSchema, listChatsSchema } from "../lib/ai/schemas";
import { validate } from "../middlewares/validate";

/** The schedule assistant: questions about stored uploads, answered by critpath-ai. Public, so
 * both limits exist to cap what one address can spend on the model. */
export const aiRouter = express.Router();

/**
 * @openapi
 * tags:
 *   name: Assistant
 *   description: Ask questions about a stored schedule (answered by the critpath-ai service)
 */

/**
 * @openapi
 * /ai/chat:
 *   post:
 *     summary: Ask a question; it and the answer are saved, and the answer streams as server-sent events
 *     description: >
 *       Header `X-CritPath-Visitor` (the browser's random key; chats belong to it). Body
 *       `{ fileId?, chatId?, message }`: leave `chatId` out to start a chat about `fileId`, or name
 *       a saved chat to continue it. Events are `chat` ({ id, title }) first, then `text` ({ text }),
 *       `tool` ({ name, label, state }), then `done` or `error` ({ code, message }).
 *     tags: [Assistant]
 *     responses:
 *       200:
 *         description: text/event-stream
 *       400:
 *         description: Validation Error, or NO_VISITOR
 *       404:
 *         description: The chat or file is not found
 *       429:
 *         description: RATE_LIMITED
 *       503:
 *         description: AI_DISABLED (AI_SERVICE_URL unset) or AI_UNAVAILABLE
 */
aiRouter.post("/chat", limiter(1, 6), limiter(24 * 60, 60), validate(chatSchema), aiController.chat);

/**
 * @openapi
 * /ai/chats:
 *   get:
 *     summary: This visitor's saved chats, most recent first (up to 50), optionally about one file
 *     tags: [Assistant]
 *     parameters:
 *       - in: query
 *         name: fileId
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: "[{ id, fileId, title, createdAt, updatedAt, messageCount }]"
 * /ai/chats/{chatId}:
 *   get:
 *     summary: One saved chat with its messages ({ role, content, error, createdAt })
 *     tags: [Assistant]
 *     responses:
 *       200:
 *         description: The chat
 *       404:
 *         description: Not this visitor's chat
 *   delete:
 *     summary: Delete a saved chat
 *     tags: [Assistant]
 *     responses:
 *       200:
 *         description: Deleted
 *       404:
 *         description: Not this visitor's chat
 */
aiRouter.get("/chats", limiter(1, 60), validate(listChatsSchema), aiController.listChats);
aiRouter.get("/chats/:chatId", limiter(1, 60), validate(chatParamsSchema), aiController.getChat);
aiRouter.delete("/chats/:chatId", limiter(1, 30), validate(chatParamsSchema), aiController.deleteChat);
