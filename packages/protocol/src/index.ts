export const PROTOCOL_NAME = "SFTP-WS";
export const PROTOCOL_VERSION = 1;
export const MAX_CONTROL_MESSAGE_BYTES = 64 * 1024;
export const BINARY_HEADER_LENGTH = 100;
export const DEFAULT_UPLOAD_CHUNK_SIZE = 256 * 1024;
export const DEFAULT_DOWNLOAD_CHUNK_SIZE = 256 * 1024;
export const MAX_BINARY_METADATA_BYTES = 8 * 1024;

export const BINARY_MESSAGE_TYPES = {
  uploadChunk: 0x0201,
  downloadChunk: 0x0202,
} as const;

export const BINARY_FLAGS = {
  ackRequired: 0x0001,
  final: 0x0002,
} as const;

export const CONTROL_MESSAGE_TYPES = [
  "HELLO",
  "HELLO_ACK",
  "HEARTBEAT_PING",
  "HEARTBEAT_PONG",
  "AUTH_LOGIN",
  "AUTH_KEY_CHALLENGE",
  "AUTH_KEY_CHALLENGE_RESULT",
  "AUTH_KEY_RESPONSE",
  "AUTH_PUBLIC_KEY_REGISTER",
  "AUTH_PUBLIC_KEY_REGISTERED",
  "AUTH_TOKEN",
  "AUTH_SUCCESS",
  "AUTH_LOGOUT",
  "AUTH_LOGOUT_ACK",
  "AUTH_ME",
  "AUTH_ME_RESULT",
  "FILE_LIST_REQUEST",
  "FILE_LIST_RESULT",
  "UPLOAD_INIT",
  "UPLOAD_READY",
  "UPLOAD_ACK",
  "UPLOAD_FINISH",
  "UPLOAD_COMPLETE",
  "UPLOAD_ABORT",
  "UPLOAD_ABORTED",
  "UPLOAD_PAUSE",
  "UPLOAD_PAUSED",
  "UPLOAD_ERROR",
  "DOWNLOAD_INIT",
  "DOWNLOAD_READY",
  "DOWNLOAD_ACK",
  "DOWNLOAD_FINISH",
  "DOWNLOAD_COMPLETE",
  "DOWNLOAD_ABORT",
  "DOWNLOAD_ERROR",
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

export interface UploadInitPayload {
  path: string;
  fileSize: number;
  fileSha256: string;
  resumeTransferId?: string;
}

export interface UploadReadyPayload {
  transferId: string;
  chunkSize: number;
  nextOffset: number;
}

export interface UploadAckPayload {
  transferId: string;
  persistedOffset: number;
  chunkLength: number;
}

export interface UploadFinishPayload {
  transferId: string;
}

export interface UploadCompletePayload {
  transferId: string;
  path: string;
  fileSize: number;
  fileSha256: string;
}

export interface UploadAbortPayload {
  transferId: string;
}

export interface UploadErrorPayload extends ErrorPayload {
  transferId?: string;
}

export interface DownloadInitPayload {
  path: string;
  offset?: number;
}

export interface DownloadReadyPayload {
  transferId: string;
  path: string;
  fileName: string;
  fileSize: number;
  fileSha256: string;
  chunkSize: number;
  nextOffset: number;
}

export interface DownloadAckPayload {
  transferId: string;
  nextOffset: number;
}

export interface DownloadFinishPayload {
  transferId: string;
  fileSize: number;
  fileSha256: string;
}

export interface DownloadCompletePayload {
  transferId: string;
  success: boolean;
  receivedSize: number;
  fileSha256: string;
  accepted?: boolean;
}

export interface DownloadAbortPayload {
  transferId: string;
  acknowledged?: boolean;
}

export interface DownloadErrorPayload extends ErrorPayload {
  transferId?: string;
}

export interface BinaryFrameHeader {
  messageType: number;
  flags: number;
  errorCode: number;
  requestId: string;
  transferId: string;
  fileSize: bigint;
  offset: bigint;
  payloadLength: number;
  metadataLength: number;
  payloadSha256: Uint8Array;
}

export interface ParsedBinaryFrame {
  header: BinaryFrameHeader;
  metadata: Uint8Array;
  payload: Uint8Array;
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
  fileExists: "3005_FILE_EXISTS",
  hashMismatch: "3007_HASH_MISMATCH",
  sizeMismatch: "3008_SIZE_MISMATCH",
  invalidOffset: "3009_INVALID_OFFSET",
  invalidChunk: "3010_INVALID_CHUNK",
  uploadCancelled: "3011_UPLOAD_CANCELLED",
  downloadCancelled: "3012_DOWNLOAD_CANCELLED",
  sourceChanged: "3013_SOURCE_CHANGED",
  ackTimeout: "3014_ACK_TIMEOUT",
  rateLimited: "4001_RATE_LIMITED",
  quotaExceeded: "4002_QUOTA_EXCEEDED",
  tooManyTasks: "4003_TOO_MANY_TASKS",
  insufficientStorage: "4004_INSUFFICIENT_STORAGE",
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

export function encodeBinaryFrame(
  header: Omit<BinaryFrameHeader, "payloadLength" | "metadataLength">,
  payload: Uint8Array,
  metadata = new Uint8Array(),
): Uint8Array {
  if (metadata.byteLength > MAX_BINARY_METADATA_BYTES) throw new Error("binary metadata exceeds limit");
  if (header.payloadSha256.byteLength !== 32) throw new Error("payload SHA-256 must be 32 bytes");
  const totalLength = BINARY_HEADER_LENGTH + metadata.byteLength + payload.byteLength;
  const bytes = new Uint8Array(totalLength);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("SFT1"), 0);
  view.setUint8(4, PROTOCOL_VERSION);
  view.setUint8(5, BINARY_HEADER_LENGTH);
  view.setUint16(6, header.messageType, false);
  view.setUint16(8, header.flags, false);
  view.setUint16(10, header.errorCode, false);
  bytes.set(uuidToBytes(header.requestId), 12);
  bytes.set(uuidToBytes(header.transferId), 28);
  view.setBigUint64(44, header.fileSize, false);
  view.setBigUint64(52, header.offset, false);
  view.setUint32(60, payload.byteLength, false);
  view.setUint32(64, metadata.byteLength, false);
  bytes.set(header.payloadSha256, 68);
  bytes.set(metadata, BINARY_HEADER_LENGTH);
  bytes.set(payload, BINARY_HEADER_LENGTH + metadata.byteLength);
  return bytes;
}

export function parseBinaryFrame(
  input: ArrayBuffer | Uint8Array,
  maxPayloadLength: number,
): ParsedBinaryFrame {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < BINARY_HEADER_LENGTH) throw new Error("binary frame is shorter than its header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== "SFT1") throw new Error("invalid binary frame magic");
  if (view.getUint8(4) !== PROTOCOL_VERSION) throw new Error("unsupported binary protocol version");
  if (view.getUint8(5) !== BINARY_HEADER_LENGTH) throw new Error("unsupported binary header length");
  const payloadLength = view.getUint32(60, false);
  const metadataLength = view.getUint32(64, false);
  if (payloadLength > maxPayloadLength) throw new Error("binary payload exceeds limit");
  if (metadataLength > MAX_BINARY_METADATA_BYTES) throw new Error("binary metadata exceeds limit");
  const expectedLength = BINARY_HEADER_LENGTH + metadataLength + payloadLength;
  if (expectedLength !== bytes.byteLength) throw new Error("binary frame length does not match header");
  const header: BinaryFrameHeader = {
    messageType: view.getUint16(6, false),
    flags: view.getUint16(8, false),
    errorCode: view.getUint16(10, false),
    requestId: bytesToUuid(bytes.subarray(12, 28)),
    transferId: bytesToUuid(bytes.subarray(28, 44)),
    fileSize: view.getBigUint64(44, false),
    offset: view.getBigUint64(52, false),
    payloadLength,
    metadataLength,
    payloadSha256: bytes.slice(68, 100),
  };
  return {
    header,
    metadata: bytes.subarray(BINARY_HEADER_LENGTH, BINARY_HEADER_LENGTH + metadataLength),
    payload: bytes.subarray(BINARY_HEADER_LENGTH + metadataLength),
  };
}

export function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("SHA-256 hex value is invalid");
  const result = new Uint8Array(32);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function uuidToBytes(uuid: string): Uint8Array {
  const compact = uuid.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/i.test(compact)) throw new Error("binary frame UUID is invalid");
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(compact.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesToUuid(bytes: Uint8Array): string {
  if (bytes.byteLength !== 16) throw new Error("binary UUID must be 16 bytes");
  const compact = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function isIdentifier(value: string): boolean {
  return value.length >= 1 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

