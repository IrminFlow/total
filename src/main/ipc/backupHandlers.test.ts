import { describe, expect, it, vi } from "vitest";
import { registerBackupHandlers } from "./backupHandlers";
import type { CompanyContext, IpcHandle, IpcHandler } from "./types";

function setup(): {
  handlers: Map<string, IpcHandler>;
  requireCompany: ReturnType<typeof vi.fn>;
  chooseDestination: ReturnType<typeof vi.fn>;
} {
  const handlers = new Map<string, IpcHandler>();
  const handle: IpcHandle = (channel, handler) => handlers.set(channel, handler);
  const requireCompany = vi.fn(() => ({
    slug: "books",
    db: {},
    info: {},
  }) as CompanyContext);
  const chooseDestination = vi.fn(async () => "/safe/backups");
  registerBackupHandlers({
    handle,
    requireCompany,
    actor: () => "Owner",
    chooseDestination,
    backupCompany: vi.fn(async () => "/safe/manual.db") as never,
    companyBackupsDir: vi.fn(() => "/safe/company-backups") as never,
    inspectBackup: vi.fn(() => ({ valid: true })) as never,
    listBackupsIn: vi.fn(() => []) as never,
    resilience: {
      addBackupDestination: vi.fn(),
      backupSpaceForecast: vi.fn(),
      getRotationPolicy: vi.fn(),
      listBackupDestinations: vi.fn(() => []),
      listRecoveryDrills: vi.fn(() => []),
      recoveryDrillDue: vi.fn(() => false),
      replicateBackup: vi.fn(() => []),
      runRecoveryDrill: vi.fn(),
      setBackupDestinationActive: vi.fn(),
      setRotationPolicy: vi.fn(),
    } as never,
  });
  return { handlers, requireCompany, chooseDestination };
}

describe("backup IPC handlers", () => {
  it("keeps the legacy manual-backup alias on the exact same handler", () => {
    const { handlers } = setup();
    expect(handlers.get("company:backup")).toBe(handlers.get("backup:run"));
  });

  it("validates destination input before opening a chooser or reading company state", async () => {
    const { handlers, requireCompany, chooseDestination } = setup();
    await expect(
      handlers.get("backup:destinations:add")!({ name: "x" }),
    ).rejects.toThrow();
    expect(chooseDestination).not.toHaveBeenCalled();
    expect(requireCompany).not.toHaveBeenCalled();
  });

  it("validates drill, rotation and preview payloads before reading company state", () => {
    const { handlers, requireCompany } = setup();
    expect(() =>
      handlers.get("backup:drills:run")!({ destinationId: 0 }),
    ).toThrow();
    expect(() =>
      handlers.get("backup:rotation:set")!({
        dailyCount: 0,
        weeklyCount: 1,
        monthlyCount: 1,
        yearEndCount: 1,
      }),
    ).toThrow();
    expect(() =>
      handlers.get("backup:preview")!({ file: "../company.db" }),
    ).toThrow();
    expect(requireCompany).not.toHaveBeenCalled();
  });
});
