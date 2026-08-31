import { context } from '@actions/github'
import { setupClaCheck } from './setupClaCheck'
import { lockPullRequest } from './pullrequest/pullRequestLock'

import * as core from '@actions/core'
import * as input from './shared/getInputs'
import { validateMergedPullRequestForLock } from './livePullRequest'

export async function run() {
  try {
    core.info(`CLA Assistant GitHub Action bot has started the process`)

    if (context.payload.action === 'closed') {
      if (
        input.lockPullRequestAfterMerge() &&
        context.payload.pull_request?.merged
      ) {
        await validateMergedPullRequestForLock()
        return lockPullRequest()
      }
      const reason = context.payload.pull_request?.merged
        ? 'automatic locking is disabled'
        : 'it was not merged'
      core.info(`Pull request ${context.issue.number} is closed and ${reason}`)
      return
    }

    if (
      context.payload.action === 'reopened' &&
      context.payload.pull_request?.locked
    ) {
      core.warning(
        `Pull request ${context.issue.number} is locked. The action preserves maintainer locks. A maintainer must unlock the conversation before contributors can sign.`
      )
    }

    await setupClaCheck()
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
}

if (process.env.NODE_ENV !== 'test') {
  run()
}
