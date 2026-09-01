import { context } from '@actions/github'
import { SigningComment } from '../interfaces'
import { getPrSignComment } from '../shared/pr-sign-comment'
import type { ExpectedSigningComment } from '../shared/getInputs'
import { isCommentSignedByUser, isUneditedComment } from './signatureComment'
import {
  listBoundedPullRequestComments,
  PullRequestComment
} from './pullRequestComments'

const CHANGED_SIGNING_COMMENT_ERROR =
  'A signing comment changed or was deleted before the signature ledger write'

const MISSING_EXPECTED_SIGNING_COMMENT_ERROR =
  'The preflight-authenticated signing comment changed or was deleted before the signature write'

/**
 * Verify the immutable comment tuple returned by signer-preflight against the
 * event payload and the current bounded REST snapshot. Numeric IDs identify
 * the account and comment; login names are deliberately not compared because
 * GitHub permits username changes.
 */
export function validateExpectedSigningComment(
  expected: ExpectedSigningComment | undefined,
  comments: PullRequestComment[]
): void {
  if (!expected) return

  const eventComment = context.payload.comment
  if (
    context.eventName !== 'issue_comment' ||
    context.payload.action !== 'created' ||
    !isExpectedCommentShape(eventComment) ||
    eventComment.id !== expected.id ||
    eventComment.body !== getPrSignComment() ||
    eventComment.user.id !== expected.authorId ||
    eventComment.user.type !== 'User' ||
    eventComment.created_at !== expected.createdAt ||
    eventComment.updated_at !== expected.createdAt
  ) {
    throw new Error(MISSING_EXPECTED_SIGNING_COMMENT_ERROR)
  }

  const matches = comments.filter(comment => comment.id === expected.id)
  if (matches.length !== 1) {
    throw new Error(MISSING_EXPECTED_SIGNING_COMMENT_ERROR)
  }
  const comment = matches[0]
  if (!comment) throw new Error(MISSING_EXPECTED_SIGNING_COMMENT_ERROR)
  if (
    comment.body !== getPrSignComment() ||
    comment.user?.id !== expected.authorId ||
    comment.user.type !== 'User' ||
    comment.created_at !== expected.createdAt ||
    !isUneditedComment(comment.created_at, comment.updated_at)
  ) {
    throw new Error(MISSING_EXPECTED_SIGNING_COMMENT_ERROR)
  }
}

function isExpectedCommentShape(value: unknown): value is {
  id: number
  body: string
  created_at: string
  updated_at: string
  user: { id: number; type: string }
} {
  if (!value || typeof value !== 'object') return false
  const comment = value as {
    id?: unknown
    body?: unknown
    created_at?: unknown
    updated_at?: unknown
    user?: { id?: unknown; type?: unknown }
  }
  return (
    Number.isSafeInteger(comment.id) &&
    Number(comment.id) > 0 &&
    typeof comment.body === 'string' &&
    typeof comment.created_at === 'string' &&
    typeof comment.updated_at === 'string' &&
    Number.isSafeInteger(comment.user?.id) &&
    Number(comment.user?.id) > 0 &&
    typeof comment.user?.type === 'string'
  )
}

/**
 * Re-fetch only the bounded Pull Request comment collection before a ledger
 * write and confirm that each accepted signing comment is unchanged. The
 * action edits its own bot comment during this run, so unrelated comments are
 * intentionally excluded from the comparison.
 */
export async function validateSigningCommentsUnchanged(
  initialComments: PullRequestComment[],
  acceptedSignatures: SigningComment[],
  expected?: ExpectedSigningComment
): Promise<void> {
  if (!expected && acceptedSignatures.length === 0) return
  const currentComments = await listBoundedPullRequestComments()
  validateExpectedSigningComment(expected, initialComments)
  validateExpectedSigningComment(expected, currentComments)
  if (acceptedSignatures.length === 0) return

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

    if (expected && commentId !== expected.id) {
      throw new Error(CHANGED_SIGNING_COMMENT_ERROR)
    }

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

/** Re-fetch and validate a preflight-bound comment immediately before a write. */
export async function validateExpectedSigningCommentLive(
  expected: ExpectedSigningComment | undefined
): Promise<void> {
  if (!expected) return
  validateExpectedSigningComment(
    expected,
    await listBoundedPullRequestComments()
  )
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
    isUneditedComment(comment.created_at, comment.updated_at) &&
    isCommentSignedByUser(
      comment.body ?? '',
      comment.user.login,
      comment.user.type,
      comment.user.id
    )
  )
}
