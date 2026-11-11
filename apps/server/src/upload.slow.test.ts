import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import {
  BINARY_FLAGS,
  BINARY_MESSAGE_TYPES,
  PROTOCOL_NAME,
  createControlMessage,
  encodeBinaryFrame,
  parseControlMessage,
  serializeControlMessage,
  type ControlMessage,
  type ControlMessageType,
} from "@sft/protocol";
import { startServer } from "./server.js";

const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const testRunsRoot = resolve(workspaceRoot, ".cache", "test-runs");
const fileSize = 100 * 1024 * 1024;
const chunkSize = 256 * 1024;
const userId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

test("slow: uploads and verifies a 100 MiB file", { timeout: 120_000 }, async (t) => {
  await mkdir(testRunsRoot, { recursive: true });
  const runRoot = join(testRunsRoot, randomUUID());
  await mkdir(runRoot, { recursive: true });
  const sourcePath = join(runRoot, "source-100m.bin");
  const expectedHash = await createSourceFile(sourcePath);
  const storageRoot = join(runRoot, "storage");
  const server = await startServer({
    port: 0,
    databasePath: ":memory:",
    storageRoot,
    uploadChunkSize: chunkSize,
    maxFileSizeBytes: 110 * 1024 * 1024,
    defaultQuotaBytes: 120 * 1024 * 1024,
    initialUsers: [{ id: userId, username: "Alice", password: "Alice-Slow-Upload-2026!", displayName: "Alice" }],
    logger: { info() {}, warn() {}, error() {} },
  });
  const client = await SlowUploadClient.connect(`ws://${server.host}:${server.port}/ws`);
  t.after(async () => {
    client.close();
    await server.close();
    await rm(runRoot, { recursive: true, force: true });
  });
  await client.login("Alice", "Alice-Slow-Upload-2026!");

  const ready = await client.request("UPLOAD_INIT", {
    path: "uploaded-100m.bin",
    fileSize,
    fileSha256: expectedHash,
  });
  assert.equal(ready.type, "UPLOAD_READY");
  const transferId = record(ready.payload).transferId as string;
  const source = await open(sourcePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(chunkSize);
    let offset = 0;
    while (offset < fileSize) {
      const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, fileSize - offset), offset);
      assert.ok(bytesRead > 0);
      const payload = buffer.subarray(0, bytesRead);
      const ack = await client.sendChunk(transferId, payload, offset);
      assert.equal(ack.type, "UPLOAD_ACK");
      offset = record(ack.payload).persistedOffset as number;
    }
  } finally {
    await source.close();
  }
  const complete = await client.request("UPLOAD_FINISH", { transferId });
  assert.equal(complete.type, "UPLOAD_COMPLETE");
  assert.equal(record(complete.payload).fileSha256, expectedHash);
  const destinationHash = await hashFile(join(storageRoot, "users", userId, "uploaded-100m.bin"));
  assert.equal(destinationHash, expectedHash);
  assert.equal((await client.request("AUTH_ME", {})).type, "AUTH_ME_RESULT");
});

class SlowUploadClient {
  private readonly pending = new Map<string, (message: ControlMessage<unknown>) => void>();

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      const message = parseControlMessage(data.toString());
      if (message.type === "HEARTBEAT_PING") {
        const nonce = record(message.payload).nonce;
        socket.send(serializeControlMessage(createControlMessage("HEARTBEAT_PONG", message.requestId, { nonce })));
        return;
      }
      this.pending.get(message.requestId)?.(message);
      this.pending.delete(message.requestId);
    });
  }

  static async connect(url: string): Promise<SlowUploadClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolvePromise, reject) => {
      socket.once("open", resolvePromise);
      socket.once("error", reject);
    });
    const client = new SlowUploadClient(socket);
    assert.equal((await client.request("HELLO", { protocol: PROTOCOL_NAME, clientName: "slow-upload-test" })).type, "HELLO_ACK");
    return client;
  }

  async login(username: string, password: string): Promise<void> {
    assert.equal((await this.request("AUTH_LOGIN", { username, password })).type, "AUTH_SUCCESS");
  }

  sendChunk(transferId: string, payload: Uint8Array, offset: number): Promise<ControlMessage<unknown>> {
    const requestId = randomUUID();
    const frame = encodeBinaryFrame({
      messageType: BINARY_MESSAGE_TYPES.uploadChunk,
      flags: BINARY_FLAGS.ackRequired,
      errorCode: 0,
      requestId,
      transferId,
      fileSize: BigInt(fileSize),
      offset: BigInt(offset),
      payloadSha256: createHash("sha256").update(payload).digest(),
    }, payload);
    return this.waitAndSend(requestId, () => this.socket.send(frame));
  }

  request(type: ControlMessageType, payload: Record<string, unknown>): Promise<ControlMessage<unknown>> {
    const requestId = randomUUID();
    return this.waitAndSend(requestId, () => {
      this.socket.send(serializeControlMessage(createControlMessage(type, requestId, payload)));
    });
  }

  close(): void { this.socket.terminate(); }

  private waitAndSend(requestId: string, action: () => void): Promise<ControlMessage<unknown>> {
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("slow upload response timeout"));
      }, 30_000);
      this.pending.set(requestId, (message) => {
        clearTimeout(timer);
        resolvePromise(message);
      });
      action();
    });
  }
}

async function createSourceFile(path: string): Promise<string> {
  const handle = await open(path, "wx");
  const hash = createHash("sha256");
  const block = Buffer.allocUnsafe(1024 * 1024);
  for (let index = 0; index < block.length; index += 1) block[index] = (index * 13 + 29) & 0xff;
  try {
    for (let offset = 0; offset < fileSize; offset += block.length) {
      await handle.write(block, 0, block.length, offset);
      hash.update(block);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}
