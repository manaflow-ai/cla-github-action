import * as core from '@actions/core'
import { context } from '@actions/github'
import {
  checkAllowList,
  isPullRequestOpenerAllowlisted
} from './checkAllowList'
import getCommitters from './graphql'
import {
  ClaFileContent,
  ClafileContentAndSha,
  CommitterMap,
  Committer,
  Signature
} from './interfaces'
import {
  createFile,
  getFileContent,
  updateFile
} from './persistence/persistence'
import prCommentSetup, {
  preparePrComment
} from './pullrequest/pullRequestComment'
import { errorMessage, errorStatus } from './shared/errors'
import {
  getExpectedSigningComment,
  requireOpenerAsAuthor
} from './shared/getInputs'
import type { ExpectedSigningComment } from './shared/getInputs'
import {
  LivePullRequestSnapshot,
  validateLivePullRequest
} from './livePullRequest'
import {
  findOpenerAuthorshipMismatch,
  includePullRequestOpener,
  openerAuthorshipMismatchMessage
} from './shared/committers'
import {
  MAX_LEDGER_BYTES,
  MAX_LEDGER_CREATE_RECOVERY_ATTEMPTS,
  MAX_LEDGER_SIGNATURES
} from './shared/limits'
import {
  listBoundedPullRequestComments,
  PullRequestComment
} from './pullrequest/pullRequestComments'
import {
  validateExpectedSigningComment,
  validateExpectedSigningCommentLive,
  validateSigningCommentsUnchanged
} from './pullrequest/signingCommentSnapshot'

export async function setupClaCheck() {
  // A caller may use this output to authorize a follow-up check refresh. Keep
  // it false unless this run actually persists a newly accepted signature.
  core.setOutput('signature_recorded', false)
  // This is a final policy result, not a record of one signature. Keep it
  // false until the all-signed status has been applied successfully.
  core.setOutput('cla_passed', false)
  const expectedSigningComment = getExpectedSigningComment()
  const livePullRequest = await validateLivePullRequest()
  // Bound all contributor-controlled comments before any ledger or comment
  // write, then use the same snapshot throughout this action run.
  const pullRequestComments = await listBoundedPullRequestComments()
  validateExpectedSigningComment(expectedSigningComment, pullRequestComments)
  let committerMap = getInitialCommittersMap()

  const commitAuthors = await getCommitters(livePullRequest.headSha)
  const openerMismatch = detectOpenerMismatch(
    commitAuthors,
    livePullRequest.opener
  )
  let committers = includePullRequestOpener(
    commitAuthors,
    livePullRequest.opener,
    context.issue.number
  )
  committers = checkAllowList(committers)
  if (openerMismatch) {
    // The missing-ledger bootstrap path publishes the first bot comment before
    // this function returns. Carry the guard into that path so its first
    // diagnostic cannot omit the authenticated opener mismatch.
    committerMap.openerMismatch = openerMismatch
  }

  const claFile = await getCLAFileContentandSHA(
    committers,
    committerMap,
    livePullRequest,
    pullRequestComments,
    expectedSigningComment
  )
  // A missing ledger was created and no contributor remains after the
  // authenticated opener allowlist. The bootstrap path already published the
  // all-signed status, so no ledger update is required.
  if (!claFile) return
  const { claFileContent, sha } = claFile

  committerMap = prepareCommiterMap(committers, claFileContent) as CommitterMap
  if (openerMismatch) {
    committerMap.openerMismatch = openerMismatch
  }

  try {
    const commentPlan = await preparePrComment(
      committerMap,
      committers,
      pullRequestComments,
      true,
      expectedSigningComment?.id,
      () => validateExpectedSigningCommentLive(expectedSigningComment)
    )
    const reactedCommitters = commentPlan.reactedCommitters

    if (reactedCommitters?.newSigned.length) {
      /* pushing the recently signed  contributors to the CLA Json File */
      await validateSigningCommentsUnchanged(
        pullRequestComments,
        reactedCommitters.newSigned,
        expectedSigningComment
      )
      await validateLivePullRequest(livePullRequest)
      await updateFile(sha, claFileContent, reactedCommitters, async () => {
        await validateSigningCommentsUnchanged(
          pullRequestComments,
          reactedCommitters.newSigned,
          expectedSigningComment
        )
        await validateLivePullRequest(livePullRequest)
      })
      core.setOutput('signature_recorded', true)
    }
    if (
      reactedCommitters?.allSignedFlag ||
      committerMap?.notSigned === undefined ||
      committerMap.notSigned.length === 0
    ) {
      // A force-push or retarget can happen while commit identities and PR
      // comments are read. Revalidate even when no ledger write is needed so
      // the action cannot report success from a stale snapshot.
      await validateLivePullRequest(livePullRequest)
      // Publish an all-signed status only after any new signatures are
      // revalidated and persisted. A rejected comment leaves the last trusted
      // bot status unchanged.
      await commentPlan.apply()
      if (openerMismatch?.hardFail) {
        core.setFailed(openerMismatchError(openerMismatch))
        return
      }
      core.setOutput('cla_passed', true)
      core.info(`All contributors have signed the CLA 📝 ✅ `)
      return
    } else {
      await commentPlan.apply()
      core.setFailed(
        `Committers of Pull Request number ${context.issue.number} have to sign the CLA 📝`
      )
    }
  } catch (err) {
    core.setFailed(`Could not complete the CLA check: ${errorMessage(err)}`)
  }
}

