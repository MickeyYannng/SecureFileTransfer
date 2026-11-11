import { randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  BINARY_HEADER_LENGTH,
  ERROR_CODES,
  MAX_CONTROL_MESSAGE_BYTES,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  createControlMessage,
  hasStringField,
  parseControlMessage,
  parseBinaryFrame,
  serializeControlMessage,
  type AuthMeResultPayload,
  type AuthSuccessPayload,
  type ControlMessage,
  type ErrorPayload,
  type HeartbeatPayload,
  type HelloAckPayload,
  type UploadErrorPayload,
} from "@sft/protocol";
import { AuthFailure, AuthService, type AuthenticatedSession } from "./auth.js";
import { AppDatabase } from "./database.js";
import { StorageFailure, StorageService } from "./storage.js";
import { UploadFailure, UploadManager } from "./upload.js";

export interface InitialUser {
  id?: string;
  username: string;
  password: string;
  displayName: string;
  quotaBytes?: number;
  maxFiles?: number;
}

export interface ServerOptions {
  host?: string;
  port?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  databasePath?: string;
  storageRoot?: string;
  sessionTtlMs?: number;
  maxFileSizeBytes?: number;
  defaultQuotaBytes?: number;
  defaultMaxFiles?: number;
  uploadChunkSize?: number;
  maxActiveUploadsGlobal?: number;
  maxActiveUploadsPerUser?: number;
  initialUsers?: InitialUser[];
  logger?: Pick<Console, "info" | "warn" | "error">;
}

interface ConnectionState {
  connectionId: string;
  helloComplete: boolean;
  sessionId?: string;
  lastPongAt: number;
  pendingHeartbeatNonce?: string;
  messagesInWindow: number;
  rateWindowStartedAt: number;
  messageChain: Promise<void>;
  pendingMessages: number;
}

export interface RunningServer {
  host: string;
  port: number;
  httpServer: HttpServer;
  close(): Promise<void>;
}

const CONTROL_RATE_WINDOW_MS = 10_000;
const CONTROL_RATE_LIMIT = 100;
const MAX_PENDING_MESSAGES = 8;
const defaultDatabasePath = fileURLToPath(new URL("../../../data/sft.sqlite", import.meta.url));
const defaultStorageRoot = fileURLToPath(new URL("../../../storage", import.meta.url));

