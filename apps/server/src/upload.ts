import { createHash, randomUUID, timingSafeEqual, type Hash } from "node:crypto";
import { open, stat, type FileHandle } from "node:fs/promises";
import {
  BINARY_FLAGS,
  BINARY_MESSAGE_TYPES,
  bytesToHex,
  type ParsedBinaryFrame,
  type PublicUser,
  type UploadAckPayload,
  type UploadCompletePayload,
  type UploadReadyPayload,
} from "@sft/protocol";
import { StorageFailure, StorageService } from "./storage.js";
import type { BandwidthLimiter } from "./bandwidth.js";

export type UploadState = "initialized" | "receiving" | "paused" | "verifying" | "completed" | "cancelled" | "failed";

export class UploadFailure extends Error {
  constructor(
    readonly code:
      | "INVALID_INIT"
      | "INVALID_CHUNK"
      | "INVALID_OFFSET"
      | "SIZE_MISMATCH"
      | "HASH_MISMATCH"
      | "FILE_EXISTS"
      | "QUOTA_EXCEEDED"
      | "TOO_MANY_TASKS"
      | "INSUFFICIENT_STORAGE"
      | "UPLOAD_NOT_FOUND"
      | "UPLOAD_CANCELLED"
      | "IO_ERROR",
    message: string,
    readonly transferId?: string,
  ) {
    super(message);
    this.name = "UploadFailure";
  }
}

export interface UploadManagerOptions {
  chunkSize: number;
  maxActiveUploadsGlobal: number;
  maxActiveUploadsPerUser: number;
  resumeTtlMs?: number;
  bandwidthLimiter?: BandwidthLimiter;
}

interface UploadTask {
  transferId: string;
  connectionId: string;
  userId: string;
  logicalPath: string;
  finalPath: string;
  temporaryPath: string;
  fileSize: number;
  declaredSha256: string;
  expectedOffset: number;
  state: UploadState;
  fileHandle: FileHandle;
  hasher: Hash;
  handleClosed: boolean;
  resumeTimer?: NodeJS.Timeout;
}

