# Changelog

All notable changes to this fork since it diverged from the upstream
`cla-assistant/github-action` project (archived). The branch point is commit
[`58daaf8`](../../commit/58daaf8) "Update README to reflect repository status".

Versioning starts at `v3.0.0`, the first major version after the upstream
project's final release (`v2.7.1`), to make clear this is a divergent line.
Changes are grouped by the logical unit of work; each entry links to the
commit that introduced it.

## Unreleased

### Security

- The action now rejects an empty, relative, or non-HTTPS
  `path-to-document` input before it makes a GitHub write.
- Commit identities now come from GitHub's GraphQL `Commit.authors`
  connection. The action includes the primary author, resolved co-authors, and
  every committer. Unlinked service-looking metadata is not exempt because git
  names and email addresses can be forged. The action no longer trusts a
  numeric ID written in a raw `Co-authored-by` trailer.
- Every non-opener identity derived from git author, co-author, or committer
  metadata must post the exact declaration on the current Pull Request.
  GitHub's email-to-account mapping does not authenticate authorship. A stored
  signature is reusable only for the account authenticated by the live Pull
  Request API as the opener.
- The deprecated name, email, and glob `allowlist` is ignored. The new
  `allowlist-ids` input can exempt only the authenticated live Pull Request
  opener. It never exempts an identity derived only from commit metadata.
- Signature comments must contain only the exact declaration. Appended text,
  changed case or punctuation, quotations, and bot comments do not count.
- A declaration comment counts only when its GitHub creation and update
  timestamps match. Editing an older comment into the declaration before a
  later `recheck` cannot create a signature.
- Existing CLA marker comments are trusted only when GitHub confirms that the
  canonical Actions bot wrote them. A spoofed marker cannot suppress a valid
  signing comment from the same action run. The verified numeric bot ID comes
  from the current GitHub instance, so GitHub Enterprise Server is supported.
- The action checks the live Pull Request state, opener, base repository ID,
  base branch, head repository ID, head branch, and head commit before
  signature work, before a ledger write, and before it reports success.
- GraphQL commit identity pages must report the same Pull Request head commit
  as the live REST snapshot. A force-push cannot substitute an unbound commit
  set between validation and signature work.
- The signature ledger now rejects invalid entries and removes duplicate IDs.
- The unsafe branch-based internal workflow rerun was removed. A repository
  must use a separate trusted rerun job that validates the Pull Request number
  and current head commit.
- Repository workflows now use full commit SHAs for every external action,
  explicit minimum token permissions, disabled checkout credential
  persistence, and job timeouts. CODEOWNERS and weekly Dependabot updates
  cover the action, npm dependencies, and workflow dependencies.
- Pull Requests with more than 1,000 commits or more than 101,000 git identity
  assertions fail closed to bound work on untrusted GraphQL data. The identity
  bound is derived from the maximum 100 authors per commit plus one committer.
- The action no longer unlocks a reopened Pull Request. It preserves
  maintainer locks and tells maintainers to unlock the conversation manually.
- A failed request to lock a merged Pull Request now fails the action instead
  of reporting success with an unlocked signature comment.
- Pull Requests with more than 1,000 comments and signature ledgers with more
  than 10,000 entries or 1,000,000 bytes fail closed before a read or write.
- A closed event is re-fetched and matched by immutable base repository ID,
  base branch, opener, state, and merge result before the action locks the
  conversation. A valid live head is still required, but a source branch
  advance or repository deletion after merge does not prevent locking.
- The new `required-base-ref` input has an empty compatibility default, which
  preserves upstream behavior. Protected deployments must set it explicitly.
- GitHub API failures fail the current run without automatic request replay.
  This prevents an ambiguous lost response from creating duplicate comments
  or ledger writes. Operators can rerun the failed workflow after recovery.
- The action bounds and snapshots Pull Request comments before any ledger or
  comment write. Only a GitHub `User` actor with a positive account ID can
  create a signature.
- Merged Pull Request locks use GitHub's valid `resolved` reason. An omitted
  `required-base-ref` remains compatible but now emits a runtime warning that
  any base branch is accepted.
- Git names and emails are rendered as escaped, inert text in bot comments.
  Attacker-controlled commit metadata cannot inject Markdown blocks, links,
  or account mentions.
- Accepted signing comments are re-fetched from the bounded Pull Request
  comment list immediately before a ledger write. An edited, deleted, or
  identity-changed comment fails the run without changing the ledger.
- The trusted bot publishes an all-signed status only after the action
  revalidates the signing comments and persists new signatures. A rejected
  signing comment leaves the prior bot status unchanged.
