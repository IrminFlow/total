import { z } from "zod";

export const aiOperatorActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("navigate"), screen: z.string().trim().min(1).max(80), reason: z.string().trim().max(300) }),
  z.object({ kind: z.literal("search_books"), query: z.string().trim().min(1).max(200), reason: z.string().trim().max(300) }),
  z.object({ kind: z.literal("draft_voucher"), instruction: z.string().trim().min(8).max(4_000), reason: z.string().trim().max(300) }),
  z.object({ kind: z.literal("read_file"), path: z.string().trim().min(1).max(2_000), reason: z.string().trim().max(300) }),
  z.object({ kind: z.literal("write_file"), path: z.string().trim().min(1).max(2_000), content: z.string().max(1_000_000), reason: z.string().trim().max(300) }),
]);

export const aiOperatorPlanSchema = z.object({
  summary: z.string().trim().min(1).max(2_000),
  actions: z.array(aiOperatorActionSchema).max(20),
});

export type AiOperatorAction = z.infer<typeof aiOperatorActionSchema>;
export type AiOperatorPlan = z.infer<typeof aiOperatorPlanSchema>;

export interface AiOperatorConfig {
  enabled: boolean;
  approvalMode: "every_change" | "accounting_only";
  workspaceRoots: string[];
}

export interface AiOperatorActionResult {
  kind: AiOperatorAction["kind"];
  status: "completed" | "approval_required" | "proposal_created";
  message: string;
  data?: unknown;
}
