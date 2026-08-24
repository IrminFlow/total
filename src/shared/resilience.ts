export interface BackupDestination {
  id: number;
  name: string;
  path: string;
  active: boolean;
  kind: "local" | "external" | "network_or_mounted_cloud";
  available: boolean;
  writable: boolean;
  freeBytes: number | null;
  warning: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  createdBy: string;
  createdAt: string;
}

export interface RecoveryDrill {
  id: number;
  backupFile: string;
  sourceKind: "company" | "destination";
  sourcePath: string;
  integrity: "ok" | "failed";
  detail: string;
  companyName: string | null;
  schemaVersion: number | null;
  voucherCount: number | null;
  verifiedBy: string;
  verifiedAt: string;
}

export interface BackupRotationPolicy {
  dailyCount: number;
  weeklyCount: number;
  monthlyCount: number;
  yearEndCount: number;
  updatedBy: string;
  updatedAt: string;
}

export interface BackupSpaceForecast {
  currentBytes: number;
  averageBytes: number;
  projectedRetainedFiles: number;
  projectedBytes: number;
  destinationFreeBytes: number | null;
  fitsDestination: boolean | null;
}
