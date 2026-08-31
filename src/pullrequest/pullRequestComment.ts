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
const STALE_BOT_COMMENT_ERROR =
  'The CLA bot comment changed before this plan could be applied; recheck the Pull Request'

interface BotCommentSnapshot {
  id: number
  body: string | undefined
  userId: number | undefined
  userLogin: string | undefined
  userType: string | undefined
  createdAt: string | undefined
  updatedAt: string | undefined
}

export interface PullRequestCommentPlan {
  reactedCommitters: ReactedCommitterMap | undefined
  apply(): Promise<void>
}

export default async function prCommentSetup(
  committerMap: CommitterMap,
  committers: Committer[],
  preloadedComments?: PullRequestComment[],
  acceptSigningComments = true
) {
  const plan = await preparePrComment(
    committerMap,
    committers,
    preloadedComments,
    acceptSigningComments
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
  preloadedComments?: PullRequestComment[],
  acceptSigningComments = true
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
    const initialBotComment = snapshotBotComment(claBotComment)

    // Reacted committers are contributors who have newly signed by posting
    // the Pull Request comment.
    const reactedCommitters: ReactedCommitterMap = acceptSigningComments
      ? await signatureWithPRComment(committerMap, committers, comments)
      : { newSigned: [], onlyCommitters: [], allSignedFlag: false }
    if (acceptSigningComments && reactedCommitters.onlyCommitters) {
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
          let expectedBotComment = initialBotComment
          if (!claBotComment) {
            await assertBotCommentPlanCurrent(expectedBotComment)
            await createComment(
              signed || reactedCommitters.allSignedFlag,
              committerMap
            )
            return
          }

          if (!expectedBotComment) {
            throw new Error(STALE_BOT_COMMENT_ERROR)
          }

          // Keep the existing two-update behavior when the stored ledger
          // already says everyone signed. Validate the marker before each
          // write so an older plan cannot overwrite a newer bot status.
          if (signed) {
            const body = commentContent(signed, committerMap)
            await assertBotCommentPlanCurrent(expectedBotComment)
            const updated = await updateComment(
              signed,
              committerMap,
              claBotComment
            )
            expectedBotComment = mergeBotCommentSnapshot(
              expectedBotComment,
              updated,
              body
            )
          }
          await assertBotCommentPlanCurrent(expectedBotComment)
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

/**
 * Re-fetch the canonical bot marker immediately before a comment write. A
 * concurrent run may have created or updated the marker after this plan was
 * prepared; applying the stale body would otherwise replace newer status.
 */
async function assertBotCommentPlanCurrent(
  expected: BotCommentSnapshot | undefined
): Promise<void> {
  const comments = await listBoundedPullRequestComments()
  const current = snapshotBotComment(await getComment(comments))
  if (!sameBotComment(expected, current)) {
    throw new Error(STALE_BOT_COMMENT_ERROR)
  }
}

function snapshotBotComment(comment: unknown): BotCommentSnapshot | undefined {
  if (!comment || typeof comment !== 'object') return undefined
  const candidate = comment as PullRequestComment
  if (!Number.isSafeInteger(candidate.id) || candidate.id <= 0) return undefined
  return {
    id: candidate.id,
    body: candidate.body,
    userId: candidate.user?.id,
    userLogin: candidate.user?.login,
    userType: candidate.user?.type,
    createdAt: candidate.created_at,
    updatedAt: candidate.updated_at
  }
}

function sameBotComment(
  expected: BotCommentSnapshot | undefined,
  current: BotCommentSnapshot | undefined
): boolean {
  if (!expected || !current) return expected === current
  return (
    expected.id === current.id &&
    expected.body === current.body &&
    expected.userId === current.userId &&
    expected.userLogin === current.userLogin &&
    expected.userType === current.userType &&
    expected.createdAt === current.createdAt &&
    expected.updatedAt === current.updatedAt
  )
}

function mergeBotCommentSnapshot(
  previous: BotCommentSnapshot,
  updated: unknown,
  fallbackBody: string
): BotCommentSnapshot {
  const response = snapshotBotComment(updated)
  return {
    id: response?.id ?? previous.id,
    body: response?.body ?? fallbackBody,
    userId: response?.userId ?? previous.userId,
    userLogin: response?.userLogin ?? previous.userLogin,
    userType: response?.userType ?? previous.userType,
    createdAt: response?.createdAt ?? previous.createdAt,
    updatedAt: response?.updatedAt ?? previous.updatedAt
  }
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
): Promise<unknown> {
  try {
    const response = await octokit.rest.issues.updateComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      comment_id: claBotComment.id,
      body: commentContent(signed, committerMap)
    })
    return response.data
  } catch (error) {
    throw new Error(
      `Error occured when updating the pull request comment: ${errorMessage(error)}`
    )
  }
}

async function getComment(
  comments: PullRequestComment[]
): Promise<PullRequestComment | undefined> {
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
      !Number.isSafeInteger(canonicalBot.data.id) ||
      canonicalBot.data.id <= 0
    ) {
      throw new Error(
        'GitHub did not return the canonical Actions bot identity'
      )
    }

    const trusted = markerComments.find(
      comment =>
        comment.user?.id === canonicalBot.data.id &&
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
