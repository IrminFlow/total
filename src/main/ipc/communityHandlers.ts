import { app } from "electron";
import { z } from "zod";
import type { IpcHandle } from "./types";
import { feedbackReceiptIdeaId } from "@shared/community";

const feedbackActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("submit"),
    title: z.string().trim().min(5).max(120),
    detail: z.string().trim().min(10).max(2000),
    email: z.string().trim().email().max(200).or(z.literal("")),
  }),
  z.object({
    action: z.literal("vote"),
    ideaId: z.string().trim().regex(/^[A-Za-z0-9_-]{3,80}$/),
  }),
  z.object({
    action: z.literal("follow"),
    ideaId: z.string().trim().regex(/^[A-Za-z0-9_-]{3,80}$/),
    email: z.string().trim().email().max(200),
  }),
]);

export function registerCommunityHandlers(handle: IpcHandle): void {
  handle("community:feedback:list", async () => {
    const response = await fetch("https://devjindal.tech/api/feedback", {
      headers: { "user-agent": `Total/${app.getVersion()}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("The feedback board is unavailable offline");
    const parsed = z.object({
      ideas: z.array(z.object({
        id: z.string().max(80),
        title: z.string().max(120),
        detail: z.string().max(1000),
        status: z.enum(["considering", "planned", "building", "released"]),
        votes: z.number().int().min(0),
        releaseVersion: z.string().max(30).nullable().default(null),
      })).max(100),
    }).parse(await response.json());
    return parsed.ideas;
  }, "viewer");

  handle("community:feedback:action", async (payload) => {
    const input = feedbackActionSchema.parse(payload);
    const response = await fetch("https://devjindal.tech/api/feedback", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": `Total/${app.getVersion()}`,
      },
      body: JSON.stringify({ ...input, source: "app" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("The feedback board could not be updated");
    const ideaId = feedbackReceiptIdeaId(input.action, "ideaId" in input ? input.ideaId : null, await response.json());
    return { ok: true as const, ideaId };
  }, "viewer");

  handle("community:cohort:submit", async (payload) => {
    const input = z.object({
      schema: z.literal(1),
      installationId: z.string().regex(/^[a-z0-9]{8,40}$/),
      activatedMonth: z.string().regex(/^\d{4}-\d{2}$/),
      appVersion: z.string().max(30),
      platform: z.string().max(30),
      events: z.array(z.object({
        name: z.enum(["company_created", "first_voucher_posted", "first_backup_verified", "first_register_opened", "week_1_return", "month_1_return"]),
        count: z.number().int().min(1).max(10_000),
        firstAt: z.string().datetime(),
        lastAt: z.string().datetime(),
      })).max(6),
    }).strict().parse(payload);
    const response = await fetch("https://devjindal.tech/api/cohort", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": `Total/${app.getVersion()}`,
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("Product insights could not be sent");
    return { ok: true as const };
  }, "viewer");
}
