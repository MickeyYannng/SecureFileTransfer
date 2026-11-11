import { createHash, randomUUID, timingSafeEqual, type Hash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";
import { basename } from "node:path";
import {
  BINARY_FLAGS,
  BINARY_MESSAGE_TYPES,
  encodeBinaryFrame,
  hexToBytes,
  type DownloadCompletePayload,
  type DownloadFinishPayload,
  type DownloadReadyPayload,
  type PublicUser,
} from "@sft/protocol";
import { StorageFailure, StorageService } from "./storage.js";
import type { BandwidthLimiter } from "./bandwidth.js";

export type DownloadState = "initializing" | "sending" | "awaiting-ack" | "awaiting-complete" | "completed" | "cancelled" | "failed";

export class DownloadFailure extends Error {
  constructor(
    readonly code:
      | "INVALID_ACK"
      | "HASH_MISMATCH"
      | "SOURCE_CHANGED"
      | "FILE_TOO_LARGE"
      | "TOO_MANY_TASKS"
      | "DOWNLOAD_NOT_FOUND"
      | "DOWNLOAD_CANCELLED"
      | "ACK_TIMEOUT"
      | "IO_ERROR",
    message: string,
    readonly transferId?: string,
  ) {
    super(message);
    this.name = "DownloadFailure";
  }
}

export interface DownloadManagerOptions {
  chunkSize: number;
  ackTimeoutMs: number;
  maxActiveDownloadsGlobal: number;
  maxActiveDownloadsPerUser: number;
  bandwidthLimiter?: BandwidthLimiter;
}

export type DownloadAction =
  | { kind: "chunk"; frame: Uint8Array }
  | { kind: "finish"; payload: DownloadFinishPayload };

interface DownloadTask {
  transferId: string;
  connectionId: string;
  userId: string;
  logicalPath: string;
  canonicalPath: string;
  fileSize: number;
  fileSha256: string;
  expectedOffset: number;
  pendingNextOffset: number;
  state: DownloadState;
  fileHandle: FileHandle;
  sentHasher: Hash;
  identity: FileIdentity;
  timer?: NodeJS.Timeout;
  onTimeout: (failure: DownloadFailure) => void;
  userRole: string;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

export class DownloadManager {
  private readonly tasks = new Map<string, DownloadTask>();
  private readonly tasksByConnection = new Map<string, Set<string>>();
  private readonly taskCountByUser = new Map<string, number>();
  private readonly reservedByConnection = new Map<string, number>();
  private lock: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: StorageService,
    private readonly options: DownloadManagerOptions,
  ) {}

  async initialize(
    connectionId: string,
    user: PublicUser,
    logicalPath: string,
    onTimeout: (failure: DownloadFailure) => void,
    startOffset = 0,
  ): Promise<DownloadReadyPayload> {
    await this.reserveSlot(connectionId, user.id);
    let fileHandle: FileHandle | undefined;
    try {
      const canonicalPath = await this.storage.resolveForRead(user.id, logicalPath);
      fileHandle = await open(canonicalPath, "r");
      const before = await fileHandle.stat({ bigint: true });
      if (!before.isFile() || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new DownloadFailure("IO_ERROR", "download source is not a supported regular file");
      }
      const fileSize = Number(before.size);
      if (fileSize > this.storage.limits.maxFileSizeBytes) {
        throw new DownloadFailure("FILE_TOO_LARGE", "file exceeds the configured download limit");
      }
      const fileSha256 = await hashFileHandle(fileHandle, fileSize);
      if (!Number.isSafeInteger(startOffset) || startOffset < 0 || startOffset > fileSize) {
        throw new DownloadFailure("INVALID_ACK", "resume offset is outside the file", undefined);
      }
      const after = await fileHandle.stat({ bigint: true });
      const pathStats = await stat(canonicalPath, { bigint: true });
      if (!sameIdentity(before, after) || !sameIdentity(after, pathStats)) {
        throw new DownloadFailure("SOURCE_CHANGED", "download source changed while metadata was prepared");
      }

      const transferId = randomUUID();
      const task: DownloadTask = {
        transferId,
        connectionId,
        userId: user.id,
        logicalPath,
        canonicalPath,
        fileSize,
        fileSha256,
        expectedOffset: startOffset,
        pendingNextOffset: startOffset,
        state: "sending",
        fileHandle,
        sentHasher: await hashPrefix(fileHandle, startOffset),
        identity: identityOf(after),
        onTimeout,
        userRole: user.role,
      };
      fileHandle = undefined;
      this.tasks.set(transferId, task);
      const connectionSet = this.tasksByConnection.get(connectionId) ?? new Set<string>();
      connectionSet.add(transferId);
      this.tasksByConnection.set(connectionId, connectionSet);
      this.decrementConnectionReservation(connectionId);
      return {
        transferId,
        path: logicalPath,
        fileName: basename(logicalPath),
        fileSize,
        fileSha256,
        chunkSize: this.options.chunkSize,
        nextOffset: startOffset,
      };
    } catch (error) {
      await fileHandle?.close().catch(() => undefined);
      this.releaseReservedSlot(connectionId, user.id);
      if (error instanceof DownloadFailure || error instanceof StorageFailure) throw error;
      throw new DownloadFailure("IO_ERROR", "could not prepare download source");
    }
  }

  async nextAction(connectionId: string, userId: string, transferId: string): Promise<DownloadAction> {
    const task = this.requireTask(transferId, connectionId, userId);
    try {
      if (task.state !== "sending") {
        throw new DownloadFailure("INVALID_ACK", "download is not ready to send a chunk", transferId);
      }
      if (task.expectedOffset === task.fileSize) return await this.finishSending(task);

      const length = Math.min(this.options.chunkSize, task.fileSize - task.expectedOffset);
      const payload = Buffer.allocUnsafe(length);
      await readExactly(task.fileHandle, payload, task.expectedOffset);
      await this.options.bandwidthLimiter?.throttle(task.userId, task.userRole, payload.byteLength);
      task.sentHasher.update(payload);
      task.pendingNextOffset = task.expectedOffset + payload.byteLength;
      task.state = "awaiting-ack";
      this.armTimeout(task, "timed out waiting for download ACK");
      const flags = BINARY_FLAGS.ackRequired
        | (task.pendingNextOffset === task.fileSize ? BINARY_FLAGS.final : 0);
      const frame = encodeBinaryFrame({
        messageType: BINARY_MESSAGE_TYPES.downloadChunk,
        flags,
        errorCode: 0,
        requestId: randomUUID(),
        transferId: task.transferId,
        fileSize: BigInt(task.fileSize),
        offset: BigInt(task.expectedOffset),
        payloadSha256: createHash("sha256").update(payload).digest(),
      }, payload);
      return { kind: "chunk", frame };
    } catch (error) {
      const failure = asDownloadFailure(error, transferId);
      await this.failTask(task);
      throw failure;
    }
  }

  async acknowledge(
    connectionId: string,
    userId: string,
    transferId: string,
    nextOffset: number,
  ): Promise<DownloadAction> {
    const task = this.requireTask(transferId, connectionId, userId);
    try {
      if (task.state !== "awaiting-ack" || nextOffset !== task.pendingNextOffset) {
        throw new DownloadFailure("INVALID_ACK", "download ACK offset is not the next expected offset", transferId);
      }
      this.clearTimer(task);
      task.expectedOffset = nextOffset;
      task.state = "sending";
      return await this.nextAction(connectionId, userId, transferId);
    } catch (error) {
      const failure = asDownloadFailure(error, transferId);
      if (this.tasks.has(transferId)) await this.failTask(task);
      throw failure;
    }
  }

  async complete(
    connectionId: string,
    userId: string,
    payload: DownloadCompletePayload,
  ): Promise<DownloadCompletePayload> {
    const task = this.requireTask(payload.transferId, connectionId, userId);
    try {
      if (task.state !== "awaiting-complete") {
        throw new DownloadFailure("INVALID_ACK", "download is not waiting for completion confirmation", task.transferId);
      }
      this.clearTimer(task);
      if (!payload.success
        || payload.receivedSize !== task.fileSize
        || !equalHexDigest(payload.fileSha256, task.fileSha256)) {
        throw new DownloadFailure("HASH_MISMATCH", "client download integrity verification failed", task.transferId);
      }
      task.state = "completed";
      await this.closeAndRelease(task);
      return { ...payload, accepted: true };
    } catch (error) {
      const failure = asDownloadFailure(error, task.transferId);
      if (this.tasks.has(task.transferId)) await this.failTask(task);
      throw failure;
    }
  }

  async abort(connectionId: string, userId: string, transferId: string): Promise<void> {
    const task = this.requireTask(transferId, connectionId, userId);
    task.state = "cancelled";
    await this.closeAndRelease(task);
  }

  async abortByConnection(connectionId: string): Promise<void> {
    const transferIds = [...(this.tasksByConnection.get(connectionId) ?? [])];
    await Promise.all(transferIds.map(async (transferId) => {
      const task = this.tasks.get(transferId);
      if (!task) return;
      task.state = "cancelled";
      await this.closeAndRelease(task);
    }));
  }

  getTransferIdForConnection(connectionId: string): string | undefined {
    return this.tasksByConnection.get(connectionId)?.values().next().value;
  }

  private async finishSending(task: DownloadTask): Promise<DownloadAction> {
    const sentSha256 = task.sentHasher.digest("hex");
    const handleStats = await task.fileHandle.stat({ bigint: true });
    let pathStats: BigIntStats;
    try {
      pathStats = await stat(task.canonicalPath, { bigint: true });
    } catch {
      throw new DownloadFailure("SOURCE_CHANGED", "download source was removed during transfer", task.transferId);
    }
    if (!sameIdentity(task.identity, handleStats)
      || !sameIdentity(task.identity, pathStats)
      || !equalHexDigest(sentSha256, task.fileSha256)) {
      throw new DownloadFailure("SOURCE_CHANGED", "download source changed during transfer", task.transferId);
    }
    task.state = "awaiting-complete";
    this.armTimeout(task, "timed out waiting for download completion confirmation");
    return {
      kind: "finish",
      payload: { transferId: task.transferId, fileSize: task.fileSize, fileSha256: task.fileSha256 },
    };
  }

  private requireTask(transferId: string, connectionId: string, userId: string): DownloadTask {
    const task = this.tasks.get(transferId);
    if (!task || task.connectionId !== connectionId || task.userId !== userId) {
      throw new DownloadFailure("DOWNLOAD_NOT_FOUND", "download task does not exist", transferId);
    }
    return task;
  }

  private armTimeout(task: DownloadTask, message: string): void {
    this.clearTimer(task);
    task.timer = setTimeout(() => {
      const failure = new DownloadFailure("ACK_TIMEOUT", message, task.transferId);
      void this.failTask(task).then(() => task.onTimeout(failure));
    }, this.options.ackTimeoutMs);
    task.timer.unref();
  }

  private clearTimer(task: DownloadTask): void {
    if (task.timer) clearTimeout(task.timer);
    delete task.timer;
  }

  private async failTask(task: DownloadTask): Promise<void> {
    task.state = "failed";
    await this.closeAndRelease(task);
  }

  private async closeAndRelease(task: DownloadTask): Promise<void> {
    this.clearTimer(task);
    await task.fileHandle.close().catch(() => undefined);
    if (!this.tasks.delete(task.transferId)) return;
    const connectionSet = this.tasksByConnection.get(task.connectionId);
    connectionSet?.delete(task.transferId);
    if (connectionSet?.size === 0) this.tasksByConnection.delete(task.connectionId);
    const count = Math.max(0, (this.taskCountByUser.get(task.userId) ?? 1) - 1);
    if (count === 0) this.taskCountByUser.delete(task.userId); else this.taskCountByUser.set(task.userId, count);
  }

  private async reserveSlot(connectionId: string, userId: string): Promise<void> {
    await this.withLock(async () => {
      const connectionCount = (this.tasksByConnection.get(connectionId)?.size ?? 0)
        + (this.reservedByConnection.get(connectionId) ?? 0);
      if (connectionCount >= this.options.maxActiveDownloadsPerUser) {
        throw new DownloadFailure("TOO_MANY_TASKS", "connection download task limit reached");
      }
      const reservedTotal = [...this.reservedByConnection.values()].reduce((sum, count) => sum + count, 0);
      if (this.tasks.size + reservedTotal >= this.options.maxActiveDownloadsGlobal) {
        throw new DownloadFailure("TOO_MANY_TASKS", "server download task limit reached");
      }
      const count = this.taskCountByUser.get(userId) ?? 0;
      if (count >= this.options.maxActiveDownloadsPerUser) {
        throw new DownloadFailure("TOO_MANY_TASKS", "user download task limit reached");
      }
      this.reservedByConnection.set(connectionId, (this.reservedByConnection.get(connectionId) ?? 0) + 1);
      this.taskCountByUser.set(userId, count + 1);
    });
  }

  private releaseReservedSlot(connectionId: string, userId: string): void {
    if ((this.reservedByConnection.get(connectionId) ?? 0) === 0) return;
    this.decrementConnectionReservation(connectionId);
    const count = Math.max(0, (this.taskCountByUser.get(userId) ?? 1) - 1);
    if (count === 0) this.taskCountByUser.delete(userId); else this.taskCountByUser.set(userId, count);
  }

  private decrementConnectionReservation(connectionId: string): void {
    const remaining = Math.max(0, (this.reservedByConnection.get(connectionId) ?? 1) - 1);
    if (remaining === 0) this.reservedByConnection.delete(connectionId);
    else this.reservedByConnection.set(connectionId, remaining);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
}

async function hashFileHandle(handle: FileHandle, fileSize: number): Promise<string> {
  const hasher = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(fileSize, 1)));
  let offset = 0;
  while (offset < fileSize) {
    const length = Math.min(buffer.byteLength, fileSize - offset);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    if (bytesRead <= 0) throw new DownloadFailure("SOURCE_CHANGED", "download source ended while hashing");
    hasher.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return hasher.digest("hex");
}

async function hashPrefix(handle: FileHandle, length: number): Promise<Hash> {
  const hasher = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(length, 1)));
  let offset = 0;
  while (offset < length) {
    const wanted = Math.min(buffer.byteLength, length - offset);
    const { bytesRead } = await handle.read(buffer, 0, wanted, offset);
    if (bytesRead <= 0) throw new DownloadFailure("SOURCE_CHANGED", "download source ended while restoring hash state");
    hasher.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return hasher;
}

async function readExactly(handle: FileHandle, target: Uint8Array, position: number): Promise<void> {
  let read = 0;
  while (read < target.byteLength) {
    const result = await handle.read(target, read, target.byteLength - read, position + read);
    if (result.bytesRead <= 0) throw new DownloadFailure("SOURCE_CHANGED", "download source ended before its declared size");
    read += result.bytesRead;
  }
}

function identityOf(stats: BigIntStats): FileIdentity {
  return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeNs: stats.mtimeNs, ctimeNs: stats.ctimeNs };
}

function sameIdentity(left: FileIdentity | BigIntStats, right: FileIdentity | BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function equalHexDigest(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(left) || !/^[0-9a-f]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function asDownloadFailure(error: unknown, transferId: string): DownloadFailure {
  if (error instanceof DownloadFailure) return error;
  return new DownloadFailure("IO_ERROR", "server download operation failed", transferId);
}
