import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { AuthService } from "./auth.js";
import { loadRuntimeConfig } from "./config.js";
import { AppDatabase } from "./database.js";
import { StorageService } from "./storage.js";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const runtime = loadRuntimeConfig();
const database = new AppDatabase(runtime.databasePath);
const auth = await AuthService.create(database, runtime);
const storage = new StorageService(runtime.storageRoot, runtime);
await storage.initialize();

try {
  if (!process.argv.includes("--seed-test-users")) {
    console.info("Database migrations applied. Use --seed-test-users with password environment variables to add Alice and Bob.");
  } else {
    const alicePassword = requiredSecret("SFT_SEED_ALICE_PASSWORD");
    const bobPassword = requiredSecret("SFT_SEED_BOB_PASSWORD");
    const alice = await auth.createUser({ username: "Alice", password: alicePassword, displayName: "Alice" });
    const bob = await auth.createUser({ username: "Bob", password: bobPassword, displayName: "Bob" });
    await storage.ensureUserRoot(alice.user.id);
    await storage.ensureUserRoot(bob.user.id);
    console.info(`Alice: ${alice.created ? "created" : "already exists"}`);
    console.info(`Bob: ${bob.created ? "created" : "already exists"}`);
  }
} finally {
  database.close();
}

function requiredSecret(name: "SFT_SEED_ALICE_PASSWORD" | "SFT_SEED_BOB_PASSWORD"): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be provided; passwords are never embedded in source code`);
  return value;
}

