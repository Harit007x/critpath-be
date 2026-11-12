import express from "express";
import { aiController } from "../controllers/aiController";
import { limiter } from "../lib/rate-limit";
import { chatSchema } from "../lib/ai/schemas";
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
 *     summary: Ask about a stored upload; the answer streams as server-sent events
 *     description: >
 *       Body `{ fileId?, messages: [{ role: "user" | "assistant", content }] }`, starting and
 *       ending with a user message. Events are `text` ({ text }), `tool` ({ name, label, state }),
 *       then `done` or `error` ({ code, message }).
 *     tags: [Assistant]
 *     responses:
 *       200:
 *         description: text/event-stream
 *       400:
 *         description: Validation Error
 *       429:
 *         description: RATE_LIMITED
 *       503:
 *         description: AI_DISABLED (AI_SERVICE_URL unset) or AI_UNAVAILABLE
 */
aiRouter.post("/chat", limiter(1, 6), limiter(24 * 60, 60), validate(chatSchema), aiController.chat);
