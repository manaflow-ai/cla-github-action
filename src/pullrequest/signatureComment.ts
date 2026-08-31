import { context } from '@actions/github'
import {
  Committer,
  CommitterMap,
  ReactedCommitterMap,
  SigningComment
} from '../interfaces'
import { getPrSignComment } from '../shared/pr-sign-comment'
import {
  listBoundedPullRequestComments,
  PullRequestComment
} from './pullRequestComments'

export default async function signatureWithPRComment(
  committerMap: CommitterMap,
  committers: Committer[],
  preloadedComments?: PullRequestComment[]
): Promise<ReactedCommitterMap> {
  const repoId = context.payload.repository?.id
  const allComments =
    preloadedComments ?? (await listBoundedPullRequestComments())
  const listOfPRComments: SigningComment[] = []
  const filteredListOfPRComments: SigningComment[] = []

  for (const prComment of allComments) {
    if (!prComment.user) continue
    listOfPRComments.push({
      name: prComment.user.login,
      id: prComment.user.id,
      comment_id: prComment.id,
      body: prComment.body ?? '',
      created_at: prComment.created_at,
      repoId,
      pullRequestNo: context.issue.number,
      actorType: prComment.user.type
    })
  }
  for (const comment of listOfPRComments) {
    if (
      isCommentSignedByUser(
        comment.body ?? '',
        comment.name,
        comment.actorType,
        comment.id
      )
    ) {
      const { body: _, actorType: __, ...withoutBody } = comment
      filteredListOfPRComments.push(withoutBody)
    }
  }
  /*
   *checking if the reacted committers are not the signed committers(not in the storage file) and filtering only the unsigned committers
   */
  const newSigned = filteredListOfPRComments.filter(commentedCommitter =>
    committerMap.notSigned.some(
      notSignedCommitter => commentedCommitter.id === notSignedCommitter.id
    )
  )

  /*
   * checking if the commented users are only the contributors who has committed in the same PR (This is needed for the PR Comment and changing the status to success when all the contributors has reacted to the PR)
   */
  const onlyCommitters = committers.filter(committer =>
    filteredListOfPRComments.some(
      commentedCommitter => committer.id == commentedCommitter.id
    )
  )
  const commentedCommitterMap: ReactedCommitterMap = {
    newSigned,
    onlyCommitters,
    allSignedFlag: false
  }

  return commentedCommitterMap
}

export function isCommentSignedByUser(
  comment: string,
  commentAuthor: string,
  actorType?: string,
  commentAuthorId?: number
): boolean {
  if (
    actorType !== 'User' ||
    !Number.isSafeInteger(commentAuthorId) ||
    (commentAuthorId ?? 0) <= 0 ||
    commentAuthor.toLowerCase() === 'github-actions[bot]' ||
    commentAuthor.toLowerCase().endsWith('[bot]')
  ) {
    return false
  }
  return commentContainsSignature(comment, getPrSignComment())
}

/**
 * Decide whether a PR comment counts as signing the CLA/DCO.
 *
 * The configured declaration must be the entire raw comment body. Case,
 * wording, punctuation, and every whitespace character must match exactly.
 * This keeps the recorded electronic signature aligned with the declaration
 * in the CLA and rejects quotations, qualifications, appended commands, and
 * declarations that only become valid after trimming.
 */
export function commentContainsSignature(
  commentBody: string,
  signPhrase: string
): boolean {
  return signPhrase.length > 0 && commentBody === signPhrase
}
