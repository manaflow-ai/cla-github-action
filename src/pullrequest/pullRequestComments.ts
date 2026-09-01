import { context } from '@actions/github'
import { octokit } from '../octokit'
import {
  MAX_PULL_REQUEST_COMMENT_BODY_BYTES,
  MAX_PULL_REQUEST_COMMENT_BYTES,
  MAX_PULL_REQUEST_COMMENTS
} from '../shared/limits'

export type PullRequestComment = Awaited<
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
  let observedBodyBytes = 0
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
      if (!Array.isArray(page)) {
        throw new PullRequestCommentLimitError(
          'GitHub returned an invalid Pull Request comment page. The action will fail closed.'
        )
      }
      const boundedPage: PullRequestComment[] = []
      for (const comment of page) {
        if (observed >= MAX_PULL_REQUEST_COMMENTS) {
          throw new PullRequestCommentLimitError(
            `A Pull Request has more than ${MAX_PULL_REQUEST_COMMENTS} Pull Request comments. The action will fail closed.`
          )
        }
        observed += 1

        if (!comment || typeof comment !== 'object') {
          throw new PullRequestCommentLimitError(
            'GitHub returned an invalid Pull Request comment. The action will fail closed.'
          )
        }
        if (typeof comment.body !== 'string') {
          throw new PullRequestCommentLimitError(
            'GitHub returned an invalid Pull Request comment body. The action will fail closed.'
          )
        }
        const bodyBytes = Buffer.byteLength(comment.body, 'utf8')
        if (bodyBytes > MAX_PULL_REQUEST_COMMENT_BODY_BYTES) {
          continue
        }
        if (bodyBytes > MAX_PULL_REQUEST_COMMENT_BYTES - observedBodyBytes) {
          throw new PullRequestCommentLimitError(
            `The combined Pull Request comment bodies exceed ${MAX_PULL_REQUEST_COMMENT_BYTES} bytes. The action will fail closed.`
          )
        }
        observedBodyBytes += bodyBytes
        boundedPage.push(comment)
      }
      return boundedPage
    }
  )
}
