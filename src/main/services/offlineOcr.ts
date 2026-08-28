import { existsSync, readFileSync, statSync } from "fs";
import { basename, join } from "path";
import { createRequire } from "module";
import type { ExtractedDocument } from "@shared/assistiveAutomation";
const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;

const require = createRequire(import.meta.url);

interface OcrResult {
  data: { text?: string; confidence?: number };
}

interface EnglishModel {
  code: string;
  gzip: boolean;
  langPath: string;
}

function amountPaise(value: string): number | null {
  const normalized = value.replace(/(?:₹|Rs\.?)/gi, "").replace(/[,\s]/g, "").replace(/[^0-9.()-]/g, "");
  if (!normalized || !/^-?\(?\d+(?:\.\d{1,2})?\)?$/.test(normalized)) return null;
  const negative = normalized.startsWith("-") || (normalized.startsWith("(") && normalized.endsWith(")"));
  const unsigned = normalized.replace(/[()-]/g, "");
  const [rupees, fraction = ""] = unsigned.split(".");
  const result = Number(rupees) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(result) ? (negative ? -result : result) : null;
}

function toIsoDate(value: string): string | null {
  const match = value.match(/\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})\b/);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]) + (match[3]!.length === 2 ? 2000 : 0);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function labelledAmount(lines: string[], labels: RegExp[]): number | null {
  for (const line of [...lines].reverse()) {
    if (!labels.some((label) => label.test(line))) continue;
    const matches = line.match(/(?:₹|Rs\.?\s*)?\d[\d,]*(?:\.\d{1,2})?/gi) ?? [];
    for (const candidate of matches.reverse()) {
      const amount = amountPaise(candidate);
      if (amount != null && amount >= 0) return amount;
    }
  }
  return null;
}

function taxAmount(lines: string[]): number | null {
  const explicitTotal = labelledAmount(lines, [
    /\btotal\s+(?:gst|tax)\b/i,
    /\b(?:gst|tax)\s+(?:total|amount)\b/i,
  ]);
  if (explicitTotal != null) return explicitTotal;

  const components = lines.flatMap((line) => {
    if (/\bgstin\b/i.test(line) || !/\b(?:igst|cgst|sgst|gst|cess)\b/i.test(line)) return [];
    const candidates = line.match(/(?:₹|Rs\.?\s*)?\d[\d,]*(?:\.\d{1,2})?/gi) ?? [];
    const amount = candidates.length ? amountPaise(candidates[candidates.length - 1]!) : null;
    return amount == null || amount < 0 ? [] : [amount];
  });
  return components.length ? components.reduce((sum, amount) => sum + amount, 0) : null;
}

export function parseOfflineInvoiceText(text: string, confidence: number, fileName = "document"): ExtractedDocument {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const gstin = text.toUpperCase().match(/\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]\b/)?.[0] ?? null;
  const dateLine = lines.find((line) => /(?:invoice\s+date|bill\s+date|dated?|date)\b/i.test(line));
  const date = toIsoDate(dateLine ?? text);
  const numberLine = lines.find((line) => /(?:invoice|bill|receipt)\s*(?:no|number|#)/i.test(line));
  const documentNumber = numberLine?.match(/(?:no\.?|number|#)\s*[:\-]?\s*([A-Z0-9][A-Z0-9\/_\-.]{1,40})/i)?.[1] ?? null;
  const total = labelledAmount(lines, [/grand\s*total/i, /invoice\s*(?:value|total)/i, /amount\s*payable/i, /net\s*amount/i, /^total\b/i]);
  const tax = taxAmount(lines);
  const subtotal = labelledAmount(lines, [/sub\s*total/i, /taxable\s*(?:value|amount)/i]);
  const warnings = ["Extracted locally with bundled OCR. Compare every value with the source image."];
  if (!documentNumber) warnings.push("Document number was not detected.");
  if (!date) warnings.push("Document date was not detected.");
  if (total == null) warnings.push("Invoice total was not detected.");
  if (confidence < 70) warnings.push("OCR confidence is low; manual entry may be faster.");
  const merchant = lines.find((line) => line.length >= 3 && line.length <= 100 && !/(invoice|receipt|bill\s*(?:no|number|#)|tax|gst|cess|total|amount|value|phone|email|date|dated|original|duplicate)/i.test(line))
    ?? basename(fileName).replace(/\.[^.]+$/, "");
  return {
    supplierOrMerchant: merchant || null,
    documentNumber,
    date,
    gstin,
    subtotal,
    tax,
    total,
    items: [],
    confidenceBps: Math.max(0, Math.min(10_000, Math.round(confidence * 100))),
    warnings,
  };
}

/** Fully local OCR. The WASM engine and English trained-data file are packaged with Total. */
export async function extractDocumentOffline(path: string): Promise<ExtractedDocument> {
  const size = statSync(path).size;
  if (size <= 0 || size > MAX_DOCUMENT_BYTES) throw new Error("Document must be between 1 byte and 15 MB");
  const tesseract = await import("tesseract.js");
  const model = require("@tesseract.js-data/eng") as EnglishModel;
  const packagedModel = typeof process.resourcesPath === "string" ? join(process.resourcesPath, "offline-ocr") : "";
  const worker = await tesseract.createWorker(model.code, undefined, {
    langPath: packagedModel && existsSync(join(packagedModel, "eng.traineddata.gz")) ? packagedModel : model.langPath,
    gzip: model.gzip,
    logger: () => undefined,
  });
  try {
    const result = await worker.recognize(readFileSync(path)) as OcrResult;
    return parseOfflineInvoiceText(result.data.text ?? "", result.data.confidence ?? 0, path);
  } finally {
    await worker.terminate();
  }
}
