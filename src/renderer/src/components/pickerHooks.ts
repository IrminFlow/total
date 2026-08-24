import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Group, Ledger, StockItem } from '@shared/domain'
import { api } from '../lib/client'

export function useLedgers(): Ledger[] {
  const { data } = useQuery({ queryKey: ['ledgers'], queryFn: api.ledgers.list })
  return data ?? []
}

export function useGroups(): Group[] {
  const { data } = useQuery({ queryKey: ['groups'], queryFn: api.groups.list })
  return data ?? []
}

export function useStockItems(): StockItem[] {
  const { data } = useQuery({ queryKey: ['stockItems'], queryFn: api.stockItems.list })
  return data ?? []
}

/** Find-or-create the CGST/SGST/IGST/Cess ledgers (under Duties & Taxes) and Round Off. */
export function useTaxLedgers(): {
  ensure: (taxType: 'cgst' | 'sgst' | 'igst' | 'cess') => Promise<number>
  ensureRoundOff: () => Promise<number>
} {
  const queryClient = useQueryClient()
  const ensure = async (taxType: 'cgst' | 'sgst' | 'igst' | 'cess'): Promise<number> => {
    const ledgers = await api.ledgers.list()
    const existing = ledgers.find((l) => l.taxType === taxType)
    if (existing) return existing.id
    const groups = await api.groups.list()
    const duties = groups.find((g) => g.name === 'Duties & Taxes')
    if (!duties) throw new Error('Duties & Taxes group missing')
    const created = await api.ledgers.create({
      name: taxType.toUpperCase(),
      groupId: duties.id,
      openingBalance: 0,
      gstin: null,
      stateCode: null,
      address: null,
      taxType,
      gstRate: null,
      hsn: null,
      tdsSectionId: null,
      pan: null,
      creditDays: null,
      exportType: null
    })
    await queryClient.invalidateQueries({ queryKey: ['ledgers'] })
    return created.id
  }
  const ensureRoundOff = async (): Promise<number> => {
    const ledgers = await api.ledgers.list()
    const existing = ledgers.find((l) => l.name.toLowerCase() === 'round off')
    if (existing) return existing.id
    const groups = await api.groups.list()
    const indirect = groups.find((g) => g.name === 'Indirect Expenses')
    if (!indirect) throw new Error('Indirect Expenses group missing')
    const created = await api.ledgers.create({
      name: 'Round Off',
      groupId: indirect.id,
      openingBalance: 0,
      gstin: null,
      stateCode: null,
      address: null,
      taxType: null,
      gstRate: null,
      hsn: null,
      tdsSectionId: null,
      pan: null,
      creditDays: null,
      exportType: null
    })
    await queryClient.invalidateQueries({ queryKey: ['ledgers'] })
    return created.id
  }
  return { ensure, ensureRoundOff }
}
