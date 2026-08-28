import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { atomicWriteFile } from "../atomicFile";
import { dataRoot } from "../paths";

const installationSchema = z.object({
  version: z.literal(1),
  installationId: z.string().uuid(),
});

/** Stable device-scoped support reference. It contains no company or user identity. */
export function supportInstallationId(): string {
  const path = join(dataRoot(), "support-installation.json");
  try {
    return installationSchema.parse(JSON.parse(readFileSync(path, "utf8"))).installationId;
  } catch {
    const installationId = randomUUID();
    atomicWriteFile(path, `${JSON.stringify({ version: 1, installationId })}\n`, 0o600);
    return installationId;
  }
}