async function getCLAFileContentandSHA(
  committers: Committer[],
  committerMap: CommitterMap,
  livePullRequest: LivePullRequestSnapshot,
  pullRequestComments: PullRequestComment[],
  expectedSigningComment?: ExpectedSigningComment
): Promise<void | ClafileContentAndSha> {
  let result
  try {
    result = await getFileContent()
  } catch (error) {
    if (errorStatus(error) === 404) {
      return createClaFileAndPRComment(
        committers,
        committerMap,
        livePullRequest,
        pullRequestComments,
        expectedSigningComment
      )
    } else {
      throw new Error(
        `Could not retrieve repository contents. Status: ${errorStatus(error) ?? 'unknown'}`
      )
    }
  }
  return parseClaFileResponse(result)
}

function parseClaFileResponse(result: any): ClafileContentAndSha {
  const sha = result?.data?.sha
  if (typeof sha !== 'string' || sha.length === 0) {
    throw new Error('Invalid CLA signature ledger: file SHA is missing')
  }
  if (typeof result?.data?.content !== 'string') {
    throw new Error('Invalid CLA signature ledger: file content is missing')
  }
  const claFileContentBuffer = Buffer.from(result.data.content, 'base64')
  if (claFileContentBuffer.byteLength > MAX_LEDGER_BYTES) {
    throw new Error(
      `Invalid CLA signature ledger: file is larger than ${MAX_LEDGER_BYTES} bytes`
    )
  }
  const claFileContent = parseClaFileContent(claFileContentBuffer.toString())
  return { claFileContent, sha }
}

function parseClaFileContent(raw: string): ClaFileContent {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Invalid CLA signature ledger: file is not valid JSON')
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray(
      (parsed as { signedContributors?: unknown }).signedContributors
    )
  ) {
    throw new Error(
      'Invalid CLA signature ledger: signedContributors must be an array'
    )
  }

  const signatures = (parsed as { signedContributors: unknown[] })
    .signedContributors
  if (signatures.length > MAX_LEDGER_SIGNATURES) {
    throw new Error(
      `Invalid CLA signature ledger: more than ${MAX_LEDGER_SIGNATURES} signatures`
    )
  }
  const byId = new Map<number, Signature>()
  for (const value of signatures) {
    if (!isValidSignature(value)) {
      throw new Error(
        'Invalid CLA signature ledger: every entry must have a non-empty name and positive numeric id'
      )
    }
    if (!byId.has(value.id)) byId.set(value.id, value)
  }
  if (byId.size !== signatures.length) {
    core.warning(
      'Duplicate CLA signature ledger entries were ignored by user ID.'
    )
  }
  return { signedContributors: [...byId.values()] }
}

function isValidSignature(value: unknown): value is Signature {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { name?: unknown; id?: unknown }
  return (
    typeof candidate.name === 'string' &&
    candidate.name.trim().length > 0 &&
    typeof candidate.id === 'number' &&
    Number.isSafeInteger(candidate.id) &&
    candidate.id > 0
  )
}

