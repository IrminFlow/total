import type { RendererLogInput } from "@shared/schemas";
import { call } from "./ipcClient";

/** IPC calls required before a company-specific route chunk has loaded. */
export const coreApi = {
  app: {
    info: () => call<{ version: string; platform: string }>("app:info"),
  },
  log: {
    renderer: (input: RendererLogInput) => call<null>("log:renderer", input),
  },
  crashes: {
    record: (input: { message: string; stack?: string; screen?: string }) =>
      call<unknown>("crash:record", input),
  },
};
