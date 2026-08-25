import { useCallback, useEffect, useRef, useState } from "react";
import { isAnyModalOpen } from "../components/modalRegistry";

interface HistoryEntry<T> {
  value: T;
  serialized: string;
}

interface FormHistory<T> {
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  clear: () => void;
}

const MAX_HISTORY = 60;
const COALESCE_MS = 450;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Form-level history for unposted drafts. Consecutive keystrokes are coalesced, while changes
 * separated by a pause (or discrete controls) remain individually reversible. Applying history
 * updates the ordinary React state, so existing validation, unsaved guards and draft autosave all
 * observe the restored value without a second persistence path.
 */
export function useFormHistory<T>(
  value: T,
  apply: (value: T) => void,
  enabled = true,
): FormHistory<T> {
  const serialized = JSON.stringify(value);
  const current = useRef<HistoryEntry<T>>({ value: clone(value), serialized });
  const undoStack = useRef<HistoryEntry<T>[]>([]);
  const redoStack = useRef<HistoryEntry<T>[]>([]);
  const applying = useRef(false);
  const wasEnabled = useRef(enabled);
  const lastChangeAt = useRef(0);
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const [, rerender] = useState(0);
  const refresh = (): void => rerender((count) => count + 1);

  useEffect(() => {
    if (!enabled) {
      wasEnabled.current = false;
      current.current = { value: clone(value), serialized };
      undoStack.current = [];
      redoStack.current = [];
      return;
    }
    if (!wasEnabled.current) {
      wasEnabled.current = true;
      current.current = { value: clone(value), serialized };
      return;
    }
    if (serialized === current.current.serialized) return;
    if (applying.current) {
      applying.current = false;
      current.current = { value: clone(value), serialized };
      return;
    }
    const now = Date.now();
    if (now - lastChangeAt.current > COALESCE_MS || undoStack.current.length === 0) {
      undoStack.current = [...undoStack.current, current.current].slice(-MAX_HISTORY);
    }
    current.current = { value: clone(value), serialized };
    redoStack.current = [];
    lastChangeAt.current = now;
    refresh();
  }, [enabled, serialized, value]);

  const move = useCallback((direction: "undo" | "redo") => {
    if (!enabled) return;
    const source = direction === "undo" ? undoStack : redoStack;
    const destination = direction === "undo" ? redoStack : undoStack;
    const target = source.current.at(-1);
    if (!target) return;
    source.current = source.current.slice(0, -1);
    destination.current = [...destination.current, current.current].slice(-MAX_HISTORY);
    current.current = target;
    applying.current = true;
    lastChangeAt.current = 0;
    applyRef.current(clone(target.value));
    refresh();
  }, [enabled]);

  const undo = useCallback(() => move("undo"), [move]);
  const redo = useCallback(() => move("redo"), [move]);
  const clear = useCallback(() => {
    undoStack.current = [];
    redoStack.current = [];
    current.current = { value: clone(value), serialized };
    refresh();
  }, [serialized, value]);

  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent): void => {
      if (isAnyModalOpen() || !(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      const wantsUndo = key === "z" && !event.shiftKey;
      const wantsRedo = (key === "z" && event.shiftKey) || (key === "y" && !event.shiftKey);
      if ((!wantsUndo || undoStack.current.length === 0) && (!wantsRedo || redoStack.current.length === 0)) return;
      event.preventDefault();
      if (wantsUndo) undo();
      else redo();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [enabled, redo, undo]);

  return {
    canUndo: enabled && undoStack.current.length > 0,
    canRedo: enabled && redoStack.current.length > 0,
    undo,
    redo,
    clear,
  };
}
