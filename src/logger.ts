// src/logger.ts
// Structured JSONL logger. Append-only trade/edge log for dry-run validation
// and post-hoc analysis. Also provides console logging with module prefixes.

import { appendFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { config } from "./config.js";
import type { LogLevel, LogEntry } from "./types.js";

const LOG_FILE = join(config.dataDir, "trades.jsonl");

// Ensure data directory exists
if (!existsSync(config.dataDir)) {
  mkdirSync(config.dataDir, { recursive: true });
}

function formatConsole(entry: LogEntry): string {
  const prefix = `[${entry.ts}] [${entry.module}]`;
  const lvl = entry.level === "error" ? "✗" : entry.level === "warn" ? "⚠" : "·";
  const dataStr = entry.data ? ` ${JSON.stringify(entry.data)}` : "";
  return `${prefix} ${lvl} ${entry.msg}${dataStr}`;
}

function writeToFile(entry: LogEntry): void {
  try {
    appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
  } catch {
    // Swallow file write errors — don't crash the bot over logging
  }
}

function log(
  level: LogLevel,
  module: string,
  msg: string,
  data?: Record<string, unknown>,
  persist = false,
): void {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    module,
    msg,
    ...(data && { data }),
  };

  if (level === "error") {
    console.error(formatConsole(entry));
  } else if (level === "warn") {
    console.warn(formatConsole(entry));
  } else if (config.verbose) {
    console.log(formatConsole(entry));
  }

  // Persist to JSONL file only in dry-run mode
  if (persist && config.dryRun) {
    writeToFile(entry);
  }
}

/**
 * Create a scoped logger for a specific module.
 */
export function createLogger(module: string) {
  return {
    info: (msg: string, data?: Record<string, unknown>) =>
      log("info", module, msg, data),
    warn: (msg: string, data?: Record<string, unknown>) =>
      log("warn", module, msg, data),
    error: (msg: string, data?: Record<string, unknown>) =>
      log("error", module, msg, data),
    debug: (msg: string, data?: Record<string, unknown>) =>
      log("debug", module, msg, data),

    /** Log AND persist to trades.jsonl — use for edges, trades, exits. */
    record: (msg: string, data?: Record<string, unknown>) =>
      log("info", module, msg, data, true),
  };
}
