import * as core from '@actions/core'
import { context } from '@actions/github'
import { checkAllowList } from './checkAllowList'
import getCommitters from './graphql'
import {
  ClaFileContent,
  ClafileContentAndSha,
  CommitterMap,
  Committer,
  ReactedCommitterMap,
  Signature
} from './interfaces'
import {
  createFile,
  getFileContent,
  updateFile
} from './persistence/persistence'
import prCommentSetup from './pullrequest/pullRequestComment'
import { errorMessage, errorStatus } from './shared/errors'
import { requireOpenerAsAuthor } from './shared/getInputs'
import {
  LivePullRequestSnapshot,
  validateLivePullRequest
} from './livePullRequest'

export async function setupClaCheck() {
  const livePullRequest = await validateLivePullRequest()
  let committerMap = getInitialCommittersMap()

  const commitAuthors = await getCommitters()
  const openerMismatch = detectOpenerMismatch(
    commitAuthors,
    livePullRequest.opener
  )
  let committers = includePullRequestOpener(
    commitAuthors,
    livePullRequest.opener
  )
  committers = checkAllowList(committers)

  const { claFileContent, sha } = (await getCLAFileContentandSHA(
    committers,
    committerMap,
    livePullRequest
  )) as ClafileContentAndSha

  committerMap = prepareCommiterMap(committers, claFileContent) as CommitterMap
  if (openerMismatch) {
    committerMap.openerMismatch = openerMismatch
  }

  try {
    const reactedCommitters = (await prCommentSetup(
      committerMap,
      committers
    )) as ReactedCommitterMap

    if (reactedCommitters?.newSigned.length) {
      /* pushing the recently signed  contributors to the CLA Json File */
      await validateLivePullRequest(livePullRequest)
      await updateFile(sha, claFileContent, reactedCommitters)
    }
    if (
      reactedCommitters?.allSignedFlag ||
      committerMap?.notSigned === undefined ||
      committerMap.notSigned.length === 0
    ) {
      core.info(`All contributors have signed the CLA 📝 ✅ `)
      if (openerMismatch?.hardFail) {
        core.setFailed(
          `Pull Request opener @${openerMismatch.opener} is not recorded as an author, co-author, or committer of any commit in this PR. If this is intentional (e.g. a cherry-pick or release-engineering workflow), set the 'require-opener-as-author' action input to 'false'.`
        )
        return
      }
      return
    } else {
      core.setFailed(
        `Committers of Pull Request number ${context.issue.number} have to sign the CLA 📝`
      )
    }
  } catch (err) {
    core.setFailed(`Could not update the JSON file: ${errorMessage(err)}`)
  }
}

async function getCLAFileContentandSHA(
  committers: Committer[],
  committerMap: CommitterMap,
  livePullRequest: LivePullRequestSnapshot
): Promise<void | ClafileContentAndSha> {
  let result, claFileContentString, claFileContent, sha
  try {
    result = await getFileContent()
  } catch (error) {
    if (errorStatus(error) === 404) {
      return createClaFileAndPRComment(
        committers,
        committerMap,
        livePullRequest
      )
    } else {
      throw new Error(
        `Could not retrieve repository contents. Status: ${errorStatus(error) ?? 'unknown'}`
      )
    }
  }
  sha = result?.data?.sha
  claFileContentString = Buffer.from(result.data.content, 'base64').toString()
  claFileContent = parseClaFileContent(claFileContentString)
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
  livePullRequest: LivePullRequestSnapshot
): Promise<void> {
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

  await validateLivePullRequest(livePullRequest)
  await createFile(initialContentBinary).catch((error: unknown) =>
    core.setFailed(
      `Error occurred when creating the signed contributors file: ${errorMessage(error)}. Make sure the branch where signatures are stored is NOT protected.`
    )
  )
  await prCommentSetup(committerMap, committers)
  throw new Error(
    `Committers of pull request ${context.issue.number} have to sign the CLA`
  )
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
  if (committer.id <= 0 || committer.requiresCurrentSignature) return false
  return claFileContent.signedContributors.some(cla => committer.id === cla.id)
}

const getInitialCommittersMap = (): CommitterMap => ({
  signed: [],
  notSigned: [],
  unknown: []
})

/**
 * Prepend the PR opener to the committer set if they are not already present
 * via a commit or Co-authored-by trailer. The PR submitter is a contributor
 * to the merge in their own right and must sign the CLA, even if every commit
 * was authored by someone else.
 */
function includePullRequestOpener(
  committers: Committer[],
  opener: LivePullRequestSnapshot['opener']
): Committer[] {
  if (committers.some(c => c.id === opener.id)) return committers
  return [
    {
      name: opener.login,
      id: opener.id,
      pullRequestNo: context.issue.number
    },
    ...committers
  ]
}

/**
 * Return {opener, commitAuthors, hardFail} if the PR opener is NOT recorded
 * as an author, co-author, or committer of any commit in the PR. This is an
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
  if (commitAuthors.some(c => c.id === opener.id)) return undefined
  core.setOutput('opener_not_in_commits', true)
  return {
    opener: opener.login,
    commitAuthors: commitAuthors.map(c => c.name).filter(n => n.length > 0),
    hardFail: requireOpenerAsAuthor()
  }
}
