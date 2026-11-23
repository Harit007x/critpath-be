/**
 * The client for critpath-ai, the AI service (its own repo; NestJS, or the FastAPI version in
 * critpath-ai-fastapi, which answers the same way) that answers questions about
 * stored schedules. This API is its only caller: the browser never reaches it directly, so sign-in,
 * rate limits and CORS stay here, and the AI service can stay on a private address.
 */
import { HttpError } from "../../utils/http";
import type { Turn } from "./schemas";

/** Read per call: dotenv-flow loads env in index.ts after imports are evaluated. */
const config = () => ({
  url: process.env.AI_SERVICE_URL?.trim().replace(/\/$/, "") || null,
  token: process.env.AI_SERVICE_TOKEN?.trim() || null,
});

export const aiEnabled = () => config().url !== null;

/**
 * Starts a chat answer and returns the service's event stream (server-sent events: `text`,
 * `tool`, then `done` or `error`). Throws an HttpError when the service is off, unreachable or
 * refuses the request; once the stream has started, errors arrive as `error` events instead.
 */
export async function startChat(
  request: { fileId: string | null; messages: Turn[] },
  signal: AbortSignal
): Promise<ReadableStream<Uint8Array>> {
  const { url, token } = config();
  if (!url) throw new HttpError(503, "The assistant is not switched on", "AI_DISABLED");

  let response: Response;
  try {
    response = await fetch(`${url}/v1/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      // critpath-ai's field names are snake_case.
      body: JSON.stringify({ file_id: request.fileId, messages: request.messages }),
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new HttpError(503, "The assistant could not be reached", "AI_UNAVAILABLE");
  }

  if (!response.ok || !response.body) {
    // 401: the two services disagree on AI_SERVICE_TOKEN, a setup problem, not the visitor's.
    const status = response.status === 422 ? 400 : 502;
    throw new HttpError(status, "The assistant could not take that question", "AI_FAILED");
  }
  return response.body;
}
