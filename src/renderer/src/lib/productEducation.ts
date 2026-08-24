export interface ReleaseNote {
  version: string;
  title: string;
  released: string;
  changes: { title: string; detail: string; screen?: string }[];
}

export const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: "0.5.0",
    title: "A calmer, faster accounting workspace",
    released: "August 2026",
    changes: [
      { title: "Quarterly registers", detail: "Switch sales and purchase ledgers between month and quarter evidence.", screen: "registers" },
      { title: "Keyboard-first navigation", detail: "Red mnemonics, global shortcuts and voucher keys now agree everywhere.", screen: "gateway" },
      { title: "Controlled Assist", detail: "OpenAI and compatible providers use exact previews, citations and inert proposals.", screen: "assist" },
      { title: "Recovery you can inspect", detail: "Verified backups, restore previews, recovery drills and Data health are built in.", screen: "settings" },
      { title: "Private support cases", detail: "Track a case, choose every attachment and save an encrypted offline bundle." },
    ],
  },
];

const RELEASE_SEEN_KEY = "total:release-notes:last-seen";

/** First installs start clean; an older recorded version triggers exactly one upgrade note. */
export function releaseNotesDue(storage: Storage, currentVersion: string): boolean {
  const previous = storage.getItem(RELEASE_SEEN_KEY);
  if (previous === null) {
    storage.setItem(RELEASE_SEEN_KEY, currentVersion);
    return false;
  }
  return previous !== currentVersion;
}

export function markReleaseNotesSeen(storage: Storage, currentVersion: string): void {
  storage.setItem(RELEASE_SEEN_KEY, currentVersion);
}

export interface DiscoveryTip {
  id: string;
  screen: string;
  title: string;
  detail: string;
}

export const DISCOVERY_TIPS: DiscoveryTip[] = [
  { id: "register-quarter", screen: "registers", title: "See the same register by quarter", detail: "The Monthly / Quarterly switch changes the grouping, while drill-down keeps the exact voucher trail." },
  { id: "voucher-keys", screen: "voucher-entry", title: "Your hands can stay on the keyboard", detail: "F4–F9 choose the common voucher types; Command/Ctrl+Enter saves after validation." },
  { id: "daybook-batch", screen: "daybook", title: "Export several invoices together", detail: "Select sales rows in the Day book and create one reviewed batch of PDFs." },
  { id: "bank-match-evidence", screen: "banking", title: "Inspect why a bank match ranked first", detail: "Open match evidence to compare amount, date, reference and alternatives before clearing." },
  { id: "assist-preview", screen: "assist", title: "Preview before anything leaves this device", detail: "Choose individual context fields and inspect the exact provider payload before asking Assist." },
];

interface DiscoveryState {
  visits: Record<string, number>;
  dismissedUntil: Record<string, string>;
  never: string[];
}

const DISCOVERY_KEY = "total:feature-discovery:v1";
const EMPTY_DISCOVERY: DiscoveryState = { visits: {}, dismissedUntil: {}, never: [] };

function readDiscovery(storage: Storage): DiscoveryState {
  try {
    const value = JSON.parse(storage.getItem(DISCOVERY_KEY) ?? "null") as Partial<DiscoveryState> | null;
    return value
      ? {
          visits: value.visits ?? {},
          dismissedUntil: value.dismissedUntil ?? {},
          never: value.never ?? [],
        }
      : { ...EMPTY_DISCOVERY, visits: {}, dismissedUntil: {}, never: [] };
  } catch {
    return { ...EMPTY_DISCOVERY, visits: {}, dismissedUntil: {}, never: [] };
  }
}

function writeDiscovery(storage: Storage, state: DiscoveryState): void {
  storage.setItem(DISCOVERY_KEY, JSON.stringify(state));
}

export function visitForDiscovery(
  storage: Storage,
  screen: string,
  now = new Date(),
): DiscoveryTip | null {
  const state = readDiscovery(storage);
  state.visits[screen] = (state.visits[screen] ?? 0) + 1;
  writeDiscovery(storage, state);
  const tip = DISCOVERY_TIPS.find((candidate) => candidate.screen === screen);
  if (!tip || state.visits[screen] < 2 || state.never.includes(tip.id)) return null;
  const dismissed = state.dismissedUntil[tip.id];
  return !dismissed || dismissed <= now.toISOString() ? tip : null;
}

export function dismissDiscovery(
  storage: Storage,
  id: string,
  never: boolean,
  now = new Date(),
): void {
  const state = readDiscovery(storage);
  if (never) state.never = [...new Set([...state.never, id])];
  else {
    const later = new Date(now);
    later.setDate(later.getDate() + 30);
    state.dismissedUntil[id] = later.toISOString();
  }
  writeDiscovery(storage, state);
}
