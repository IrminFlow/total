// The app's tool set: WP 5.1 read tools over the report services, WP 5.2 screen tools (current
// screen data, explain this, and the read tools the screens expose) + the draft tool, and WP 5.6 `remember` (proposes a memory; never active on its own).
import { READ_TOOLS } from './readTools'
import { SCREEN_TOOLS } from './screenTools'
import { draftVoucherTool } from '../drafts'
import { rememberTool } from '../memory'
import { ToolRegistry } from './registry'

export function createToolRegistry(): ToolRegistry {
  return new ToolRegistry([...READ_TOOLS, ...SCREEN_TOOLS, draftVoucherTool, rememberTool])
}
