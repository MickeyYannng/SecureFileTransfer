export const PROTOCOL_NAME = "SFTP-WS";
export const PROTOCOL_VERSION = 1;
export const MAX_CONTROL_MESSAGE_BYTES = 64 * 1024;

export const CONTROL_MESSAGE_TYPES = [
  "HELLO",
  "HELLO_ACK",
  "HEARTBEAT_PING",
  "HEARTBEAT_PONG",
  "AUTH_LOGIN",
  "AUTH_TOKEN",
  "AUTH_SUCCESS",
  "AUTH_LOGOUT",
  "AUTH_LOGOUT_ACK",
  "AUTH_ME",
  "AUTH_ME_RESULT",
  "FILE_LIST_REQUEST",
  "FILE_LIST_RESULT",
  "ERROR",
] as const;

export type ControlMessageType = (typeof CONTROL_MESSAGE_TYPES)[number];

export interface ControlMessage<TPayload = Record<string, unknown>> {
  version: number;
  type: ControlMessageType;
  requestId: string;
  timestamp: number;
  payload: TPayload;
}

export interface HelloPayload {
  protocol: typeof PROTOCOL_NAME;
  clientName: string;
}

export interface HelloAckPayload {
  protocol: typeof PROTOCOL_NAME;
  connectionId: string;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
}

export interface HeartbeatPayload {
  nonce: string;
}

export interface ErrorPayload {
  code: string;
  message: string;
  retryable: boolean;
}

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  role: string;
  quotaBytes: number;
  maxFiles: number;
}

export interface AuthLoginPayload {
  username: string;
  password: string;
}

export interface AuthTokenPayload {
  token: string;
}

export interface AuthSuccessPayload {
  user: PublicUser;
  expiresAt: number;
  token?: string;
}

export interface AuthMeResultPayload {
  user: PublicUser;
  expiresAt: number;
}

export interface FileListRequestPayload {
  path: string;
}

export interface FileListEntry {
  name: string;
  type: "file" | "directory";
  size: number;
  modifiedAt: number;
}

export interface StorageUsage {
  usedBytes: number;
  fileCount: number;
  quotaBytes: number;
  maxFiles: number;
  maxFileSizeBytes: number;
}

export interface FileListResultPayload {
  path: string;
  entries: FileListEntry[];
  usage: StorageUsage;
}

export const ERROR_CODES = {
  invalidMessage: "1001_INVALID_MESSAGE",
  helloRequired: "1002_HELLO_REQUIRED",
  protocolMismatch: "1003_PROTOCOL_MISMATCH",
  unexpectedMessage: "1004_UNEXPECTED_MESSAGE",
  invalidPayload: "1005_INVALID_PAYLOAD",
  authRequired: "2001_AUTH_REQUIRED",
  invalidCredentials: "2002_INVALID_CREDENTIALS",
  forbidden: "2003_FORBIDDEN",
  sessionExpired: "2004_SESSION_EXPIRED",
  sessionRevoked: "2005_SESSION_REVOKED",
  invalidPath: "3001_INVALID_PATH",
  notFound: "3004_NOT_FOUND",
  rateLimited: "4001_RATE_LIMITED",
  internalError: "5001_INTERNAL_ERROR",
  notImplemented: "5002_NOT_IMPLEMENTED",
} as const;

const typeSet = new Set<string>(CONTROL_MESSAGE_TYPES);

export function createControlMessage<TPayload>(
  type: ControlMessageType,
  requestId: string,
  payload: TPayload,
  timestamp = Date.now(),
): ControlMessage<TPayload> {
  return { version: PROTOCOL_VERSION, type, requestId, timestamp, payload };
}

export function serializeControlMessage(message: ControlMessage<unknown>): string {
  return JSON.stringify(message);
}

export function parseControlMessage(input: string): ControlMessage<unknown> {
  if (new TextEncoder().encode(input).byteLength > MAX_CONTROL_MESSAGE_BYTES) {
    throw new Error("control message exceeds size limit");
  }

  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new Error("control message is not valid JSON");
  }

  if (!isRecord(value)) throw new Error("control message must be an object");
  if (value.version !== PROTOCOL_VERSION) throw new Error("unsupported protocol version");
  if (typeof value.type !== "string" || !typeSet.has(value.type)) {
    throw new Error("unknown control message type");
  }
  if (typeof value.requestId !== "string" || !isIdentifier(value.requestId)) {
    throw new Error("invalid requestId");
  }
  if (typeof value.timestamp !== "number" || !Number.isSafeInteger(value.timestamp) || value.timestamp < 0) {
    throw new Error("invalid timestamp");
  }
  if (!isRecord(value.payload)) throw new Error("payload must be an object");

  return value as unknown as ControlMessage<unknown>;
}

export function hasStringField<TField extends string>(
  value: unknown,
  field: TField,
): value is Record<TField, string> {
  return isRecord(value) && typeof value[field] === "string";
}

function isIdentifier(value: string): boolean {
  return value.length >= 1 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

