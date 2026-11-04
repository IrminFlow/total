/** App's React key for the Registers screen: a nav entry that differs in any param — `visit`
 *  included — remounts it, so a remembered-tab link after a visit-only one is applied. */
export function registersScreenKey(s: { tab?: string; from?: string; to?: string; kind?: string; voucherIds?: number[]; visit?: boolean }): string {
  return `${s.tab ?? 'last'}|${s.from ?? ''}|${s.to ?? ''}|${s.kind ?? ''}|${s.voucherIds?.join(',') ?? ''}|${s.visit ? 'visit' : ''}`
}
