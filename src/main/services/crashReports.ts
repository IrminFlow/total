import { createHash, randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";
import { atomicWriteFile } from "../atomicFile";
import { dataRoot } from "../paths";

export interface CrashEnvelope {
  id: string;
  timestamp: string;
  kind: "renderer" | "main_exception" | "main_rejection" | "renderer_gone";
  appVersion: string;
  platform: string;
  arch: string;
  screen: string | null;
  fingerprint: string;
  message: string;
  stackFrames: string[];
}

function directory(): string {
  return join(dataRoot(), "crashes");
}

export function redactCrashText(value: string): string {
  const home = homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return value
    .replace(new RegExp(home, "gi"), "<home>")
    .replace(/\/(?:Users|home)\/[^/\s]+/gi, "<home>")
    .replace(/\b[A-Z]:\\Users\\[^\\\s]+/gi, "<home>")
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, "<email>")
    .replace(/\b(?:sk|key|token|secret)[-_][A-Za-z0-9_-]{8,}\b/gi, "<secret>")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function safeFrames(stack: string | undefined): string[] {
  return (stack ?? "")
    .split("\n")
    .slice(1, 11)
    .map(redactCrashText)
    .map((line) => line.replace(/\((?:file:\/\/)?[^)]+[\\/]([^\\/)]+:\d+:\d+)\)/g, "($1)"))
    .filter(Boolean);
}

export function writeCrashEnvelope(input: {
  kind: CrashEnvelope["kind"];
  appVersion: string;
  platform: string;
  arch: string;
  screen?: string | null;
  message: string;
  stack?: string;
  now?: Date;
}): CrashEnvelope {
  const message = redactCrashText(input.message || "Unexpected application error");
  const stackFrames = safeFrames(input.stack);
  const timestamp = (input.now ?? new Date()).toISOString();
  const fingerprint = createHash("sha256")
    .update(`${input.kind}\0${message}\0${stackFrames[0] ?? ""}`)
    .digest("hex")
    .slice(0, 16);
  const envelope: CrashEnvelope = {
    id: `CR-${timestamp.slice(0, 10).replace(/-/g, "")}-${randomBytes(3).toString("hex").toUpperCase()}`,
    timestamp,
    kind: input.kind,
    appVersion: input.appVersion.slice(0, 30),
    platform: input.platform.slice(0, 30),
    arch: input.arch.slice(0, 30),
    screen: input.screen?.slice(0, 80) ?? null,
    fingerprint,
    message,
    stackFrames,
  };
  mkdirSync(directory(), { recursive: true });
  atomicWriteFile(join(directory(), `${envelope.id}.json`), `${JSON.stringify(envelope, null, 2)}\n`, 0o600);
  return envelope;
}

export function listCrashEnvelopes(): CrashEnvelope[] {
  if (!existsSync(directory())) return [];
  return readdirSync(directory())
    .filter((name) => /^CR-\d{8}-[A-F0-9]{6}\.json$/.test(name))
    .sort()
    .reverse()
    .slice(0, 20)
    .flatMap((name) => {
      try {
        const value = JSON.parse(readFileSync(join(directory(), basename(name)), "utf8")) as CrashEnvelope;
        return value.id === name.slice(0, -5) ? [value] : [];
      } catch {
        return [];
      }
    });
}
