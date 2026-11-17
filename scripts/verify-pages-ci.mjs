import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const requiredJobs = ['verify', 'android-apk', 'android-release-upgrade']

/** Only accept checks from the exact successful main push CI run, never a same-SHA branch run. */
export const validatePublishCi = (run, jobs, sha) => {
  if (
    !run ||
    run.head_sha !== sha ||
    run.head_branch !== 'main' ||
    run.event !== 'push' ||
    run.status !== 'completed' ||
    run.conclusion !== 'success'
  ) {
    throw new Error('CI run does not prove a completed successful main push for target SHA')
  }
  for (const name of requiredJobs) {
    const matching = jobs.filter((job) => job.name === name)
    if (matching.length !== 1) {
      throw new Error(`Missing or duplicate CI job in triggering run: ${name}`)
    }
    if (matching[0].status !== 'completed' || matching[0].conclusion !== 'success') {
      throw new Error(`CI job not successful in triggering run: ${name}`)
    }
  }
  return true
}

export const selectManualDispatchRun = (runs, sha) =>
  runs.find(
    (run) =>
      run.head_sha === sha &&
      run.head_branch === 'main' &&
      run.event === 'push' &&
      run.status === 'completed' &&
      run.conclusion === 'success'
  )

const runCli = () => {
  const repo = process.env.GITHUB_REPOSITORY
  const sha = process.env.TARGET_SHA
  const triggerId = process.env.TRIGGER_CI_RUN_ID
  if (
    !repo ||
    !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo) ||
    !sha ||
    !/^[a-f0-9]{40}$/.test(sha)
  ) {
    throw new Error('Missing or invalid GitHub repository and target SHA')
  }

  const api = (path) => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8' }))

  let run
  if (triggerId) {
    if (!/^\d+$/.test(triggerId)) throw new Error('Invalid triggering CI run ID')
    run = api(`repos/${repo}/actions/runs/${triggerId}`)
  } else {
    // Manual workflow_dispatch: require the most recent completed successful main push of this exact SHA.
    const results = api(
      `repos/${repo}/actions/runs?head_sha=${sha}&branch=main&event=push&per_page=100`
    )
    run = selectManualDispatchRun(results.workflow_runs ?? [], sha)
  }
  if (!run?.id) throw new Error('No eligible successful main CI run found')
  const jobData = api(`repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`)
  validatePublishCi(run, jobData.jobs ?? [], sha)
  console.log(`Pages gate accepted CI run ${run.id} for main SHA ${sha}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    runCli()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
