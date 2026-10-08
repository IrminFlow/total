// MCP parity: the same tool through the MCP server (SDK client, in-memory transport) and through
// the registry gives byte-identical results — masked by field when masking is on — and the same
// tool list per role; a viewer's draft call is refused on both paths.
import type { EvalCase } from '../types'
import { FY, TODAY } from './util'

export const MCP_CASES: EvalCase[] = [
  { kind: 'mcp', id: 'mcp.tools-viewer', category: 'mcp_parity', title: 'Tool list for a viewer', tool: 'tools/list', args: () => ({}), role: 'viewer' },
  { kind: 'mcp', id: 'mcp.tools-accountant', category: 'mcp_parity', title: 'Tool list for an accountant', tool: 'tools/list', args: () => ({}), role: 'accountant' },
  { kind: 'mcp', id: 'mcp.pnl', category: 'mcp_parity', title: 'profit_and_loss', tool: 'profit_and_loss', args: () => ({ ...FY }) },
  { kind: 'mcp', id: 'mcp.outstandings', category: 'mcp_parity', title: 'outstandings (receivable)', tool: 'outstandings', args: () => ({ side: 'receivable', asOn: TODAY }) },
  { kind: 'mcp', id: 'mcp.ledger-injected', category: 'mcp_parity', title: 'ledger_statement with a planted narration', tool: 'ledger_statement', args: (f) => ({ ledgerId: f.ids.krishna, ...FY }) },
  { kind: 'mcp', id: 'mcp.stock', category: 'mcp_parity', title: 'stock_summary', tool: 'stock_summary', args: () => ({ asOn: TODAY }) },
  { kind: 'mcp', id: 'mcp.masked-ledgers', category: 'mcp_parity', title: 'list_ledgers with masking on', tool: 'list_ledgers', args: () => ({}), masked: true },
  { kind: 'mcp', id: 'mcp.viewer-draft-refused', category: 'mcp_parity', title: 'A viewer’s draft call is refused on both paths', tool: 'draft_voucher', args: () => ({ kind: 'payment', party: 'Sharma Steel', account: 'HDFC Bank', amount: '1,000' }), refused: true }
]
