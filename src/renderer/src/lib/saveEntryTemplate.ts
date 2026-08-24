import type { VoucherWorkDraftInput } from '@shared/voucherDrafts'
import { api } from './client'
import { promptDialog } from './dialogs'

export async function saveEntryTemplate(input: VoucherWorkDraftInput, suggestedName: string): Promise<string | null> {
  const name = await promptDialog({ title: 'Save as entry template', message: 'Name this reusable one-off pattern. It will always open as an editable draft.', placeholder: 'Rent, bank charges, monthly utilities…', initial: suggestedName, confirmLabel: 'Save template' })
  if (!name?.trim()) return null
  const saved = await api.entryTemplates.save({ ...input, name: name.trim() })
  return saved.name
}
