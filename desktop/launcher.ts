/**
 * Standalone desktop launcher for WSB Inverse Sentiment Tracker.
 *
 * When compiled with pkg, this entry point:
 * 1. Patches native module resolution so better-sqlite3 loads from next to the exe
 * 2. Resolves paths relative to the exe location (not the snapshot filesystem)
 * 3. Auto-opens the dashboard in the user's default browser
 * 4. Keeps the process running as a console window
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import path from "path";
import Module from "module";
import { exec } from "child_process";

// When running inside a pkg binary, process.execPath points to the exe.
const isPkg = !!(process as NodeJS.Process & { pkg?: unknown }).pkg;
const baseDir = isPkg ? path.dirname(process.execPath) : path.resolve(__dirname, "..");

// Patch native module resolution BEFORE any imports that trigger better-sqlite3.
// The `bindings` package probes multiple paths via require.resolve(), but pkg's
// virtual FS intercepts those calls. We override _resolveFilename to redirect
// any request for better_sqlite3.node to the real file next to the exe.
if (isPkg) {
  const ModuleAny = Module as unknown as {
    _resolveFilename: (request: string, parent: unknown, isMain: boolean, options: unknown) => string;
  };
  const origResolve = ModuleAny._resolveFilename;
  ModuleAny._resolveFilename = function (request: string, parent: unknown, isMain: boolean, options: unknown): string {
    if (typeof request === "string" && request.includes("better_sqlite3.node")) {
      return path.join(baseDir, "better_sqlite3.node");
    }
    return origResolve.call(this, request, parent, isMain, options);
  };
}

// Set public dir before server.ts reads it
process.env.WSB_PUBLIC_DIR = path.join(baseDir, "public");

// Now load the app modules (better-sqlite3 will use the patched dlopen)
const { config } = require("../src/config") as typeof import("../src/config");
const { initDatabase } = require("../src/services/database") as typeof import("../src/services/database");
const { startServer } = require("../src/server") as typeof import("../src/server");
const { startScheduler } = require("../src/services/scheduler") as typeof import("../src/services/scheduler");
const { logger } = require("../src/lib/logger") as typeof import("../src/lib/logger");

function openBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;
  if (platform === "win32") {
    cmd = `start "" "${url}"`;
  } else if (platform === "darwin") {
    cmd = `open "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }
  exec(cmd, (err) => {
    if (err) {
      logger.warn("Could not auto-open browser", { error: err.message });
      logger.info(`Open manually: ${url}`);
    }
  });
}

function main(): void {
  const port = config.server.port;
  const url = `http://localhost:${port}`;

  console.log("===========================================");
  console.log("  WSB Inverse Sentiment Tracker");
  console.log("===========================================");
  console.log(`  Starting on ${url}`);
  console.log("  Press Ctrl+C to stop");
  console.log("===========================================");
  console.log("");

  // Initialize database in a data/ folder next to the exe
  const dbPath = path.join(baseDir, "data", "wsb.db");
  initDatabase(dbPath);

  // Start server
  startServer();

  // Start polling scheduler
  startScheduler();

  // Auto-open browser after a short delay to let the server bind
  setTimeout(() => {
    logger.info("Opening dashboard in browser", { url });
    openBrowser(url);
  }, 1500);
}

main();
