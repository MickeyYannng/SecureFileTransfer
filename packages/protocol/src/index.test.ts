import assert from "node:assert/strict";
import test from "node:test";
import {
  BINARY_FLAGS,
  BINARY_MESSAGE_TYPES,
  bytesToHex,
  createControlMessage,
  encodeBinaryFrame,
  hexToBytes,
  parseBinaryFrame,
  parseControlMessage,
  serializeControlMessage,
} from "./index.js";

test("round-trips a heartbeat control message", () => {
  const message = createControlMessage("HEARTBEAT_PING", "req-1", { nonce: "nonce-1" }, 123);
  assert.deepEqual(parseControlMessage(serializeControlMessage(message)), message);
});

test("encodes and parses the fixed 100-byte upload chunk header", () => {
  const payload = new TextEncoder().encode("chunk-data");
  const digest = hexToBytes("ab".repeat(32));
  const encoded = encodeBinaryFrame({
    messageType: BINARY_MESSAGE_TYPES.uploadChunk,
    flags: BINARY_FLAGS.ackRequired,
    errorCode: 0,
    requestId: "11111111-1111-4111-8111-111111111111",
    transferId: "22222222-2222-4222-8222-222222222222",
    fileSize: 100n,
    offset: 10n,
    payloadSha256: digest,
  }, payload);
  const parsed = parseBinaryFrame(encoded, 1024);
  assert.equal(parsed.header.messageType, BINARY_MESSAGE_TYPES.uploadChunk);
  assert.equal(parsed.header.fileSize, 100n);
  assert.equal(parsed.header.offset, 10n);
  assert.equal(bytesToHex(parsed.header.payloadSha256), "ab".repeat(32));
  assert.deepEqual(parsed.payload, payload);
});

test("rejects binary frames with inconsistent lengths", () => {
  const encoded = encodeBinaryFrame({
    messageType: BINARY_MESSAGE_TYPES.uploadChunk,
    flags: BINARY_FLAGS.ackRequired,
    errorCode: 0,
    requestId: "11111111-1111-4111-8111-111111111111",
    transferId: "22222222-2222-4222-8222-222222222222",
    fileSize: 1n,
    offset: 0n,
    payloadSha256: new Uint8Array(32),
  }, new Uint8Array([1]));
  assert.throws(() => parseBinaryFrame(encoded.subarray(0, encoded.length - 1), 1024), /length/);
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

