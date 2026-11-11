export const PROTOCOL_NAME = "SFTP-WS";
export const PROTOCOL_VERSION = 1;
export const MAX_CONTROL_MESSAGE_BYTES = 64 * 1024;

export const CONTROL_MESSAGE_TYPES = [
  "HELLO",
  "HELLO_ACK",
  "HEARTBEAT_PING",
  "HEARTBEAT_PONG",
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

