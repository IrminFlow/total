import { z } from "zod";
import {
  collaborationPublishSchema,
  invitationAcceptSchema,
  syncConfigureSchema,
} from "@shared/collaborationSync";
import * as credentials from "../services/collaborationCredentials";
import * as collaboration from "../services/collaborationSync";
import type { CompanyContext, IpcHandle } from "./types";

interface CollaborationHandlerContext {
  handle: IpcHandle;
  requireCompany: () => CompanyContext;
}

export function registerCollaborationHandlers({
  handle,
  requireCompany,
}: CollaborationHandlerContext): void {
  handle("collaboration:status", () => {
    const company = requireCompany();
    return collaboration.getCollaborationSyncStatus(company.db, company.slug);
  }, "viewer");
  handle("collaboration:configure", (payload) => {
    const company = requireCompany();
    const configured = credentials.configureCollaborationCredentials(
      company.slug,
      syncConfigureSchema.parse(payload),
    );
    return {
      createdRecoveryKey: configured.createdRecoveryKey,
      status: collaboration.getCollaborationSyncStatus(company.db, company.slug),
    };
  }, "owner");
  handle("collaboration:setEnabled", (payload) => {
    const company = requireCompany();
    const { enabled } = z.object({ enabled: z.boolean() }).parse(payload);
    credentials.setCollaborationEnabled(company.slug, enabled);
    return collaboration.getCollaborationSyncStatus(company.db, company.slug);
  }, "owner");
  handle("collaboration:disconnect", () => {
    const company = requireCompany();
    credentials.removeCollaborationCredentials(company.slug);
    return collaboration.getCollaborationSyncStatus(company.db, company.slug);
  }, "owner");
  handle("collaboration:recoveryKey", () => {
    const company = requireCompany();
    return { recoveryKey: credentials.exportCollaborationRecoveryKey(company.slug) };
  }, "owner");
  handle("collaboration:sync", async () => {
    const company = requireCompany();
    return collaboration.runCollaborationSync(company.db, company.slug);
  }, "owner");
  handle("collaboration:records", (payload) => {
    const { includeDeleted } = z.object({ includeDeleted: z.boolean().default(false) }).parse(payload ?? {});
    return collaboration.listCollaborationRecords(requireCompany().db, includeDeleted);
  }, "viewer");
  handle("collaboration:publish", (payload) => {
    const company = requireCompany();
    return collaboration.publishCollaborationChange(
      company.db,
      company.slug,
      collaborationPublishSchema.parse(payload),
    );
  }, "accountant");
  handle("collaboration:invitations:list", () =>
    collaboration.listTeamInvitations(requireCompany().slug), "owner");
  handle("collaboration:invitations:create", (payload) => {
    const { expiresInHours } = z.object({
      expiresInHours: z.number().int().min(1).max(720),
    }).parse(payload);
    return collaboration.createTeamInvitation(requireCompany().slug, expiresInHours);
  }, "owner");
  handle("collaboration:invitations:revoke", (payload) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(payload);
    return collaboration.revokeTeamInvitation(requireCompany().slug, id);
  }, "owner");
  handle("collaboration:invitations:accept", async (payload) => {
    const company = requireCompany();
    const accepted = await collaboration.acceptTeamInvitation(invitationAcceptSchema.parse(payload));
    const configured = credentials.configureCollaborationCredentials(company.slug, {
      endpoint: accepted.endpoint,
      workspaceId: accepted.workspaceId,
      apiToken: accepted.apiToken,
      recoveryKey: accepted.recoveryKey,
      enabled: true,
    });
    return collaboration.getCollaborationSyncStatus(company.db, company.slug);
  }, "owner");
}