export class UploadManager {
  private readonly tasks = new Map<string, UploadTask>();
  private readonly tasksByConnection = new Map<string, Set<string>>();
  private readonly taskCountByUser = new Map<string, number>();
  private readonly reservedBytesByUser = new Map<string, number>();
  private readonly reservedFilesByUser = new Map<string, number>();
  private readonly reservedPaths = new Set<string>();
  private lock: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: StorageService,
    private readonly options: UploadManagerOptions,
  ) {}

  async initialize(
    connectionId: string,
    user: PublicUser,
    logicalPath: string,
    fileSize: number,
    fileSha256: string,
    resumeTransferId?: string,
  ): Promise<UploadReadyPayload> {
    return this.withLock(async () => {
      validateUploadDeclaration(fileSize, fileSha256);
      if (resumeTransferId) {
        const task = this.tasks.get(resumeTransferId);
        if (!task || task.userId !== user.id || task.state !== "paused") {
          throw new UploadFailure("UPLOAD_NOT_FOUND", "resumable upload task does not exist", resumeTransferId);
        }
        if (task.logicalPath !== logicalPath || task.fileSize !== fileSize || task.declaredSha256 !== fileSha256.toLowerCase()) {
          throw new UploadFailure("INVALID_INIT", "resume metadata does not match the original upload", resumeTransferId);
        }
        if ((this.tasksByConnection.get(connectionId)?.size ?? 0) >= this.options.maxActiveUploadsPerUser) {
          throw new UploadFailure("TOO_MANY_TASKS", "connection upload task limit reached");
        }
        if (task.resumeTimer) clearTimeout(task.resumeTimer);
        delete task.resumeTimer;
        task.connectionId = connectionId;
        task.state = "receiving";
        const connectionSet = this.tasksByConnection.get(connectionId) ?? new Set<string>();
        connectionSet.add(task.transferId);
        this.tasksByConnection.set(connectionId, connectionSet);
        return { transferId: task.transferId, chunkSize: this.options.chunkSize, nextOffset: task.expectedOffset };
      }
      const connectionTasks = this.tasksByConnection.get(connectionId)?.size ?? 0;
      if (connectionTasks >= this.options.maxActiveUploadsPerUser) {
        throw new UploadFailure("TOO_MANY_TASKS", "connection upload task limit reached");
      }
      if (this.tasks.size >= this.options.maxActiveUploadsGlobal) {
        throw new UploadFailure("TOO_MANY_TASKS", "server upload task limit reached");
      }
      const userTaskCount = this.taskCountByUser.get(user.id) ?? 0;
      if (userTaskCount >= this.options.maxActiveUploadsPerUser) {
        throw new UploadFailure("TOO_MANY_TASKS", "user upload task limit reached");
      }
      if (fileSize > this.storage.limits.maxFileSizeBytes) {
        throw new UploadFailure("QUOTA_EXCEEDED", "file exceeds the configured single-file limit");
      }

      const usage = await this.storage.getUsage(user);
      const reservedBytes = this.reservedBytesByUser.get(user.id) ?? 0;
      const reservedFiles = this.reservedFilesByUser.get(user.id) ?? 0;
      if (usage.usedBytes + reservedBytes + fileSize > user.quotaBytes) {
        throw new UploadFailure("QUOTA_EXCEEDED", "user storage quota would be exceeded");
      }
      if (usage.fileCount + reservedFiles + 1 > user.maxFiles) {
        throw new UploadFailure("QUOTA_EXCEEDED", "user file count limit would be exceeded");
      }
      const globallyReservedBytes = Array.from(this.reservedBytesByUser.values()).reduce((sum, value) => sum + value, 0);
      if (!await this.storage.hasAvailableDiskSpace(fileSize + globallyReservedBytes + 1024 * 1024)) {
        throw new UploadFailure("INSUFFICIENT_STORAGE", "server does not have enough available disk space");
      }

      const transferId = randomUUID();
      let paths;
      try {
        paths = await this.storage.prepareUploadPaths(user.id, logicalPath, transferId);
      } catch (error) {
        if (error instanceof StorageFailure && error.code === "FILE_EXISTS") {
          throw new UploadFailure("FILE_EXISTS", error.message);
        }
        throw error;
      }
      const pathKey = canonicalReservationKey(paths.finalPath);
      if (this.reservedPaths.has(pathKey)) throw new UploadFailure("FILE_EXISTS", "destination is already reserved");

      let fileHandle: FileHandle;
      try {
        fileHandle = await open(paths.temporaryPath, "wx");
      } catch {
        throw new UploadFailure("IO_ERROR", "could not create upload temporary file");
      }
      const task: UploadTask = {
        transferId,
        connectionId,
        userId: user.id,
        logicalPath,
        finalPath: paths.finalPath,
        temporaryPath: paths.temporaryPath,
        fileSize,
        declaredSha256: fileSha256.toLowerCase(),
        expectedOffset: 0,
        state: "receiving",
        fileHandle,
        hasher: createHash("sha256"),
        handleClosed: false,
      };
      this.tasks.set(transferId, task);
      const connectionSet = this.tasksByConnection.get(connectionId) ?? new Set<string>();
      connectionSet.add(transferId);
      this.tasksByConnection.set(connectionId, connectionSet);
      this.taskCountByUser.set(user.id, userTaskCount + 1);
      this.reservedBytesByUser.set(user.id, reservedBytes + fileSize);
      this.reservedFilesByUser.set(user.id, reservedFiles + 1);
      this.reservedPaths.add(pathKey);
      return { transferId, chunkSize: this.options.chunkSize, nextOffset: 0 };
    });
  }

  async acceptChunk(
    connectionId: string,
    user: PublicUser,
    frame: ParsedBinaryFrame,
  ): Promise<UploadAckPayload> {
    const task = this.requireTask(frame.header.transferId, connectionId, user.id);
    try {
      if (task.state !== "receiving") throw new UploadFailure("INVALID_CHUNK", "upload is not receiving chunks", task.transferId);
      if (frame.header.messageType !== BINARY_MESSAGE_TYPES.uploadChunk || frame.header.errorCode !== 0) {
        throw new UploadFailure("INVALID_CHUNK", "binary message is not an upload chunk", task.transferId);
      }
      if ((frame.header.flags & BINARY_FLAGS.ackRequired) === 0 || frame.header.metadataLength !== 0) {
        throw new UploadFailure("INVALID_CHUNK", "upload chunk flags or metadata are invalid", task.transferId);
      }
      if (frame.header.fileSize !== BigInt(task.fileSize)) {
        throw new UploadFailure("SIZE_MISMATCH", "binary header file size does not match upload", task.transferId);
      }
      if (frame.header.offset !== BigInt(task.expectedOffset)) {
        throw new UploadFailure("INVALID_OFFSET", "chunk offset is not the next expected offset", task.transferId);
      }
      if (frame.payload.byteLength === 0 || frame.payload.byteLength > this.options.chunkSize) {
        throw new UploadFailure("INVALID_CHUNK", "chunk length is outside the negotiated bounds", task.transferId);
      }
      if (task.expectedOffset + frame.payload.byteLength > task.fileSize) {
        throw new UploadFailure("SIZE_MISMATCH", "chunk exceeds the declared file size", task.transferId);
      }
      const actualChunkHash = createHash("sha256").update(frame.payload).digest();
      const declaredChunkHash = Buffer.from(frame.header.payloadSha256);
      if (!timingSafeEqual(actualChunkHash, declaredChunkHash)) {
        throw new UploadFailure("HASH_MISMATCH", "chunk SHA-256 does not match", task.transferId);
      }

      await this.options.bandwidthLimiter?.throttle(user.id, user.role, frame.payload.byteLength);

      await writeAll(task.fileHandle, frame.payload, task.expectedOffset);
      await task.fileHandle.sync();
      task.hasher.update(frame.payload);
      task.expectedOffset += frame.payload.byteLength;
      return {
        transferId: task.transferId,
        persistedOffset: task.expectedOffset,
        chunkLength: frame.payload.byteLength,
      };
    } catch (error) {
      const failure = asUploadFailure(error, task.transferId);
      await this.failTask(task);
      throw failure;
    }
  }

  async finish(connectionId: string, user: PublicUser, transferId: string): Promise<UploadCompletePayload> {
    const task = this.requireTask(transferId, connectionId, user.id);
    try {
      if (task.state !== "receiving") throw new UploadFailure("INVALID_INIT", "upload cannot be finished in its current state", transferId);
      task.state = "verifying";
      if (task.expectedOffset !== task.fileSize) {
        throw new UploadFailure("SIZE_MISMATCH", "received byte count does not match declared size", transferId);
      }
      await task.fileHandle.sync();
      await this.closeHandle(task);
      const temporaryStat = await stat(task.temporaryPath);
      if (temporaryStat.size !== task.fileSize) {
        throw new UploadFailure("SIZE_MISMATCH", "temporary file size does not match declared size", transferId);
      }
      const actualSha256 = task.hasher.digest("hex");
      if (!equalHexDigest(actualSha256, task.declaredSha256)) {
        throw new UploadFailure("HASH_MISMATCH", "whole-file SHA-256 does not match", transferId);
      }
      try {
        await this.storage.commitTemporaryFile(task.temporaryPath, task.finalPath);
      } catch (error) {
        if (isFileExists(error)) throw new UploadFailure("FILE_EXISTS", "destination was created concurrently", transferId);
        throw error;
      }
      task.state = "completed";
      this.releaseTask(task);
      return {
        transferId,
        path: task.logicalPath,
        fileSize: task.fileSize,
        fileSha256: actualSha256,
      };
    } catch (error) {
      const failure = asUploadFailure(error, transferId);
      await this.failTask(task);
      throw failure;
    }
  }

  async abort(connectionId: string, userId: string, transferId: string): Promise<void> {
    const task = this.requireTask(transferId, connectionId, userId);
    task.state = "cancelled";
    await this.closeHandle(task);
    await this.storage.removeTemporaryFile(task.temporaryPath);
    this.releaseTask(task);
  }

  async pause(connectionId: string, userId: string, transferId: string): Promise<number> {
    const task = this.requireTask(transferId, connectionId, userId);
    if (task.state !== "receiving") throw new UploadFailure("INVALID_INIT", "upload cannot be paused", transferId);
    task.state = "paused";
    const connectionSet = this.tasksByConnection.get(connectionId);
    connectionSet?.delete(transferId);
    if (connectionSet?.size === 0) this.tasksByConnection.delete(connectionId);
    task.connectionId = "";
    const ttl = this.options.resumeTtlMs ?? 10 * 60_000;
    task.resumeTimer = setTimeout(() => { void this.failTask(task); }, ttl);
    task.resumeTimer.unref();
    return task.expectedOffset;
  }

  async abortByConnection(connectionId: string): Promise<void> {
    const transferIds = [...(this.tasksByConnection.get(connectionId) ?? [])];
    await Promise.all(transferIds.map(async (transferId) => {
      const task = this.tasks.get(transferId);
      if (!task) return;
      task.state = "cancelled";
      await this.closeHandle(task);
      await this.storage.removeTemporaryFile(task.temporaryPath);
      this.releaseTask(task);
    }));
  }

  getTransferIdForConnection(connectionId: string): string | undefined {
    return this.tasksByConnection.get(connectionId)?.values().next().value;
  }

  private requireTask(transferId: string, connectionId: string, userId: string): UploadTask {
    const task = this.tasks.get(transferId);
    if (!task || task.connectionId !== connectionId || task.userId !== userId) {
      throw new UploadFailure("UPLOAD_NOT_FOUND", "upload task does not exist", transferId);
    }
    return task;
  }

  private async failTask(task: UploadTask): Promise<void> {
    task.state = "failed";
    await this.closeHandle(task);
    await this.storage.removeTemporaryFile(task.temporaryPath);
    this.releaseTask(task);
  }

  private async closeHandle(task: UploadTask): Promise<void> {
    if (task.handleClosed) return;
    task.handleClosed = true;
    try {
      await task.fileHandle.close();
    } catch {
      // Cleanup remains best-effort after a prior I/O failure.
    }
  }

  private releaseTask(task: UploadTask): void {
    if (task.resumeTimer) clearTimeout(task.resumeTimer);
    if (!this.tasks.delete(task.transferId)) return;
    const connectionSet = this.tasksByConnection.get(task.connectionId);
    connectionSet?.delete(task.transferId);
    if (connectionSet?.size === 0) this.tasksByConnection.delete(task.connectionId);
    const taskCount = Math.max(0, (this.taskCountByUser.get(task.userId) ?? 1) - 1);
    const reservedBytes = Math.max(0, (this.reservedBytesByUser.get(task.userId) ?? task.fileSize) - task.fileSize);
    const reservedFiles = Math.max(0, (this.reservedFilesByUser.get(task.userId) ?? 1) - 1);
    if (taskCount === 0) this.taskCountByUser.delete(task.userId); else this.taskCountByUser.set(task.userId, taskCount);
    if (reservedBytes === 0) this.reservedBytesByUser.delete(task.userId); else this.reservedBytesByUser.set(task.userId, reservedBytes);
    if (reservedFiles === 0) this.reservedFilesByUser.delete(task.userId); else this.reservedFilesByUser.set(task.userId, reservedFiles);
    this.reservedPaths.delete(canonicalReservationKey(task.finalPath));
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function validateUploadDeclaration(fileSize: number, fileSha256: string): void {
  if (!Number.isSafeInteger(fileSize) || fileSize < 0) throw new UploadFailure("INVALID_INIT", "file size is invalid");
  if (!/^[0-9a-f]{64}$/i.test(fileSha256)) throw new UploadFailure("INVALID_INIT", "file SHA-256 is invalid");
}

async function writeAll(handle: FileHandle, payload: Uint8Array, position: number): Promise<void> {
  let written = 0;
  while (written < payload.byteLength) {
    const result = await handle.write(payload, written, payload.byteLength - written, position + written);
    if (result.bytesWritten <= 0) throw new UploadFailure("IO_ERROR", "file write made no progress");
    written += result.bytesWritten;
  }
}

function equalHexDigest(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function canonicalReservationKey(path: string): string {
  return process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path;
}

function asUploadFailure(error: unknown, transferId: string): UploadFailure {
  if (error instanceof UploadFailure) return error;
  return new UploadFailure("IO_ERROR", "server file operation failed", transferId);
}

function isFileExists(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

export function describeChunkHash(frame: ParsedBinaryFrame): string {
  return bytesToHex(frame.header.payloadSha256);
}
