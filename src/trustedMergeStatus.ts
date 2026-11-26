import { context } from '@actions/github'
import { octokit } from './octokit'
import {
  getTrustedMergeStatusContext,
  getTrustedMergeStatusCreatorIds
} from './shared/getInputs'
import {
  MAX_TRUSTED_MERGE_STATUS_LOOKUPS,
  MAX_TRUSTED_MERGE_STATUS_PAGES
} from './shared/limits'

/** Parsed trusted merge status configuration plus the remaining lookup budget. */
interface TrustedMergeStatus {
  context: string
  creatorIds: Set<number>
  remainingLookups: number
}

/** The GraphQL commit fields the exemption needs. */
interface CommitShape {
  oid?: string | null
  parents?: { totalCount: number } | null
}

const COMMIT_SHA = /^[0-9a-f]{40}$/

/**
 * Reads the optional trusted merge vouching configuration. Both inputs are
 * required together; a partial or malformed configuration fails the run
 * instead of silently widening or narrowing who must sign.
 */
export function getTrustedMergeStatus(): TrustedMergeStatus | undefined {
  const statusContext = getTrustedMergeStatusContext()
  const rawIds = getTrustedMergeStatusCreatorIds()
  if (!statusContext && !rawIds) return undefined
  if (!statusContext || !rawIds) {
    throw new Error(
      'trusted-merge-status-context and trusted-merge-status-creator-ids must be provided together'
    )
  }
  if (/[\r\n]/.test(statusContext) || statusContext.length > 255) {
    throw new Error('trusted-merge-status-context is malformed')
  }
  const creatorIds = new Set<number>()
  for (const raw of rawIds.split(',')) {
    const entry = raw.trim()
    const id = Number(entry)
    if (!/^[1-9][0-9]*$/.test(entry) || !Number.isSafeInteger(id)) {
      throw new Error(
        'trusted-merge-status-creator-ids must be comma-separated numeric GitHub account IDs'
      )
    }
    creatorIds.add(id)
  }
  return {
    context: statusContext,
    creatorIds,
    remainingLookups: MAX_TRUSTED_MERGE_STATUS_LOOKUPS
  }
}

/**
 * A merge commit is exempt from signing when this repository's newest commit
 * status with the configured context is a success created by a configured
 * account. Commit statuses are stored per repository and only a token with
 * statuses write access to this repository can create one, so a fork cannot
 * vouch for its own commits, and git author, committer, and signature
 * metadata play no part. The status names one exact commit, so it cannot be
 * moved to a different tree. Single-parent commits are never exempt.
 */
export async function isTrustedMergeCommit(
  commit: CommitShape,
  trust: TrustedMergeStatus
): Promise<boolean> {
  if (!commit.parents || commit.parents.totalCount < 2) return false
  if (typeof commit.oid !== 'string' || !COMMIT_SHA.test(commit.oid)) {
    return false
  }
  if (trust.remainingLookups <= 0) return false
  trust.remainingLookups -= 1

  const newest = await findNewestStatus(commit.oid, trust.context)
  const creatorId = newest?.creator?.id
  return Boolean(
    newest &&
    newest.state === 'success' &&
    typeof creatorId === 'number' &&
    trust.creatorIds.has(creatorId)
  )
}

/**
 * Returns this repository's newest status for `statusContext` on `sha`, or
 * undefined. GitHub lists statuses newest first, 100 per page, so the first
 * match is the newest. Only the newest status counts: a later failure or a
 * later status from another account revokes the exemption. Paging stops at
 * MAX_TRUSTED_MERGE_STATUS_PAGES; a context not found by then is unvouched.
 */
async function findNewestStatus(
  sha: string,
  statusContext: string
): Promise<{ state: string; creator?: { id: number } | null } | undefined> {
  for (let page = 1; page <= MAX_TRUSTED_MERGE_STATUS_PAGES; page++) {
    const response = await octokit.rest.repos.listCommitStatusesForRef({
      owner: context.repo.owner,
      repo: context.repo.repo,
      ref: sha,
      per_page: 100,
      page
    })
    const match = response.data.find(status => status.context === statusContext)
    if (match) return match
    if (response.data.length < 100) return undefined
  }
  return undefined
}
