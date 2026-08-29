const FULL_REVISION = /^[a-f0-9]{40}$/
const CI_WORKFLOW_PATH = /(?:^|\/)\.github\/workflows\/ci\.yml(?:@|$)/

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/**
 * Require a successful push CI run for the exact release commit. A passing PR
 * run, an ancestor's run, or a still-running workflow is not release evidence.
 */
export function validateSuccessfulCiRun(payload, { revision, branch = 'main' }) {
  assert(FULL_REVISION.test(revision ?? ''), 'A full lowercase release revision is required')
  assert(payload && Array.isArray(payload.workflow_runs), 'GitHub CI response must contain workflow_runs')

  const exactRuns = payload.workflow_runs.filter(
    (run) =>
      run &&
      run.head_sha === revision &&
      run.head_branch === branch &&
      run.event === 'push' &&
      CI_WORKFLOW_PATH.test(String(run.path ?? '')),
  )
  assert(exactRuns.length > 0, `No push CI run exists for ${revision} on ${branch}`)

  const successful = exactRuns
    .filter(
      (run) =>
        run.status === 'completed' &&
        run.conclusion === 'success' &&
        Number.isSafeInteger(run.id) &&
        run.id > 0 &&
        Number.isSafeInteger(run.run_attempt) &&
        run.run_attempt > 0,
    )
    .sort((left, right) => right.id - left.id)[0]
  assert(successful, `CI has not completed successfully for ${revision} on ${branch}`)

  return {
    runId: successful.id,
    runAttempt: successful.run_attempt,
    revision: successful.head_sha,
    branch: successful.head_branch,
    conclusion: successful.conclusion,
  }
}
