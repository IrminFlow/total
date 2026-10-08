// WP 6.4 — notes and tasks on a party (party_notes, migration 036). Party-level; a note about one
// bill stays a bill follow-up (bill_followups, WP 4.2). Pure: schemas, row type, due buckets.
import { z } from 'zod'

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')

export const partyNoteInputSchema = z
  .object({
    ledgerId: z.number().int().positive(),
    kind: z.enum(['note', 'task']),
    text: z.string().trim().min(1, 'Write something').max(2000),
    dueDate: isoDate.nullable().default(null)
  })
  .refine((n) => n.kind === 'task' || n.dueDate === null, { message: 'Only a task has a due date', path: ['dueDate'] })
export type PartyNoteInput = z.input<typeof partyNoteInputSchema>

export const partyNoteUpdateSchema = z.object({
  id: z.number().int().positive(),
  text: z.string().trim().min(1, 'Write something').max(2000).optional(),
  dueDate: isoDate.nullable().optional(),
  done: z.boolean().optional()
})
export type PartyNoteUpdate = z.infer<typeof partyNoteUpdateSchema>

export const partyNotesQuerySchema = z.object({
  ledgerId: z.number().int().positive().optional(),
  kind: z.enum(['note', 'task']).optional(),
  includeDone: z.boolean().default(false)
})
export type PartyNotesQuery = z.input<typeof partyNotesQuerySchema>

export interface PartyNote {
  id: number
  ledgerId: number
  ledgerName: string
  kind: 'note' | 'task'
  text: string
  dueDate: string | null
  doneAt: string | null
  createdBy: string | null
  createdAt: string
}

export type TaskDueBucket = 'overdue' | 'today' | 'week' | 'later' | 'none' | 'done'

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** Which bucket an open task falls into on `today` (week = the next 7 days after today). */
export function taskBucket(n: Pick<PartyNote, 'kind' | 'dueDate' | 'doneAt'>, today: string): TaskDueBucket {
  if (n.kind !== 'task') return 'none'
  if (n.doneAt) return 'done'
  if (!n.dueDate) return 'none'
  if (n.dueDate < today) return 'overdue'
  if (n.dueDate === today) return 'today'
  if (n.dueDate <= addDays(today, 7)) return 'week'
  return 'later'
}

/** The dashboard chip: open tasks overdue or due today, and those due within the week. */
export interface TasksDueSummary {
  overdue: number
  today: number
  week: number
}

export function summariseTasks(notes: readonly Pick<PartyNote, 'kind' | 'dueDate' | 'doneAt'>[], today: string): TasksDueSummary {
  const s: TasksDueSummary = { overdue: 0, today: 0, week: 0 }
  for (const n of notes) {
    const b = taskBucket(n, today)
    if (b === 'overdue') s.overdue++
    else if (b === 'today') s.today++
    else if (b === 'week') s.week++
  }
  return s
}
