import { Committer } from '../interfaces'

interface PullRequestOpener {
  id: number
  login: string
}

interface OpenerAuthorshipMismatch {
  opener: string
  commitAuthors: string[]
}

/**
 * Include the authenticated Pull Request opener as a contributor when the
 * opener is not present in git metadata. Git author and committer fields are
 * assertions, so the live Pull Request identity must remain a separate
 * contributor even when the commit list is otherwise complete.
 */
export function includePullRequestOpener(
  committers: Committer[],
  opener: PullRequestOpener,
  pullRequestNo: number
): Committer[] {
  const existing = committers.find(committer => committer.id === opener.id)
  if (existing) {
    existing.isPullRequestOpener = true
    return committers
  }
  return [
    {
      name: opener.login,
      id: opener.id,
      pullRequestNo,
      isPullRequestOpener: true
    },
    ...committers
  ]
}

/**
 * Return an authenticated opener mismatch when no primary-author or
 * co-author identity in the current commit set has the opener's account ID.
 * Committer-only matches do not qualify because the committer field is still
 * attacker-controlled git metadata.
 */
export function findOpenerAuthorshipMismatch(
  commitAuthors: Committer[],
  opener: PullRequestOpener
): OpenerAuthorshipMismatch | undefined {
  const authorshipIdentities = commitAuthors.filter(
    committer => committer.isPrimaryAuthor || committer.isCoAuthor
  )
  if (authorshipIdentities.some(committer => committer.id === opener.id)) {
    return undefined
  }
  return {
    opener: opener.login,
    commitAuthors: authorshipIdentities
      .map(committer => committer.name)
      .filter(name => name.length > 0)
  }
}

export function openerAuthorshipMismatchMessage(
  mismatch: OpenerAuthorshipMismatch
): string {
  return `Pull Request opener @${mismatch.opener} is not recorded as an author or co-author of any commit in this PR. If this is intentional (e.g. a cherry-pick or release-engineering workflow), set the 'require-opener-as-author' action input to 'false'.`
}
