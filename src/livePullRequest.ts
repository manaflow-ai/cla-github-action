import { context } from '@actions/github'
import { octokit } from './octokit'
import { getRequiredBaseRef } from './shared/getInputs'

export interface LivePullRequestSnapshot {
  headSha: string
  baseRef: string
  baseRepository: string
  opener: { id: number; login: string }
}

const OPEN_PULL_REQUEST_TARGET_ACTIONS = new Set([
  'opened',
  'edited',
  'reopened',
  'synchronize'
])

/**
 * Read the Pull Request from GitHub immediately before signature work. Event
 * payloads can become stale after a force-push or retarget. Both the live PR
 * and the triggering event must describe the same open PR in this repository.
 */
export async function validateLivePullRequest(
  expected?: LivePullRequestSnapshot
): Promise<LivePullRequestSnapshot> {
  const repository = `${context.repo.owner}/${context.repo.repo}`
  validateEvent(repository)

  const response = await octokit.rest.pulls.get({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: context.issue.number
  })
  const pullRequest = response.data
  const liveRepository = pullRequest.base.repo?.full_name
  const requiredBaseRef = getRequiredBaseRef()
  const opener = pullRequest.user

  if (pullRequest.state !== 'open') {
    throw new Error(
      'Live Pull Request is not open; refusing a CLA signature write'
    )
  }
  if (liveRepository?.toLowerCase() !== repository.toLowerCase()) {
    throw new Error(
      `Live Pull Request base repository is not ${repository}; refusing a CLA signature write`
    )
  }
  if (pullRequest.base.ref !== requiredBaseRef) {
    throw new Error(
      `Live Pull Request base branch is '${pullRequest.base.ref}', not '${requiredBaseRef}'; refusing a CLA signature write`
    )
  }
  if (
    !opener ||
    !Number.isSafeInteger(opener.id) ||
    opener.id <= 0 ||
    !opener.login?.trim()
  ) {
    throw new Error(
      'Live Pull Request opener has no verified GitHub identity; refusing a CLA signature write'
    )
  }

  const snapshot: LivePullRequestSnapshot = {
    headSha: pullRequest.head.sha,
    baseRef: pullRequest.base.ref,
    baseRepository: liveRepository,
    opener: { id: opener.id, login: opener.login }
  }
  if (
    expected &&
    (snapshot.headSha !== expected.headSha ||
      snapshot.baseRef !== expected.baseRef ||
      snapshot.baseRepository.toLowerCase() !==
        expected.baseRepository.toLowerCase() ||
      snapshot.opener.id !== expected.opener.id ||
      snapshot.opener.login.toLowerCase() !==
        expected.opener.login.toLowerCase())
  ) {
    throw new Error(
      'Live Pull Request identity changed during the CLA check; refusing a CLA signature write'
    )
  }

  validatePayloadAgainstLive(snapshot, repository)
  return snapshot
}

function validateEvent(repository: string): void {
  const payloadRepository = context.payload.repository?.full_name
  if (
    typeof payloadRepository !== 'string' ||
    payloadRepository.toLowerCase() !== repository.toLowerCase()
  ) {
    throw new Error(
      `Event repository does not match ${repository}; refusing CLA processing`
    )
  }

  if (context.eventName === 'issue_comment') {
    const issue = context.payload.issue
    if (
      context.payload.action !== 'created' ||
      !issue?.pull_request ||
      issue.number !== context.issue.number ||
      issue.state !== 'open'
    ) {
      throw new Error(
        'issue_comment event is not a new comment on this open Pull Request'
      )
    }
    return
  }

  if (context.eventName === 'pull_request_target') {
    const pullRequest = context.payload.pull_request
    if (
      !OPEN_PULL_REQUEST_TARGET_ACTIONS.has(context.payload.action || '') ||
      !pullRequest ||
      pullRequest.number !== context.issue.number ||
      pullRequest.state !== 'open'
    ) {
      throw new Error(
        'pull_request_target event is not an allowed transition for this open Pull Request'
      )
    }
    return
  }

  throw new Error(
    `Event '${context.eventName}' is not allowed to write CLA signatures`
  )
}

function validatePayloadAgainstLive(
  live: LivePullRequestSnapshot,
  repository: string
): void {
  if (context.eventName !== 'pull_request_target') return
  const pullRequest = context.payload.pull_request
  if (
    pullRequest?.head?.sha !== live.headSha ||
    pullRequest.base?.ref !== live.baseRef ||
    pullRequest.base.repo?.full_name?.toLowerCase() !== repository.toLowerCase()
  ) {
    throw new Error(
      'pull_request_target payload does not match the live Pull Request identity'
    )
  }
}
