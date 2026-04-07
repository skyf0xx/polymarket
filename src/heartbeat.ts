// src/heartbeat.ts
// Sends a POST /heartbeats every 5s to prevent open orders from being cancelled.
// The CLOB endpoint cancels all orders if no heartbeat is received within 10s
// (with a 5s buffer). We send every 5s to stay well within that window.

import { createHmac } from "crypto";
import { readFileSync } from "fs";
import { config } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("heartbeat");

const HEARTBEAT_INTERVAL_MS = 5_000;
const HEARTBEAT_URL = `${config.clobApiUrl}/heartbeats`;

interface ApiCreds {
  key: string;
  secret: string;
  passphrase: string;
}

function buildHeaders(creds: ApiCreds, signerAddress: string, body: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1_000).toString();
  const message = timestamp + "POST" + "/heartbeats" + body;
  const base64Secret = Buffer.from(creds.secret, "base64");
  const sig = createHmac("sha256", base64Secret)
    .update(message)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  return {
    "POLY_ADDRESS": signerAddress,
    "POLY_API_KEY": creds.key,
    "POLY_PASSPHRASE": creds.passphrase,
    "POLY_TIMESTAMP": timestamp,
    "POLY_SIGNATURE": sig,
    "Content-Type": "application/json",
  };
}

export function startHeartbeat(credsFile: string, signerAddress: string): () => void {
  const creds = JSON.parse(readFileSync(credsFile, "utf-8")) as ApiCreds;
  let heartbeatId = "";

  const timer = setInterval(async () => {
    try {
      const body = JSON.stringify({ heartbeat_id: heartbeatId });
      const headers = buildHeaders(creds, signerAddress, body);
      const res = await fetch(HEARTBEAT_URL, { method: "POST", headers, body });

      const json = await res.json().catch(() => null) as Record<string, unknown> | null;

      if (res.ok) {
        if (typeof json?.heartbeat_id === "string") {
          heartbeatId = json.heartbeat_id;
        }
      } else if (res.status === 400 && typeof json?.heartbeat_id === "string") {
        // Server rejected our ID and provided the correct one — update and continue
        log.warn(`Heartbeat ID mismatch, correcting to server ID`);
        heartbeatId = json.heartbeat_id;
      } else {
        log.warn(`Heartbeat failed: HTTP ${res.status}`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`Heartbeat error: ${message}`);
    }
  }, HEARTBEAT_INTERVAL_MS);

  log.info(`Heartbeat started (every ${HEARTBEAT_INTERVAL_MS / 1_000}s)`);

  return () => clearInterval(timer);
}
