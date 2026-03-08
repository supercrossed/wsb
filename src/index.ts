import "dotenv/config";

import fs from "fs";
import path from "path";
import { config } from "./config";
import { initDatabase, migrateKeysToEncrypted } from "./services/database";
import { startScheduler } from "./services/scheduler";
import { startServer } from "./server";
import { restoreBotState } from "./services/tradebot";
import { logger } from "./lib/logger";

function main(): void {
  logger.info("WSB Inverse Sentiment Tracker starting");

  // Initialize database
  initDatabase(config.db.path);

  // Start the web server
  startServer();

  // Start polling scheduler
  startScheduler();

  // Migrate any plaintext API keys to encrypted format
  migrateKeysToEncrypted();

  // Restore trade bot state from last run
  restoreBotState();

  // Write update status on startup (marks update complete if triggered by updater)
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf-8"));
    const statusPath = path.resolve("data", "update-status.json");
    const status = {
      updating: false,
      lastUpdated: new Date().toISOString(),
      version: pkg.version,
    };
    fs.writeFileSync(statusPath, JSON.stringify(status));
  } catch { /* ignore — data dir may not exist yet */ }

  logger.info("All systems initialized");
}

main();
