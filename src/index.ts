// Load .env before any other module reads process.env at import time.
import "dotenv-flow/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { createServer } from "http";
import swaggerUi from "swagger-ui-express";
import { router } from "./routes/routes";
import { prisma } from "./utils/db";
import { errorHandler } from "./middlewares/errorHandler";
import { swaggerSpec } from "./utils/swagger";
import { frontendOrigins } from "./lib/auth";
import { storageLabel } from "./lib/uploads";
import { clientIp } from "./lib/rate-limit";
import { describeError, notifyOps } from "./lib/discord";
import { backupLabel, nightlyBackup } from "./lib/backup";

const app = express();

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} ${clientIp(req)}`);
  next();
});

// Nothing the API serves is a page for search. robots.txt keeps crawlers off this host; the header
// covers the same routes proxied through the app's origin, where robots.txt is the app's.
app.use((_req, res, next) => {
  res.setHeader("X-Robots-Tag", "noindex");
  next();
});
app.get("/robots.txt", (_req, res) => {
  res.type("text/plain").send("User-agent: *\nDisallow: /\n");
});

// Webhooks that verify a signature over the raw body go here, before express.json and CORS.

app.use(
  cors({
    origin: frontendOrigins,
    credentials: true,
  })
);

app.use(cookieParser());
app.use(express.json({ limit: "2mb" }));

app.use("/api", router);
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

app.use(errorHandler as unknown as express.ErrorRequestHandler);

const server = createServer(app);
const PORT = process.env.PORT || 5000;

const HOURLY_MS = 60 * 60 * 1000;

async function startServer() {
  try {
    await prisma.$connect();
    console.log("✅ Connected to Postgres");
    server.listen(PORT, () => {
      console.log(`✅ API running on http://localhost:${PORT} (docs at /api-docs)`);
      console.log(`📎 Uploads: ${storageLabel}`);
      console.log(`💾 Backups: ${backupLabel}`);
    });

    // The backup checks the bucket for today's on every tick (lib/backup.ts), so hourly is enough.
    void nightlyBackup();
    setInterval(() => void nightlyBackup(), HOURLY_MS).unref();

    const shutdown = async () => {
      console.log("🛑 Shutting down server...");
      await prisma.$disconnect();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (error) {
    console.error("Failed to connect to the database:", error);
    await notifyOps("db-connect", "The API could not reach the database", describeError(error));
    process.exit(1);
  }
}

// Node would print and exit on these anyway; this tells the owner first (at most 3 s), then exits
// the same way, so Railway restarts a process whose state can no longer be trusted.
const crash = (what: string) => async (error: unknown) => {
  console.error(`${what}:`, error);
  await notifyOps(`crash:${what}`, "The API crashed", `${what}: ${describeError(error)}`);
  process.exit(1);
};
process.on("uncaughtException", crash("Uncaught exception"));
process.on("unhandledRejection", crash("Unhandled rejection"));

startServer();
