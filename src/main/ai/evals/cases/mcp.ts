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
  { kind: 'mcp', id: 'mcp.close-checklist', category: 'mcp_parity', title: 'close_checklist (WP 5.5)', tool: 'close_checklist', args: () => ({ period: '2026-03' }) },
  { kind: 'mcp', id: 'mcp.anomalies', category: 'mcp_parity', title: 'find_anomalies (WP 5.5)', tool: 'find_anomalies', args: () => ({ ...FY }) },
  { kind: 'mcp', id: 'mcp.viewer-remember-refused', category: 'mcp_parity', title: 'A viewer’s remember call is refused on both paths (WP 5.6)', tool: 'remember', args: () => ({ kind: 'fact', text: 'Books close on the 5th' }), refused: true },
  { kind: 'mcp', id: 'mcp.viewer-draft-refused', category: 'mcp_parity', title: 'A viewer’s draft call is refused on both paths', tool: 'draft_voucher', args: () => ({ kind: 'payment', party: 'Sharma Steel', account: 'HDFC Bank', amount: '1,000' }), refused: true }
]