export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 3000;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 45_000;
  const sessionTtlMs = options.sessionTtlMs ?? 30 * 60_000;
  const maxFileSizeBytes = options.maxFileSizeBytes ?? 512 * 1024 * 1024;
  const defaultQuotaBytes = options.defaultQuotaBytes ?? 1024 * 1024 * 1024;
  const defaultMaxFiles = options.defaultMaxFiles ?? 1_000;
  const uploadChunkSize = options.uploadChunkSize ?? 256 * 1024;
  const maxActiveUploadsGlobal = options.maxActiveUploadsGlobal ?? 32;
  const maxActiveUploadsPerUser = options.maxActiveUploadsPerUser ?? 1;
  const logger = options.logger ?? console;

  if (heartbeatIntervalMs <= 0 || heartbeatTimeoutMs <= heartbeatIntervalMs) {
    throw new Error("heartbeat timeout must be greater than the positive interval");
  }
  if (sessionTtlMs <= 0) throw new Error("session TTL must be positive");
  if (uploadChunkSize < 16 * 1024 || uploadChunkSize > 1024 * 1024) {
    throw new Error("upload chunk size must be between 16 KiB and 1 MiB");
  }

  const database = new AppDatabase(options.databasePath ?? defaultDatabasePath);
  const auth = await AuthService.create(database, { sessionTtlMs, defaultQuotaBytes, defaultMaxFiles });
  const storage = new StorageService(options.storageRoot ?? defaultStorageRoot, {
    maxFileSizeBytes,
    defaultQuotaBytes,
    defaultMaxFiles,
  });
  await storage.initialize();
  const upload = new UploadManager(storage, {
    chunkSize: uploadChunkSize,
    maxActiveUploadsGlobal,
    maxActiveUploadsPerUser,
  });
  for (const initialUser of options.initialUsers ?? []) {
    const result = await auth.createUser(initialUser);
    await storage.ensureUserRoot(result.user.id);
  }

  const app = express();
  app.disable("x-powered-by");
  app.get("/health", (_request, response) => {
    response.json({ status: "ok", protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION, phase: "2.2" });
  });

  const httpServer = createServer(app);
  const webSocketServer = new WebSocketServer({
    server: httpServer,
    path: "/ws",
    maxPayload: Math.max(MAX_CONTROL_MESSAGE_BYTES, BINARY_HEADER_LENGTH + uploadChunkSize),
    perMessageDeflate: false,
  });
  webSocketServer.on("error", () => logger.error("WebSocket server transport error"));
  const states = new WeakMap<WebSocket, ConnectionState>();

  webSocketServer.on("connection", (socket) => {
    const now = Date.now();
    const state: ConnectionState = {
      connectionId: randomUUID(),
      helloComplete: false,
      lastPongAt: now,
      messagesInWindow: 0,
      rateWindowStartedAt: now,
      messageChain: Promise.resolve(),
      pendingMessages: 0,
    };
    states.set(socket, state);

    socket.on("message", (data, isBinary) => {
      state.pendingMessages += 1;
      if (state.pendingMessages > MAX_PENDING_MESSAGES) {
        sendError(socket, randomUUID(), ERROR_CODES.rateLimited, "too many queued messages", true);
        socket.close(1008, "message queue limit exceeded");
        state.pendingMessages -= 1;
        return;
      }
      state.messageChain = state.messageChain
        .then(() => handleIncomingMessage(
          socket,
          state,
          data,
          isBinary,
          auth,
          storage,
          upload,
          logger,
          heartbeatIntervalMs,
          heartbeatTimeoutMs,
          uploadChunkSize,
        ))
        .catch(() => {
          logger.error(`Unhandled request failure on connection ${state.connectionId}`);
          sendError(socket, randomUUID(), ERROR_CODES.internalError, "internal server error", false);
        })
        .finally(() => { state.pendingMessages -= 1; });
    });
    socket.on("error", (error) => logger.warn(`WebSocket ${state.connectionId}: ${error.message}`));
    socket.on("close", () => { void upload.abortByConnection(state.connectionId); });
  });

  const heartbeatTimer = setInterval(() => {
    const now = Date.now();
    for (const socket of webSocketServer.clients) {
      const state = states.get(socket);
      if (!state || socket.readyState !== WebSocket.OPEN) continue;
      if (now - state.lastPongAt > heartbeatTimeoutMs) {
        logger.warn(`Terminating idle WebSocket ${state.connectionId}`);
        socket.terminate();
        continue;
      }
      if (!state.helloComplete) continue;
      if (state.pendingHeartbeatNonce) continue;
      const nonce = randomUUID();
      state.pendingHeartbeatNonce = nonce;
      const payload: HeartbeatPayload = { nonce };
      send(socket, createControlMessage("HEARTBEAT_PING", randomUUID(), payload));
    }
  }, heartbeatIntervalMs);
  heartbeatTimer.unref();

  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(port, host, () => {
        httpServer.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    clearInterval(heartbeatTimer);
    database.close();
    throw error;
  }

  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");
  logger.info(`SFT Phase 2.2 server listening on http://${host}:${address.port}`);

  return {
    host,
    port: address.port,
    httpServer,
    async close() {
      clearInterval(heartbeatTimer);
      for (const socket of webSocketServer.clients) {
        const state = states.get(socket);
        if (state) await upload.abortByConnection(state.connectionId);
        socket.terminate();
      }
      await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
      database.close();
    },
  };
}

