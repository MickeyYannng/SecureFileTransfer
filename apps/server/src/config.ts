import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));

export interface RuntimeConfig {
  host: string;
  port: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  databasePath: string;
  storageRoot: string;
  sessionTtlMs: number;
  maxFileSizeBytes: number;
  defaultQuotaBytes: number;
  defaultMaxFiles: number;
}

export function loadRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  return {
    host: environment.SFT_HOST ?? "127.0.0.1",
    port: positiveInteger(environment.SFT_PORT, 3000),
    heartbeatIntervalMs: positiveInteger(environment.SFT_HEARTBEAT_INTERVAL_MS, 15_000),
    heartbeatTimeoutMs: positiveInteger(environment.SFT_HEARTBEAT_TIMEOUT_MS, 45_000),
    databasePath: resolve(projectRoot, environment.SFT_DATABASE_PATH ?? "data/sft.sqlite"),
    storageRoot: resolve(projectRoot, environment.SFT_STORAGE_ROOT ?? "storage"),
    sessionTtlMs: positiveInteger(environment.SFT_SESSION_TTL_MS, 30 * 60_000),
    maxFileSizeBytes: positiveInteger(environment.SFT_MAX_FILE_SIZE_BYTES, 512 * 1024 * 1024),
    defaultQuotaBytes: positiveInteger(environment.SFT_DEFAULT_QUOTA_BYTES, 1024 * 1024 * 1024),
    defaultMaxFiles: positiveInteger(environment.SFT_DEFAULT_MAX_FILES, 1_000),
  };
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`invalid positive integer configuration: ${value}`);
  return parsed;
}

