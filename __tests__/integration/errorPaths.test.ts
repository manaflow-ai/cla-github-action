/**
 * Failure-mode scenarios: how does the action behave when GitHub returns a
 * transient 5xx, a 403, or when createFile fails?
 */
import * as core from '@actions/core'
import { installFakeGitHub, FakeGitHub } from '../testHelpers/fakeGithub'
import { resetEnv, setDefaultInputs } from '../testHelpers/env'
import { reloadOctokit, setContext } from '../testHelpers/context'

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
  const warned = jest.spyOn(core, 'warning').mockImplementation(() => {})
  return {
    get failures() {
      return failed.mock.calls.map(c => String(c[0]))
    },
    get warnings() {
      return warned.mock.calls.map(c => String(c[0]))
    },
    restore() {
      failed.mockRestore()
      warned.mockRestore()
    }
  }
}

describe('error paths', () => {
  jest.setTimeout(30000)

  let fake: FakeGitHub

  beforeEach(() => {
    setDefaultInputs()
    fake = installFakeGitHub()
  })
  afterEach(async () => {
    await fake.close()
    resetEnv()
  })

  it('retries and recovers from a one-shot GitHub 5xx response', async () => {
    const watch = watchCore()
    fake.repo('acme', 'widgets').addPullRequest({
      number: 7,
      head: { sha: 'headsha', ref: 'feature/cla' },
      commits: [{ author: { login: 'alice', id: 1001 } }]
    })
    fake.repo('acme', 'widgets').setFile('signatures/v1/cla.json', {
      signedContributors: []
    })
    // The first GET returns the GitHub "Unicorn!" HTML 500 page.
    fake.injectFailure({
      method: 'GET',
      pathPattern: /\/repos\/acme\/widgets\/contents\/signatures/,
      status: 500,
      body: '<!DOCTYPE html><title>Unicorn!</title>',
      times: 1
    })

    setContext({
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 7,
      actor: 'alice',
      eventName: 'pull_request_target',
      payload: {
        pull_request: { number: 7, state: 'open' },
        repository: { id: fake.repo('acme', 'widgets').state.id },
        action: 'opened'
      }
    })

    await runAction()

    expect(watch.failures.join('\n')).toMatch(
      /Committers of Pull Request number 7/
    )
    expect(watch.failures.join('\n')).not.toMatch(
      /Could not retrieve repository contents|Could not update the JSON file/
    )
    expect(fake.repo('acme', 'widgets').listComments(7)).toHaveLength(1)
    watch.restore()
  })

  it('reports the failure cleanly when the contents GET returns a transient 502', async () => {
    const watch = watchCore()
    fake.repo('acme', 'widgets').addPullRequest({
      number: 7,
      head: { sha: 'headsha', ref: 'feature/cla' },
      commits: [{ author: { login: 'alice', id: 1001 } }]
    })
    fake.repo('acme', 'widgets').setFile('signatures/v1/cla.json', {
      signedContributors: []
    })
    // Inject repeated 502 responses.
    fake.injectFailure({
      method: 'GET',
      pathPattern: /\/repos\/acme\/widgets\/contents\/signatures/,
      status: 502,
      times: 1000
    })

    setContext({
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 7,
      actor: 'alice',
      eventName: 'pull_request_target',
      payload: {
        pull_request: { number: 7, state: 'open' },
        repository: { id: fake.repo('acme', 'widgets').state.id },
        action: 'opened'
      }
    })

    await runAction()

    // The action reports the failure through core.setFailed.
    expect(watch.failures.join('\n')).toMatch(
      /Could not retrieve repository contents|Could not update the JSON file/
    )
    watch.restore()
  })

  it('reports the failure cleanly when createOrUpdateFileContents returns 422 on bootstrap', async () => {
    const watch = watchCore()
    fake.repo('acme', 'widgets').addPullRequest({
      number: 7,
      head: { sha: 'headsha', ref: 'feature/cla' },
      commits: [{ author: { login: 'alice', id: 1001 } }]
    })
    // Force the bootstrap path (no existing signatures file).
    fake.injectFailure({
      method: 'PUT',
      pathPattern: /\/repos\/acme\/widgets\/contents\/signatures/,
      status: 422,
      body: JSON.stringify({ message: 'branch is protected' }),
      times: 1000
    })

    setContext({
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 7,
      actor: 'alice',
      eventName: 'pull_request_target',
      payload: {
        pull_request: { number: 7, state: 'open' },
        repository: { id: fake.repo('acme', 'widgets').state.id },
        action: 'opened'
      }
    })

    await runAction()

    // setupClaCheck's catch wraps this specifically — the user-facing message
    // tells them the signatures-file branch must not be protected.
    expect(watch.failures.join('\n')).toMatch(
      /creating the signed contributors file.*branch.*protected/i
    )
    watch.restore()
  })

  it('does not call the Actions rerun API after a comment signature', async () => {
    const watch = watchCore()
    fake.repo('acme', 'widgets').addPullRequest({
      number: 7,
      head: { sha: 'headsha', ref: 'feature/cla' },
      commits: [{ author: { login: 'alice', id: 1001 } }]
    })
    fake.repo('acme', 'widgets').setFile('signatures/v1/cla.json', {
      signedContributors: []
    })
    fake.repo('acme', 'widgets').addComment(7, {
      body: '**CLA Assistant Lite bot**: notice',
      user: { login: 'github-actions[bot]', id: 41898282, type: 'Bot' }
    })
    fake.repo('acme', 'widgets').addComment(7, {
      body: 'I have read the CLA Document and I hereby sign the CLA',
      user: { login: 'alice', id: 1001, type: 'User' }
    })
    fake
      .repo('acme', 'widgets')
      .addWorkflow('cla-check', [{ id: 777, conclusion: 'failure' }])

    // Any attempt to inspect a workflow run fails. The hardened action must
    // not touch this endpoint because reruns belong in a separate trusted job.
    fake.injectFailure({
      method: 'GET',
      pathPattern: /\/repos\/acme\/widgets\/actions\/workflows\/\d+\/runs/,
      status: 503,
      times: 1000
    })

    setContext({
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 7,
      actor: 'alice',
      eventName: 'issue_comment',
      payload: {
        action: 'created',
        issue: { number: 7, pull_request: {} },
        comment: {
          body: 'I have read the CLA Document and I hereby sign the CLA',
          user: { login: 'alice', id: 1001 }
        },
        repository: { id: fake.repo('acme', 'widgets').state.id }
      }
    })

    await runAction()

    // The signature should still have been recorded even though the rerun
    // request failed.
    const sigFile = fake
      .repo('acme', 'widgets')
      .getFile('signatures/v1/cla.json') as {
      signedContributors: Array<{ name: string }>
    }
    expect(sigFile.signedContributors.map(c => c.name)).toContain('alice')

    expect(fake.recordedRerunRequests).toEqual([])
    expect(watch.warnings.join('\n')).not.toMatch(/rerun/i)
    expect(watch.failures).toEqual([])
    watch.restore()
  })

  it('fails closed with a clear error when the signature ledger shape is invalid', async () => {
    const watch = watchCore()
    fake.repo('acme', 'widgets').addPullRequest({
      number: 22,
      head: { sha: 'headsha', ref: 'feature/invalid-ledger' },
      commits: [{ author: { login: 'alice', id: 1001 } }]
    })
    fake.repo('acme', 'widgets').setFile('signatures/v1/cla.json', {
      signedContributors: 'everyone'
    })
    setContext({
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 22,
      actor: 'alice',
      eventName: 'pull_request_target',
      payload: {
        action: 'opened',
        pull_request: {
          number: 22,
          state: 'open',
          user: { login: 'alice', id: 1001 }
        },
        repository: { id: fake.repo('acme', 'widgets').state.id }
      }
    })

    await runAction()

    expect(watch.failures.join('\n')).toMatch(/invalid cla signature ledger/i)
    expect(fake.repo('acme', 'widgets').listComments(22)).toHaveLength(0)
    watch.restore()
  })

  it('fails closed when the signature ledger has more than 10000 entries', async () => {
    const watch = watchCore()
    fake.repo('acme', 'widgets').addPullRequest({
      number: 35,
      head: { sha: 'headsha', ref: 'feature/oversized-ledger' },
      user: { login: 'alice', id: 1001 },
      commits: [{ author: { login: 'alice', id: 1001 } }]
    })
    fake.repo('acme', 'widgets').setFile('signatures/v1/cla.json', {
      signedContributors: Array.from({ length: 10_001 }, (_, index) => ({
        name: `signer-${index}`,
        id: 500_000 + index
      }))
    })
    setContext({
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 35,
      actor: 'alice',
      eventName: 'pull_request_target',
      payload: {
        action: 'opened',
        pull_request: {
          number: 35,
          state: 'open',
          user: { login: 'alice', id: 1001 }
        },
        repository: { id: fake.repo('acme', 'widgets').state.id }
      }
    })

    await runAction()

    expect(watch.failures.join('\n')).toMatch(/more than 10000 signatures/i)
    expect(fake.repo('acme', 'widgets').listComments(35)).toHaveLength(0)
    watch.restore()
  })
})
