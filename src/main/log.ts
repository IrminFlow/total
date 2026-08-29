/**
 * Crash/error logging: JSONL lines appended to ~/Documents/total/logs/total-YYYY-MM-DD.log,
 * pruned after 14 days. Never throws — logging must never be the thing that crashes the app.
 *
 * Never log IPC payloads — only channel names and error messages (redaction by construction).
 */
import { app, shell } from 'electron'
import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'fs'
import { join } from 'path'
import { dataRoot } from './paths'
import { formatLine, isExpiredLogName, type LogLevel } from './logformat'
import { writeCrashEnvelope } from './services/crashReports'

const KEEP_DAYS = 14

export function logsDir(): string {
  return join(dataRoot(), 'logs')
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

function logFilePath(): string {
  return join(logsDir(), `total-${todayISO()}.log`)
}

function appVersion(): string {
  try {
    return app.getVersion()
  } catch {
    return '0.0.0'
  }
}

/** Append one JSONL log line. Never throws. */
export function log(level: LogLevel, event: string, data?: Record<string, unknown>): void {
  try {
    mkdirSync(logsDir(), { recursive: true })
    const line = formatLine(new Date(), level, event, appVersion(), data)
    appendFileSync(logFilePath(), line)
  } catch {
    // Logging must never throw — swallow and move on.
  }
}

/** Remove log files older than the retention window. Never throws. */
function pruneOldLogs(): void {
  try {
    const today = todayISO()
    for (const name of readdirSync(logsDir())) {
      if (isExpiredLogName(name, today, KEEP_DAYS)) {
        try {
          unlinkSync(join(logsDir(), name))
        } catch {
          // Best-effort prune — skip files we can't remove.
        }
      }
    }
  } catch {
    // logsDir() may not exist yet — nothing to prune.
  }
}

/**
 * Install crash-safety hooks and prune old logs. Call first thing in whenReady().
 * uncaughtException / unhandledRejection are logged but never cause the app to exit.
 */
export function initLogging(): void {
  try {
    mkdirSync(logsDir(), { recursive: true })
  } catch {
    // If we can't create the dir, log() below will no-op safely too.
  }
  pruneOldLogs()

  process.on('uncaughtException', (err) => {
    log('error', 'uncaughtException', { error: String(err), stack: err instanceof Error ? err.stack : undefined })
    try {
      writeCrashEnvelope({ kind: 'main_exception', appVersion: appVersion(), platform: process.platform, arch: process.arch, message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined })
    } catch {
      // Crash reporting is best-effort and must never turn one failure into another.
    }
  })
  process.on('unhandledRejection', (reason) => {
    log('error', 'unhandledRejection', { error: String(reason) })
    try {
      writeCrashEnvelope({ kind: 'main_rejection', appVersion: appVersion(), platform: process.platform, arch: process.arch, message: reason instanceof Error ? reason.message : String(reason), stack: reason instanceof Error ? reason.stack : undefined })
    } catch {
      // Crash reporting is best-effort and must never turn one failure into another.
    }
  })
}

/** Reveal the logs folder in Finder. */
export function revealLogs(): void {
  try {
    mkdirSync(logsDir(), { recursive: true })
  } catch {
    // openPath will surface the error to the user if the dir truly can't exist.
  }
  shell.openPath(logsDir())
}
