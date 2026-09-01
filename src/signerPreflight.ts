import * as core from '@actions/core'
import { context } from '@actions/github'
import { isPullRequestOpenerAllowlisted } from './checkAllowList'
import getCommitters from './graphql'
import { validateLivePullRequest } from './livePullRequest'
import { Committer, CommitterMap } from './interfaces'
import signatureWithPRComment, {
  isCommentSignedByUser,
  isUneditedComment
} from './pullrequest/signatureComment'
import {
  listBoundedPullRequestComments,
  PullRequestComment
} from './pullrequest/pullRequestComments'
import {
  findOpenerAuthorshipMismatch,
  includePullRequestOpener,
  openerAuthorshipMismatchMessage
} from './shared/committers'
import { getPrSignComment } from './shared/pr-sign-comment'
import { requireOpenerAsAuthor } from './shared/getInputs'

type SignerDecision = 'authorized' | 'unauthorized' | 'error'

export function setSignerDecision(decision: SignerDecision): void {
  core.setOutput('signer_decision', decision)
}

/**
 * Authenticate the current signing comment without invoking any ledger or
 * Pull Request write. The write-capable action must still repeat all live
 * checks before accepting a signature; this result is only an admission
 * signal for a least-privilege workflow gate.
 */
export async function runSignerPreflight(): Promise<void> {
  core.setOutput('signer_authorized', false)

  const livePullRequest = await validateLivePullRequest()
  core.setOutput('head_sha', livePullRequest.headSha)
  core.setOutput('base_sha', livePullRequest.baseSha)
  const eventComment = readEventComment()
  const signPhrase = getPrSignComment()

  if (!commentMatchesPhrase(eventComment, signPhrase)) {
    core.info(
      'The current Pull Request comment is not the configured exact signing declaration.'
    )
    return
  }

  const comments = await listBoundedPullRequestComments()
  const canonicalComment = findCanonicalComment(comments, eventComment)
  if (!canonicalComment) {
    throw new Error(
      'The current signing comment is missing from the live Pull Request; refusing signer admission'
    )
  }
  if (!sameEventComment(eventComment, canonicalComment)) {
    throw new Error(
      'The current signing comment changed while the preflight was starting; refusing signer admission'
    )
  }
  if (
    !isUneditedComment(canonicalComment.created_at, canonicalComment.updated_at)
  ) {
    throw new Error(
      'The current signing comment was edited; post a new exact declaration'
    )
  }

  const commitAuthors = await getCommitters(livePullRequest.headSha)
  const openerMismatch = findOpenerAuthorshipMismatch(
    commitAuthors,
    livePullRequest.opener
  )
  if (openerMismatch) {
    core.setOutput('opener_not_in_commits', true)
  }
  if (
    openerMismatch &&
    requireOpenerAsAuthor() &&
    !isPullRequestOpenerAllowlisted(livePullRequest.opener)
  ) {
    setSignerDecision('unauthorized')
    core.setFailed(openerAuthorshipMismatchMessage(openerMismatch))
    return
  }

  const committers = includePullRequestOpener(
    commitAuthors,
    livePullRequest.opener,
    context.issue.number
  )
  const committerMap: CommitterMap = {
    signed: [],
    notSigned: committers,
    unknown: []
  }
  const reaction = await signatureWithPRComment(committerMap, committers, [
    canonicalComment
  ])
  const authorized = reaction.newSigned.some(
    signer => signer.id === eventComment.user.id
  )
  core.setOutput('signer_authorized', authorized)

  if (!authorized) {
    setSignerDecision('unauthorized')
    core.setFailed(
      'The signing comment is not authored by an authenticated identity in the current Pull Request'
    )
    return
  }
  setSignerDecision('authorized')
}

interface EventComment {
  id: number
  body: string
  user: { id: number; login: string; type: string }
  createdAt?: string
  updatedAt?: string
}

function readEventComment(): EventComment {
  if (
    context.eventName !== 'issue_comment' ||
    context.payload.action !== 'created'
  ) {
    throw new Error(
      'signer-preflight only accepts a newly created issue_comment event'
    )
  }

  const value = context.payload.comment
  if (!value || typeof value !== 'object') {
    throw new Error(
      'The issue-comment payload has no verified comment; refusing signer admission'
    )
  }
  const comment = value as {
    id?: unknown
    body?: unknown
    created_at?: unknown
    updated_at?: unknown
    user?: { id?: unknown; login?: unknown; type?: unknown }
  }
  const user = comment.user
  if (
    !isPositiveSafeInteger(comment.id) ||
    typeof comment.body !== 'string' ||
    !user ||
    !isPositiveSafeInteger(user.id) ||
    typeof user.login !== 'string' ||
    user.login.trim().length === 0 ||
    typeof user.type !== 'string'
  ) {
    throw new Error(
      'The issue-comment payload has no complete authenticated commenter identity'
    )
  }
  if (
    typeof comment.created_at !== 'undefined' &&
    typeof comment.created_at !== 'string'
  ) {
    throw new Error('The issue-comment creation timestamp is malformed')
  }
  if (
    typeof comment.updated_at !== 'undefined' &&
    typeof comment.updated_at !== 'string'
  ) {
    throw new Error('The issue-comment update timestamp is malformed')
  }
  return {
    id: comment.id,
    body: comment.body,
    user: { id: user.id, login: user.login, type: user.type },
    ...(typeof comment.created_at === 'string'
      ? { createdAt: comment.created_at }
      : {}),
    ...(typeof comment.updated_at === 'string'
      ? { updatedAt: comment.updated_at }
      : {})
  }
}

function commentMatchesPhrase(comment: EventComment, phrase: string): boolean {
  return isCommentSignedByUser(
    comment.body,
    comment.user.login,
    comment.user.type,
    comment.user.id,
    phrase
  )
}

function findCanonicalComment(
  comments: PullRequestComment[],
  eventComment: EventComment
): PullRequestComment | undefined {
  return comments.find(comment => comment.id === eventComment.id)
}

function sameEventComment(
  eventComment: EventComment,
  canonicalComment: PullRequestComment
): boolean {
  const user = canonicalComment.user
  if (
    !user ||
    user.id !== eventComment.user.id ||
    user.type !== eventComment.user.type ||
    canonicalComment.body !== eventComment.body
  ) {
    return false
  }
  if (
    eventComment.createdAt !== undefined &&
    eventComment.createdAt !== canonicalComment.created_at
  ) {
    return false
  }
  if (
    eventComment.updatedAt !== undefined &&
    eventComment.updatedAt !== canonicalComment.updated_at
  ) {
    return false
  }
  return true
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
