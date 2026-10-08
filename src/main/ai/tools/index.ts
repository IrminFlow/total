// The app's tool set (WP 5.1): read tools over the report services + the draft tools (WP 5.3:
// every voucher kind — drafting/tools.ts).
import { READ_TOOLS } from './readTools'
import { DRAFT_TOOLS } from '../drafting/tools'
import { ToolRegistry } from './registry'

export function createToolRegistry(): ToolRegistry {
  return new ToolRegistry([...READ_TOOLS, ...DRAFT_TOOLS])
}
