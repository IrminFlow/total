// Imported FIRST by main/index.ts (side effect): a scripted run with TOTAL_E2E_TODAY shifts the
// clock before any other module reads it (shared/e2eClock.ts has the rules).
import { app } from 'electron'
import { e2eTodayFromEnv, installE2eClock } from '@shared/e2eClock'

export const e2eToday = e2eTodayFromEnv(process.env, app.isPackaged)
installE2eClock(e2eToday)
