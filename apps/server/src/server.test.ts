import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  PROTOCOL_NAME,
  createControlMessage,
  hasStringField,
  parseControlMessage,
  serializeControlMessage,
} from "@sft/protocol";
import { startServer } from "./server.js";

const silentLogger = { info() {}, warn() {}, error() {} };

test("negotiates HELLO and completes an application heartbeat", async (t) => {
  const server = await startServer({
    port: 0,
    heartbeatIntervalMs: 25,
    heartbeatTimeoutMs: 250,
    logger: silentLogger,
  });
  t.after(() => server.close());

  const socket = new WebSocket(`ws://${server.host}:${server.port}/ws`);
  t.after(() => socket.close());
  await onceOpen(socket);

  const requestId = randomUUID();
  socket.send(
    serializeControlMessage(
      createControlMessage("HELLO", requestId, { protocol: PROTOCOL_NAME, clientName: "integration-test" }),
    ),
  );

  const helloAck = await nextMessage(socket);
  assert.equal(helloAck.type, "HELLO_ACK");
  assert.equal(helloAck.requestId, requestId);

  const ping = await nextMessage(socket);
  assert.equal(ping.type, "HEARTBEAT_PING");
  assert.ok(hasStringField(ping.payload, "nonce"));
  socket.send(
    serializeControlMessage(
      createControlMessage("HEARTBEAT_PONG", ping.requestId, { nonce: ping.payload.nonce }),
    ),
  );
});

function onceOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function nextMessage(socket: WebSocket): Promise<ReturnType<typeof parseControlMessage>> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      try {
        resolve(parseControlMessage(data.toString()));
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