- When the signature ledger does not exist, the first run creates an empty
  ledger and leaves existing declarations pending with `recheck` guidance. It
  never publishes all-signed status before those signatures are persisted.
- The first missing-ledger comment now includes the opener-authorship guard and
  its specific failure message, instead of hiding that diagnostic until a
  later run.
- If an authenticated allowlisted opener is the only contributor on the first
  Pull Request, ledger creation completes successfully without requesting a
  signature.
- When two Pull Requests create the first ledger together, a 409 or 422 create
  response starts at most three safe reads. The action continues only after it
  confirms a valid ledger. Other create failures still fail closed.
- The shared ledger uses bounded optimistic locking for later cross-Pull Request
  writes. A contents conflict re-reads the ledger, merges the new signature,
  revalidates the live Pull Request and signing comment, and retries at most
  three writes. Persistent contention fails closed and may require a later
  `recheck`; it cannot cause an unbounded runner loop or discard a committed
  signature.

### Changed

- Updated the production Actions toolkit to `@actions/core` 3.0.1 and
  `@actions/github` 9.1.1. Updated the action bundle to the Node 24 runtime.

## v3.2.0 — 2026-06-17

### Changed
- **CLA sign-comment matching tolerates a small amount of surrounding
  text.** ([`1f440bd`](../../commit/1f440bd)) A comment now counts as a signature when the configured phrase
  appears on its own line (or its own block of lines, for a multi-line
  `custom-pr-sign-comment`), case-insensitive, with trailing `.`/`!`
  ignored, and any other text in the comment is no longer than the
  phrase itself (minimum allowance 32 characters). Previously the match
  failed if the comment contained anything on another line — for example
  a contributor adding `recheck` below the declaration. The same rule
  now applies whether or not `custom-pr-sign-comment` is set; previously
  that path required a byte-for-byte match. Note this is also slightly
  *stricter* on the matching line itself: text before or after the
  phrase on the same line (other than trailing punctuation) no longer
  matches, and a line inside a `>` Markdown blockquote is never treated
  as the author's own declaration.

## v3.1.0 — 2026-06-09

### Fixed
- **Pull requests closed without merging are no longer locked.**
  ([`30dab6b`](../../commit/30dab6b)) The `lock-pullrequest-aftermerge`
  feature locked the conversation on *any* `closed` event, including a
  contributor closing their own unmerged PR. If the PR was later
  reopened, the stale lock prevented the bot from commenting and the CLA
  check could never complete. The lock now only applies when the PR was
  actually merged.
- **Reopened PRs with a stale lock are unlocked automatically.**
  ([`30dab6b`](../../commit/30dab6b)) A merged PR can never be reopened,
  so a lock found on a reopened PR is either left over from the
  lock-on-any-close bug above or was set manually by a maintainer; the
  action cannot tell the two apart and removes it so the CLA check can
  comment again. Applies only when `lock-pullrequest-aftermerge` is
  enabled. The recommended workflow in the README now includes
  `reopened` in its `pull_request_target` trigger types so the check
  (and the unlock) runs on reopen.

## v3.0.0 — 2026-05-07

First tagged release of this fork.

### Added
- **Impersonation guard: PR opener must be an author or co-author of at
  least one commit (new `require-opener-as-author` input, defaults to
  `true`).** A PR whose commits are all attributed to a different identity
  than the submitter is a potential git-author impersonation vector (git
  author fields are unauthenticated). When the opener is not in the
  authorship trail, the action now:
  - Emits `core.setOutput('opener_not_in_commits', true)` so branch-
    protection rules can gate on it.
  - Prepends a `> [!CAUTION]` block to the bot comment naming the opener
    and the actual commit authors.
  - Fails the check (`setFailed`) when `require-opener-as-author` is
    `true` (the default).
  - Opt out with `require-opener-as-author: 'false'` for workflows
    involving cherry-picks, release-engineering patch submission, or
    mailing-list-style contribution. In that mode the block is a
    `> [!NOTE]` heads-up instead of a hard failure.
- **PR opener and `Co-authored-by:` trailers are now part of the committer
  set.** Previously the action enumerated only `commit.author` (with
  `commit.committer` as fallback) from each PR commit. If Alice opened a PR
  whose commits were authored entirely by Bob, Alice was never required to
  sign. Likewise any `Co-authored-by: Name <email>` trailer in a commit
  message was invisible to the CLA check. Now: the PR submitter
  (`context.payload.pull_request.user`) is prepended to the committer set,
  and trailers are parsed out of every commit message. For noreply-form
  trailer emails (`<id>+<login>@users.noreply.github.com` and the legacy
  `<login>@users.noreply.github.com`) the login and numeric id are extracted
  directly. Non-noreply trailer emails route through the same unlinked-email
  warning block.
