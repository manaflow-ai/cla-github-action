import * as core from '@actions/core'
import { installFakeGitHub, FakeGitHub } from '../testHelpers/fakeGithub'
import { resetEnv, setDefaultInputs, setInput } from '../testHelpers/env'
import { reloadOctokit, setContext } from '../testHelpers/context'

async function runAction() {
  reloadOctokit()
  for (const path of Object.keys(require.cache)) {
    if (path.includes('/src/')) delete require.cache[path]
  }
  const { run } = require('../../src/main') as typeof import('../../src/main')
  await run()
}

/** Install spies on core.setFailed / core.info. Returns accessors. */
function watchCore() {
  const failed = jest.spyOn(core, 'setFailed').mockImplementation(() => {})
  const info = jest.spyOn(core, 'info').mockImplementation(() => {})
  return {
    get failures() {
      return failed.mock.calls.map(c => String(c[0]))
    },
    get infos() {
      return info.mock.calls.map(c => String(c[0]))
    },
    restore() {
      failed.mockRestore()
      info.mockRestore()
    }
  }
}

describe('CLA action end-to-end scenarios', () => {
  let fake: FakeGitHub
  beforeEach(() => {
    setDefaultInputs({
      'path-to-signatures': 'signatures/cla.json',
      branch: 'main',
      allowlist: '',
      'allowlist-ids': ''
    })
    fake = installFakeGitHub()
  })
  afterEach(async () => {
    await fake.close()
    resetEnv()
  })

  it('PR opened by an unsigned contributor: posts notice, fails check', async () => {
    const watch = watchCore()
    fake.repo('acme', 'widgets').addPullRequest({
      number: 7,
      head: { sha: 'headsha', ref: 'feature/cla' },
      commits: [{ author: { login: 'alice', id: 1001 } }]
    })
    fake
      .repo('acme', 'widgets')
      .setFile('signatures/cla.json', { signedContributors: [] })

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

    const comments = fake.repo('acme', 'widgets').listComments(7)
    expect(comments).toHaveLength(1)
    expect(comments[0]!.body).toMatch(/CLA Assistant Lite bot/)

    expect(watch.failures.join('\n')).toMatch(
      /Committers of Pull Request number 7/
    )
    watch.restore()
  })

  it('Contributor posts the sign phrase: signatures file updated, bot comment marks all signed', async () => {
    fake.repo('acme', 'widgets').addPullRequest({
      number: 7,
      head: { sha: 'headsha', ref: 'feature/cla' },
      commits: [{ author: { login: 'alice', id: 1001 } }]
    })
    fake
      .repo('acme', 'widgets')
      .setFile('signatures/cla.json', { signedContributors: [] })
    // Existing bot comment + the user's signing comment.
    fake.repo('acme', 'widgets').addComment(7, {
      body: 'something **CLA Assistant Lite bot** says',
      user: { login: 'github-actions[bot]', id: 41898282, type: 'Bot' }
    })
    fake.repo('acme', 'widgets').addComment(7, {
      body: 'I have read the CLA Document and I hereby sign the CLA',
      user: { login: 'alice', id: 1001 }
    })
    fake.repo('acme', 'widgets').addWorkflow('cla-check', [
      {
        id: 777,
        conclusion: 'failure',
        head_sha: 'headsha',
        event: 'pull_request_target',
        pull_requests: [{ number: 7 }]
      }
    ])

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

    const sigFile = fake
      .repo('acme', 'widgets')
      .getFile('signatures/cla.json') as any
    expect(sigFile.signedContributors.map((c: any) => c.name)).toContain(
      'alice'
    )

    const bot = fake
      .repo('acme', 'widgets')
      .listComments(7)
      .find(c => c.user.login === 'github-actions[bot]')!
    expect(bot.body).toMatch(/all contributors have signed the cla/i)

    expect(fake.recordedRerunRequests).toEqual([])
  })

  it('Already-signed contributor opens a PR with no prior bot comment: posts an all-signed comment, file untouched', async () => {
    const watch = watchCore()
    fake.repo('acme', 'widgets').addPullRequest({
      number: 8,
      head: { sha: 'headsha', ref: 'feature/again' },
      commits: [{ author: { login: 'alice', id: 1001 } }]
    })
    fake.repo('acme', 'widgets').setFile('signatures/cla.json', {
      signedContributors: [
        {
          name: 'alice',
          id: 1001,
          comment_id: 99,
          created_at: '2024-01-01',
          repoId: 1,
          pullRequestNo: 3
        }
      ]
    })

    setContext({
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 8,
      actor: 'alice',
      eventName: 'pull_request_target',
      payload: {
        pull_request: { number: 8, state: 'open' },
        repository: { id: fake.repo('acme', 'widgets').state.id },
        action: 'opened'
      }
    })

    await runAction()

    // File untouched.
    const sigFile = fake
      .repo('acme', 'widgets')
      .getFile('signatures/cla.json') as any
    expect(sigFile.signedContributors).toHaveLength(1)
    // All-signed bot comment posted.
    const comments = fake.repo('acme', 'widgets').listComments(8)
    expect(
      comments.some(c => /all contributors have signed the cla/i.test(c.body))
    ).toBe(true)
    expect(watch.failures).toEqual([])
    watch.restore()
  })

  it('Dependabot PR: numeric-ID allow-listed, skipped entirely, check passes', async () => {
    setInput('allowlist-ids', '49699333')
    fake.repo('acme', 'widgets').addPullRequest({
      number: 9,
      head: { sha: 'headsha', ref: 'deps/bump' },
      commits: [{ author: { login: 'dependabot[bot]', id: 49699333 } }]
    })
    fake
      .repo('acme', 'widgets')
      .setFile('signatures/cla.json', { signedContributors: [] })

    setContext({
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 9,
      actor: 'dependabot[bot]',
      eventName: 'pull_request_target',
      payload: {
        pull_request: { number: 9, state: 'open' },
        repository: { id: fake.repo('acme', 'widgets').state.id },
        action: 'opened'
      }
    })

    await runAction()

    // No signatures recorded (allowlist short-circuits).
    const sigFile = fake
      .repo('acme', 'widgets')
      .getFile('signatures/cla.json') as any
    expect(sigFile.signedContributors).toEqual([])
  })

  it('Merged PR: lock endpoint is called when lock-pullrequest-aftermerge is true', async () => {
    setInput('lock-pullrequest-aftermerge', 'true')

    setContext({
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 10,
      eventName: 'pull_request',
      payload: { action: 'closed', pull_request: { number: 10, merged: true } }
    })

    await runAction()

    expect(fake.recordedLocks).toEqual([
      { owner: 'acme', repo: 'widgets', issue: 10 }
    ])
  })

  it('Remote signatures repo: reads and writes hit the configured remote org/repo', async () => {
    setInput('remote-organization-name', 'other-org')
    setInput('remote-repository-name', 'sig-store')

    fake.repo('acme', 'widgets').addPullRequest({
      number: 11,
      head: { sha: 'headsha', ref: 'feat/x' },
      commits: [{ author: { login: 'alice', id: 1001 } }]
    })
    fake
      .repo('other-org', 'sig-store')
      .setFile('signatures/cla.json', { signedContributors: [] })

    setContext({
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 11,
      actor: 'alice',
      eventName: 'pull_request_target',
      payload: {
        pull_request: { number: 11, state: 'open' },
        repository: { id: fake.repo('acme', 'widgets').state.id },
        action: 'opened'
      }
    })

    const watch = watchCore()
    await runAction()

    expect(watch.failures.join('\n')).toMatch(
      /Committers of Pull Request number 11/
    )
    // No file in the main repo (persistence went to the remote repo only).
    expect(
      fake.repo('acme', 'widgets').getFile('signatures/cla.json')
    ).toBeUndefined()
    // Remote file is still empty (unsigned contributor didn't sign).
    expect(
      (
        fake
          .repo('other-org', 'sig-store')
          .getFile('signatures/cla.json') as any
      ).signedContributors
    ).toEqual([])
    watch.restore()
  })

  it('PR with a commit authored by an email not linked to any GitHub user: posts the unlinked-email warning', async () => {
    const watch = watchCore()
    fake.repo('acme', 'widgets').addPullRequest({
      number: 12,
      head: { sha: 'headsha', ref: 'feature/email' },
      user: { login: 'mystery', id: 1001 },
      // No `login` / `id` — this maps to an unknown committer in the action.
      commits: [
        { author: { name: 'Mystery Contributor', email: 'typo@example.com' } }
      ]
    })
    fake
      .repo('acme', 'widgets')
      .setFile('signatures/cla.json', { signedContributors: [] })

    setContext({
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 12,
      actor: 'mystery',
      eventName: 'pull_request_target',
      payload: {
        pull_request: { number: 12, state: 'open' },
        repository: { id: fake.repo('acme', 'widgets').state.id },
        action: 'opened'
      }
    })

    await runAction()

    const comments = fake.repo('acme', 'widgets').listComments(12)
    expect(comments).toHaveLength(1)
    const body = comments[0]!.body
    // The warning block, the email, and both remediation paths.
    expect(body).toContain('[!WARNING]')
    expect(body).toContain('typo@example.com')
    expect(body).toContain('github.com/settings/emails')
    expect(body).toContain('Rewrite the commits')
    // Still marked failed — the action cannot tell whether this committer
    // has signed.
    expect(watch.failures.join('\n')).toMatch(
      /Committers of Pull Request number 12/
    )
    watch.restore()
  })

  it('PR opener who did not author any commit is required to sign', async () => {
    const watch = watchCore()
    // Commits authored by bob only; alice is the PR opener.
    fake.repo('acme', 'widgets').addPullRequest({
      number: 13,
      head: { sha: 'headsha', ref: 'feature/opener' },
      user: { login: 'alice', id: 1001 },
      commits: [{ author: { login: 'bob', id: 2002 } }]
    })
    // Bob has already signed; alice has not.
    fake.repo('acme', 'widgets').setFile('signatures/cla.json', {
      signedContributors: [{ name: 'bob', id: 2002 }]
    })

    setContext({
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 13,
      actor: 'alice',
      eventName: 'pull_request_target',
      payload: {
        action: 'opened',
        pull_request: {
          number: 13,
          state: 'open',
          user: { login: 'alice', id: 1001 }
        },
        repository: { id: fake.repo('acme', 'widgets').state.id }
      }
    })

    await runAction()

    const comments = fake.repo('acme', 'widgets').listComments(13)
    expect(comments).toHaveLength(1)
    expect(comments[0]!.body).toContain(':x: @alice')
    expect(watch.failures.join('\n')).toMatch(
      /Committers of Pull Request number 13/
    )
    watch.restore()
  })

  it('Co-authored-by trailers count as committers', async () => {
    const watch = watchCore()
    // Commit authored by alice, co-authored by bob (via noreply id form).
    fake.repo('acme', 'widgets').addPullRequest({
      number: 14,
      head: { sha: 'headsha', ref: 'feature/coauthor' },
      commits: [
        {
          author: { login: 'alice', id: 1001 },
          coAuthors: [{ login: 'bob', name: 'Bob', id: 2002 }],
          message:
            'Implement thing\n\nBody of commit.\n\nCo-authored-by: Bob <2002+bob@users.noreply.github.com>'
        }
      ]
    })
    // Alice has signed; bob has not.
    fake.repo('acme', 'widgets').setFile('signatures/cla.json', {
      signedContributors: [{ name: 'alice', id: 1001 }]
    })

    setContext({
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 14,
      actor: 'alice',
      eventName: 'pull_request_target',
      payload: {
        action: 'opened',
        pull_request: {
          number: 14,
          state: 'open',
          user: { login: 'alice', id: 1001 }
        },
        repository: { id: fake.repo('acme', 'widgets').state.id }
      }
    })

    await runAction()

    const comments = fake.repo('acme', 'widgets').listComments(14)
    expect(comments).toHaveLength(1)
    const body = comments[0]!.body
    // Alice shows as signed, bob as unsigned.
    expect(body).toContain(
      ':white_check_mark: [alice](https://github.com/alice)'
    )
    expect(body).toContain(':x: @bob')
    expect(watch.failures.join('\n')).toMatch(
      /Committers of Pull Request number 14/
    )
    watch.restore()
  })

  it('does not accept a prior signature for an asserted co-author without a current sign comment', async () => {
    const watch = watchCore()
    fake.repo('acme', 'widgets').addPullRequest({
      number: 15,
      head: { sha: 'headsha', ref: 'feature/forged-coauthor' },
      commits: [
        {
          author: { login: 'alice', id: 1001 },
          coAuthors: [{ login: 'bob', name: 'Bob', id: 2002 }],
          message:
            'Implement thing\n\nCo-authored-by: Bob <2002+bob@users.noreply.github.com>'
        }
      ]
    })
    // Both identities have prior signatures. The co-author trailer is still
    // only a claim, so Bob must sign this PR explicitly.
    fake.repo('acme', 'widgets').setFile('signatures/cla.json', {
      signedContributors: [
        { name: 'alice', id: 1001 },
        { name: 'bob', id: 2002 }
      ]
    })

    setContext({
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 15,
      actor: 'alice',
      eventName: 'pull_request_target',
      payload: {
        action: 'opened',
        pull_request: {
          number: 15,
          state: 'open',
          user: { login: 'alice', id: 1001 }
        },
        repository: { id: fake.repo('acme', 'widgets').state.id }
      }
    })

    await runAction()

    expect(watch.failures.join('\n')).toMatch(
      /Committers of Pull Request number 15/
    )
    const body = fake.repo('acme', 'widgets').listComments(15)[0]!.body
    expect(body).toContain(':x: @bob')
    watch.restore()
  })

  it('Co-authored-by trailer with a non-noreply email routes to the unlinked-email warning', async () => {
    const watch = watchCore()
    fake.repo('acme', 'widgets').addPullRequest({
      number: 15,
      head: { sha: 'headsha', ref: 'feature/coauthor-email' },
      commits: [
        {
          author: { login: 'alice', id: 1001 },
          coAuthors: [{ name: 'Carol', email: 'carol@example.com' }],
          message: 'Fix\n\nCo-authored-by: Carol <carol@example.com>'
        }
      ]
    })
    fake.repo('acme', 'widgets').setFile('signatures/cla.json', {
      signedContributors: [{ name: 'alice', id: 1001 }]
    })

    setContext({
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 15,
      actor: 'alice',
      eventName: 'pull_request_target',
      payload: {
        action: 'opened',
        pull_request: {
          number: 15,
          state: 'open',
          user: { login: 'alice', id: 1001 }
        },
        repository: { id: fake.repo('acme', 'widgets').state.id }
      }
    })

    await runAction()

    const body = fake.repo('acme', 'widgets').listComments(15)[0]!.body
    expect(body).toContain('[!WARNING]')
    expect(body).toContain('carol@example.com')
    watch.restore()
  })

  it('PR opener absent from all commit authors: hard-fails by default with an impersonation-guard CAUTION', async () => {
    const watch = watchCore()
    // Alice opens the PR; all commits are attributed to bob.
    fake.repo('acme', 'widgets').addPullRequest({
      number: 16,
      head: { sha: 'headsha', ref: 'feature/cherry' },
      user: { login: 'alice', id: 1001 },
      commits: [{ author: { login: 'bob', id: 2002 } }]
    })
    // Both alice and bob have already signed — so the only failure path open
    // is the opener-not-in-authors check itself.
    fake.repo('acme', 'widgets').setFile('signatures/cla.json', {
      signedContributors: [
        { name: 'alice', id: 1001 },
        { name: 'bob', id: 2002 }
      ]
    })

    setContext({
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 16,
      actor: 'alice',
      eventName: 'pull_request_target',
      payload: {
        action: 'opened',
        pull_request: {
          number: 16,
          state: 'open',
          user: { login: 'alice', id: 1001 }
        },
        repository: { id: fake.repo('acme', 'widgets').state.id }
      }
    })

    await runAction()

    expect(watch.failures.join('\n')).toMatch(
      /Pull Request opener @alice is not recorded/
    )
    const body = fake.repo('acme', 'widgets').listComments(16)[0]!.body
    expect(body).toContain('[!CAUTION]')
    expect(body).toContain('@alice')
    expect(body).toContain('@bob')
    watch.restore()
  })

  it('PR opener absent from all commit authors with require-opener-as-author=false: no hard fail, NOTE block only', async () => {
    const watch = watchCore()
    setInput('require-opener-as-author', 'false')

    fake.repo('acme', 'widgets').addPullRequest({
      number: 17,
      head: { sha: 'headsha', ref: 'feature/cherry' },
      user: { login: 'alice', id: 1001 },
      commits: [{ author: { login: 'bob', id: 2002 } }]
    })
    fake.repo('acme', 'widgets').setFile('signatures/cla.json', {
      signedContributors: [
        { name: 'alice', id: 1001 },
        { name: 'bob', id: 2002 }
      ]
    })

    setContext({
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 17,
      actor: 'alice',
      eventName: 'pull_request_target',
      payload: {
        action: 'opened',
        pull_request: {
          number: 17,
          state: 'open',
          user: { login: 'alice', id: 1001 }
        },
        repository: { id: fake.repo('acme', 'widgets').state.id }
      }
    })

    await runAction()

    expect(watch.failures).toEqual([])
    const body = fake.repo('acme', 'widgets').listComments(17)[0]!.body
    expect(body).toContain('[!NOTE]')
    expect(body).not.toContain('[!CAUTION]')
    watch.restore()
  })

  it('requires both the commit author and a different committer to sign', async () => {
    const watch = watchCore()
    fake.repo('acme', 'widgets').addPullRequest({
      number: 18,
      head: { sha: 'headsha', ref: 'feature/separate-committer' },
      commits: [
        {
          author: { login: 'alice', id: 1001 },
          committer: { login: 'bob', id: 2002 }
        }
      ]
    })
    fake.repo('acme', 'widgets').setFile('signatures/cla.json', {
      signedContributors: [{ name: 'alice', id: 1001 }]
    })
    setContext({
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 18,
      actor: 'alice',
      eventName: 'pull_request_target',
      payload: {
        action: 'opened',
        pull_request: {
          number: 18,
          state: 'open',
          user: { login: 'alice', id: 1001 }
        },
        repository: { id: fake.repo('acme', 'widgets').state.id }
      }
    })

    await runAction()

    const body = fake.repo('acme', 'widgets').listComments(18)[0]!.body
    expect(body).toContain(':x: @bob')
    expect(watch.failures.join('\n')).toMatch(
      /Committers of Pull Request number 18/
    )
    watch.restore()
  })

  it('does not exempt forged GitHub infrastructure committer metadata', async () => {
    const watch = watchCore()
    fake.repo('acme', 'widgets').addPullRequest({
      number: 21,
      head: { sha: 'headsha', ref: 'feature/web-edit' },
      commits: [
        {
          author: { login: 'alice', id: 1001 },
          committer: { name: 'GitHub', email: 'noreply@github.com' }
        }
      ]
    })
    fake.repo('acme', 'widgets').setFile('signatures/cla.json', {
      signedContributors: [{ name: 'alice', id: 1001 }]
    })
    setContext({
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 21,
      actor: 'alice',
      eventName: 'pull_request_target',
      payload: {
        action: 'opened',
        pull_request: {
          number: 21,
          state: 'open',
          user: { login: 'alice', id: 1001 }
        },
        repository: { id: fake.repo('acme', 'widgets').state.id }
      }
    })

    await runAction()

    const body = fake.repo('acme', 'widgets').listComments(21)[0]!.body
    expect(body).toContain('[!WARNING]')
    expect(body).toContain('noreply@github.com')
    expect(watch.failures.join('\n')).toMatch(
      /Committers of Pull Request number 21/
    )
    watch.restore()
  })

  it('does not let a committer-only identity satisfy the opener authorship guard', async () => {
    const watch = watchCore()
    fake.repo('acme', 'widgets').addPullRequest({
      number: 22,
      head: { sha: 'headsha', ref: 'feature/forged-committer' },
      user: { login: 'alice', id: 1001 },
      commits: [
        {
          author: { login: 'bob', id: 2002 },
          committer: { login: 'alice', id: 1001 }
        }
      ]
    })
    fake.repo('acme', 'widgets').setFile('signatures/cla.json', {
      signedContributors: [
        { name: 'alice', id: 1001 },
        { name: 'bob', id: 2002 }
      ]
    })
    fake.repo('acme', 'widgets').addComment(22, {
      body: '**CLA Assistant Lite bot**: notice',
      user: { login: 'github-actions[bot]', id: 41898282, type: 'Bot' }
    })
    fake.repo('acme', 'widgets').addComment(22, {
      body: 'I have read the CLA Document and I hereby sign the CLA',
      user: { login: 'alice', id: 1001, type: 'User' }
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

    expect(watch.failures.join('\n')).toMatch(
      /Pull Request opener @alice is not recorded as an author or co-author/
    )
    const body = fake.repo('acme', 'widgets').listComments(22)[0]!.body
    expect(body).toContain('[!CAUTION]')
    watch.restore()
  })

  it('does not reuse a prior signature for a committer-only identity', async () => {
    const watch = watchCore()
    fake.repo('acme', 'widgets').addPullRequest({
      number: 25,
      head: { sha: 'headsha', ref: 'feature/committer-signature' },
      user: { login: 'alice', id: 1001 },
      commits: [
        {
          author: { login: 'alice', id: 1001 },
          committer: { login: 'bob', id: 2002 }
        }
      ]
    })
    fake.repo('acme', 'widgets').setFile('signatures/cla.json', {
      signedContributors: [
        { name: 'alice', id: 1001 },
        { name: 'bob', id: 2002 }
      ]
    })
    setContext({
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 25,
      actor: 'alice',
      eventName: 'pull_request_target',
      payload: {
        action: 'opened',
        pull_request: {
          number: 25,
          state: 'open',
          user: { login: 'alice', id: 1001 }
        },
        repository: { id: fake.repo('acme', 'widgets').state.id }
      }
    })

    await runAction()

    expect(watch.failures.join('\n')).toMatch(
      /Committers of Pull Request number 25/
    )
    const body = fake.repo('acme', 'widgets').listComments(25)[0]!.body
    expect(body).toContain(':x: @bob')
    watch.restore()
  })

  it('allows a maintainer cherry-pick only with the opener guard opt-out and a current committer signature', async () => {
    const watch = watchCore()
    setInput('require-opener-as-author', 'false')
    fake.repo('acme', 'widgets').addPullRequest({
      number: 26,
      head: { sha: 'headsha', ref: 'maintainer/cherry-pick' },
      user: { login: 'alice', id: 1001 },
      commits: [
        {
          author: { login: 'bob', id: 2002 },
          committer: { login: 'alice', id: 1001 }
        }
      ]
    })
    fake.repo('acme', 'widgets').setFile('signatures/cla.json', {
      signedContributors: [
        { name: 'alice', id: 1001 },
        { name: 'bob', id: 2002 }
      ]
    })
    fake.repo('acme', 'widgets').addComment(26, {
      body: '**CLA Assistant Lite bot**: notice',
      user: { login: 'github-actions[bot]', id: 41898282, type: 'Bot' }
    })
    fake.repo('acme', 'widgets').addComment(26, {
      body: 'I have read the CLA Document and I hereby sign the CLA',
      user: { login: 'alice', id: 1001, type: 'User' }
    })
    setContext({
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 26,
      actor: 'alice',
      eventName: 'pull_request_target',
      payload: {
        action: 'opened',
        pull_request: {
          number: 26,
          state: 'open',
          user: { login: 'alice', id: 1001 }
        },
        repository: { id: fake.repo('acme', 'widgets').state.id }
      }
    })

    await runAction()

    expect(watch.failures).toEqual([])
    expect(fake.repo('acme', 'widgets').listComments(26)[0]!.body).toMatch(
      /all contributors have signed the cla/i
    )
    watch.restore()
  })

  it('does not silently remove a GitHub Actions bot commit identity', async () => {
    const watch = watchCore()
    setInput('require-opener-as-author', 'false')
    fake.repo('acme', 'widgets').addPullRequest({
      number: 19,
      head: { sha: 'headsha', ref: 'automation/generated' },
      user: { login: 'alice', id: 1001 },
      commits: [
        {
          author: { login: 'github-actions[bot]', id: 41898282 },
          committer: { login: 'alice', id: 1001 }
        }
      ]
    })
    fake.repo('acme', 'widgets').setFile('signatures/cla.json', {
      signedContributors: [{ name: 'alice', id: 1001 }]
    })
    setContext({
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 19,
      actor: 'alice',
      eventName: 'pull_request_target',
      payload: {
        action: 'opened',
        pull_request: {
          number: 19,
          state: 'open',
          user: { login: 'alice', id: 1001 }
        },
        repository: { id: fake.repo('acme', 'widgets').state.id }
      }
    })

    await runAction()

    const body = fake.repo('acme', 'widgets').listComments(19)[0]!.body
    expect(body).toContain(':x: @github-actions[bot]')
    expect(watch.failures.join('\n')).toMatch(
      /Committers of Pull Request number 19/
    )
    watch.restore()
  })

  it('fails closed when GitHub reports more than 100 authors on one commit', async () => {
    const watch = watchCore()
    fake.repo('acme', 'widgets').addPullRequest({
      number: 20,
      head: { sha: 'headsha', ref: 'feature/too-many-authors' },
      commits: [
        {
          author: { login: 'alice', id: 1001 },
          authorsHasNextPage: true
        }
      ]
    })
    fake.repo('acme', 'widgets').setFile('signatures/cla.json', {
      signedContributors: [{ name: 'alice', id: 1001 }]
    })
    setContext({
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 20,
      actor: 'alice',
      eventName: 'pull_request_target',
      payload: {
        action: 'opened',
        pull_request: {
          number: 20,
          state: 'open',
          user: { login: 'alice', id: 1001 }
        },
        repository: { id: fake.repo('acme', 'widgets').state.id }
      }
    })

    await runAction()

    expect(watch.failures.join('\n')).toMatch(/more than 100 authors/i)
    expect(fake.repo('acme', 'widgets').listComments(20)).toHaveLength(0)
    watch.restore()
  })

  it('does not write a signature after the live PR is retargeted away from main', async () => {
    const watch = watchCore()
    fake.repo('acme', 'widgets').addPullRequest({
      number: 23,
      head: { sha: 'headsha', ref: 'feature/retargeted' },
      base: { ref: 'release', repoFullName: 'acme/widgets' },
      commits: [{ author: { login: 'alice', id: 1001 } }]
    })
    fake
      .repo('acme', 'widgets')
      .setFile('signatures/cla.json', { signedContributors: [] })
    fake.repo('acme', 'widgets').addComment(23, {
      body: '**CLA Assistant Lite bot**: notice',
      user: { login: 'github-actions[bot]', id: 41898282, type: 'Bot' }
    })
    fake.repo('acme', 'widgets').addComment(23, {
      body: 'I have read the CLA Document and I hereby sign the CLA',
      user: { login: 'alice', id: 1001, type: 'User' }
    })
    setContext({
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 23,
      actor: 'alice',
      eventName: 'issue_comment',
      payload: {
        action: 'created',
        issue: {
          number: 23,
          state: 'open',
          pull_request: {}
        },
        comment: {
          body: 'I have read the CLA Document and I hereby sign the CLA',
          user: { login: 'alice', id: 1001, type: 'User' }
        },
        repository: {
          id: fake.repo('acme', 'widgets').state.id,
          full_name: 'acme/widgets'
        }
      }
    })

    await runAction()

    expect(watch.failures.join('\n')).toMatch(/base branch.*main/i)
    const ledger = fake
      .repo('acme', 'widgets')
      .getFile('signatures/cla.json') as any
    expect(ledger.signedContributors).toEqual([])
    watch.restore()
  })

  it('accepts an edited event for an open Pull Request that still targets main', async () => {
    const watch = watchCore()
    fake.repo('acme', 'widgets').addPullRequest({
      number: 24,
      head: { sha: 'headsha', ref: 'feature/edited' },
      user: { login: 'alice', id: 1001 },
      commits: [{ author: { login: 'alice', id: 1001 } }]
    })
    fake.repo('acme', 'widgets').setFile('signatures/cla.json', {
      signedContributors: [{ name: 'alice', id: 1001 }]
    })
    setContext({
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 24,
      actor: 'alice',
      eventName: 'pull_request_target',
      payload: {
        action: 'edited',
        pull_request: {
          number: 24,
          state: 'open',
          user: { login: 'alice', id: 1001 }
        },
        repository: { id: fake.repo('acme', 'widgets').state.id }
      }
    })

    await runAction()

    expect(watch.failures).toEqual([])
    expect(fake.repo('acme', 'widgets').listComments(24)[0]!.body).toMatch(
      /all contributors have signed the cla/i
    )
    watch.restore()
  })

  it('revalidates the live Pull Request immediately before a success result', async () => {
    const watch = watchCore()
    fake.repo('acme', 'widgets').addPullRequest({
      number: 27,
      head: { sha: 'headsha', ref: 'feature/retarget-during-check' },
      user: { login: 'alice', id: 1001 },
      commits: [{ author: { login: 'alice', id: 1001 } }]
    })
    fake.repo('acme', 'widgets').setFile('signatures/cla.json', {
      signedContributors: [{ name: 'alice', id: 1001 }]
    })
    fake.injectFailure({
      method: 'GET',
      pathPattern: /\/repos\/acme\/widgets\/pulls\/27$/,
      skip: 1,
      times: 1,
      status: 200,
      body: JSON.stringify({
        number: 27,
        state: 'open',
        head: { sha: 'headsha', ref: 'feature/retarget-during-check' },
        base: { ref: 'release', repo: { full_name: 'acme/widgets' } },
        user: { login: 'alice', id: 1001 }
      })
    })
    setContext({
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 27,
      actor: 'alice',
      eventName: 'pull_request_target',
      payload: {
        action: 'opened',
        pull_request: {
          number: 27,
          state: 'open',
          user: { login: 'alice', id: 1001 }
        },
        repository: { id: fake.repo('acme', 'widgets').state.id }
      }
    })

    await runAction()

    expect(watch.failures.join('\n')).toMatch(/base branch.*main/i)
    watch.restore()
  })
})
