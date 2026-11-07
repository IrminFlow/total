// The gateway adapter contract against the NIC e-invoice client (services/nic.ts) over the fake NIC
// sandbox (nicFake.testutil.ts — the published IRP contract): e-invoice + e-way bill; the returns
// part must refuse as not_supported. A dbtest because nic.ts sits beside the DB services.
import { afterAll, beforeAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { nicCredentialsSchema } from '@shared/schemas'
import { einvoiceIssues } from '@shared/gst/einvoiceSchema'
import { createFakeNic } from '../services/nicFake.testutil'
import { resetNicSession } from '../services/nic'
import { createNicAdapter } from './nicAdapter'
import { CONTRACT_GSTIN, runGatewayContract, type ContractClock } from './contract.testutil'

const SECRETS = { username: 'api_user', password: 'api-pass-1', clientId: 'client-1', clientSecret: 'secret-1' }
let dir = ''
let prevDataDir: string | undefined
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'total-gw-nic-'))
  prevDataDir = process.env.TOTAL_DATA_DIR
  process.env.TOTAL_DATA_DIR = dir // log() writes under dataRoot()/logs
})
afterAll(() => {
  if (prevDataDir === undefined) delete process.env.TOTAL_DATA_DIR
  else process.env.TOTAL_DATA_DIR = prevDataDir
  rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => resetNicSession())

const START = Date.parse('2026-08-20T10:00:00+05:30')

runGatewayContract('NIC e-invoice client (fake NIC sandbox)', () => {
  let t = START
  const clock: ContractClock = { now: () => t, advance: (ms) => { t += ms } }
  const fake = createFakeNic({ ...SECRETS, gstins: [CONTRACT_GSTIN], now: clock.now, validateInvoice: einvoiceIssues })
  const deps = { fetchFn: fake.fetch, sleep: async () => undefined, now: clock.now }
  const creds = (over: Partial<typeof SECRETS> = {}) =>
    nicCredentialsSchema.parse({ baseUrlEinvoice: 'https://einv-apisandbox.nic.in', ...SECRETS, publicKeyPem: fake.publicKeyPem, ...over })
  return {
    adapter: createNicAdapter(creds(), deps),
    badAdapter: createNicAdapter(creds({ password: 'wrong' }), deps),
    who: { gstin: CONTRACT_GSTIN, username: SECRETS.username, password: '' },
    badWho: { gstin: CONTRACT_GSTIN, username: SECRETS.username, password: '' },
    clock,
    otp: '000000'
  }
})
