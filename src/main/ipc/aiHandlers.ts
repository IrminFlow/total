import { dialog } from "electron";
import { mkdirSync } from "fs";
import { randomUUID } from "crypto";
import { extname, join } from "path";
import { z } from "zod";
import type { CompanyContext, IpcHandle } from "./types";
import { isoDate, periodSchema } from "@shared/schemas";
import { aiAskSchema, aiDraftVoucherSchema, aiProviderInputSchema } from "@shared/ai";
import { companyDir } from "../paths";
import * as ai from "../services/ai";
import * as assistiveAutomation from "../services/assistiveAutomation";
import * as attachmentVault from "../services/attachmentVault";
import * as aiConversations from "../services/aiConversations";
import { requireDeviceSafetyControl } from "../services/deviceSafety";

const activeAiRequests = new Map<string, { controller: AbortController; companySlug: string }>();

function isCancellation(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /abort|cancel/i.test(error.message));
}

export interface AiHandlerContext {
  handle: IpcHandle;
  requireCompany: () => CompanyContext;
  actor: () => string;
}

export function registerAiHandlers({ handle, requireCompany, actor }: AiHandlerContext): void {
  handle("ai:getConfig", () => ai.getConfig(), "viewer");
  handle("ai:setConfig", (payload) => ai.setConfig(aiProviderInputSchema.parse(payload)), "owner");
  const requireAi = (): void =>
    requireDeviceSafetyControl("aiCopilot", "AI copilot is disabled on this device");
  handle("ai:testConnection", () => {
    requireAi();
    return ai.testConnection();
  }, "owner");
  handle("ai:contextPreview", (payload) => {
    requireAi();
    const { from, to, fields } = periodSchema.extend({
      fields: z.array(z.enum(["company", "period", "dashboard", "trial_balance", "receivables", "payables", "units"])).max(7).optional(),
    }).parse(payload);
    const company = requireCompany();
    return ai.contextPreview(company.db, company.info, from, to, fields);
  }, "viewer");
  handle("ai:ask", async (payload) => {
    requireAi();
    const input = aiAskSchema.parse(payload);
    const company = requireCompany();
    const requestId = input.requestId ?? randomUUID();
    if (activeAiRequests.has(requestId)) throw new Error("This AI request is already running");
    if (input.conversationId) {
      aiConversations.appendAiConversationMessage(company.db, {
        conversationId: input.conversationId,
        requestId,
        role: "user",
        content: input.prompt,
      });
    }
    const context = input.includeContext
      ? ai.selectedContext(company.db, company.info, input.from, input.to, input.contextFields)
      : null;
    const controller = new AbortController();
    activeAiRequests.set(requestId, { controller, companySlug: company.slug });
    try {
      const answer = await ai.ask(input.prompt, context, controller.signal);
      if (input.conversationId) {
        aiConversations.appendAiConversationMessage(company.db, {
          conversationId: input.conversationId,
          requestId,
          role: "assistant",
          content: answer.text,
          citations: answer.citations,
          provider: answer.provider,
          model: answer.model,
          usage: answer.usage,
        });
      }
      return { ...answer, requestId };
    } catch (error) {
      if (input.conversationId) {
        aiConversations.appendAiConversationMessage(company.db, {
          conversationId: input.conversationId,
          requestId,
          role: "assistant",
          content: isCancellation(error)
            ? "Request cancelled before an answer was completed."
            : "Request failed before an answer was completed.",
          status: isCancellation(error) ? "cancelled" : "failed",
        });
      }
      if (isCancellation(error)) throw new Error("AI request cancelled");
      throw error;
    } finally {
      activeAiRequests.delete(requestId);
    }
  }, "accountant");
  handle("ai:cancel", (payload) => {
    const { requestId } = z.object({ requestId: z.string().uuid() }).parse(payload);
    const company = requireCompany();
    const active = activeAiRequests.get(requestId);
    if (!active || active.companySlug !== company.slug) return { cancelled: false };
    active.controller.abort();
    return { cancelled: true };
  }, "accountant");
  handle("ai:conversations:list", () => aiConversations.listAiConversations(requireCompany().db), "accountant");
  handle("ai:conversations:create", (payload) => {
    const { title } = z.object({ title: z.string().trim().min(1).max(120) }).parse(payload);
    return aiConversations.createAiConversation(requireCompany().db, title, actor());
  }, "accountant");
  handle("ai:conversations:messages", (payload) => {
    const { conversationId } = z.object({ conversationId: z.string().uuid() }).parse(payload);
    return aiConversations.listAiConversationMessages(requireCompany().db, conversationId);
  }, "accountant");
  handle("ai:conversations:delete", (payload) => {
    const { conversationId } = z.object({ conversationId: z.string().uuid() }).parse(payload);
    return { deleted: aiConversations.deleteAiConversation(requireCompany().db, conversationId) };
  }, "accountant");
  handle("ai:conversations:deleteAll", () => ({
    deleted: aiConversations.deleteAllAiConversations(requireCompany().db),
  }), "owner");
  handle("ai:draftVoucher", async (payload) => {
    requireAi();
    const { prompt, shareMasterData, conversationId } = aiDraftVoucherSchema.parse(payload);
    const company = requireCompany();
    const proposal = await ai.draftVoucher(company.db, company.slug, prompt, shareMasterData);
    aiConversations.recordAiDraftAction(company.db, {
      conversationId,
      proposalId: proposal.id,
      prompt,
      explanation: "AI-generated voucher proposal. Review every ledger and amount before approval.",
      warnings: ["Nothing has been posted. Approval is required inside Total."],
    }, actor());
    return proposal;
  }, "accountant");
  handle("ai:documents:list", () => assistiveAutomation.listDocumentInbox(requireCompany().db), "viewer");
  handle("ai:documents:capture", async (payload) => {
    requireAi();
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
