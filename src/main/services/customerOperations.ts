import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "fs";
import { basename, join } from "path";
import { createHash, randomBytes } from "crypto";
import type { DB } from "../db/connection";
import type { CompanyInfo } from "@shared/domain";
import type {
  CustomerPortalBundle,
  SalesCustomerAssignment,
  SalesCustomFieldDefinition,
  SalesCustomFieldInput,
  SalesReturnCandidate,
  SalesReturnDraftInput,
  SalesTerritory,
  SubscriptionContract,
  SubscriptionContractInput,
  TerritorySalesRow,
  WarrantyClaim,
} from "@shared/customerOperations";
import { saveVoucherDraft } from "./voucherDrafts";
import { invoicePdf } from "./invoice";
import { companyExportsDir } from "../paths";
import { writeAudit } from "./audit";

export function salesReturnCandidates(
  db: DB,
  partyLedgerId?: number,
): SalesReturnCandidate[] {
  const docs = db
    .prepare(
      `SELECT v.id AS voucherId,v.number,v.date,v.party_ledger_id AS partyLedgerId,l.name AS partyName FROM vouchers v JOIN voucher_types vt ON vt.id=v.voucher_type_id JOIN ledgers l ON l.id=v.party_ledger_id WHERE vt.kind='sales' AND v.deleted_at IS NULL AND (? IS NULL OR v.party_ledger_id=?) ORDER BY v.date DESC,v.id DESC`,
    )
    .all(partyLedgerId ?? null, partyLedgerId ?? null) as Omit<
    SalesReturnCandidate,
    "lines"
  >[];
  return docs
    .map((doc) => {
      const lines = db
        .prepare(
          `SELECT il.id AS inventoryLineId,il.stock_item_id AS stockItemId,si.name AS itemName,il.qty_milli AS qtySoldMilli,COALESCE(SUM(r.qty_milli),0) AS qtyReturnedMilli,il.rate_paise AS ratePaise,il.amount AS value FROM inventory_lines il JOIN stock_items si ON si.id=il.stock_item_id LEFT JOIN sales_return_links r ON r.invoice_inventory_line_id=il.id WHERE il.voucher_id=? AND il.direction='out' GROUP BY il.id ORDER BY il.line_order,il.id`,
        )
        .all(doc.voucherId) as Array<
        Omit<SalesReturnCandidate["lines"][number], "openQtyMilli">
      >;
      return {
        ...doc,
        lines: lines
          .map((line) => ({
            ...line,
            openQtyMilli: Math.max(
              0,
              line.qtySoldMilli - line.qtyReturnedMilli,
            ),
          }))
          .filter((line) => line.openQtyMilli > 0),
      };
    })
    .filter((doc) => doc.lines.length > 0);
}

export function createSalesReturnDraft(
  db: DB,
  input: SalesReturnDraftInput,
  author: string,
) {
  const source = salesReturnCandidates(db).find(
    (row) => row.voucherId === input.invoiceVoucherId,
  );
  if (!source) throw new Error("Sales invoice has no returnable quantity");
  if (!input.reason.trim()) throw new Error("Return reason is required");
  const selected = input.lines.map((choice) => {
    const line = source.lines.find(
      (row) => row.inventoryLineId === choice.invoiceInventoryLineId,
    );
    if (!line) throw new Error("Return line is not available");
    if (choice.qtyMilli <= 0 || choice.qtyMilli > line.openQtyMilli)
      throw new Error(
        `Return quantity for ${line.itemName} exceeds the open quantity`,
      );
    return { line, qtyMilli: choice.qtyMilli };
  });
  const type = db
    .prepare("SELECT id FROM voucher_types WHERE kind='credit_note' LIMIT 1")
    .get() as { id: number } | undefined;
  if (!type) throw new Error("Create a credit note voucher type first");
  return saveVoucherDraft(
    db,
    {
      voucherTypeId: type.id,
      mode: "invoice",
      title: `Sales return · ${source.number}`,
      payloadVersion: 1,
      payload: {
        date: input.date,
        number: "",
        partyId: source.partyLedgerId,
        accountId: null,
        rows: selected.map(({ line, qtyMilli }) => ({
          itemId: line.stockItemId,
          qtyText: String(qtyMilli / 1000),
          rate: line.ratePaise,
          discount: null,
        })),
        narration: `${input.reason.trim()} · against ${source.number}`,
        vehicleNo: "",
        transporterId: "",
        distanceKm: "",
        currencyCode: "",
        fxRateText: "",
        posOverride: null,
        optionalVoucher: false,
        billName: "",
        billDueDate: input.date,
        billNameTouched: false,
        billDueDateTouched: false,
        manualNewBillMode: false,
        noteBillRefs: [],
        salesReturnLinks: selected.map(({ line, qtyMilli }) => ({
          invoiceVoucherId: source.voucherId,
          invoiceInventoryLineId: line.inventoryLineId,
          qtyMilli,
        })),
      },
    },
    author,
  );
}

