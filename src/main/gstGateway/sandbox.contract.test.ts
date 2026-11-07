// The gateway contract against a REAL GSP sandbox — run only by the manual CI workflow
// (.github/workflows/gsp-sandbox.yml, workflow_dispatch) with TOTAL_GSP_SANDBOX=<provider id> and
// the sandbox credentials from the repository secrets. Skipped everywhere else (no network in the
// normal suites). Phase 4 ships NO real GSP adapter yet (owner, 7 Nov 2026: no GSP chosen, no
// sandbox credentials): asking for one fails with that message until an adapter registers here.
import { describe, expect, it } from 'vitest'
import type { GstGatewayAdapter } from './types'
import { runGatewayContract, type ContractSetup } from './contract.testutil'

/** Real GSP adapters by provider id — empty until a GSP is chosen. */
const SANDBOX_ADAPTERS: Record<string, (env: NodeJS.ProcessEnv) => GstGatewayAdapter> = {}

const wanted = process.env.TOTAL_GSP_SANDBOX

if (!wanted) {
  describe.skip('gateway contract: GSP sandbox (manual workflow only)', () => {
    it('runs with TOTAL_GSP_SANDBOX set', () => undefined)
  })
} else if (!SANDBOX_ADAPTERS[wanted]) {
  describe('gateway contract: GSP sandbox', () => {
    it(`has an adapter for "${wanted}"`, () => {
      expect.fail(`No real GSP adapter "${wanted}" is registered yet (Phase 4 ships the Test GSP only) — add it to SANDBOX_ADAPTERS.`)
    })
  })
} else {
  const env = process.env
  runGatewayContract(`GSP sandbox (${wanted})`, (): ContractSetup => ({
    adapter: SANDBOX_ADAPTERS[wanted]!(env),
    who: { gstin: env.GSP_SANDBOX_GSTIN ?? '', username: env.GSP_SANDBOX_USERNAME ?? '', password: env.GSP_SANDBOX_PASSWORD ?? '' },
    badWho: { gstin: env.GSP_SANDBOX_GSTIN ?? '', username: env.GSP_SANDBOX_USERNAME ?? '', password: 'wrong-password' },
    clock: { now: () => Date.now(), advance: () => { throw new Error('a real sandbox cannot move its clock — the window tests need the simulator') } },
    otp: env.GSP_SANDBOX_OTP ?? ''
  }))
}
