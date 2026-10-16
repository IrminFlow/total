// WP 7.2 (PR #112 follow-up): the AI tools follow the signed-in user's `canSeeProfit` flag. A user
// whose flag is off gets a plain refusal (the model relays it) from every tool that would show the
// profit — profit_and_loss, balance_sheet, budget_variance, build_report with a profit model,
// explain_figure on a profit figure and current_screen_data on a profit screen — and a trial
// balance without the P&L side (shared/profitRedaction.ts). `ctx.canSeeProfit` absent = allowed.
import { PROFIT_HIDDEN_TOOL_MESSAGE } from '@shared/profitRedaction'
import type { ToolContext } from './registry'

/** Screens that show the profit (the channels capabilities.ts PROFIT_CHANNELS governs). */
export const PROFIT_SCREENS: readonly string[] = [
  'profit-loss', 'balance-sheet', 'pnl-tform', 'cash-flow', 'budgets', 'ratios', 'item-profitability', 'comparative'
]

export const profitHidden = (ctx: Pick<ToolContext, 'canSeeProfit'>): boolean => ctx.canSeeProfit === false

/** Throws the plain refusal when the user may not see profit. */
export function assertProfitVisible(ctx: Pick<ToolContext, 'canSeeProfit'>): void {
  if (profitHidden(ctx)) throw new Error(PROFIT_HIDDEN_TOOL_MESSAGE)
}

/** A figure name that is the profit / loss itself ("Net profit", "Profit & Loss A/c", "P&L"). */
export const isProfitFigureName = (name: string | undefined | null): boolean => !!name && /\bprofit\b|\bloss\b|\bp\s*&\s*l\b/i.test(name)
