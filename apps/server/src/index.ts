import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { startServer } from "./server.js";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`invalid positive integer: ${value}`);
  return parsed;
}

await startServer({
  host: process.env.SFT_HOST ?? "127.0.0.1",
  port: positiveInteger(process.env.SFT_PORT, 3000),
  heartbeatIntervalMs: positiveInteger(process.env.SFT_HEARTBEAT_INTERVAL_MS, 15_000),
  heartbeatTimeoutMs: positiveInteger(process.env.SFT_HEARTBEAT_TIMEOUT_MS, 45_000),
});

