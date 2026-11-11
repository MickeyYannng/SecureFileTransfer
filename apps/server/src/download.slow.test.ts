import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket, type RawData } from "ws";
import {
  BINARY_MESSAGE_TYPES,
  PROTOCOL_NAME,
  bytesToHex,
  createControlMessage,
  parseBinaryFrame,
  parseControlMessage,
  serializeControlMessage,
  type ControlMessage,
  type ControlMessageType,
  type ParsedBinaryFrame,
} from "@sft/protocol";
import { startServer } from "./server.js";

const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const testRunsRoot = resolve(workspaceRoot, ".cache", "test-runs");
const fileSize = 100 * 1024 * 1024;
const chunkSize = 256 * 1024;
const userId = "ffffffff-ffff-4fff-8fff-ffffffffffff";

test("slow: downloads and verifies a 100 MiB file without whole-file buffering", { timeout: 120_000 }, async (t) => {
  await mkdir(testRunsRoot, { recursive: true });
  const runRoot = join(testRunsRoot, randomUUID());
  const storageRoot = join(runRoot, "storage");
  const userRoot = join(storageRoot, "users", userId);
  await mkdir(userRoot, { recursive: true });
  const expectedHash = await createSourceFile(join(userRoot, "source-100m.bin"));
  const server = await startServer({
    port: 0,
    databasePath: ":memory:",
    storageRoot,
    downloadChunkSize: chunkSize,
    downloadAckTimeoutMs: 30_000,
    initialUsers: [{ id: userId, username: "Alice", password: "Alice-Slow-Download-2026!", displayName: "Alice" }],
    logger: { info() {}, warn() {}, error() {} },
  });
  const client = await StreamingDownloadClient.connect(`ws://${server.host}:${server.port}/ws`);
  t.after(async () => {
    client.close();
    await server.close();
    await rm(runRoot, { recursive: true, force: true });
  });
  await client.login("Alice", "Alice-Slow-Download-2026!");
  const result = await client.download("source-100m.bin");
  assert.equal(result.bytesReceived, fileSize);
  assert.equal(result.sha256, expectedHash);
  assert.equal((await client.request("AUTH_ME", {})).type, "AUTH_ME_RESULT");
});

class StreamingDownloadClient {
  private readonly pending = new Map<string, (message: ControlMessage<unknown>) => void>();
  private readonly events: Array<ControlMessage<unknown> | ParsedBinaryFrame> = [];
  private readonly waiters: Array<(event: ControlMessage<unknown> | ParsedBinaryFrame) => void> = [];

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        this.push(parseBinaryFrame(toBytes(data), chunkSize));
        return;
      }
      const message = parseControlMessage(data.toString());
      if (message.type === "HEARTBEAT_PING") {
        this.send("HEARTBEAT_PONG", { nonce: record(message.payload).nonce }, message.requestId);
        return;
      }
      const pending = this.pending.get(message.requestId);
      if (pending) { this.pending.delete(message.requestId); pending(message); }
      else this.push(message);
    });
  }

  static async connect(url: string): Promise<StreamingDownloadClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolvePromise, reject) => {
      socket.once("open", resolvePromise);
      socket.once("error", reject);
    });
    const client = new StreamingDownloadClient(socket);
    assert.equal((await client.request("HELLO", { protocol: PROTOCOL_NAME, clientName: "slow-download-test" })).type, "HELLO_ACK");
    return client;
  }

  async login(username: string, password: string): Promise<void> {
    assert.equal((await this.request("AUTH_LOGIN", { username, password })).type, "AUTH_SUCCESS");
  }

  async download(path: string): Promise<{ bytesReceived: number; sha256: string }> {
    const ready = await this.request("DOWNLOAD_INIT", { path });
    assert.equal(ready.type, "DOWNLOAD_READY");
    const payload = record(ready.payload);
    const transferId = payload.transferId as string;
    assert.equal(payload.fileSize, fileSize);
    assert.equal(payload.fileSha256, await this.hashFromProtocol(transferId));
    return { bytesReceived: fileSize, sha256: payload.fileSha256 as string };
  }

  private async hashFromProtocol(transferId: string): Promise<string> {
    const hash = createHash("sha256");
    let offset = 0;
    while (offset < fileSize) {
      const event = await this.next();
      assert.ok("header" in event);
      assert.equal(event.header.messageType, BINARY_MESSAGE_TYPES.downloadChunk);
      assert.equal(event.header.transferId, transferId);
      assert.equal(Number(event.header.offset), offset);
      assert.equal(bytesToHex(createHash("sha256").update(event.payload).digest()), bytesToHex(event.header.payloadSha256));
      hash.update(event.payload);
      offset += event.payload.byteLength;
      this.send("DOWNLOAD_ACK", { transferId, nextOffset: offset });
    }
    const finish = await this.next();
    assert.ok("type" in finish);
    assert.equal(finish.type, "DOWNLOAD_FINISH");
    const digest = hash.digest("hex");
    const complete = await this.request("DOWNLOAD_COMPLETE", {
      transferId, success: true, receivedSize: offset, fileSha256: digest,
    });
    assert.equal(complete.type, "DOWNLOAD_COMPLETE");
    return digest;
  }

  request(type: ControlMessageType, payload: Record<string, unknown>): Promise<ControlMessage<unknown>> {
    const requestId = randomUUID();
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error("slow download response timeout")); }, 30_000);
      this.pending.set(requestId, (message) => { clearTimeout(timer); resolvePromise(message); });
      this.send(type, payload, requestId);
    });
  }

  send(type: ControlMessageType, payload: Record<string, unknown>, requestId: string = randomUUID()): void {
    this.socket.send(serializeControlMessage(createControlMessage(type, requestId, payload)));
  }

  close(): void { this.socket.terminate(); }

  private next(): Promise<ControlMessage<unknown> | ParsedBinaryFrame> {
    const event = this.events.shift();
    if (event) return Promise.resolve(event);
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("slow download event timeout")), 30_000);
      this.waiters.push((nextEvent) => { clearTimeout(timer); resolvePromise(nextEvent); });
    });
  }

  private push(event: ControlMessage<unknown> | ParsedBinaryFrame): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(event); else this.events.push(event);
  }
}

async function createSourceFile(path: string): Promise<string> {
  const handle = await open(path, "wx");
  const hash = createHash("sha256");
  const block = Buffer.allocUnsafe(1024 * 1024);
  for (let index = 0; index < block.length; index += 1) block[index] = (index * 23 + 11) & 0xff;
  try {
    for (let offset = 0; offset < fileSize; offset += block.length) {
      await handle.write(block, 0, block.length, offset);
      hash.update(block);
    }
    await handle.sync();
  } finally { await handle.close(); }
  return hash.digest("hex");
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}
