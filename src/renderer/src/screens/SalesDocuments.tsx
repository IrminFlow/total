import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  SalesDocument,
  SalesDocumentInput,
  SalesDocumentKind,
  SalesDocumentLineInput,
  SalesDocumentStatus,
} from "@shared/salesDocuments";
import {
  SALES_STATUS_TRANSITIONS,
  salesLineAmounts,
} from "@shared/salesDocuments";
import { formatPaise } from "@shared/money";
import { todayISO, toDisplayDate } from "@shared/dates";
import { api } from "../lib/client";
import { useNav, useSession, useToasts } from "../state/stores";
import {
  AmountInput,
  Button,
  DateInput,
  EmptyState,
  Field,
  Modal,
  Money,
  Panel,
  Select,
  SkeletonRows,
  TextInput,
} from "../components/ui";
import { inputCls } from "../components/inputStyles";
import {
  ItemPicker,
  LedgerPicker,
} from "../components/pickers";
import { useLedgers, useStockItems } from "../components/pickerHooks";
import {
  BillingSchedulesModal,
  CustomerOperationsModal,
  DiscountPoliciesModal,
  PricingModal,
} from "./SalesControls";

const KINDS: { id: SalesDocumentKind; label: string; singular: string }[] = [
  { id: "quotation", label: "Quotations", singular: "Quotation" },
  { id: "order", label: "Sales orders", singular: "Sales order" },
  { id: "challan", label: "Delivery challans", singular: "Delivery challan" },
  { id: "proforma", label: "Proformas", singular: "Proforma invoice" },
];
const terminal = new Set<SalesDocumentStatus>([
  "rejected",
  "cancelled",
  "expired",
  "fulfilled",
  "converted",
  "returned",
]);
const statusTone = (status: SalesDocumentStatus): string =>
  terminal.has(status)
    ? "border-line bg-panel2 text-muted"
    : status === "part_fulfilled"
      ? "border-amber/35 bg-amber/8 text-ink"
      : status === "draft"
        ? "border-line bg-panel2 text-muted"
        : "border-dr/25 bg-dr/5 text-dr";
const qty = (value: number): string =>
  (value / 1000).toLocaleString("en-IN", { maximumFractionDigits: 3 });

