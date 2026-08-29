/**
 * A stand-in for the `electron` module, used only in the MCP server bundle.
 *
 * The server runs under ELECTRON_RUN_AS_NODE, which is Electron acting as a plain Node runtime:
 * there is no `app`, no `safeStorage`, and inside a packaged bundle there is no
 * `node_modules/electron` to resolve either. Requiring it there fails at load with "Cannot find
 * module 'electron'" -- which passed unnoticed in development, where the npm shim happens to
 * resolve and the code paths that would have used `app` never ran.
 *
 * So the bundle aliases `electron` here. The server needs exactly one thing from it, a data
 * root, and homedir() answers that honestly in a headless process.
 */

import { homedir } from 'os'
import { join } from 'path'

export const app = {
  getPath(name: string): string {
    if (name === 'documents') return join(homedir(), 'Documents')
    if (name === 'userData') return join(homedir(), 'Library', 'Application Support', 'Total')
    return homedir()
  },
  getVersion: (): string => process.env.npm_package_version ?? '0.0.0',
  getAppPath: (): string => process.cwd()
}

/** The MCP server never stores secrets; reporting "unavailable" keeps the secret store in its
 *  refuse-to-persist branch rather than pretending it can encrypt. */
export const safeStorage = {
  isEncryptionAvailable: (): boolean => false,
  encryptString: (): Buffer => {
    throw new Error('safeStorage is not available in the MCP server')
  },
  decryptString: (): string => {
    throw new Error('safeStorage is not available in the MCP server')
  }
}

export const shell = { openExternal: async (): Promise<void> => undefined }
export const Notification = class {
  static isSupported(): boolean {
    return false
  }
  show(): void {}
}
