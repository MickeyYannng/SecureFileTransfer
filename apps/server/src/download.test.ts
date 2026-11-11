import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket, type RawData } from "ws";
import {
  BINARY_FLAGS,
  BINARY_MESSAGE_TYPES,
  ERROR_CODES,
  PROTOCOL_NAME,
  bytesToHex,
  createControlMessage,
  encodeBinaryFrame,
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
const aliceId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const bobId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const alicePassword = "Alice-Download-2026!";
const bobPassword = "Bob-Download-2026!";
const chunkSize = 64 * 1024;

type DownloadEvent = { kind: "binary"; frame: ParsedBinaryFrame } | { kind: "control"; message: ControlMessage<unknown> };

test("Phase 2.3 single-file download integration", async (t) => {
  await mkdir(testRunsRoot, { recursive: true });
  const runRoot = join(testRunsRoot, randomUUID());
  const storageRoot = join(runRoot, "storage");
  const server = await startServer({
    port: 0,
    databasePath: ":memory:",
    storageRoot,
    heartbeatIntervalMs: 30,
    heartbeatTimeoutMs: 500,
    downloadChunkSize: chunkSize,
    downloadAckTimeoutMs: 100,
    maxActiveDownloadsPerUser: 1,
    initialUsers: [
      { id: aliceId, username: "Alice", password: alicePassword, displayName: "Alice" },
      { id: bobId, username: "Bob", password: bobPassword, displayName: "Bob" },
    ],
    logger: { info() {}, warn() {}, error() {} },
  });
  const aliceRoot = join(storageRoot, "users", aliceId);
  const clients: DownloadTestClient[] = [];
  const makeClient = async (username?: "Alice" | "Bob") => {
    const client = await DownloadTestClient.connect(`ws://${server.host}:${server.port}/ws`, chunkSize);
    clients.push(client);
    if (username) await client.login(username, username === "Alice" ? alicePassword : bobPassword);
    return client;
  };
  t.after(async () => {
    for (const client of clients) client.close();
    await server.close();
    await rm(runRoot, { recursive: true, force: true });
  });

  const alice = await makeClient("Alice");

  await t.test("downloads zero-byte and small text files and keeps the socket open", async () => {
    await writeFile(join(aliceRoot, "empty.bin"), Buffer.alloc(0));
    assert.deepEqual(await alice.download("empty.bin"), Buffer.alloc(0));
    const text = Buffer.from("安全下载 / Phase 2.3\n", "utf8");
    await writeFile(join(aliceRoot, "hello.txt"), text);
    assert.deepEqual(await alice.download("hello.txt"), text);
    assert.equal((await alice.request("AUTH_ME", {})).type, "AUTH_ME_RESULT");
    await delay(70);
    assert.ok(alice.heartbeatCount > 0);
  });

  await t.test("downloads a 1 MiB binary file with matching bytes and SHA-256", async () => {
    const content = deterministicBytes(1024 * 1024);
    await writeFile(join(aliceRoot, "one-megabyte.bin"), content);
    const downloaded = await alice.download("one-megabyte.bin");
    assert.deepEqual(downloaded, content);
    assert.equal(sha256Hex(downloaded), sha256Hex(content));
  });

  await t.test("reconnects and resumes a download from the acknowledged offset", async () => {
    const content = deterministicBytes(chunkSize * 3 + 77);
    await writeFile(join(storageRoot, "users", aliceId, "resumed-download.bin"), content);
    const first = await makeClient("Alice");
    const ready = await first.request("DOWNLOAD_INIT", { path: "resumed-download.bin" });
    assert.equal(ready.type, "DOWNLOAD_READY");
    const firstId = transferId(ready);
    const firstChunk = await first.nextBinary();
    const offset = firstChunk.payload.byteLength;
    assert.deepEqual(Buffer.from(firstChunk.payload), content.subarray(0, offset));
    first.send("DOWNLOAD_ACK", { transferId: firstId, nextOffset: offset });
    first.close();
    await delay(30);

    const resumed = await makeClient("Alice");
    const resumedReady = await resumed.request("DOWNLOAD_INIT", { path: "resumed-download.bin", offset });
    assert.equal(resumedReady.type, "DOWNLOAD_READY");
    assert.equal(record(resumedReady.payload).nextOffset, offset);
    const resumedId = transferId(resumedReady);
    const chunks: Buffer[] = [content.subarray(0, offset)];
    let received = offset;
    while (received < content.length) {
      const frame = await resumed.nextBinary();
      assert.equal(frame.header.offset, BigInt(received));
      chunks.push(Buffer.from(frame.payload));
      received += frame.payload.byteLength;
      resumed.send("DOWNLOAD_ACK", { transferId: resumedId, nextOffset: received });
    }
    assert.equal((await resumed.nextControl()).type, "DOWNLOAD_FINISH");
    const digest = sha256Hex(Buffer.concat(chunks));
    const completed = await resumed.request("DOWNLOAD_COMPLETE", {
      transferId: resumedId, success: true, receivedSize: received, fileSha256: digest,
    });
    assert.equal(completed.type, "DOWNLOAD_COMPLETE");
    assert.equal(digest, sha256Hex(content));
  });

  await t.test("downloads content previously committed by the upload protocol", async () => {
    const content = deterministicBytes(chunkSize * 2 + 123);
    await alice.upload("roundtrip.bin", content);
    assert.deepEqual(await alice.download("roundtrip.bin"), content);
    assert.deepEqual(await readFile(join(aliceRoot, "roundtrip.bin")), content);
  });

  await t.test("rejects unauthenticated, cross-user and traversing paths", async () => {
    await writeFile(join(aliceRoot, "alice-only.txt"), "Alice only");
    const anonymous = await makeClient();
    assertDownloadError(await anonymous.request("DOWNLOAD_INIT", { path: "alice-only.txt" }), ERROR_CODES.authRequired);
    const bob = await makeClient("Bob");
    assertDownloadError(await bob.request("DOWNLOAD_INIT", { path: "alice-only.txt" }), ERROR_CODES.notFound);
    assertDownloadError(await bob.request("DOWNLOAD_INIT", { path: `../${aliceId}/alice-only.txt` }), ERROR_CODES.invalidPath);
    assertDownloadError(await bob.request("DOWNLOAD_INIT", { path: "C:/Windows/win.ini" }), ERROR_CODES.invalidPath);
    assertDownloadError(await bob.request("DOWNLOAD_INIT", { path: "CON.txt" }), ERROR_CODES.invalidPath);
  });

  await t.test("rejects wrong and duplicate ACK offsets and releases task slots", async () => {
    const content = deterministicBytes(chunkSize * 2);
    await writeFile(join(aliceRoot, "ack.bin"), content);
    const wrong = await alice.request("DOWNLOAD_INIT", { path: "ack.bin" });
    const wrongFrame = await alice.nextBinary();
    assertDownloadError(await alice.request("DOWNLOAD_ACK", {
      transferId: transferId(wrong), nextOffset: wrongFrame.header.payloadLength + 1,
    }), ERROR_CODES.invalidOffset);

    const duplicate = await alice.request("DOWNLOAD_INIT", { path: "ack.bin" });
    const first = await alice.nextBinary();
    const firstOffset = first.header.payloadLength;
    alice.send("DOWNLOAD_ACK", { transferId: transferId(duplicate), nextOffset: firstOffset });
    await alice.nextBinary();
    assertDownloadError(await alice.request("DOWNLOAD_ACK", {
      transferId: transferId(duplicate), nextOffset: firstOffset,
    }), ERROR_CODES.invalidOffset);
    assert.deepEqual(await alice.download("ack.bin"), content);
  });

  await t.test("cleans tasks after cancel, disconnect, timeout and enforces one task per user", async () => {
    const content = deterministicBytes(chunkSize * 2);
    await writeFile(join(aliceRoot, "cleanup.bin"), content);

    const cancelling = await makeClient("Alice");
    const ready = await cancelling.request("DOWNLOAD_INIT", { path: "cleanup.bin" });
    await cancelling.nextBinary();
    const aborted = await cancelling.request("DOWNLOAD_ABORT", { transferId: transferId(ready) });
    assert.equal(aborted.type, "DOWNLOAD_ABORT");
    assert.equal(record(aborted.payload).acknowledged, true);

    const holding = await makeClient("Alice");
    const held = await holding.request("DOWNLOAD_INIT", { path: "cleanup.bin" });
    await holding.nextBinary();
    const blocked = await makeClient("Alice");
    assertDownloadError(await blocked.request("DOWNLOAD_INIT", { path: "cleanup.bin" }), ERROR_CODES.tooManyTasks);
    holding.close();
    await delay(50);

    const timingOut = await makeClient("Alice");
    await timingOut.request("DOWNLOAD_INIT", { path: "cleanup.bin" });
    await timingOut.nextBinary();
    const timeout = await timingOut.nextControl(1_000);
    assertDownloadError(timeout, ERROR_CODES.ackTimeout);
    assert.deepEqual(await timingOut.download("cleanup.bin"), content);
    void held;
  });

  await t.test("does not treat DOWNLOAD_FINISH as success when client verification fails", async () => {
    const content = Buffer.from("completion must be explicit");
    await writeFile(join(aliceRoot, "complete-check.txt"), content);
    const ready = await alice.request("DOWNLOAD_INIT", { path: "complete-check.txt" });
    const frame = await alice.nextBinary();
    alice.send("DOWNLOAD_ACK", { transferId: transferId(ready), nextOffset: frame.payload.byteLength });
    const finish = await alice.nextControl();
    assert.equal(finish.type, "DOWNLOAD_FINISH");
    assertDownloadError(await alice.request("DOWNLOAD_COMPLETE", {
      transferId: transferId(ready),
      success: false,
      receivedSize: frame.payload.byteLength,
      fileSha256: "00".repeat(32),
    }), ERROR_CODES.hashMismatch);
    assert.deepEqual(await alice.download("complete-check.txt"), content);
  });

  await t.test("does not report success if the source is modified or deleted", async () => {
    const original = deterministicBytes(chunkSize * 2);
    const modifiedPath = join(aliceRoot, "modified.bin");
    await writeFile(modifiedPath, original);
    const modifiedReady = await alice.request("DOWNLOAD_INIT", { path: "modified.bin" });
    const first = await alice.nextBinary();
    await writeFile(modifiedPath, Buffer.alloc(original.length, 0x7a));
    alice.send("DOWNLOAD_ACK", {
      transferId: transferId(modifiedReady),
      nextOffset: Number(first.header.offset) + first.payload.byteLength,
    });
    const second = await alice.nextBinary();
    alice.send("DOWNLOAD_ACK", {
      transferId: transferId(modifiedReady),
      nextOffset: Number(second.header.offset) + second.payload.byteLength,
    });
    const changed = await alice.nextControl();
    assertDownloadError(changed, ERROR_CODES.sourceChanged);

    const deletedPath = join(aliceRoot, "deleted.bin");
    await writeFile(deletedPath, deterministicBytes(1024));
    const deletedReady = await alice.request("DOWNLOAD_INIT", { path: "deleted.bin" });
    const only = await alice.nextBinary();
    await unlink(deletedPath);
    alice.send("DOWNLOAD_ACK", { transferId: transferId(deletedReady), nextOffset: only.payload.byteLength });
    assertDownloadError(await alice.nextControl(), ERROR_CODES.sourceChanged);
    await assert.rejects(stat(deletedPath));
  });
});

class DownloadTestClient {
  private readonly pending = new Map<string, (message: ControlMessage<unknown>) => void>();
  private readonly events: DownloadEvent[] = [];
  private readonly eventWaiters: Array<(event: DownloadEvent) => void> = [];
  heartbeatCount = 0;

  private constructor(private readonly socket: WebSocket, private readonly chunkSize: number) {
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        this.pushEvent({ kind: "binary", frame: parseBinaryFrame(toBytes(data), chunkSize) });
        return;
      }
      const message = parseControlMessage(data.toString());
      if (message.type === "HEARTBEAT_PING") {
        this.heartbeatCount += 1;
        this.send("HEARTBEAT_PONG", { nonce: record(message.payload).nonce }, message.requestId);
        return;
      }
      const waiter = this.pending.get(message.requestId);
      if (waiter) {
        this.pending.delete(message.requestId);
        waiter(message);
      } else {
        this.pushEvent({ kind: "control", message });
      }
    });
  }

  static async connect(url: string, chunkSize: number): Promise<DownloadTestClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolvePromise, reject) => {
      socket.once("open", resolvePromise);
      socket.once("error", reject);
    });
    const client = new DownloadTestClient(socket, chunkSize);
    assert.equal((await client.request("HELLO", { protocol: PROTOCOL_NAME, clientName: "download-test" })).type, "HELLO_ACK");
    return client;
  }

  async login(username: string, password: string): Promise<void> {
    assert.equal((await this.request("AUTH_LOGIN", { username, password })).type, "AUTH_SUCCESS");
  }

  async download(path: string): Promise<Buffer> {
    const ready = await this.request("DOWNLOAD_INIT", { path });
    assert.equal(ready.type, "DOWNLOAD_READY");
    const metadata = record(ready.payload);
    const id = metadata.transferId as string;
    const fileSize = metadata.fileSize as number;
    const expectedHash = metadata.fileSha256 as string;
    const chunks: Buffer[] = [];
    const hasher = createHash("sha256");
    let offset = 0;
    while (offset < fileSize) {
      const frame = await this.nextBinary();
      assert.equal(frame.header.messageType, BINARY_MESSAGE_TYPES.downloadChunk);
      assert.equal(frame.header.transferId, id);
      assert.equal(Number(frame.header.offset), offset);
      assert.equal(bytesToHex(createHash("sha256").update(frame.payload).digest()), bytesToHex(frame.header.payloadSha256));
      chunks.push(Buffer.from(frame.payload));
      hasher.update(frame.payload);
      offset += frame.payload.byteLength;
      this.send("DOWNLOAD_ACK", { transferId: id, nextOffset: offset });
    }
    const finish = await this.nextControl();
    assert.equal(finish.type, "DOWNLOAD_FINISH");
    assert.equal(record(finish.payload).transferId, id);
    const digest = hasher.digest("hex");
    assert.equal(digest, expectedHash);
    const completed = await this.request("DOWNLOAD_COMPLETE", {
      transferId: id, success: true, receivedSize: offset, fileSha256: digest,
    });
    assert.equal(completed.type, "DOWNLOAD_COMPLETE");
    assert.equal(record(completed.payload).accepted, true);
    return Buffer.concat(chunks);
  }

  async upload(path: string, content: Uint8Array): Promise<void> {
    const ready = await this.request("UPLOAD_INIT", { path, fileSize: content.byteLength, fileSha256: sha256Hex(content) });
    assert.equal(ready.type, "UPLOAD_READY");
    const id = transferId(ready);
    const size = record(ready.payload).chunkSize as number;
    for (let offset = 0; offset < content.byteLength; offset += size) {
      const payload = content.subarray(offset, Math.min(content.byteLength, offset + size));
      const requestId = randomUUID();
      const frame = encodeBinaryFrame({
        messageType: BINARY_MESSAGE_TYPES.uploadChunk,
        flags: BINARY_FLAGS.ackRequired,
        errorCode: 0,
        requestId,
        transferId: id,
        fileSize: BigInt(content.byteLength),
        offset: BigInt(offset),
        payloadSha256: createHash("sha256").update(payload).digest(),
      }, payload);
      const ack = await this.waitAndSend(requestId, () => this.socket.send(frame));
      assert.equal(ack.type, "UPLOAD_ACK");
    }
    assert.equal((await this.request("UPLOAD_FINISH", { transferId: id })).type, "UPLOAD_COMPLETE");
  }

  request(type: ControlMessageType, payload: Record<string, unknown>): Promise<ControlMessage<unknown>> {
    const requestId = randomUUID();
    return this.waitAndSend(requestId, () => this.send(type, payload, requestId));
  }

  send(type: ControlMessageType, payload: Record<string, unknown>, requestId: string = randomUUID()): void {
    this.socket.send(serializeControlMessage(createControlMessage(type, requestId, payload)));
  }

  async nextBinary(timeout = 3_000): Promise<ParsedBinaryFrame> {
    const event = await this.nextEvent(timeout);
    assert.equal(event.kind, "binary");
    return event.frame;
  }

  async nextControl(timeout = 3_000): Promise<ControlMessage<unknown>> {
    const event = await this.nextEvent(timeout);
    assert.equal(event.kind, "control");
    return event.message;
  }

  close(): void { this.socket.terminate(); }

  private waitAndSend(requestId: string, action: () => void): Promise<ControlMessage<unknown>> {
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("timed out waiting for control response"));
      }, 5_000);
      this.pending.set(requestId, (message) => { clearTimeout(timer); resolvePromise(message); });
      action();
    });
  }

  private nextEvent(timeout: number): Promise<DownloadEvent> {
    const queued = this.events.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for download event")), timeout);
      this.eventWaiters.push((event) => { clearTimeout(timer); resolvePromise(event); });
    });
  }

  private pushEvent(event: DownloadEvent): void {
    const waiter = this.eventWaiters.shift();
    if (waiter) waiter(event); else this.events.push(event);
  }
}

function transferId(message: ControlMessage<unknown>): string { return record(message.payload).transferId as string; }
function assertDownloadError(message: ControlMessage<unknown>, code: string): void {
  assert.equal(message.type, "DOWNLOAD_ERROR");
  assert.equal(record(message.payload).code, code);
}
function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function sha256Hex(content: Uint8Array): string { return createHash("sha256").update(content).digest("hex"); }
function deterministicBytes(size: number): Buffer {
  const result = Buffer.allocUnsafe(size);
  for (let index = 0; index < result.length; index += 1) result[index] = (index * 47 + 19) & 0xff;
  return result;
}
function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
function delay(milliseconds: number): Promise<void> { return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)); }