async function handleIncomingMessage(
  socket: WebSocket,
  state: ConnectionState,
  data: RawData,
  isBinary: boolean,
  auth: AuthService,
  storage: StorageService,
  upload: UploadManager,
  logger: Pick<Console, "info" | "warn" | "error">,
  heartbeatIntervalMs: number,
  heartbeatTimeoutMs: number,
  uploadChunkSize: number,
): Promise<void> {
  if (isBinary) {
    await handleUploadChunk(socket, state, data, auth, upload, uploadChunkSize);
    return;
  }
  if (!allowControlMessage(state)) {
    sendError(socket, randomUUID(), ERROR_CODES.rateLimited, "too many control messages", true);
    socket.close(1008, "rate limit exceeded");
    return;
  }
  let message: ControlMessage<unknown>;
  try {
    message = parseControlMessage(rawDataToUtf8(data));
  } catch {
    sendError(socket, randomUUID(), ERROR_CODES.invalidMessage, "invalid control message", false);
    return;
  }

  if (!state.helloComplete && message.type !== "HELLO") {
    sendError(socket, message.requestId, ERROR_CODES.helloRequired, "HELLO must be the first message", false);
    return;
  }

  try {
    switch (message.type) {
      case "HELLO": {
        if (state.helloComplete) throw new ProtocolFailure("HELLO has already completed");
        if (!hasStringField(message.payload, "protocol") || message.payload.protocol !== PROTOCOL_NAME) {
          sendError(socket, message.requestId, ERROR_CODES.protocolMismatch, "unsupported protocol name", false);
          socket.close(1002, "protocol mismatch");
          return;
        }
        state.helloComplete = true;
        const payload: HelloAckPayload = {
          protocol: PROTOCOL_NAME,
          connectionId: state.connectionId,
          heartbeatIntervalMs,
          heartbeatTimeoutMs,
        };
        send(socket, createControlMessage("HELLO_ACK", message.requestId, payload));
        return;
      }
      case "HEARTBEAT_PING": {
        const nonce = requiredString(message.payload, "nonce", 128);
        send(socket, createControlMessage("HEARTBEAT_PONG", message.requestId, { nonce }));
        return;
      }
      case "HEARTBEAT_PONG": {
        const nonce = requiredString(message.payload, "nonce", 128);
        if (state.pendingHeartbeatNonce === nonce) {
          state.lastPongAt = Date.now();
          delete state.pendingHeartbeatNonce;
        }
        return;
      }
      case "AUTH_LOGIN": {
        if (state.sessionId) throw new ProtocolFailure("connection is already authenticated");
        const username = requiredString(message.payload, "username", 128);
        const password = requiredString(message.payload, "password", 512);
        const login = await auth.login(username, password);
        state.sessionId = login.sessionId;
        await storage.ensureUserRoot(login.user.id);
        const payload: AuthSuccessPayload = {
          token: login.token,
          user: login.user,
          expiresAt: login.expiresAt,
        };
        send(socket, createControlMessage("AUTH_SUCCESS", message.requestId, payload));
        return;
      }
      case "AUTH_TOKEN": {
        if (state.sessionId) throw new ProtocolFailure("connection is already authenticated");
        const token = requiredString(message.payload, "token", 256);
        const session = auth.authenticateToken(token);
        state.sessionId = session.sessionId;
        await storage.ensureUserRoot(session.user.id);
        const payload: AuthSuccessPayload = { user: session.user, expiresAt: session.expiresAt };
        send(socket, createControlMessage("AUTH_SUCCESS", message.requestId, payload));
        return;
      }
      case "AUTH_ME": {
        const session = requireCurrentSession(state, auth);
        const payload: AuthMeResultPayload = { user: session.user, expiresAt: session.expiresAt };
        send(socket, createControlMessage("AUTH_ME_RESULT", message.requestId, payload));
        return;
      }
      case "AUTH_LOGOUT": {
        const session = requireCurrentSession(state, auth);
        await upload.abortByConnection(state.connectionId);
        auth.logout(session.sessionId);
        delete state.sessionId;
        send(socket, createControlMessage("AUTH_LOGOUT_ACK", message.requestId, {}));
        return;
      }
      case "FILE_LIST_REQUEST": {
        const session = requireCurrentSession(state, auth);
        const logicalPath = requiredStringAllowEmpty(message.payload, "path", 1024);
        const result = await storage.list(session.user, logicalPath);
        send(socket, createControlMessage("FILE_LIST_RESULT", message.requestId, result));
        return;
      }
      case "UPLOAD_INIT": {
        const session = requireCurrentSession(state, auth);
        const logicalPath = requiredString(message.payload, "path", 1024);
        const fileSize = requiredNonNegativeInteger(message.payload, "fileSize");
        const fileSha256 = requiredString(message.payload, "fileSha256", 64);
        const ready = await upload.initialize(state.connectionId, session.user, logicalPath, fileSize, fileSha256);
        send(socket, createControlMessage("UPLOAD_READY", message.requestId, ready));
        return;
      }
      case "UPLOAD_FINISH": {
        const session = requireCurrentSession(state, auth);
        const transferId = requiredString(message.payload, "transferId", 36);
        const complete = await upload.finish(state.connectionId, session.user, transferId);
        send(socket, createControlMessage("UPLOAD_COMPLETE", message.requestId, complete));
        return;
      }
      case "UPLOAD_ABORT": {
        const session = requireCurrentSession(state, auth);
        const transferId = requiredString(message.payload, "transferId", 36);
        await upload.abort(state.connectionId, session.user.id, transferId);
        send(socket, createControlMessage("UPLOAD_ABORTED", message.requestId, { transferId }));
        return;
      }
      case "HELLO_ACK":
      case "AUTH_SUCCESS":
      case "AUTH_LOGOUT_ACK":
      case "AUTH_ME_RESULT":
      case "FILE_LIST_RESULT":
      case "UPLOAD_READY":
      case "UPLOAD_ACK":
      case "UPLOAD_COMPLETE":
      case "UPLOAD_ABORTED":
      case "UPLOAD_ERROR":
      case "ERROR":
        throw new ProtocolFailure(`${message.type} is server-originated`);
    }
  } catch (error) {
    if (error instanceof AuthFailure) {
      if (error.code === "SESSION_EXPIRED" || error.code === "SESSION_REVOKED") {
        delete state.sessionId;
        await upload.abortByConnection(state.connectionId);
      }
      if (isUploadControlType(message.type)) {
        sendUploadError(socket, message.requestId, authErrorCode(error.code), error.message, false, upload.getTransferIdForConnection(state.connectionId));
      } else {
        sendError(socket, message.requestId, authErrorCode(error.code), error.message, false);
      }
      return;
    }
    if (error instanceof UploadFailure) {
      sendUploadError(socket, message.requestId, uploadErrorCode(error.code), error.message, false, error.transferId);
      return;
    }
    if (error instanceof StorageFailure) {
      if (isUploadControlType(message.type)) {
        sendUploadError(socket, message.requestId, storageErrorCode(error.code), error.message, false, upload.getTransferIdForConnection(state.connectionId));
      } else {
        sendError(socket, message.requestId, storageErrorCode(error.code), error.message, false);
      }
      return;
    }
    if (error instanceof ProtocolFailure) {
      sendError(socket, message.requestId, ERROR_CODES.invalidPayload, error.message, false);
      return;
    }
    logger.error(`Request ${message.type} failed on connection ${state.connectionId}`);
    sendError(socket, message.requestId, ERROR_CODES.internalError, "internal server error", false);
  }
}

