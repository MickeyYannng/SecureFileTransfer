import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import selfsigned from "selfsigned";
import { WebSocket, type RawData } from "ws";
import {
  BINARY_FLAGS, BINARY_MESSAGE_TYPES, ERROR_CODES, PROTOCOL_NAME, createControlMessage,
  encodeBinaryFrame, parseBinaryFrame, parseControlMessage, serializeControlMessage,
  type ControlMessage, type ControlMessageType, type ParsedBinaryFrame,
} from "@sft/protocol";
import { startServer } from "./server.js";

const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const testRunsRoot = resolve(workspaceRoot, ".cache", "test-runs");
const origin = "https://allowed.test";
const alicePassword = "Alice-Security-2026!";
const bobPassword = "Bob-Security-2026!";

test("WSS security and concurrent multi-user transfers", async (t) => {
  const tls = await createTestTls();
  await mkdir(testRunsRoot, { recursive: true });
  const runRoot = join(testRunsRoot, randomUUID());
  const storageRoot = join(runRoot, "storage");
  const server = await startServer({
    port: 0, databasePath: ":memory:", storageRoot, tls: { cert: tls.cert, key: tls.key },
    allowedOrigins: [origin], maxConnections: 20, maxActiveUploadsPerUser: 3, maxActiveDownloadsPerUser: 3,
    normalBandwidthBytesPerSecond: 1024 * 1024, vipBandwidthBytesPerSecond: 5 * 1024 * 1024,
    initialUsers: [
      { username: "Alice", password: alicePassword, displayName: "Alice" },
      { username: "Bob", password: bobPassword, displayName: "Bob", role: "vip" },
    ], logger: { info() {}, warn() {}, error() {} },
  });
  const url = `wss://${server.host}:${server.port}/ws`;
  const clients: SecureTransferClient[] = [];
  t.after(async () => {
    clients.forEach((client) => client.close());
    await server.close();
    await rm(runRoot, { recursive: true, force: true });
  });

  await t.test("requires a trusted CA and allowed Origin", async () => {
    await assert.rejects(connectRaw(url, { origin }));
    await assert.rejects(connectRaw(url, { origin: "https://evil.test", ca: tls.ca }));
    const socket = await connectRaw(url, { origin, ca: tls.ca });
    socket.terminate();
  });

  await t.test("uploads and downloads three Alice files while Bob transfers concurrently", async () => {
    const aliceContents = [0, 1, 2].map((index) => deterministicBytes(180_000 + index * 17));
    const bobContent = deterministicBytes(200_123);
    const aliceClients = await Promise.all(aliceContents.map(async () => {
      const client = await SecureTransferClient.connect(url, tls.ca); clients.push(client);
      await client.login("Alice", alicePassword); return client;
    }));
    const bob = await SecureTransferClient.connect(url, tls.ca); clients.push(bob);
    await bob.login("Bob", bobPassword);

    await Promise.all([
      ...aliceClients.map((client, index) => client.upload(`alice-${index}.bin`, aliceContents[index]!)),
      bob.upload("bob.bin", bobContent),
    ]);
    const downloaded = await Promise.all([
      ...aliceClients.map((client, index) => client.download(`alice-${index}.bin`)),
      bob.download("bob.bin"),
    ]);
    aliceContents.forEach((content, index) => assert.deepEqual(downloaded[index], content));
    assert.deepEqual(downloaded[3], bobContent);
    assert.equal((await aliceClients[0]!.request("AUTH_ME", {})).type, "AUTH_ME_RESULT");
  });

  await t.test("applies a higher server-side transfer rate to VIP users", async () => {
    const content = deterministicBytes(1024 * 1024);
    const alice = await SecureTransferClient.connect(url, tls.ca); clients.push(alice); await alice.login("Alice", alicePassword);
    const bob = await SecureTransferClient.connect(url, tls.ca); clients.push(bob); await bob.login("Bob", bobPassword);
    const aliceStarted = performance.now();
    await alice.upload("normal-rate.bin", content);
    const aliceDuration = performance.now() - aliceStarted;
    const bobStarted = performance.now();
    await bob.upload("vip-rate.bin", content);
    const bobDuration = performance.now() - bobStarted;
    assert.ok(aliceDuration > bobDuration * 2, `expected normal ${aliceDuration}ms to be slower than VIP ${bobDuration}ms`);
  });

  await t.test("enforces connection and login limits", async () => {
    const limitedRoot = join(runRoot, "limited");
    const limited = await startServer({
      port: 0, databasePath: ":memory:", storageRoot: limitedRoot, tls: { cert: tls.cert, key: tls.key },
      allowedOrigins: [origin], maxConnections: 1, loginMaxAttempts: 2, loginWindowMs: 60_000,
      initialUsers: [{ username: "Alice", password: alicePassword, displayName: "Alice" }],
      logger: { info() {}, warn() {}, error() {} },
    });
    const limitedUrl = `wss://${limited.host}:${limited.port}/ws`;
    const first = await SecureTransferClient.connect(limitedUrl, tls.ca);
    try {
      await assert.rejects(connectRaw(limitedUrl, { origin, ca: tls.ca }));
      const wrong1 = await first.request("AUTH_LOGIN", { username: "Alice", password: "wrong-1" });
      const wrong2 = await first.request("AUTH_LOGIN", { username: "Alice", password: "wrong-2" });
      assert.equal(record(wrong1.payload).code, ERROR_CODES.invalidCredentials);
      assert.equal(record(wrong2.payload).code, ERROR_CODES.invalidCredentials);
      const limitedLogin = await first.request("AUTH_LOGIN", { username: "Alice", password: alicePassword });
      assert.equal(limitedLogin.type, "ERROR");
      assert.equal(record(limitedLogin.payload).code, ERROR_CODES.rateLimited);
    } finally {
      first.close();
      await limited.close();
    }
  });
});

