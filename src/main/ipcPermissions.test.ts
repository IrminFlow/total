import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import * as ts from "typescript";
import {
  EXPLICIT_PERMISSION_ACTIONS,
  IPC_EXPORT_CONTRACTS,
  companyWideExportLabelForChannel,
  exportFormatForChannel,
  permissionResolvedInsideHandler,
  permissionActionForChannel,
} from "./ipcPermissions";

const IPC_SOURCE_URLS = [
  new URL("./ipc.ts", import.meta.url),
  ...readdirSync(new URL("./ipc/", import.meta.url), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts") &&
        entry.name !== "types.ts",
    )
    .map((entry) => new URL(`./ipc/${entry.name}`, import.meta.url)),
];

function registeredChannelList(): string[] {
  return IPC_SOURCE_URLS.flatMap((url) => [
    ...readFileSync(url, "utf8").matchAll(/handle\(\s*["']([^"']+)["']/g),
  ]).map((match) => match[1]!);
}

function registeredChannels(): Set<string> {
  return new Set(registeredChannelList());
}

function directFileChannels(): Set<string> {
  const channels = new Set<string>();
  for (const url of IPC_SOURCE_URLS) {
    const sourceText = readFileSync(url, "utf8");
    const source = ts.createSourceFile(
      url.pathname,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "handle" &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0]) &&
        /writeFileSync|atomicWriteFile|writeExportPdf|showItemInFolder|shell\.openPath/.test(
          node.getText(source),
        )
      )
        channels.add(node.arguments[0].text);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return channels;
}

describe("IPC permission contracts", () => {
  it("registers every statically declared IPC channel exactly once", () => {
    const channels = registeredChannelList();
    expect(channels).toHaveLength(new Set(channels).size);
  });

  it.each([
    ["voucher:batchTag", { ids: [1, 2], tag: "review" }],
    ["voucher:batchReview", { ids: [1, 2] }],
    [
      "voucher:batchReverse",
      { ids: [1, 2], date: "2026-08-24", reason: "Correction" },
    ],
    ["bank:setBankDate", { lineId: 12, bankDate: "2026-08-24" }],
    [
      "bank:chequeStatus",
      { voucherId: 7, status: "cleared", statusDate: "2026-08-24" },
    ],
  ])("classifies %s as an edit even without a top-level id", (channel, payload) => {
    expect(permissionActionForChannel(channel, payload, "accountant")).toBe(
      "edit",
    );
  });

  it.each(["agent:approveProposal", "agent:discardProposal"])(
    "classifies %s as an approval decision",
    (channel) => {
      expect(
        permissionActionForChannel(
          channel,
          { file: "proposal.json" },
          "accountant",
        ),
      ).toBe("approve");
    },
  );

  it.each(Object.keys(IPC_EXPORT_CONTRACTS))(
    "classifies registered file channel %s as an export",
    (channel) => {
      expect(permissionActionForChannel(channel, {}, "accountant")).toBe(
        "export",
      );
      expect(exportFormatForChannel(channel)).toBe(
        IPC_EXPORT_CONTRACTS[channel as keyof typeof IPC_EXPORT_CONTRACTS]
          .format,
      );
    },
  );

  it("classifies transport updates as edits", () => {
    expect(
      permissionActionForChannel(
        "edoc:transportSet",
        { voucherId: 7, data: {} },
        "accountant",
      ),
    ).toBe("edit");
  });

  it("keeps the explicit contract table synchronized with the protected channels", () => {
    expect(EXPLICIT_PERMISSION_ACTIONS).toEqual({
      "voucher:batchTag": "edit",
      "voucher:batchReview": "edit",
      "voucher:batchReverse": "edit",
      "bank:setBankDate": "edit",
      "bank:chequeStatus": "edit",
      "system:recovery:attempt": "backup",
      "edoc:transportSet": "edit",
      "agent:approveProposal": "approve",
      "agent:discardProposal": "approve",
    });
  });

  it("keeps every permission and export contract attached to a registered IPC channel", () => {
    const registered = registeredChannels();
    expect(
      [
        ...Object.keys(EXPLICIT_PERMISSION_ACTIONS),
        ...Object.keys(IPC_EXPORT_CONTRACTS),
      ].filter(
        (channel) => !registered.has(channel),
      ),
    ).toEqual([]);
  });

  it("requires a format contract for every export-shaped registered channel", () => {
    const intentionallySeparate = new Set(["backup:exportEncrypted"]);
    const exportShaped = [...registeredChannels()].filter(
      (channel) =>
        channel.startsWith("export:") ||
        /(?:export(?:[A-Z:]|$)|:filePreview$|:pdf$|Pdf$|:payslip(?:Pack)?$|:ecr$|:esi$|:ptCsv$|:advice$|:noticePack$|:portalBundle$|:ewbJson$|:testGrid$)/.test(
          channel,
        ),
    );
    expect(
      exportShaped.filter(
        (channel) =>
          !intentionallySeparate.has(channel) &&
          exportFormatForChannel(channel) === null,
      ),
    ).toEqual([]);
  });

  it("audits every direct user-visible file handler or records an explicit exemption", () => {
    const exemptions = new Set([
      "backup:exportEncrypted", // governed by the distinct backup permission
      "import:template", // static blank template, no company records
      "support:bundleOffline", // consented encrypted support recovery path
      "voucher:attachmentOpen", // opens one already scope-authorized attachment
    ]);
    expect(
      [...directFileChannels()].filter(
        (channel) =>
          !exemptions.has(channel) && exportFormatForChannel(channel) === null,
      ),
    ).toEqual([]);
  });

  it("derives every company-wide scope block from the export registry", () => {
    for (const [channel, contract] of Object.entries(IPC_EXPORT_CONTRACTS)) {
      expect(companyWideExportLabelForChannel(channel)).toBe(
        contract.departmentScope === "company_wide" ? contract.label : null,
      );
    }
  });

  it("keeps voucher authorization inside both cheque document handlers", () => {
    const source = readFileSync(new URL("./ipc.ts", import.meta.url), "utf8");
    const chequePdf = source.slice(
      source.indexOf('handle("cheque:pdf"'),
      source.indexOf('handle("cheque:testGrid"'),
    );
    const paymentAdvice = source.slice(
      source.indexOf('handle("cheque:advice"'),
      source.indexOf("// ---------- F11 features"),
    );
    expect(chequePdf).toContain("assertVoucherDepartmentScope");
    expect(paymentAdvice).toContain("assertVoucherDepartmentScope");
  });

  it("authorizes dynamic automation on save, enable, and manual run", () => {
    const source = readFileSync(new URL("./ipc.ts", import.meta.url), "utf8");
    expect(source.match(/assertAutomationRunAllowed\(/g)).toHaveLength(3);
    expect(permissionResolvedInsideHandler("integrations:automation:run")).toBe(
      true,
    );
    expect(permissionResolvedInsideHandler("integrations:automation:save")).toBe(
      false,
    );
    expect(source).toContain("permissionResolvedInsideHandler(channel)");
  });

  it("preserves ordinary create, id-based edit, view, and settings inference", () => {
    expect(
      permissionActionForChannel("master:ledgers:create", {}, "accountant"),
    ).toBe("create");
    expect(
      permissionActionForChannel(
        "master:ledgers:update",
        { id: 1 },
        "accountant",
      ),
    ).toBe("edit");
    expect(permissionActionForChannel("voucher:list", {}, "viewer")).toBe(
      "view",
    );
    expect(permissionActionForChannel("company:updateInfo", {}, "owner")).toBe(
      "settings",
    );
  });
});
