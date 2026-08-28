import { readFileSync, statSync } from "node:fs";
import { dryRunTallyXml, type ImportSummary } from "./tallyImport";

export const MAX_TALLY_IMPORT_BYTES = 64 * 1024 * 1024;

function assertSize(byteLength: number): void {
  if (byteLength === 0) throw new Error("Tally export is empty");
  if (byteLength > MAX_TALLY_IMPORT_BYTES)
    throw new Error("Tally export exceeds the 64 MB import limit");
}

export function decodeTallyXml(bytes: Buffer): string {
  assertSize(bytes.byteLength);
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return bytes.subarray(2).toString("utf16le").replace(/^\uFEFF/, "");
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const body = bytes.subarray(2);
    if (body.byteLength % 2 !== 0) throw new Error("Invalid UTF-16BE Tally export");
    const swapped = Buffer.allocUnsafe(body.byteLength);
    for (let i = 0; i < body.byteLength; i += 2) {
      swapped[i] = body[i + 1]!;
      swapped[i + 1] = body[i]!;
    }
    return swapped.toString("utf16le").replace(/^\uFEFF/, "");
  }
  const offset = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset)).replace(/^\uFEFF/, "");
  } catch {
    throw new Error("Tally export must be UTF-8, UTF-16LE, or UTF-16BE text");
  }
}

export function readTallyXmlFile(path: string): string {
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error("Tally import path must be a regular file");
  assertSize(stat.size);
  const bytes = readFileSync(path);
  // Recheck after reading in case the file changed between stat and read.
  assertSize(bytes.byteLength);
  return decodeTallyXml(bytes);
}

export function validateTallyXml(xml: string): ImportSummary {
  assertSize(Buffer.byteLength(xml, "utf8"));
  const summary = dryRunTallyXml(xml);
  const recognized = summary.groups + summary.ledgers + summary.units + summary.items + summary.vouchers;
  if (recognized === 0)
    throw new Error("Unsupported Tally export: no recognized masters or vouchers were found");
  return summary;
}