class SecureTransferClient {
  private readonly pending = new Map<string, (message: ControlMessage<unknown>) => void>();
  private readonly events: Array<ParsedBinaryFrame | ControlMessage<unknown>> = [];
  private readonly waiters: Array<(event: ParsedBinaryFrame | ControlMessage<unknown>) => void> = [];
  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (data, binary) => {
      if (binary) { this.push(parseBinaryFrame(toBytes(data), 1024 * 1024)); return; }
      const message = parseControlMessage(data.toString());
      if (message.type === "HEARTBEAT_PING") {
        this.send("HEARTBEAT_PONG", { nonce: record(message.payload).nonce }, message.requestId); return;
      }
      const pending = this.pending.get(message.requestId);
      if (pending) { this.pending.delete(message.requestId); pending(message); } else this.push(message);
    });
  }
  static async connect(url: string, ca: string): Promise<SecureTransferClient> {
    const socket = await connectRaw(url, { origin, ca });
    const client = new SecureTransferClient(socket);
    assert.equal((await client.request("HELLO", { protocol: PROTOCOL_NAME, clientName: "security-test" })).type, "HELLO_ACK");
    return client;
  }
  async login(username: string, password: string): Promise<void> {
    assert.equal((await this.request("AUTH_LOGIN", { username, password })).type, "AUTH_SUCCESS");
  }
  async upload(path: string, content: Uint8Array): Promise<void> {
    const ready = await this.request("UPLOAD_INIT", { path, fileSize: content.byteLength, fileSha256: sha(content) });
    assert.equal(ready.type, "UPLOAD_READY");
    const meta = record(ready.payload); const transferId = meta.transferId as string; const chunkSize = meta.chunkSize as number;
    for (let offset = 0; offset < content.byteLength; offset += chunkSize) {
      const payload = content.subarray(offset, Math.min(offset + chunkSize, content.byteLength));
      const requestId = randomUUID();
      const frame = encodeBinaryFrame({
        messageType: BINARY_MESSAGE_TYPES.uploadChunk, flags: BINARY_FLAGS.ackRequired, errorCode: 0,
        requestId, transferId, fileSize: BigInt(content.byteLength), offset: BigInt(offset),
        payloadSha256: createHash("sha256").update(payload).digest(),
      }, payload);
      assert.equal((await this.waitSend(requestId, () => this.socket.send(frame))).type, "UPLOAD_ACK");
    }
    assert.equal((await this.request("UPLOAD_FINISH", { transferId })).type, "UPLOAD_COMPLETE");
  }
  async download(path: string): Promise<Buffer> {
    const ready = await this.request("DOWNLOAD_INIT", { path });
    assert.equal(ready.type, "DOWNLOAD_READY");
    const meta = record(ready.payload); const transferId = meta.transferId as string; const size = meta.fileSize as number;
    const chunks: Buffer[] = []; const hash = createHash("sha256"); let offset = 0;
    while (offset < size) {
      const event = await this.next(); assert.ok("header" in event); assert.equal(event.header.transferId, transferId);
      chunks.push(Buffer.from(event.payload)); hash.update(event.payload); offset += event.payload.byteLength;
      this.send("DOWNLOAD_ACK", { transferId, nextOffset: offset });
    }
    const finish = await this.next(); assert.ok("type" in finish); assert.equal(finish.type, "DOWNLOAD_FINISH");
    const digest = hash.digest("hex"); assert.equal(digest, meta.fileSha256);
    assert.equal((await this.request("DOWNLOAD_COMPLETE", { transferId, success: true, receivedSize: offset, fileSha256: digest })).type, "DOWNLOAD_COMPLETE");
    return Buffer.concat(chunks);
  }
  request(type: ControlMessageType, payload: Record<string, unknown>): Promise<ControlMessage<unknown>> {
    const id = randomUUID(); return this.waitSend(id, () => this.send(type, payload, id));
  }
  send(type: ControlMessageType, payload: Record<string, unknown>, id: string = randomUUID()): void {
    this.socket.send(serializeControlMessage(createControlMessage(type, id, payload)));
  }
  close(): void { this.socket.terminate(); }
  private waitSend(id: string, action: () => void): Promise<ControlMessage<unknown>> {
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("response timeout")), 10_000);
      this.pending.set(id, (message) => { clearTimeout(timer); resolvePromise(message); }); action();
    });
  }
  private next(): Promise<ParsedBinaryFrame | ControlMessage<unknown>> {
    const event = this.events.shift(); if (event) return Promise.resolve(event);
    return new Promise((resolvePromise) => this.waiters.push(resolvePromise));
  }
  private push(event: ParsedBinaryFrame | ControlMessage<unknown>): void {
    const waiter = this.waiters.shift(); if (waiter) waiter(event); else this.events.push(event);
  }
}

