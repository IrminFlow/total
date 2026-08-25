import { z } from "zod";

export const deviceSafetyControlsSchema = z.object({
  aiCopilot: z.boolean(),
  mcpAccess: z.boolean(),
  supportUploads: z.boolean(),
  telemetry: z.boolean(),
});

export type DeviceSafetyControls = z.infer<typeof deviceSafetyControlsSchema>;

export const DEFAULT_DEVICE_SAFETY_CONTROLS: DeviceSafetyControls = {
  aiCopilot: false,
  mcpAccess: false,
  supportUploads: false,
  telemetry: false,
};
