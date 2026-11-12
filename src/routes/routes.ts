import express from "express";
import { healthController } from "../controllers/healthController";
import { authRouter } from "./authRoutes";
import { userRouter } from "./userRoutes";
import { xerRouter } from "./xerRoutes";
import { aiRouter } from "./aiRoutes";

export const router = express.Router();

/**
 * @openapi
 * /health:
 *   get:
 *     summary: Service health check (verifies database connectivity)
 *     tags: [General]
 *     responses:
 *       200:
 *         description: Service is healthy
 *       503:
 *         description: Service is degraded (database unreachable)
 */
router.get("/health", healthController.getHealth);
router.use("/auth", authRouter);
router.use("/users", userRouter);
router.use("/xer", xerRouter);
router.use("/ai", aiRouter);
