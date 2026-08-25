export const SHORTCUT_GUIDE_KEY = "total:shortcut-guide:v1";

export interface ShortcutGuideState {
  completed: boolean;
  completedAt: string | null;
}

export function readShortcutGuide(storage: Storage): ShortcutGuideState {
  try {
    const parsed = JSON.parse(storage.getItem(SHORTCUT_GUIDE_KEY) ?? "null") as
      | Partial<ShortcutGuideState>
      | null;
    if (parsed?.completed === true) {
      return {
        completed: true,
        completedAt:
          typeof parsed.completedAt === "string" ? parsed.completedAt : null,
      };
    }
  } catch {
    // A damaged device preference is safe to replace. Company books are not involved.
  }
  return { completed: false, completedAt: null };
}

export function completeShortcutGuide(
  storage: Storage,
  now = new Date(),
): ShortcutGuideState {
  const next = { completed: true, completedAt: now.toISOString() };
  storage.setItem(SHORTCUT_GUIDE_KEY, JSON.stringify(next));
  return next;
}
