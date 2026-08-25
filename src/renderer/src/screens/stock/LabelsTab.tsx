import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type LabelJobRequest } from '../../lib/client'
import { useToasts } from '../../state/stores'
import { Button, EmptyState, Field, Panel, Select, TextInput } from '../../components/ui'
import { useStockItems } from '../../components/pickers'
import { LABEL_SIZES } from '@shared/labels'

/**
 * Barcode label printing (roadmap E #111).
 *
 * The preview is not decoration. Nothing in `@shared/labels` has ever been sent to a physical
 * printer — the TSPL commands are the documented ones and are tested byte for byte, which is a
 * weaker claim than "the label came out right" — so the operator gets to READ the job first, and
 * the "Save to file" path exists so the first person with real hardware can inspect the bytes
 * before committing a roll of stock to them.
 */
export function LabelsTab(): React.JSX.Element {
  const items = useStockItems()
  const toast = useToasts()
  const [copies, setCopies] = useState<Record<number, number>>({})
  const [sizeId, setSizeId] = useState(LABEL_SIZES[0]!.id)
  const [priceLevelId, setPriceLevelId] = useState<number | null>(null)
  const [includePrice, setIncludePrice] = useState(true)
  const [printer, setPrinter] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  const { data: levels } = useQuery({ queryKey: ['priceLevels'], queryFn: api.priceLevels.list })
  const { data: printers } = useQuery({ queryKey: ['rawPrinters'], queryFn: api.rawPrint.printers })

  const chosen = useMemo(
    () => Object.entries(copies).filter(([, n]) => n > 0).map(([id, n]) => ({ stockItemId: Number(id), copies: n })),
    [copies]
  )
  const job: LabelJobRequest = { items: chosen, sizeId, priceLevelId, includePrice }

  const { data: plan } = useQuery({
    queryKey: ['labelPreview', chosen, sizeId, priceLevelId, includePrice],
    queryFn: () => api.labels.preview(job),
    enabled: chosen.length > 0
  })

  const visible = items.filter((i) => !filter.trim() || i.name.toLowerCase().includes(filter.trim().toLowerCase()))

  const send = async (toFile: boolean): Promise<void> => {
    try {
      const result = await api.labels.print(job, toFile ? null : printer, toFile ? undefined : null)
      toast.push(
        'success',
        result.path ? `${result.bytes} bytes written to ${result.path}` : `Sent ${plan?.totalLabels ?? 0} labels to ${result.printer}`
      )
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <div className="grid gap-3 lg:grid-cols-[1fr_360px]">
      <Panel>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-body font-medium">Items</h3>
          <TextInput
            data-testid="input-label-filter"
            aria-label="Filter items"
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-48"
          />
        </div>
        {items.length === 0 ? (
          <EmptyState title="No stock items yet" hint="Create items under Masters → Stock items" />
        ) : (
          <table className="ledger-table" data-testid="rows-label-items">
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col" className="w-40">Barcode</th>
                <th scope="col" className="r w-28">Labels</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((i) => (
                <tr key={i.id}>
                  <td>{i.name}</td>
                  {/* An item with neither a barcode nor a code cannot be labelled, and saying so
                      here beats a refusal after the operator has set a count. */}
                  <td className={`num ${!i.barcode && !i.code ? 'text-cr' : 'text-muted'}`}>
                    {i.barcode ?? i.code ?? 'none — cannot be labelled'}
                  </td>
                  <td className="r">
                    <TextInput
                      data-testid={`input-label-copies-${i.id}`}
                      aria-label={`Labels for ${i.name}`}
                      className="num w-20 text-right"
                      value={copies[i.id] ?? ''}
                      onChange={(e) => {
                        const n = Number(e.target.value.replace(/[^0-9]/g, ''))
                        setCopies((cur) => ({ ...cur, [i.id]: Number.isFinite(n) ? n : 0 }))
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <div>
        <Panel className="mb-3">
          <h3 className="mb-2 text-body font-medium">The roll</h3>
          <div className="grid gap-3">
            <Field label="Label size">
              <Select data-testid="select-label-size" value={sizeId} onChange={(e) => setSizeId(e.target.value)}>
                {LABEL_SIZES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Price from"
              hint="With no price list the last purchase rate is used — never the valuation, which is a cost and not a selling price."
            >
              <Select
                data-testid="select-label-price-level"
                value={priceLevelId ?? ''}
                onChange={(e) => setPriceLevelId(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">Last purchase rate</option>
                {(levels ?? []).map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </Field>
            <label className="flex items-center gap-2 text-body">
              <input
                type="checkbox"
                data-testid="check-label-price"
                checked={includePrice}
                onChange={(e) => setIncludePrice(e.target.checked)}
              />
              Print the price
            </label>
            <Field label="Printer">
              <Select
                data-testid="select-label-printer"
                value={printer ?? ''}
                onChange={(e) => setPrinter(e.target.value || null)}
              >
                <option value="">Choose a queue…</option>
                {(printers ?? []).map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                    {p.isDefault ? ' (default)' : ''}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </Panel>

        <Panel>
          <h3 className="mb-2 text-body font-medium">
            Preview {plan ? `— ${plan.totalLabels} label${plan.totalLabels === 1 ? '' : 's'}` : ''}
          </h3>
          {chosen.length === 0 ? (
            <p className="px-1 text-hint text-muted">Set a number of labels against an item.</p>
          ) : (
            <>
              {plan?.errors.length ? (
                <ul className="mb-2 px-1 text-hint text-cr" data-testid="label-errors">
                  {plan.errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              ) : null}
              <div className="grid gap-2" data-testid="label-preview">
                {(plan?.preview ?? []).map((lines, i) => (
                  <pre key={i} className="rounded-md border border-line bg-panel2 p-2 text-caption leading-tight">
                    {lines.join('\n')}
                  </pre>
                ))}
              </div>
              <div className="mt-3 flex justify-end gap-2">
                <Button data-testid="btn-label-save" onClick={() => void send(true)}>
                  Save to file
                </Button>
                <Button
                  variant="primary"
                  data-testid="btn-label-print"
                  disabled={!printer || !plan || plan.errors.length > 0}
                  disabledTitle={!printer ? 'Choose a printer queue first' : 'Fix the problems above first'}
                  onClick={() => void send(false)}
                >
                  Print
                </Button>
              </div>
              <p className="mt-2 px-1 text-hint text-muted">
                These commands have never been sent to a physical label printer. Save the job to a file and read it
                before committing a roll to it.
              </p>
            </>
          )}
        </Panel>
      </div>
    </div>
  )
}
