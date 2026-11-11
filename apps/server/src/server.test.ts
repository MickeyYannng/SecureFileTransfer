import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import {
  ERROR_CODES,
  PROTOCOL_NAME,
  createControlMessage,
  hasStringField,
  parseControlMessage,
  serializeControlMessage,
  type ControlMessage,
  type ControlMessageType,
} from "@sft/protocol";
import { startServer } from "./server.js";

const silentLogger = { info() {}, warn() {}, error() {} };
const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const testRunsRoot = resolve(workspaceRoot, ".cache", "test-runs");
const aliceId = "11111111-1111-4111-8111-111111111111";
const bobId = "22222222-2222-4222-8222-222222222222";
const alicePassword = "Alice-Integration-2026!";
const bobPassword = "Bob-Integration-2026!";

test("Phase 2.1 authentication, isolation, paths, sessions, and heartbeat", async (t) => {
  await mkdir(testRunsRoot, { recursive: true });
  const runRoot = join(testRunsRoot, randomUUID());
  assert.ok(runRoot.startsWith(`${testRunsRoot}\\`) || runRoot.startsWith(`${testRunsRoot}/`));
  const storageRoot = join(runRoot, "storage");
  const server = await startServer({
    port: 0,
    databasePath: ":memory:",
    storageRoot,
    heartbeatIntervalMs: 30,
    heartbeatTimeoutMs: 300,
    sessionTtlMs: 30_000,
    initialUsers: [
      { id: aliceId, username: "Alice", password: alicePassword, displayName: "Alice" },
      { id: bobId, username: "Bob", password: bobPassword, displayName: "Bob" },
    ],
    logger: silentLogger,
  });
  const clients: TestClient[] = [];
  t.after(async () => {
    for (const client of clients) client.close();
    await server.close();
    await rm(runRoot, { recursive: true, force: true });
  });

  const makeClient = async () => {
    const client = await TestClient.connect(`ws://${server.host}:${server.port}/ws`);
    clients.push(client);
    return client;
  };

  let aliceToken = "";
  let bobToken = "";
  let aliceClient: TestClient;
  let bobClient: TestClient;

  await t.test("Alice can log in and fetch current user information", async () => {
    aliceClient = await makeClient();
    const response = await aliceClient.request("AUTH_LOGIN", { username: "Alice", password: alicePassword });
    assert.equal(response.type, "AUTH_SUCCESS");
    const payload = record(response.payload);
    assert.equal(record(payload.user).username, "Alice");
    assert.equal(typeof payload.token, "string");
    aliceToken = payload.token as string;
    const me = await aliceClient.request("AUTH_ME", {});
    assert.equal(me.type, "AUTH_ME_RESULT");
    assert.equal(record(record(me.payload).user).id, aliceId);
  });

  await t.test("Ed25519 challenge login accepts a valid signature and rejects a wrong signature", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeySpki = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
    assert.equal((await aliceClient.request("AUTH_PUBLIC_KEY_REGISTER", { publicKeySpki })).type, "AUTH_PUBLIC_KEY_REGISTERED");

    const invalidClient = await makeClient();
    const invalidChallenge = await invalidClient.request("AUTH_KEY_CHALLENGE", { username: "Alice" });
    assert.equal(invalidChallenge.type, "AUTH_KEY_CHALLENGE_RESULT");
    assertErrorCode(await invalidClient.request("AUTH_KEY_RESPONSE", {
      challengeId: record(invalidChallenge.payload).challengeId,
      signature: Buffer.alloc(64).toString("base64url"),
    }), ERROR_CODES.invalidCredentials);

    const keyClient = await makeClient();
    const challenge = await keyClient.request("AUTH_KEY_CHALLENGE", { username: "Alice" });
    const challengePayload = record(challenge.payload);
    const signature = sign(null, Buffer.from(challengePayload.challenge as string, "base64url"), privateKey).toString("base64url");
    const authenticated = await keyClient.request("AUTH_KEY_RESPONSE", {
      challengeId: challengePayload.challengeId,
      signature,
    });
    assert.equal(authenticated.type, "AUTH_SUCCESS");
    assert.equal(record(record(authenticated.payload).user).username, "Alice");
  });

  await t.test("wrong password and SQL injection input cannot authenticate", async () => {
    const wrongPasswordClient = await makeClient();
    assertErrorCode(
      await wrongPasswordClient.request("AUTH_LOGIN", { username: "Alice", password: "definitely-wrong" }),
      ERROR_CODES.invalidCredentials,
    );
    const injectionClient = await makeClient();
    assertErrorCode(
      await injectionClient.request("AUTH_LOGIN", { username: "' OR 1=1 --", password: alicePassword }),
      ERROR_CODES.invalidCredentials,
    );
  });

  await t.test("unauthenticated WebSocket cannot list protected files", async () => {
    const anonymous = await makeClient();
    assertErrorCode(await anonymous.request("FILE_LIST_REQUEST", { path: "" }), ERROR_CODES.authRequired);
  });

  await t.test("Bob cannot see or traverse into Alice private directory", async () => {
    const aliceRoot = join(storageRoot, "users", aliceId);
    const bobRoot = join(storageRoot, "users", bobId);
    await writeFile(join(aliceRoot, "alice-private.txt"), "Alice only", "utf8");
    bobClient = await makeClient();
    const login = await bobClient.request("AUTH_LOGIN", { username: "Bob", password: bobPassword });
    assert.equal(login.type, "AUTH_SUCCESS");
    bobToken = record(login.payload).token as string;

    const aliceList = await aliceClient.request("FILE_LIST_REQUEST", { path: "" });
    const aliceEntries = record(aliceList.payload).entries as Array<{ name: string }>;
    assert.ok(aliceEntries.some((entry) => entry.name === "alice-private.txt"));
    const bobList = await bobClient.request("FILE_LIST_REQUEST", { path: "" });
    const bobEntries = record(bobList.payload).entries as Array<{ name: string }>;
    assert.ok(!bobEntries.some((entry) => entry.name === "alice-private.txt"));

    assertErrorCode(
      await bobClient.request("FILE_LIST_REQUEST", { path: `../${aliceId}` }),
      ERROR_CODES.invalidPath,
    );
    assertErrorCode(
      await bobClient.request("FILE_LIST_REQUEST", { path: "C:/Windows" }),
      ERROR_CODES.invalidPath,
    );
    assertErrorCode(
      await bobClient.request("FILE_LIST_REQUEST", { path: "/etc" }),
      ERROR_CODES.invalidPath,
    );

    const linkPath = join(bobRoot, "alice-link");
    await symlink(aliceRoot, linkPath, process.platform === "win32" ? "junction" : "dir");
    assertErrorCode(
      await bobClient.request("FILE_LIST_REQUEST", { path: "alice-link" }),
      ERROR_CODES.forbidden,
    );
  });

  await t.test("revoked token cannot be reused and protected operations stop after logout", async () => {
    const logout = await bobClient.request("AUTH_LOGOUT", {});
    assert.equal(logout.type, "AUTH_LOGOUT_ACK");
    assertErrorCode(await bobClient.request("FILE_LIST_REQUEST", { path: "" }), ERROR_CODES.authRequired);
    const reconnect = await makeClient();
    assertErrorCode(await reconnect.request("AUTH_TOKEN", { token: bobToken }), ERROR_CODES.sessionRevoked);
  });

  await t.test("reconnect requires token revalidation and heartbeat remains active", async () => {
    const reconnect = await makeClient();
    const authenticated = await reconnect.request("AUTH_TOKEN", { token: aliceToken });
    assert.equal(authenticated.type, "AUTH_SUCCESS");
    assert.equal((record(authenticated.payload).token), undefined);
    const list = await reconnect.request("FILE_LIST_REQUEST", { path: "" });
    assert.equal(list.type, "FILE_LIST_RESULT");
    await delay(90);
    assert.ok(reconnect.heartbeatCount > 0);
  });

  await t.test("expired token is rejected on the existing and a reconnected socket", async () => {
    const expiryRoot = join(runRoot, "expiry-storage");
    const expiryServer = await startServer({
      port: 0,
      databasePath: ":memory:",
      storageRoot: expiryRoot,
      heartbeatIntervalMs: 30,
      heartbeatTimeoutMs: 300,
      sessionTtlMs: 100,
      initialUsers: [{ username: "Alice", password: alicePassword, displayName: "Alice" }],
      logger: silentLogger,
    });
    const expiringClient = await TestClient.connect(`ws://${expiryServer.host}:${expiryServer.port}/ws`);
    const login = await expiringClient.request("AUTH_LOGIN", { username: "Alice", password: alicePassword });
    const token = record(login.payload).token as string;
    await delay(140);
    assertErrorCode(
      await expiringClient.request("FILE_LIST_REQUEST", { path: "" }),
      ERROR_CODES.sessionExpired,
    );
    const retryClient = await TestClient.connect(`ws://${expiryServer.host}:${expiryServer.port}/ws`);
    assertErrorCode(await retryClient.request("AUTH_TOKEN", { token }), ERROR_CODES.sessionExpired);
    expiringClient.close();
    retryClient.close();
    await expiryServer.close();
  });
});