- **Dedicated "unlinked email" guidance on unknown committers.** When a commit
  author's email is not linked to any GitHub user, the bot now posts a
  prominent `> [!WARNING]` block that lists each unlinked email and gives the
  contributor two concrete remediation paths (link the email at
  `github.com/settings/emails`, or rewrite the commits with a known email
  using the exact git commands). Previously this case rendered as a terse
  aside on the main pending-signatures comment with generic "not a GitHub
  user" copy. The commit author's email is now carried through the GraphQL
  committers query and attached to `Committer.email` so the comment can
  surface the specific address that failed to match.


### Code-review pass (April 2026)

Driven by `PLAN.md` following a deep review. Seven phases:

**Bug fixes** ([`c5254b2`](../../commit/c5254b2)):
- Fixed a dead code path: `error.status === "404"` (string) vs `404` (number)
  meant `createClaFileAndPRComment` never ran. First-time users can now bootstrap
  a signatures file from scratch.
- `signatureComment.ts` no longer mutates the returned comment objects when
  stripping the `body` field.
- `prCommentSetup` now posts an "all signed" bot comment when there is no prior
  bot comment and every committer is already signed (previously a silent no-op).
- Fixed broken Markdown in the "signed" list: `(name)[url]` → `[name](url)`.
- `checkAllowList.ts`: renamed inverted `isUserNotInAllowList` to
  `isUserAllowListed`, removed the dead `!== undefined` guard.
- Replaced `console.debug` with `core.debug` in `pullRerunRunner.ts`.
- Dropped the `.replace(/ /g, '')` whitespace strip on the GraphQL query.

**Type cleanup** ([`142d247`](../../commit/142d247)):
- Removed `noImplicitAny: false` and `useUnknownInCatchVariables: false` from
  `tsconfig.json`. Fixed fallout (implicit-any parameters, catch narrowing).
- Introduced `ClaFileContent` / `Signature` interfaces; deleted unused
  `CommentedCommitterMap`, `LabelName`, `CommittersCommentDetails`.
- Added `src/shared/errors.ts` with `errorMessage(err)` / `errorStatus(err)`
  helpers for safer catch handling.

