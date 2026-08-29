import { existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import {
  DEFAULT_DEVICE_SAFETY_CONTROLS,
  deviceSafetyControlsSchema,
  type DeviceSafetyControls,
} from "@shared/deviceSafety";
import { atomicWriteFile } from "../atomicFile";
import { dataRoot } from "../paths";

export function deviceSafetyPath(): string {
  return join(dataRoot(), "device-safety.json");
}

export function readDeviceSafetyControls(): DeviceSafetyControls {
  try {
    const path = deviceSafetyPath();
    if (!existsSync(path)) return { ...DEFAULT_DEVICE_SAFETY_CONTROLS };
    const parsed = deviceSafetyControlsSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : { ...DEFAULT_DEVICE_SAFETY_CONTROLS };
  } catch {
    return { ...DEFAULT_DEVICE_SAFETY_CONTROLS };
  }
}

export function writeDeviceSafetyControls(input: DeviceSafetyControls): DeviceSafetyControls {
  const controls = deviceSafetyControlsSchema.parse(input);
  mkdirSync(dataRoot(), { recursive: true, mode: 0o700 });
  atomicWriteFile(deviceSafetyPath(), `${JSON.stringify(controls, null, 2)}\n`, 0o600);
  return controls;
}

export function requireDeviceSafetyControl(
  key: keyof DeviceSafetyControls,
  message: string,
): void {
  if (!readDeviceSafetyControls()[key]) throw new Error(message);
}
