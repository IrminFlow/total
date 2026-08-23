/**
 * Crash/error logging: JSONL lines appended to ~/Documents/total/logs/total-YYYY-MM-DD.log,
 * pruned after 14 days. Never throws — logging must never be the thing that crashes the app.
 *
 * Never log IPC payloads — only channel names and error messages (redaction by construction).
 */
import { app, shell } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'fs'
import { join } from 'path'
import { dataRoot } from './paths'
import { formatLine, isExpiredLogName, type LogLevel } from './logformat'

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
  })
  process.on('unhandledRejection', (reason) => {
    log('error', 'unhandledRejection', { error: String(reason) })
  })
}

/** Reveal the logs folder in Finder. */
/**
 * The most recent log lines, newest last — what the support dialog shows the user *before*
 * anything is sent anywhere.
 *
 * Safe to surface verbatim by construction: `log()` records channel names, event names and
 * error messages, never IPC payloads, so no ledger name, party or amount can be in here. That
 * invariant is what lets the dialog print the report in full rather than asking the user to
 * trust a summary.
 */
export function recentLogLines(limit = 80): string[] {
  const lines: string[] = []
  try {
    // Today's file first, then yesterday's, so a crash just after midnight still has context.
    const days = [0, 1].map((back) => {
      const d = new Date()
      d.setUTCDate(d.getUTCDate() - back)
      return join(logsDir(), `total-${d.toISOString().slice(0, 10)}.log`)
    })
    for (const file of days.reverse()) {
      if (!existsSync(file)) continue
      lines.push(...readFileSync(file, 'utf8').split('\n').filter(Boolean))
    }
  } catch {
    // Diagnostics must never be the thing that fails.
  }
  return lines.slice(-limit)
}

export function revealLogs(): void {
  try {
    mkdirSync(logsDir(), { recursive: true })
  } catch {
    // openPath will surface the error to the user if the dir truly can't exist.
  }
  shell.openPath(logsDir())
}
