import { SigningComment } from '../interfaces'
import { isCommentSignedByUser } from './signatureComment'
import {
  listBoundedPullRequestComments,
  PullRequestComment
} from './pullRequestComments'

const CHANGED_SIGNING_COMMENT_ERROR =
  'A signing comment changed or was deleted before the signature ledger write'

/**
 * Re-fetch only the bounded Pull Request comment collection before a ledger
 * write and confirm that each accepted signing comment is unchanged. The
 * action edits its own bot comment during this run, so unrelated comments are
 * intentionally excluded from the comparison.
 */
export async function validateSigningCommentsUnchanged(
  initialComments: PullRequestComment[],
  acceptedSignatures: SigningComment[]
): Promise<void> {
  if (acceptedSignatures.length === 0) return

  const currentComments = await listBoundedPullRequestComments()
  const initialById = indexComments(initialComments)
  const currentById = indexComments(currentComments)
  const checkedIds = new Set<number>()

  for (const signature of acceptedSignatures) {
    const commentId = signature.comment_id
    if (
      typeof commentId !== 'number' ||
      !Number.isSafeInteger(commentId) ||
      commentId <= 0
    ) {
      throw new Error(CHANGED_SIGNING_COMMENT_ERROR)
    }
    if (checkedIds.has(commentId)) continue
    checkedIds.add(commentId)

    const initial = initialById.get(commentId)
    const current = currentById.get(commentId)
    if (
      !initial ||
      !current ||
      !matchesAcceptedSignature(initial, signature) ||
      !sameSigningComment(initial, current) ||
      !isCurrentSignature(current)
    ) {
      throw new Error(CHANGED_SIGNING_COMMENT_ERROR)
    }
  }
}

function indexComments(
  comments: PullRequestComment[]
): Map<number, PullRequestComment> {
  return new Map(comments.map(comment => [comment.id, comment]))
}

function matchesAcceptedSignature(
  comment: PullRequestComment,
  signature: SigningComment
): boolean {
  return (
    comment.user?.id === signature.id &&
    comment.user.login === signature.name &&
    comment.user.type === 'User' &&
    comment.created_at === signature.created_at &&
    isCurrentSignature(comment)
  )
}

function sameSigningComment(
  initial: PullRequestComment,
  current: PullRequestComment
): boolean {
  return (
    current.body === initial.body &&
    current.user?.id === initial.user?.id &&
    current.user?.login === initial.user?.login &&
    current.user?.type === initial.user?.type &&
    current.created_at === initial.created_at &&
    current.updated_at === initial.updated_at
  )
}

function isCurrentSignature(comment: PullRequestComment): boolean {
  return Boolean(
    comment.user &&
    isCommentSignedByUser(
      comment.body ?? '',
      comment.user.login,
      comment.user.type,
      comment.user.id
    )
  )
}
