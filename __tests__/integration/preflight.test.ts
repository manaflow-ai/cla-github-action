import * as core from '@actions/core'
import { installFakeGitHub, FakeGitHub } from '../testHelpers/fakeGithub'
import { resetEnv, setDefaultInputs } from '../testHelpers/env'
import { reloadOctokit, setContext } from '../testHelpers/context'

const SIGN_PHRASE = 'I have read the CLA Document and I hereby sign the CLA'

async function runAction(): Promise<void> {
  reloadOctokit()
  for (const path of Object.keys(require.cache)) {
    if (path.includes('/src/')) delete require.cache[path]
  }
  const { run } = require('../../src/main') as typeof import('../../src/main')
  await run()
}

function watchCore() {
  const failed = jest.spyOn(core, 'setFailed').mockImplementation(() => {})
  const output = jest.spyOn(core, 'setOutput').mockImplementation(() => {})
  return {
    get failures() {
      return failed.mock.calls.map(call => String(call[0]))
    },
    get outputs() {
      return output.mock.calls.map(call => [call[0], call[1]])
    },
    restore() {
      failed.mockRestore()
      output.mockRestore()
    }
  }
}

describe('signer-preflight mode', () => {
  let fake: FakeGitHub

  beforeEach(() => {
    setDefaultInputs({
      mode: 'signer-preflight',
      'path-to-signatures': 'signatures/cla.json',
      branch: 'cla-signatures'
    })
    fake = installFakeGitHub()
  })

  afterEach(async () => {
    await fake.close()
    resetEnv()
  })

  function addCommentEvent(options: {
    repository: ReturnType<FakeGitHub['repo']>
    pullRequestNumber: number
    login: string
    id: number
    type?: 'User' | 'Bot'
    body?: string
    includeTimestamps?: boolean
    eventLogin?: string
  }) {
    const comment = options.repository.addComment(options.pullRequestNumber, {
      body: options.body ?? SIGN_PHRASE,
      user: {
        login: options.login,
        id: options.id,
        type: options.type ?? 'User'
      }
    })
    setContext({
      owner: 'acme',
      repo: 'widgets',
      issueNumber: options.pullRequestNumber,
      actor: options.login,
      eventName: 'issue_comment',
      payload: {
        action: 'created',
        comment: {
          id: comment.id,
          body: comment.body,
          user: {
            ...comment.user,
            ...(options.eventLogin ? { login: options.eventLogin } : {})
          },
          ...(options.includeTimestamps === false
            ? {}
            : {
                created_at: comment.created_at,
                updated_at: comment.updated_at
              })
        },
        repository: {
          id: options.repository.state.id,
          full_name: 'acme/widgets'
        },
        issue: {
          number: options.pullRequestNumber,
          state: 'open',
          pull_request: {}
        }
      }
    })
    return comment
  }

  function addPullRequest(
    commits: Array<{
      author: { login: string; id: number }
      committer?: { login: string; id: number }
      coAuthors?: Array<{ login: string; id: number }>
    }>,
    user = { login: 'alice', id: 1001 }
  ) {
    return fake.repo('acme', 'widgets').addPullRequest({
      number: 7,
      head: { sha: 'headsha', ref: 'feature/preflight' },
      user,
      commits
    })
  }

  function writeRequests() {
    return fake.requestLog.filter(request => {
      if (request.method !== 'POST') return request.method !== 'GET'
      return !request.path.endsWith('/graphql')
    })
  }

  it('authorizes the authenticated primary author without any write request', async () => {
    const watch = watchCore()
    const repository = addPullRequest([
      { author: { login: 'alice', id: 1001 } }
    ])
    const comment = addCommentEvent({
      repository,
      pullRequestNumber: 7,
      login: 'alice',
      id: 1001
    })

    await runAction()

    expect(watch.outputs).toContainEqual(['signer_authorized', true])
    expect(watch.failures).toEqual([])
    expect(repository.listComments(7)).toHaveLength(1)
    expect(repository.getFile('signatures/cla.json')).toBeUndefined()
    expect(writeRequests()).toEqual([])
    expect(comment.body).toBe(SIGN_PHRASE)
    watch.restore()
  })

  it.each([
    ['co-author', [{ login: 'alice', id: 1001 }], [{ login: 'bob', id: 2002 }]],
    ['committer', [{ login: 'alice', id: 1001 }], undefined]
  ] as const)(
    'authorizes a current %s identity by numeric GitHub ID',
    async (_role, authors, coAuthors) => {
      const watch = watchCore()
      const commits = [
        {
          author: authors[0]!,
          ...(coAuthors
            ? { coAuthors }
            : {
                committer: { login: 'bob', id: 2002 }
              })
        }
      ]
      const repository = addPullRequest(commits)
      addCommentEvent({
        repository,
        pullRequestNumber: 7,
        login: 'bob',
        id: 2002
      })

      await runAction()

      expect(watch.outputs).toContainEqual(['signer_authorized', true])
      expect(watch.failures).toEqual([])
      expect(writeRequests()).toEqual([])
      watch.restore()
    }
  )

  it('authorizes the authenticated opener when they have no commit identity', async () => {
    const watch = watchCore()
    const repository = addPullRequest(
      [{ author: { login: 'bob', id: 2002 } }],
      { login: 'alice', id: 1001 }
    )
    setDefaultInputs({
      mode: 'signer-preflight',
      'require-opener-as-author': 'false'
    })
    addCommentEvent({
      repository,
      pullRequestNumber: 7,
      login: 'alice',
      id: 1001
    })

    await runAction()

    expect(watch.outputs).toContainEqual(['signer_authorized', true])
    expect(watch.outputs).toContainEqual(['opener_not_in_commits', true])
    expect(watch.failures).toEqual([])
    expect(writeRequests()).toEqual([])
    watch.restore()
  })

  it.each([
    ['Austin', 'austin', 38676809],
    ['Aziz', 'aziz', 67667005]
  ] as const)(
    'allows an authenticated %s opener exemption when their commits are authored by others',
    async (_name, login, id) => {
      const watch = watchCore()
      const repository = addPullRequest(
        [{ author: { login: 'bob', id: 2002 } }],
        { login, id }
      )
      setDefaultInputs({
        mode: 'signer-preflight',
        'allowlist-ids': String(id)
      })
      addCommentEvent({
        repository,
        pullRequestNumber: 7,
        login: 'bob',
        id: 2002
      })

      await runAction()

      expect(watch.outputs).toContainEqual(['signer_authorized', true])
      expect(watch.outputs).toContainEqual(['opener_not_in_commits', true])
      expect(watch.failures).toEqual([])
      expect(writeRequests()).toEqual([])
      watch.restore()
    }
  )

  it('rejects an opener mismatch when the live opener is not allowlisted', async () => {
    const watch = watchCore()
    const repository = addPullRequest(
      [{ author: { login: 'bob', id: 2002 } }],
      { login: 'alice', id: 1001 }
    )
    addCommentEvent({
      repository,
      pullRequestNumber: 7,
      login: 'bob',
      id: 2002
    })

    await runAction()

    expect(watch.outputs).toContainEqual(['signer_authorized', false])
    expect(watch.outputs).toContainEqual(['opener_not_in_commits', true])
    expect(watch.failures.join('\n')).toMatch(/opener @alice/i)
    expect(writeRequests()).toEqual([])
    watch.restore()
  })

  it('does not treat a forged commit identity as an opener allowlist match', async () => {
    const watch = watchCore()
    const repository = addPullRequest(
      [{ author: { login: 'bob', id: 2002 } }],
      { login: 'alice', id: 1001 }
    )
    setDefaultInputs({
      mode: 'signer-preflight',
      'allowlist-ids': '2002'
    })
    addCommentEvent({
      repository,
      pullRequestNumber: 7,
      login: 'bob',
      id: 2002
    })

    await runAction()

    expect(watch.outputs).toContainEqual(['signer_authorized', false])
    expect(watch.outputs).toContainEqual(['opener_not_in_commits', true])
    expect(watch.failures.join('\n')).toMatch(/opener @alice/i)
    expect(writeRequests()).toEqual([])
    watch.restore()
  })

  it('keeps numeric identity authorization across a username rename', async () => {
    const watch = watchCore()
    const repository = addPullRequest([
      { author: { login: 'alice-renamed', id: 1001 } }
    ])
    addCommentEvent({
      repository,
      pullRequestNumber: 7,
      login: 'alice-renamed',
      id: 1001,
      eventLogin: 'alice'
    })

    await runAction()

    expect(watch.outputs).toContainEqual(['signer_authorized', true])
    expect(watch.failures).toEqual([])
    expect(writeRequests()).toEqual([])
    watch.restore()
  })

  it('rejects an exact declaration by an unrelated authenticated commenter', async () => {
    const watch = watchCore()
    const repository = addPullRequest([
      { author: { login: 'alice', id: 1001 } }
    ])
    addCommentEvent({
      repository,
      pullRequestNumber: 7,
      login: 'mallory',
      id: 9001
    })

    await runAction()

    expect(watch.outputs).toContainEqual(['signer_authorized', false])
    expect(watch.failures.join('\n')).toMatch(
      /not authored by an authenticated identity/i
    )
    expect(repository.listComments(7)).toHaveLength(1)
    expect(repository.getFile('signatures/cla.json')).toBeUndefined()
    expect(writeRequests()).toEqual([])
    watch.restore()
  })

  it('rejects a declaration that was edited after the event was delivered', async () => {
    const watch = watchCore()
    const repository = addPullRequest([
      { author: { login: 'alice', id: 1001 } }
    ])
    const comment = addCommentEvent({
      repository,
      pullRequestNumber: 7,
      login: 'alice',
      id: 1001
    })
    comment.body = `${SIGN_PHRASE} with a qualification`
    comment.updated_at = '2099-01-01T00:00:00.000Z'

    await runAction()

    expect(watch.outputs).toContainEqual(['signer_authorized', false])
    expect(watch.failures.join('\n')).toMatch(/changed while the preflight/i)
    expect(repository.listComments(7)).toHaveLength(1)
    expect(writeRequests()).toEqual([])
    watch.restore()
  })

  it('rejects a deleted declaration instead of authorizing a stale event', async () => {
    const watch = watchCore()
    const repository = addPullRequest([
      { author: { login: 'alice', id: 1001 } }
    ])
    const comment = addCommentEvent({
      repository,
      pullRequestNumber: 7,
      login: 'alice',
      id: 1001
    })
    repository.listComments(7).splice(0, 1)

    await runAction()

    expect(watch.outputs).toContainEqual(['signer_authorized', false])
    expect(watch.failures.join('\n')).toMatch(
      /missing from the live Pull Request/i
    )
    expect(writeRequests()).toEqual([])
    expect(comment.id).toBeGreaterThan(0)
    watch.restore()
  })

  it('does not admit ordinary discussion comments', async () => {
    const watch = watchCore()
    const repository = addPullRequest([
      { author: { login: 'alice', id: 1001 } }
    ])
    addCommentEvent({
      repository,
      pullRequestNumber: 7,
      login: 'mallory',
      id: 9001,
      body: 'Thanks for reviewing this.'
    })

    await runAction()

    expect(watch.outputs).toContainEqual(['signer_authorized', false])
    expect(watch.failures).toEqual([])
    expect(writeRequests()).toEqual([])
    watch.restore()
  })
})
