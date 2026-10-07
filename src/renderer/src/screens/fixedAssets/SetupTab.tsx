// Groups & blocks setup (WP 3.6): asset groups (Companies-Act class, IT block, ledgers), the
// seeded Schedule II useful lives and the IT block rates — every row editable, every seeded row
// carrying its citation.
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { DEP_METHOD_LABELS, type DepMethod } from '@shared/depreciation'
import {
  FIXED_ASSET_SOURCES, formatBp, formatLife, type AssetGroupRow, type CaClassRow, type ItBlockRateRow, type ItBlockRow
} from '@shared/fixedAssets'
import { faApi } from '../../lib/fixedAssetsClient'
import { useToasts } from '../../state/stores'
import { Badge, Banner, Button, Checkbox, Field, Modal, Panel, SectionTitle, Select, TextInput } from '../../components/ui'
import { DataTable, defineColumns } from '../../components/table'
import { LedgerLink } from '../../components/links'
import { LedgerPicker, useGroups } from '../../components/pickers'
import { bpText, parsePercentBp, useFixedAssetLedgerFilters, useRefreshFixedAssets } from './common'

const ledgerCell = (id: number | null, name: string | null, fallback: string): React.JSX.Element =>
  id != null ? <LedgerLink ledgerId={id} name={name ?? ''} /> : <span className="text-muted">{fallback}</span>

export const GROUP_COLUMNS = defineColumns<AssetGroupRow>([
  { id: 'name', header: 'Group', kind: 'text', value: (g) => g.name, hideable: false, groupable: false, minWidth: 160 },
  { id: 'class', header: 'Schedule II class', kind: 'text', value: (g) => g.caClassName ?? '', minWidth: 200, className: 'text-muted' },
  { id: 'life', header: 'Life', kind: 'number', value: (g) => g.lifeMonths, text: (g) => formatLife(g.lifeMonths), width: 110 },
  { id: 'residual', header: 'Residual', kind: 'number', value: (g) => g.residualBp, text: (g) => formatBp(g.residualBp), width: 92 },
  { id: 'method', header: 'Method', kind: 'text', value: (g) => g.method.toUpperCase(), width: 84 },
  { id: 'block', header: 'IT block', kind: 'text', value: (g) => g.itBlockName ?? '', minWidth: 180, className: 'text-muted' },
  { id: 'acc', header: 'Accumulated depreciation', kind: 'text', value: (g) => g.accDepLedgerName ?? '', minWidth: 200, cell: (g) => ledgerCell(g.accDepLedgerId, g.accDepLedgerName, 'Created on first run') },
  { id: 'dep', header: 'Expense', kind: 'text', value: (g) => g.depExpenseLedgerName ?? '', width: 150, cell: (g) => ledgerCell(g.depExpenseLedgerId, g.depExpenseLedgerName, 'Depreciation') },
  { id: 'assets', header: 'Assets', kind: 'number', value: (g) => g.assetCount, width: 80 }
])

export const CLASS_COLUMNS = defineColumns<CaClassRow>([
  { id: 'code', header: 'Part C', kind: 'text', value: (c) => c.code, width: 90, className: 'num' },
  { id: 'name', header: 'Nature of assets', kind: 'text', value: (c) => c.name, hideable: false, groupable: false, minWidth: 260 },
  { id: 'life', header: 'Useful life', kind: 'number', value: (c) => c.lifeMonths, text: (c) => formatLife(c.lifeMonths), width: 120 },
  { id: 'from', header: 'From', kind: 'date', value: (c) => c.effectiveFrom, width: 104 },
  { id: 'to', header: 'To', kind: 'date', value: (c) => c.effectiveTo, width: 104 },
  {
    id: 'source', header: 'Source', kind: 'text', value: (c) => c.source, minWidth: 160, className: 'text-muted',
    cell: (c) => <span title={c.source}>{c.source.includes('UNVERIFIED') ? <Badge tone="warning">Unverified</Badge> : null} {c.source}</span>
  }
])

