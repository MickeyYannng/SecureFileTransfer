import { randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import express from "express";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  MAX_CONTROL_MESSAGE_BYTES,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  createControlMessage,
  hasStringField,
  parseControlMessage,
  serializeControlMessage,
  type ControlMessage,
  type ErrorPayload,
  type HeartbeatPayload,
  type HelloAckPayload,
} from "@sft/protocol";

export interface ServerOptions {
  host?: string;
  port?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

interface ConnectionState {
  connectionId: string;
  helloComplete: boolean;
  lastPongAt: number;
  messagesInWindow: number;
  rateWindowStartedAt: number;
}

export interface RunningServer {
  host: string;
  port: number;
  httpServer: HttpServer;
  close(): Promise<void>;
}

const CONTROL_RATE_WINDOW_MS = 10_000;
const CONTROL_RATE_LIMIT = 100;

export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 3000;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 45_000;
  const logger = options.logger ?? console;

  if (heartbeatIntervalMs <= 0 || heartbeatTimeoutMs <= heartbeatIntervalMs) {
    throw new Error("heartbeat timeout must be greater than the positive interval");
  }

  const app = express();
  app.disable("x-powered-by");
  app.get("/health", (_request, response) => {
    response.json({ status: "ok", protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION });
  });

  const httpServer = createServer(app);
  const webSocketServer = new WebSocketServer({
    server: httpServer,
    path: "/ws",
    maxPayload: MAX_CONTROL_MESSAGE_BYTES,
    perMessageDeflate: false,
  });

  const states = new WeakMap<WebSocket, ConnectionState>();

  webSocketServer.on("connection", (socket) => {
    const now = Date.now();
    const state: ConnectionState = {
      connectionId: randomUUID(),
      helloComplete: false,
      lastPongAt: now,
      messagesInWindow: 0,
      rateWindowStartedAt: now,
    };
    states.set(socket, state);

    socket.on("message", (data, isBinary) => {
      if (!allowControlMessage(state)) {
        sendError(socket, randomUUID(), "RATE_LIMITED", "too many control messages", true);
        socket.close(1008, "rate limit exceeded");
        return;
      }
      if (isBinary) {
        sendError(socket, randomUUID(), "NOT_IMPLEMENTED", "binary transfer frames begin in Phase 2", false);
        return;
      }

      let message: ControlMessage<unknown>;
      try {
        message = parseControlMessage(rawDataToUtf8(data));
      } catch (error) {
        sendError(socket, randomUUID(), "INVALID_MESSAGE", errorMessage(error), false);
        return;
      }

      if (!state.helloComplete && message.type !== "HELLO") {
        sendError(socket, message.requestId, "HELLO_REQUIRED", "HELLO must be the first message", false);
        return;
      }

      switch (message.type) {
        case "HELLO": {
          if (!hasStringField(message.payload, "protocol") || message.payload.protocol !== PROTOCOL_NAME) {
            sendError(socket, message.requestId, "PROTOCOL_MISMATCH", "unsupported protocol name", false);
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
          break;
        }
        case "HEARTBEAT_PING": {
          if (!hasStringField(message.payload, "nonce")) {
            sendError(socket, message.requestId, "INVALID_PAYLOAD", "heartbeat nonce is required", false);
            return;
          }
          send(socket, createControlMessage("HEARTBEAT_PONG", message.requestId, { nonce: message.payload.nonce }));
          break;
        }
        case "HEARTBEAT_PONG": {
          if (hasStringField(message.payload, "nonce")) state.lastPongAt = Date.now();
          break;
        }
        case "HELLO_ACK":
        case "ERROR":
          sendError(socket, message.requestId, "UNEXPECTED_MESSAGE", `${message.type} is server-originated`, false);
          break;
      }
    });

    socket.on("error", (error) => logger.warn(`WebSocket ${state.connectionId}: ${error.message}`));
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
      const payload: HeartbeatPayload = { nonce: randomUUID() };
      send(socket, createControlMessage("HEARTBEAT_PING", randomUUID(), payload));
    }
  }, heartbeatIntervalMs);
  heartbeatTimer.unref();

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");
  logger.info(`SFT Phase 1 server listening on http://${host}:${address.port}`);

  return {
    host,
    port: address.port,
    httpServer,
    async close() {
      clearInterval(heartbeatTimer);
      for (const socket of webSocketServer.clients) socket.close(1001, "server shutdown");
      await new Promise<void>((resolve, reject) => {
        webSocketServer.close(() => {
          httpServer.close((error) => (error ? reject(error) : resolve()));
        });
      });
    },
  };
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

