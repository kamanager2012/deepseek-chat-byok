import { describe, expect, it } from 'vitest'
import { selectManualDispatchRun, validatePublishCi } from '../scripts/verify-pages-ci.mjs'

const sha = '6fe8787defb318147876a66af35f190c641be22a'
const validRun = {
  id: 123,
  head_sha: sha,
  head_branch: 'main',
  event: 'push',
  status: 'completed',
  conclusion: 'success',
}
const jobs = ['verify', 'android-apk', 'android-release-upgrade'].map((name) => ({
  name,
  status: 'completed',
  conclusion: 'success',
}))

describe('Pages exact CI run gate', () => {
  it('accepts the actual completed main branch workflow run', () => {
    expect(validatePublishCi(validRun, jobs, sha)).toBe(true)
  })

  it('does not mistake a same-SHA feature branch or unfinished CI for a valid main CI', () => {
    expect(() => validatePublishCi({ ...validRun, head_branch: 'feat/pages' }, jobs, sha)).toThrow()
    expect(() =>
      validatePublishCi({ ...validRun, status: 'in_progress', conclusion: null }, jobs, sha)
    ).toThrow()
  })

  it('requires every job of the specific main CI run, not the latest global check-run', () => {
    expect(() =>
      validatePublishCi(validRun, jobs.filter((job) => job.name !== 'verify'), sha)
    ).toThrow('Missing or duplicate')
    expect(() =>
      validatePublishCi(
        validRun,
        jobs.map((job) =>
          job.name === 'android-release-upgrade' ? { ...job, conclusion: 'skipped' } : job
        ),
        sha
      )
    ).toThrow('not successful')
  })

  it('allows manual dispatch only if a successful main push matches the exact SHA', () => {
    const feature = { ...validRun, id: 999, head_branch: 'feat/pages' }
    expect(selectManualDispatchRun([feature, validRun], sha)?.id).toBe(123)
    expect(selectManualDispatchRun([feature], sha)).toBeUndefined()
    expect(selectManualDispatchRun([validRun], '0'.repeat(40))).toBeUndefined()
  })
})
