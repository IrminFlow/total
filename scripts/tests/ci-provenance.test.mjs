import test from 'node:test'
import assert from 'node:assert/strict'
import { validateSuccessfulCiRun } from '../lib/ci-provenance.mjs'

const revision = 'a'.repeat(40)

function run(overrides = {}) {
  return {
    id: 42,
    run_attempt: 1,
    head_sha: revision,
    head_branch: 'main',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    path: 'IrminFlow/total/.github/workflows/ci.yml@refs/heads/main',
    ...overrides,
  }
}

test('accepts completed successful push CI for the exact main revision', () => {
  assert.deepEqual(
    validateSuccessfulCiRun({ workflow_runs: [run()] }, { revision }),
    {
      runId: 42,
      runAttempt: 1,
      revision,
      branch: 'main',
      conclusion: 'success',
    },
  )
})

test('rejects successful CI belonging to another revision', () => {
  assert.throws(
    () =>
      validateSuccessfulCiRun(
        { workflow_runs: [run({ head_sha: 'b'.repeat(40) })] },
        { revision },
      ),
    /No push CI run exists/,
  )
})

test('rejects a passing pull-request run as release provenance', () => {
  assert.throws(
    () =>
      validateSuccessfulCiRun(
        { workflow_runs: [run({ event: 'pull_request' })] },
        { revision },
      ),
    /No push CI run exists/,
  )
})

test('rejects incomplete, failed, or unrelated workflow runs', async (t) => {
  for (const [name, overrides] of [
    ['incomplete', { status: 'in_progress', conclusion: null }],
    ['failed', { conclusion: 'failure' }],
    ['unrelated', { path: '.github/workflows/soak.yml' }],
  ]) {
    await t.test(name, () => {
      assert.throws(
        () =>
          validateSuccessfulCiRun(
            { workflow_runs: [run(overrides)] },
            { revision },
          ),
        name === 'unrelated' ? /No push CI run exists/ : /has not completed successfully/,
      )
    })
  }
})

test('requires well-formed response and immutable release identity', () => {
  assert.throws(
    () => validateSuccessfulCiRun({}, { revision }),
    /workflow_runs/,
  )
  assert.throws(
    () => validateSuccessfulCiRun({ workflow_runs: [run()] }, { revision: 'short' }),
    /full lowercase release revision/,
  )
})
