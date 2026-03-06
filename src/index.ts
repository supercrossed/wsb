import "dotenv/config";

import { config } from "./config";
import { initDatabase } from "./services/database";
import { startScheduler } from "./services/scheduler";
import { startServer } from "./server";
import { logger } from "./lib/logger";

function main(): void {
  logger.info("WSB Inverse Sentiment Tracker starting");

  // Initialize database
  initDatabase(config.db.path);

  // Start the web server
  startServer();

  // Start polling scheduler
  startScheduler();

  logger.info("All systems initialized");
}

main();
