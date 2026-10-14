/**
 * WP 7.3: TOTAL_TEST_DB_SYNCHRONOUS=off|normal sets PRAGMA synchronous for the DB-layer tests.
 * Real books run with the build default: better-sqlite3 compiles SQLite with
 * SQLITE_DEFAULT_WAL_SYNCHRONOUS=1, so a WAL database is NORMAL — it fsyncs (FlushFileBuffers on
 * Windows) at every checkpoint; on CI runners' disks those stalled seeding-heavy hooks (the demo
 * company is hundreds of commits) past vitest's hook timeout. OFF skips them.
 *
 * WP 7.3 review: honoured only INSIDE a vitest worker (`VITEST`, which vitest sets in every
 * worker) AND with a scratch `TOTAL_DATA_DIR`. TOTAL_DATA_DIR alone is not proof of a scratch
 * folder — the CLI sets it to the real Documents\total (cli/main.ts) and anyone may point the app
 * at real books with it — so a stray TOTAL_TEST_DB_SYNCHRONOUS in a shell can never turn off crash
 * durability for real books. Pure (no better-sqlite3) so plain vitest covers it.
 */
export function testSynchronous(env: Record<string, string | undefined>): 'OFF' | 'NORMAL' | null {
  if (!env.TOTAL_DATA_DIR || !env.VITEST) return null
  const v = env.TOTAL_TEST_DB_SYNCHRONOUS?.toLowerCase()
  return v === 'off' ? 'OFF' : v === 'normal' ? 'NORMAL' : null
}