async function handleUploadChunk(
  socket: WebSocket,
  state: ConnectionState,
  data: RawData,
  auth: AuthService,
  upload: UploadManager,
  uploadChunkSize: number,
): Promise<void> {
  let requestId: string = randomUUID();
  let transferId: string | undefined;
  try {
    const session = requireCurrentSession(state, auth);
    const frame = parseBinaryFrame(rawDataToBytes(data), uploadChunkSize);
    requestId = frame.header.requestId;
    transferId = frame.header.transferId;
    const ack = await upload.acceptChunk(state.connectionId, session.user, frame);
    send(socket, createControlMessage("UPLOAD_ACK", requestId, ack));
  } catch (error) {
    if (error instanceof AuthFailure) {
      if (error.code === "SESSION_EXPIRED" || error.code === "SESSION_REVOKED") delete state.sessionId;
      await upload.abortByConnection(state.connectionId);
      sendUploadError(socket, requestId, authErrorCode(error.code), error.message, false, transferId);
      return;
    }
    if (error instanceof UploadFailure) {
      sendUploadError(socket, requestId, uploadErrorCode(error.code), error.message, false, error.transferId ?? transferId);
      return;
    }
    await upload.abortByConnection(state.connectionId);
    sendUploadError(socket, requestId, ERROR_CODES.invalidChunk, "invalid binary upload frame", false, transferId);
  }
}

class ProtocolFailure extends Error {}

