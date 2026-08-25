import { useMemo, useState } from "react";
import { Kbd, Modal } from "./ui";
import { useAccessibilityPreferences } from "../lib/accessibilityPrefs";
import { localizedLabel } from "../lib/localization";
import { useFeatures } from "../lib/useFeatures";
import { useSession } from "../state/stores";
import {
  GLOBAL_COMMANDS,
  NAVIGATION_COMMANDS,
  VOUCHER_COMMANDS,
  commandAvailable,
  effectiveBindings,
  formatShortcut,
  resetShortcutOverrides,
  setShortcutOverride,
  useShortcutOverrides,
  type CommandDefinition,
  type ShortcutBinding,
} from "../lib/commands";

interface ShortcutGroup {
  title: string;
  commands: CommandDefinition[];
  context?: "global" | "gateway" | "voucher";
}

function parseNavigationBinding(value: string): ShortcutBinding | null {
  const parts = value.toLowerCase().split("+").map((part) => part.trim()).filter(Boolean);
  const key = parts.at(-1) ?? "";
  if (key.length !== 1 || !/^[a-z0-9]$/.test(key)) return null;
  if (!parts.includes("alt") || parts.some((part) => !["alt", "shift", key].includes(part))) return null;
  return { key, context: "global", alt: true, shift: parts.includes("shift") };
}

function ShortcutKeys({ bindings }: { bindings: ShortcutBinding[] }): React.JSX.Element {
  return (
    <span className="flex shrink-0 flex-wrap items-center justify-end gap-1">
      {bindings.map((binding) => (
        <Kbd key={`${binding.context}:${formatShortcut(binding)}`}>{formatShortcut(binding)}</Kbd>
      ))}
    </span>
  );
}

export function ShortcutHelp({ onClose }: { onClose: () => void }): React.JSX.Element {
  const language = useAccessibilityPreferences((state) => state.language);
  const features = useFeatures();
  const role = useSession((state) => state.user?.role ?? "owner");
  const overrides = useShortcutOverrides();
  const [query, setQuery] = useState("");
  const [customizing, setCustomizing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const groups = useMemo<ShortcutGroup[]>(() => {
    const visible = (commands: CommandDefinition[]) =>
      commands.filter((command) => commandAvailable(command, features, role));
    return [
      { title: "Global", commands: visible(GLOBAL_COMMANDS), context: "global" },
      { title: "Home", commands: visible(NAVIGATION_COMMANDS), context: "gateway" },
      { title: "Navigation", commands: visible(NAVIGATION_COMMANDS), context: "global" },
      { title: "Voucher entry", commands: visible(VOUCHER_COMMANDS), context: "voucher" },
    ];
  }, [features, role]);

  const normalizedQuery = query.trim().toLowerCase();
  const filteredGroups = groups.map((group) => ({
    ...group,
    commands: group.commands.filter((command) => {
      const bindings = effectiveBindings(command, overrides).filter(
        (binding) => !group.context || binding.context === group.context,
      );
      return bindings.length > 0 && (!normalizedQuery ||
        `${command.label} ${command.keywords?.join(" ") ?? ""} ${bindings.map(formatShortcut).join(" ")}`
          .toLowerCase().includes(normalizedQuery));
    }),
  })).filter((group) => group.commands.length > 0);

  return (
    <Modal title={localizedLabel("Keyboard shortcuts", language)} onClose={onClose} wide>
      <div className="mb-5 flex items-center gap-2 border-b border-line pb-4">
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search keyboard shortcuts"
          placeholder="Search a task or key"
          className="min-w-0 flex-1 rounded-md border border-line bg-panel2 px-3 py-2 text-[13px] outline-none focus:border-amber focus:ring-2 focus:ring-amber/20"
        />
        <button type="button" className="rounded-md border border-line px-3 py-2 text-[12px] font-medium text-ink hover:bg-panel2" onClick={() => { setError(null); setCustomizing((current) => !current); }}>
          {customizing ? "Done" : "Customize"}
        </button>
        {customizing && (
          <button type="button" className="px-2 py-2 text-[12px] text-muted hover:text-ink" onClick={() => { resetShortcutOverrides(); setError(null); }}>
            Reset defaults
          </button>
        )}
      </div>

      {error && <p role="alert" className="mb-3 rounded-md bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</p>}

      <div className="grid grid-cols-2 gap-x-8 gap-y-6">
        {filteredGroups.map((group) => (
          <section key={group.title} aria-labelledby={`shortcut-${group.title}`}>
            <h3 id={`shortcut-${group.title}`} className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
              {localizedLabel(group.title, language)}
            </h3>
            <div className="flex flex-col gap-1.5">
              {group.commands.map((command) => {
                const bindings = effectiveBindings(command, overrides).filter(
                  (binding) => !group.context || binding.context === group.context,
                );
                const editable = customizing && group.title === "Navigation" && command.customizable;
                return (
                  <div key={`${group.title}:${command.id}`} className="flex min-h-8 items-center justify-between gap-4 rounded-md px-1 hover:bg-panel2/70">
                    <span className="text-[13px] text-ink">{localizedLabel(command.label, language)}</span>
                    {editable ? (
                      <input
                        key={`${command.id}:${formatShortcut(bindings[0]!)}`}
                        aria-label={`Shortcut for ${command.label}`}
                        defaultValue={formatShortcut(bindings[0]!)}
                        className="w-28 rounded border border-line bg-panel px-2 py-1 text-right font-mono text-[11px] outline-none focus:border-amber"
                        onBlur={(event) => {
                          const binding = parseNavigationBinding(event.target.value);
                          if (!binding) {
                            setError("Use Alt+letter or Alt+Shift+letter.");
                            event.target.value = formatShortcut(bindings[0]!);
                            return;
                          }
                          const conflicts = setShortcutOverride(command.id, [binding]);
                          if (conflicts.length) {
                            setError(`That shortcut is already assigned (${conflicts[0]!.binding}).`);
                            event.target.value = formatShortcut(bindings[0]!);
                          } else setError(null);
                        }}
                      />
                    ) : <ShortcutKeys bindings={bindings} />}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
      {filteredGroups.length === 0 && <p className="py-10 text-center text-[13px] text-muted">No shortcuts match “{query}”.</p>}
      <p className="mt-5 border-t border-line pt-3 text-[11px] leading-relaxed text-muted">
        Shortcuts pause while you type. Voucher letters work before entry begins; Alt variants remain available throughout voucher entry.
      </p>
    </Modal>
  );
}
