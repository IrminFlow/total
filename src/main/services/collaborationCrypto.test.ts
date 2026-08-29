import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CollaborativeDocument } from "@shared/collaborationSync";
import {
  decryptCollaborationEnvelope,
  encryptCollaborationDocument,
  generateCollaborationKeyMaterial,
} from "./collaborationCrypto";

describe("collaboration envelope crypto", () => {
  it("encrypts, authenticates, signs and restores a collaboration document", () => {
    const keys = generateCollaborationKeyMaterial();
    const deviceId = randomUUID();
    const document: CollaborativeDocument = {
      entityKind: "comment",
      entityId: "review-42",
      fields: {
        body: {
          value: "Please check the attachment",
          clock: { [deviceId]: 1 },
          updatedAt: "2026-08-27T10:00:00.000Z",
          deviceId,
        },
      },
      clock: { [deviceId]: 1 },
      deleted: false,
    };
    const envelope = encryptCollaborationDocument({
      workspaceId: randomUUID(),
      envelopeId: randomUUID(),
      deviceId,
      sequence: 1,
      createdAt: "2026-08-27T10:00:00.000Z",
      document,
      keys,
    });
    expect(envelope.ciphertext).not.toContain("attachment");
    expect(decryptCollaborationEnvelope(envelope, keys.encryptionKey)).toEqual(document);
  });

  it("rejects changed routing metadata before decryption", () => {
    const keys = generateCollaborationKeyMaterial();
    const deviceId = randomUUID();
    const envelope = encryptCollaborationDocument({
      workspaceId: randomUUID(),
      envelopeId: randomUUID(),
      deviceId,
      sequence: 1,
      createdAt: "2026-08-27T10:00:00.000Z",
      document: {
        entityKind: "draft",
        entityId: "draft-1",
        fields: {},
        clock: { [deviceId]: 1 },
        deleted: false,
      },
      keys,
    });
    expect(() => decryptCollaborationEnvelope({ ...envelope, sequence: 2 }, keys.encryptionKey)).toThrow("signature");
  });
});
