import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import morgan from "morgan";
import { env, isProduction } from "./config/env.js";
import { errorHandler } from "./core/http/error-handler.js";
import { notFoundHandler } from "./core/http/not-found.js";
import { registerRoutes } from "./routes.js";

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: env.corsOrigin === "*" ? true : env.corsOrigin }));
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use(morgan(isProduction ? "combined" : "dev"));
  app.use(rateLimit({ windowMs: 60_000, limit: 300 }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, data: { status: "ok" } });
  });

  registerRoutes(app);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