function requireCurrentSession(state: ConnectionState, auth: AuthService): AuthenticatedSession {
  return auth.validateSession(state.sessionId);
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  const candidate = readStringField(value, field);
  if (candidate.length < 1 || candidate.length > maxLength) {
    throw new ProtocolFailure(`${field} is required`);
  }
  return candidate;
}

function requiredStringAllowEmpty(value: unknown, field: string, maxLength: number): string {
  const candidate = readStringField(value, field);
  if (candidate.length > maxLength) {
    throw new ProtocolFailure(`${field} must be a string`);
  }
  return candidate;
}

function requiredNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolFailure(`${field} must be a non-negative integer`);
  }
  const candidate = (value as Record<string, unknown>)[field];
  if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0) {
    throw new ProtocolFailure(`${field} must be a non-negative integer`);
  }
  return candidate;
}

function readStringField(value: unknown, field: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolFailure(`${field} must be a string`);
  }
  const candidate = (value as Record<string, unknown>)[field];
  if (typeof candidate !== "string") throw new ProtocolFailure(`${field} must be a string`);
  return candidate;
}

function authErrorCode(code: AuthFailure["code"]): string {
  switch (code) {
    case "AUTH_REQUIRED": return ERROR_CODES.authRequired;
    case "INVALID_CREDENTIALS": return ERROR_CODES.invalidCredentials;
    case "SESSION_EXPIRED": return ERROR_CODES.sessionExpired;
    case "SESSION_REVOKED": return ERROR_CODES.sessionRevoked;
  }
}

function storageErrorCode(code: StorageFailure["code"]): string {
  switch (code) {
    case "INVALID_PATH": return ERROR_CODES.invalidPath;
    case "NOT_FOUND": return ERROR_CODES.notFound;
    case "FORBIDDEN": return ERROR_CODES.forbidden;
    case "FILE_EXISTS": return ERROR_CODES.fileExists;
  }
}

function uploadErrorCode(code: UploadFailure["code"]): string {
  switch (code) {
    case "INVALID_INIT": return ERROR_CODES.invalidPayload;
    case "INVALID_CHUNK": return ERROR_CODES.invalidChunk;
    case "INVALID_OFFSET": return ERROR_CODES.invalidOffset;
    case "SIZE_MISMATCH": return ERROR_CODES.sizeMismatch;
    case "HASH_MISMATCH": return ERROR_CODES.hashMismatch;
    case "FILE_EXISTS": return ERROR_CODES.fileExists;
    case "QUOTA_EXCEEDED": return ERROR_CODES.quotaExceeded;
    case "TOO_MANY_TASKS": return ERROR_CODES.tooManyTasks;
    case "INSUFFICIENT_STORAGE": return ERROR_CODES.insufficientStorage;
    case "UPLOAD_NOT_FOUND": return ERROR_CODES.notFound;
    case "UPLOAD_CANCELLED": return ERROR_CODES.uploadCancelled;
    case "IO_ERROR": return ERROR_CODES.internalError;
  }
}

function isUploadControlType(type: ControlMessage<unknown>["type"]): boolean {
  return type === "UPLOAD_INIT" || type === "UPLOAD_FINISH" || type === "UPLOAD_ABORT";
}

function send(socket: WebSocket, message: ControlMessage<unknown>): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(serializeControlMessage(message));
}

function sendError(
  socket: WebSocket,
  requestId: string,
  code: string,
  message: string,
  retryable: boolean,
): void {
  const payload: ErrorPayload = { code, message, retryable };
  send(socket, createControlMessage("ERROR", requestId, payload));
}

function sendUploadError(
  socket: WebSocket,
  requestId: string,
  code: string,
  message: string,
  retryable: boolean,
  transferId?: string,
): void {
  const payload: UploadErrorPayload = transferId
    ? { code, message, retryable, transferId }
    : { code, message, retryable };
  send(socket, createControlMessage("UPLOAD_ERROR", requestId, payload));
}

function allowControlMessage(state: ConnectionState): boolean {
  const now = Date.now();
  if (now - state.rateWindowStartedAt >= CONTROL_RATE_WINDOW_MS) {
    state.rateWindowStartedAt = now;
    state.messagesInWindow = 0;
  }
  state.messagesInWindow += 1;
  return state.messagesInWindow <= CONTROL_RATE_LIMIT;
}

function rawDataToUtf8(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

function rawDataToBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
