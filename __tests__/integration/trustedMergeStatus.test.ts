import * as core from '@actions/core'
import { installFakeGitHub, FakeGitHub } from '../testHelpers/fakeGithub'
import { CommitStatusFixture } from '../testHelpers/fakeGithubCore'
import { resetEnv, setDefaultInputs } from '../testHelpers/env'
import { reloadOctokit, setContext } from '../testHelpers/context'

const MERGE_SHA = 'a'.repeat(40)
const ACTIONS_BOT = { login: 'github-actions[bot]', id: 41898282 }
const CATCH_UP = 'cmux/catch-up'

async function runAction() {
  reloadOctokit()
  for (const path of Object.keys(require.cache)) {
    if (path.includes('/src/')) delete require.cache[path]
  }
  const { run } = require('../../src/main') as typeof import('../../src/main')
  await run()
}

function watchCore() {
  const failed = jest.spyOn(core, 'setFailed').mockImplementation(() => {})
  const info = jest.spyOn(core, 'info').mockImplementation(() => {})
  const output = jest.spyOn(core, 'setOutput').mockImplementation(() => {})
  return {
    get failures() {
      return failed.mock.calls.map(c => String(c[0]))
    },
    get outputs() {
      return output.mock.calls.map(c => [c[0], c[1]])
    },
    restore() {
      failed.mockRestore()
      info.mockRestore()
      output.mockRestore()
    }
  }
}

describe('trusted merge status', () => {
  let fake: FakeGitHub

  afterEach(async () => {
    await fake.close()
    resetEnv()
  })

  function setUp(options: {
    inputs?: Record<string, string>
    parentCount?: number
    statuses?: CommitStatusFixture[]
    forkStatuses?: CommitStatusFixture[]
  }) {
    setDefaultInputs({
      'path-to-signatures': 'signatures/cla.json',
      'trusted-merge-status-context': CATCH_UP,
      'trusted-merge-status-creator-ids': String(ACTIONS_BOT.id),
      ...(options.inputs || {})
    })
    fake = installFakeGitHub()
    const repository = fake.repo('acme', 'widgets')
    repository.addPullRequest({
      number: 12,
      head: { sha: 'headsha', ref: 'feature/cla' },
      user: { login: 'alice', id: 1001 },
      commits: [
        { author: { login: 'alice', id: 1001 } },
        {
          oid: MERGE_SHA,
          parentCount: options.parentCount ?? 2,
          author: ACTIONS_BOT
        }
      ]
    })
    repository.setFile('signatures/cla.json', {
      signedContributors: [{ name: 'alice', id: 1001 }]
    })
    // Oldest first here; addCommitStatus lists the newest first.
    for (const status of options.statuses || []) {
      repository.addCommitStatus(MERGE_SHA, status)
    }
    for (const status of options.forkStatuses || []) {
      fake.repo('mallory', 'widgets').addCommitStatus(MERGE_SHA, status)
    }
    setContext({
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 12,
      actor: 'alice',
      eventName: 'pull_request_target',
      payload: {
        pull_request: { number: 12, state: 'open' },
        repository: { id: repository.state.id },
        action: 'synchronize'
      }
    })
  }

  const success: CommitStatusFixture = {
    context: CATCH_UP,
    state: 'success',
    creator: ACTIONS_BOT
  }

  it('skips a merge commit vouched for by a trusted status in this repository', async () => {
    setUp({ statuses: [success] })
    const watch = watchCore()
    await runAction()
    expect(watch.failures).toEqual([])
    expect(watch.outputs).toContainEqual(['cla_passed', true])
    expect(
      fake.requestLog.some(
        r =>
          r.method === 'GET' &&
          r.path.startsWith(`/repos/acme/widgets/commits/${MERGE_SHA}/statuses`)
      )
    ).toBe(true)
    watch.restore()
  })

  it('requires the merge author to sign without a status', async () => {
    setUp({})
    const watch = watchCore()
    await runAction()
    expect(watch.failures.join('\n')).toMatch(
      /Committers of Pull Request number 12/
    )
    watch.restore()
  })

  it('ignores a status created by an account that is not configured', async () => {
    setUp({
      statuses: [
        { context: CATCH_UP, state: 'success', creator: { login: 'x', id: 7 } }
      ]
    })
    const watch = watchCore()
    await runAction()
    expect(watch.failures.join('\n')).toMatch(
      /Committers of Pull Request number 12/
    )
    watch.restore()
  })

  it('honors only the newest status for the context', async () => {
    setUp({ statuses: [success, { ...success, state: 'failure' }] })
    const watch = watchCore()
    await runAction()
    expect(watch.failures.join('\n')).toMatch(
      /Committers of Pull Request number 12/
    )
    watch.restore()
  })

  it('never exempts a single-parent commit', async () => {
    setUp({ parentCount: 1, statuses: [success] })
    const watch = watchCore()
    await runAction()
    expect(watch.failures.join('\n')).toMatch(
      /Committers of Pull Request number 12/
    )
    watch.restore()
  })

  it('ignores a status that exists only in another repository', async () => {
    setUp({ forkStatuses: [success] })
    const watch = watchCore()
    await runAction()
    expect(watch.failures.join('\n')).toMatch(
      /Committers of Pull Request number 12/
    )
    watch.restore()
  })

  it('reads no statuses when the feature is not configured', async () => {
    setUp({
      inputs: {
        'trusted-merge-status-context': '',
        'trusted-merge-status-creator-ids': ''
      },
      statuses: [success]
    })
    const watch = watchCore()
    await runAction()
    expect(watch.failures.join('\n')).toMatch(
      /Committers of Pull Request number 12/
    )
    expect(fake.requestLog.some(r => r.path.includes('/statuses'))).toBe(false)
    watch.restore()
  })

  it('fails closed on a partial configuration', async () => {
    setUp({
      inputs: { 'trusted-merge-status-creator-ids': '' },
      statuses: [success]
    })
    const watch = watchCore()
    await runAction()
    expect(watch.failures.join('\n')).toMatch(
      /trusted-merge-status-context and trusted-merge-status-creator-ids must be provided together/
    )
    watch.restore()
  })

  it('fails closed on malformed creator IDs', async () => {
    setUp({
      inputs: { 'trusted-merge-status-creator-ids': 'github-actions[bot]' },
      statuses: [success]
    })
    const watch = watchCore()
    await runAction()
    expect(watch.failures.join('\n')).toMatch(
      /must be comma-separated numeric GitHub account IDs/
    )
    watch.restore()
  })
})
