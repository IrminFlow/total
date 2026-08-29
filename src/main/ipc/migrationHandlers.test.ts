import { beforeEach, describe, expect, it, vi } from "vitest";

const { exportMigrationCertificate, showItemInFolder } = vi.hoisted(() => ({
  exportMigrationCertificate: vi.fn(),
  showItemInFolder: vi.fn(),
}));

vi.mock("electron", () => ({
  dialog: { showOpenDialog: vi.fn() },
  shell: { showItemInFolder },
}));
vi.mock("../db/connection", () => ({ backupCompany: vi.fn() }));
vi.mock("../services/migrationCertificate", () => ({
  exportMigrationCertificate,
}));

import { registerMigrationHandlers } from "./migrationHandlers";
import type { CompanyContext, IpcHandle, IpcHandler } from "./types";
import type { Role } from "../services/roles";

describe("migration IPC handlers", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps certificate export owner-only and validates before reading company state", async () => {
    const handlers = new Map<string, IpcHandler>();
    const roles = new Map<string, Role | undefined>();
    const handle: IpcHandle = (channel, handler, role) => {
      handlers.set(channel, handler);
      roles.set(channel, role);
    };
    const requireCompany = vi.fn(
      () =>
        ({
          slug: "books",
          db: {},
          info: { name: "Books" },
        }) as never,
    );
    registerMigrationHandlers({ handle, requireCompany, actor: () => "Owner" });

    expect(roles.get("export:migrationCertificate")).toBe("owner");
    await expect(
      handlers.get("export:migrationCertificate")!({ batchId: 0 }),
    ).rejects.toThrow();
    await expect(
      handlers.get("export:migrationCertificate")!({ batchId: 1, extra: true }),
    ).rejects.toThrow();
    expect(requireCompany).not.toHaveBeenCalled();
    expect(exportMigrationCertificate).not.toHaveBeenCalled();
  });

  it("exports the exact selected batch and reveals the JSON certificate", async () => {
    const handlers = new Map<string, IpcHandler>();
    const handle: IpcHandle = (channel, handler) =>
      handlers.set(channel, handler);
    const company = {
      slug: "books",
      db: {},
      info: { name: "Books" },
    } as unknown as CompanyContext;
    exportMigrationCertificate.mockResolvedValue({
      jsonPath: "/exports/batch-7.json",
      pdfPath: "/exports/batch-7.pdf",
      contentSha256: "a".repeat(64),
      status: "internal_checks_passed",
    });
    registerMigrationHandlers({
      handle,
      requireCompany: () => company,
      actor: () => "Owner",
    });

    const result = await handlers.get("export:migrationCertificate")!({
      batchId: 7,
    });
    expect(exportMigrationCertificate).toHaveBeenCalledWith(
      company.db,
      company.info,
      "books",
      7,
      "Owner",
    );
    expect(showItemInFolder).toHaveBeenCalledWith("/exports/batch-7.json");
    expect(result).toMatchObject({ status: "internal_checks_passed" });
  });
});
