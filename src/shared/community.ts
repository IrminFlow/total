import { z } from "zod";

/** Normalize both the private Blob receipt (`id`) and provider-compatible receipt (`ideaId`). */
export function feedbackReceiptIdeaId(
  action: "submit" | "vote" | "follow",
  requestedIdeaId: string | null,
  payload: unknown,
): string {
  const receipt = z.object({
    ok: z.literal(true),
    id: z.string().max(80).optional(),
    ideaId: z.string().max(80).optional(),
  }).passthrough().parse(payload);
  const ideaId = action === "submit" ? receipt.ideaId ?? receipt.id : requestedIdeaId;
  if (!ideaId) throw new Error("The feedback service did not return a receipt");
  return ideaId;
}
