import { installFakeGitHub, FakeGitHub } from '../testHelpers/fakeGithub'
import { resetEnv, setDefaultInputs } from '../testHelpers/env'
import { reloadOctokit, setContext } from '../testHelpers/context'

const MAX_COMMENT_BODY_BYTES = 65_536
const MAX_COMMENT_BYTES = 10_000_000

async function listComments(): Promise<
  Awaited<
    ReturnType<
      typeof import('../../src/pullrequest/pullRequestComments').listBoundedPullRequestComments
    >
  >
> {
  reloadOctokit()
  for (const path of Object.keys(require.cache)) {
    if (path.includes('/src/')) delete require.cache[path]
  }
  const { listBoundedPullRequestComments } =
    require('../../src/pullrequest/pullRequestComments') as typeof import('../../src/pullrequest/pullRequestComments')
  return listBoundedPullRequestComments()
}

function writeRequests(fake: FakeGitHub) {
  return fake.requestLog.filter(request =>
    ['POST', 'PUT', 'PATCH'].includes(request.method)
  )
}

describe('bounded Pull Request comment payloads', () => {
  let fake: FakeGitHub

  beforeEach(() => {
    setDefaultInputs({
      'path-to-signatures': 'signatures/cla.json',
      branch: 'main'
    })
    fake = installFakeGitHub()
  })

  afterEach(async () => {
    await fake.close()
    resetEnv()
  })

  it('fails closed before writes when one comment body exceeds the byte limit', async () => {
    const repository = fake.repo('acme', 'widgets')
    repository.addComment(7, {
      body: 'x'.repeat(MAX_COMMENT_BODY_BYTES + 1),
      user: { login: 'alice', id: 1001, type: 'User' }
    })
    setContext({
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 7,
      payload: { repository: { id: repository.state.id } }
    })

    await expect(listComments()).rejects.toThrow(
      /comment body exceeds 65536 bytes/i
    )

    expect(writeRequests(fake)).toEqual([])
  })

  it('fails closed before writes when comment bodies exceed the aggregate byte limit', async () => {
    const repository = fake.repo('acme', 'widgets')
    const body = 'x'.repeat(65_000)
    const commentCount = Math.floor(MAX_COMMENT_BYTES / body.length) + 1
    for (let i = 0; i < commentCount; i++) {
      repository.addComment(7, {
        body,
        user: { login: `user-${i}`, id: 20_000 + i, type: 'User' }
      })
    }
    setContext({
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 7,
      payload: { repository: { id: repository.state.id } }
    })

    await expect(listComments()).rejects.toThrow(
      /combined comment bodies exceed 10000000 bytes/i
    )

    expect(writeRequests(fake)).toEqual([])
  })

  it('counts UTF-8 bytes and accepts a body exactly at the per-comment limit', async () => {
    const repository = fake.repo('acme', 'widgets')
    const body = '😀'.repeat(MAX_COMMENT_BODY_BYTES / 4)
    repository.addComment(9, {
      body,
      user: { login: 'alice', id: 1001, type: 'User' }
    })
    setContext({
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 9,
      payload: { repository: { id: repository.state.id } }
    })
    reloadOctokit()
    const { listBoundedPullRequestComments } =
      require('../../src/pullrequest/pullRequestComments') as typeof import('../../src/pullrequest/pullRequestComments')

    await expect(listBoundedPullRequestComments()).resolves.toHaveLength(1)
  })

  it('fails closed on a malformed comment body instead of coercing it', async () => {
    const repository = fake.repo('acme', 'widgets')
    const comment = repository.addComment(7, {
      body: 'ordinary comment',
      user: { login: 'alice', id: 1001, type: 'User' }
    })
    comment.body = 42 as unknown as string
    setContext({
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 7,
      payload: { repository: { id: repository.state.id } }
    })

    await expect(listComments()).rejects.toThrow(/invalid comment body/i)

    expect(writeRequests(fake)).toEqual([])
  })
})
