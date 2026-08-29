import type { DB } from '../db/connection'
import type { PersonalTask, PersonalTaskInput, TaskStatus } from '@shared/tasks'
import { writeAudit } from './audit'

interface TaskRow {
  id: number; title: string; note: string | null; due_date: string | null
  priority: PersonalTask['priority']; status: TaskStatus; assigned_to: string | null
  link_type: PersonalTask['linkType']; link_key: string | null; created_by: string
  created_at: string; completed_by: string | null; completed_at: string | null; updated_at: string
}

function mapTask(row: TaskRow): PersonalTask {
  return {
    id: row.id, title: row.title, note: row.note, dueDate: row.due_date, priority: row.priority,
    status: row.status, assignedTo: row.assigned_to, linkType: row.link_type, linkKey: row.link_key,
    createdBy: row.created_by, createdAt: row.created_at, completedBy: row.completed_by,
    completedAt: row.completed_at, updatedAt: row.updated_at
  }
}

function validateLink(db: DB, type: PersonalTask['linkType'], rawKey: string | null): string | null {
  if (type === 'none') return null
  const key = rawKey?.trim()
  if (!key) throw new Error('Choose what this task links to')
  if (type === 'voucher') {
    const id = Number(key)
    if (!Number.isInteger(id) || !db.prepare('SELECT 1 FROM vouchers WHERE id = ? AND deleted_at IS NULL').get(id)) throw new Error('Linked voucher was not found')
    return String(id)
  }
  if (type === 'ledger') {
    const id = Number(key)
    if (!Number.isInteger(id) || !db.prepare('SELECT 1 FROM ledgers WHERE id = ?').get(id)) throw new Error('Linked ledger was not found')
    return String(id)
  }
  if (type === 'gst_return') {
    if (!/^(gstr1|gstr3b):\d{6}$/.test(key)) throw new Error('GST return link must look like gstr1:202608')
    return key.toLowerCase()
  }
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(key)) throw new Error('Screen link is invalid')
  return key
}

export function listTasks(db: DB, status?: TaskStatus): PersonalTask[] {
  const rows = (status
    ? db.prepare(
        `SELECT * FROM tasks WHERE status = ?
         ORDER BY CASE WHEN due_date IS NULL THEN 1 ELSE 0 END, due_date,
                  CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, id DESC`
      ).all(status)
    : db.prepare(
        `SELECT * FROM tasks ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'done' THEN 1 ELSE 2 END,
         CASE WHEN due_date IS NULL THEN 1 ELSE 0 END, due_date, id DESC LIMIT 500`
      ).all()) as TaskRow[]
  return rows.map(mapTask)
}

export function saveTask(db: DB, input: PersonalTaskInput, author: string, id?: number): PersonalTask {
  const title = input.title.trim()
  if (!title || title.length > 160) throw new Error('Task title must be between 1 and 160 characters')
  const linkKey = validateLink(db, input.linkType, input.linkKey)
  const before = id ? getTask(db, id) : null
  if (id && !before) throw new Error('Task not found')
  if (before && before.status !== 'open') throw new Error('Completed or cancelled tasks cannot be edited')
  let taskId = id
  if (id) {
    db.prepare(
      `UPDATE tasks SET title = ?, note = ?, due_date = ?, priority = ?, assigned_to = ?,
       link_type = ?, link_key = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(title, input.note?.trim() || null, input.dueDate, input.priority, input.assignedTo?.trim() || null, input.linkType, linkKey, id)
  } else {
    taskId = Number(db.prepare(
      `INSERT INTO tasks (title, note, due_date, priority, assigned_to, link_type, link_key, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(title, input.note?.trim() || null, input.dueDate, input.priority, input.assignedTo?.trim() || null, input.linkType, linkKey, author).lastInsertRowid)
  }
  const after = getTask(db, taskId!)!
  writeAudit(db, 'task', taskId!, id ? 'update' : 'create', before, after)
  return after
}

export function getTask(db: DB, id: number): PersonalTask | null {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined
  return row ? mapTask(row) : null
}

export function setTaskStatus(db: DB, id: number, status: Exclude<TaskStatus, 'open'>, author: string): PersonalTask {
  const before = getTask(db, id)
  if (!before) throw new Error('Task not found')
  if (before.status !== 'open') throw new Error('Task is already closed')
  db.prepare(
    `UPDATE tasks SET status = ?, completed_by = ?, completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  ).run(status, author, id)
  const after = getTask(db, id)!
  writeAudit(db, 'task', id, 'update', before, after)
  return after
}
