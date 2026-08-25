// Launch the PACKAGED app (built at whatever version you want to test) and intercept the
// updater's dialog call, proving an older install discovers the current release.
//
//   npm run build && npx electron-builder --mac --dir && node scripts/verify-update.mjs
//
// Runs on a scratch TOTAL_DATA_DIR — it must never touch ~/Documents/total.
import { _electron as electron } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const appPath = process.env.APP_PATH ?? join(process.cwd(), 'dist/mac-arm64/Total.app/Contents/MacOS/Total')
const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...desktopEnv } = process.env
const app = await electron.launch({
  executablePath: appPath,
  timeout: 60000,
  env: {
    ...desktopEnv,
    TOTAL_DATA_DIR: mkdtempSync(join(tmpdir(), 'total-update-check-')),
    TOTAL_SUPPRESS_SYNC_WARNING: '1'
  }
})
// Patch dialog.showMessageBox before the 5s update check fires.
await app.evaluate(({ dialog }) => {
  globalThis.__dialogs = []
  const original = dialog.showMessageBox.bind(dialog)
  dialog.showMessageBox = async (...args) => {
    const opts = args.find((a) => a && typeof a === 'object' && 'message' in a)
    globalThis.__dialogs.push({ message: opts?.message, detail: opts?.detail, buttons: opts?.buttons })
    return { response: 1, checkboxChecked: false } // "Later" — don't open anything
  }
  void original
})
console.log('version under test:', await app.evaluate(({ app }) => app.getVersion()))
console.log('isPackaged:', await app.evaluate(({ app }) => app.isPackaged))
for (let i = 0; i < 25; i++) {
  const dialogs = await app.evaluate(() => globalThis.__dialogs)
  if (dialogs.length) {
    console.log('UPDATE DIALOG:', JSON.stringify(dialogs[0], null, 1))
    break
  }
  await new Promise((r) => setTimeout(r, 1000))
}
await app.close()
