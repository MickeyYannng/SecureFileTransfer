import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { config } from "dotenv";
import { loadRuntimeConfig } from "./config.js";
import { startServer } from "./server.js";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
const runtime = loadRuntimeConfig();
const tls = runtime.tlsCertPath && runtime.tlsKeyPath
  ? { cert: readFileSync(runtime.tlsCertPath), key: readFileSync(runtime.tlsKeyPath) }
  : undefined;
if (runtime.requireTls && !tls) throw new Error("TLS is required but certificate paths are missing");
await startServer(tls ? { ...runtime, tls } : { ...runtime });

