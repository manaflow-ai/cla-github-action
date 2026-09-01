/** Fail-closed bounds for data controlled by Pull Request contributors. */
export const MAX_PULL_REQUEST_COMMITS = 1000
// Commit.authors(first: 100) returns at most 100 author/co-author identities.
// One additional assertion is collected for the git committer. Keep the
// aggregate identity bound derived from the commit envelope so a valid PR at
// the commit limit does not fail early merely because each commit has a
// committer assertion too.
export const MAX_AUTHORS_PER_COMMIT = 100
export const MAX_GIT_IDENTITY_ASSERTIONS =
  MAX_PULL_REQUEST_COMMITS * (MAX_AUTHORS_PER_COMMIT + 1)
export const MAX_PULL_REQUEST_COMMENTS = 1000
// Bound contributor-controlled comment bodies before the action retains a
// complete paginated history. Counts use UTF-8 bytes, not JavaScript code
// units, so the limit matches the data sent over the GitHub API.
export const MAX_PULL_REQUEST_COMMENT_BODY_BYTES = 65_536
export const MAX_PULL_REQUEST_COMMENT_BYTES = 10_000_000
export const MAX_LEDGER_SIGNATURES = 10_000
// GitHub's Contents API only supports files up to 1 MB.
export const MAX_LEDGER_BYTES = 1_000_000
// Concurrent pull requests write the shared ledger with optimistic locking.
// Keep retries bounded so a persistent conflict cannot turn into a runner
// hang or an unbounded API loop.
export const MAX_LEDGER_WRITE_ATTEMPTS = 3
// A first-file create can lose a race with another Pull Request. Retry only
// the safe read that confirms the other run created a valid ledger.
export const MAX_LEDGER_CREATE_RECOVERY_ATTEMPTS = 3
