import fs from "fs";
import path from "path";

type LogLevel = "info" | "warn" | "error" | "debug";

const LOG_DIR = path.resolve(__dirname, "../../logs");
const LOG_FILE = path.join(LOG_DIR, "wsb.log");

// Ensure logs directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Open a write stream in append mode
const logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });

function formatTimestamp(): string {
  return new Date().toISOString();
}

function log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  const entry = {
    timestamp: formatTimestamp(),
    level,
    message,
    ...(context ? { context } : {}),
  };
  const line = JSON.stringify(entry) + "\n";

  // Write to stdout/stderr as before
  if (level === "error") {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }

  // Also write to log file
  logStream.write(line);
}

export const logger = {
  info: (message: string, context?: Record<string, unknown>) => log("info", message, context),
  warn: (message: string, context?: Record<string, unknown>) => log("warn", message, context),
  error: (message: string, context?: Record<string, unknown>) => log("error", message, context),
  debug: (message: string, context?: Record<string, unknown>) => log("debug", message, context),
};
