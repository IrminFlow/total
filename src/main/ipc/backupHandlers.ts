import { join } from "path";
import { z } from "zod";
import { backupFileSchema } from "@shared/schemas";
import type { backupCompany as BackupCompany } from "../db/connection";
import type {
  inspectBackup as InspectBackup,
  listBackupsIn as ListBackupsIn,
} from "../db/backup";
import type { companyBackupsDir as CompanyBackupsDir } from "../paths";
import type * as Resilience from "../services/resilience";
import type { CompanyContext, IpcHandle } from "./types";

interface BackupHandlerDependencies {
  handle: IpcHandle;
  requireCompany: () => CompanyContext;
  actor: () => string;
  chooseDestination: () => Promise<string | null>;
  backupCompany: typeof BackupCompany;
  companyBackupsDir: typeof CompanyBackupsDir;
  inspectBackup: typeof InspectBackup;
  listBackupsIn: typeof ListBackupsIn;
  resilience: Pick<
    typeof Resilience,
    | "addBackupDestination"
    | "backupSpaceForecast"
    | "getRotationPolicy"
    | "listBackupDestinations"
    | "listRecoveryDrills"
    | "recoveryDrillDue"
    | "replicateBackup"
    | "runRecoveryDrill"
    | "setBackupDestinationActive"
    | "setRotationPolicy"
  >;
}

const destinationNameSchema = z.object({
  name: z.string().trim().min(2).max(80),
});

const destinationStateSchema = z.object({
  id: z.number().int().positive(),
  active: z.boolean(),
});

const drillSchema = z.object({
  destinationId: z.number().int().positive().nullable().optional(),
});

const rotationSchema = z.object({
  dailyCount: z.number().int().min(1).max(365),
  weeklyCount: z.number().int().min(0).max(104),
  monthlyCount: z.number().int().min(0).max(120),
  yearEndCount: z.number().int().min(0).max(25),
});

/** Register verified snapshot, destination, drill and tiered-retention IPC handlers. */
export function registerBackupHandlers({
  handle,
  requireCompany,
  actor,
  chooseDestination,
  backupCompany,
  companyBackupsDir,
  inspectBackup,
  listBackupsIn,
  resilience,
}: BackupHandlerDependencies): void {
  const runManualBackup = async (): Promise<{
    path: string;
    copies: ReturnType<typeof resilience.replicateBackup>;
  }> => {
    const company = requireCompany();
    const path = await backupCompany(company.db, company.slug, "manual");
    return {
      path,
      copies: resilience.replicateBackup(company.db, company.slug, path),
    };
  };

  // Kept as an alias for existing renderer and integration callers.
  handle("company:backup", runManualBackup);
  handle("backup:run", runManualBackup);

  handle(
    "backup:list",
    () => {
      const company = requireCompany();
      return listBackupsIn(companyBackupsDir(company.slug));
    },
    "viewer",
  );

  handle(
    "backup:destinations:list",
    () => resilience.listBackupDestinations(requireCompany().db),
    "viewer",
  );
  handle(
    "backup:destinations:add",
    async (payload) => {
      const { name } = destinationNameSchema.parse(payload);
      const destination = await chooseDestination();
      if (!destination) return null;
      return resilience.addBackupDestination(
        requireCompany().db,
        name,
        destination,
        actor(),
      );
    },
    "owner",
  );
  handle(
    "backup:destinations:setActive",
    (payload) => {
      const { id, active } = destinationStateSchema.parse(payload);
      return resilience.setBackupDestinationActive(
        requireCompany().db,
        id,
        active,
      );
    },
    "owner",
  );

  handle(
    "backup:drills:list",
    () => ({
      due: resilience.recoveryDrillDue(requireCompany().db),
      rows: resilience.listRecoveryDrills(requireCompany().db),
    }),
    "viewer",
  );
  handle(
    "backup:drills:run",
    (payload) => {
      const { destinationId } = drillSchema.parse(payload ?? {});
      const company = requireCompany();
      return resilience.runRecoveryDrill(
        company.db,
        company.slug,
        actor(),
        destinationId,
      );
    },
    "owner",
  );

  handle(
    "backup:rotation:get",
    () => {
      const company = requireCompany();
      return {
        policy: resilience.getRotationPolicy(company.db),
        forecast: resilience.backupSpaceForecast(company.db, company.slug),
      };
    },
    "viewer",
  );
  handle(
    "backup:rotation:set",
    (payload) => {
      const input = rotationSchema.parse(payload);
      const company = requireCompany();
      const policy = resilience.setRotationPolicy(
        company.db,
        input,
        actor(),
      );
      return {
        policy,
        forecast: resilience.backupSpaceForecast(company.db, company.slug),
      };
    },
    "owner",
  );

  handle(
    "backup:preview",
    (payload) => {
      const { file } = z.object({ file: backupFileSchema }).parse(payload);
      const company = requireCompany();
      return inspectBackup(join(companyBackupsDir(company.slug), file));
    },
    "owner",
  );
}
