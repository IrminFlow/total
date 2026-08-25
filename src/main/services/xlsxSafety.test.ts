import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { assertSafeXlsxContainer } from "./xlsxSafety";

function centralDirectoryOffset(buffer: Buffer): number {
  for (let offset = buffer.length - 22; offset >= 0; offset--)
    if (buffer.readUInt32LE(offset) === 0x06054b50) return buffer.readUInt32LE(offset + 16);
  throw new Error("missing test EOCD");
}

describe("XLSX container safety", () => {
  it("accepts an ordinary ExcelJS workbook", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Books").addRow(["Date", "Amount"]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    expect(() => assertSafeXlsxContainer(buffer)).not.toThrow();
  });

  it("rejects a forged expansion bomb before decompression", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Books").addRow(["Date", "Amount"]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const directory = centralDirectoryOffset(buffer);
    buffer.writeUInt32LE(200 * 1024 * 1024, directory + 24);
    expect(() => assertSafeXlsxContainer(buffer)).toThrow(/entry exceeds|uncompressed size/);
  });

  it("rejects truncated, split, ZIP64 and inconsistent containers", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Books").addRow(["Date"]);
    const source = Buffer.from(await workbook.xlsx.writeBuffer());
    expect(() => assertSafeXlsxContainer(source.subarray(0, 20))).toThrow(/truncated/);

    const split = Buffer.from(source);
    split.writeUInt16LE(1, split.length - 18);
    expect(() => assertSafeXlsxContainer(split)).toThrow(/Split/);

    const zip64 = Buffer.from(source);
    zip64.writeUInt16LE(0xffff, zip64.length - 14);
    zip64.writeUInt16LE(0xffff, zip64.length - 12);
    expect(() => assertSafeXlsxContainer(zip64)).toThrow(/ZIP64|entry safety/);

    const inconsistent = Buffer.from(source);
    inconsistent.writeUInt32LE(1, inconsistent.length - 6);
    expect(() => assertSafeXlsxContainer(inconsistent)).toThrow(/inconsistent/);
  });

  it("handles deterministic byte mutations as bounded validation failures", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Books").addRow(["Date", "Narration", "Amount"]);
    const source = Buffer.from(await workbook.xlsx.writeBuffer());
    let state = 0x51_58_4c_53;
    const next = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };
    for (let index = 0; index < 250; index++) {
      const end = Math.max(1, next() % (source.length + 1));
      const candidate = Buffer.from(source.subarray(0, end));
      for (let edits = 0; edits < 4 && candidate.length > 0; edits++) {
        const offset = next() % candidate.length;
        candidate[offset] = (candidate[offset]! ^ (1 << (next() % 8))) & 0xff;
      }
      let result: "accepted" | "rejected" = "accepted";
      try { assertSafeXlsxContainer(candidate); } catch { result = "rejected"; }
      expect(["accepted", "rejected"]).toContain(result);
    }
  });
});