**TypeScript 5 upgrade** ([`16fefb1`](../../commit/16fefb1)):
- `typescript` `^4.9.4` → `^5.7.x`, `@types/jest` `^29` → `^30`.
- Enabled `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.

**Structural refactors** ([`d5854d0`](../../commit/d5854d0)):
- Lazy `octokit` factory that validates tokens on first use and has no
  import-time side effects. Exports an `Octokit` type alias so callers no
  longer reach into `@actions/github/lib/utils` (a private subpath).
- Four boolean inputs (`use-dco-flag`, `lock-pullrequest-aftermerge`,
  `empty-commit-flag`, `suggest-recheck`) now return real `boolean`s via a
  shared `getBooleanInput()` helper; removed the scattered `'true' / 'false'`
  string comparisons.
- `persistence.ts`: extracted `resolveSignaturesTarget()` helper to collapse
  three copy-paste bodies into one.

**Template consolidation** ([`7e3e83b`](../../commit/7e3e83b)):
- `pullRequestCommentContent.ts` `cla()` and `dco()` collapsed into a single
  parameterized renderer (104 LOC → ~85). Fixed asymmetric
  `****DCO Assistant Lite bot****` (4 asterisks) vs `**CLA Assistant Lite bot**`
  (2 asterisks).

**Pagination** ([`cac6d84`](../../commit/cac6d84)):
- `listComments` / `getComment` use `octokit.paginate`, so PRs with >30
  comments no longer silently drop signatures.
- `graphql.ts` commits query follows `pageInfo.hasNextPage` for PRs with >100
  commits.
- `listWorkflowRuns` bumped to `per_page=100` (still reads only the newest run).

**Tooling & residual cleanup** (this commit):
- Added Prettier (`^3`) with the existing `.prettierrc.json`; added
  `format` / `format:check` scripts. Formatted the repo.
- Deleted the orphaned `src/addEmptyCommit.ts` module, its test, and the
  `empty-commit-flag` input / `getEmptyCommitFlag` wrapper — no caller in `src/`
  or `action.yml`.
- `persistence.updateFile` no longer mutates the caller's `claFileContent`;
  returns `Promise<void>` and builds a fresh object.
- Normalised `lockPullRequest` logging to a single post-success / post-failure
  line.
- Deleted a stale `__tests__/testHelpers/env.js` that was shadowing the `.ts`.



### Added
- **Unit + integration test harness.** ~60 new tests across three layers:
  pure-logic units for `checkAllowList`, `getInputs`, `commentContent`, and
  `getPrSignComment`; per-module HTTP-level tests for `persistence`,
  `pullRequestComment`, `pullRequestLock`, `addEmptyCommit`, and
  `pullRerunRunner` using an `undici` `MockAgent`; six end-to-end scenarios
  driven by an in-memory `FakeGitHub` that covers unsigned-PR, sign-via-comment,
  already-signed, allow-listed bot, merged-PR lock, and remote-signatures-repo
  flows. ([`482990d`](../../commit/482990d))
- **Bundle smoke test.** Spawns `dist/index.js` as a subprocess against a real
  `http.Server`-backed fake for three end-to-end scenarios, catching any
  regression in how `ncc` bundles the action. ([`6210ee4`](../../commit/6210ee4))
- **Pre- vs post-refactor regression test.** Runs the pre-refactor `dist/index.js`
  (extracted from commit `eeb7f3f`) and the current `dist/index.js` against the
  same HTTP fake, asserts the set of recorded calls is identical across the
  three smoke scenarios. ([`8241668`](../../commit/8241668))

### Changed
- **Upgraded `@actions/github` from `^4.0.0` to `^6.0.1`** to silence two
  Node.js deprecation warnings — `DEP0169` (`url.parse()` in the bundled
  `@actions/http-client@1.x`) and `DEP0040` (`punycode` reached via
  `@octokit/request@5.x` → `node-fetch@2` → `whatwg-url@5` → `tr46@0`). v6
  pulls in `@actions/http-client@2.x` (WHATWG URL) and `@octokit/request@8.x`
  (uses `undici`). The v6 REST surface moved from `octokit.<resource>` to
  `octokit.rest.<resource>`, and Octokit response types are stricter, so all
  call sites in `addEmptyCommit.ts`, `persistence.ts`,
  `pullrequest/pullRequestComment.ts`, `pullrequest/pullRequestLock.ts`,
  `pullrequest/signatureComment.ts`, and `pullRerunRunner.ts` were updated,
  along with optional-chaining/non-null-assertion fixes where the new types
  required them. ([`7f32052`](../../commit/7f32052))
- **Bumped `@actions/core` `1.10.0` → `1.11.1`** and
  **`@types/node` `^18.x` → `^20.x`** (aligns with the Node 20+ runtime).
  ([`083debb`](../../commit/083debb))
- **Upgraded `husky` `4` → `9`.** Migrated the pre-commit hook from the
  legacy `husky` block in `package.json` to a `.husky/pre-commit` script, as
  required by husky 9, and moved the dep from `dependencies` to
  `devDependencies`. ([`ecdea08`](../../commit/ecdea08))
- **Added `@types/jest`** (`^29.x`, compatible with the current TypeScript
  `^4.9`) to restore compilation of the test suite, which had been silently
  failing. ([`7f32052`](../../commit/7f32052))
- **`src/main.ts`** skips its import-time `run()` invocation under
  `NODE_ENV=test` so the test harness can drive `run()` explicitly without
  double-invoking the action. ([`482990d`](../../commit/482990d))

### Removed
- **Dropped unused dependencies** `@octokit/rest`, `@octokit/types`,
  `actions-toolkit`, and `node-fetch`. None of these were imported from
  `src/` or the original test files; they were residue from an earlier shape
  of the action. ([`ecdea08`](../../commit/ecdea08))
- **Replaced `lodash` with a one-line inline `escapeRegExp`** helper in
  `checkAllowList.ts` — the only call site — and removed the dependency. This
  shrank the bundled `dist/index.js` from roughly 1.7 MB to 1.2 MB.
  ([`ecdea08`](../../commit/ecdea08))
- **Deleted `__tests__/pullRequestLock.test.ts`** which contained no
  tests — only a stale import block and a commented-out declaration.
  ([`7f32052`](../../commit/7f32052))

### Fixed
- **False-failure when all contributors have signed** — the action previously
  reported failure in this edge case. ([`eeb7f3f`](../../commit/eeb7f3f))
- **`__tests__/main.test.ts`** now compiles and runs: corrected import paths
  (`checkcla` → `setupClaCheck`, `pullRequestLock` →
  `pullrequest/pullRequestLock`), replaced the removed `ts-jest/utils`
  `mocked` helper with the built-in `jest.mocked`, and mocked `core.getInput`
  so the "merged PR" tests actually exercise the `lockPullRequest` branch.
  ([`7f32052`](../../commit/7f32052))

### Infrastructure
- **Bumped the GitHub Actions runtime to `node24`** in `action.yml`.
  ([`b3e568c`](../../commit/b3e568c))
- **Updated README** to reflect this fork's status and scope.
  ([`58daaf8`](../../commit/58daaf8))
