import { z } from "zod";

/** A record id as Better Auth generates them: letters, digits, `-` and `_`. */
export const recordId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "Invalid id");

export const userIdSchema = z.object({ params: z.object({ userId: recordId }) });
