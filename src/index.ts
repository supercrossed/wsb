import "dotenv/config";

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

  logger.info("All systems initialized");
}

main();
