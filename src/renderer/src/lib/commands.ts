import { useSyncExternalStore } from "react";
import type { CompanyFeatures } from "@shared/features";
import type { VoucherKind } from "@shared/domain";
import type { Role } from "./client";
import type { Screen } from "../state/stores";
import { SCREENS, type ScreenDef } from "./screens";

export type CommandContext = "global" | "gateway" | "voucher" | "screen";

export interface ShortcutBinding {
  key: string;
  context: CommandContext;
  alt?: boolean;
  shift?: boolean;
  primary?: boolean;
  label?: string;
}

export interface CommandDefinition {
  id: string;
  context: CommandContext;
  label: string;
  navigationTarget?: Screen;
  bindings: ShortcutBinding[];
  mnemonic?: string;
  keywords?: string[];
  feature?: keyof CompanyFeatures;
  roles?: Role[];
  customizable?: boolean;
}

const NAVIGATION_DEFAULTS: Partial<
  Record<Screen["name"], { key: string; shift?: boolean }>
> = {
  gateway: { key: "g" },
  "action-centre": { key: "a" },
  assist: { key: "a", shift: true },
  "task-inbox": { key: "h" },
  "voucher-entry": { key: "v" },
  "voucher-drafts": { key: "v", shift: true },
  "entry-templates": { key: "e", shift: true },
  "sales-documents": { key: "r" },
  communications: { key: "g", shift: true },
  daybook: { key: "d" },
  masters: { key: "m" },
  recurring: { key: "c" },
  "import-tally": { key: "i" },
  "trial-balance": { key: "t" },
  "profit-loss": { key: "l" },
  "balance-sheet": { key: "b" },
  "cash-flow": { key: "f" },
  procurement: { key: "r", shift: true },
  "stock-summary": { key: "s" },
  "inventory-control": { key: "n", shift: true },
  "month-close": { key: "q" },
  "year-end": { key: "y" },
  registers: { key: "e" },
  outstandings: { key: "o" },
  collections: { key: "l", shift: true },
  consolidated: { key: "n" },
  "cost-centres": { key: "c", shift: true },
  budgets: { key: "u" },
  "management-insights": { key: "i", shift: true },
  exceptions: { key: "x" },
  banking: { key: "k" },
  "supplier-dues": { key: "u", shift: true },
  payroll: { key: "p" },
  gstr1: { key: "1" },
  gstr3b: { key: "3" },
  gstr2b: { key: "2" },
  edocs: { key: "w" },
  tds: { key: "t", shift: true },
  "compliance-centre": { key: "j" },
  settings: { key: "s", shift: true },
};

function navigationCommand(def: ScreenDef): CommandDefinition {
  const navigation = NAVIGATION_DEFAULTS[def.name];
  const bindings: ShortcutBinding[] = [];
  if (def.card)
    bindings.push({ key: def.card.key.toLowerCase(), context: "gateway" });
  if (navigation)
    bindings.push({
      key: navigation.key,
      context: "global",
      alt: true,
      shift: navigation.shift,
    });
  return {
    id: `navigate.${def.name}`,
    context: "global",
    label: def.navLabel ?? def.title,
    navigationTarget: def.screen ?? undefined,
    bindings,
    mnemonic: navigation?.key ?? def.card?.key.toLowerCase(),
    keywords: def.keywords,
    feature: def.feature,
    customizable: !!navigation,
  };
}

export const NAVIGATION_COMMANDS: CommandDefinition[] = SCREENS.filter(
  (def) => def.screen != null,
).map(navigationCommand);

export const GLOBAL_COMMANDS: CommandDefinition[] = [
  { id: "global.palette", context: "global", label: "Open the command palette", bindings: [{ key: "k", context: "global", primary: true }] },
  { id: "global.shortcuts", context: "global", label: "Show keyboard shortcuts", bindings: [{ key: "?", context: "global" }] },
  { id: "global.settings", context: "global", label: "Open Settings", navigationTarget: { name: "settings" }, bindings: [{ key: ",", context: "global", primary: true }] },
  { id: "global.back", context: "global", label: "Go back", bindings: [{ key: "[", context: "global", primary: true }] },
  { id: "global.forward", context: "global", label: "Go forward", bindings: [{ key: "]", context: "global", primary: true }] },
  { id: "global.escape", context: "global", label: "Close or go back", bindings: [{ key: "Escape", context: "global" }] },
];

