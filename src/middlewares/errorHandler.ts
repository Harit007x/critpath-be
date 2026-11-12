import { Request, Response, NextFunction, ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import multer from "multer";
import { HttpError } from "../utils/http";
import { describeError, notifyOps } from "../lib/discord";

export const errorHandler: ErrorRequestHandler = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  if (process.env.NODE_ENV !== "production") {
    console.error("Path:", req.path);
    console.error("Error:", err);
  }

  // Handle Zod Validation Errors
  if (err instanceof ZodError) {
    res.status(400).json({
      success: false,
      message: "Validation Error",
      errors: err.issues,
    });
    return;
  }

  // Upload limits (file too large, too many files, unexpected field)
  if (err instanceof multer.MulterError) {
    res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
      success: false,
      message:
        err.code === "LIMIT_FILE_SIZE"
          ? err.field === "image"
            ? "Images can be at most 2 MB"
            : "Files can be at most 25 MB"
          : err.message,
      code: err.code,
    });
    return;
  }

  // Handle syntax errors (malformed JSON)
  if (err instanceof SyntaxError && "body" in err) {
    res.status(400).json({
      success: false,
      message: "Invalid format. Expected JSON.",
    });
    return;
  }

  const statusCode = err.statusCode || 500;
  const message = err.message || "Internal Server Error";

  // A 5xx we chose (an HttpError: an upstream down, a missing key) is expected; anything else is a
  // bug. Keyed by route pattern, not path, so one bug on every id is one alert, not one per id.
  if (statusCode >= 500 && !(err instanceof HttpError)) {
    const route = `${req.method} ${req.baseUrl}${req.route?.path ?? req.path}`;
    void notifyOps(`500:${route}`, "The API answered 500", `${route}: ${describeError(err)}`);
  }

  res.status(statusCode).json({
    success: false,
    message,
    ...(err.code && typeof err.code === "string" && { code: err.code }),
    ...(process.env.NODE_ENV !== "production" && { stack: err.stack }),
  });
};
