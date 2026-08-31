import { context } from '@actions/github'

import { ClaFileContent, ReactedCommitterMap } from '../interfaces'
import { Octokit, getDefaultOctokitClient, getPATOctokit } from '../octokit'

import * as input from '../shared/getInputs'
import {
  MAX_LEDGER_BYTES,
  MAX_LEDGER_SIGNATURES,
  MAX_LEDGER_WRITE_ATTEMPTS
} from '../shared/limits'

interface SignaturesTarget {
  octokit: Octokit
  owner: string
  repo: string
  path: string
  branch: string
}

function resolveSignaturesTarget(): SignaturesTarget {
  const remote = Boolean(input.getRemoteRepoName() || input.getRemoteOrgName())
  return {
    octokit: remote ? getPATOctokit() : getDefaultOctokitClient(),
    owner: input.getRemoteOrgName() || context.repo.owner,
    repo: input.getRemoteRepoName() || context.repo.repo,
    path: input.getPathToSignatures(),
    branch: input.getBranch()
  }
}

export async function getFileContent(): Promise<any> {
  const t = resolveSignaturesTarget()
  return t.octokit.rest.repos.getContent({
    owner: t.owner,
    repo: t.repo,
    path: t.path,
    ref: t.branch
  })
}

export async function createFile(contentBinary: string): Promise<any> {
  const t = resolveSignaturesTarget()
  return t.octokit.rest.repos.createOrUpdateFileContents({
    owner: t.owner,
    repo: t.repo,
    path: t.path,
    message:
      input.getCreateFileCommitMessage() ||
      'Creating file for storing CLA Signatures',
    content: contentBinary,
    branch: t.branch
  })
}

export async function updateFile(
  sha: string,
  claFileContent: ClaFileContent,
  reactedCommitters: ReactedCommitterMap
): Promise<void> {
  const t = resolveSignaturesTarget()
  const pullRequestNo = context.issue.number
  let currentSha = sha
  let currentContent = claFileContent

  // The ledger is shared by all Pull Requests. Per-PR workflow concurrency
  // prevents duplicate work for one PR, while this bounded optimistic retry
  // merges another PR's commit when two independent writers race.
  for (let attempt = 0; attempt < MAX_LEDGER_WRITE_ATTEMPTS; attempt += 1) {
    const updated: ClaFileContent = {
      signedContributors: dedupeSignatures([
        ...currentContent.signedContributors,
        ...reactedCommitters.newSigned
      ])
    }
    const serialized = JSON.stringify(updated, null, 2)
    if (Buffer.byteLength(serialized) > MAX_LEDGER_BYTES) {
      throw new Error(
        `Cannot persist a CLA signature ledger larger than ${MAX_LEDGER_BYTES} bytes`
      )
    }
    const contentBinary = Buffer.from(serialized).toString('base64')

    try {
      await t.octokit.rest.repos.createOrUpdateFileContents({
        owner: t.owner,
        repo: t.repo,
        path: t.path,
        sha: currentSha,
        message: buildSignedCommitMessage(pullRequestNo),
        content: contentBinary,
        branch: t.branch
      })
      return
    } catch (error) {
      if (
        !isContentsConflict(error) ||
        attempt + 1 >= MAX_LEDGER_WRITE_ATTEMPTS
      ) {
        throw error
      }
      const latest = parseLedgerSnapshot(await getFileContent())
      currentSha = latest.sha
      currentContent = latest.content
    }
  }

  throw new Error(
    'Could not persist the CLA signature ledger after bounded retries'
  )
}

interface LedgerSnapshot {
  sha: string
  content: ClaFileContent
}

function parseLedgerSnapshot(response: any): LedgerSnapshot {
  const data = response?.data
  if (
    !data ||
    Array.isArray(data) ||
    typeof data.sha !== 'string' ||
    data.sha.length === 0 ||
    typeof data.content !== 'string'
  ) {
    throw new Error('Invalid CLA signature ledger response')
  }

  const raw = Buffer.from(data.content, 'base64')
  if (raw.byteLength > MAX_LEDGER_BYTES) {
    throw new Error(
      `Invalid CLA signature ledger: file is larger than ${MAX_LEDGER_BYTES} bytes`
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString())
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
  return {
    sha: data.sha,
    content: {
      signedContributors: dedupeSignatures(signatures)
    }
  }
}

function isContentsConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { status?: unknown }).status === 409
  )
}

function dedupeSignatures(
  signatures: Array<unknown>
): ClaFileContent['signedContributors'] {
  const seen = new Set<number>()
  const deduped = signatures.filter(
    (signature): signature is ClaFileContent['signedContributors'][number] => {
      if (!isValidSignature(signature)) {
        throw new Error(
          'Cannot persist a CLA signature without a non-empty name and valid user ID'
        )
      }
      if (seen.has(signature.id)) return false
      seen.add(signature.id)
      return true
    }
  )
  if (deduped.length > MAX_LEDGER_SIGNATURES) {
    throw new Error(
      `Cannot persist more than ${MAX_LEDGER_SIGNATURES} CLA signatures in one ledger`
    )
  }
  return deduped
}

function isValidSignature(
  value: unknown
): value is ClaFileContent['signedContributors'][number] {
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

function buildSignedCommitMessage(pullRequestNo: number): string {
  const template = input.getSignedCommitMessage()
  const owner = context.issue.owner
  const repo = context.issue.repo
  if (!template) {
    return `@${context.actor} has signed the CLA in ${owner}/${repo}#${pullRequestNo}`
  }
  return template
    .replace('$contributorName', context.actor)
    .replace('$pullRequestNo', pullRequestNo.toString())
    .replace('$owner', owner)
    .replace('$repo', repo)
}
