// Imported FIRST by main.tsx (side effect): the shifted clock of a scripted run (the preload
// passes the day main accepted — shared/e2eClock.ts), before any app module reads the date.
import { installE2eClock } from '@shared/e2eClock'

installE2eClock((window as unknown as { total?: { e2eToday?: string | null } }).total?.e2eToday ?? null)
