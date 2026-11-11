import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import {
  BINARY_FLAGS,
  BINARY_MESSAGE_TYPES,
  ERROR_CODES,
  PROTOCOL_NAME,
  createControlMessage,
  encodeBinaryFrame,
  parseControlMessage,
  serializeControlMessage,
  type ControlMessage,
  type ControlMessageType,
} from "@sft/protocol";
import { startServer } from "./server.js";

const silentLogger = { info() {}, warn() {}, error() {} };
const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const testRunsRoot = resolve(workspaceRoot, ".cache", "test-runs");
const aliceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const bobId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const alicePassword = "Alice-Upload-2026!";
const bobPassword = "Bob-Upload-2026!";
const chunkSize = 64 * 1024;

test("Phase 2.2 single-file upload integration", async (t) => {
  await mkdir(testRunsRoot, { recursive: true });
  const runRoot = join(testRunsRoot, randomUUID());
  const storageRoot = join(runRoot, "storage");
  const server = await startServer({
    port: 0,
    databasePath: ":memory:",
    storageRoot,
    heartbeatIntervalMs: 30,
    heartbeatTimeoutMs: 500,
    uploadChunkSize: chunkSize,
    maxFileSizeBytes: 2 * 1024 * 1024,
    defaultQuotaBytes: 8 * 1024 * 1024,
    defaultMaxFiles: 100,
    maxActiveUploadsPerUser: 2,
    initialUsers: [
      { id: aliceId, username: "Alice", password: alicePassword, displayName: "Alice", quotaBytes: 2 * 1024 * 1024, maxFiles: 100 },
      { id: bobId, username: "Bob", password: bobPassword, displayName: "Bob", quotaBytes: 1024 * 1024, maxFiles: 1 },
    ],
    logger: silentLogger,
  });
  const clients: UploadTestClient[] = [];
  t.after(async () => {
    for (const client of clients) client.close();
    await server.close();
    await rm(runRoot, { recursive: true, force: true });
  });
  const makeClient = async (username?: "Alice" | "Bob") => {
    const client = await UploadTestClient.connect(`ws://${server.host}:${server.port}/ws`);
    clients.push(client);
    if (username) await client.login(username, username === "Alice" ? alicePassword : bobPassword);
    return client;
  };

  const alice = await makeClient("Alice");

  await t.test("uploads a zero-byte file and keeps the socket open", async () => {
    const complete = await alice.upload("zero.bin", Buffer.alloc(0));
    assert.equal(complete.type, "UPLOAD_COMPLETE");
    assert.equal((await stat(join(storageRoot, "users", aliceId, "zero.bin"))).size, 0);
    await delay(80);
    assert.ok(alice.heartbeatCount > 0);
    assert.equal((await alice.request("AUTH_ME", {})).type, "AUTH_ME_RESULT");
  });

  await t.test("uploads a small text file and verifies its bytes", async () => {
    const content = Buffer.from("SFTP-WS Phase 2.2\n", "utf8");
    await alice.upload("small.txt", content);
    assert.deepEqual(await readFile(join(storageRoot, "users", aliceId, "small.txt")), content);
  });

  await t.test("uploads a 1 MiB binary file with matching SHA-256", async () => {
    const content = deterministicBytes(1024 * 1024);
    const complete = await alice.upload("one-megabyte.bin", content);
    assert.equal(record(complete.payload).fileSha256, sha256Hex(content));
    assert.equal(sha256Hex(await readFile(join(storageRoot, "users", aliceId, "one-megabyte.bin"))), sha256Hex(content));
  });

  await t.test("rejects an incorrect whole-file SHA-256 and removes temporary data", async () => {
    const content = Buffer.from("hash mismatch");
    const ready = await alice.init("bad-whole-hash.bin", content.length, "00".repeat(32));
    await alice.sendAllChunks(ready, content);
    assertUploadError(await alice.request("UPLOAD_FINISH", { transferId: transferId(ready) }), ERROR_CODES.hashMismatch);
    assert.equal(await exists(join(storageRoot, "users", aliceId, "bad-whole-hash.bin")), false);
  });

  await t.test("rejects declared-size mismatch", async () => {
    const content = Buffer.from("short");
    const ready = await alice.init("size-mismatch.bin", content.length + 1, sha256Hex(content));
    await alice.sendAllChunks(ready, content);
    assertUploadError(await alice.request("UPLOAD_FINISH", { transferId: transferId(ready) }), ERROR_CODES.sizeMismatch);
    assert.equal(await exists(join(storageRoot, "users", aliceId, "size-mismatch.bin")), false);
  });

  await t.test("rejects wrong, repeated, and out-of-order offsets", async () => {
    const content = deterministicBytes(chunkSize * 2);
    const repeated = await alice.init("repeat.bin", content.length, sha256Hex(content));
    await alice.sendChunk(repeated, content.subarray(0, chunkSize), 0);
    assertUploadError(await alice.sendChunk(repeated, content.subarray(0, chunkSize), 0), ERROR_CODES.invalidOffset);

    const outOfOrder = await alice.init("out-of-order.bin", content.length, sha256Hex(content));
    assertUploadError(await alice.sendChunk(outOfOrder, content.subarray(chunkSize), chunkSize), ERROR_CODES.invalidOffset);

    const wrongHash = await alice.init("bad-chunk-hash.bin", 1, sha256Hex(Buffer.from([1])));
    assertUploadError(await alice.sendChunk(wrongHash, Buffer.from([1]), 0, true), ERROR_CODES.hashMismatch);
  });

  await t.test("rejects unauthenticated, traversing, and cross-user destinations", async () => {
    const anonymous = await makeClient();
    assertUploadError(
      await anonymous.request("UPLOAD_INIT", { path: "anonymous.txt", fileSize: 0, fileSha256: sha256Hex(Buffer.alloc(0)) }),
      ERROR_CODES.authRequired,
    );
    const bob = await makeClient("Bob");
    assertUploadError(
      await bob.request("UPLOAD_INIT", { path: `../${aliceId}/stolen.txt`, fileSize: 0, fileSha256: sha256Hex(Buffer.alloc(0)) }),
      ERROR_CODES.invalidPath,
    );
    assertUploadError(
      await bob.request("UPLOAD_INIT", { path: "C:/Windows/stolen.txt", fileSize: 0, fileSha256: sha256Hex(Buffer.alloc(0)) }),
      ERROR_CODES.invalidPath,
    );
    assert.equal(await exists(join(storageRoot, "users", aliceId, "stolen.txt")), false);
  });

  await t.test("cleans temporary files on disconnect and explicit abort", async () => {
    const disconnecting = await makeClient("Alice");
    const content = deterministicBytes(chunkSize * 2);
    const ready = await disconnecting.init("disconnect.bin", content.length, sha256Hex(content));
    await disconnecting.sendChunk(ready, content.subarray(0, chunkSize), 0);
    disconnecting.close();
    await delay(100);
    assert.equal(await exists(join(storageRoot, "users", aliceId, "disconnect.bin")), false);

    const aborting = await makeClient("Alice");
    const abortReady = await aborting.init("cancelled.bin", content.length, sha256Hex(content));
    await aborting.sendChunk(abortReady, content.subarray(0, chunkSize), 0);
    const aborted = await aborting.request("UPLOAD_ABORT", { transferId: transferId(abortReady) });
    assert.equal(aborted.type, "UPLOAD_ABORTED");
    assert.equal(await exists(join(storageRoot, "users", aliceId, "cancelled.bin")), false);
    assert.deepEqual(await listPartFiles(join(storageRoot, ".upload-tmp")), []);
  });

  await t.test("handles active and committed filename conflicts without overwrite", async () => {
    const first = await makeClient("Alice");
    const second = await makeClient("Alice");
    const emptyHash = sha256Hex(Buffer.alloc(0));
    const reserved = await first.init("reserved.bin", 0, emptyHash);
    assertUploadError(
      await second.request("UPLOAD_INIT", { path: "reserved.bin", fileSize: 0, fileSha256: emptyHash }),
      ERROR_CODES.fileExists,
    );
    await first.request("UPLOAD_ABORT", { transferId: transferId(reserved) });

    const original = Buffer.from("original");
    await alice.upload("conflict.txt", original);
    assertUploadError(
      await alice.request("UPLOAD_INIT", { path: "conflict.txt", fileSize: 0, fileSha256: emptyHash }),
      ERROR_CODES.fileExists,
    );
    assert.deepEqual(await readFile(join(storageRoot, "users", aliceId, "conflict.txt")), original);
  });

  await t.test("enforces the configured single-file limit", async () => {
    assertUploadError(
      await alice.request("UPLOAD_INIT", {
        path: "too-large.bin",
        fileSize: 2 * 1024 * 1024 + 1,
        fileSha256: "00".repeat(32),
      }),
      ERROR_CODES.quotaExceeded,
    );
  });

  await t.test("enforces total quota and file-count limits during initialization", async () => {
    assertUploadError(
      await alice.request("UPLOAD_INIT", {
        path: "quota-overflow.bin",
        fileSize: 1536 * 1024,
        fileSha256: "00".repeat(32),
      }),
      ERROR_CODES.quotaExceeded,
    );
    const bob = await makeClient("Bob");
    await bob.upload("only-file.txt", Buffer.from("one"));
    assertUploadError(
      await bob.request("UPLOAD_INIT", {
        path: "second-file.txt",
        fileSize: 0,
        fileSha256: sha256Hex(Buffer.alloc(0)),
      }),
      ERROR_CODES.quotaExceeded,
    );
  });
});

