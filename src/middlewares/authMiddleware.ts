import { Request, Response, NextFunction } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../lib/auth";

export type AuthUser = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string | null;
  createdAt: Date;
  updatedAt: Date;
};

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

const unauthorized = (res: Response) =>
  res.status(401).json({ success: false, message: "Not authorized to access this route" });

/** Requires a signed-in session (Better Auth's cookie) and exposes the user as `req.user`. */
export const protect = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session) {
      unauthorized(res);
      return;
    }
    req.user = session.user as AuthUser;
    next();
  } catch (error) {
    console.error("Auth Middleware Error:", error);
    unauthorized(res);
  }
};