export function recordSalesReturn(
  db: DB,
  returnVoucherId: number,
  links: {
    invoiceVoucherId: number;
    invoiceInventoryLineId: number;
    qtyMilli: number;
  }[],
  author: string,
): void {
  const voucher = db
    .prepare(
      `SELECT vt.kind FROM vouchers v JOIN voucher_types vt ON vt.id=v.voucher_type_id WHERE v.id=?`,
    )
    .get(returnVoucherId) as { kind: string } | undefined;
  if (voucher?.kind !== "credit_note")
    throw new Error("Return evidence must attach to a credit note");
  const returned = db
    .prepare(
      `SELECT id,stock_item_id AS stockItemId,qty_milli AS qtyMilli,amount FROM inventory_lines WHERE voucher_id=? AND direction='in' ORDER BY line_order,id`,
    )
    .all(returnVoucherId) as {
    id: number;
    stockItemId: number;
    qtyMilli: number;
    amount: number;
  }[];
  if (returned.length !== links.length)
    throw new Error("Posted return lines do not match the source selection");
  db.transaction(() =>
    links.forEach((link, index) => {
      const source = db
        .prepare(
          "SELECT stock_item_id AS stockItemId FROM inventory_lines WHERE id=? AND voucher_id=?",
        )
        .get(link.invoiceInventoryLineId, link.invoiceVoucherId) as
        { stockItemId: number } | undefined;
      const target = returned[index];
      if (
        !source ||
        !target ||
        source.stockItemId !== target.stockItemId ||
        link.qtyMilli !== target.qtyMilli
      )
        throw new Error(
          "Posted return quantity or item changed from the reviewed source",
        );
      const candidate = salesReturnCandidates(db)
        .find((row) => row.voucherId === link.invoiceVoucherId)
        ?.lines.find(
          (line) => line.inventoryLineId === link.invoiceInventoryLineId,
        );
      if (!candidate || link.qtyMilli > candidate.openQtyMilli)
        throw new Error("Return would exceed the original invoice quantity");
      db.prepare(
        `INSERT INTO sales_return_links(return_voucher_id,return_inventory_line_id,invoice_voucher_id,invoice_inventory_line_id,qty_milli,value,created_by) VALUES(?,?,?,?,?,?,?)`,
      ).run(
        returnVoucherId,
        target.id,
        link.invoiceVoucherId,
        link.invoiceInventoryLineId,
        link.qtyMilli,
        target.amount,
        author,
      );
    }),
  )();
  writeAudit(db, "sales_return", returnVoucherId, "create", null, { links });
}

