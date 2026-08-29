import { useRef, useState } from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";

export interface ActionMenuItem {
  id: string;
  label: string;
  onSelect: () => void;
  danger?: boolean;
  dividerBefore?: boolean;
  title?: string;
}

interface ActionMenuProps {
  ariaLabel: string;
  trigger: React.ReactNode;
  triggerClassName: string;
  items: readonly ActionMenuItem[];
  disabled?: boolean;
  testId?: string;
  contentClassName?: string;
}

/**
 * Compact, keyboard-complete actions menu for dense tables and workspaces.
 * Radix owns popup positioning, outside/Escape dismissal and focus return;
 * this component adds the roving menu-key behavior expected on desktop.
 */
export function ActionMenu({
  ariaLabel,
  trigger,
  triggerClassName,
  items,
  disabled = false,
  testId,
  contentClassName = "min-w-[12rem]",
}: ActionMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const initialFocusRef = useRef<"first" | "last">("first");

  const menuItems = (): HTMLButtonElement[] =>
    Array.from(
      contentRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      ) ?? [],
    );

  const focusBoundary = (boundary: "first" | "last"): void => {
    const available = menuItems();
    const target = boundary === "first" ? available[0] : available.at(-1);
    target?.focus();
  };

  const handleTriggerKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
  ): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    initialFocusRef.current = event.key === "ArrowUp" ? "last" : "first";
    setOpen(true);
  };

  const handleMenuKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>,
  ): void => {
    const available = menuItems();
    const currentIndex = available.findIndex(
      (item) => item === document.activeElement,
    );
    let nextIndex: number;

    if (event.key === "ArrowDown") {
      nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % available.length;
    } else if (event.key === "ArrowUp") {
      nextIndex =
        currentIndex < 0
          ? available.length - 1
          : (currentIndex - 1 + available.length) % available.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = available.length - 1;
    } else if (event.key === "Tab") {
      setOpen(false);
      return;
    } else {
      return;
    }

    event.preventDefault();
    available[nextIndex]?.focus();
  };

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) initialFocusRef.current = "first";
        setOpen(nextOpen);
      }}
    >
      <PopoverPrimitive.Trigger asChild>
        <button
          ref={triggerRef}
          type="button"
          data-testid={testId}
          aria-label={ariaLabel}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={disabled}
          className={triggerClassName}
          onKeyDown={handleTriggerKeyDown}
        >
          {trigger}
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          ref={contentRef}
          role="menu"
          aria-label={ariaLabel}
          align="end"
          sideOffset={4}
          collisionPadding={8}
          className={`z-[60] rounded-md border border-line bg-panel py-1 text-left panel-shadow outline-none ${contentClassName}`}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            queueMicrotask(() => focusBoundary(initialFocusRef.current));
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            triggerRef.current?.focus();
          }}
          onKeyDown={handleMenuKeyDown}
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              title={item.title}
              className={`block w-full px-3 py-1.5 text-left text-[12.5px] outline-none hover:bg-panel2 focus:bg-panel2 focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-inset ${item.dividerBefore ? "border-t border-line" : ""} ${item.danger ? "text-cr" : "text-ink"}`}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
