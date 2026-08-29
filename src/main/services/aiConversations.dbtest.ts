import { describe, expect, it } from "vitest";
import { seededDb } from "../db/testdb";
import {
  appendAiConversationMessage,
  createAiConversation,
  deleteAiConversation,
  listAiConversationMessages,
  listAiConversations,
  recordAiDraftAction,
} from "./aiConversations";

describe("local AI conversation history", () => {
  it("persists bounded messages and usage, then deletes the complete conversation", () => {
    const db = seededDb();
    const conversation = createAiConversation(db, "  Cash position  ", "Asha");
    appendAiConversationMessage(db, { conversationId: conversation.id, requestId: "req-1", role: "user", content: "Explain cash." });
    appendAiConversationMessage(db, {
      conversationId: conversation.id,
      requestId: "req-1",
      role: "assistant",
      content: "Cash is available.",
      citations: [{ label: "Dashboard", uri: "total://gateway/dashboard" }],
      provider: "openai",
      model: "gpt-test",
      usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
    });
    expect(listAiConversations(db)[0]).toMatchObject({ id: conversation.id, title: "Cash position" });
    expect(listAiConversationMessages(db, conversation.id)[1]).toMatchObject({ usage: { totalTokens: 17 }, model: "gpt-test" });
    expect(deleteAiConversation(db, conversation.id)).toBe(true);
    expect(listAiConversations(db)).toEqual([]);
  });

  it("records an inert AI draft action without posting a voucher", () => {
    const db = seededDb();
    const conversation = createAiConversation(db, "Draft rent", "Asha");
    recordAiDraftAction(db, { conversationId: conversation.id, proposalId: "proposal-1", prompt: "Draft rent payment" }, "Asha");
    expect((db.prepare(`SELECT status FROM ai_draft_actions WHERE proposal_id='proposal-1'`).get() as { status: string }).status).toBe("proposed");
    expect((db.prepare(`SELECT COUNT(*) AS n FROM vouchers`).get() as { n: number }).n).toBe(0);
  });
});
