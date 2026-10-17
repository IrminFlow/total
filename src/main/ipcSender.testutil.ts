// Test shim for the D7 sender check (ipcSender.ts): dbtests call the registered handlers directly,
// so they pass TRUSTED_EVENT — a main frame showing the configured renderer page.
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { configureTrustedRenderer } from './ipcSender'

// Built like main/index.ts builds it, so it is a valid file URL on every platform (a literal
// `file:///test/…` has no drive letter and is not a local path on Windows).
export const TEST_RENDERER_URL = pathToFileURL(join(tmpdir(), 'total-test', 'out', 'renderer', 'index.html')).href
configureTrustedRenderer({ fileUrl: TEST_RENDERER_URL })

const mainFrame = { url: TEST_RENDERER_URL, parent: null, processId: 1, routingId: 1 }
export const TRUSTED_EVENT = { senderFrame: mainFrame, sender: { id: 1, mainFrame } }