type RateRow = ItBlockRateRow & { blockName: string; blockCode: string }

export const RATE_COLUMNS = defineColumns<RateRow>([
  { id: 'block', header: 'Block', kind: 'text', value: (r) => r.blockName, hideable: false, minWidth: 240 },
  { id: 'act', header: 'Act', kind: 'enum', value: (r) => r.act, options: [{ value: '1961', label: '1961 Act' }, { value: '2025', label: '2025 Act' }], width: 100 },
  { id: 'from', header: 'From', kind: 'date', value: (r) => r.effectiveFrom, width: 104 },
  { id: 'to', header: 'To', kind: 'date', value: (r) => r.effectiveTo, width: 104 },
  { id: 'rate', header: 'Rate', kind: 'number', value: (r) => r.rateBp, text: (r) => formatBp(r.rateBp), width: 84 },
  { id: 'addl', header: 'Additional', kind: 'number', value: (r) => r.additionalRateBp, text: (r) => (r.additionalRateBp ? formatBp(r.additionalRateBp) : '—'), width: 100 },
  { id: 'section', header: 'Section / rule', kind: 'text', value: (r) => r.sectionRef, minWidth: 200, className: 'text-muted', cell: (r) => <span title={r.source}>{r.sectionRef}</span> }
])

export function SetupTab(): React.JSX.Element {
  const { data: groups = [] } = useQuery({ queryKey: ['faGroups'], queryFn: faApi.groups })
  const { data: classes = [] } = useQuery({ queryKey: ['faClasses'], queryFn: faApi.classes })
  const { data: blocks = [] } = useQuery({ queryKey: ['faBlocks'], queryFn: faApi.blocks })
  const [editGroup, setEditGroup] = useState<AssetGroupRow | 'new' | null>(null)
  const [editClass, setEditClass] = useState<CaClassRow | 'new' | null>(null)
  const [editRate, setEditRate] = useState<RateRow | 'new' | null>(null)
  const rates = useMemo<RateRow[]>(() => blocks.flatMap((b) => b.rates.map((r) => ({ ...r, blockName: b.name, blockCode: b.code }))), [blocks])

  return (
    <div className="flex flex-col gap-section">
      <div>
        <SectionTitle right={<Button size="sm" data-testid="btn-fixed-assets-new-group" onClick={() => setEditGroup('new')}>New group</Button>}>Asset groups</SectionTitle>
        <Panel>
          <DataTable
            viewId="fixed-assets-groups"
            testId="fixed-assets-groups"
            ariaLabel="Asset groups"
            columns={GROUP_COLUMNS}
            rows={groups}
            rowKey={(g) => g.id}
            rowAttrs={(g) => ({ 'data-row-id': g.id })}
            onRowActivate={(g) => setEditGroup(g)}
            maxHeight="40vh"
            exportOptions={{ title: 'Fixed asset groups', periodLabel: 'Master data', filename: 'fixed-asset-groups' }}
          />
        </Panel>
      </div>
      <div>
        <SectionTitle right={<Button size="sm" onClick={() => setEditClass('new')}>New class</Button>}>Schedule II useful lives (Companies Act, 2013)</SectionTitle>
        <Panel>
          <DataTable
            viewId="fixed-assets-classes"
            testId="fixed-assets-classes"
            ariaLabel="Schedule II useful lives"
            columns={CLASS_COLUMNS}
            rows={classes}
            rowKey={(c) => c.id}
            onRowActivate={(c) => setEditClass(c)}
            maxHeight="40vh"
            exportOptions={{ title: 'Schedule II useful lives', periodLabel: 'Master data', filename: 'schedule-ii-lives' }}
          />
        </Panel>
      </div>
      <div>
        <SectionTitle right={<Button size="sm" onClick={() => setEditRate('new')}>New rate</Button>}>Income-tax blocks and rates</SectionTitle>
        <Panel>
          <DataTable
            viewId="fixed-assets-rates"
            testId="fixed-assets-rates"
            ariaLabel="Income-tax block rates"
            columns={RATE_COLUMNS}
            rows={rates}
            rowKey={(r) => r.id}
            onRowActivate={(r) => setEditRate(r)}
            maxHeight="40vh"
            exportOptions={{ title: 'Income-tax depreciation rates', periodLabel: 'Master data', filename: 'it-depreciation-rates' }}
          />
        </Panel>
      </div>
      <Panel className="p-panel">
        <p className="mb-2 text-body-sm font-medium">Sources (accessed 7 Oct 2026)</p>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-hint text-muted">
          {FIXED_ASSET_SOURCES.map((s) => (
            <li key={s.key}>{s.title} — <span className="num">{s.url}</span></li>
          ))}
          <li>
            No &ldquo;assets up to ₹5,000 written off in full&rdquo; rule is applied: it was in Schedule XIV of the 1956 Act, not in
            Schedule II (ICAI GN(A) 35 ¶56–58). A company may adopt a materiality threshold as its own policy.
          </li>
          <li>Rows marked Unverified (and the migration-026 notes) list what could not be checked against the official text.</li>
        </ul>
      </Panel>
      {editGroup && <GroupModal group={editGroup === 'new' ? null : editGroup} classes={classes} blocks={blocks} onClose={() => setEditGroup(null)} />}
      {editClass && <ClassModal row={editClass === 'new' ? null : editClass} onClose={() => setEditClass(null)} />}
      {editRate && <RateModal row={editRate === 'new' ? null : editRate} blocks={blocks} onClose={() => setEditRate(null)} />}
    </div>
  )
}