async function createTestTls(): Promise<{ ca: string; cert: string; key: string }> {
  const ca = await selfsigned.generate([{ name: "commonName", value: "Test CA" }], {
    algorithm: "sha256", extensions: [{ name: "basicConstraints", cA: true }, { name: "keyUsage", keyCertSign: true }],
  });
  const server = await selfsigned.generate([{ name: "commonName", value: "localhost" }], {
    algorithm: "sha256", ca: { key: ca.private, cert: ca.cert },
    extensions: [{ name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] }, { name: "extKeyUsage", serverAuth: true }],
  });
  return { ca: ca.cert, cert: server.cert, key: server.private };
}
function connectRaw(url: string, options: { origin: string; ca?: string }): Promise<WebSocket> {
  return new Promise((resolvePromise, reject) => {
    const socket = new WebSocket(url, { origin: options.origin, ...(options.ca ? { ca: options.ca } : {}) });
    socket.once("open", () => resolvePromise(socket)); socket.once("error", reject);
  });
}
function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value)); return value as Record<string, unknown>;
}
function sha(content: Uint8Array): string { return createHash("sha256").update(content).digest("hex"); }
function deterministicBytes(size: number): Buffer {
  const result = Buffer.allocUnsafe(size); for (let i = 0; i < size; i += 1) result[i] = (i * 37 + 5) & 0xff; return result;
}
function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data); if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
