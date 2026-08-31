/** Fail-closed bounds for data controlled by Pull Request contributors. */
export const MAX_PULL_REQUEST_COMMENTS = 1000
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
