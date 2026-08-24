export type ProductFlagId = "guidedHelp" | "featureDiscovery" | "communityWorkspace" | "smtpDeliveryPreview";
export interface ProductFlagState {
  version: 1;
  flags: Record<ProductFlagId, boolean>;
  history: { flag: ProductFlagId; enabled: boolean; changedAt: string }[];
}

const ALL_PRODUCT_FLAGS: { id: ProductFlagId; label: string; safeFallback: string }[] = [
  { id: "guidedHelp", label: "Guided offline help", safeFallback: "Keyboard shortcut help and Support remain available." },
  { id: "featureDiscovery", label: "Related feature tips", safeFallback: "All features remain reachable through navigation and Help." },
  { id: "communityWorkspace", label: "Community & learning workspace", safeFallback: "Books, export and Support remain unchanged." },
  { id: "smtpDeliveryPreview", label: "SMTP submission preview", safeFallback: "Draft review and local .eml export remain available." },
];

export const PRODUCT_FLAGS = ALL_PRODUCT_FLAGS.filter(
  (flag) => import.meta.env.DEV || flag.id !== "smtpDeliveryPreview",
);

const KEY = "total:product-flags:v1";
const defaults = (): ProductFlagState => ({
  version: 1,
  flags: { guidedHelp: true, featureDiscovery: true, communityWorkspace: true, smtpDeliveryPreview: false },
  history: [],
});

export function readProductFlags(storage: Storage): ProductFlagState {
  try {
    const parsed = JSON.parse(storage.getItem(KEY) ?? "null") as Partial<ProductFlagState> | null;
    if (parsed?.version === 1)
      return {
        ...defaults(),
        ...parsed,
        flags: { ...defaults().flags, ...(parsed.flags ?? {}) },
        history: Array.isArray(parsed.history) ? parsed.history.slice(-50) : [],
      };
  } catch {
    // A malformed optional flag file falls back to the stable public surface.
  }
  return defaults();
}

export function setProductFlag(
  storage: Storage,
  flag: ProductFlagId,
  enabled: boolean,
  now = new Date(),
): ProductFlagState {
  const state = readProductFlags(storage);
  state.flags[flag] = enabled;
  state.history = [...state.history, { flag, enabled, changedAt: now.toISOString() }].slice(-50);
  storage.setItem(KEY, JSON.stringify(state));
  return state;
}
