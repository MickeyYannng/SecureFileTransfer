import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { loadRuntimeConfig } from "./config.js";
import { startServer } from "./server.js";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
await startServer(loadRuntimeConfig());

