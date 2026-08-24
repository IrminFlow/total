import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  certificateContentSha256,
  verifyCertificateContent,
} from "./migrationCertificateManifest";

describe("migration certificate manifest", () => {
  it("hashes semantically identical JSON independent of key order", () => {
    const first = { z: 1, nested: { b: 2, a: [true, null, "x"] } };
    const second = { nested: { a: [true, null, "x"], b: 2 }, z: 1 };
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(certificateContentSha256(first)).toBe(
      certificateContentSha256(second),
    );
  });

  it("detects any mutation to a self-hashed certificate", () => {
    const content = {
      schema: "total.migration-reconciliation-certificate",
      schemaVersion: 1,
      batch: { id: 7 },
    };
    const certificate = {
      ...content,
      contentSha256: certificateContentSha256(content),
    };
    expect(verifyCertificateContent(certificate)).toBe(true);
    expect(verifyCertificateContent({ ...certificate, batch: { id: 8 } })).toBe(
      false,
    );
  });

  it("rejects values that JSON cannot represent faithfully", () => {
    expect(() => canonicalJson({ amount: Number.NaN })).toThrow(/finite/);
    expect(() => canonicalJson({ missing: undefined })).toThrow(
      /JSON-compatible/,
    );
  });
});
