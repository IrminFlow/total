import type { ReactNode } from "react";

export interface ReportToolbarProps {
  ariaLabel?: string;
  view?: ReactNode;
  period?: ReactNode;
  granularity?: ReactNode;
  filters?: ReactNode;
  comparison?: ReactNode;
  savedView?: ReactNode;
  columns?: ReactNode;
  actions?: ReactNode;
  status?: ReactNode;
  className?: string;
  compact?: boolean;
  children?: ReactNode;
}

/** Shared report controls in a predictable keyboard and visual order. */
export function ReportToolbar({
  ariaLabel = "Report controls",
  view,
  period,
  granularity,
  filters,
  comparison,
  savedView,
  columns,
  actions,
  status,
  className = "",
  compact = false,
  children,
}: ReportToolbarProps): React.JSX.Element {
  const groups = [
    { label: "Report view", content: view },
    { label: "Period", content: period },
    { label: "Grouping", content: granularity },
    { label: "Filters", content: filters },
    { label: "Comparison", content: comparison },
    { label: "Saved views", content: savedView },
    { label: "Columns", content: columns },
    { label: "Report actions", content: actions },
  ].filter((group) => Boolean(group.content));
  return (
    <div
      role="toolbar"
      aria-label={ariaLabel}
      className={`${compact ? "flex min-w-0 flex-wrap items-center justify-end gap-2" : "flex min-w-0 flex-wrap items-center justify-between gap-3 border-y border-line py-2"} ${className}`}
    >
      {!compact && status ? <div className="min-w-0 text-detail text-muted">{status}</div> : null}
      {children ?? (
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          {groups.map((group) => (
            <div
              key={group.label}
              role="group"
              aria-label={group.label}
              className="flex min-w-0 items-center gap-2"
            >
              {group.content}
            </div>
          ))}
        </div>
      )}
      {compact ? status : null}
    </div>
  );
}
