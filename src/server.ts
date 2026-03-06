import express from "express";
import path from "path";

import { router } from "./api/routes";
import { config } from "./config";
import { logger } from "./lib/logger";

export function createServer(): express.Express {
  const app = express();

  app.use(express.json());

  // Serve static frontend files
  app.use(express.static(path.resolve(__dirname, "../public")));

  // API routes
  app.use(router);

  // SPA fallback: serve index.html for non-API routes
  app.get("/{*splat}", (_req, res) => {
    res.sendFile(path.resolve(__dirname, "../public/index.html"));
  });

  return app;
}

export function startServer(): void {
  const app = createServer();
  const host = "0.0.0.0"; // Bind to all interfaces so Pi is accessible on LAN

  app.listen(config.server.port, host, () => {
    logger.info("Server started", {
      port: config.server.port,
      host,
      url: `http://${host}:${config.server.port}`,
    });
  });
}
