import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openCompanyDb, type DB } from "../db/connection";
import { LocalCollaborationRelay } from "../testing/localCollaborationRelay";
import {
  encryptCollaborationDocument,
  generateCollaborationKeyMaterial,
  type CollaborationKeyMaterial,
} from "./collaborationCrypto";
import type { CollaborationCredentials } from "./collaborationCredentials";

const mocked = vi.hoisted(() => ({ credentials: new Map<string, CollaborationCredentials>() }));
vi.mock("./collaborationCredentials", () => ({
  readCollaborationCredentials: (slug: string) => mocked.credentials.get(slug) ?? null,
  normalizedCollaborationEndpoint: (endpoint: string) => endpoint.replace(/\/$/, ""),
}));

import {
  getCollaborationSyncStatus,
  listCollaborationRecords,
  publishCollaborationChange,
  runCollaborationSync,
} from "./collaborationSync";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let root: string;
const databases: DB[] = [];

function credentials(token: string, keys: CollaborationKeyMaterial): CollaborationCredentials {
  return {
    enabled: true,
    endpoint: "http://localhost",
    workspaceId: WORKSPACE,
    apiToken: token,
    deviceId: randomUUID(),
    keys,
  };
}

function database(slug: string): DB {
  const db = openCompanyDb(slug);
  databases.push(db);
  return db;
}

function incomingCount(db: DB): number {
  return (db.prepare("SELECT COUNT(*) value FROM sync_envelopes WHERE direction='incoming'").get() as { value: number }).value;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "total-collaboration-"));
  process.env.TOTAL_DATA_DIR = root;
  mocked.credentials.clear();
});

