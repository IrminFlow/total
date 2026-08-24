import { createHash } from "crypto";

/** JSON canonicalization used by migration certificates. Keys are sorted recursively so the
 * content digest is portable across runtimes and independent of insertion order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("Certificate values must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("Certificate values must be JSON-compatible");
}

export function certificateContentSha256(content: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(content), "utf8")
    .digest("hex");
}

export function verifyCertificateContent(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { contentSha256, ...content } = value as Record<string, unknown>;
  return (
    typeof contentSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(contentSha256) &&
    certificateContentSha256(content) === contentSha256
  );
}
