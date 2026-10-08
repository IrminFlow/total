import { z } from 'zod'

/** IPC shape of a typed sheet (writer.ts XlsxSheet) — export:xlsx and the books export. */
const cell = z.union([z.string().max(32767), z.number().finite(), z.null()]).optional()

export const xlsxColumnSchema = z.object({
  header: z.string().max(255),
  kind: z.enum(['text', 'money', 'date', 'qty', 'number', 'integer', 'percent']),
  decimals: z.number().int().min(0).max(3).optional(),
  width: z.number().min(1).max(255).optional()
})

export const xlsxRowSchema = z.union([
  z.array(cell).max(16384),
  z.object({
    cells: z.array(cell).max(16384),
    bold: z.boolean().optional(),
    qtyDecimals: z.record(z.string(), z.number().int().min(0).max(3)).optional()
  })
])

export const xlsxSheetSchema = z.object({
  name: z.string().min(1).max(100),
  columns: z.array(xlsxColumnSchema).min(1).max(16384),
  rows: z.array(xlsxRowSchema).max(1_000_000),
  preamble: z.array(z.string().max(1000)).max(10).optional()
})

export const exportXlsxSchema = z.object({
  filename: z.string().trim().regex(/^[a-z0-9-_]+$/, 'Filename must be lowercase letters, digits, - or _'),
  sheets: z.array(xlsxSheetSchema).min(1).max(50)
})
