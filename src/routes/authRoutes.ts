import express from "express";
import { toNodeHandler } from "better-auth/node";
import { auth } from "../lib/auth";
import { CLIENT_IP_HEADER, clientIp } from "../lib/rate-limit";

export const authRouter = express.Router();

// Better Auth rate-limits sign-in and sign-up per IP (in production), but reads the IP from a
// header and gives up on a multi-hop X-Forwarded-For, putting everyone in one shared bucket.
// Overwritten on every request, so a value a client sends is never used.
authRouter.use((req, _res, next) => {
  req.headers[CLIENT_IP_HEADER] = clientIp(req);
  next();
});
authRouter.use(toNodeHandler(auth.handler));
