import { useSyncExternalStore } from "react";

export type ProductFlagId =
  | "guidedHelp"
  | "featureDiscovery"
  | "communityWorkspace"
  | "smtpDeliveryPreview"
  | "aiCopilot"
  | "mcpAccess"
  | "supportUploads"
  | "telemetry";
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
  { id: "aiCopilot", label: "AI copilot", safeFallback: "Accounting, reports and search continue without an AI provider." },
  { id: "mcpAccess", label: "Local MCP access", safeFallback: "JSON exports and the app remain available; external agents cannot connect." },
  { id: "supportUploads", label: "Support attachments", safeFallback: "Text-only support and encrypted offline bundles remain available." },
  { id: "telemetry", label: "Anonymous product telemetry", safeFallback: "No product-use events are recorded or sent." },
];

export const PRODUCT_FLAGS = ALL_PRODUCT_FLAGS.filter(
  (flag) => import.meta.env.DEV || flag.id !== "smtpDeliveryPreview",
);

const KEY = "total:product-flags:v1";
const defaults = (): ProductFlagState => ({
  version: 1,
  flags: {
    guidedHelp: true,
    featureDiscovery: true,
    communityWorkspace: true,
    smtpDeliveryPreview: false,
    aiCopilot: false,
    mcpAccess: false,
    supportUploads: false,
    telemetry: false,
  },
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
  if (typeof window !== "undefined" && storage === window.localStorage)
    window.dispatchEvent(new Event("total:product-flags-changed"));
  return state;
}

export function useProductFlags(): ProductFlagState {
  const serialized = useSyncExternalStore(
    (listener) => {
      window.addEventListener("total:product-flags-changed", listener);
      window.addEventListener("storage", listener);
      return () => {
        window.removeEventListener("total:product-flags-changed", listener);
        window.removeEventListener("storage", listener);
      };
    },
    () => JSON.stringify(readProductFlags(localStorage)),
    () => JSON.stringify(defaults()),
  );
  return JSON.parse(serialized) as ProductFlagState;
}
