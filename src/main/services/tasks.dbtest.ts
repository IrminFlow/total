import { describe, expect, it } from 'vitest'
import { postSimpleVoucher, seededDb } from '../db/testdb'
import { listTasks, saveTask, setTaskStatus } from './tasks'

describe('personal task inbox', () => {
  it('sorts overdue work first and retains typed voucher links', () => {
    const db = seededDb()
    const voucher = postSimpleVoucher(db, { date: '2026-08-01', amount: 10_000, kind: 'journal' })
    saveTask(db, { title: 'Later review', note: null, dueDate: '2026-09-01', priority: 'normal', assignedTo: 'Asha', linkType: 'none', linkKey: null }, 'Asha')
    const urgent = saveTask(db, { title: 'Check voucher evidence', note: 'Ask for receipt', dueDate: '2026-08-20', priority: 'high', assignedTo: 'Kabir', linkType: 'voucher', linkKey: String(voucher.id) }, 'Asha')
    expect(listTasks(db, 'open')[0]).toMatchObject({ id: urgent.id, linkType: 'voucher', linkKey: String(voucher.id), assignedTo: 'Kabir' })
  })

  it('completes once, preserves author evidence and blocks edits afterwards', () => {
    const db = seededDb()
    const task = saveTask(db, { title: 'File return', note: null, dueDate: null, priority: 'normal', assignedTo: null, linkType: 'gst_return', linkKey: 'gstr1:202608' }, 'Asha')
    const done = setTaskStatus(db, task.id, 'done', 'Owner')
    expect(done).toMatchObject({ status: 'done', completedBy: 'Owner' })
    expect(done.completedAt).not.toBeNull()
    expect(() => setTaskStatus(db, task.id, 'cancelled', 'Owner')).toThrow('already closed')
    expect(() => saveTask(db, { title: 'Rewrite', note: null, dueDate: null, priority: 'low', assignedTo: null, linkType: 'none', linkKey: null }, 'Owner', task.id)).toThrow('cannot be edited')
  })

  it('refuses links to missing accounting records', () => {
    const db = seededDb()
    expect(() => saveTask(db, { title: 'Missing', note: null, dueDate: null, priority: 'normal', assignedTo: null, linkType: 'ledger', linkKey: '9999' }, 'Asha')).toThrow('not found')
  })
})
