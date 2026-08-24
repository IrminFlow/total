import qrcode from "qrcode-generator";
import type { DB } from "../db/connection";
import { writeExportPdf } from "./pdf";

const esc = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
function qrSvg(text: string): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ scalable: true });
}

export async function exportBarcodeLabels(
  db: DB,
  slug: string,
  companyName: string,
  items: { stockItemId: number; copies: number }[],
): Promise<string> {
  if (!items.length) throw new Error("Select at least one item for labels");
  const stmt = db.prepare("SELECT id,name,barcode FROM stock_items WHERE id=?");
  const labels: string[] = [];
  for (const request of items) {
    const row = stmt.get(request.stockItemId) as
      { id: number; name: string; barcode: string | null } | undefined;
    if (!row) throw new Error("A selected stock item was not found");
    if (!row.barcode) throw new Error(`${row.name} has no barcode or SKU`);
    for (let i = 0; i < request.copies; i++)
      labels.push(
        `<div class="label"><div class="qr">${qrSvg(row.barcode)}</div><div class="copy"><strong>${esc(row.name)}</strong><span>${esc(row.barcode)}</span><small>${esc(companyName)}</small></div></div>`,
      );
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:A4;margin:8mm}*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif;color:#111}.sheet{display:grid;grid-template-columns:repeat(3,1fr);grid-auto-rows:33mm;gap:2mm}.label{border:.25mm solid #bbb;border-radius:1.5mm;display:flex;align-items:center;gap:3mm;padding:3mm;break-inside:avoid}.qr{width:25mm;height:25mm;flex:none}.qr svg{width:100%;height:100%}.copy{min-width:0}.copy strong{display:block;font-size:10pt;line-height:1.2;max-height:24pt;overflow:hidden}.copy span{display:block;margin-top:2mm;font:8pt ui-monospace,monospace;word-break:break-all}.copy small{display:block;margin-top:2mm;color:#666;font-size:6.5pt}</style></head><body><div class="sheet">${labels.join("")}</div></body></html>`;
  return writeExportPdf(
    slug,
    `barcode-labels-${new Date().toISOString().slice(0, 10)}.pdf`,
    html,
    { pageSize: "A4" },
  );
}
