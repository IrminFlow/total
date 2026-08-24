export interface FocusContext {
  tag: string;
  role: string | null;
  name: string;
  testId: string | null;
  screen: string | null;
}

/** Safe, bounded metadata for accessibility reports. Never reads an input's value. */
export function focusContextFor(target: Element | null): FocusContext | null {
  if (!(target instanceof HTMLElement)) return null;
  const labels =
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement
      ? Array.from(target.labels ?? [])
          .map((label) => label.textContent?.trim())
          .filter(Boolean)
          .join(" ")
      : "";
  const textName = target.matches("button, a")
    ? (target.textContent?.replace(/\s+/g, " ").trim() ?? "")
    : "";
  const name = (target.getAttribute("aria-label") || labels || textName).slice(
    0,
    160,
  );
  return {
    tag: target.tagName.toLowerCase(),
    role: target.getAttribute("role"),
    name,
    testId: target.dataset.testid ?? null,
    screen:
      target.closest("[data-screen]")?.getAttribute("data-screen") ?? null,
  };
}
