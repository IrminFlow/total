import { formatPaise } from '@shared/money'

export interface MorningDigestData {
  date: string
  company: string
  cashAndBank: number
  overdueReceivables: number
  overduePayables: number
  exceptionCount: number
  deadlineCount: number
  recurringDue: number
  tasksDue: number
}

export function morningDigestText(data: MorningDigestData): string {
  const scheduled = data.recurringDue + data.tasksDue
  const money = (paise: number): string => `₹${formatPaise(paise)}`
  return [
    `${data.company} morning brief for ${data.date}`,
    `Cash and bank: ${money(data.cashAndBank)}`,
    `Overdue receivables: ${money(data.overdueReceivables)}`,
    `Overdue payables: ${money(data.overduePayables)}`,
    `Book exceptions: ${data.exceptionCount}`,
    `Compliance deadlines in the next 30 days: ${data.deadlineCount}`,
    `Scheduled work due: ${scheduled} (${data.recurringDue} recurring, ${data.tasksDue} tasks)`
  ].join('\n')
}
