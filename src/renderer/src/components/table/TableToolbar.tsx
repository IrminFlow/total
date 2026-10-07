import { useState, type ReactNode } from 'react'
import { columnLabel, describeFilter, isGroupable, moveColumn, type Density, type TableModel } from '../../lib/table'
import { Button, inputSmCls } from '../ui'
import { PopoverButton } from './Popover'
import type { TableColumn } from './types'
import type { TableViewController } from './useTableView'

export interface ToolbarFeatures {
  quickFilter?: boolean
  columns?: boolean
  groupBy?: boolean
  density?: boolean
  /** Saved views menu — only shown for a persisted table (viewId set). */
  views?: boolean
  /** Shown when the table has an `exportOptions` prop. */
  export?: boolean
}

const chipCls =
  'inline-flex items-center gap-1 rounded-full border border-amber/50 bg-amberbar/10 py-0.5 pr-1 pl-2.5 text-small text-ink'

export function TableToolbar<Row>({
  area,
  columns,
  controller,
  model,
  quick,
  setQuick,
  features,
  menu,
  setMenu,
  appDensity = 'comfortable',
  onExportCsv,
  onExportPdf,
  start,
  end,
  loading = false
}: {
  area: string
  columns: TableColumn<Row>[]
  controller: TableViewController
  model: TableModel<Row, TableColumn<Row>>
  quick: string
  setQuick: (q: string) => void
  features: Required<ToolbarFeatures>
  menu: string | null
  setMenu: (m: string | null) => void
  /** The app-wide density a view with `density: null` follows. */
  appDensity?: Density
  onExportCsv?: () => void
  onExportPdf?: () => void
  start?: ReactNode
  end?: ReactNode
  /** Rows are still loading: the count is withheld (it would read "0 rows"). */
  loading?: boolean
}): React.JSX.Element {
  const { view, setView } = controller
  const density: Density = view.density ?? appDensity
  const byId = new Map(columns.map((c) => [c.id, c]))
  const chips = Object.entries(view.filters).filter(([id]) => byId.has(id))
  const groupable = columns.filter((c) => isGroupable(c))
  const filtered = model.rows.length !== model.totalCount

  return (
    <div className="flex flex-col gap-2 border-b border-line px-3 py-2" data-testid={`${area}-table-toolbar`}>
      <div className="flex flex-wrap items-center gap-2">
        {start}
        {features.quickFilter && (
          <input
            type="search"
            className={`${inputSmCls} !w-56`}
            placeholder="Filter rows…"
            aria-label="Filter rows"
            value={quick}
            // While it has text, Esc clears it — an enclosing Modal must not close on that key.
            data-consumes-escape={quick ? '' : undefined}
            onChange={(e) => setQuick(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && quick) {
                e.stopPropagation() // clear first; a second Esc blurs / goes back as usual
                e.nativeEvent.stopImmediatePropagation()
                setQuick('')
              }
            }}
            data-testid={`${area}-table-quick`}
          />
        )}
        {!loading && (
          <span className="num text-small text-muted" aria-live="polite" data-testid={`${area}-table-count`}>
            {filtered ? `${model.rows.length} of ${model.totalCount}` : `${model.totalCount}`} {model.totalCount === 1 ? 'row' : 'rows'}
          </span>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {features.groupBy && groupable.length > 0 && (
            <label className="flex items-center gap-1 text-small text-muted">
              <span>Group</span>
              <select
                className={`${inputSmCls} !w-auto !text-small`}
                value={view.groupBy ?? ''}
                onChange={(e) => setView((v) => ({ ...v, groupBy: e.target.value || null }))}
                data-testid={`${area}-table-group`}
              >
                <option value="">None</option>
                {groupable.map((c) => (
                  <option key={c.id} value={c.id}>
                    {columnLabel(c)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {features.density && (
            <button
              type="button"
              className="rounded-md border border-line bg-panel2 px-2 py-1 text-small text-muted hover:border-amber/60 hover:text-ink"
              aria-pressed={density === 'compact'}
              aria-label="Compact rows"
              title={view.density ? 'Compact rows (this table)' : 'Compact rows (following the app setting)'}
              // Picking the app's own density stores null, so the table follows the setting again.
              onClick={() => {
                const next: Density = density === 'compact' ? 'comfortable' : 'compact'
                setView((v) => ({ ...v, density: next === appDensity ? null : next }))
              }}
              data-testid={`${area}-table-density`}
            >
              {density === 'compact' ? '☰ Compact' : '☰ Comfortable'}
            </button>
          )}
          {features.columns && (
            <PopoverButton
              label="Columns"
              popoverLabel="Choose columns"
              open={menu === 'columns'}
              setOpen={(o) => setMenu(o ? 'columns' : null)}
              align="right"
              width={250}
              testId={`${area}-table-columns`}
              render={() => <ColumnChooser columns={columns} controller={controller} area={area} />}
            >
              ⚙ Columns
            </PopoverButton>
          )}
          {features.views && controller.persistent && (
            <PopoverButton
              label={`Views${controller.active ? `: ${controller.active}` : ''}`}
              popoverLabel="Saved views"
              open={menu === 'views'}
              setOpen={(o) => setMenu(o ? 'views' : null)}
              align="right"
              width={270}
              testId={`${area}-table-views`}
              render={(close) => <ViewsMenu controller={controller} close={close} area={area} />}
            >
              ▤ {controller.active ?? 'Default view'}
              {controller.modified ? ' •' : ''}
            </PopoverButton>
          )}
          {features.export && onExportPdf && (
            <Button variant="ghost" size="sm" onClick={onExportPdf} data-testid={`${area}-table-pdf`}>
              PDF
            </Button>
          )}
          {features.export && onExportCsv && (
            <Button variant="ghost" size="sm" onClick={onExportCsv} data-testid={`${area}-table-csv`}>
              CSV
            </Button>
          )}
          {end}
        </div>
      </div>
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Active filters" role="group">
          {chips.map(([id, f]) => (
            <span key={id} className={chipCls} data-testid={`${area}-table-chip-${id}`}>
              {describeFilter(byId.get(id)!, f)}
              <button
                type="button"
                className="rounded-full px-1 text-muted hover:text-ink"
                aria-label={`Remove filter: ${describeFilter(byId.get(id)!, f)}`}
                onClick={() =>
                  setView((v) => {
                    const filters = { ...v.filters }
                    delete filters[id]
                    return { ...v, filters }
                  })
                }
              >
                ✕
              </button>
            </span>
          ))}
          <button
            type="button"
            className="text-small text-blue hover:underline"
            onClick={() => setView((v) => ({ ...v, filters: {} }))}
            data-testid={`${area}-table-clear-filters`}
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  )
}

function ColumnChooser<Row>({ columns, controller, area }: { columns: TableColumn<Row>[]; controller: TableViewController; area: string }): React.JSX.Element {
  const { view, setView } = controller
  const byId = new Map(columns.map((c) => [c.id, c]))
  const order = view.order.filter((id) => byId.has(id))
  return (
    <div className="flex flex-col gap-1">
      <p className="mb-1 text-caption font-semibold tracking-[0.08em] text-muted uppercase">Columns</p>
      <ul className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
        {order.map((id, i) => {
          const c = byId.get(id)!
          const shown = !view.hidden.includes(id)
          return (
            <li key={id} className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-panel2">
              <label className="flex flex-1 items-center gap-2">
                <input
                  type="checkbox"
                  checked={shown}
                  disabled={c.hideable === false}
                  onChange={() =>
                    setView((v) => ({ ...v, hidden: shown ? [...v.hidden, id] : v.hidden.filter((x) => x !== id) }))
                  }
                  data-testid={`${area}-table-col-${id}`}
                />
                {columnLabel(c)}
              </label>
              <button
                type="button"
                className="px-1 text-muted hover:text-ink disabled:opacity-30"
                aria-label={`Move ${columnLabel(c)} up`}
                disabled={i === 0}
                onClick={() => setView((v) => moveColumn(v, id, v.order.indexOf(order[i - 1]!)))}
              >
                ↑
              </button>
              <button
                type="button"
                className="px-1 text-muted hover:text-ink disabled:opacity-30"
                aria-label={`Move ${columnLabel(c)} down`}
                disabled={i === order.length - 1}
                onClick={() => setView((v) => moveColumn(v, id, v.order.indexOf(order[i + 1]!)))}
              >
                ↓
              </button>
            </li>
          )
        })}
      </ul>
      <button
        type="button"
        className="mt-1 self-start text-small text-blue hover:underline"
        onClick={() =>
          setView((v) => ({ ...v, order: controller.defaults.order, hidden: controller.defaults.hidden, widths: {} }))
        }
      >
        Reset columns
      </button>
    </div>
  )
}

function ViewsMenu({ controller, close, area }: { controller: TableViewController; close: () => void; area: string }): React.JSX.Element {
  const [mode, setMode] = useState<null | 'save' | 'rename'>(null)
  const [name, setName] = useState('')
  const taken = (n: string): boolean => controller.saved.some((s) => s.name === n.trim()) && n.trim() !== controller.active
  const itemCls = 'flex w-full items-center justify-between rounded px-2 py-1 text-left hover:bg-panel2'

  if (mode) {
    const submit = (): void => {
      if (!name.trim()) return
      if (mode === 'save') controller.saveAs(name)
      else if (controller.active) controller.rename(controller.active, name)
      close()
    }
    return (
      <div className="flex flex-col gap-2">
        <label className="text-caption font-semibold tracking-[0.08em] text-muted uppercase" htmlFor={`${area}-view-name`}>
          {mode === 'save' ? 'Save current view as' : 'Rename view'}
        </label>
        <input
          id={`${area}-view-name`}
          className={`${inputSmCls}`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            }
          }}
          maxLength={60}
          data-testid={`${area}-table-view-name`}
        />
        {mode === 'save' && taken(name) && <span className="text-hint text-muted">Replaces the saved view “{name.trim()}”.</span>}
        {mode === 'rename' && taken(name) && <span className="text-hint text-cr">A view with that name exists.</span>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setMode(null)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!name.trim() || (mode === 'rename' && taken(name))}
            onClick={submit}
            data-testid={`${area}-table-view-save`}
          >
            Save
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-0.5">
      <p className="mb-1 text-caption font-semibold tracking-[0.08em] text-muted uppercase">Views</p>
      <button
        type="button"
        className={itemCls}
        aria-current={controller.active === null ? 'true' : undefined}
        onClick={() => {
          controller.switchTo(null)
          close()
        }}
        data-testid={`${area}-table-view-default`}
      >
        Default view {controller.active === null && <span className="text-amber">✓</span>}
      </button>
      {controller.saved.map((s) => (
        <button
          key={s.name}
          type="button"
          className={itemCls}
          aria-current={controller.active === s.name ? 'true' : undefined}
          onClick={() => {
            controller.switchTo(s.name)
            close()
          }}
          data-testid={`${area}-table-view-item`}
        >
          <span className="truncate">{s.name}</span> {controller.active === s.name && <span className="text-amber">✓</span>}
        </button>
      ))}
      <div className="my-1 border-t border-line" />
      <button
        type="button"
        className={itemCls}
        onClick={() => {
          setName(controller.active ?? '')
          setMode('save')
        }}
        data-testid={`${area}-table-view-save-as`}
      >
        Save current as…
      </button>
      {controller.active && (
        <>
          <button
            type="button"
            className={itemCls}
            onClick={() => {
              setName(controller.active ?? '')
              setMode('rename')
            }}
            data-testid={`${area}-table-view-rename`}
          >
            Rename “{controller.active}”…
          </button>
          <button
            type="button"
            className={`${itemCls} text-cr`}
            onClick={() => {
              if (controller.active) controller.remove(controller.active)
              close()
            }}
            data-testid={`${area}-table-view-delete`}
          >
            Delete “{controller.active}”
          </button>
        </>
      )}
      <button
        type="button"
        className={itemCls}
        onClick={() => {
          controller.reset()
          close()
        }}
        data-testid={`${area}-table-view-reset`}
      >
        Reset to default
      </button>
    </div>
  )
}
