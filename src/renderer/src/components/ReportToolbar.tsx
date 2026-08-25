import type { ReactNode } from "react";

export interface ReportToolbarProps {
  period?: ReactNode;
  granularity?: ReactNode;
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
  period,
  granularity,
  comparison,
  savedView,
  columns,
  actions,
  status,
  className = "",
  compact = false,
  children,
}: ReportToolbarProps): React.JSX.Element {
  const groups = [period, granularity, comparison, savedView, columns, actions].filter(Boolean);
  return (
    <div
      role="toolbar"
      aria-label="Report controls"
      className={`${compact ? "flex items-center gap-2" : "flex min-w-0 flex-wrap items-center justify-between gap-3 border-y border-line py-2"} ${className}`}
    >
      {!compact && status ? <div className="min-w-0 text-detail text-muted">{status}</div> : null}
      {children ?? (
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          {groups.map((group, index) => (
            <div key={index} className="flex min-w-0 items-center gap-2">
              {group}
            </div>
          ))}
        </div>
      )}
      {compact ? status : null}
    </div>
  );
}