afterEach(() => {
  while (databases.length) databases.pop()!.close();
  delete process.env.TOTAL_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe("encrypted collaboration service against the local relay", () => {
  it("preserves the outbox on failure, retries, and delivers after the source app closes", async () => {
    const relay = new LocalCollaborationRelay();
    const tokenA = relay.registerUser(USER_A);
    const tokenB = relay.registerUser(USER_B);
    const sharedKey = generateCollaborationKeyMaterial().encryptionKey;
    const keysA = { ...generateCollaborationKeyMaterial(), encryptionKey: sharedKey };
    const keysB = { ...generateCollaborationKeyMaterial(), encryptionKey: sharedKey };
    mocked.credentials.set("device-a", credentials(tokenA, keysA));
    mocked.credentials.set("device-b", credentials(tokenB, keysB));
    const dbA = database("device-a");
    publishCollaborationChange(dbA, "device-a", {
      entityKind: "task", entityId: "month-close", patch: { title: "Close August" },
    });

    const offlineFetch: typeof fetch = async () => { throw new Error("network offline"); };
    await expect(runCollaborationSync(dbA, "device-a", offlineFetch)).rejects.toThrow("network offline");
    expect(getCollaborationSyncStatus(dbA, "device-a")).toMatchObject({ pending: 1, cursor: null, lastError: "network offline" });

    await runCollaborationSync(dbA, "device-a", relay.fetch);
    expect(getCollaborationSyncStatus(dbA, "device-a")).toMatchObject({ pending: 0, cursor: "1", lastError: null });
    dbA.close();
    databases.splice(databases.indexOf(dbA), 1);

    // The relay is durable and does not depend on a running source application.
    const inviteResponse = await relay.fetch(`http://localhost/v1/workspaces/${WORKSPACE}/invitations`, {
      method: "POST", headers: { authorization: `Bearer ${tokenA}` }, body: JSON.stringify({ expiresInHours: 24 }),
    });
    const invitation = await inviteResponse.json() as { invitationCode: string };
    await relay.fetch("http://localhost/v1/invitations/accept", {
      method: "POST", headers: { authorization: `Bearer ${tokenB}` }, body: JSON.stringify(invitation),
    });
    const dbB = database("device-b");
    await runCollaborationSync(dbB, "device-b", relay.fetch);
    expect(listCollaborationRecords(dbB)[0]?.fields.title?.value).toBe("Close August");
  });

  it("converges concurrent offline edits, records visible conflicts, and ignores replayed duplicates", async () => {
    const relay = new LocalCollaborationRelay();
    const tokenA = relay.registerUser(USER_A);
    const tokenB = relay.registerUser(USER_B);
    const sharedKey = generateCollaborationKeyMaterial().encryptionKey;
    mocked.credentials.set("device-a", credentials(tokenA, { ...generateCollaborationKeyMaterial(), encryptionKey: sharedKey }));
    mocked.credentials.set("device-b", credentials(tokenB, { ...generateCollaborationKeyMaterial(), encryptionKey: sharedKey }));
    const dbA = database("device-a");
    const dbB = database("device-b");

    publishCollaborationChange(dbA, "device-a", { entityKind: "task", entityId: "review", patch: { title: "Review" } });
    await runCollaborationSync(dbA, "device-a", relay.fetch);
    const createInvite = await relay.fetch(`http://localhost/v1/workspaces/${WORKSPACE}/invitations`, {
      method: "POST", headers: { authorization: `Bearer ${tokenA}` }, body: JSON.stringify({ expiresInHours: 24 }),
    });
    const invite = await createInvite.json() as { invitationCode: string };
    await relay.fetch("http://localhost/v1/invitations/accept", {
      method: "POST", headers: { authorization: `Bearer ${tokenB}` }, body: JSON.stringify(invite),
    });
    await runCollaborationSync(dbB, "device-b", relay.fetch);

    publishCollaborationChange(dbA, "device-a", { entityKind: "task", entityId: "review", patch: { title: "Review sales" } });
    publishCollaborationChange(dbB, "device-b", { entityKind: "task", entityId: "review", patch: { title: "Review purchases" } });
    await runCollaborationSync(dbA, "device-a", relay.fetch);
    await runCollaborationSync(dbB, "device-b", relay.fetch);
    await runCollaborationSync(dbA, "device-a", relay.fetch);

    expect(listCollaborationRecords(dbA)).toEqual(listCollaborationRecords(dbB));
    expect(getCollaborationSyncStatus(dbA, "device-a").conflicts).toBe(1);
    expect(getCollaborationSyncStatus(dbB, "device-b").conflicts).toBe(1);
    const beforeReplay = incomingCount(dbA);
    const replayFetch: typeof fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if ((init?.method ?? "GET") === "GET") url.searchParams.set("cursor", "0");
      return relay.fetch(url, init);
    };
    await runCollaborationSync(dbA, "device-a", replayFetch);
    expect(incomingCount(dbA)).toBe(beforeReplay);
    expect(getCollaborationSyncStatus(dbA, "device-a").conflicts).toBe(1);

    // An explicit edit made after the conflict carries the merged vector clock and is the
    // resolution. It clears the visible conflict on this device and on peers after sync.
    publishCollaborationChange(dbA, "device-a", {
      entityKind: "task", entityId: "review", patch: { title: "Review sales and purchases" },
    });
    expect(getCollaborationSyncStatus(dbA, "device-a").conflicts).toBe(0);
    await runCollaborationSync(dbA, "device-a", relay.fetch);
    await runCollaborationSync(dbB, "device-b", relay.fetch);
    expect(getCollaborationSyncStatus(dbB, "device-b").conflicts).toBe(0);
    expect(listCollaborationRecords(dbB)[0]?.fields.title?.value).toBe("Review sales and purchases");
  });

  it("rejects corrupt signatures without advancing the cursor", async () => {
    const relay = new LocalCollaborationRelay();
    const tokenA = relay.registerUser(USER_A);
    const sharedKey = generateCollaborationKeyMaterial().encryptionKey;
    const keysA = { ...generateCollaborationKeyMaterial(), encryptionKey: sharedKey };
    const keysB = { ...generateCollaborationKeyMaterial(), encryptionKey: sharedKey };
    mocked.credentials.set("device-a", credentials(tokenA, keysA));
    const dbA = database("device-a");
    publishCollaborationChange(dbA, "device-a", { entityKind: "comment", entityId: "safe", patch: { body: "safe" } });
    await runCollaborationSync(dbA, "device-a", relay.fetch);
    expect(getCollaborationSyncStatus(dbA, "device-a").cursor).toBe("1");

    const deviceB = randomUUID();
    const corrupt = encryptCollaborationDocument({
      workspaceId: WORKSPACE, envelopeId: randomUUID(), deviceId: deviceB, sequence: 1,
      createdAt: "2026-08-28T08:00:00.000Z",
      document: {
        entityKind: "comment", entityId: "hostile", fields: {
          body: { value: "tampered", clock: { [deviceB]: 1 }, updatedAt: "2026-08-28T08:00:00.000Z", deviceId: deviceB },
        }, clock: { [deviceB]: 1 }, deleted: false,
      },
      keys: keysB,
    });
    const changed = corrupt.signature[5] === "A" ? "B" : "A";
    corrupt.signature = `${corrupt.signature.slice(0, 5)}${changed}${corrupt.signature.slice(6)}`;
    relay.injectEnvelope(WORKSPACE, corrupt);
    await expect(runCollaborationSync(dbA, "device-a", relay.fetch)).rejects.toThrow("signature");
    expect(getCollaborationSyncStatus(dbA, "device-a").cursor).toBe("1");
    expect(listCollaborationRecords(dbA).some((record) => record.entityId === "hostile")).toBe(false);
  });

  it("rejects oversized declared and streamed responses", async () => {
    const token = "token-a";
    const keys = generateCollaborationKeyMaterial();
    mocked.credentials.set("device-a", credentials(token, keys));
    const db = database("device-a");
    const declaredOversize: typeof fetch = async () => new Response("{}", {
      status: 200, headers: { "content-length": String(2 * 1024 * 1024 + 1) },
    });
    await expect(runCollaborationSync(db, "device-a", declaredOversize)).rejects.toThrow("2 MB");
    const streamedOversize: typeof fetch = async () => new Response(JSON.stringify({ padding: "x".repeat(2 * 1024 * 1024) }), { status: 200 });
    await expect(runCollaborationSync(db, "device-a", streamedOversize)).rejects.toThrow("2 MB");
    expect(getCollaborationSyncStatus(db, "device-a").cursor).toBeNull();
  });
});