class UploadTestClient {
  private readonly pending = new Map<string, {
    resolve: (message: ControlMessage<unknown>) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  heartbeatCount = 0;

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      const message = parseControlMessage(data.toString());
      if (message.type === "HEARTBEAT_PING") {
        const payload = record(message.payload);
        socket.send(serializeControlMessage(createControlMessage("HEARTBEAT_PONG", message.requestId, { nonce: payload.nonce })));
        this.heartbeatCount += 1;
        return;
      }
      const waiter = this.pending.get(message.requestId);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.pending.delete(message.requestId);
      waiter.resolve(message);
    });
  }

  static async connect(url: string): Promise<UploadTestClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolvePromise, reject) => {
      socket.once("open", resolvePromise);
      socket.once("error", reject);
    });
    const client = new UploadTestClient(socket);
    assert.equal((await client.request("HELLO", { protocol: PROTOCOL_NAME, clientName: "upload-integration" })).type, "HELLO_ACK");
    return client;
  }

  async login(username: string, password: string): Promise<void> {
    assert.equal((await this.request("AUTH_LOGIN", { username, password })).type, "AUTH_SUCCESS");
  }

  async init(path: string, fileSize: number, fileSha256: string): Promise<ControlMessage<unknown>> {
    const response = await this.request("UPLOAD_INIT", { path, fileSize, fileSha256 });
    assert.equal(response.type, "UPLOAD_READY");
    Object.assign(record(response.payload), { __fileSize: fileSize });
    return response;
  }

  async upload(path: string, content: Uint8Array): Promise<ControlMessage<unknown>> {
    const ready = await this.init(path, content.byteLength, sha256Hex(content));
    await this.sendAllChunks(ready, content);
    const complete = await this.request("UPLOAD_FINISH", { transferId: transferId(ready) });
    assert.equal(complete.type, "UPLOAD_COMPLETE");
    return complete;
  }

  async sendAllChunks(ready: ControlMessage<unknown>, content: Uint8Array): Promise<void> {
    const negotiatedChunkSize = record(ready.payload).chunkSize as number;
    for (let offset = 0; offset < content.byteLength; offset += negotiatedChunkSize) {
      const chunk = content.subarray(offset, Math.min(content.byteLength, offset + negotiatedChunkSize));
      const ack = await this.sendChunk(ready, chunk, offset);
      assert.equal(ack.type, "UPLOAD_ACK");
    }
  }

  sendChunk(
    ready: ControlMessage<unknown>,
    chunk: Uint8Array,
    offset: number,
    corruptHash = false,
  ): Promise<ControlMessage<unknown>> {
    const requestId = randomUUID();
    const hash = createHash("sha256").update(chunk).digest();
    if (corruptHash) hash[0] = (hash[0] ?? 0) ^ 0xff;
    const frame = encodeBinaryFrame({
      messageType: BINARY_MESSAGE_TYPES.uploadChunk,
      flags: BINARY_FLAGS.ackRequired,
      errorCode: 0,
      requestId,
      transferId: transferId(ready),
      fileSize: BigInt(record(ready.payload).__fileSize as number),
      offset: BigInt(offset),
      payloadSha256: hash,
    }, chunk);
    return this.sendBinary(requestId, frame);
  }

  request(type: ControlMessageType, payload: Record<string, unknown>): Promise<ControlMessage<unknown>> {
    const requestId = randomUUID();
    return this.waitAndSend(requestId, () => {
      this.socket.send(serializeControlMessage(createControlMessage(type, requestId, payload)));
    });
  }

  close(): void {
    this.socket.terminate();
  }

  private sendBinary(requestId: string, frame: Uint8Array): Promise<ControlMessage<unknown>> {
    return this.waitAndSend(requestId, () => this.socket.send(frame));
  }

  private waitAndSend(requestId: string, sendAction: () => void): Promise<ControlMessage<unknown>> {
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("timed out waiting for upload response"));
      }, 10_000);
      this.pending.set(requestId, { resolve: resolvePromise, reject, timer });
      sendAction();
    });
  }
}

function transferId(message: ControlMessage<unknown>): string {
  return record(message.payload).transferId as string;
}

function assertUploadError(message: ControlMessage<unknown>, code: string): void {
  assert.equal(message.type, "UPLOAD_ERROR");
  assert.equal(record(message.payload).code, code);
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function sha256Hex(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function deterministicBytes(size: number): Buffer {
  const result = Buffer.allocUnsafe(size);
  for (let index = 0; index < result.length; index += 1) result[index] = (index * 31 + 17) & 0xff;
  return result;
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function listPartFiles(root: string): Promise<string[]> {
  if (!await exists(root)) return [];
  const entries = await readdir(root, { recursive: true });
  return entries.filter((entry) => entry.endsWith(".part"));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
