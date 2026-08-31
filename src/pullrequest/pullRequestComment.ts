import { octokit } from '../octokit'
import { context } from '@actions/github'
import signatureWithPRComment from './signatureComment'
import { commentContent } from './pullRequestCommentContent'
import { CommitterMap, Committer, ReactedCommitterMap } from '../interfaces'
import { getUseDcoFlag } from '../shared/getInputs'
import { errorMessage } from '../shared/errors'
import * as core from '@actions/core'
import {
  listBoundedPullRequestComments,
  PullRequestComment,
  PullRequestCommentLimitError
} from './pullRequestComments'

const ACTIONS_BOT_LOGIN = 'github-actions[bot]'
// GitHub's Actions bot account has a stable numeric identity. Require the
// login, type, and ID together so a compromised or unexpected API response
// cannot authorize a public marker string as a trusted bot comment.
const ACTIONS_BOT_ID = 41898282

export interface PullRequestCommentPlan {
  reactedCommitters: ReactedCommitterMap | undefined
  apply(): Promise<void>
}

export default async function prCommentSetup(
  committerMap: CommitterMap,
  committers: Committer[],
  preloadedComments?: PullRequestComment[]
) {
  const plan = await preparePrComment(
    committerMap,
    committers,
    preloadedComments
  )
  await plan.apply()
  return plan.reactedCommitters
}

/**
 * Compute the trusted CLA comment update without publishing it. The caller
 * can validate and persist any newly accepted signatures before apply() makes
 * an all-signed claim visible on the Pull Request.
 */
export async function preparePrComment(
  committerMap: CommitterMap,
  committers: Committer[],
  preloadedComments?: PullRequestComment[]
): Promise<PullRequestCommentPlan> {
  const signed = committerMap?.notSigned && committerMap?.notSigned.length === 0

  try {
    const comments =
      preloadedComments ?? (await listBoundedPullRequestComments())
    const claBotComment = await getComment(comments)
    if (
      claBotComment &&
      (!Number.isSafeInteger(claBotComment.id) || claBotComment.id <= 0)
    ) {
      throw new Error('The trusted CLA bot comment has an invalid ID')
    }

    // Reacted committers are contributors who have newly signed by posting
    // the Pull Request comment.
    const reactedCommitters = await signatureWithPRComment(
      committerMap,
      committers,
      comments
    )
    if (reactedCommitters?.onlyCommitters) {
      reactedCommitters.allSignedFlag = prepareAllSignedCommitters(
        committerMap,
        reactedCommitters.onlyCommitters,
        committers
      )
    }

    return {
      reactedCommitters,
      apply: () =>
        applyCommentOperation(async () => {
          const refreshedMap = prepareCommiterMap(
            committerMap,
            reactedCommitters
          )
          refreshedMap.openerMismatch = committerMap.openerMismatch
          committerMap = refreshedMap
          if (!claBotComment) {
            await createComment(
              signed || reactedCommitters.allSignedFlag,
              committerMap
            )
            return
          }

          // Keep the existing two-update behavior when the stored ledger
          // already says everyone signed. Both writes are deferred together.
          if (signed) {
            await updateComment(signed, committerMap, claBotComment)
          }
          await updateComment(
            reactedCommitters.allSignedFlag,
            committerMap,
            claBotComment
          )
        })
    }
  } catch (error) {
    throw commentOperationError(error)
  }
}

async function applyCommentOperation(
  operation: () => Promise<void>
): Promise<void> {
  try {
    await operation()
  } catch (error) {
    throw commentOperationError(error)
  }
}

function commentOperationError(error: unknown): Error {
  return new Error(
    `Error occured when creating or editing the comments of the pull request: ${errorMessage(error)}`
  )
}

async function createComment(
  signed: boolean,
  committerMap: CommitterMap
): Promise<void> {
  await octokit.rest.issues
    .createComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: context.issue.number,
      body: commentContent(signed, committerMap)
    })
    .catch(error => {
      throw new Error(
        `Error occured when creating a pull request comment: ${errorMessage(error)}`
      )
    })
}

async function updateComment(
  signed: boolean,
  committerMap: CommitterMap,
  claBotComment: any
): Promise<void> {
  await octokit.rest.issues
    .updateComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      comment_id: claBotComment.id,
      body: commentContent(signed, committerMap)
    })
    .catch(error => {
      throw new Error(
        `Error occured when updating the pull request comment: ${errorMessage(error)}`
      )
    })
}

async function getComment(comments: PullRequestComment[]) {
  try {
    const marker = getUseDcoFlag()
      ? /.*DCO Assistant Lite bot.*/m
      : /.*CLA Assistant Lite bot.*/m
    const markerComments = comments.filter(comment =>
      comment.body?.match(marker)
    )
    if (markerComments.length === 0) return undefined

    // A marker string is public and can be copied by any commenter. Resolve
    // GitHub's canonical Actions bot account and accept only a marker written
    // by that API identity. This avoids a hard-coded database ID while still
    // failing closed if GitHub cannot verify the bot account.
    const canonicalBot = await octokit.rest.users.getByUsername({
      username: ACTIONS_BOT_LOGIN
    })
    if (
      canonicalBot.data.type !== 'Bot' ||
      canonicalBot.data.login.toLowerCase() !== ACTIONS_BOT_LOGIN ||
      canonicalBot.data.id !== ACTIONS_BOT_ID
    ) {
      throw new Error(
        'GitHub did not return the canonical Actions bot identity'
      )
    }

    const trusted = markerComments.find(
      comment =>
        comment.user?.id === ACTIONS_BOT_ID &&
        comment.user.login.toLowerCase() ===
          canonicalBot.data.login.toLowerCase() &&
        comment.user.type === canonicalBot.data.type
    )
    if (!trusted) {
      core.warning(
        'Ignored a CLA marker comment because it was not written by the canonical GitHub Actions bot.'
      )
    }
    return trusted
  } catch (error) {
    if (error instanceof PullRequestCommentLimitError) throw error
    throw new Error('Could not retrieve or verify CLA bot comments')
  }
}

function prepareCommiterMap(
  committerMap: CommitterMap,
  reactedCommitters: ReactedCommitterMap
): CommitterMap {
  committerMap.signed.push(...reactedCommitters.newSigned)
  committerMap.notSigned = committerMap.notSigned.filter(
    committer =>
      !reactedCommitters.newSigned.some(
        reactedCommitter => committer.id === reactedCommitter.id
      )
  )
  return committerMap
}

function prepareAllSignedCommitters(
  committerMap: CommitterMap,
  signedInPrCommitters: Committer[],
  committers: Committer[]
): boolean {
  let allSignedCommitters = [] as Committer[]
  /*
   * 1) already signed committers in the file 2) signed committers in the PR comment
   */
  const ids = new Set(signedInPrCommitters.map(committer => committer.id))
  allSignedCommitters = [
    ...signedInPrCommitters,
    ...committerMap.signed.filter(
      signedCommitter => !ids.has(signedCommitter.id)
    )
  ]
  /*
   * checking if all the unsigned committers have reacted to the PR comment (this is needed for changing the content of the PR comment to "All committers have signed the CLA")
   */
  let allSignedFlag: boolean = committers.every(committer =>
    allSignedCommitters.some(
      reactedCommitter => committer.id === reactedCommitter.id
    )
  )
  return allSignedFlag
}
