import { execFile, spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";

interface LoginSession {
  process: ChildProcess;
  output: string;
  status: "running" | "completed" | "failed" | "cancelled";
  exitCode: number | null;
}

const sessions = new Map<string, LoginSession>();
const MAX_OUTPUT = 32_000;

function append(session: LoginSession, chunk: Buffer): void {
  session.output = `${session.output}${chunk.toString("utf8")}`.slice(-MAX_OUTPUT);
}

export function codexLoginStatus(): Promise<{ available: boolean; authenticated: boolean; detail: string }> {
  return new Promise((resolve) => {
    execFile("codex", ["login", "status"], { timeout: 5_000 }, (error, stdout, stderr) => {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return resolve({ available: false, authenticated: false, detail: "Codex CLI is not installed" });
      const detail = `${stdout}${stderr}`.trim().slice(0, 1_000) || (error ? "Codex is not signed in" : "Codex is signed in");
      resolve({ available: true, authenticated: !error, detail });
    });
  });
}

export function startCodexDeviceLogin(): { sessionId: string } {
  const sessionId = randomUUID();
  const child = spawn("codex", ["login", "--device-auth"], { env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const session: LoginSession = { process: child, output: "", status: "running", exitCode: null };
  sessions.set(sessionId, session);
  child.stdout.on("data", (chunk: Buffer) => append(session, chunk));
  child.stderr.on("data", (chunk: Buffer) => append(session, chunk));
  child.on("error", (error) => { session.status = "failed"; session.output = `${session.output}\n${error.message}`.trim(); });
  child.on("close", (code) => { session.exitCode = code; if (session.status === "running") session.status = code === 0 ? "completed" : "failed"; });
  return { sessionId };
}

export function codexLoginSession(sessionId: string): { output: string; status: LoginSession["status"]; exitCode: number | null } {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("Codex login session was not found");
  return { output: session.output, status: session.status, exitCode: session.exitCode };
}

export function cancelCodexLogin(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session || session.status !== "running") return;
  session.status = "cancelled";
  session.process.kill();
}
