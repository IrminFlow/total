import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "fs";
import { homedir, tmpdir } from "os";
import { join, relative, resolve } from "path";

const mocks = vi.hoisted(() => ({
  draftVoucher: vi.fn(async () => ({ id: "proposal-1" })),
  search: vi.fn(() => [{ title: "Cash ledger" }]),
}));

vi.mock("electron", () => ({ app: { getPath: () => "/unused" } }));
vi.mock("./ai", () => ({ draftVoucher: mocks.draftVoucher }));
vi.mock("./assistiveAutomation", () => ({ constrainedNaturalSearch: mocks.search }));

import { executeOperatorAction, getOperatorConfig, operatorContext, setOperatorConfig } from "./aiOperator";

let dataDir = "";
let workspace = "";
let outside = "";

const info = {} as never;
const db = {} as never;
const action = (value: Record<string, unknown>) => ({ reason: "Test the explicit operator boundary", ...value }) as never;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "total-operator-data-"));
  workspace = mkdtempSync(join(tmpdir(), "total-operator-workspace-"));
  outside = mkdtempSync(join(tmpdir(), "total-operator-outside-"));
  process.env.TOTAL_DATA_DIR = dataDir;
  mocks.draftVoucher.mockClear();
  mocks.search.mockClear();
});

afterEach(() => {
  delete process.env.TOTAL_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function enable(approvalMode: "every_change" | "accounting_only" = "every_change") {
  return setOperatorConfig({ enabled: true, approvalMode, workspaceRoots: [workspace] });
}

describe("AI Operator service boundary", () => {
  it("is disabled by default and rejects broad or invalid workspace roots", () => {
    expect(getOperatorConfig()).toEqual({ enabled: false, approvalMode: "every_change", workspaceRoots: [] });
    expect(() => setOperatorConfig({ enabled: true, approvalMode: "every_change", workspaceRoots: [resolve("/")] })).toThrow(/specific project folder/);
    expect(() => setOperatorConfig({ enabled: true, approvalMode: "every_change", workspaceRoots: [homedir()] })).toThrow(/specific project folder/);
    expect(() => setOperatorConfig({ enabled: true, approvalMode: "every_change", workspaceRoots: [dataDir] })).toThrow(/specific project folder/);
    expect(() => setOperatorConfig({ enabled: true, approvalMode: "every_change", workspaceRoots: [join(workspace, "missing")] })).toThrow();
  });

  it("canonicalizes and deduplicates approved roots without exposing more in context", () => {
    const configured = setOperatorConfig({ enabled: true, approvalMode: "every_change", workspaceRoots: [workspace, workspace] });
    expect(configured.workspaceRoots).toEqual([realpathSync(workspace)]);
    expect(JSON.parse(operatorContext(configured))).toEqual({
      policy: "Posted accounting changes always become proposals and require review inside Total.",
      approvalMode: "every_change",
      workspaceRoots: [realpathSync(workspace)],
    });
  });

  it("rejects traversal, relative paths, and symlinks", async () => {
    enable();
    const outsideFile = join(outside, "private.txt");
    writeFileSync(outsideFile, "private");
    const link = join(workspace, "linked.txt");
    symlinkSync(outsideFile, link);

    await expect(executeOperatorAction(db, "books", info, action({ kind: "read_file", path: "relative.txt" }), false)).rejects.toThrow(/absolute/);
    await expect(executeOperatorAction(db, "books", info, action({ kind: "read_file", path: join(workspace, relative(workspace, outsideFile)) }), false)).rejects.toThrow(/outside/);
    await expect(executeOperatorAction(db, "books", info, action({ kind: "read_file", path: link }), false)).rejects.toThrow(/outside|symbolic/);
  });

  it("reads regular text but rejects directories, binary data, missing files, and files over 2 MB", async () => {
    enable();
    const text = join(workspace, "notes.txt");
    writeFileSync(text, "quarterly review");
    await expect(executeOperatorAction(db, "books", info, action({ kind: "read_file", path: text }), false)).resolves.toMatchObject({
      status: "completed",
      data: { path: text, content: "quarterly review" },
    });

    const binary = join(workspace, "image.bin");
    writeFileSync(binary, Buffer.from([1, 0, 2]));
    await expect(executeOperatorAction(db, "books", info, action({ kind: "read_file", path: binary }), false)).rejects.toThrow(/Binary/);
    await expect(executeOperatorAction(db, "books", info, action({ kind: "read_file", path: workspace }), false)).rejects.toThrow(/regular text files/);
    await expect(executeOperatorAction(db, "books", info, action({ kind: "read_file", path: join(workspace, "missing.txt") }), false)).rejects.toThrow(/does not exist/);

    const large = join(workspace, "large.txt");
    writeFileSync(large, "x");
    truncateSync(large, 2 * 1024 * 1024 + 1);
    await expect(executeOperatorAction(db, "books", info, action({ kind: "read_file", path: large }), false)).rejects.toThrow(/up to 2 MB/);
  });

  it("requires explicit approval for every-change writes", async () => {
    enable("every_change");
    const target = join(workspace, "output.txt");
    const pending = await executeOperatorAction(db, "books", info, action({ kind: "write_file", path: target, content: "approved content" }), false);
    expect(pending).toMatchObject({ status: "approval_required" });
    expect(() => readFileSync(target)).toThrow();

    await expect(executeOperatorAction(db, "books", info, action({ kind: "write_file", path: target, content: "approved content" }), true)).resolves.toMatchObject({ status: "completed" });
    expect(readFileSync(target, "utf8")).toBe("approved content");
  });

  it("allows approved-folder writes in accounting-only mode but keeps voucher work proposal-only", async () => {
    enable("accounting_only");
    const target = join(workspace, "direct.txt");
    await expect(executeOperatorAction(db, "books", info, action({ kind: "write_file", path: target, content: "direct content" }), false)).resolves.toMatchObject({ status: "completed" });
    expect(readFileSync(target, "utf8")).toBe("direct content");

    await expect(executeOperatorAction(db, "books", info, action({ kind: "draft_voucher", instruction: "Record a cash receipt from Asha for invoice 42" }), true)).resolves.toMatchObject({
      status: "proposal_created",
      data: { id: "proposal-1" },
    });
    expect(mocks.draftVoucher).toHaveBeenCalledWith(db, "books", expect.any(String), true);
  });

  it("executes only safe navigation and constrained book search while enabled", async () => {
    enable();
    await expect(executeOperatorAction(db, "books", info, action({ kind: "navigate", screen: "day-book" }), false)).resolves.toMatchObject({ status: "completed", data: { screen: "day-book" } });
    await expect(executeOperatorAction(db, "books", info, action({ kind: "search_books", query: "cash" }), false)).resolves.toMatchObject({ status: "completed", data: [{ title: "Cash ledger" }] });
    expect(mocks.search).toHaveBeenCalledWith(db, "cash");
  });

  it("blocks every action when the operator is disabled", async () => {
    await expect(executeOperatorAction(db, "books", info, action({ kind: "navigate", screen: "gateway" }), false)).rejects.toThrow(/disabled/);
  });
});
