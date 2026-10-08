// The app's tool set (WP 5.1): read tools over the report services + the draft tool.
import { READ_TOOLS } from './readTools'
import { draftVoucherTool } from '../drafts'
import { ToolRegistry } from './registry'

export function createToolRegistry(): ToolRegistry {
  return new ToolRegistry([...READ_TOOLS, draftVoucherTool])
}
