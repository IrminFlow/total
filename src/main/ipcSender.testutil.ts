// Test shim for the D7 sender check (ipcSender.ts): dbtests call the registered handlers directly,
// so they pass TRUSTED_EVENT — a main frame showing the configured renderer page.
import { configureTrustedRenderer } from './ipcSender'

export const TEST_RENDERER_URL = 'file:///test/out/renderer/index.html'
configureTrustedRenderer({ fileUrl: TEST_RENDERER_URL })

const mainFrame = { url: TEST_RENDERER_URL, parent: null, processId: 1, routingId: 1 }
export const TRUSTED_EVENT = { senderFrame: mainFrame, sender: { id: 1, mainFrame } }
