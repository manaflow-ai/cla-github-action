import { octokit } from '../octokit'
import * as core from '@actions/core'
import { context } from '@actions/github'
import { errorMessage, withGitHubApiError } from '../shared/errors'

export async function lockPullRequest() {
  const pullRequestNo = context.issue.number
  try {
    await withGitHubApiError('issues.lock', () =>
      octokit.rest.issues.lock({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: pullRequestNo,
        lock_reason: 'resolved'
      })
    )
    core.info(
      `Locked pull request ${pullRequestNo} to safeguard CLA signatures`
    )
  } catch (e) {
    throw new Error(
      `Failed to lock pull request ${pullRequestNo}: ${errorMessage(e)}`,
      { cause: e }
    )
  }
}
