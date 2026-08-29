const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const base64 = /^[A-Za-z0-9+/]+={0,2}$/;
const envelopeKeys = [
  "protocol", "workspaceId", "envelopeId", "deviceId", "sequence", "entityKind",
  "entityId", "createdAt", "keyVersion", "cipher", "iv", "authTag", "ciphertext",
  "signingPublicKey", "signature",
].sort();

function bytesFromBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer as ArrayBuffer;
}

/** Complete relay-boundary validation. The service still cannot read ciphertext, but it can
 * reject malformed headers and verify that the registered device signed the exact envelope. */
export async function verifyRelayEnvelope(value: unknown, workspaceId: string): Promise<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid envelope");
  const envelope = value as Record<string, unknown>;
  if (Object.keys(envelope).sort().join("\0") !== envelopeKeys.join("\0"))
    throw new Error("Envelope fields are incomplete or unsupported");
  if (envelope.protocol !== "total-sync/v1" || envelope.workspaceId !== workspaceId)
    throw new Error("Envelope workspace mismatch");
  if (!uuid.test(String(envelope.envelopeId)) || !uuid.test(String(envelope.deviceId)))
    throw new Error("Envelope identifiers are invalid");
  if (!Number.isSafeInteger(envelope.sequence) || Number(envelope.sequence) < 1 || Number(envelope.sequence) > Number.MAX_SAFE_INTEGER)
    throw new Error("Envelope sequence is invalid");
  if (!['proposal','draft','comment','task'].includes(String(envelope.entityKind)))
    throw new Error("Unsupported collaboration entity");
  if (typeof envelope.entityId !== "string" || envelope.entityId.length < 1 || envelope.entityId.length > 180)
    throw new Error("Envelope entity identifier is invalid");
  if (typeof envelope.createdAt !== "string" || !Number.isFinite(Date.parse(envelope.createdAt)) || envelope.createdAt.length > 40)
    throw new Error("Envelope timestamp is invalid");
  if (!Number.isSafeInteger(envelope.keyVersion) || Number(envelope.keyVersion) < 1 || envelope.cipher !== "aes-256-gcm")
    throw new Error("Envelope cryptography metadata is invalid");
  for (const [field, maximum] of [["iv", 128], ["authTag", 128], ["ciphertext", 1_800_000], ["signature", 512]] as const) {
    const fieldValue = envelope[field];
    if (typeof fieldValue !== "string" || fieldValue.length < 1 || fieldValue.length > maximum || !base64.test(fieldValue))
      throw new Error(`Envelope ${field} is invalid`);
  }
  if (typeof envelope.signingPublicKey !== "string" || envelope.signingPublicKey.length > 2048 ||
      !/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+\n-----END PUBLIC KEY-----\n?$/.test(envelope.signingPublicKey))
    throw new Error("Envelope signing key is invalid");
  const pemBody = envelope.signingPublicKey.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  const publicKey = await crypto.subtle.importKey("spki", bytesFromBase64(pemBody), { name: "Ed25519" }, false, ["verify"]);
  const { signature, ...unsigned } = envelope;
  const verified = await crypto.subtle.verify(
    { name: "Ed25519" },
    publicKey,
    bytesFromBase64(String(signature)),
    new TextEncoder().encode(JSON.stringify(unsigned)),
  );
  if (!verified) throw new Error("Envelope signature is invalid");
  return envelope;
}
