/**
 * Permissions finer than the three roles (roadmap #266).
 *
 * The roles — viewer, accountant, owner — answer "how much of the app", and a real office asks a
 * narrower question: the accountant who enters every purchase must not see what anyone is paid,
 * and the assistant who types sales must not be able to export the whole customer list. Those are
 * not new roles. They are one role with a hole in it.
 *
 * So this is deny-only. A user's role still sets the ceiling; per-user denials cut areas out of
 * it. There is deliberately no grant direction: a grant would let a viewer post entries while the
 * audit trail records them as a viewer, and "what could this person do" would no longer be
 * answerable from the role alone — which is the question an auditor actually asks.
 *
 * Pure, no imports: the main process enforces it and the renderer hides controls with it.
 */

/**
 * The areas a denial can name. Coarse on purpose — a permission list nobody can hold in their
 * head is a permission list nobody configures correctly.
 */
export const CAPABILITIES = [
  'books',
  'masters',
  'banking',
  'payroll',
  'gst',
  'reports',
  'exports',
  'settings'
] as const

export type Capability = (typeof CAPABILITIES)[number]

export const CAPABILITY_LABELS: Record<Capability, string> = {
  books: 'Vouchers and the day book',
  masters: 'Ledgers, items and other masters',
  banking: 'Bank statements and reconciliation',
  payroll: 'Payroll, salaries and employees',
  gst: 'GST returns and e-documents',
  reports: 'Reports and analysis',
  exports: 'Exports, PDFs and backups',
  settings: 'Settings, users and company details'
}

/** Denied capabilities for one user. Absent / empty = the role's full reach. */
export type Denials = readonly Capability[]

/** Type guard for values coming back out of the database's JSON column. */
export function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && (CAPABILITIES as readonly string[]).includes(value)
}

/** Parse whatever is stored in `users.denied_json` into a clean, deduplicated list. */
export function parseDenials(raw: unknown): Capability[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<Capability>()
  for (const item of raw) if (isCapability(item)) seen.add(item)
  // Sorted so two equal denial sets are also equal strings in the audit trail.
  return [...seen].sort()
}

/**
 * Channel → capability.
 *
 * Derived from the channel name rather than declared per handler: there are two hundred-odd
 * channels, and a scheme that needs every one of them annotated is a scheme where the next
 * channel added is the one that is silently ungated.
 *
 * Order matters — the first matching prefix wins, so the specific ones ('export:', 'payroll:')
 * are listed before the general.
 */
const PREFIX_CAPABILITIES: [string, Capability][] = [
  ['export:', 'exports'],
  ['backup:', 'exports'],
  ['company:backup', 'exports'],
  ['company:revealExports', 'exports'],
  ['invoice:pdf', 'exports'],
  ['report:pdf', 'exports'],
  ['payroll:', 'payroll'],
  ['employee', 'payroll'],
  ['attendance:', 'payroll'],
  ['payhead', 'payroll'],
  ['bank:', 'banking'],
  ['recon', 'banking'],
  ['gst', 'gst'],
  ['edoc', 'gst'],
  ['nic:', 'gst'],
  ['filing', 'gst'],
  ['tds:', 'gst'],
  ['master:', 'masters'],
  ['stock:', 'masters'],
  ['priceLevels:', 'masters'],
  ['report:', 'reports'],
  ['analysis:', 'reports'],
  ['dashboard', 'reports'],
  ['consolidated:', 'reports'],
  ['config:', 'settings'],
  ['users:', 'settings'],
  ['auth:users', 'settings'],
  ['company:updateInfo', 'settings'],
  ['company:lock', 'settings'],
  ['license:', 'settings'],
  ['ai:', 'settings'],
  ['agent:', 'settings'],
  ['audit:', 'settings'],
  ['voucher', 'books'],
  ['daybook', 'books'],
  ['bin:', 'books'],
  ['recurring:', 'books'],
  ['yearend:', 'books']
]

/**
 * Which capability a channel belongs to, or null when it belongs to none — the company picker,
 * the auth flow, logging. A null capability can never be denied, which is deliberate: locking
 * someone out of `company:list` would leave them staring at an app with no way back.
 */
export function capabilityOfChannel(channel: string): Capability | null {
  for (const [prefix, capability] of PREFIX_CAPABILITIES) {
    if (channel.startsWith(prefix)) return capability
  }
  return null
}

/**
 * True when a user with these denials may use `channel`.
 *
 * Read-only channels are NOT exempt: "cannot see payroll" has to mean the reports too, or the
 * denial is decoration.
 */
export function permitsChannel(denials: Denials, channel: string): boolean {
  const capability = capabilityOfChannel(channel)
  if (capability === null) return true
  return !denials.includes(capability)
}

/** The message the denial produces. Names the area, because "not permitted" sends people to
 *  support and "you cannot see payroll" sends them to whoever configured it. */
export function denialMessage(capability: Capability): string {
  return `Your account does not have access to ${CAPABILITY_LABELS[capability].toLowerCase()}`
}
