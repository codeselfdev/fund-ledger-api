import { clientActivityContext } from "./core/security/client-activity.js";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import morgan from "morgan";
import { env, isProduction } from "./config/env.js";
import { errorHandler } from "./core/http/error-handler.js";
import { notFoundHandler } from "./core/http/not-found.js";
import { registerRoutes } from "./routes.js";
import { getObjectStorageDiagnostics } from "./core/storage/object-storage.service.js";

import { whatsappBotWebhookRouter } from "./modules/assistant/whatsapp-bot.routes.js";

export function createApp() {
  const app = express();

  // Coolify/Traefik (and most reverse proxies) set X-Forwarded-For.
  // Required so express-rate-limit can identify clients correctly.
  app.set("trust proxy", env.trustProxy);

  app.use(helmet());
  app.use(cors({ origin: env.corsOrigin === "*" ? true : env.corsOrigin }));
  app.use("/v1/webhooks/whatsapp", express.raw({ type: "application/json", limit: "256kb" }), whatsappBotWebhookRouter);
  app.use("/v1/members/import-fund", express.json({ limit: "8mb" }));
  app.use("/v1/business-setup/imports", express.json({ limit: "8mb" }));
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use(morgan(isProduction ? "combined" : "dev"));
  app.use(rateLimit({
    windowMs: 60_000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false
  }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, data: { status: "ok", storage: getObjectStorageDiagnostics() } });
  });

  app.use(clientActivityContext);
  registerRoutes(app);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
