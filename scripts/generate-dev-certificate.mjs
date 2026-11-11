import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import selfsigned from "selfsigned";

const output = resolve("certs");
await mkdir(output, { recursive: true });
const now = new Date();
const expires = new Date(now);
expires.setFullYear(expires.getFullYear() + 3);

const ca = await selfsigned.generate([{ name: "commonName", value: "SecureFileTransfer Dev CA" }], {
  keyType: "rsa", keySize: 2048, algorithm: "sha256", notBeforeDate: now, notAfterDate: expires,
  extensions: [
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
  ],
});
const server = await selfsigned.generate([{ name: "commonName", value: "localhost" }], {
  keyType: "rsa", keySize: 2048, algorithm: "sha256", notBeforeDate: now, notAfterDate: expires,
  ca: { key: ca.private, cert: ca.cert },
  extensions: [
    { name: "basicConstraints", cA: false, critical: true },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames: [
      { type: 2, value: "localhost" }, { type: 7, ip: "127.0.0.1" }, { type: 7, ip: "::1" },
    ] },
  ],
});

await Promise.all([
  writeFile(resolve(output, "dev-ca.pem"), ca.cert, { mode: 0o644 }),
  writeFile(resolve(output, "dev-server.pem"), server.cert, { mode: 0o644 }),
  writeFile(resolve(output, "dev-server-key.pem"), server.private, { mode: 0o600 }),
]);
console.log(`Generated local TLS files in ${output}`);
console.log("Trust certs/dev-ca.pem for CurrentUser before opening the HTTPS demo.");
