// Scenario 42 — MCP server and agent drafts (WP 5.7). While the app is open, a real MCP client
// (the official SDK over stdio) starts `total-cli mcp` against the same scratch data dir: it lists
// the tools, reads a resource, and — as accountant — drafts a rent payment. An inbox drop becomes a
// flagged draft instead of a posting. Settings → Agent access shows the MCP section (snippets,
// kill switch), the drafts from agents and the MCP request log; reviewing the MCP draft opens the
// voucher editor pre-filled and saving consumes it. Turning MCP off makes the next server refuse
// to start. Every view is shot in both themes; set WP57_SHOTS=/tmp/wp57 to copy them there.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { scenario, assert, assertEq } from '../lib/harness.mjs'

const require = createRequire(import.meta.url)
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')

await scenario('42-mcp-server', async (h) => {
  await h.createCompanyUI('MCP Co')
  const slug = 'mcp-co'
  const extraShots = process.env.WP57_SHOTS
  const shot = async (name) => {
    await h.page.mouse.move(0, 0)
    await h.page.waitForTimeout(250)
    await h.shot(name)
    if (extraShots) {
      fs.mkdirSync(extraShots, { recursive: true })
      fs.copyFileSync(path.join(h.outDir, `${name}.png`), path.join(extraShots, `${name}.png`))
    }
  }
  const setTheme = async (theme) => {
    const now = await h.page.evaluate(() => document.documentElement.dataset.theme ?? 'light')
    if (now !== theme) await h.page.evaluate(() => document.querySelector('[data-testid="btn-theme"]').click())
    await h.page.waitForFunction((t) => (document.documentElement.dataset.theme ?? 'light') === t, theme)
    await h.page.waitForTimeout(300)
  }
  const bothThemes = async (name) => {
    await setTheme('light')
    await shot(`${name}-light`)
    await setTheme('dark')
    await shot(`${name}-dark`)
    await setTheme('light')
  }

  // ---------- books ----------
  const groups = await h.invoke('master:groups:list')
  const gid = (name) => groups.find((g) => g.name === name).id
  const ledger = (name, group, gstin = null) =>
    h.invoke('master:ledgers:create', { name, groupId: gid(group), openingBalance: 0, gstin, stateCode: gstin ? '27' : null, address: null, taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null })
  const rent = await ledger('Shop Rent', 'Indirect Expenses')
  await ledger('Acme Traders', 'Sundry Debtors', '27AAPFU0939F1ZV')
  const cash = (await h.invoke('master:ledgers:list')).find((l) => l.name === 'Cash').id
  const types = await h.invoke('master:voucherTypes:list')
  const today = await h.page.evaluate(() => new Date().toISOString().slice(0, 10))
  const fy = await h.page.evaluate(() => (new Date().getMonth() >= 3 ? new Date().getFullYear() : new Date().getFullYear() - 1))
  const vouchers = async () => (await h.invoke('voucher:list', { from: `${fy}-04-01`, to: `${fy + 1}-03-31` })).length

  // ---------- an MCP client starts the server over stdio, next to the running app ----------
  const env = { ...process.env, TOTAL_DATA_DIR: h.dataDir, TOTAL_SUPPRESS_SYNC_WARNING: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const startClient = async (args) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(h.appDir, 'scripts', 'total-cli.mjs'), 'mcp', '--company', slug, ...args],
      env,
      stderr: 'pipe'
    })
    let stderr = ''
    transport.stderr?.on('data', (d) => (stderr += d.toString()))
    const client = new Client({ name: 'e2e-client', version: '1.0.0' })
    await client.connect(transport)
    return { client, stderr: () => stderr }
  }

  const viewer = await startClient([])
  const viewerTools = (await viewer.client.listTools()).tools.map((t) => t.name)
  assert(viewerTools.includes('trial_balance') && !viewerTools.includes('draft_voucher'), `viewer tools: ${viewerTools.join(', ')}`)
  const company = await viewer.client.readResource({ uri: 'total://company' })
  const companyText = company.contents[0].text
  assert(companyText.includes('MCP Co'), 'resource total://company reads the company')
  const acme = await viewer.client.callTool({ name: 'list_ledgers', arguments: { search: 'Acme' } })
  assert(!acme.content[0].text.includes('27AAPFU0939F1ZV') && acme.content[0].text.includes('[GSTIN …1ZV]'), 'GSTIN masked by default')
  await viewer.client.close()

  const accountant = await startClient(['--role', 'accountant'])
  const drafted = await accountant.client.callTool({
    name: 'draft_voucher',
    arguments: { kind: 'payment', date: today, narration: 'Shop rent for the month', lines: [{ ledgerId: rent.id, drCr: 'dr', amount: '2,500' }, { ledgerId: cash, drCr: 'cr', amount: '2,500' }] }
  })
  assert(!drafted.isError, `draft_voucher over MCP: ${drafted.content[0].text}`)
  const mcpDraftId = JSON.parse(drafted.content[0].text).result.draftId
  await accountant.client.close()
  assertEq(await vouchers(), 0, 'drafting over MCP wrote nothing to the books')

  // ---------- an inbox drop becomes a flagged draft, not a posting ----------
  const inbox = path.join(h.dataDir, 'companies', slug, 'inbox')
  fs.mkdirSync(inbox, { recursive: true })
  const receiptType = types.find((t) => t.kind === 'receipt').id
  const sales = await ledger('Counter Sales', 'Sales Accounts')
  fs.writeFileSync(
    path.join(inbox, 'from-script.json'),
    JSON.stringify({ voucherTypeId: receiptType, date: today, narration: 'Counter takings', lines: [{ ledgerId: cash, drCr: 'dr', amount: 1250000 }, { ledgerId: sales.id, drCr: 'cr', amount: 1250000 }] })
  )
  await h.invoke('agent:setConfig', { enabled: true })
  let drafts = []
  for (let i = 0; i < 40 && drafts.length < 2; i++) {
    await h.page.waitForTimeout(250)
    drafts = await h.invoke('agent:drafts', { status: 'open' })
  }
  assertEq(drafts.length, 2, 'one MCP draft and one inbox draft are waiting')
  const inboxDraft = drafts.find((d) => d.source === 'inbox')
  assert(inboxDraft && inboxDraft.unrequested && inboxDraft.origin === 'from-script.json', `inbox draft flagged: ${JSON.stringify(inboxDraft)}`)
  assert(drafts.find((d) => d.id === mcpDraftId)?.origin === 'e2e-client', 'MCP draft records its client')
  assertEq(await vouchers(), 0, 'the inbox drop was not posted')

  // ---------- Settings → Agent access ----------
  await h.goto('settings')
  await h.click('tab-settings-agents')
  await h.page.waitForSelector('[data-testid="settings-mcp"]', { timeout: 10000 })
  await h.page.waitForSelector('[data-testid="rows-agent-drafts"] tr', { timeout: 10000 })
  await h.page.waitForSelector('[data-testid="rows-mcp-log"] tr', { timeout: 10000 })
  const snippet = await h.page.$eval('[data-testid="mcp-snippet-claude-code"]', (el) => el.textContent)
  assert(snippet.startsWith('claude mcp add total-mcp-co') && snippet.includes('scripts/total-cli.mjs mcp --company mcp-co'), `snippet: ${snippet}`)
  const toTop = () => h.page.evaluate(() => document.querySelector('[data-testid="settings-mcp"]')?.scrollIntoView({ block: 'start' }))
  await toTop()
  // Let the "company created" toast from the start of the run go before the first shots.
  await h.page.waitForFunction(() => !document.body.innerText.includes('MCP Co created'), null, { timeout: 15000 }).catch(() => undefined)
  await bothThemes('01-agent-access-mcp')
  await h.click('mcp-role-accountant')
  const accSnippet = await h.page.$eval('[data-testid="mcp-snippet-claude-code"]', (el) => el.textContent)
  assert(accSnippet.includes('--role accountant'), `accountant snippet: ${accSnippet}`)
  await h.page.evaluate(() => document.querySelector('[data-testid="rows-agent-drafts"]')?.scrollIntoView({ block: 'start' }))
  await bothThemes('02-agent-drafts-and-log')

  // ---------- review the MCP draft → save → consumed ----------
  await h.page.click(`[data-testid="rows-agent-drafts"] tr:has-text("Shop Rent") [data-testid="btn-agent-draft-review"]`)
  await h.waitScreen('voucher-entry')
  const banner = await h.page.waitForSelector('[data-testid="ai-draft-banner"]', { timeout: 10000 })
  assert((await banner.textContent()).includes('Proposed over MCP by e2e-client'), 'the editor says where the draft came from')
  await h.page.keyboard.press('Control+Enter')
  await h.page.waitForFunction(() => document.querySelector('[data-screen]')?.getAttribute('data-screen') !== 'voucher-entry', null, { timeout: 15000 })
  assertEq((await h.invoke('ai:draft:get', { id: mcpDraftId })).status, 'consumed', 'saving consumed the MCP draft')
  assertEq(await vouchers(), 1, 'the reviewed draft is now in the books — saved by the user')
  const audit = await h.invoke('audit:list', { entity: 'ai_draft', page: 0 })
  assert(
    audit.rows.some((r) => r.userName === 'mcp:e2e-client' && r.entityId === mcpDraftId && r.action === 'create'),
    `the MCP draft was audited as mcp:e2e-client: ${JSON.stringify(audit.rows.map((r) => [r.entityId, r.action, r.userName]))}`
  )
  assert(audit.rows.some((r) => r.userName === 'agent-inbox' && r.entityId === inboxDraft.id), 'the inbox draft was audited as agent-inbox')

  // ---------- kill switch ----------
  await h.goto('settings')
  await h.click('tab-settings-agents')
  await h.page.waitForSelector('[data-testid="settings-mcp"]', { timeout: 10000 })
  await h.click('btn-settings-mcp-toggle')
  await h.page.waitForSelector('[data-testid="mcp-killed"]', { timeout: 10000 })
  await toTop()
  await bothThemes('03-agent-access-mcp-off')
  let refused = ''
  try {
    const c = await startClient([])
    await c.client.listTools()
    await c.client.close()
  } catch (err) {
    refused = String(err?.message ?? err)
  }
  assert(refused !== '', 'a new MCP session is refused while MCP is off')
  assertEq((await h.invoke('agent:mcp:get')).config.enabled, false, 'the kill switch is stored')
})
