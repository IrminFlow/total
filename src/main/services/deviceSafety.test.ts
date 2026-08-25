import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { readDeviceSafetyControls, requireDeviceSafetyControl, writeDeviceSafetyControls } from "./deviceSafety";

const original = process.env.TOTAL_DATA_DIR;
afterEach(() => {
  if (original === undefined) delete process.env.TOTAL_DATA_DIR;
  else process.env.TOTAL_DATA_DIR = original;
});

describe("device safety controls", () => {
  it("fails closed for missing and malformed files", () => {
    const dir = mkdtempSync(join(tmpdir(), "total-device-safety-"));
    process.env.TOTAL_DATA_DIR = dir;
    expect(readDeviceSafetyControls()).toEqual({ aiCopilot: false, mcpAccess: false, supportUploads: false, telemetry: false });
    writeFileSync(join(dir, "device-safety.json"), '{"aiCopilot":"yes"}');
    expect(readDeviceSafetyControls().aiCopilot).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists exact controls and enforces disabled capabilities", () => {
    const dir = mkdtempSync(join(tmpdir(), "total-device-safety-"));
    process.env.TOTAL_DATA_DIR = dir;
    writeDeviceSafetyControls({ aiCopilot: true, mcpAccess: false, supportUploads: false, telemetry: false });
    expect(readDeviceSafetyControls().aiCopilot).toBe(true);
    expect(() => requireDeviceSafetyControl("mcpAccess", "MCP is disabled")).toThrow("MCP is disabled");
    rmSync(dir, { recursive: true, force: true });
  });
});
