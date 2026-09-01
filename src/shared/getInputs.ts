import * as core from '@actions/core'

/**
 * Selects the action execution path. The normal `sign` mode retains the
 * historical ledger/comment behavior. `signer-preflight` performs only the
 * read-only identity and comment checks needed by an unprivileged workflow
 * gate.
 */
export const getMode = (): string =>
  core.getInput('mode', { required: false }).trim() || 'sign'

export const getRemoteRepoName = (): string => {
  return core.getInput('remote-repository-name', { required: false })
}

export const getRemoteOrgName = (): string => {
  return core.getInput('remote-organization-name', { required: false })
}

export const getPathToSignatures = (): string =>
  core.getInput('path-to-signatures', { required: false })

export const getPathToDocument = (): string =>
  core.getInput('path-to-document', { required: false })

export const getBranch = (): string =>
  core.getInput('branch', { required: false })

/**
 * Optional immutable head binding supplied by a read-only preflight job.
 * Empty means that the action uses its normal live Pull Request validation.
 */
export const getExpectedHeadSha = (): string =>
  core.getInput('expected-head-sha', { required: false }).trim()

/**
 * Optional immutable base binding supplied by a read-only preflight job.
 * Empty means that the action uses its normal live Pull Request validation.
 */
export const getExpectedBaseSha = (): string =>
  core.getInput('expected-base-sha', { required: false }).trim()

export interface ExpectedSigningComment {
  id: number
  createdAt: string
  authorId: number
}

/**
 * Optional immutable comment binding supplied by a read-only signer-preflight.
 * The three fields are a tuple: a partial tuple is never accepted. Empty means
 * that the writer keeps its normal live comment discovery behavior.
 */
export const getExpectedSigningComment = ():
  | ExpectedSigningComment
  | undefined => {
  const id = core.getInput('expected-comment-id', { required: false }).trim()
  const createdAt = core
    .getInput('expected-comment-created-at', { required: false })
    .trim()
  const authorId = core
    .getInput('expected-comment-author-id', { required: false })
    .trim()
  const values = [id, createdAt, authorId]
  if (values.every(value => value === '')) return undefined
  if (values.some(value => value === '')) {
    throw new Error(
      'expected-comment-id, expected-comment-created-at, and expected-comment-author-id must be provided together'
    )
  }
  const parsedId = parsePositiveSafeInteger(id)
  const parsedAuthorId = parsePositiveSafeInteger(authorId)
  if (
    parsedId === undefined ||
    parsedAuthorId === undefined ||
    /[\r\n]/.test(createdAt)
  ) {
    throw new Error('Expected signer comment identity inputs are malformed')
  }
  return { id: parsedId, createdAt, authorId: parsedAuthorId }
}

export const getRequiredBaseRef = (): string =>
  core.getInput('required-base-ref', { required: false }) || 'main'

export const getAllowListItem = (): string =>
  core.getInput('allowlist', { required: false })

export const getAllowListIds = (): string =>
  core.getInput('allowlist-ids', { required: false })

export const getSignedCommitMessage = (): string =>
  core.getInput('signed-commit-message', { required: false })

export const getCreateFileCommitMessage = (): string =>
  core.getInput('create-file-commit-message', { required: false })

export const getCustomNotSignedPrComment = (): string =>
  core.getInput('custom-notsigned-prcomment', { required: false })

export const getCustomAllSignedPrComment = (): string =>
  core.getInput('custom-allsigned-prcomment', { required: false })

export const getUseDcoFlag = (): boolean => getBooleanInput('use-dco-flag')

export const getCustomPrSignComment = (): string =>
  core.getInput('custom-pr-sign-comment', { required: false })

export const lockPullRequestAfterMerge = (): boolean =>
  getBooleanInput('lock-pullrequest-aftermerge')

export const suggestRecheck = (): boolean => getBooleanInput('suggest-recheck')

/**
 * Whether the PR opener must be recorded as an author or co-author of at
 * least one commit in the PR. Committer metadata does not qualify because it
 * is not authenticated. When true (the default), an opener who is not
 * in the authorship trail causes the check to fail — a guard against
 * impersonation of an attacker-submitted patch attributed to a trusted
 * identity. Opt out by setting 'false' if your workflow involves submitters
 * who legitimately push commits authored by others (cherry-picks, release
 * engineers applying accepted patches, mailing-list-style patch submission).
 */
export const requireOpenerAsAuthor = (): boolean =>
  getBooleanInput('require-opener-as-author', true)

/**
 * Parses the action input as a boolean, tolerating unset / empty. Actions
 * accept only strings; 'true' / 'false' (case-insensitive) are the supported
 * values. Anything else falls back to `fallback` (default false), so an
 * unset input preserves the semantics the caller wants.
 */
function getBooleanInput(name: string, fallback = false): boolean {
  const raw = core.getInput(name, { required: false }).toLowerCase().trim()
  if (raw === 'true') return true
  if (raw === 'false') return false
  return fallback
}

function parsePositiveSafeInteger(value: string): number | undefined {
  if (!/^[1-9][0-9]*$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}
