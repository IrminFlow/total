import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { verifyRelayEnvelope } from "./envelope.ts";

const b64 = (bytes: ArrayBuffer | Uint8Array): string => {
  const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...value));
};

const pem = (bytes: ArrayBuffer): string => {
  const encoded = b64(bytes);
  return `-----BEGIN PUBLIC KEY-----\n${encoded.match(/.{1,64}/g)!.join("\n")}\n-----END PUBLIC KEY-----\n`;
};

Deno.test("relay accepts an exact Ed25519-signed bounded envelope and rejects tampering", async () => {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const unsigned = {
    protocol: "total-sync/v1",
    workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    envelopeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    deviceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    sequence: 1,
    entityKind: "task",
    entityId: "month-close",
    createdAt: "2026-08-28T08:00:00.000Z",
    keyVersion: 1,
    cipher: "aes-256-gcm",
    iv: b64(crypto.getRandomValues(new Uint8Array(12))),
    authTag: b64(crypto.getRandomValues(new Uint8Array(16))),
    ciphertext: b64(new TextEncoder().encode("opaque ciphertext")),
    signingPublicKey: pem(await crypto.subtle.exportKey("spki", pair.publicKey)),
  };
  const signature = b64(await crypto.subtle.sign("Ed25519", pair.privateKey, new TextEncoder().encode(JSON.stringify(unsigned))));
  const envelope = { ...unsigned, signature };
  assertEquals((await verifyRelayEnvelope(envelope, unsigned.workspaceId)).envelopeId, unsigned.envelopeId);
  await assertRejects(() => verifyRelayEnvelope({ ...envelope, entityId: "changed" }, unsigned.workspaceId), Error, "signature");
  await assertRejects(() => verifyRelayEnvelope({ ...envelope, extra: true }, unsigned.workspaceId), Error, "fields");
});
