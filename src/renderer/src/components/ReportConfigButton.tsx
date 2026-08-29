import { useState } from 'react'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import { GearSix } from '@phosphor-icons/react'
import { Button } from './ui'
import type { ReportColumn } from '../lib/reportConfig'

/** F12-style "configure columns" gear button — opens a checkbox list wired to useReportConfig. */
export function ReportConfigButton({
  columns,
  visible,
  toggle
}: {
  columns: ReportColumn[]
  visible: Record<string, boolean>
  toggle: (key: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          className="flex items-center gap-1.5 rounded-md border border-line bg-panel2 px-2 py-1 text-[12px] text-muted hover:border-amber/60 hover:text-ink"
          aria-label="Configure columns"
        >
          <GearSix size={14} weight="bold" /> Columns
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="end"
          sideOffset={6}
          aria-label="Visible report columns"
          className="z-[60] w-64 rounded-xl border border-line bg-panel p-4 shadow-2xl outline-none"
        >
          <p className="mb-3 text-[13px] font-semibold text-ink">Visible columns</p>
          <div className="flex flex-col gap-2">
            {columns.map((c) => (
              <label key={c.key} className="flex items-center gap-2 text-[13px]">
                <input type="checkbox" checked={visible[c.key] ?? c.defaultOn} onChange={() => toggle(c.key)} />
                {c.label}
              </label>
            ))}
          </div>
          <div className="mt-4 flex justify-end">
            <PopoverPrimitive.Close asChild>
              <Button variant="primary">Done</Button>
            </PopoverPrimitive.Close>
          </div>
          <PopoverPrimitive.Arrow className="fill-line" />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}