const VOUCHER_KEYS: Array<[VoucherKind, string, string, string?]> = [
  ["contra", "Contra", "c", "F4"],
  ["payment", "Payment", "p", "F5"],
  ["receipt", "Receipt", "r", "F6"],
  ["journal", "Journal", "j", "F7"],
  ["sales", "Sales", "s", "F8"],
  ["purchase", "Purchase", "u", "F9"],
  ["credit_note", "Credit note", "n"],
  ["debit_note", "Debit note", "d"],
  ["stock_journal", "Stock journal", "k"],
  ["physical_stock", "Physical stock", "h"],
];

export const VOUCHER_MNEMONICS: Partial<Record<VoucherKind, string>> =
  Object.fromEntries(VOUCHER_KEYS.map(([kind, , key]) => [kind, key]));

export const VOUCHER_COMMANDS: CommandDefinition[] = VOUCHER_KEYS.map(
  ([kind, label, key, fKey]) => ({
    id: `voucher.kind.${kind}`,
    context: "voucher",
    label,
    navigationTarget: { name: "voucher-entry", kindHint: kind },
    mnemonic: key,
    roles: ["owner", "accountant"],
    bindings: [
      { key, context: "voucher" },
      { key, context: "voucher", alt: true },
      ...(fKey ? [{ key: fKey, context: "voucher" as const }] : []),
      ...(kind === "credit_note" ? [
        { key: "F8", context: "voucher" as const, alt: true, label: "Alt+F8" },
        { key: "F8", context: "voucher" as const, primary: true, label: "Ctrl/Cmd+F8" },
      ] : []),
      ...(kind === "debit_note" ? [
        { key: "F9", context: "voucher" as const, alt: true, label: "Alt+F9" },
        { key: "F9", context: "voucher" as const, primary: true, label: "Ctrl/Cmd+F9" },
      ] : []),
    ],
  }),
);

export const COMMANDS: CommandDefinition[] = [
  ...GLOBAL_COMMANDS,
  ...NAVIGATION_COMMANDS,
  ...VOUCHER_COMMANDS,
];

const STORAGE_KEY = "total.shortcut-overrides.v1";
const CHANGE_EVENT = "total-shortcuts-changed";
type ShortcutOverrides = Record<string, ShortcutBinding[]>;

function validBinding(value: unknown): value is ShortcutBinding {
  if (!value || typeof value !== "object") return false;
  const binding = value as Partial<ShortcutBinding>;
  return typeof binding.key === "string" && binding.key.length > 0 &&
    ["global", "gateway", "voucher", "screen"].includes(binding.context ?? "");
}

export function readShortcutOverrides(): ShortcutOverrides {
  if (typeof localStorage === "undefined") return {};
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, bindings]) =>
        Array.isArray(bindings) && bindings.every(validBinding),
      ),
    ) as ShortcutOverrides;
  } catch {
    return {};
  }
}

export function effectiveBindings(
  command: CommandDefinition,
  overrides: ShortcutOverrides = readShortcutOverrides(),
): ShortcutBinding[] {
  const replacements = overrides[command.id];
  if (!replacements) return command.bindings;
  const replacedContexts = new Set(replacements.map((binding) => binding.context));
  return [
    ...command.bindings.filter((binding) => !replacedContexts.has(binding.context)),
    ...replacements,
  ];
}

export interface ShortcutConflict {
  context: CommandContext;
  binding: string;
  commands: string[];
}

export function bindingKey(binding: ShortcutBinding): string {
  return [binding.primary ? "primary" : "", binding.alt ? "alt" : "", binding.shift ? "shift" : "", binding.key.toLowerCase()]
    .filter(Boolean)
    .join("+");
}