export function warrantyRegister(db: DB): WarrantyClaim[] {
  return db
    .prepare(
      `SELECT c.id,c.serial_id AS serialId,s.serial_no AS serialNo,si.name AS itemName,c.invoice_voucher_id AS invoiceVoucherId,v.number AS invoiceNumber,v.date AS invoiceDate,s.warranty_until AS warrantyUntil,c.opened_date AS openedDate,c.issue,c.status,c.outcome,c.service_cost AS serviceCost,c.resolved_date AS resolvedDate FROM sales_warranty_claims c JOIN inventory_serials s ON s.id=c.serial_id JOIN stock_items si ON si.id=s.stock_item_id JOIN vouchers v ON v.id=c.invoice_voucher_id ORDER BY c.opened_date DESC,c.id DESC`,
    )
    .all() as WarrantyClaim[];
}
export function openWarrantyClaim(
  db: DB,
  serialId: number,
  openedDate: string,
  issue: string,
  author: string,
): WarrantyClaim {
  const sold = db
    .prepare(
      `SELECT v.id AS voucherId,v.date,s.warranty_until AS warrantyUntil FROM inventory_serials s JOIN inventory_serial_movements sm ON sm.serial_id=s.id AND sm.direction='out' JOIN inventory_lines il ON il.id=sm.inventory_line_id JOIN vouchers v ON v.id=il.voucher_id JOIN voucher_types vt ON vt.id=v.voucher_type_id WHERE s.id=? AND vt.kind='sales' ORDER BY v.date DESC LIMIT 1`,
    )
    .get(serialId) as
    | { voucherId: number; date: string; warrantyUntil: string | null }
    | undefined;
  if (!sold) throw new Error("Serial has no linked sales invoice");
  if (sold.warrantyUntil && openedDate > sold.warrantyUntil)
    throw new Error(`Warranty expired on ${sold.warrantyUntil}`);
  const id = Number(
    db
      .prepare(
        `INSERT INTO sales_warranty_claims(serial_id,invoice_voucher_id,opened_date,issue,created_by) VALUES(?,?,?,?,?)`,
      )
      .run(serialId, sold.voucherId, openedDate, issue.trim(), author)
      .lastInsertRowid,
  );
  writeAudit(db, "warranty_claim", id, "create", null, {
    serialId,
    invoiceVoucherId: sold.voucherId,
  });
  return warrantyRegister(db).find((row) => row.id === id)!;
}
export function resolveWarrantyClaim(
  db: DB,
  id: number,
  status: WarrantyClaim["status"],
  outcome: string | null,
  serviceCost: number,
  resolvedDate: string | null,
): WarrantyClaim {
  if (!["in_service", "resolved", "rejected"].includes(status))
    throw new Error("Invalid warranty outcome");
  db.prepare(
    "UPDATE sales_warranty_claims SET status=?,outcome=?,service_cost=?,resolved_date=? WHERE id=?",
  ).run(status, outcome?.trim() || null, serviceCost, resolvedDate, id);
  return warrantyRegister(db).find((row) => row.id === id)!;
}

