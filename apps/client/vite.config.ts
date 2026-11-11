import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Agent } from "node:https";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig(({ mode }) => {
  const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
  const env = loadEnv(mode, projectRoot, "");
  const certPath = env.VITE_HTTPS_CERT_PATH;
  const keyPath = env.VITE_HTTPS_KEY_PATH;
  const https = certPath && keyPath ? {
    cert: readFileSync(resolve(projectRoot, certPath)),
    key: readFileSync(resolve(projectRoot, keyPath)),
  } : undefined;
  const tlsEnabled = Boolean(https);
  const caPath = resolve(projectRoot, "certs/dev-ca.pem");
  return {
    plugins: [vue()],
    server: {
      host: "127.0.0.1",
      port: 5173,
      ...(https ? { https } : {}),
      proxy: {
        "/ws": {
          target: tlsEnabled ? "wss://127.0.0.1:3000" : "ws://127.0.0.1:3000",
          ws: true,
          secure: true,
          ...(tlsEnabled ? { agent: new Agent({ ca: readFileSync(caPath) }) } : {}),
        },
      },
    },
  };
});