export function findCommandConflicts(
  commands: CommandDefinition[] = COMMANDS,
  overrides: ShortcutOverrides = readShortcutOverrides(),
): ShortcutConflict[] {
  const groups = new Map<string, string[]>();
  for (const command of commands) {
    for (const binding of effectiveBindings(command, overrides)) {
      const group = `${binding.context}:${bindingKey(binding)}`;
      groups.set(group, [...(groups.get(group) ?? []), command.id]);
    }
  }
  return [...groups.entries()].flatMap(([group, ids]) => {
    if (ids.length < 2) return [];
    const [context, ...binding] = group.split(":");
    return [{ context: context as CommandContext, binding: binding.join(":"), commands: ids }];
  });
}

function publishShortcutChange(): void {
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function setShortcutOverride(commandId: string, bindings: ShortcutBinding[]): ShortcutConflict[] {
  const command = COMMANDS.find((candidate) => candidate.id === commandId);
  if (!command?.customizable || bindings.some((binding) => binding.context !== "global"))
    return [{ context: "global", binding: "invalid", commands: [commandId] }];
  const next = { ...readShortcutOverrides(), [commandId]: bindings };
  const conflicts = findCommandConflicts(COMMANDS, next);
  if (conflicts.length) return conflicts;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  publishShortcutChange();
  return [];
}

export function resetShortcutOverrides(): void {
  if (typeof localStorage !== "undefined") localStorage.removeItem(STORAGE_KEY);
  if (typeof window !== "undefined") publishShortcutChange();
}

export function useShortcutOverrides(): ShortcutOverrides {
  const snapshot = useSyncExternalStore(
    (listener) => {
      window.addEventListener(CHANGE_EVENT, listener);
      window.addEventListener("storage", listener);
      return () => {
        window.removeEventListener(CHANGE_EVENT, listener);
        window.removeEventListener("storage", listener);
      };
    },
    () => JSON.stringify(readShortcutOverrides()),
    () => "{}",
  );
  try {
    return JSON.parse(snapshot) as ShortcutOverrides;
  } catch {
    return {};
  }
}

export function commandAvailable(
  command: CommandDefinition,
  features?: CompanyFeatures,
  role: Role = "owner",
): boolean {
  return (!command.feature || !features || features[command.feature]) &&
    (!command.roles || command.roles.includes(role));
}

export function commandForScreen(name: Screen["name"]): CommandDefinition | undefined {
  return NAVIGATION_COMMANDS.find((command) => command.navigationTarget?.name === name);
}

export function matchesShortcut(event: KeyboardEvent, binding: ShortcutBinding): boolean {
  const keyMatches = event.key.toLowerCase() === binding.key.toLowerCase();
  const primary = event.metaKey || event.ctrlKey;
  return keyMatches && primary === !!binding.primary && event.altKey === !!binding.alt && event.shiftKey === !!binding.shift;
}

export function formatShortcut(binding: ShortcutBinding): string {
  if (binding.label) return binding.label;
  return [binding.primary ? "Cmd/Ctrl" : "", binding.alt ? "Alt" : "", binding.shift ? "Shift" : "", binding.key.length === 1 ? binding.key.toUpperCase() : binding.key]
    .filter(Boolean)
    .join("+");
}

export function voucherKindForKeyboardEvent(event: KeyboardEvent): VoucherKind | undefined {
  const command = VOUCHER_COMMANDS.find((candidate) =>
    candidate.bindings.some((binding) => matchesShortcut(event, binding)),
  );
  return command?.navigationTarget?.name === "voucher-entry"
    ? command.navigationTarget.kindHint
    : undefined;
}

const defaultConflicts = findCommandConflicts(COMMANDS, {});
if (defaultConflicts.length) {
  throw new Error(
    `Command shortcut collision: ${defaultConflicts.map((conflict) => `${conflict.context} ${conflict.binding} (${conflict.commands.join(", ")})`).join("; ")}`,
  );
}
