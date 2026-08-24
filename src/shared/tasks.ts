export type TaskPriority = 'low' | 'normal' | 'high'
export type TaskStatus = 'open' | 'done' | 'cancelled'
export type TaskLinkType = 'none' | 'voucher' | 'ledger' | 'screen' | 'gst_return'

export interface PersonalTask {
  id: number
  title: string
  note: string | null
  dueDate: string | null
  priority: TaskPriority
  status: TaskStatus
  assignedTo: string | null
  linkType: TaskLinkType
  linkKey: string | null
  createdBy: string
  createdAt: string
  completedBy: string | null
  completedAt: string | null
  updatedAt: string
}

export interface PersonalTaskInput {
  title: string
  note: string | null
  dueDate: string | null
  priority: TaskPriority
  assignedTo: string | null
  linkType: TaskLinkType
  linkKey: string | null
}
