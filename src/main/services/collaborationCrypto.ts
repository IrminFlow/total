import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import {
  collaborativeDocumentSchema,
  encryptedSyncEnvelopeSchema,
  type CollaborativeDocument,
  type EncryptedSyncEnvelope,
} from "@shared/collaborationSync";

export interface CollaborationKeyMaterial {
  encryptionKey: Buffer;
  signingPrivateKey: string;
  signingPublicKey: string;
}

export function generateCollaborationKeyMaterial(): CollaborationKeyMaterial {
  const pair = generateKeyPairSync("ed25519");
  return {
    encryptionKey: randomBytes(32),
    signingPrivateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    signingPublicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function envelopeSigningBytes(envelope: Omit<EncryptedSyncEnvelope, "signature">): Buffer {
  return Buffer.from(JSON.stringify(envelope), "utf8");
}

function aad(input: Pick<EncryptedSyncEnvelope, "protocol" | "workspaceId" | "envelopeId" | "deviceId" | "sequence" | "entityKind" | "entityId" | "createdAt" | "keyVersion">): Buffer {
  return Buffer.from(JSON.stringify({
    protocol: input.protocol,
    workspaceId: input.workspaceId,
    envelopeId: input.envelopeId,
    deviceId: input.deviceId,
    sequence: input.sequence,
    entityKind: input.entityKind,
    entityId: input.entityId,
    createdAt: input.createdAt,
    keyVersion: input.keyVersion,
  }), "utf8");
}

export function encryptCollaborationDocument(input: {
  workspaceId: string;
  envelopeId: string;
  deviceId: string;
  sequence: number;
  createdAt: string;
  document: CollaborativeDocument;
  keys: CollaborationKeyMaterial;
}): EncryptedSyncEnvelope {
  const header = {
    protocol: "total-sync/v1" as const,
    workspaceId: input.workspaceId,
    envelopeId: input.envelopeId,
    deviceId: input.deviceId,
    sequence: input.sequence,
    entityKind: input.document.entityKind,
    entityId: input.document.entityId,
    createdAt: input.createdAt,
    keyVersion: 1,
  };
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", input.keys.encryptionKey, iv);
  cipher.setAAD(aad(header));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(collaborativeDocumentSchema.parse(input.document)), "utf8"),
    cipher.final(),
  ]);
  const unsigned = {
    ...header,
    cipher: "aes-256-gcm" as const,
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    signingPublicKey: input.keys.signingPublicKey,
  };
  return encryptedSyncEnvelopeSchema.parse({
    ...unsigned,
    signature: sign(null, envelopeSigningBytes(unsigned), createPrivateKey(input.keys.signingPrivateKey)).toString("base64"),
  });
}

export function decryptCollaborationEnvelope(
  value: EncryptedSyncEnvelope,
  encryptionKey: Buffer,
): CollaborativeDocument {
  const envelope = encryptedSyncEnvelopeSchema.parse(value);
  const { signature, ...unsigned } = envelope;
  if (!verify(null, envelopeSigningBytes(unsigned), createPublicKey(envelope.signingPublicKey), Buffer.from(signature, "base64")))
    throw new Error("Sync envelope signature is invalid");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(envelope.iv, "base64"));
  decipher.setAAD(aad(envelope));
  decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
  const document = collaborativeDocumentSchema.parse(JSON.parse(plaintext));
  if (document.entityKind !== envelope.entityKind || document.entityId !== envelope.entityId)
    throw new Error("Sync envelope metadata does not match its encrypted document");
  return document;
}
