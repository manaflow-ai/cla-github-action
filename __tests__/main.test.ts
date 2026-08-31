import * as core from '@actions/core'
import * as github from '@actions/github'
import { context } from '@actions/github'
import { setupClaCheck } from '../src/setupClaCheck'
import { lockPullRequest } from '../src/pullrequest/pullRequestLock'
import { run } from '../src/main'
import { validateMergedPullRequestForLock } from '../src/livePullRequest'

jest.mock('@actions/core')
jest.mock('@actions/github')
jest.mock('../src/pullrequest/pullRequestLock')
jest.mock('../src/setupClaCheck')
jest.mock('../src/livePullRequest')
const mockedGetClas = jest.mocked(setupClaCheck)
const mockedLockPullRequest = jest.mocked(lockPullRequest)
const mockedCoreGetInput = jest.mocked(core.getInput)
const mockedCoreWarning = jest.mocked(core.warning)
const mockedValidateMergedPullRequestForLock = jest.mocked(
  validateMergedPullRequestForLock
)

describe('Pull request event', () => {
  beforeEach(async () => {
    mockedGetClas.mockReset()
    mockedLockPullRequest.mockReset()
    mockedCoreWarning.mockReset()
    mockedValidateMergedPullRequestForLock.mockReset()
    mockedValidateMergedPullRequestForLock.mockResolvedValue()
    mockedCoreGetInput.mockImplementation((name: string) => {
      if (name === 'lock-pullrequest-aftermerge') return 'true'
      if (name === 'required-base-ref') return 'main'
      if (name === 'path-to-document') return 'https://example.com/cla'
      return ''
    })
    // @ts-ignore
    github.context = {
      eventName: 'pull_request_target',
      ref: 'refs/pull/232/merge',
      workflow: 'CLA Assistant',
      action: 'ibakshaygithub-action-1',
      actor: 'ibakshay',
      payload: {
        action: 'closed',
        number: '1',
        pull_request: {
          number: 1,
          title: 'test',
          merged: true,
          locked: false,
          user: {
            login: 'ibakshay'
          }
        },
        repository: {
          name: 'auto-assign',
          owner: {
            login: 'ibakshay'
          }
        }
      },
      repo: {
        owner: 'ibakshay',
        repo: 'auto-assign'
      },
      issue: {
        owner: 'kentaro-m',
        repo: 'auto-assign',
        number: 1
      },
      sha: ''
    }
  })

  test('the lockPullRequest  method should be called if there is a pull request merge/closed', async () => {
    await run()
    expect(mockedValidateMergedPullRequestForLock).toHaveBeenCalled()
    expect(mockedLockPullRequest).toHaveBeenCalled()
  })

  test('a failed lock request is reported through the action failure channel', async () => {
    mockedLockPullRequest.mockRejectedValueOnce(
      new Error('lock request failed')
    )

    await run()

    expect(core.setFailed).toHaveBeenCalledWith('lock request failed')
  })

  test('a failed merged Pull Request validation prevents locking', async () => {
    mockedValidateMergedPullRequestForLock.mockRejectedValueOnce(
      new Error('live identity mismatch')
    )
    await run()
    expect(mockedLockPullRequest).not.toHaveBeenCalled()
    expect(core.setFailed).toHaveBeenCalledWith('live identity mismatch')
  })

  test('the checkcla  method should not called if there is a pull request merge/closed', async () => {
    await run()
    expect(mockedGetClas).not.toHaveBeenCalled()
  })

  test('the lockPullRequest method should not be called if the pull request was closed without merging', async () => {
    github.context.payload.pull_request!.merged = false
    await run()
    expect(mockedLockPullRequest).not.toHaveBeenCalled()
    expect(mockedGetClas).not.toHaveBeenCalled()
  })

  test('a reopened pull request keeps its maintainer lock', async () => {
    github.context.payload.action = 'reopened'
    github.context.payload.pull_request!.locked = true
    await run()
    expect(mockedCoreWarning).toHaveBeenCalledWith(
      expect.stringMatching(/preserves maintainer locks/i)
    )
    expect(mockedGetClas).toHaveBeenCalled()
  })

  test('an unlocked pull request can run the check after reopen', async () => {
    github.context.payload.action = 'reopened'
    await run()
    expect(mockedCoreWarning).not.toHaveBeenCalled()
    expect(mockedGetClas).toHaveBeenCalled()
  })

  test('a maintainer lock is preserved when automatic locking is disabled', async () => {
    mockedCoreGetInput.mockImplementation((name: string) => {
      if (name === 'lock-pullrequest-aftermerge') return 'false'
      if (name === 'required-base-ref') return 'main'
      if (name === 'path-to-document') return 'https://example.com/cla'
      return ''
    })
    github.context.payload.action = 'reopened'
    github.context.payload.pull_request!.locked = true
    await run()
    expect(mockedCoreWarning).toHaveBeenCalledWith(
      expect.stringMatching(/preserves maintainer locks/i)
    )
    expect(mockedGetClas).toHaveBeenCalled()
  })

  test('a closed event does no CLA work when automatic locking is disabled', async () => {
    mockedCoreGetInput.mockImplementation((name: string) => {
      if (name === 'lock-pullrequest-aftermerge') return 'false'
      if (name === 'required-base-ref') return 'main'
      if (name === 'path-to-document') return 'https://example.com/cla'
      return ''
    })
    await run()
    expect(mockedLockPullRequest).not.toHaveBeenCalled()
    expect(mockedValidateMergedPullRequestForLock).not.toHaveBeenCalled()
    expect(mockedGetClas).not.toHaveBeenCalled()
  })

  test('an issue_comment event without a pull_request payload runs the CLA check without locking or unlocking', async () => {
    github.context.eventName = 'issue_comment'
    github.context.payload.action = 'created'
    delete github.context.payload.pull_request
    await run()
    expect(mockedLockPullRequest).not.toHaveBeenCalled()
    expect(mockedGetClas).toHaveBeenCalled()
  })

  test('the lockPullRequest  method should not be called if there is a pull request opened', async () => {
    github.context.payload.action = 'opened'
    await run()

    expect(mockedLockPullRequest).not.toHaveBeenCalled()
  })

  test('the checkcla  method should  be called if there is a pull request opened', async () => {
    github.context.payload.action = 'opened'
    await run()
    expect(mockedGetClas).toHaveBeenCalled()
  })

  test('uses the secure base-branch default without a warning', async () => {
    mockedCoreGetInput.mockImplementation((name: string) => {
      if (name === 'lock-pullrequest-aftermerge') return 'true'
      if (name === 'path-to-document') return 'https://example.com/cla'
      return ''
    })
    github.context.payload.action = 'opened'
    await run()
    expect(mockedCoreWarning).not.toHaveBeenCalled()
    expect(mockedGetClas).toHaveBeenCalled()
  })

  test.each(['', 'CLA.md', 'http://example.com/cla', '//example.com/cla'])(
    'rejects an unsafe path-to-document before any GitHub write: %p',
    async documentUrl => {
      mockedCoreGetInput.mockImplementation((name: string) => {
        if (name === 'lock-pullrequest-aftermerge') return 'true'
        if (name === 'required-base-ref') return 'main'
        if (name === 'path-to-document') return documentUrl
        return ''
      })
      github.context.payload.action = 'opened'

      await run()

      expect(core.setFailed).toHaveBeenCalledWith(
        expect.stringMatching(/path-to-document.*non-empty absolute HTTPS URL/i)
      )
      expect(mockedGetClas).not.toHaveBeenCalled()
      expect(mockedValidateMergedPullRequestForLock).not.toHaveBeenCalled()
      expect(mockedLockPullRequest).not.toHaveBeenCalled()
    }
  )

  test('the lockPullRequest  method should not be called if there is a pull request sync', async () => {
    github.context.payload.action = 'synchronize'

    await run()

    expect(mockedLockPullRequest).not.toHaveBeenCalled()
  })

  test('the checkcla  method should  be called if there is a pull request sync', async () => {
    github.context.payload.action = 'synchronize'
    await run()
    expect(mockedGetClas).toHaveBeenCalled()
  })
})
