import { context } from '@actions/github'
import { setupClaCheck } from './setupClaCheck'
import { lockPullRequest } from './pullrequest/pullRequestLock'

import * as core from '@actions/core'
import * as input from './shared/getInputs'
import { validateMergedPullRequestForLock } from './livePullRequest'
import { requireHttpsDocumentUrl } from './shared/documentUrl'
import { runSignerPreflight } from './signerPreflight'

export async function run() {
  try {
    core.info(`CLA Assistant GitHub Action bot has started the process`)
    core.setOutput('signature_recorded', false)
    core.setOutput('signer_authorized', false)
    core.setOutput('head_sha', '')

    requireHttpsDocumentUrl()

    const mode = input.getMode()
    if (mode === 'signer-preflight') {
      await runSignerPreflight()
      return
    }
    if (mode !== 'sign') {
      throw new Error(
        `Unsupported action mode '${mode}'. Use 'sign' or 'signer-preflight'.`
      )
    }

    if (context.payload.action === 'closed') {
      if (
        input.lockPullRequestAfterMerge() &&
        context.payload.pull_request?.merged
      ) {
        await validateMergedPullRequestForLock()
        await lockPullRequest()
        return
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
