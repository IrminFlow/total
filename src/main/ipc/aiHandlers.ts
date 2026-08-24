import { dialog } from "electron";
import { mkdirSync } from "fs";
import { randomUUID } from "crypto";
import { extname, join } from "path";
import { z } from "zod";
import type { DB } from "../db/connection";
import type { CompanyInfo } from "@shared/domain";
import type { Role } from "../services/roles";
import { isoDate, periodSchema } from "@shared/schemas";
import { aiAskSchema, aiDraftVoucherSchema, aiProviderInputSchema } from "@shared/ai";
import { companyDir } from "../paths";
import * as ai from "../services/ai";
import * as assistiveAutomation from "../services/assistiveAutomation";
import * as attachmentVault from "../services/attachmentVault";

type Handler = (payload: unknown) => unknown | Promise<unknown>;
export type IpcHandle = (channel: string, handler: Handler, minRole?: Role) => void;

interface CompanyContext {
  slug: string;
  db: DB;
  info: CompanyInfo;
}

export interface AiHandlerContext {
  handle: IpcHandle;
  requireCompany: () => CompanyContext;
  actor: () => string;
}

export function registerAiHandlers({ handle, requireCompany, actor }: AiHandlerContext): void {
  handle("ai:getConfig", () => ai.getConfig(), "viewer");
  handle("ai:setConfig", (payload) => ai.setConfig(aiProviderInputSchema.parse(payload)), "owner");
  handle("ai:testConnection", () => ai.testConnection(), "owner");
  handle("ai:contextPreview", (payload) => {
    const { from, to, fields } = periodSchema.extend({
      fields: z.array(z.enum(["company", "period", "dashboard", "trial_balance", "receivables", "payables", "units"])).max(7).optional(),
    }).parse(payload);
    const company = requireCompany();
    return ai.contextPreview(company.db, company.info, from, to, fields);
  }, "viewer");
  handle("ai:ask", async (payload) => {
    const input = aiAskSchema.parse(payload);
    const company = requireCompany();
    const context = input.includeContext
      ? ai.selectedContext(company.db, company.info, input.from, input.to, input.contextFields)
      : null;
    return ai.ask(input.prompt, context);
  }, "viewer");
  handle("ai:draftVoucher", async (payload) => {
    const { prompt } = aiDraftVoucherSchema.parse(payload);
    const company = requireCompany();
    return ai.draftVoucher(company.db, company.slug, prompt);
  }, "accountant");
  handle("ai:documents:list", () => assistiveAutomation.listDocumentInbox(requireCompany().db), "viewer");
  handle("ai:documents:capture", async (payload) => {
    const { kind } = z.object({ kind: z.enum(["supplier_invoice", "receipt"]) }).parse(payload);
    const picked = await dialog.showOpenDialog({
      title: kind === "supplier_invoice" ? "Choose a supplier invoice image" : "Choose a receipt image",
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
      properties: ["openFile"],
    });
    if (picked.canceled || !picked.filePaths[0]) return null;
    const company = requireCompany();
    const route = assistiveAutomation.listTaskRoutes(company.db).find((row) => row.taskKind === "ocr");
    const extracted = await ai.extractDocumentImage(picked.filePaths[0], kind, route?.model, route?.provider);
    const documentDir = join(companyDir(company.slug), "attachments", "assist");
    mkdirSync(documentDir, { recursive: true });
    const storedPath = join(documentDir, `${kind}-${randomUUID()}${extname(picked.filePaths[0]).toLowerCase()}`);
    const managedPath = attachmentVault.storeManagedAttachment(company.db, company.slug, picked.filePaths[0], storedPath);
    return assistiveAutomation.addExtractedDocument(company.db, kind, managedPath, extracted, actor());
  }, "accountant");
  handle("ai:documents:review", (payload) => {
    const { id, status } = z.object({
      id: z.number().int().positive(),
      status: z.enum(["approved", "dismissed"]),
    }).parse(payload);
    return assistiveAutomation.reviewDocument(requireCompany().db, id, status, actor());
  });
  handle("ai:ledgerSuggestions", (payload) => {
    const { kind, query, contextKey, partyLedgerId } = z.object({
      kind: z.string().trim().min(1).max(50),
      query: z.string().max(100),
      contextKey: z.string().trim().min(1).max(200),
      partyLedgerId: z.number().int().positive().nullable().optional(),
    }).parse(payload);
    return assistiveAutomation.evidenceLedgerSuggestions(requireCompany().db, kind, query, contextKey, partyLedgerId);
  }, "viewer");
  handle("ai:ledgerFeedback", (payload) => {
    const { contextKey, ledgerId, outcome } = z.object({
      contextKey: z.string().trim().min(1).max(200),
      ledgerId: z.number().int().positive(),
      outcome: z.enum(["accepted", "rejected"]),
    }).parse(payload);
    assistiveAutomation.recordLedgerFeedback(requireCompany().db, contextKey, ledgerId, outcome, actor());
    return null;
  });
  handle("search:natural", (payload) => {
    const { query } = z.object({ query: z.string().trim().min(1).max(200) }).parse(payload);
    return assistiveAutomation.constrainedNaturalSearch(requireCompany().db, query);
  }, "viewer");
  handle("ai:reconciliationExplain", (payload) => {
    const input = z.object({
      kind: z.enum(["tolerance", "many_to_one"]),
      statementAmount: z.number().int().positive(),
      lines: z.array(z.object({
        voucherId: z.number().int().positive(),
        date: isoDate,
        number: z.string(),
        amount: z.number().int().positive(),
      })).min(1).max(20),
    }).parse(payload);
    return assistiveAutomation.reconciliationExplanation(input.kind, input.statementAmount, input.lines);
  }, "viewer");
  handle("ai:varianceNarrative", (payload) => {
    const input = z.object({
      currentFrom: isoDate,
      currentTo: isoDate,
      comparisonFrom: isoDate,
      comparisonTo: isoDate,
    }).parse(payload);
    return assistiveAutomation.citedVarianceNarrative(
      requireCompany().db,
      input.currentFrom,
      input.currentTo,
      input.comparisonFrom,
      input.comparisonTo,
    );
  }, "viewer");
  handle("ai:collectionMessage", (payload) => {
    const { ledgerId, asOn, tone, billVoucherIds } = z.object({
      ledgerId: z.number().int().positive(),
      asOn: isoDate,
      tone: z.enum(["polite", "firm"]),
      billVoucherIds: z.array(z.number().int().positive()).min(1).max(50),
    }).parse(payload);
    return assistiveAutomation.collectionMessage(requireCompany().db, ledgerId, asOn, tone, billVoucherIds);
  }, "viewer");
  handle("ai:routes:list", () => assistiveAutomation.listTaskRoutes(requireCompany().db), "viewer");
  handle("ai:routes:set", (payload) => {
    const input = z.object({
      taskKind: z.enum(["ocr", "classification", "analysis", "writing"]),
      provider: z.enum(["default", "openai", "compatible"]),
      model: z.string().trim().max(120).nullable(),
    }).parse(payload);
    if (input.provider !== "default") ai.taskProviderConfig(input.provider);
    return assistiveAutomation.setTaskRoute(requireCompany().db, input, actor());
  }, "owner");
  handle("ai:evaluation:record", (payload) => {
    const input = z.object({
      fixtureSet: z.string().trim().min(1).max(100),
      extractionAccuracyBps: z.number().int().min(0).max(10000),
      citationValidityBps: z.number().int().min(0).max(10000),
      draftValidityBps: z.number().int().min(0).max(10000),
      details: z.unknown(),
    }).parse(payload);
    return { id: assistiveAutomation.recordEvaluation(requireCompany().db, input) };
  }, "owner");
}
