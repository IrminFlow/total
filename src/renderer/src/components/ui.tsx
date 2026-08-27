import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
  type TableHTMLAttributes,
} from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { X } from "@phosphor-icons/react";
import { formatPaise, parseRupees } from "@shared/money";
import { parseSmartDate, toDisplayDate } from "@shared/dates";
import { useToasts } from "../state/stores";
import { inputCls } from "./inputStyles";
import { registerModal, unregisterModal } from "./modalRegistry";

// ---------- shared text + labels ----------

export function Kbd({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <kbd className="rounded border border-line bg-panel2 px-1.5 py-0.5 font-mono text-label text-muted">
      {children}
    </kbd>
  );
}

export function SectionTitle({
  children,
  right,
}: {
  children: ReactNode;
  right?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
      <h2 className="text-[20px] font-semibold tracking-[-0.015em] whitespace-nowrap">
        {children}
      </h2>
      {right}
    </div>
  );
}

/** Persistent, consolidated form preflight. Unlike a toast, this stays beside the action and
 * exposes every known blocker at once so keyboard users do not have to fail-save repeatedly. */
export function ValidationSummary({
  issues,
}: {
  issues: string[];
}): React.JSX.Element | null {
  if (issues.length === 0) return null;
  return (
    <div
      className="rounded-md border border-cr/35 bg-cr/5 px-3 py-2"
      role="alert"
      aria-live="polite"
    >
      <p className="text-[11.5px] font-semibold text-cr">Before saving</p>
      <ul className="mt-1 grid gap-0.5 text-[11.5px] text-ink">
        {issues.map((issue) => (
          <li key={issue} className="flex gap-2">
            <span aria-hidden="true" className="text-cr">
              •
            </span>
            <span>{issue}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Signed paise rendered ledger-style: Dr green / Cr red, mono, dash for zero. */
export function Money({
  paise,
  signed = false,
  className = "",
}: {
  paise: number;
  signed?: boolean;
  className?: string;
}): React.JSX.Element {
  const tone = signed
    ? paise > 0
      ? "text-dr"
      : paise < 0
        ? "text-cr"
        : "text-muted"
    : "";
  return (
    <span className={`num ${tone} ${className}`}>
      {formatPaise(signed ? Math.abs(paise) : paise, { zeroDash: true })}
      {signed && paise !== 0 ? (paise > 0 ? " Dr" : " Cr") : ""}
    </span>
  );
}

// ---------- controls ----------

export function Field({
  label,
  children,
  hint,
  error,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
  error?: string | null;
}): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 block text-caption font-medium text-muted">
        {label}
      </span>
      {children}
      {error ? (
        <span className="mt-1 block text-hint text-cr">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-hint text-muted/80">{hint}</span>
      ) : null}
    </label>
  );
}

export const TextInput = forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(function TextInput(props, ref) {
  return (
    <input
      ref={ref}
      {...props}
      className={`${inputCls} ${props.className ?? ""}`}
    />
  );
});

export function Select(
  props: React.SelectHTMLAttributes<HTMLSelectElement>,
): React.JSX.Element {
  return (
    <select {...props} className={`${inputCls} ${props.className ?? ""}`} />
  );
}

/** Accessible, portal-rendered help text for compact workstation controls. The trigger remains
 * visually unchanged and can be focused from the keyboard. */
export function Tooltip({
  content,
  children,
  side = "top",
}: {
  content: ReactNode;
  children: React.JSX.Element;
  side?: "top" | "right" | "bottom" | "left";
}): React.JSX.Element {
  return (
    <TooltipPrimitive.Provider delayDuration={350} skipDelayDuration={100}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            sideOffset={6}
            className="z-[70] max-w-72 rounded-md border border-line bg-ink px-2.5 py-1.5 text-[11px] leading-4 text-canvas shadow-lg select-none"
          >
            {content}
            <TooltipPrimitive.Arrow className="fill-ink" />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

export function Button({
  variant = "default",
  disabledTitle,
  title,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "danger" | "ghost";
  /** Tooltip shown while the button is disabled — rendered on a wrapping span, since a
   *  pointer-events-none disabled button can't surface `title` itself. */
  disabledTitle?: string;
}): React.JSX.Element {
  const styles = {
    default:
      "border border-line bg-panel hover:border-amber/60 text-ink panel-shadow",
    primary:
      "border border-amberbar bg-amberbar text-[#2b2000] hover:brightness-95 font-semibold",
    danger: "border border-cr/50 bg-cr/10 text-cr hover:bg-cr/20",
    ghost:
      "border border-transparent text-muted hover:text-ink hover:border-line",
  }[variant];
  const button = (
    <button
      type="button"
      {...props}
      title={title}
      aria-label={props["aria-label"] ?? title}
      className={`min-h-8 rounded-md px-3 py-1.5 text-detail transition-colors disabled:opacity-40 disabled:pointer-events-none ${styles} ${props.className ?? ""}`}
    />
  );
  if (props.disabled && disabledTitle) {
    return (
      <Tooltip content={disabledTitle}>
        <span tabIndex={0} className="inline-block cursor-not-allowed">
          {button}
        </span>
      </Tooltip>
    );
  }
  return title ? <Tooltip content={title}>{button}</Tooltip> : button;
}

/** Rupee amount input that thinks in integer paise. Shows an inline error while the text
 *  doesn't parse as an amount. */
export function AmountInput({
  paise,
  onPaise,
  onEnter,
  autoFocus,
  placeholder,
  className,
  ariaLabel = "Amount",
  testId = "input-amount",
}: {
  paise: number | null;
  onPaise: (paise: number | null) => void;
  onEnter?: () => void;
  autoFocus?: boolean;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
  /** data-testid for the input (lib/testids.ts — `input-<what>`). */
  testId?: string;
}): React.JSX.Element {
  const [text, setText] = useState(
    paise != null && paise !== 0 ? formatPaise(paise) : "",
  );
  useEffect(() => {
    // Reflect external resets (e.g. clearing a form).
    if (paise == null || paise === 0) setText((t) => (parseRupees(t) ? t : ""));
  }, [paise]);
  const invalid = text.trim() !== "" && parseRupees(text) == null;
  return (
    <span className={`block min-w-0 ${className ?? ""}`}>
      <input
        className={`${inputCls} num text-right ${invalid ? "border-cr/70" : ""}`}
        data-testid={testId}
        value={text}
        autoFocus={autoFocus}
        placeholder={placeholder ?? "0.00"}
        inputMode="decimal"
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        onChange={(e) => {
          setText(e.target.value);
          onPaise(parseRupees(e.target.value));
        }}
        onBlur={() => {
          const parsed = parseRupees(text);
          if (parsed != null) setText(formatPaise(parsed));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && onEnter) onEnter();
        }}
      />
      {invalid && (
        <span className="mt-0.5 block text-hint text-cr">Not an amount</span>
      )}
    </span>
  );
}

/** Date input with Tally shorthand: "7", "7/4", "y", "t". Shows DD-MMM-YY when valid;
 *  an unparseable entry shows an inline error that clears as soon as you type again. */
export function DateInput({
  value,
  context,
  onChange,
  className,
  testId = "input-date",
}: {
  value: string;
  context: string;
  onChange: (iso: string) => void;
  className?: string;
  /** data-testid for the input (lib/testids.ts — `input-<what>`). */
  testId?: string;
}): React.JSX.Element {
  const [text, setText] = useState(toDisplayDate(value));
  const [bad, setBad] = useState(false);
  useEffect(() => setText(toDisplayDate(value)), [value]);
  return (
    <span className={`block min-w-0 ${className ?? ""}`}>
      <input
        className={`${inputCls} num ${bad ? "border-cr/70" : ""}`}
        data-testid={testId}
        value={text}
        aria-invalid={bad || undefined}
        onChange={(e) => {
          setText(e.target.value);
          if (bad) setBad(false);
        }}
        onFocus={(e) => e.target.select()}
        onBlur={() => {
          const parsed =
            parseSmartDate(text, context) ??
            (text.trim() === toDisplayDate(value) ? value : null);
          if (parsed) {
            setBad(false);
            onChange(parsed);
            setText(toDisplayDate(parsed));
          } else {
            setBad(true);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
      {bad && (
        <span className="mt-0.5 block text-hint text-cr">
          Try 7, 7/4, t, y or 15-08-2026
        </span>
      )}
    </span>
  );
}

// ---------- panels + modal ----------

export function Panel({
  children,
  className = "",
  scroll,
  ...rest
}: {
  children: ReactNode;
  className?: string;
  /** Cap the panel's content height — anything longer scrolls inside the panel instead of
   *  growing the page (Gateway top-lists, Settings backups, …). */
  scroll?: { maxH: string };
} & Omit<
  HTMLAttributes<HTMLDivElement>,
  "children" | "className"
>): React.JSX.Element {
  return (
    <div
      className={`app-panel rounded-lg border border-line bg-panel panel-shadow overflow-hidden ${className}`}
      {...rest}
    >
      {scroll ? (
        <div
          className="app-panel-scroll overflow-y-auto"
          style={{ maxHeight: scroll.maxH }}
        >
          {children}
        </div>
      ) : (
        children
      )}
    </div>
  );
}

/** A durable query failure state. Keep this distinct from EmptyState: a failed read must never
 * look like a valid zero balance or an empty register. */
export function QueryErrorState({
  title = "Could not load this view",
  detail = "Your local data has not changed. Try the request again.",
  onRetry,
  className = "",
}: {
  title?: string;
  detail?: string;
  onRetry?: () => void;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      className={`rounded-lg border border-cr/30 bg-cr/5 px-4 py-4 ${className}`}
      role="alert"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-body font-semibold text-ink">{title}</p>
          <p className="mt-1 text-small leading-5 text-muted">{detail}</p>
        </div>
        {onRetry && (
          <Button onClick={onRetry} aria-label={`Retry: ${title}`}>
            Try again
          </Button>
        )}
      </div>
    </div>
  );
}

/** A focusable report row with the same activation semantics as a button.
 * Enter and Space activate it; events from controls inside the row keep their own behavior. */
export function InteractiveReportRow({
  onActivate,
  className = "",
  children,
  ...props
}: Omit<TableHTMLAttributes<HTMLTableRowElement>, "onClick" | "onKeyDown"> & {
  onActivate: () => void;
}): React.JSX.Element {
  const isNestedControl = (target: EventTarget | null): boolean =>
    target instanceof HTMLElement &&
    target.closest(
      "button, a, input, select, textarea, [contenteditable='true']",
    ) !== null;

  return (
    <tr
      role="button"
      tabIndex={0}
      {...props}
      className={`interactive-report-row cursor-pointer ${className}`}
      onClick={(event) => {
        if (!isNestedControl(event.target)) onActivate();
      }}
      onKeyDown={(event) => {
        if (isNestedControl(event.target)) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onActivate();
        }
      }}
    >
      {children}
    </tr>
  );
}

/** Bare capped-height scroll container for lists that already live inside a Panel (or none). */
export function ScrollList({
  maxH,
  children,
  className = "",
}: {
  maxH: string;
  children: ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={`overflow-y-auto ${className}`} style={{ maxHeight: maxH }}>
      {children}
    </div>
  );
}

/** ScrollList that only clips once `active` — for tables whose rows contain absolutely-
 *  positioned TypeAhead dropdowns, which any overflow container would clip while the table
 *  is short enough not to need scrolling (voucher entry line grids). */
export function LineTableScroller({
  active,
  children,
  className = "",
  maxH = "340px",
}: {
  active: boolean;
  children: ReactNode;
  className?: string;
  maxH?: string;
}): React.JSX.Element {
  return active ? (
    <ScrollList maxH={maxH} className={className}>
      {children}
    </ScrollList>
  ) : (
    <div className={className}>{children}</div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  wide,
  dirty = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  /** When true, dismissing (Esc / overlay / ✕) first asks to discard unsaved changes. */
  dirty?: boolean;
}): React.JSX.Element {
  const previousFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const confirmRef = useRef(confirmDiscard);
  confirmRef.current = confirmDiscard;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const requestClose = useCallback((): void => {
    if (confirmRef.current) return; // discard prompt is already up — answer it instead
    if (dirtyRef.current) {
      setConfirmDiscard(true);
      return;
    }
    onCloseRef.current();
  }, []);

  useEffect(() => {
    const id = registerModal();
    return () => {
      unregisterModal(id);
      // The parent removes a controlled dialog immediately after onClose. Restore after Radix's
      // own teardown so toolbar and table-row triggers keep their keyboard position.
      const previous = previousFocusRef.current;
      queueMicrotask(() => previous?.focus());
    };
  }, []);

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) requestClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          data-modal={title}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (confirmRef.current) setConfirmDiscard(false);
            else requestClose();
          }}
          onPointerDownOutside={(event) => {
            event.preventDefault();
            requestClose();
          }}
          className={`fixed left-1/2 top-[10vh] z-40 max-h-[75vh] w-[calc(100%-2rem)] -translate-x-1/2 ${wide ? "max-w-3xl" : "max-w-lg"} overflow-auto rounded-xl border border-line bg-panel shadow-2xl outline-none`}
        >
          <div className="flex items-center justify-between border-b border-line px-5 py-3">
            <DialogPrimitive.Title className="text-title font-semibold tracking-[-0.01em]">
              {title}
            </DialogPrimitive.Title>
            <div className="flex items-center gap-2">
              <Kbd>Esc</Kbd>
              <DialogPrimitive.Close
                type="button"
                aria-label="Close"
                data-testid="modal-close"
                onClick={(event) => {
                  event.preventDefault();
                  requestClose();
                }}
                className="rounded-md border border-transparent px-1.5 py-0.5 text-[15px] leading-none text-muted transition-colors hover:border-line hover:text-ink"
              >
                <X size={15} weight="bold" />
              </DialogPrimitive.Close>
            </div>
          </div>
          <div className="p-5">{children}</div>
          {confirmDiscard && (
            <div className="flex items-center justify-between gap-3 border-t border-amber/60 bg-amber/10 px-5 py-3">
              <p className="text-detail text-ink">Discard unsaved changes?</p>
              <div className="flex shrink-0 gap-2">
                <Button
                  data-testid="modal-keep-editing"
                  onClick={() => setConfirmDiscard(false)}
                >
                  Keep editing
                </Button>
                <Button
                  variant="danger"
                  data-testid="modal-discard"
                  onClick={() => onCloseRef.current()}
                >
                  Discard
                </Button>
              </div>
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function Toasts(): React.JSX.Element {
  const { toasts, dismiss, pause, resume } = useToasts();
  const tones = {
    info: "border-blue/50 text-blue",
    success: "border-dr/50 text-dr",
    error: "border-cr/60 text-cr",
    warning: "border-amber/60 text-amber",
  };
  const labels = {
    info: "Info",
    success: "Success",
    error: "Error",
    warning: "Warning",
  };
  return (
    // Pause/resume live on the container, not the toast: React still fires the container's
    // mouseEnter/Leave when the pointer moves over a child, and a hovered toast that gets
    // removed (click-dismiss, dedupe) can no longer strand the stack in the paused state.
    <div
      onMouseEnter={pause}
      onMouseLeave={resume}
      className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-96 flex-col gap-2"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.kind === "error" ? "alert" : "status"}
          aria-live={t.kind === "error" ? "assertive" : "polite"}
          className={`pointer-events-auto rounded-lg border bg-panel text-detail shadow-xl ${tones[t.kind]}`}
        >
          <button
            aria-label={`${labels[t.kind]}: ${t.text}. Dismiss notification`}
            onClick={() => dismiss(t.id)}
            className="w-full px-4 py-2.5 text-left"
          >
            <span className="font-semibold">{labels[t.kind]}:</span> {t.text}
          </button>
        </div>
      ))}
    </div>
  );
}

// ---------- loading primitives ----------

export function Spinner({
  className = "",
}: {
  className?: string;
}): React.JSX.Element {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={`inline-block h-4 w-4 animate-spin rounded-full border-2 border-line border-t-amber ${className}`}
    />
  );
}

export function Skeleton({
  className = "",
}: {
  className?: string;
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={`block animate-pulse rounded bg-panel2 ${className}`}
    />
  );
}

/** Placeholder rows while a list/report query is in flight — drop inside a Panel. */
export function SkeletonRows({
  rows = 8,
  className = "",
}: {
  rows?: number;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      data-testid="skeleton-rows"
      className={`flex flex-col gap-2.5 p-4 ${className}`}
    >
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton
          key={i}
          className={`h-4 ${i % 3 === 0 ? "w-2/3" : i % 3 === 1 ? "w-full" : "w-5/6"}`}
        />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  action,
  icon,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  icon?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      {icon && <div className="mb-3 text-muted/50">{icon}</div>}
      <p className="text-[14px] text-muted">{title}</p>
      {hint && <p className="mt-1 text-body-sm text-muted/70">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
