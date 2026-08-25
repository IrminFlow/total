import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Keeps large financial reports from mounting every row in one React commit. Totals and export
 * data still use the complete source array; only the interactive table is progressively exposed.
 */
export function useBoundedRows<T>(
  rows: readonly T[],
  resetKey: string,
  pageSize = 200,
): {
  visibleRows: readonly T[];
  visibleCount: number;
  totalCount: number;
  remaining: number;
  complete: boolean;
  showMore: () => void;
} {
  const [limit, setLimit] = useState(pageSize);
  useEffect(() => setLimit(pageSize), [pageSize, resetKey]);
  const visibleRows = useMemo(() => rows.slice(0, limit), [limit, rows]);
  const remaining = Math.max(0, rows.length - visibleRows.length);
  const showMore = useCallback(
    () => setLimit((current) => Math.min(rows.length, current + pageSize)),
    [pageSize, rows.length],
  );
  return {
    visibleRows,
    visibleCount: visibleRows.length,
    totalCount: rows.length,
    remaining,
    complete: remaining === 0,
    showMore,
  };
}