function GroupModal({ group, classes, blocks, onClose }: { group: AssetGroupRow | null; classes: CaClassRow[]; blocks: ItBlockRow[]; onClose: () => void }): React.JSX.Element {
  const toast = useToasts()
  const refresh = useRefreshFixedAssets()
  const filters = useFixedAssetLedgerFilters()
  const allGroups = useGroups()
  const expenseFilter = useMemo(() => {
    const nature = new Map(allGroups.map((g) => [g.id, g.nature]))
    return (l: { groupId: number }) => nature.get(l.groupId) === 'expense'
  }, [allGroups])
  const [name, setName] = useState(group?.name ?? '')
  const [caClassId, setCaClassId] = useState<number | null>(group?.caClassId ?? null)
  const [life, setLife] = useState(String(group?.lifeMonths ?? 60))
  const [residual, setResidual] = useState(bpText(group?.residualBp ?? 500))
  const [method, setMethod] = useState<DepMethod>(group?.method ?? 'slm')
  const [itBlockId, setItBlockId] = useState<number | null>(group?.itBlockId ?? null)
  const [assetLedgerId, setAssetLedgerId] = useState<number | null>(group?.assetLedgerId ?? null)
  const [accDepLedgerId, setAccDepLedgerId] = useState<number | null>(group?.accDepLedgerId ?? null)
  const [depExpenseLedgerId, setDepExpenseLedgerId] = useState<number | null>(group?.depExpenseLedgerId ?? null)
  const [postPerAsset, setPostPerAsset] = useState(group?.postPerAsset ?? false)
  const [error, setError] = useState<string | null>(null)
  const pickClass = (id: number | null): void => {
    setCaClassId(id)
    const c = classes.find((x) => x.id === id)
    if (c) setLife(String(c.lifeMonths))
  }
  const save = async (): Promise<void> => {
    const residualBp = parsePercentBp(residual)
    const lifeMonths = Number(life)
    if (!name.trim()) return setError('Name the group')
    if (residualBp == null) return setError('Residual value must be a percentage')
    if (!Number.isInteger(lifeMonths) || lifeMonths < 1) return setError('Useful life must be a whole number of months')
    try {
      await faApi.groupSave({ name: name.trim(), caClassId, lifeMonths, residualBp, method, itBlockId, assetLedgerId, accDepLedgerId, depExpenseLedgerId, postPerAsset }, group?.id)
      await refresh()
      toast.push('success', group ? 'Group saved' : 'Group added')
      onClose()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const remove = async (): Promise<void> => {
    try {
      await faApi.groupDelete(group!.id)
      await refresh()
      onClose()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <Modal title={group ? `Asset group — ${group.name}` : 'New asset group'} onClose={onClose} wide>
      <div className="grid grid-cols-3 gap-3" data-testid="fixed-assets-group-form">
        <Field label="Name" className="col-span-1"><TextInput data-testid="input-fixed-assets-group-name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Schedule II class" className="col-span-2">
          <Select value={caClassId ?? ''} onChange={(e) => pickClass(e.target.value ? Number(e.target.value) : null)}>
            <option value="">None</option>
            {classes.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name} ({formatLife(c.lifeMonths)})</option>)}
          </Select>
        </Field>
        <Field label="Useful life (months)" hint={Number(life) > 0 ? formatLife(Number(life)) : undefined}><TextInput className="num" value={life} onChange={(e) => setLife(e.target.value)} /></Field>
        <Field label="Residual value %"><TextInput className="num" value={residual} onChange={(e) => setResidual(e.target.value)} /></Field>
        <Field label="Method">
          <Select value={method} onChange={(e) => setMethod(e.target.value as DepMethod)}>
            {(['slm', 'wdv'] as const).map((m) => <option key={m} value={m}>{DEP_METHOD_LABELS[m]}</option>)}
          </Select>
        </Field>
        <Field label="IT block" className="col-span-3">
          <Select value={itBlockId ?? ''} onChange={(e) => setItBlockId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">None</option>
            {blocks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        </Field>
        <Field label="Default asset ledger"><LedgerPicker value={assetLedgerId} onPick={setAssetLedgerId} filter={filters.asset} placeholder="Optional" /></Field>
        <Field label="Accumulated depreciation ledger" hint="Blank = created on the first run"><LedgerPicker value={accDepLedgerId} onPick={setAccDepLedgerId} filter={filters.accDep} placeholder="Created on first run" /></Field>
        <Field label="Depreciation expense ledger" hint="Blank = 'Depreciation'"><LedgerPicker value={depExpenseLedgerId} onPick={setDepExpenseLedgerId} filter={expenseFilter} placeholder="Depreciation" /></Field>
        <div className="col-span-3">
          <Checkbox label="Post one credit line per asset" hint="Otherwise one line per accumulated-depreciation ledger" checked={postPerAsset} onChange={setPostPerAsset} />
        </div>
      </div>
      {error && <p className="mt-3 text-body-sm text-danger" role="alert">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        {group && group.assetCount === 0 && <Button variant="danger" onClick={() => void remove()}>Delete group</Button>}
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" data-testid="btn-fixed-assets-group-save" onClick={() => void save()}>Save group</Button>
      </div>
    </Modal>
  )
}

function ClassModal({ row, onClose }: { row: CaClassRow | null; onClose: () => void }): React.JSX.Element {
  const toast = useToasts()
  const refresh = useRefreshFixedAssets()
  const [code, setCode] = useState(row?.code ?? '')
  const [name, setName] = useState(row?.name ?? '')
  const [life, setLife] = useState(String(row?.lifeMonths ?? ''))
  const [from, setFrom] = useState(row?.effectiveFrom ?? '2014-04-01')
  const [to, setTo] = useState(row?.effectiveTo ?? '')
  const [source, setSource] = useState(row?.source ?? '')
  const save = async (): Promise<void> => {
    try {
      await faApi.classSave({ code, name, lifeMonths: Number(life), effectiveFrom: from, effectiveTo: to || null, source }, row?.id)
      await refresh()
      onClose()
    } catch (e) {
      toast.push('error', (e as Error).message)
    }
  }
  return (
    <Modal title={row ? `Schedule II — ${row.code}` : 'New Schedule II class'} onClose={onClose} wide>
      <div className="grid grid-cols-4 gap-3">
        <Field label="Part C ref"><TextInput value={code} onChange={(e) => setCode(e.target.value)} /></Field>
        <Field label="Nature of assets" className="col-span-3"><TextInput value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Life (months)"><TextInput className="num" value={life} onChange={(e) => setLife(e.target.value)} /></Field>
        <Field label="Effective from" hint="YYYY-MM-DD"><TextInput className="num" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="Effective to" hint="Blank = open"><TextInput className="num" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <Field label="Source / citation" className="col-span-4"><TextInput value={source} onChange={(e) => setSource(e.target.value)} /></Field>
      </div>
      {row?.isSeeded && <Banner tone="info" className="mt-3">Seeded from Schedule II with the citation above — edit it if the law changes, and update the citation.</Banner>}
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => void save()}>Save</Button>
      </div>
    </Modal>
  )
}

function RateModal({ row, blocks, onClose }: { row: RateRow | null; blocks: ItBlockRow[]; onClose: () => void }): React.JSX.Element {
  const toast = useToasts()
  const refresh = useRefreshFixedAssets()
  const [blockId, setBlockId] = useState<number | null>(row?.blockId ?? blocks[0]?.id ?? null)
  const [act, setAct] = useState<'1961' | '2025'>(row?.act ?? '2025')
  const [from, setFrom] = useState(row?.effectiveFrom ?? '2026-04-01')
  const [to, setTo] = useState(row?.effectiveTo ?? '')
  const [rate, setRate] = useState(row ? bpText(row.rateBp) : '')
  const [addl, setAddl] = useState(row ? bpText(row.additionalRateBp) : '0')
  const [section, setSection] = useState(row?.sectionRef ?? '')
  const [source, setSource] = useState(row?.source ?? '')
  const save = async (): Promise<void> => {
    const rateBp = parsePercentBp(rate)
    const addlBp = parsePercentBp(addl)
    if (blockId == null || rateBp == null || addlBp == null) return toast.push('error', 'Pick a block and enter the rates as percentages')
    try {
      await faApi.blockRateSave({ blockId, act, effectiveFrom: from, effectiveTo: to || null, rateBp, additionalRateBp: addlBp, sectionRef: section, source }, row?.id)
      await refresh()
      onClose()
    } catch (e) {
      toast.push('error', (e as Error).message)
    }
  }
  return (
    <Modal title={row ? `IT rate — ${row.blockName}` : 'New IT block rate'} onClose={onClose} wide>
      <div className="grid grid-cols-4 gap-3">
        <Field label="Block" className="col-span-4">
          <Select value={blockId ?? ''} onChange={(e) => setBlockId(Number(e.target.value))}>
            {blocks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        </Field>
        <Field label="Act">
          <Select value={act} onChange={(e) => setAct(e.target.value as '1961' | '2025')}>
            <option value="1961">1961 Act</option>
            <option value="2025">2025 Act</option>
          </Select>
        </Field>
        <Field label="Effective from"><TextInput className="num" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="Effective to" hint="Blank = open"><TextInput className="num" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <Field label="Rate %"><TextInput className="num" value={rate} onChange={(e) => setRate(e.target.value)} /></Field>
        <Field label="Additional %"><TextInput className="num" value={addl} onChange={(e) => setAddl(e.target.value)} /></Field>
        <Field label="Section / rule" className="col-span-3"><TextInput value={section} onChange={(e) => setSection(e.target.value)} /></Field>
        <Field label="Source / citation" className="col-span-4"><TextInput value={source} onChange={(e) => setSource(e.target.value)} /></Field>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        {row && (
          <Button variant="danger" onClick={() => void faApi.blockRateDelete(row.id).then(refresh).then(onClose).catch((e: Error) => toast.push('error', e.message))}>
            Delete rate
          </Button>
        )}
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => void save()}>Save</Button>
      </div>
    </Modal>
  )
}
