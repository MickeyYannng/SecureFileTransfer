import assert from "node:assert/strict";
import test from "node:test";
import {
  createControlMessage,
  parseControlMessage,
  serializeControlMessage,
} from "./index.js";

test("round-trips a heartbeat control message", () => {
  const message = createControlMessage("HEARTBEAT_PING", "req-1", { nonce: "nonce-1" }, 123);
  assert.deepEqual(parseControlMessage(serializeControlMessage(message)), message);
});

test("rejects unsupported versions and invalid identifiers", () => {
  assert.throws(
    () => parseControlMessage('{"version":2,"type":"HELLO","requestId":"req-1","timestamp":1,"payload":{}}'),
    /unsupported protocol version/,
  );
  assert.throws(
    () => parseControlMessage('{"version":1,"type":"HELLO","requestId":"../bad","timestamp":1,"payload":{}}'),
    /invalid requestId/,
  );
});

