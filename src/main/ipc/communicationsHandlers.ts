import { z } from "zod";
import {
  acceptanceResolutionSchema,
  communicationBatchCreateSchema,
  communicationBatchQueueSchema,
  communicationBatchStatusSchema,
  outboundDraftInputSchema,
  outboundDraftUpdateSchema,
  outboundMessageStatusSchema,
  partyContactInputSchema,
  smtpProfileInputSchema,
  smtpProfileUpdateSchema,
} from "@shared/communications";
import * as communications from "../services/communications";
import * as communicationBatches from "../services/communicationBatches";
import type { CompanyContext, IpcHandle } from "./types";
import type { SessionUser } from "./authHandlers";

interface CommunicationsHandlerContext {
  handle: IpcHandle;
  requireCompany: () => CompanyContext;
  actor: () => string;
  getSessionUser: () => SessionUser | null;
  chooseEmlDestination: (suggestedFileName: string) => Promise<string | null>;
}

const positiveId = z.number().int().positive();
const messageId = z.string().uuid();

export function registerCommunicationsHandlers({
  handle,
  requireCompany,
  actor,
  getSessionUser,
  chooseEmlDestination,
}: CommunicationsHandlerContext): void {
  handle(
    "communications:contacts:list",
    (payload) => {
      const input = z
        .object({
          ledgerId: positiveId,
          includeInactive: z.boolean().optional(),
        })
        .strict()
        .parse(payload);
      return communications.listPartyContacts(
        requireCompany().db,
        input.ledgerId,
        input.includeInactive,
      );
    },
    "viewer",
  );
  handle("communications:contacts:save", (payload) => {
    const input = z
      .object({ id: positiveId.optional(), data: partyContactInputSchema })
      .strict()
      .parse(payload);
    return communications.savePartyContact(
      requireCompany().db,
      input.data,
      actor(),
      input.id,
    );
  });
  handle("communications:contacts:delete", (payload) => {
    const input = z.object({ id: positiveId }).strict().parse(payload);
    return communications.deletePartyContact(requireCompany().db, input.id);
  });

  handle(
    "communications:smtp:list",
    () => communications.listSmtpProfiles(requireCompany().db),
    "owner",
  );
  handle(
    "communications:smtp:create",
    (payload) => {
      const input = smtpProfileInputSchema.parse(payload);
      return communications.createSmtpProfile(
        requireCompany().db,
        input,
        actor(),
      );
    },
    "owner",
  );
  handle(
    "communications:smtp:update",
    (payload) => {
      const input = z
        .object({ id: positiveId, data: smtpProfileUpdateSchema })
        .strict()
        .parse(payload);
      return communications.updateSmtpProfile(
        requireCompany().db,
        input.id,
        input.data,
      );
    },
    "owner",
  );
  handle(
    "communications:smtp:delete",
    (payload) => {
      const input = z.object({ id: positiveId }).strict().parse(payload);
      return communications.deleteSmtpProfile(requireCompany().db, input.id);
    },
    "owner",
  );
  handle(
    "communications:smtp:test",
    (payload) => {
      const input = z.object({ id: positiveId }).strict().parse(payload);
      return communications.testSmtpProfile(requireCompany().db, input.id);
    },
    "owner",
  );

  handle(
    "communications:messages:list",
    (payload) => {
      const input = z
        .object({
          ledgerId: positiveId.optional(),
          status: outboundMessageStatusSchema.optional(),
          limit: z.number().int().min(1).max(500).optional(),
        })
        .strict()
        .default({})
        .parse(payload);
      return communications.listOutboundMessages(requireCompany().db, input);
    },
    "viewer",
  );
  handle(
    "communications:messages:get",
    (payload) => {
      const input = z.object({ id: messageId }).strict().parse(payload);
      return communications.getOutboundMessage(requireCompany().db, input.id);
    },
    "viewer",
  );
  handle(
    "communications:messages:events",
    (payload) => {
      const input = z.object({ id: messageId }).strict().parse(payload);
      return communications.listMessageEvents(requireCompany().db, input.id);
    },
    "viewer",
  );
  handle("communications:messages:createDraft", (payload) => {
    const input = outboundDraftInputSchema.parse(payload);
    return communications.createOutboundDraft(
      requireCompany().db,
      input,
      actor(),
    );
  });
  handle("communications:messages:updateDraft", (payload) => {
    const input = z
      .object({ id: messageId, data: outboundDraftUpdateSchema })
      .strict()
      .parse(payload);
    return communications.updateOutboundDraft(
      requireCompany().db,
      input.id,
      input.data,
      actor(),
    );
  });
  handle("communications:messages:review", (payload) => {
    const input = z
      .object({ id: messageId, expectedRevision: positiveId })
      .strict()
      .parse(payload);
    return communications.reviewOutboundMessage(
      requireCompany().db,
      input.id,
      input.expectedRevision,
      actor(),
    );
  });
  handle("communications:messages:queue", (payload) => {
    const input = z
      .object({ id: messageId, smtpProfileId: positiveId })
      .strict()
      .parse(payload);
    return communications.queueOutboundMessage(
      requireCompany().db,
      input.id,
      input.smtpProfileId,
      actor(),
    );
  });
  handle("communications:messages:deliver", (payload) => {
    const input = z.object({ id: messageId }).strict().parse(payload);
    return communications.deliverOutboundMessage(
      requireCompany().db,
      input.id,
      actor(),
    );
  });
  handle("communications:messages:resolveAcceptance", (payload) => {
    const input = z
      .object({ id: messageId, resolution: acceptanceResolutionSchema })
      .strict()
      .parse(payload);
    return communications.resolveUnknownAcceptance(
      requireCompany().db,
      input.id,
      input.resolution,
      actor(),
    );
  });
  handle("communications:messages:cancel", (payload) => {
    const input = z.object({ id: messageId }).strict().parse(payload);
    return communications.cancelOutboundMessage(
      requireCompany().db,
      input.id,
      actor(),
    );
  });
  handle("communications:messages:exportEml", async (payload) => {
    const input = z
      .object({
        id: messageId,
        smtpProfileId: positiveId.optional(),
      })
      .strict()
      .parse(payload);
    const destinationPath = await chooseEmlDestination(
      `Total-message-${input.id}.eml`,
    );
    if (destinationPath === null) return null;
    return communications.exportMessageEml(
      requireCompany().db,
      input.id,
      destinationPath,
      actor(),
      input.smtpProfileId,
    );
  });

  const batchActor = () => {
    const user = getSessionUser();
    return user
      ? { id: user.id, name: user.name }
      : { id: null, name: actor() };
  };
  handle(
    "communications:batches:list",
    (payload) => {
      const input = z
        .object({
          status: communicationBatchStatusSchema.optional(),
          limit: z.number().int().min(1).max(200).optional(),
        })
        .strict()
        .default({})
        .parse(payload);
      return communicationBatches.listCommunicationBatches(
        requireCompany().db,
        input.status,
        input.limit,
      );
    },
    "viewer",
  );
  handle(
    "communications:batches:get",
    (payload) => {
      const input = z.object({ id: messageId }).strict().parse(payload);
      return communicationBatches.getCommunicationBatch(
        requireCompany().db,
        input.id,
      );
    },
    "viewer",
  );
  handle(
    "communications:batches:events",
    (payload) => {
      const input = z.object({ id: messageId }).strict().parse(payload);
      return communicationBatches.listCommunicationBatchEvents(
        requireCompany().db,
        input.id,
      );
    },
    "viewer",
  );
  handle("communications:batches:create", (payload) => {
    const input = communicationBatchCreateSchema.parse(payload);
    return communicationBatches.createCommunicationBatch(
      requireCompany().db,
      input,
      batchActor(),
    );
  });
  handle("communications:batches:approve", (payload) => {
    const input = z
      .object({
        id: messageId,
        note: z.string().trim().min(3).max(500).nullable().default(null),
      })
      .strict()
      .parse(payload);
    return communicationBatches.approveCommunicationBatch(
      requireCompany().db,
      input.id,
      batchActor(),
      input.note,
    );
  });
  handle("communications:batches:reject", (payload) => {
    const input = z
      .object({ id: messageId, note: z.string().trim().min(3).max(500) })
      .strict()
      .parse(payload);
    return communicationBatches.rejectCommunicationBatch(
      requireCompany().db,
      input.id,
      batchActor(),
      input.note,
    );
  });
  handle("communications:batches:enqueue", (payload) => {
    const input = communicationBatchQueueSchema.parse(payload);
    return communicationBatches.enqueueCommunicationBatch(
      requireCompany().db,
      input.id,
      input.smtpProfileId,
      batchActor(),
      input.itemIds,
    );
  });
  handle("communications:batches:cancel", (payload) => {
    const input = z.object({ id: messageId }).strict().parse(payload);
    return communicationBatches.cancelCommunicationBatch(
      requireCompany().db,
      input.id,
      batchActor(),
    );
  });
}
