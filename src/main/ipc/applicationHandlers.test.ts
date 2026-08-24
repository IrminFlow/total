import { describe, expect, it, vi } from "vitest";
import { registerApplicationHandlers } from "./applicationHandlers";
import type { IpcHandle, IpcHandler } from "./types";

function setup() {
  const handlers = new Map<string, IpcHandler>();
  const roles = new Map<string, string | undefined>();
  const writeRendererError = vi.fn();
  const revealLogs = vi.fn();
  const checkForUpdates = vi.fn(() => ({ available: false }));
  const handle: IpcHandle = (channel, handler, role) => {
    handlers.set(channel, handler);
    roles.set(channel, role);
  };
  registerApplicationHandlers({
    handle,
    writeRendererError,
    revealLogs,
    getVersion: () => "0.5.0",
    platform: "darwin",
    checkForUpdates,
  });
  return {
    handlers,
    roles,
    writeRendererError,
    revealLogs,
    checkForUpdates,
  };
}

describe("application IPC handlers", () => {
  it("parses renderer errors before writing and preserves every field", () => {
    const test = setup();
    expect(() => test.handlers.get("log:renderer")!({ message: 7 })).toThrow();
    expect(test.writeRendererError).not.toHaveBeenCalled();

    expect(
      test.handlers.get("log:renderer")!({
        message: "Render failed",
        stack: "stack",
        componentStack: "component",
        screen: "Gateway",
      }),
    ).toBeNull();
    expect(test.writeRendererError).toHaveBeenCalledWith({
      message: "Render failed",
      stack: "stack",
      componentStack: "component",
      screen: "Gateway",
    });
  });

  it("reports app metadata and keeps update checks viewer-accessible", () => {
    const test = setup();
    expect(test.handlers.get("app:info")!(undefined)).toEqual({
      version: "0.5.0",
      platform: "darwin",
    });
    expect(test.handlers.get("app:checkUpdates")!(undefined)).toEqual({
      available: false,
    });
    expect(test.roles.get("app:checkUpdates")).toBe("viewer");
  });
});
