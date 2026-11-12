import { Request, Response, NextFunction } from "express";
import { ZodTypeAny } from "zod";

/**
 * Validates `{ body, query, params }` against a zod schema. The parsed body
 * replaces `req.body`, so controllers see coerced values (dates, trimmed strings).
 */
export const validate = (schema: ZodTypeAny) => {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const parsed = (await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
      })) as { body?: unknown };
      if (parsed.body !== undefined) req.body = parsed.body;
      return next();
    } catch (error) {
      return next(error);
    }
  };
};
