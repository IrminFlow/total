import type { QueryClient } from '@tanstack/react-query'
import type { Group } from '@shared/domain'
import { CATEGORIES, type CategoryKey } from '@shared/simple/categories'
import { api } from '../../lib/client'

/**
 * WP 9.4 — the plain account a Money answer needs and the company does not have yet ("Owner's
 * money" for money the owner put in, "Owner's drawings" for money they took out): added with its
 * category under its standard group, as the setup presets and the category picker do — never a
 * dead end. Returns its id (null when the group is missing).
 */
export async function ensureCategoryAccount(key: CategoryKey, groups: readonly Group[], queryClient: QueryClient): Promise<number | null> {
  const def = CATEGORIES[key]
  const groupId = groups.find((g) => g.name === def.group)?.id
  if (groupId == null) return null
  const l = await api.ledgers.create({
    name: def.name, groupId, openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null,
    tdsSectionId: null, pan: null, creditDays: null, exportType: null, simpleCategory: key
  })
  for (const k of ['ledgers', 'simpleMoneySetup']) await queryClient.invalidateQueries({ queryKey: [k] }) // i18n-technical: query families
  return l.id
}
