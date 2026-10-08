// The app's tool set: WP 5.1 read tools over the report services, WP 5.2 screen tools (current
// screen data, explain this, and the read tools the screens expose), the WP 5.5 assistants
// (close checklist, GSTR-2B mismatches, anomalies, build_report, the 2B draft) + the draft tool.
import { READ_TOOLS } from './readTools'
import { SCREEN_TOOLS } from './screenTools'
import { draftVoucherTool } from '../drafts'
import { ASSISTANT_TOOLS } from './assistantTools'
import { ToolRegistry } from './registry'

export function createToolRegistry(): ToolRegistry {
  return new ToolRegistry([...READ_TOOLS, ...SCREEN_TOOLS, ...ASSISTANT_TOOLS, draftVoucherTool])
}
