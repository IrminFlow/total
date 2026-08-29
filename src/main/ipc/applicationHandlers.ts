import { rendererLogSchema } from "@shared/schemas";
import type { IpcHandle } from "./types";

interface ApplicationHandlerContext {
  handle: IpcHandle;
  writeRendererError: (detail: {
    message: string;
    stack?: string;
    componentStack?: string;
    screen?: string;
  }) => void;
  revealLogs: () => void;
  getVersion: () => string;
  platform: NodeJS.Platform;
  checkForUpdates: () => unknown | Promise<unknown>;
}

/** Register app diagnostics, metadata, and interactive update handlers. */
export function registerApplicationHandlers({
  handle,
  writeRendererError,
  revealLogs,
  getVersion,
  platform,
  checkForUpdates,
}: ApplicationHandlerContext): void {
  handle("log:renderer", (payload) => {
    writeRendererError(rendererLogSchema.parse(payload));
    return null;
  });
  handle("log:reveal", () => {
    revealLogs();
    return null;
  });
  handle("app:info", () => ({ version: getVersion(), platform }));
  handle("app:checkUpdates", () => checkForUpdates(), "viewer");
}
