import { randomUUID } from "crypto";
import type { AiCitation, AiConversation, AiConversationMessage, AiUsage } from "@shared/ai";
import type { DB } from "../db/connection";

interface ConversationRow {
  id: string;
  title: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: number;
  conversation_id: string;
  request_id: string | null;
  role: "user" | "assistant";
  content: string;
  citations_json: string;
  provider: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  status: "completed" | "cancelled" | "failed";
  created_at: string;
}

function mapConversation(row: ConversationRow): AiConversation {
  return {
    id: row.id,
    title: row.title,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeCitations(raw: string): AiCitation[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is AiCitation =>
          !!item && typeof item === "object" && typeof (item as AiCitation).label === "string" && typeof (item as AiCitation).uri === "string",
        ).slice(0, 20)
      : [];
  } catch {
    return [];
  }
}

function mapMessage(row: MessageRow): AiConversationMessage {
  const usage = row.input_tokens === null && row.output_tokens === null && row.total_tokens === null
    ? null
    : {
        inputTokens: row.input_tokens ?? 0,
        outputTokens: row.output_tokens ?? 0,
        totalTokens: row.total_tokens ?? (row.input_tokens ?? 0) + (row.output_tokens ?? 0),
      };
  return {
    id: row.id,
    conversationId: row.conversation_id,
    requestId: row.request_id,
    role: row.role,
    content: row.content,
    citations: safeCitations(row.citations_json),
    provider: row.provider,
    model: row.model,
    usage,
    status: row.status,
    createdAt: row.created_at,
  };
}

export function listAiConversations(db: DB): AiConversation[] {
  return (db.prepare(`SELECT * FROM ai_conversations ORDER BY updated_at DESC,id DESC LIMIT 50`).all() as ConversationRow[]).map(mapConversation);
}

export function createAiConversation(db: DB, rawTitle: string, actor: string): AiConversation {
  const title = rawTitle.trim().replace(/\s+/g, " ").slice(0, 120) || "New conversation";
  const id = randomUUID();
  db.prepare(`INSERT INTO ai_conversations (id,title,created_by) VALUES (?,?,?)`).run(id, title, actor.trim() || "Local user");
  return mapConversation(db.prepare(`SELECT * FROM ai_conversations WHERE id=?`).get(id) as ConversationRow);
}

export function listAiConversationMessages(db: DB, conversationId: string): AiConversationMessage[] {
  if (!db.prepare(`SELECT 1 FROM ai_conversations WHERE id=?`).get(conversationId)) throw new Error("AI conversation not found");
  return (db.prepare(`SELECT * FROM ai_conversation_messages WHERE conversation_id=? ORDER BY id LIMIT 200`).all(conversationId) as MessageRow[]).map(mapMessage);
}

export function appendAiConversationMessage(
  db: DB,
  input: {
    conversationId: string;
    requestId?: string | null;
    role: "user" | "assistant";
    content: string;
    citations?: AiCitation[];
    provider?: string | null;
    model?: string | null;
    usage?: AiUsage | null;
    status?: "completed" | "cancelled" | "failed";
  },
): AiConversationMessage {
  const content = input.content.trim().slice(0, 20_000);
  if (!content) throw new Error("AI conversation messages cannot be empty");
  const insert = db.transaction(() => {
    if (!db.prepare(`SELECT 1 FROM ai_conversations WHERE id=?`).get(input.conversationId)) throw new Error("AI conversation not found");
    const result = db.prepare(`INSERT INTO ai_conversation_messages
      (conversation_id,request_id,role,content,citations_json,provider,model,input_tokens,output_tokens,total_tokens,status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
        input.conversationId,
        input.requestId ?? null,
        input.role,
        content,
        JSON.stringify(input.citations ?? []),
        input.provider ?? null,
        input.model ?? null,
        input.usage?.inputTokens ?? null,
        input.usage?.outputTokens ?? null,
        input.usage?.totalTokens ?? null,
        input.status ?? "completed",
      );
    db.prepare(`UPDATE ai_conversations SET updated_at=datetime('now') WHERE id=?`).run(input.conversationId);
    return Number(result.lastInsertRowid);
  });
  const id = insert();
  return mapMessage(db.prepare(`SELECT * FROM ai_conversation_messages WHERE id=?`).get(id) as MessageRow);
}

export function deleteAiConversation(db: DB, id: string): boolean {
  return db.prepare(`DELETE FROM ai_conversations WHERE id=?`).run(id).changes > 0;
}

export function deleteAllAiConversations(db: DB): number {
  return db.prepare(`DELETE FROM ai_conversations`).run().changes;
}

export function recordAiDraftAction(
  db: DB,
  input: { conversationId?: string | null; proposalId: string; prompt: string; explanation?: string; warnings?: string[] },
  actor: string,
): number {
  return Number(db.prepare(`INSERT INTO ai_draft_actions
    (conversation_id,proposal_id,action_kind,source_prompt,explanation,warnings_json,created_by)
    VALUES (?,?, 'voucher', ?,?,?,?)`).run(
      input.conversationId ?? null,
      input.proposalId,
      input.prompt.trim().slice(0, 4_000),
      input.explanation?.trim().slice(0, 4_000) ?? "",
      JSON.stringify((input.warnings ?? []).slice(0, 50)),
      actor.trim() || "Local user",
    ).lastInsertRowid);
}
