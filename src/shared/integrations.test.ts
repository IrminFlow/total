import { describe, expect, it } from "vitest";
import { pluginManifestSchema } from "./integrations";

const base = {
  schemaVersion: 1 as const,
  id: "in.total.example",
  name: "Example adapter",
  version: "1.2.0",
  publisher: "Example Partners",
  runtime: "declarative-v1" as const,
  compatibility: { contractVersion: 1 as const, minAppVersion: "0.5.0" },
  permissions: ["reports:read" as const],
  networkHosts: [],
  screens: [],
  importers: [],
  reports: [
    { id: "sales", label: "Sales movement", primitive: "sales_register" as const },
  ],
  exports: [],
};

describe("declarative integration manifest", () => {
  it("accepts bounded declarations with explicit permissions", () => {
    expect(pluginManifestSchema.parse(base)).toMatchObject({
      id: "in.total.example",
      runtime: "declarative-v1",
    });
  });

  it("rejects executable entrypoints and undeclared authority", () => {
    expect(() => pluginManifestSchema.parse({ ...base, main: "index.js" })).toThrow();
    expect(() =>
      pluginManifestSchema.parse({
        ...base,
        permissions: [],
        networkHosts: ["api.example.com"],
      }),
    ).toThrow(/network:declared_hosts/);
  });
});
