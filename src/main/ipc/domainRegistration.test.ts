import { describe, expect, it } from "vitest";
import { registerConsolidatedHandlers } from "./consolidatedHandlers";
import { registerYearEndHandlers } from "./yearEndHandlers";
import type { IpcHandle } from "./types";
import type { Role } from "../services/roles";

describe("extracted IPC domain registration", () => {
  it("preserves consolidated and year-end role boundaries", () => {
    const registrations: Array<[string, Role | undefined]> = [];
    const handle: IpcHandle = (channel, _handler, role) => {
      registrations.push([channel, role]);
    };
    const requireCompany = () => {
      throw new Error("registration must not access a company");
    };

    registerConsolidatedHandlers({ handle, requireCompany });
    registerYearEndHandlers({ handle, requireCompany });

    expect(registrations).toEqual([
      ["consol:run", "viewer"],
      ["yearend:preview", "viewer"],
      ["yearend:close", "owner"],
    ]);
  });
});
