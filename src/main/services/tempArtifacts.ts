import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "fs";
import { tmpdir } from "os";
import { basename, dirname, join, resolve, sep } from "path";

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_STALE_SCAN = 100;
const CLEANUP_RETRIES = 4;
const CLEANUP_RETRY_MS = 250;

export interface TemporaryArtifact {
  path: string;
  dispose: () => void;
}

export interface TemporaryArtifactOptions {
  /** Automatic cleanup delay for previews handed to another application. */
  ttlMs?: number;
  /** Opportunistically remove older crash leftovers with the same prefix. */
  staleAfterMs?: number;
}

function assertPrefix(prefix: string): void {
  if (!/^total-[a-z0-9-]{1,48}-$/.test(prefix))
    throw new Error("Temporary artifact prefix is invalid");
}

function assertTemporaryChild(path: string): void {
  const root = resolve(tmpdir());
  const target = resolve(path);
  if (dirname(target) !== root || !target.startsWith(`${root}${sep}`))
    throw new Error("Refusing to clean a path outside the temporary folder");
}

function removeTemporaryChild(path: string): void {
  assertTemporaryChild(path);
  rmSync(path, { recursive: true, force: true });
}

function generatedNamePattern(prefix: string): RegExp {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}[A-Za-z0-9]{6}$`);
}

function pruneStale(prefix: string, staleAfterMs: number, now: number): void {
  const generatedName = generatedNamePattern(prefix);
  const names = readdirSync(tmpdir())
    .filter((name) => generatedName.test(name))
    .sort()
    .slice(0, MAX_STALE_SCAN);
  for (const name of names) {
    const path = join(tmpdir(), basename(name));
    try {
      if (now - lstatSync(path).mtimeMs >= staleAfterMs) removeTemporaryChild(path);
    } catch {
      // A concurrent cleanup or operating-system temp purge already handled it.
    }
  }
}

/**
 * Create a temp directory that cleans itself after a bounded preview window. A small stale scan
 * also removes leftovers from crashes, but never scans or deletes outside the OS temp root.
 */
export function createBoundedTemporaryDirectory(
  prefix: string,
  options: TemporaryArtifactOptions = {},
): TemporaryArtifact {
  assertPrefix(prefix);
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  if (!Number.isFinite(ttlMs) || ttlMs < 1_000 || ttlMs > 24 * 60 * 60 * 1000)
    throw new Error("Temporary artifact TTL is out of range");
  if (
    !Number.isFinite(staleAfterMs) ||
    staleAfterMs < ttlMs ||
    staleAfterMs > 30 * 24 * 60 * 60 * 1000
  )
    throw new Error("Temporary artifact stale window is out of range");
  pruneStale(prefix, staleAfterMs, Date.now());
  const path = mkdtempSync(join(tmpdir(), prefix));
  let disposed = false;
  let expiryTimer: NodeJS.Timeout;
  let retryTimer: NodeJS.Timeout | null = null;
  const attemptCleanup = (attempt: number): void => {
    try {
      if (existsSync(path)) removeTemporaryChild(path);
    } catch {
      if (attempt >= CLEANUP_RETRIES) return;
      retryTimer = setTimeout(() => attemptCleanup(attempt + 1), CLEANUP_RETRY_MS);
      retryTimer.unref();
    }
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    clearTimeout(expiryTimer);
    if (retryTimer) clearTimeout(retryTimer);
    // Preview applications and antivirus scanners can briefly retain a file handle on Windows.
    // Cleanup is best-effort and retried; it must never crash the main process or mask work errors.
    attemptCleanup(0);
  };
  expiryTimer = setTimeout(dispose, ttlMs);
  expiryTimer.unref();
  return { path, dispose };
}

/** Run import/decryption work in a directory that is removed on success and on every throw path. */
export async function withTemporaryDirectory<T>(
  prefix: string,
  work: (path: string) => Promise<T> | T,
): Promise<T> {
  const artifact = createBoundedTemporaryDirectory(prefix);
  try {
    return await work(artifact.path);
  } finally {
    artifact.dispose();
  }
}
