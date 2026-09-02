import { context } from '@actions/github'
import { setupClaCheck } from './setupClaCheck'
import { lockPullRequest } from './pullrequest/pullRequestLock'

import * as core from '@actions/core'
import * as input from './shared/getInputs'
import { validateMergedPullRequestForLock } from './livePullRequest'
import { requireHttpsDocumentUrl } from './shared/documentUrl'
import { runSignerPreflight, setSignerDecision } from './signerPreflight'
import { apiResultForError, errorMessage } from './shared/errors'
import { setApiResult } from './shared/apiResult'

export async function run() {
  try {
    core.info(`CLA Assistant GitHub Action bot has started the process`)
    core.setOutput('signature_recorded', false)
    core.setOutput('cla_passed', false)
    setApiResult('error')
    core.setOutput('signer_authorized', false)
    setSignerDecision('error')
    core.setOutput('head_sha', '')
    core.setOutput('base_sha', '')
    core.setOutput('comment_id', '')
    core.setOutput('comment_created_at', '')
    core.setOutput('comment_author_id', '')

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
        setApiResult('success')
        return
      }
      const reason = context.payload.pull_request?.merged
        ? 'automatic locking is disabled'
        : 'it was not merged'
      core.info(`Pull request ${context.issue.number} is closed and ${reason}`)
      setApiResult('success')
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
    setApiResult(apiResultForError(error))
    core.setFailed(errorMessage(error))
  }
}

if (process.env.NODE_ENV !== 'test') {
  run()
}