async function createClaFileAndPRComment(
  committers: Committer[],
  committerMap: CommitterMap,
  livePullRequest: LivePullRequestSnapshot,
  pullRequestComments: PullRequestComment[],
  expectedSigningComment?: ExpectedSigningComment
): Promise<void | ClafileContentAndSha> {
  committerMap.notSigned = committers
  committerMap.signed = []
  committers.map(committer => {
    if (!committer.id) {
      committerMap.unknown.push(committer)
    }
  })

  const initialContent = { signedContributors: [] }
  const initialContentString = JSON.stringify(initialContent, null, 3)
  const initialContentBinary =
    Buffer.from(initialContentString).toString('base64')

  await validateExpectedSigningCommentLive(expectedSigningComment)
  await validateLivePullRequest(livePullRequest)
  try {
    await createFile(initialContentBinary)
  } catch (error) {
    const recoveredLedger = await recoverConcurrentLedgerCreate(error)
    if (recoveredLedger) {
      // The other run won the create race. Continue through the normal
      // signature path so this run cannot publish all-signed until any new
      // declaration is validated and persisted in the confirmed ledger.
      await validateLivePullRequest(livePullRequest)
      await validateExpectedSigningCommentLive(expectedSigningComment)
      core.warning(
        'Another Pull Request created the CLA signature ledger concurrently. Continuing with the confirmed ledger.'
      )
      return recoveredLedger
    }
    throw new Error(
      `Error occurred when creating the signed contributors file: ${errorMessage(error)}. Ensure the configured trusted automation identity can write to the signature branch.`
    )
  }
  await validateLivePullRequest(livePullRequest)
  await validateExpectedSigningCommentLive(expectedSigningComment)
  // The first run creates an empty ledger. Keep existing declarations pending
  // until a later run can validate and persist them through the normal update
  // path. Never publish all-signed status for an empty new ledger.
  await prCommentSetup(
    committerMap,
    committers,
    pullRequestComments,
    false,
    undefined,
    () => validateExpectedSigningCommentLive(expectedSigningComment)
  )
  if (committerMap.openerMismatch?.hardFail) {
    throw new Error(openerMismatchError(committerMap.openerMismatch))
  }
  if (committers.length === 0) {
    // Bootstrap has already created the empty ledger and applied the
    // all-signed comment for an authenticated, allowlisted opener. Report a
    // pass only after that final comment write succeeded.
    core.setOutput('cla_passed', true)
    return
  }
  throw new Error(
    `Committers of pull request ${context.issue.number} have to sign the CLA`
  )
}

async function recoverConcurrentLedgerCreate(
  createError: unknown
): Promise<ClafileContentAndSha | undefined> {
  const status = errorStatus(createError)
  if (status !== 409 && status !== 422) return undefined

  for (
    let attempt = 0;
    attempt < MAX_LEDGER_CREATE_RECOVERY_ATTEMPTS;
    attempt += 1
  ) {
    let result
    try {
      result = await getFileContent()
    } catch (readError) {
      if (errorStatus(readError) === 404) continue
      throw new Error(
        `Could not verify the CLA signature ledger after a concurrent create. Status: ${errorStatus(readError) ?? 'unknown'}`
      )
    }
    return parseClaFileResponse(result)
  }

  return undefined
}

function prepareCommiterMap(
  committers: Committer[],
  claFileContent: ClaFileContent
): CommitterMap {
  let committerMap = getInitialCommittersMap()

  committerMap.notSigned = committers.filter(
    committer => !hasReusableStoredSignature(committer, claFileContent)
  )
  committerMap.signed = committers.filter(committer =>
    hasReusableStoredSignature(committer, claFileContent)
  )
  committers.map(committer => {
    if (!committer.id) {
      committerMap.unknown.push(committer)
    }
  })
  return committerMap
}

function hasReusableStoredSignature(
  committer: Committer,
  claFileContent: ClaFileContent
): boolean {
  if (
    committer.id <= 0 ||
    (committer.requiresCurrentSignature && !committer.isPullRequestOpener)
  )
    return false
  return claFileContent.signedContributors.some(cla => committer.id === cla.id)
}

const getInitialCommittersMap = (): CommitterMap => ({
  signed: [],
  notSigned: [],
  unknown: []
})

function openerMismatchError(
  mismatch: NonNullable<CommitterMap['openerMismatch']>
): string {
  return openerAuthorshipMismatchMessage(mismatch)
}

/**
 * Return {opener, commitAuthors, hardFail} if the PR opener is NOT recorded
 * as an author or co-author of any commit in the PR. Committer metadata does
 * not qualify because it is not independently authenticated. This is an
 * impersonation-adjacent signal: someone opening a PR whose commits are all
 * attributed to someone else. Undefined when the opener is in the trail or
 * when we cannot read the opener identity from the event payload.
 *
 * hardFail tracks the 'require-opener-as-author' input so callers can
 * decide whether to call setFailed vs just render a warning.
 */
function detectOpenerMismatch(
  commitAuthors: Committer[],
  opener: LivePullRequestSnapshot['opener']
): { opener: string; commitAuthors: string[]; hardFail: boolean } | undefined {
  const mismatch = findOpenerAuthorshipMismatch(commitAuthors, opener)
  if (!mismatch) return undefined
  core.setOutput('opener_not_in_commits', true)
  return {
    ...mismatch,
    hardFail: requireOpenerAsAuthor() && !isPullRequestOpenerAllowlisted(opener)
  }
}
