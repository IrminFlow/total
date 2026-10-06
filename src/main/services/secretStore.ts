/**
 * The app's secret store: secrets.ts logic + Electron `safeStorage` as the cipher, persisted at
 * <dataRoot>/secrets.json (outside every company folder, so company backups never carry it).
 *
 * Hermetic test runs: when TOTAL_DATA_DIR is set AND TOTAL_INSECURE_TEST_SECRETS=1, a
 * non-secure test cipher is used instead so smoke/e2e never touch the developer's keychain (or
 * hang on a keychain prompt in CI). The flag is ignored without TOTAL_DATA_DIR, so it can never
 * apply to a real ~/Documents/total, and it is refused outright in a packaged build (app.isPackaged).
 *
 * Under Electron-as-Node (dbtests) `safeStorage` doesn't exist; the cipher then reports
 * unavailable rather than throwing at import. dbtests inject their own store anyway.
 */
import { app, safeStorage } from 'electron'
import { join } from 'path'
import { dataRoot } from '../paths'
import { log } from '../log'
import { createSecretStore, insecureTestCipher, insecureTestCipherAllowed, type SecretCipher, type SecretStore } from './secrets'

function safeStorageCipher(): SecretCipher {
  // Under Electron-as-Node `require('electron')` is just the binary path string, so
  // safeStorage is undefined there — guard every access.
  const ss = (): typeof safeStorage | undefined => safeStorage as typeof safeStorage | undefined
  return {
    isAvailable: () => {
      try {
        return !!ss()?.isEncryptionAvailable()
      } catch {
        return false
      }
    },
    encrypt: (plain) => ss()!.encryptString(plain),
    decrypt: (ct) => ss()!.decryptString(ct)
  }
}

/** app.isPackaged, or null under Electron-as-Node where `app` is undefined. */
function appIsPackaged(): boolean | null {
  try {
    return typeof app?.isPackaged === 'boolean' ? app.isPackaged : null
  } catch {
    return null
  }
}

let store: SecretStore | null = null

export function appSecretStore(): SecretStore {
  if (store) return store
  const testMode = insecureTestCipherAllowed(process.env, appIsPackaged())
  if (testMode) log('warn', 'secrets-insecure-test-cipher', { dataRoot: dataRoot() })
  else if (process.env.TOTAL_INSECURE_TEST_SECRETS === '1') {
    log('warn', 'secrets-insecure-test-cipher-refused', { packaged: appIsPackaged() })
  }
  store = createSecretStore({
    filePath: () => join(dataRoot(), 'secrets.json'),
    cipher: testMode ? insecureTestCipher() : safeStorageCipher()
  })
  return store
}
