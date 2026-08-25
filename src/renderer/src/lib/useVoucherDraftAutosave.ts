import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { VoucherWorkDraftInput } from "@shared/voucherDrafts";
import { api } from "./client";

export type VoucherDraftAutosaveStatus = "idle" | "waiting" | "saving" | "saved" | "error";

export function useVoucherDraftAutosave(input: {
  enabled: boolean;
  meaningful: boolean;
  initialDraftId?: number;
  draft: VoucherWorkDraftInput;
  delayMs?: number;
  onSaved?: () => void;
}): {
  draftId: number | undefined;
  status: VoucherDraftAutosaveStatus;
  saveNow: () => Promise<number>;
  markCommitted: () => void;
} {
  const serialized = useMemo(() => JSON.stringify(input.draft), [input.draft]);
  const latestDraft = useRef(input.draft);
  latestDraft.current = input.draft;
  const draftIdRef = useRef<number | undefined>(input.initialDraftId);
  const [draftId, setDraftId] = useState<number | undefined>(input.initialDraftId);
  const [status, setStatus] = useState<VoucherDraftAutosaveStatus>("idle");
  const lastSaved = useRef(input.initialDraftId ? serialized : "");
  const generation = useRef(0);

  useEffect(() => {
    if (input.initialDraftId && input.initialDraftId !== draftIdRef.current) {
      draftIdRef.current = input.initialDraftId;
      setDraftId(input.initialDraftId);
      lastSaved.current = serialized;
    }
  }, [input.initialDraftId, serialized]);

  const persist = useCallback(async (): Promise<number> => {
    const snapshot = latestDraft.current;
    const snapshotSerialized = JSON.stringify(snapshot);
    const run = ++generation.current;
    setStatus("saving");
    try {
      const saved = await api.voucherDrafts.save(snapshot, draftIdRef.current);
      if (run === generation.current) {
        draftIdRef.current = saved.id;
        setDraftId(saved.id);
        lastSaved.current = snapshotSerialized;
        setStatus("saved");
        input.onSaved?.();
      }
      return saved.id;
    } catch (error) {
      if (run === generation.current) setStatus("error");
      throw error;
    }
  }, [input.onSaved]);

  useEffect(() => {
    if (!input.enabled || !input.meaningful || serialized === lastSaved.current) return;
    setStatus("waiting");
    const timer = window.setTimeout(() => void persist().catch(() => undefined), input.delayMs ?? 1500);
    return () => window.clearTimeout(timer);
  }, [input.delayMs, input.enabled, input.meaningful, persist, serialized]);

  const markCommitted = useCallback((): void => {
    generation.current += 1;
    draftIdRef.current = undefined;
    setDraftId(undefined);
    lastSaved.current = "";
    setStatus("idle");
  }, []);

  return { draftId, status, saveNow: persist, markCommitted };
}
