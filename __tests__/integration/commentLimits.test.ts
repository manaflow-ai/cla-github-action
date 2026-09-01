import { installFakeGitHub, FakeGitHub } from '../testHelpers/fakeGithub'
import { resetEnv, setDefaultInputs } from '../testHelpers/env'
import { reloadOctokit, setContext } from '../testHelpers/context'

const MAX_COMMENT_BODY_BYTES = 65_536
const MAX_COMMENT_BYTES = 10_000_000
const SIGN_PHRASE = 'I have read the CLA Document and I hereby sign the CLA'

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

  it('skips an oversized irrelevant body and keeps a valid later comment', async () => {
    const repository = fake.repo('acme', 'widgets')
    repository.addComment(7, {
      body: 'x'.repeat(MAX_COMMENT_BODY_BYTES + 1),
      user: { login: 'alice', id: 1001, type: 'User' }
    })
    const validComment = repository.addComment(7, {
      body: SIGN_PHRASE,
      user: { login: 'alice', id: 1001, type: 'User' }
    })
    setContext({
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 7,
      payload: { repository: { id: repository.state.id } }
    })

    const comments = await listComments()

    expect(comments.map(comment => comment.id)).toEqual([validComment.id])
    expect(writeRequests(fake)).toEqual([])
  })

  it('skips an oversized body that only prefixes the exact signing phrase', async () => {
    const repository = fake.repo('acme', 'widgets')
    repository.addComment(7, {
      body: `${SIGN_PHRASE}${'x'.repeat(MAX_COMMENT_BODY_BYTES)}`,
      user: { login: 'alice', id: 1001, type: 'User' }
    })
    setContext({
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 7,
      payload: { repository: { id: repository.state.id } }
    })

    await expect(listComments()).resolves.toEqual([])
    expect(writeRequests(fake)).toEqual([])
  })

  it('fails closed when skipped oversized noise exceeds the aggregate limit', async () => {
    const repository = fake.repo('acme', 'widgets')
    const body = 'x'.repeat(MAX_COMMENT_BODY_BYTES + 1)
    for (let i = 0; i < 154; i++) {
      repository.addComment(7, {
        body,
        user: { login: `noise-${i}`, id: 30_000 + i, type: 'User' }
      })
    }
    setContext({
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 7,
      payload: { repository: { id: repository.state.id } }
    })

    await expect(listComments()).rejects.toThrow(
      /combined .*comment bodies exceed 10000000 bytes/i
    )
    expect(writeRequests(fake)).toEqual([])
  })

  it('fails closed before writes when retained comment bodies exceed the aggregate byte limit', async () => {
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
      /combined .*comment bodies exceed 10000000 bytes/i
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

    await expect(listComments()).resolves.toHaveLength(1)
  })

  it.each([42, null, undefined])(
    'fails closed on a malformed comment body (%s) instead of coercing it',
    async malformedBody => {
      const repository = fake.repo('acme', 'widgets')
      const comment = repository.addComment(7, {
        body: 'ordinary comment',
        user: { login: 'alice', id: 1001, type: 'User' }
      })
      comment.body = malformedBody as unknown as string
      setContext({
        owner: 'acme',
        repo: 'widgets',
        issueNumber: 7,
        payload: { repository: { id: repository.state.id } }
      })

      await expect(listComments()).rejects.toThrow(/invalid .*comment body/i)

      expect(writeRequests(fake)).toEqual([])
    }
  )
})
