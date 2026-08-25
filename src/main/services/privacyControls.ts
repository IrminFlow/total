import type { DB } from "../db/connection";
import { writeAudit } from "./audit";

const CLIPBOARD_KEY = "privacy.clipboardClearSeconds";

function readMeta(db: DB, key: string): unknown {
  const row = db.prepare("SELECT value FROM meta WHERE key=?").get(key) as
    | { value: string }
    | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

export function clipboardClearSeconds(db: DB): number {
  const value = readMeta(db, CLIPBOARD_KEY);
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 600
    ? value
    : 60;
}

export function setClipboardClearSeconds(
  db: DB,
  seconds: number,
): number {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 600)
    throw new Error("Clipboard clear delay must be between 0 and 600 seconds");
  const before = clipboardClearSeconds(db);
  db.prepare(
    "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(CLIPBOARD_KEY, JSON.stringify(seconds));
  writeAudit(db, "privacy_controls", 0, "update", { clipboardClearSeconds: before }, { clipboardClearSeconds: seconds });
  return seconds;
}
