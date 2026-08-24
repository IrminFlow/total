import { create } from "zustand";
import { setDefaultNumberGrouping, type NumberGrouping } from "@shared/money";

export type FontScale = "default" | "large" | "xlarge";
export type MotionPreference = "system" | "reduce";
export type ReadingMode = "standard" | "dyslexia";
export type UiLanguage = "en" | "hi";

export interface AccessibilityPreferences {
  fontScale: FontScale;
  motion: MotionPreference;
  readingMode: ReadingMode;
  numberGrouping: NumberGrouping;
  language: UiLanguage;
}

export const DEFAULT_ACCESSIBILITY_PREFERENCES: AccessibilityPreferences = {
  fontScale: "default",
  motion: "system",
  readingMode: "standard",
  numberGrouping: "indian",
  language: "en",
};

const STORAGE_KEY = "total-accessibility-v1";

function isPreferences(value: unknown): value is AccessibilityPreferences {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    ["default", "large", "xlarge"].includes(String(item.fontScale)) &&
    ["system", "reduce"].includes(String(item.motion)) &&
    ["standard", "dyslexia"].includes(String(item.readingMode)) &&
    ["indian", "international"].includes(String(item.numberGrouping)) &&
    ["en", "hi"].includes(String(item.language))
  );
}

export function readAccessibilityPreferences(): AccessibilityPreferences {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? "null",
    );
    return isPreferences(parsed)
      ? parsed
      : { ...DEFAULT_ACCESSIBILITY_PREFERENCES };
  } catch {
    return { ...DEFAULT_ACCESSIBILITY_PREFERENCES };
  }
}

export function applyAccessibilityPreferences(
  preferences: AccessibilityPreferences,
): void {
  const root = document.documentElement;
  root.dataset.fontScale = preferences.fontScale;
  root.dataset.motion = preferences.motion;
  root.dataset.readingMode = preferences.readingMode;
  root.dataset.uiLanguage = preferences.language;
  root.lang = preferences.language;
  setDefaultNumberGrouping(preferences.numberGrouping);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
}

interface AccessibilityState extends AccessibilityPreferences {
  setPreference: <K extends keyof AccessibilityPreferences>(
    key: K,
    value: AccessibilityPreferences[K],
  ) => void;
  reset: () => void;
}

const initial = readAccessibilityPreferences();

export const useAccessibilityPreferences = create<AccessibilityState>(
  (set) => ({
    ...initial,
    setPreference: (key, value) =>
      set((state) => {
        const next: AccessibilityPreferences = {
          fontScale: state.fontScale,
          motion: state.motion,
          readingMode: state.readingMode,
          numberGrouping: state.numberGrouping,
          language: state.language,
          [key]: value,
        };
        applyAccessibilityPreferences(next);
        return next;
      }),
    reset: () => {
      const next = { ...DEFAULT_ACCESSIBILITY_PREFERENCES };
      applyAccessibilityPreferences(next);
      set(next);
    },
  }),
);
