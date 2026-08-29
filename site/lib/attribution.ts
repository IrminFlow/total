import { randomUUID } from "node:crypto";
import { intakeStoreConfigured, storeJson } from "./intakeStore";
import { parseAttribution, type AttributionInput } from "./attributionContract";

export { parseAttribution } from "./attributionContract";

/** Stores an anonymous, allowlisted event. Attribution must never delay or break the user action. */
export async function recordAttribution(input: AttributionInput, now = new Date()): Promise<void> {
  if (!intakeStoreConfigured()) return;
  const parsed = parseAttribution(input);
  if (!parsed) return;
  const hour = now.toISOString().slice(0, 13);
  const day = hour.slice(0, 10);
  try {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      storeJson(`attribution/${day}/${randomUUID()}.json`, {
        schema: 1,
        receivedHour: `${hour}:00:00.000Z`,
        ...parsed,
      }),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, 500);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
  } catch {
    // Product delivery and downloads do not depend on measurement.
  }
}