export function listCustomFields(db: DB): SalesCustomFieldDefinition[] {
  return (
    db
      .prepare(
        `SELECT id,field_key AS fieldKey,label,document_kind AS documentKind,data_type AS dataType,required,options_json AS optionsJson,active FROM sales_custom_field_definitions ORDER BY active DESC,label`,
      )
      .all() as Array<
      Omit<SalesCustomFieldDefinition, "required" | "options" | "active"> & {
        required: number;
        optionsJson: string;
        active: number;
      }
    >
  ).map((row) => ({
    ...row,
    required: !!row.required,
    options: JSON.parse(row.optionsJson) as string[],
    active: !!row.active,
  }));
}
export function saveCustomField(
  db: DB,
  input: SalesCustomFieldInput,
  author: string,
): SalesCustomFieldDefinition {
  if (!/^[a-z][a-z0-9_]{1,39}$/.test(input.fieldKey))
    throw new Error(
      "Field key must use lowercase letters, numbers and underscores",
    );
  if (input.dataType === "choice" && !input.options.length)
    throw new Error("Choice fields need options");
  const id = Number(
    db
      .prepare(
        `INSERT INTO sales_custom_field_definitions(field_key,label,document_kind,data_type,required,options_json,active,created_by) VALUES(?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.fieldKey,
        input.label.trim(),
        input.documentKind,
        input.dataType,
        Number(input.required),
        JSON.stringify(input.options),
        Number(input.active),
        author,
      ).lastInsertRowid,
  );
  writeAudit(db, "sales_custom_field", id, "create", null, input);
  return listCustomFields(db).find((row) => row.id === id)!;
}
export function validateCustomFields(
  db: DB,
  kind: string,
  values: Record<string, string>,
): void {
  for (const field of listCustomFields(db).filter(
    (row) => row.active && (!row.documentKind || row.documentKind === kind),
  )) {
    const value = values[field.fieldKey]?.trim() ?? "";
    if (field.required && !value) throw new Error(`${field.label} is required`);
    if (!value) continue;
    if (field.dataType === "number" && !Number.isFinite(Number(value)))
      throw new Error(`${field.label} must be a number`);
    if (field.dataType === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value))
      throw new Error(`${field.label} must be a date`);
    if (field.dataType === "choice" && !field.options.includes(value))
      throw new Error(
        `${field.label} must be one of: ${field.options.join(", ")}`,
      );
  }
}

export function saveTerritory(
  db: DB,
  name: string,
  parentId: number | null,
): SalesTerritory {
  const id = Number(
    db
      .prepare("INSERT INTO sales_territories(name,parent_id) VALUES(?,?)")
      .run(name.trim(), parentId).lastInsertRowid,
  );
  return db
    .prepare(
      "SELECT id,name,parent_id AS parentId,active FROM sales_territories WHERE id=?",
    )
    .get(id) as SalesTerritory;
}
export function assignCustomer(
  db: DB,
  customerLedgerId: number,
  territoryId: number,
  salesperson: string,
  effectiveFrom: string,
  effectiveTo: string | null,
): SalesCustomerAssignment {
  const id = Number(
    db
      .prepare(
        `INSERT INTO sales_customer_assignments(customer_ledger_id,territory_id,salesperson,effective_from,effective_to) VALUES(?,?,?,?,?)`,
      )
      .run(
        customerLedgerId,
        territoryId,
        salesperson.trim(),
        effectiveFrom,
        effectiveTo,
      ).lastInsertRowid,
  );
  return db
    .prepare(
      `SELECT a.id,a.customer_ledger_id AS customerLedgerId,l.name AS customerName,a.territory_id AS territoryId,t.name AS territoryName,a.salesperson,a.effective_from AS effectiveFrom,a.effective_to AS effectiveTo FROM sales_customer_assignments a JOIN ledgers l ON l.id=a.customer_ledger_id JOIN sales_territories t ON t.id=a.territory_id WHERE a.id=?`,
    )
    .get(id) as SalesCustomerAssignment;
}
export function territorySales(
  db: DB,
  from: string,
  to: string,
): TerritorySalesRow[] {
  return db
    .prepare(
      `WITH sales AS (SELECT v.id,v.party_ledger_id,v.date,CASE vt.kind WHEN 'sales' THEN (SELECT COALESCE(SUM(amount),0) FROM voucher_lines WHERE voucher_id=v.id AND dr_cr='dr') ELSE 0 END AS sale,CASE vt.kind WHEN 'credit_note' THEN (SELECT COALESCE(SUM(amount),0) FROM voucher_lines WHERE voucher_id=v.id AND dr_cr='cr') ELSE 0 END AS ret FROM vouchers v JOIN voucher_types vt ON vt.id=v.voucher_type_id WHERE vt.kind IN ('sales','credit_note') AND v.date BETWEEN ? AND ? AND v.deleted_at IS NULL), tagged AS (SELECT s.*,a.territory_id,a.salesperson FROM sales s LEFT JOIN sales_customer_assignments a ON a.id=(SELECT a2.id FROM sales_customer_assignments a2 WHERE a2.customer_ledger_id=s.party_ledger_id AND a2.effective_from<=s.date AND (a2.effective_to IS NULL OR a2.effective_to>=s.date) ORDER BY a2.effective_from DESC LIMIT 1)) SELECT tagged.territory_id AS territoryId,COALESCE(t.name,'Unassigned') AS territoryName,COALESCE(tagged.salesperson,'Unassigned') AS salesperson,SUM(CASE WHEN sale>0 THEN 1 ELSE 0 END) AS invoiceCount,SUM(sale) AS salesAmount,SUM(ret) AS returnAmount,SUM(sale-ret) AS netSales,0 AS collections FROM tagged LEFT JOIN sales_territories t ON t.id=tagged.territory_id GROUP BY tagged.territory_id,tagged.salesperson ORDER BY netSales DESC`,
    )
    .all(from, to) as TerritorySalesRow[];
}

export function listSubscriptions(db: DB): SubscriptionContract[] {
  return db
    .prepare(
      `SELECT c.id,c.recurring_schedule_id AS recurringScheduleId,s.name AS scheduleName,l.name AS customerName,c.plan_name AS planName,c.start_date AS startDate,c.end_date AS endDate,c.escalation_bps AS escalationBps,c.next_escalation_date AS nextEscalationDate,c.status,c.renewed_from_id AS renewedFromId,c.note FROM sales_subscription_contracts c JOIN sales_recurring_schedules s ON s.id=c.recurring_schedule_id JOIN ledgers l ON l.id=s.party_ledger_id ORDER BY c.status,c.start_date DESC`,
    )
    .all() as SubscriptionContract[];
}
export function createSubscription(
  db: DB,
  input: SubscriptionContractInput,
  author: string,
  renewedFromId: number | null = null,
): SubscriptionContract {
  const id = Number(
    db
      .prepare(
        `INSERT INTO sales_subscription_contracts(recurring_schedule_id,plan_name,start_date,end_date,escalation_bps,next_escalation_date,status,renewed_from_id,note,created_by) VALUES(?,?,?,?,?,?,'active',?,?,?)`,
      )
      .run(
        input.recurringScheduleId,
        input.planName.trim(),
        input.startDate,
        input.endDate,
        input.escalationBps,
        input.nextEscalationDate,
        renewedFromId,
        input.note?.trim() || null,
        author,
      ).lastInsertRowid,
  );
  writeAudit(db, "sales_subscription", id, "create", null, input);
  return listSubscriptions(db).find((row) => row.id === id)!;
}
export function setSubscriptionStatus(
  db: DB,
  id: number,
  status: SubscriptionContract["status"],
): SubscriptionContract {
  db.prepare(
    "UPDATE sales_subscription_contracts SET status=?,updated_at=datetime('now') WHERE id=?",
  ).run(status, id);
  db.prepare(
    "UPDATE sales_recurring_schedules SET active=? WHERE id=(SELECT recurring_schedule_id FROM sales_subscription_contracts WHERE id=?)",
  ).run(Number(status === "active"), id);
  return listSubscriptions(db).find((row) => row.id === id)!;
}

export async function customerPortalBundle(
  db: DB,
  company: CompanyInfo,
  slug: string,
  customerLedgerId: number,
  from: string,
  to: string,
  author: string,
): Promise<CustomerPortalBundle> {
  const customer = db
    .prepare("SELECT name FROM ledgers WHERE id=?")
    .get(customerLedgerId) as { name: string } | undefined;
  if (!customer) throw new Error("Customer was not found");
  const token = randomBytes(12).toString("hex"),
    dir = join(companyExportsDir(slug), `customer-${token}`);
  mkdirSync(dir, { recursive: true });
  const vouchers = db
    .prepare(
      `SELECT v.id,v.number,v.date,vt.kind FROM vouchers v JOIN voucher_types vt ON vt.id=v.voucher_type_id WHERE v.party_ledger_id=? AND v.date BETWEEN ? AND ? AND vt.kind IN ('sales','receipt','credit_note') AND v.deleted_at IS NULL ORDER BY v.date,v.id`,
    )
    .all(customerLedgerId, from, to) as {
    id: number;
    number: string;
    date: string;
    kind: string;
  }[];
  let invoiceCount = 0,
    receiptCount = 0;
  for (const voucher of vouchers) {
    if (voucher.kind === "sales" || voucher.kind === "credit_note") {
      const path = await invoicePdf(db, company, slug, voucher.id);
      copyFileSync(path, join(dir, basename(path)));
      invoiceCount++;
    } else receiptCount++;
  }
  const data = {
    schema: "total.customer-portal.v1",
    company: company.name,
    customer: customer.name,
    period: { from, to },
    generatedAt: new Date().toISOString(),
    token,
    vouchers,
  };
  writeFileSync(join(dir, "activity.json"), JSON.stringify(data, null, 2));
  const esc = (value: string) =>
    value.replace(
      /[&<>"]/g,
      (char) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!,
    );
  writeFileSync(
    join(dir, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>${esc(customer.name)} documents</title><style>body{font:14px system-ui;max-width:760px;margin:48px auto;color:#17202c}h1{font:600 30px Georgia}li{padding:6px}</style><h1>${esc(customer.name)}</h1><p>${from} to ${to} · offline customer document pack</p><ul>${vouchers.map((row) => `<li>${row.date} · ${esc(row.number)} · ${row.kind}</li>`).join("")}</ul><p>Files in this folder are private. Share the complete folder only with the named customer.</p>`,
  );
  const hashes = readdirSync(dir)
      .sort()
      .map((file) => ({
        file,
        sha256: createHash("sha256")
          .update(requireFile(join(dir, file)))
          .digest("hex"),
      })),
    manifest = JSON.stringify({ token, files: hashes });
  writeFileSync(join(dir, "manifest.json"), manifest);
  const manifestHash = createHash("sha256").update(manifest).digest("hex");
  db.prepare(
    `INSERT INTO customer_portal_exports(customer_ledger_id,from_date,to_date,folder_token,manifest_hash,created_by) VALUES(?,?,?,?,?,?)`,
  ).run(customerLedgerId, from, to, token, manifestHash, author);
  writeAudit(db, "customer_portal_export", 0, "export", null, {
    customerLedgerId,
    from,
    to,
    token,
    manifestHash,
  });
  return { path: dir, token, manifestHash, invoiceCount, receiptCount };
}
function requireFile(path: string): Buffer {
  return readFileSync(path);
}
