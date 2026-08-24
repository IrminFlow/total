import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type ImportKind,
  type ImportPreview,
  type MappingProfile,
  type MigrationDryRun,
} from "../lib/client";
import { useNav, useSession, useToasts } from "../state/stores";
import {
  Button,
  Field,
  Modal,
  Panel,
  SectionTitle,
  Select,
  TextInput,
} from "../components/ui";
import { GST_STATES } from "@shared/gst/states";
import { gstinErrorMessage } from "../lib/gstinError";
import { useUnsavedGuard } from "../lib/useUnsavedGuard";
import { formatPaise } from "@shared/money";
import {
  CheckCircle,
  FileCsv,
  Fingerprint,
  Warning,
} from "@phosphor-icons/react";

const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/;
const TAN_RE = /^[A-Z]{4}\d{5}[A-Z]$/;

export function CompanyInfoScreen(): React.JSX.Element {
  const { info, slug, setCompany } = useSession();
  const toast = useToasts();
  const nav = useNav();
  const setup = useQuery({ queryKey: ["onboarding-status"], queryFn: api.onboarding.status });
  const [name, setName] = useState(info?.name ?? "");
  const [stateCode, setStateCode] = useState(info?.stateCode ?? "27");
  const [gstin, setGstin] = useState(info?.gstin ?? "");
  const [regType, setRegType] = useState(
    info?.gstRegistrationType ?? "unregistered",
  );
  const [address, setAddress] = useState(info?.address ?? "");
  const [email, setEmail] = useState(info?.email ?? "");
  const [phone, setPhone] = useState(info?.phone ?? "");
  const [pan, setPan] = useState(info?.pan ?? "");
  const [tan, setTan] = useState(info?.tan ?? "");

  // Re-seed the form whenever the saved info changes (company switch, save round-trip,
  // Tally import updating details) so the fields never show a stale company's values.
  useEffect(() => {
    setName(info?.name ?? "");
    setStateCode(info?.stateCode ?? "27");
    setGstin(info?.gstin ?? "");
    setRegType(info?.gstRegistrationType ?? "unregistered");
    setAddress(info?.address ?? "");
    setEmail(info?.email ?? "");
    setPhone(info?.phone ?? "");
    setPan(info?.pan ?? "");
    setTan(info?.tan ?? "");
  }, [info]);

  // Guard in-app navigation while the form differs from what's saved.
  const dirty =
    name !== (info?.name ?? "") ||
    stateCode !== (info?.stateCode ?? "27") ||
    gstin !== (info?.gstin ?? "") ||
    regType !== (info?.gstRegistrationType ?? "unregistered") ||
    address !== (info?.address ?? "") ||
    email !== (info?.email ?? "") ||
    phone !== (info?.phone ?? "") ||
    pan !== (info?.pan ?? "") ||
    tan !== (info?.tan ?? "");
  useUnsavedGuard(dirty);

  const gstinError = gstinErrorMessage(gstin, stateCode);
  const panError =
    pan.trim() && !PAN_RE.test(pan.trim())
      ? "Invalid PAN (e.g. ABCDE1234F)"
      : null;
  const tanError =
    tan.trim() && !TAN_RE.test(tan.trim())
      ? "Invalid TAN (e.g. ABCD12345E)"
      : null;

  const save = async (): Promise<void> => {
    try {
      if (gstinError) return void toast.push("error", gstinError);
      if (panError) return void toast.push("error", panError);
      if (tanError) return void toast.push("error", tanError);
      const updated = await api.company.updateInfo({
        name: name.trim(),
        stateCode,
        gstin: gstin.trim() ? gstin.trim().toUpperCase() : null,
        gstRegistrationType: gstin.trim()
          ? regType === "unregistered"
            ? "regular"
            : regType
          : "unregistered",
        address,
        booksFrom: info?.booksFrom ?? 2025,
        email: email.trim() || null,
        phone: phone.trim() || null,
        pan: pan.trim() ? pan.trim().toUpperCase() : null,
        tan: tan.trim() ? tan.trim().toUpperCase() : null,
      });
      if (slug) setCompany(slug, updated);
      toast.push("success", "Company details saved");
    } catch (err) {
      toast.push("error", (err as Error).message);
    }
  };
  const portableExport = async (): Promise<void> => {
    try {
      const result = await api.exporter.portable();
      toast.push(
        "success",
        `Portable exit package saved with ${Object.values(result.counts).reduce((sum, count) => sum + count, 0)} records`,
      );
    } catch (err) {
      toast.push("error", (err as Error).message);
    }
  };

  return (
    <div className="mx-auto max-w-2xl">
      <SectionTitle>Company details</SectionTitle>
      {setup.data && (
        <Panel className="mb-4 overflow-hidden p-0" data-testid="setup-progress">
          <div className="flex items-center justify-between border-b border-line bg-panel2 px-4 py-3">
            <div><p className="text-[12px] font-semibold">Setup health · {setup.data.score}%</p><p className="mt-0.5 text-[9.5px] text-muted">Resumable, local and safe to finish in any order.</p></div>
            <div className="h-1.5 w-36 overflow-hidden rounded bg-line"><div className="h-full bg-amber" style={{ width: `${setup.data.score}%` }} /></div>
          </div>
          <div className="grid grid-cols-7 gap-px bg-line">
            {Object.entries(setup.data.profile.setupSteps).map(([step, done]) => <div key={step} className="bg-panel px-2 py-2 text-center"><p className={done ? 'text-dr' : 'text-muted'}>{done ? '✓' : '○'}</p><p className="mt-0.5 text-[8px] capitalize text-muted">{step.replace(/([A-Z])/g, ' $1')}</p></div>)}
          </div>
          {setup.data.openingRows.length > 0 && (
            <div className={`px-4 py-2 text-[10px] ${setup.data.openingDifference === 0 ? 'text-dr' : 'text-cr'}`}>
              Opening balances · {setup.data.openingRows.length} ledgers · unresolved difference {formatPaise(setup.data.openingDifference)}
            </div>
          )}
          <div className="flex flex-wrap gap-2 border-t border-line px-4 py-3">
            <Button onClick={() => nav.go({ name: 'masters', tab: 'ledgers' })}>Review openings</Button>
            <Button onClick={() => nav.go({ name: 'settings', tab: 'backups' })}>Backups</Button>
            <Button onClick={() => void api.importer.template('ledgers').then(() => toast.push('success', 'Sample ledger template saved')).catch((error: Error) => toast.push('error', error.message))}>Sample import</Button>
            <Button onClick={() => void api.onboarding.exportHandoff().then(() => toast.push('success', 'Accountant handoff saved')).catch((error: Error) => toast.push('error', error.message))}>Export handoff</Button>
            <Button onClick={() => void api.onboarding.importHandoff().then((result) => { if (result) toast.push('success', 'Accountant setup imported') }).catch((error: Error) => toast.push('error', error.message))}>Import handoff…</Button>
          </div>
        </Panel>
      )}
      <button
        data-testid="btn-company-info-invoice-layout"
        onClick={() => nav.go({ name: "settings", tab: "invoice" })}
        className="mb-4 flex w-full items-center justify-between rounded-lg border-2 border-amber/50 bg-amber/10 px-4 py-3.5 text-left transition-colors hover:border-amber hover:bg-amber/15"
      >
        <span>
          <span className="block text-[14px] font-semibold">
            Invoice layout &amp; contents…
          </span>
          <span className="block text-[11.5px] text-muted">
            Logo, declaration, bank details, QR, barcode column, copies to print
          </span>
        </span>
        <span className="text-[15px] text-amber">→</span>
      </button>
      <Panel className="flex flex-col gap-4 p-5">
        <Field label="Name">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="State">
            <Select
              value={stateCode}
              onChange={(e) => setStateCode(e.target.value)}
            >
              {Object.entries(GST_STATES).map(([code, label]) => (
                <option key={code} value={code}>
                  {code} — {label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Registration">
            <Select
              value={regType}
              onChange={(e) => setRegType(e.target.value as typeof regType)}
              disabled={!gstin.trim()}
            >
              <option value="regular">Regular</option>
              <option value="composition">Composition</option>
              <option value="unregistered">Unregistered</option>
            </Select>
          </Field>
        </div>
        <Field label="GSTIN" error={gstinError} hint="Needed for GSTR exports">
          <TextInput
            value={gstin}
            onChange={(e) => setGstin(e.target.value.toUpperCase())}
            className="num"
          />
        </Field>
        <Field label="Address">
          <TextInput
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Email">
            <TextInput
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Phone">
            <TextInput
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="PAN" error={panError} hint="Company's Income Tax PAN">
            <TextInput
              value={pan}
              onChange={(e) => setPan(e.target.value.toUpperCase())}
              className="num"
              maxLength={10}
            />
          </Field>
          <Field label="TAN" error={tanError} hint="Needed for TDS filings">
            <TextInput
              value={tan}
              onChange={(e) => setTan(e.target.value.toUpperCase())}
              className="num"
              maxLength={10}
            />
          </Field>
        </div>
        <div className="flex justify-between">
          <div className="flex gap-2">
            <Button onClick={() => nav.go({ name: "import-tally" })}>
              Import from Tally (XML)
            </Button>
            <Button onClick={() => void portableExport()}>
              Export portable JSON
            </Button>
          </div>
          <Button variant="primary" onClick={() => void save()}>
            Save details
          </Button>
        </div>
      </Panel>
      <p className="mt-3 text-[12px] text-muted">
        Books from FY {info?.booksFrom}-{((info?.booksFrom ?? 0) + 1) % 100}.
        Data lives in ~/Documents/total/companies/{slug} — back it up like any
        folder.
      </p>
      <CsvImportCard />
    </div>
  );
}

const IMPORT_KINDS: { id: ImportKind; label: string }[] = [
  { id: "ledgers", label: "Ledgers" },
  { id: "items", label: "Stock items" },
  { id: "openings", label: "Opening balances" },
  { id: "generic_journal", label: "Balanced journal rows" },
  { id: "busy", label: "Busy transactions" },
  { id: "zoho_books", label: "Zoho Books transactions" },
  { id: "marg", label: "Marg transactions" },
];

function CsvImportCard(): React.JSX.Element {
  const toast = useToasts();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<ImportKind>("ledgers");
  const [fileName, setFileName] = useState<string | null>(null);
  const [sourceDetail, setSourceDetail] = useState<string | null>(null);
  const [csvText, setCsvText] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [dryRun, setDryRun] = useState<MigrationDryRun | null>(null);
  const [profileId, setProfileId] = useState("");
  const [profileOpen, setProfileOpen] = useState(false);
  const [normalizedCsv, setNormalizedCsv] = useState<string | null>(null);
  const [lastBatch, setLastBatch] = useState<number | null>(null);
  const profiles = useQuery({
    queryKey: ["importProfiles"],
    queryFn: api.importer.profiles,
  });
  const [busy, setBusy] = useState(false);

  const reset = (): void => {
    setFileName(null);
    setSourceDetail(null);
    setCsvText(null);
    setPreview(null);
    setDryRun(null);
    setNormalizedCsv(null);
  };

  const pickAndPreview = async (): Promise<void> => {
    try {
      const picked = await api.importer.pickCsv();
      if (!picked) return;
      setBusy(true);
      const profiled = profileId
        ? await api.importer.profilePreview(Number(profileId), picked.csvText)
        : null;
      const p =
        profiled?.preview ?? (await api.importer.preview(kind, picked.csvText));
      setFileName(picked.fileName);
      setSourceDetail(`${picked.sourceFormat.toUpperCase()}${picked.sheetName ? ` · ${picked.sheetName}` : ""}`);
      setCsvText(picked.csvText);
      setPreview(p);
      setDryRun(profiled?.dryRun ?? null);
      setNormalizedCsv(profiled?.normalizedCsv ?? picked.csvText);
    } catch (err) {
      toast.push("error", (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const apply = async (): Promise<void> => {
    if (!csvText) return;
    setBusy(true);
    try {
      const r = profileId
        ? await api.importer.profileApply(Number(profileId), csvText)
        : await api.importer.apply(kind, csvText);
      toast.push(
        "success",
        `Batch #${r.batchId} imported: ${r.created} created, ${r.updated} updated${r.reconciliation.rejectedRows ? `, ${r.reconciliation.rejectedRows} rejected` : ""}`,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["ledgers"] }),
        queryClient.invalidateQueries({ queryKey: ["stockItems"] }),
        queryClient.invalidateQueries({ queryKey: ["groups"] }),
        queryClient.invalidateQueries({ queryKey: ["groupTree"] }),
      ]);
      setLastBatch(r.batchId);
      setPreview(null);
    } catch (err) {
      toast.push("error", (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const downloadTemplate = async (): Promise<void> => {
    try {
      const r = await api.importer.template(kind);
      toast.push("success", `Template saved to ${r.path}`);
    } catch (err) {
      toast.push("error", (err as Error).message);
    }
  };

  const exportErrors = async (): Promise<void> => {
    if (!preview || !normalizedCsv) return;
    const profile = profiles.data?.find((row) => row.id === Number(profileId));
    const errorKind = profile?.targetKind ?? kind;
    try {
      const r = await api.importer.errorWorkbook(
        fileName ?? "import.csv",
        normalizedCsv,
        errorKind,
      );
      toast.push("success", `Error workbook saved to ${r.path}`);
    } catch (err) {
      toast.push("error", (err as Error).message);
    }
  };
  const linkAttachments = async (): Promise<void> => {
    if (!lastBatch || !normalizedCsv) return;
    try {
      const result = await api.importer.attachments(lastBatch, normalizedCsv);
      if (result)
        toast.push(
          result.missing.length ? "info" : "success",
          `${result.linked} attachment(s) linked${result.missing.length ? `; ${result.missing.length} need attention` : ""}`,
        );
    } catch (err) {
      toast.push("error", (err as Error).message);
    }
  };

  const errorsByLine = new Map(
    preview?.errors.map((e) => [e.line, e.message]) ?? [],
  );
  const previewRows = preview?.rows.slice(0, 50) ?? [];
  const columns = previewRows.length
    ? Object.keys(previewRows[0]!).filter((k) => k !== "line")
    : [];

  return (
    <Panel className="mt-4 flex flex-col gap-4 overflow-hidden p-0">
      <div className="flex items-start gap-3 border-b border-line bg-panel2 px-5 py-4">
        <span className="rounded-md border border-line bg-panel p-2 text-blue">
          <FileCsv size={20} weight="duotone" />
        </span>
        <div className="min-w-0 flex-1">
          <SectionTitle
            right={
              <Button variant="ghost" onClick={() => void downloadTemplate()}>
                Download {IMPORT_KINDS.find((k) => k.id === kind)?.label}{" "}
                template
              </Button>
            }
          >
            Import from spreadsheet
          </SectionTitle>
          <p className="mt-1 text-[12px] text-muted">
            Bring masters, opening balances or balanced transactions from Busy,
            Zoho Books, Marg, CSV, TSV or Excel workbooks. The first non-empty
            worksheet is normalized locally; preview and reconcile every row
            before applying.
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-4 px-5 pb-5">
        <div className="flex items-end gap-3">
          <Field label="What to import">
            <Select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as ImportKind);
                reset();
              }}
            >
              {IMPORT_KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Saved mapping profile">
            <Select
              value={profileId}
              onChange={(e) => {
                setProfileId(e.target.value);
                reset();
              }}
            >
              <option value="">Automatic headers</option>
              {(profiles.data ?? [])
                .filter((row) => row.active)
                .map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Button variant="ghost" onClick={() => setProfileOpen(true)}>
            Manage mappings
          </Button>
          <Button onClick={() => void pickAndPreview()} disabled={busy}>
            Pick file…
          </Button>
          {fileName && (
            <span className="text-[12px] text-muted">{fileName}{sourceDetail ? ` · ${sourceDetail}` : ""}</span>
          )}
        </div>

        {preview && (
          <>
            {preview.alreadyImported && (
              <div className="flex items-start gap-2.5 rounded-md border border-cr/35 bg-cr/8 px-3.5 py-3 text-[12.5px]">
                <Warning
                  size={19}
                  weight="fill"
                  className="mt-0.5 shrink-0 text-cr"
                />
                <div>
                  <b>
                    Already imported as batch #{preview.alreadyImported.id}.
                  </b>{" "}
                  This exact file was applied on{" "}
                  {new Date(preview.alreadyImported.appliedAt).toLocaleString()}
                  . Choose another file to prevent duplicate books.
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 border-y border-line sm:grid-cols-4">
              {[
                ["Source rows", preview.reconciliation.sourceRows, "text-ink"],
                ["Accepted", preview.reconciliation.acceptedRows, "text-dr"],
                [
                  "Rejected",
                  preview.reconciliation.rejectedRows,
                  preview.reconciliation.rejectedRows
                    ? "text-cr"
                    : "text-muted",
                ],
                [
                  "Create / update",
                  `${preview.willCreate} / ${preview.willUpdate}`,
                  "text-ink",
                ],
              ].map(([label, value, tone], index) => (
                <div
                  key={String(label)}
                  className={`px-3 py-3 ${index > 0 ? "border-l border-line" : ""}`}
                >
                  <div className={`num text-[18px] font-semibold ${tone}`}>
                    {value}
                  </div>
                  <div className="mt-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-muted">
                    {label}
                  </div>
                </div>
              ))}
            </div>
            {dryRun && (
              <div className="grid grid-cols-3 gap-px overflow-hidden rounded-md border border-line bg-line">
                <div className="bg-panel2 p-3">
                  <p className="text-[9px] uppercase tracking-[0.08em] text-muted">
                    Duplicate risk
                  </p>
                  <p className="mt-1 text-[11.5px] font-medium capitalize">
                    {dryRun.duplicateRisk.replace("_", " ")}
                  </p>
                </div>
                <div className="bg-panel2 p-3">
                  <p className="text-[9px] uppercase tracking-[0.08em] text-muted">
                    Unsupported columns
                  </p>
                  <p className="mt-1 text-[11.5px] font-medium">
                    {dryRun.unsupportedColumns.length || "None"}
                  </p>
                </div>
                <div className="bg-panel2 p-3">
                  <p className="text-[9px] uppercase tracking-[0.08em] text-muted">
                    Estimated vouchers
                  </p>
                  <p className="num mt-1 text-[11.5px] font-medium">
                    {dryRun.estimatedVouchers}
                  </p>
                </div>
              </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-muted">
              <span className="flex items-center gap-1.5">
                <CheckCircle size={15} weight="fill" className="text-dr" /> Rows
                and parsed values reconcile
              </span>
              <span className="num">
                Accepted value{" "}
                {formatPaise(preview.reconciliation.acceptedAmount, {
                  symbol: true,
                })}{" "}
                · Rejected{" "}
                {formatPaise(preview.reconciliation.rejectedAmount, {
                  symbol: true,
                })}
              </span>
            </div>
            <div className="max-h-80 overflow-auto rounded-md border border-line">
              <table className="ledger-table">
                <thead>
                  <tr>
                    <th className="w-14">Line</th>
                    {columns.map((c) => (
                      <th key={c}>{c}</th>
                    ))}
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((row) => {
                    const line = row.line as number;
                    const error = errorsByLine.get(line);
                    return (
                      <tr key={line}>
                        <td className="num text-muted">{line}</td>
                        {columns.map((c) => (
                          <td key={c}>
                            {row[c] == null ? "" : String(row[c])}
                          </td>
                        ))}
                        <td>
                          {error ? (
                            <span className="rounded-full bg-cr/15 px-2 py-0.5 text-[11px] text-cr">
                              {error}
                            </span>
                          ) : (
                            <span className="rounded-full bg-dr/15 px-2 py-0.5 text-[11px] text-dr">
                              OK
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {(() => {
              const shownLines = new Set(
                previewRows.map((r) => r.line as number),
              );
              const hiddenErrorCount = preview.errors.filter(
                (e) => !shownLines.has(e.line),
              ).length;
              return hiddenErrorCount > 0 ? (
                <p className="text-[12px] text-muted">
                  {hiddenErrorCount} more error(s) beyond the rows shown above
                  will still be skipped on apply.
                </p>
              ) : null;
            })()}
            <div className="flex justify-end gap-2">
              {preview.errors.length > 0 && (
                <Button onClick={() => void exportErrors()}>
                  Export error workbook
                </Button>
              )}
              <Button variant="ghost" onClick={reset} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={() => void apply()}
                disabled={
                  busy ||
                  preview.total === 0 ||
                  Boolean(preview.alreadyImported)
                }
              >
                {preview.alreadyImported
                  ? "Already imported"
                  : busy
                    ? "Applying…"
                    : "Apply import"}
              </Button>
            </div>
            <div className="flex items-center gap-1.5 border-t border-line pt-3 text-[10.5px] text-muted">
              <Fingerprint size={14} /> <span>File fingerprint</span>{" "}
              <code className="num truncate">{preview.sourceHash}</code>
            </div>
          </>
        )}
        {lastBatch && !preview && (
          <div className="flex items-center justify-between rounded-md border border-dr/30 bg-dr/5 p-3">
            <span className="text-[11.5px] text-dr">
              Import batch #{lastBatch} completed and can be reconciled from the
              retained receipt.
            </span>
            <Button onClick={() => void linkAttachments()}>
              Link source documents…
            </Button>
          </div>
        )}
      </div>
      {profileOpen && (
        <MappingProfileModal
          onClose={() => setProfileOpen(false)}
          onSaved={async () => {
            await profiles.refetch();
            setProfileOpen(false);
          }}
        />
      )}
    </Panel>
  );
}

function MappingProfileModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => Promise<void>;
}): React.JSX.Element {
  const toast = useToasts();
  const [name, setName] = useState("");
  const [source, setSource] = useState<MappingProfile["sourceKind"]>("generic");
  const [target, setTarget] =
    useState<MappingProfile["targetKind"]>("generic_journal");
  const [mapping, setMapping] = useState(
    "Voucher Group=Voucher No\nDate=Date\nVoucher Type=Voucher Type\nLedger=Ledger\nDebit=Debit\nCredit=Credit\nNarration=Narration",
  );
  const save = async () => {
    const fieldMappings = Object.fromEntries(
      mapping
        .split("\n")
        .map((line) => line.split("=").map((v) => v.trim()))
        .filter((parts) => parts.length === 2 && parts[0] && parts[1]) as [
        string,
        string,
      ][],
    );
    try {
      await api.importer.profileSave({
        name,
        sourceKind: source,
        targetKind: target,
        fieldMappings,
        valueMappings: {},
        dateFormat: "auto",
        active: true,
      });
      toast.push("success", "Mapping profile saved");
      await onSaved();
    } catch (e) {
      toast.push("error", (e as Error).message);
    }
  };
  return (
    <Modal title="New import mapping" onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Profile name">
          <TextInput
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Source">
          <Select
            value={source}
            onChange={(e) => setSource(e.target.value as typeof source)}
          >
            <option value="generic">Generic</option>
            <option value="busy">Busy</option>
            <option value="zoho_books">Zoho Books</option>
            <option value="marg">Marg</option>
          </Select>
        </Field>
        <Field label="Target">
          <Select
            value={target}
            onChange={(e) => setTarget(e.target.value as typeof target)}
          >
            <option value="generic_journal">Balanced journals</option>
            <option value="ledgers">Ledgers / contacts</option>
            <option value="items">Stock items</option>
            <option value="openings">Opening balances</option>
          </Select>
        </Field>
        <div className="col-span-2">
          <Field
            label="Column mappings"
            hint="One Canonical field=Source column per line."
          >
            <textarea
              className="min-h-48 w-full rounded-md border border-line bg-panel2 p-3 font-mono text-[11px]"
              value={mapping}
              onChange={(e) => setMapping(e.target.value)}
            />
          </Field>
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          disabled={!name.trim() || !mapping.includes("=")}
          onClick={() => void save()}
        >
          Save reusable mapping
        </Button>
      </div>
    </Modal>
  );
}
