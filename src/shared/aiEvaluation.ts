import { extractedDocumentSchema, type AiCitation } from "./ai";
import { voucherInputSchema } from "./schemas";
import type { ExtractedDocument } from "./assistiveAutomation";

export interface AiEvaluationFixture {
  id: string;
  extraction?: { expected: ExtractedDocument; actual: unknown };
  citations?: {
    allowed: AiCitation[];
    actual: AiCitation[];
    contextShared: boolean;
  };
  voucherDraft?: unknown;
}

export interface AiEvaluationResult {
  fixtureSet: string;
  fixtureCount: number;
  extractionAccuracyBps: number;
  citationValidityBps: number;
  draftValidityBps: number;
  details: {
    id: string;
    extraction: "pass" | "fail" | "not_tested";
    citations: "pass" | "fail" | "not_tested";
    voucherDraft: "pass" | "fail" | "not_tested";
  }[];
}

export interface AiEvaluationThresholds {
  extractionAccuracyBps: number;
  citationValidityBps: number;
  draftValidityBps: number;
}

const bps = (passed: number, tested: number): number =>
  tested === 0 ? 10_000 : Math.round((passed * 10_000) / tested);

/** Deterministic regression harness for fixed AI fixtures. It intentionally scores provider
 * output only after the same Zod/accounting boundaries used in production; a fluent answer
 * cannot receive credit for malformed amounts, invented citations or an invalid voucher. */
export function evaluateAiFixtures(
  fixtureSet: string,
  fixtures: AiEvaluationFixture[],
): AiEvaluationResult {
  let extractionTested = 0;
  let extractionPassed = 0;
  let citationTested = 0;
  let citationPassed = 0;
  let draftTested = 0;
  let draftPassed = 0;

  const details = fixtures.map((fixture) => {
    let extraction: "pass" | "fail" | "not_tested" = "not_tested";
    if (fixture.extraction) {
      extractionTested++;
      const parsed = extractedDocumentSchema.safeParse(
        fixture.extraction.actual,
      );
      const good =
        parsed.success &&
        JSON.stringify(parsed.data) ===
          JSON.stringify(fixture.extraction.expected);
      extraction = good ? "pass" : "fail";
      if (good) extractionPassed++;
    }

    let citations: "pass" | "fail" | "not_tested" = "not_tested";
    if (fixture.citations) {
      citationTested++;
      const allowed = new Set(
        fixture.citations.allowed.map((citation) => citation.uri),
      );
      const actual = fixture.citations.actual.map((citation) => citation.uri);
      const good = fixture.citations.contextShared
        ? actual.length > 0 && actual.every((uri) => allowed.has(uri))
        : actual.length === 0;
      citations = good ? "pass" : "fail";
      if (good) citationPassed++;
    }

    let voucherDraft: "pass" | "fail" | "not_tested" = "not_tested";
    if (fixture.voucherDraft !== undefined) {
      draftTested++;
      const parsed = voucherInputSchema.safeParse(fixture.voucherDraft);
      const good = parsed.success && parsed.data.lines.reduce(
        (balance, line) => balance + (line.drCr === "dr" ? line.amount : -line.amount),
        0,
      ) === 0;
      voucherDraft = good ? "pass" : "fail";
      if (good) draftPassed++;
    }
    return { id: fixture.id, extraction, citations, voucherDraft };
  });

  return {
    fixtureSet,
    fixtureCount: fixtures.length,
    extractionAccuracyBps: bps(extractionPassed, extractionTested),
    citationValidityBps: bps(citationPassed, citationTested),
    draftValidityBps: bps(draftPassed, draftTested),
    details,
  };
}

/** Release gate for a fixed, reviewed corpus. Provider output may be persuasive while still
 * regressing extraction, evidence or double-entry safety, so every dimension is independent. */
export function aiEvaluationMeetsThresholds(
  result: AiEvaluationResult,
  thresholds: AiEvaluationThresholds,
): boolean {
  return result.fixtureCount > 0 &&
    result.extractionAccuracyBps >= thresholds.extractionAccuracyBps &&
    result.citationValidityBps >= thresholds.citationValidityBps &&
    result.draftValidityBps >= thresholds.draftValidityBps;
}
