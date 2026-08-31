import { context } from '@actions/github'
import { octokit } from '../octokit'
import { MAX_PULL_REQUEST_COMMENTS } from '../shared/limits'

type PullRequestComment = Awaited<
  ReturnType<typeof octokit.rest.issues.listComments>
>['data'][number]

export class PullRequestCommentLimitError extends Error {}

/**
 * List every Pull Request comment while bounding work on contributor-controlled
 * input. The extra page that crosses the limit is read only to prove that the
 * limit was exceeded, then the action fails closed.
 */
export async function listBoundedPullRequestComments(): Promise<
  PullRequestComment[]
> {
  let observed = 0
  return octokit.paginate(
    octokit.rest.issues.listComments,
    {
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: context.issue.number,
      per_page: 100
    },
    response => {
      const page = response.data
      observed += page.length
      if (observed > MAX_PULL_REQUEST_COMMENTS) {
        throw new PullRequestCommentLimitError(
          `A Pull Request has more than ${MAX_PULL_REQUEST_COMMENTS} Pull Request comments. The action will fail closed.`
        )
      }
      return page
    }
  )
}