export function SalesDocumentsScreen(): React.JSX.Element {
  const [kind, setKind] = useState<SalesDocumentKind>("quotation");
  const [createOpen, setCreateOpen] = useState(false);
  const [seriesOpen, setSeriesOpen] = useState(false);
  const [billingOpen, setBillingOpen] = useState(false);
  const [pricingOpen, setPricingOpen] = useState(false);
  const [discountOpen, setDiscountOpen] = useState(false);
  const [customerOpsOpen, setCustomerOpsOpen] = useState(false);
  const [convertDoc, setConvertDoc] = useState<SalesDocument | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const queryClient = useQueryClient(),
    toast = useToasts(),
    nav = useNav();
  const query = useQuery({
    queryKey: ["salesDocuments", kind],
    queryFn: () => api.salesDocuments.list(kind),
  });
  const documents = query.data ?? [];
  useEffect(() => {
    setSelectedId(documents[0]?.id ?? null);
  }, [kind, query.data]);
  const selected =
    documents.find((row) => row.id === selectedId) ?? documents[0] ?? null;
  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ["salesDocuments"] });
    await queryClient.invalidateQueries({ queryKey: ["salesDocumentSeries"] });
  };
  const move = async (
    doc: SalesDocument,
    status: SalesDocumentStatus,
  ): Promise<void> => {
    try {
      await api.salesDocuments.setStatus(doc.id, status);
      await refresh();
      toast.push("success", `${doc.number} marked ${status.replace("_", " ")}`);
    } catch (error) {
      toast.push("error", (error as Error).message);
    }
  };
  const metrics = useMemo(
    () => ({
      open: documents.filter((row) => !terminal.has(row.status)).length,
      value: documents
        .filter((row) => !terminal.has(row.status))
        .reduce((sum, row) => sum + row.totals.totalAmount, 0),
      partial: documents.filter((row) => row.status === "part_fulfilled")
        .length,
    }),
    [documents],
  );
  return (
    <div className="mx-auto max-w-7xl" data-testid="sales-documents">
      <div className="mb-4 flex items-start justify-between">
        <div>
          <p className="text-[9px] font-semibold uppercase tracking-[.15em] text-amber">
            Revenue operations
          </p>
          <h2 className="mt-1 text-[22px] font-semibold tracking-[-.025em]">
            Sales desk
          </h2>
          <p className="mt-1 text-[11px] text-muted">
            Quote, commit, deliver and prepare invoices without posting the
            books early.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            data-testid="btn-sales-recurring"
            onClick={() => setBillingOpen(true)}
          >
            Recurring
          </Button>
          <Button onClick={() => setPricingOpen(true)}>Pricing</Button>
          <Button onClick={() => setDiscountOpen(true)}>Discounts</Button>
          <Button
            data-testid="btn-customer-operations"
            onClick={() => setCustomerOpsOpen(true)}
          >
            Customer ops
          </Button>
          <Button onClick={() => setSeriesOpen(true)}>Numbering</Button>
          <Button
            variant="primary"
            data-testid="btn-sales-document-new"
            onClick={() => setCreateOpen(true)}
          >
            New {KINDS.find((row) => row.id === kind)!.singular.toLowerCase()}
          </Button>
        </div>
      </div>
      <div className="mb-3 grid grid-cols-[1.25fr_repeat(3,minmax(0,1fr))] gap-px overflow-hidden rounded-lg border border-line bg-line">
        <div className="bg-ink px-4 py-3 text-canvas">
          <p className="text-[9px] font-semibold uppercase tracking-[.12em] text-canvas/60">
            Pipeline
          </p>
          <p className="mt-2 text-[15px] font-semibold">
            {KINDS.find((row) => row.id === kind)!.label}
          </p>
          <p className="mt-1 text-[10px] text-canvas/60">
            Live operational documents
          </p>
        </div>
        <Metric
          label="Open"
          value={String(metrics.open)}
          detail={`${documents.length} total`}
        />
        <Metric
          label="Open value"
          value={formatPaise(metrics.value, { symbol: true })}
          detail="tax inclusive"
        />
        <Metric
          label="Partial"
          value={String(metrics.partial)}
          detail="needs follow-through"
        />
      </div>
      <div className="mb-3 flex rounded-md border border-line bg-panel p-0.5">
        {KINDS.map((item) => (
          <button
            key={item.id}
            data-testid={`tab-sales-${item.id}`}
            onClick={() => setKind(item.id)}
            className={`flex-1 rounded px-3 py-2 text-[11px] ${kind === item.id ? "bg-ink font-semibold text-canvas" : "text-muted hover:text-ink"}`}
          >
            {item.label}
            <span className="ml-2 font-mono text-[9px] opacity-60">
              {kind === item.id ? documents.length : ""}
            </span>
          </button>
        ))}
      </div>
      <div className="grid min-h-[470px] grid-cols-[minmax(0,1.1fr)_minmax(340px,.9fr)] gap-3">
        <Panel className="overflow-hidden p-0">
          {query.isLoading ? (
            <div className="p-4">
              <SkeletonRows rows={8} />
            </div>
          ) : !documents.length ? (
            <EmptyState
              title={`No ${KINDS.find((row) => row.id === kind)!.label.toLowerCase()} yet`}
              hint="Start the document chain here; nothing reaches the books until an invoice is posted."
              action={
                <Button variant="primary" onClick={() => setCreateOpen(true)}>
                  Create first document
                </Button>
              }
            />
          ) : (
            <table className="ledger-table">
              <thead>
                <tr>
                  <th>Document</th>
                  <th>Customer</th>
                  <th>Status</th>
                  <th className="r">Open qty</th>
                  <th className="r">Value</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((doc) => (
                  <tr
                    key={doc.id}
                    onClick={() => setSelectedId(doc.id)}
                    className={`cursor-pointer ${selected?.id === doc.id ? "bg-amber/8" : ""}`}
                    data-testid={`sales-document-row-${doc.id}`}
                  >
                    <td>
                      <p className="font-mono font-semibold">{doc.number}</p>
                      <p className="mt-0.5 text-[9px] text-muted">
                        {toDisplayDate(doc.date)} · rev {doc.revisionNo}
                      </p>
                    </td>
                    <td>{doc.partyName}</td>
                    <td>
                      <Status status={doc.status} />
                    </td>
                    <td className="r num">
                      {qty(
                        doc.lines.reduce(
                          (sum, line) => sum + line.openQtyMilli,
                          0,
                        ),
                      )}
                    </td>
                    <td className="r">
                      <Money paise={doc.totals.totalAmount} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
        <Panel className="p-0">
          {selected ? (
            <DocumentDetail
              doc={selected}
              onMove={move}
              onConvert={() => setConvertDoc(selected)}
              onOpenDraft={(id) =>
                nav.go({ name: "voucher-entry", workDraftId: id })
              }
            />
          ) : (
            <div className="p-8">
              <EmptyState
                title="Select a document"
                hint="Details, lineage and next actions appear here."
              />
            </div>
          )}
        </Panel>
      </div>
      {createOpen && (
        <DocumentModal
          kind={kind}
          onClose={() => setCreateOpen(false)}
          onSaved={async () => {
            setCreateOpen(false);
            await refresh();
          }}
        />
      )}
      {seriesOpen && (
        <SeriesModal
          kind={kind}
          onClose={() => setSeriesOpen(false)}
          onSaved={refresh}
        />
      )}
      {billingOpen && (
        <BillingSchedulesModal
          onClose={() => setBillingOpen(false)}
          onOpenDrafts={() => nav.go({ name: "voucher-drafts" })}
        />
      )}
      {pricingOpen && <PricingModal onClose={() => setPricingOpen(false)} />}
      {discountOpen && (
        <DiscountPoliciesModal onClose={() => setDiscountOpen(false)} />
      )}
      {customerOpsOpen && (
        <CustomerOperationsModal
          onClose={() => setCustomerOpsOpen(false)}
          onOpenDraft={(id) =>
            nav.go({ name: "voucher-entry", workDraftId: id })
          }
        />
      )}
      {convertDoc && (
        <ConversionModal
          doc={convertDoc}
          onClose={() => setConvertDoc(null)}
          onSaved={async (draftId) => {
            setConvertDoc(null);
            await refresh();
            if (draftId)
              nav.go({ name: "voucher-entry", workDraftId: draftId });
          }}
        />
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}): React.JSX.Element {
  return (
    <div className="bg-panel px-4 py-3">
      <p className="text-[9px] font-semibold uppercase tracking-[.1em] text-muted">
        {label}
      </p>
      <p className="mt-2 truncate font-mono text-[18px] font-semibold">
        {value}
      </p>
      <p className="mt-1 text-[9px] text-muted">{detail}</p>
    </div>
  );
}
function Status({
  status,
}: {
  status: SalesDocumentStatus;
}): React.JSX.Element {
  return (
    <span
      className={`inline-flex rounded border px-2 py-1 text-[9px] font-semibold uppercase tracking-[.05em] ${statusTone(status)}`}
    >
      {status.replace("_", " ")}
    </span>
  );
}

function DocumentDetail({
  doc,
  onMove,
  onConvert,
  onOpenDraft,
}: {
  doc: SalesDocument;
  onMove: (doc: SalesDocument, status: SalesDocumentStatus) => void;
  onConvert: () => void;
  onOpenDraft: (id: number) => void;
}): React.JSX.Element {
  const primary =
    doc.status === "draft"
      ? doc.kind === "quotation" || doc.kind === "proforma"
        ? "sent"
        : doc.kind === "order"
          ? "confirmed"
          : "approved"
      : doc.status === "sent"
        ? "accepted"
        : null;
  const convertible =
    doc.kind === "quotation" || doc.kind === "proforma"
      ? ["accepted", "part_fulfilled"].includes(doc.status)
      : doc.kind === "order"
        ? ["confirmed", "part_fulfilled"].includes(doc.status)
        : ["approved", "part_fulfilled"].includes(doc.status);
  const cancel = (
    SALES_STATUS_TRANSITIONS[doc.kind][doc.status] ?? []
  ).includes("cancelled");
  return (
    <div data-testid="sales-document-detail">
      <div className="border-b border-line p-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="font-mono text-[17px] font-semibold">{doc.number}</p>
            <p className="mt-1 text-[10px] text-muted">
              {doc.partyName} · {toDisplayDate(doc.date)}
            </p>
          </div>
          <Status status={doc.status} />
        </div>
        {doc.purpose && (
          <p className="mt-3 text-[11.5px] leading-relaxed">{doc.purpose}</p>
        )}
      </div>
      <div className="max-h-[270px] overflow-y-auto">
        <table className="ledger-table">
          <thead>
            <tr>
              <th>Line</th>
              <th className="r">Qty</th>
              <th className="r">Open</th>
              <th className="r">Amount</th>
            </tr>
          </thead>
          <tbody>
            {doc.lines.map((line) => (
              <tr key={line.id}>
                <td>
                  <p className="font-medium">{line.description}</p>
                  <p className="mt-0.5 text-[9px] text-muted">
                    {line.gstRate}% GST · {line.discountBps / 100}% discount
                  </p>
                </td>
                <td className="r num">{qty(line.qtyMilli)}</td>
                <td
                  className={`r num ${line.openQtyMilli ? "text-amber" : "text-muted"}`}
                >
                  {qty(line.openQtyMilli)}
                </td>
                <td className="r">
                  <Money paise={line.totalAmount} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t border-line p-4">
        <div className="mb-3 flex justify-between text-[11px]">
          <span className="text-muted">
            Taxable{" "}
            <span className="ml-1 num text-ink">
              {formatPaise(doc.totals.taxableAmount)}
            </span>
          </span>
          <span className="font-semibold">
            Total <Money paise={doc.totals.totalAmount} className="ml-1" />
          </span>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {cancel && (
            <Button variant="ghost" onClick={() => onMove(doc, "cancelled")}>
              Cancel
            </Button>
          )}
          {doc.status === "sent" && (
            <Button onClick={() => onMove(doc, "rejected")}>Reject</Button>
          )}
          {primary && (
            <Button
              variant="primary"
              data-testid="btn-sales-document-advance"
              onClick={() => onMove(doc, primary)}
            >
              {primary === "sent"
                ? "Send"
                : primary === "accepted"
                  ? "Accept"
                  : primary === "confirmed"
                    ? "Confirm order"
                    : "Approve challan"}
            </Button>
          )}
          {convertible && (
            <Button
              variant="primary"
              data-testid="btn-sales-document-convert"
              onClick={onConvert}
            >
              Convert open qty
            </Button>
          )}
          {doc.invoiceDraftId && (
            <Button
              variant="primary"
              onClick={() => onOpenDraft(doc.invoiceDraftId!)}
            >
              Open invoice draft
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

interface EditLine extends SalesDocumentLineInput {
  key: number;
}
let lineKey = 0;
const blankLine = (): EditLine => ({
  key: ++lineKey,
  stockItemId: null,
  description: "",
  qtyMilli: 1000,
  rate: 0,
  discountBps: 0,
  gstRate: 18,
  optional: false,
  metadata: {},
});

function DocumentModal({
  kind,
  onClose,
  onSaved,
}: {
  kind: SalesDocumentKind;
  onClose: () => void;
  onSaved: () => void;
}): React.JSX.Element {
  const { workingDate } = useSession(),
    toast = useToasts(),
    items = useStockItems(),
    ledgers = useLedgers();
  const [partyLedgerId, setParty] = useState<number | null>(null),
    [date, setDate] = useState(workingDate || todayISO()),
    [validUntil, setValidUntil] = useState<string | null>(
      kind === "quotation" || kind === "proforma" ? workingDate : null,
    ),
    [purpose, setPurpose] = useState(""),
    [terms, setTerms] = useState("Payment due as agreed"),
    [lines, setLines] = useState<EditLine[]>([blankLine()]),
    [saving, setSaving] = useState(false),
    [customFields, setCustomFields] = useState<Record<string, string>>({});
  const fieldDefs = useQuery({
    queryKey: ["salesCustomFields"],
    queryFn: api.customerOperations.customFields,
  });
  const applicableFields = (fieldDefs.data ?? []).filter(
    (field) => field.active && (!field.documentKind || field.documentKind === kind),
  );
  const series = useQuery({
    queryKey: ["salesDocumentSeries", kind],
    queryFn: () => api.salesDocuments.series(kind),
  });
  const [seriesId, setSeriesId] = useState<number | null>(null);
  useEffect(() => {
    if (!seriesId && series.data?.[0]) setSeriesId(series.data[0].id);
  }, [series.data, seriesId]);
  const preview = useQuery({
    queryKey: ["salesDocumentNumber", seriesId, date],
    queryFn: () => api.salesDocuments.numberPreview(seriesId!, date),
    enabled: !!seriesId,
  });
  const update = (key: number, patch: Partial<EditLine>): void =>
    setLines((rows) =>
      rows.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    );
  const issues = [
    !partyLedgerId ? "Choose a customer" : null,
    !seriesId ? "Choose a number series" : null,
    ...applicableFields.map((field) =>
      field.required && !customFields[field.fieldKey]?.trim()
        ? `${field.label} is required`
        : null,
    ),
    ...lines.flatMap((line, index) => [
      !line.stockItemId && !line.description.trim()
        ? `Line ${index + 1}: choose an item or add a description`
        : null,
      line.qtyMilli <= 0 ? `Line ${index + 1}: enter quantity` : null,
    ]),
  ].filter(Boolean) as string[];
  const save = async (): Promise<void> => {
    if (issues.length || !partyLedgerId || !seriesId) return;
    setSaving(true);
    try {
      const data: SalesDocumentInput = {
        kind,
        seriesId,
        partyLedgerId,
        date,
        validUntil,
        purpose: purpose.trim() || null,
        gstRegistrationId: null,
        terms: terms
          .split("\n")
          .map((row) => row.trim())
          .filter(Boolean),
        customFields,
        lines: lines.map(({ key: _key, ...line }) => line),
      };
      const created = await api.salesDocuments.create(data);
      toast.push(
        "success",
        `${created.number} created — ${formatPaise(created.totals.totalAmount, { symbol: true })}`,
      );
      onSaved();
    } catch (error) {
      toast.push("error", (error as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      title={`New ${KINDS.find((row) => row.id === kind)!.singular}`}
      onClose={onClose}
      wide
      dirty={!!partyLedgerId || lines.some((line) => line.stockItemId != null)}
    >
      <div className="grid grid-cols-4 gap-3">
        <Field label="Customer">
          <LedgerPicker
            value={partyLedgerId}
            onPick={setParty}
            autoFocus
            testId="picker-sales-customer"
          />
        </Field>
        <Field label="Date">
          <DateInput
            value={date}
            context={workingDate}
            onChange={setDate}
            testId="input-sales-date"
          />
        </Field>
        <Field label="Series">
          <Select
            value={seriesId ?? ""}
            onChange={(event) =>
              setSeriesId(Number(event.target.value) || null)
            }
          >
            {series.data?.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Next number">
          <div className="rounded-md border border-line bg-panel2 px-2.5 py-1.5 font-mono text-body">
            {preview.data?.number ?? "—"}
          </div>
        </Field>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <Field label="Purpose / reference">
          <TextInput
            value={purpose}
            onChange={(event) => setPurpose(event.target.value)}
            placeholder="Campaign, enquiry or PO reference"
          />
        </Field>
        <Field label="Valid until">
          <input
            type="date"
            className={inputCls}
            value={validUntil ?? ""}
            onChange={(event) => setValidUntil(event.target.value || null)}
          />
        </Field>
      </div>
      <div className="mt-4 overflow-visible rounded-md border border-line">
        <table className="ledger-table">
          <thead>
            <tr>
              <th className="w-[32%]">Item / description</th>
              <th className="r">Qty</th>
              <th className="r">Rate</th>
              <th className="r">Disc %</th>
              <th className="r">GST %</th>
              <th className="r">Total</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.key}>
                <td>
                  <ItemPicker
                    value={line.stockItemId}
                    onPick={(id) => {
                      const item = items.find((row) => row.id === id);
                      update(line.key, {
                        stockItemId: id,
                        description: item?.name ?? line.description,
                        gstRate: item?.gstRate ?? line.gstRate,
                      });
                      const priceLevelId = ledgers.find(
                        (row) => row.id === partyLedgerId,
                      )?.priceLevelId;
                      if (id && priceLevelId)
                        void api.priceLevels
                          .rateFor(priceLevelId, id, date)
                          .then((rate) => {
                            if (rate != null) update(line.key, { rate });
                          })
                          .catch(() => {});
                    }}
                    testId={`picker-sales-item-${line.key}`}
                  />
                  {!line.stockItemId && (
                    <TextInput
                      className="mt-1"
                      value={line.description}
                      onChange={(event) =>
                        update(line.key, { description: event.target.value })
                      }
                      placeholder="Service or free-text line"
                    />
                  )}
                </td>
                <td>
                  <TextInput
                    className="num text-right"
                    value={String(line.qtyMilli / 1000)}
                    onChange={(event) =>
                      update(line.key, {
                        qtyMilli: Math.round(
                          (Number(event.target.value) || 0) * 1000,
                        ),
                      })
                    }
                  />
                </td>
                <td>
                  <AmountInput
                    paise={line.rate}
                    onPaise={(rate) => update(line.key, { rate: rate ?? 0 })}
                    testId={`input-sales-rate-${line.key}`}
                  />
                </td>
                <td>
                  <TextInput
                    className="num text-right"
                    value={String(line.discountBps / 100)}
                    onChange={(event) =>
                      update(line.key, {
                        discountBps: Math.round(
                          (Number(event.target.value) || 0) * 100,
                        ),
                      })
                    }
                  />
                </td>
                <td>
                  <TextInput
                    className="num text-right"
                    value={String(line.gstRate)}
                    onChange={(event) =>
                      update(line.key, {
                        gstRate: Number(event.target.value) || 0,
                      })
                    }
                  />
                </td>
                <td className="r">
                  <Money paise={salesLineAmounts(line).totalAmount} />
                </td>
                <td>
                  <Button
                    variant="ghost"
                    disabled={lines.length === 1}
                    onClick={() =>
                      setLines((rows) =>
                        rows.filter((row) => row.key !== line.key),
                      )
                    }
                  >
                    ×
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button
          className="w-full border-t border-line px-3 py-2 text-left text-[10px] font-semibold text-amber hover:bg-amber/5"
          onClick={() => setLines((rows) => [...rows, blankLine()])}
        >
          + Add another line
        </button>
      </div>
      <div className="mt-3">
        <Field label="Terms — one per line">
          <textarea
            className={`${inputCls} min-h-16`}
            value={terms}
            onChange={(event) => setTerms(event.target.value)}
          />
        </Field>
      </div>
      {applicableFields.length > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-3 rounded-md border border-line bg-panel2 p-3">
          {applicableFields.map((field) => (
            <Field key={field.id} label={`${field.label}${field.required ? " *" : ""}`}>
              {field.dataType === "choice" ? (
                <Select
                  value={customFields[field.fieldKey] ?? ""}
                  onChange={(event) =>
                    setCustomFields((values) => ({ ...values, [field.fieldKey]: event.target.value }))
                  }
                >
                  <option value="">Select…</option>
                  {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
                </Select>
              ) : (
                <TextInput
                  type={field.dataType === "date" ? "date" : field.dataType === "number" ? "number" : "text"}
                  value={customFields[field.fieldKey] ?? ""}
                  onChange={(event) =>
                    setCustomFields((values) => ({ ...values, [field.fieldKey]: event.target.value }))
                  }
                />
              )}
            </Field>
          ))}
        </div>
      )}
      {issues.length > 0 && (
        <p className="mt-3 text-[10.5px] text-cr">{issues.join(" · ")}</p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          data-testid="btn-sales-document-save"
          disabled={saving || issues.length > 0}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Create document"}
        </Button>
      </div>
    </Modal>
  );
}

function ConversionModal({
  doc,
  onClose,
  onSaved,
}: {
  doc: SalesDocument;
  onClose: () => void;
  onSaved: (draftId: number | null) => void;
}): React.JSX.Element {
  const toast = useToasts(),
    [date, setDate] = useState(todayISO()),
    [saving, setSaving] = useState(false);
  const choices: ("order" | "challan" | "invoice")[] =
    doc.kind === "quotation"
      ? ["order", "invoice"]
      : doc.kind === "order"
        ? ["challan", "invoice"]
        : ["invoice"];
  const [targetKind, setTargetKind] = useState<"order" | "challan" | "invoice">(
    choices[0]!,
  );
  const series = useQuery({
    queryKey: ["salesDocumentSeries", targetKind],
    queryFn: () =>
      targetKind === "invoice"
        ? Promise.resolve([])
        : api.salesDocuments.series(targetKind),
    enabled: targetKind !== "invoice",
  });
  const [quantities, setQuantities] = useState<Record<number, number>>(() =>
    Object.fromEntries(
      doc.lines
        .filter((line) => line.openQtyMilli > 0)
        .map((line) => [line.id, line.openQtyMilli]),
    ),
  );
  const selected = doc.lines.filter((line) => (quantities[line.id] ?? 0) > 0);
  const convert = async (): Promise<void> => {
    setSaving(true);
    try {
      const result = await api.salesDocuments.convert({
        sourceDocumentId: doc.id,
        targetKind,
        targetSeriesId:
          targetKind === "invoice" ? undefined : series.data?.[0]?.id,
        date,
        lines: selected.map((line) => ({
          sourceLineId: line.id,
          qtyMilli: quantities[line.id]!,
        })),
      });
      toast.push(
        "success",
        result.targetDocument
          ? `${result.targetDocument.number} created`
          : "Invoice draft prepared for review",
      );
      onSaved(result.invoiceDraftId);
    } catch (error) {
      toast.push("error", (error as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal title={`Convert ${doc.number}`} onClose={onClose}>
      <div className="rounded-md border border-line bg-panel2 p-3">
        <p className="text-[11.5px] font-semibold">
          A traceable handoff, not a duplicate
        </p>
        <p className="mt-1 text-[10px] leading-relaxed text-muted">
          Only the selected open quantities move forward. The source stays
          linked and cannot be over-converted.
        </p>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <Field label="Create">
          <Select
            value={targetKind}
            onChange={(event) =>
              setTargetKind(event.target.value as typeof targetKind)
            }
          >
            {choices.map((choice) => (
              <option key={choice} value={choice}>
                {choice === "invoice"
                  ? "Editable sales invoice draft"
                  : KINDS.find((row) => row.id === choice)!.singular}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Document date">
          <input
            className={inputCls}
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
        </Field>
      </div>
      <div className="mt-3 overflow-hidden rounded-md border border-line">
        <table className="ledger-table">
          <thead>
            <tr>
              <th>Line</th>
              <th className="r">Open</th>
              <th className="r">Convert now</th>
            </tr>
          </thead>
          <tbody>
            {doc.lines
              .filter((line) => line.openQtyMilli > 0)
              .map((line) => (
                <tr key={line.id}>
                  <td>{line.description}</td>
                  <td className="r num">{qty(line.openQtyMilli)}</td>
                  <td>
                    <TextInput
                      className="num text-right"
                      value={String((quantities[line.id] ?? 0) / 1000)}
                      onChange={(event) =>
                        setQuantities((all) => ({
                          ...all,
                          [line.id]: Math.min(
                            line.openQtyMilli,
                            Math.max(
                              0,
                              Math.round(
                                (Number(event.target.value) || 0) * 1000,
                              ),
                            ),
                          ),
                        }))
                      }
                    />
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          data-testid="btn-sales-convert-confirm"
          disabled={
            saving ||
            !selected.length ||
            (targetKind !== "invoice" && !series.data?.[0])
          }
          onClick={() => void convert()}
        >
          {saving ? "Converting…" : "Create linked document"}
        </Button>
      </div>
    </Modal>
  );
}

function SeriesModal({
  kind,
  onClose,
  onSaved,
}: {
  kind: SalesDocumentKind;
  onClose: () => void;
  onSaved: () => Promise<void>;
}): React.JSX.Element {
  const query = useQuery({
      queryKey: ["salesDocumentSeries", kind],
      queryFn: () => api.salesDocuments.series(kind),
    }),
    toast = useToasts();
  const current = query.data?.[0];
  const [prefix, setPrefix] = useState(""),
    [suffix, setSuffix] = useState(""),
    [padWidth, setPadWidth] = useState(4),
    [restartFy, setRestart] = useState(true);
  useEffect(() => {
    if (current) {
      setPrefix(current.prefix);
      setSuffix(current.suffix);
      setPadWidth(current.padWidth);
      setRestart(current.restartFy);
    }
  }, [current]);
  const save = async (): Promise<void> => {
    if (!current) return;
    try {
      await api.salesDocuments.saveSeries(
        {
          kind,
          name: current.name,
          prefix,
          suffix,
          padWidth,
          restartFy,
          active: current.active,
        },
        current.id,
      );
      await onSaved();
      toast.push("success", "Number series updated");
      onClose();
    } catch (error) {
      toast.push("error", (error as Error).message);
    }
  };
  return (
    <Modal
      title={`${KINDS.find((row) => row.id === kind)!.singular} numbering`}
      onClose={onClose}
    >
      <p className="mb-3 text-[11px] text-muted">
        Allocated numbers are permanent. Changing this format affects only
        future documents.
      </p>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Prefix">
          <TextInput
            value={prefix}
            onChange={(event) => setPrefix(event.target.value)}
          />
        </Field>
        <Field label="Digits">
          <TextInput
            className="num"
            value={String(padWidth)}
            onChange={(event) =>
              setPadWidth(
                Math.max(0, Math.min(12, Number(event.target.value) || 0)),
              )
            }
          />
        </Field>
        <Field label="Suffix">
          <TextInput
            value={suffix}
            onChange={(event) => setSuffix(event.target.value)}
          />
        </Field>
      </div>
      <label className="mt-3 flex items-center gap-2 text-[11px]">
        <input
          type="checkbox"
          checked={restartFy}
          onChange={(event) => setRestart(event.target.checked)}
        />
        Restart sequence each Indian financial year
      </label>
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          disabled={!current}
          onClick={() => void save()}
        >
          Save future format
        </Button>
      </div>
    </Modal>
  );
}
