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
    mockedCoreGetInput.mockImplementation((name: string) =>
      name === 'lock-pullrequest-aftermerge' ? 'true' : ''
    )
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
    mockedCoreGetInput.mockImplementation(() => 'false')
    github.context.payload.action = 'reopened'
    github.context.payload.pull_request!.locked = true
    await run()
    expect(mockedCoreWarning).toHaveBeenCalledWith(
      expect.stringMatching(/preserves maintainer locks/i)
    )
    expect(mockedGetClas).toHaveBeenCalled()
  })

  test('the checkcla method should be called on a merged/closed pull request if lock-pullrequest-aftermerge is disabled', async () => {
    mockedCoreGetInput.mockImplementation(() => 'false')
    await run()
    expect(mockedLockPullRequest).not.toHaveBeenCalled()
    expect(mockedGetClas).toHaveBeenCalled()
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