class TestClient {
  private readonly pending = new Map<string, {
    resolve: (message: ControlMessage<unknown>) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  heartbeatCount = 0;

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (data) => {
      try {
        const message = parseControlMessage(data.toString());
        if (message.type === "HEARTBEAT_PING" && hasStringField(message.payload, "nonce")) {
          this.heartbeatCount += 1;
          socket.send(serializeControlMessage(createControlMessage(
            "HEARTBEAT_PONG",
            message.requestId,
            { nonce: message.payload.nonce },
          )));
          return;
        }
        const waiter = this.pending.get(message.requestId);
        if (!waiter) return;
        clearTimeout(waiter.timer);
        this.pending.delete(message.requestId);
        waiter.resolve(message);
      } catch (error) {
        for (const waiter of this.pending.values()) waiter.reject(error as Error);
        this.pending.clear();
      }
    });
  }

  static async connect(url: string): Promise<TestClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolvePromise, reject) => {
      socket.once("open", resolvePromise);
      socket.once("error", reject);
    });
    const client = new TestClient(socket);
    const hello = await client.request("HELLO", { protocol: PROTOCOL_NAME, clientName: "integration-test" });
    assert.equal(hello.type, "HELLO_ACK");
    return client;
  }

  request(type: ControlMessageType, payload: Record<string, unknown>): Promise<ControlMessage<unknown>> {
    const requestId = randomUUID();
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`timeout waiting for ${type}`));
      }, 3_000);
      this.pending.set(requestId, { resolve: resolvePromise, reject, timer });
      this.socket.send(serializeControlMessage(createControlMessage(type, requestId, payload)));
    });
  }

  close(): void {
    this.socket.terminate();
  }
}

function assertErrorCode(message: ControlMessage<unknown>, expectedCode: string): void {
  assert.equal(message.type, "ERROR");
  assert.equal(record(message.payload).code, expectedCode);
}

function record(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.ok(value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
