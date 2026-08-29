// Runs the icon renderer under a real Electron.
//
// The dev shell exports ELECTRON_RUN_AS_NODE=1 for the driver scripts (see CLAUDE.md), which
// makes `require('electron')` hand back a path string instead of the API. The renderer needs a
// browser window, so that variable is stripped for this one child process.
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

execFileSync(require('electron'), ['scripts/make-icon.cjs'], { stdio: 'inherit', env })
