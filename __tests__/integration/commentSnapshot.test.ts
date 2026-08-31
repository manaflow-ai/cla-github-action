import * as core from '@actions/core'
import { installFakeGitHub, FakeGitHub } from '../testHelpers/fakeGithub'
import { reloadOctokit, setContext } from '../testHelpers/context'
import { resetEnv, setDefaultInputs } from '../testHelpers/env'

const SIGN_PHRASE = 'I have read the CLA Document and I hereby sign the CLA'

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

describe('signing comment snapshot validation', () => {
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

  it.each(['edited', 'deleted'] as const)(
    'does not persist a signing comment that is %s before the ledger write',
    async mutation => {
      const watch = watchCore()
      const repository = fake.repo('acme', 'widgets')
      repository.addPullRequest({
        number: 41,
        head: { sha: 'headsha', ref: 'feature/comment-race' },
        user: { login: 'alice', id: 1001 },
        commits: [{ author: { login: 'alice', id: 1001 } }]
      })
      repository.setFile('signatures/cla.json', {
        signedContributors: []
      })
      const botComment = repository.addComment(41, {
        body: '**CLA Assistant Lite bot**: notice',
        user: {
          login: 'github-actions[bot]',
          id: 41898282,
          type: 'Bot'
        }
      })
      const signingComment = repository.addComment(41, {
        body: SIGN_PHRASE,
        user: { login: 'alice', id: 1001, type: 'User' }
      })

      const secondSnapshot =
        mutation === 'edited'
          ? [
              botComment,
              { ...signingComment, body: 'I no longer sign this CLA' }
            ]
          : [botComment]
      fake.injectFailure({
        method: 'GET',
        pathPattern: /\/repos\/acme\/widgets\/issues\/41\/comments$/,
        skip: 1,
        times: 1,
        status: 200,
        body: JSON.stringify(secondSnapshot)
      })

      setContext({
        owner: 'acme',
        repo: 'widgets',
        issueNumber: 41,
        actor: 'alice',
        eventName: 'issue_comment',
        payload: {
          action: 'created',
          issue: { number: 41, state: 'open', pull_request: {} },
          comment: {
            body: SIGN_PHRASE,
            user: { login: 'alice', id: 1001, type: 'User' }
          },
          repository: { id: repository.state.id, full_name: 'acme/widgets' }
        }
      })

      await runAction()

      expect(watch.failures.join('\n')).toMatch(
        /signing comment.*changed or was deleted/i
      )
      expect(repository.getFile('signatures/cla.json')).toEqual({
        signedContributors: []
      })
      expect(watch.outputs).not.toContainEqual(['signature_recorded', true])
      const trustedBotComment = repository
        .listComments(41)
        .find(comment => comment.user.login === 'github-actions[bot]')
      expect(trustedBotComment?.body).not.toMatch(
        /all contributors have signed the cla/i
      )
      expect(trustedBotComment?.body).toContain('notice')
      watch.restore()
    }
  )
})
