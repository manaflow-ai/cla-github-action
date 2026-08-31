import { context } from '@actions/github'
import { octokit } from './octokit'
import { getRequiredBaseRef } from './shared/getInputs'

export interface LivePullRequestSnapshot {
  headSha: string
  headRef: string
  headRepository: string
  headRepositoryId: number
  baseRef: string
  baseRepository: string
  baseRepositoryId: number
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
  const repositoryId = validateEvent(repository)

  const response = await octokit.rest.pulls.get({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: context.issue.number
  })
  const pullRequest = response.data
  const liveRepository = pullRequest.base.repo?.full_name
  const liveRepositoryId = pullRequest.base.repo?.id
  const liveHeadRepository = pullRequest.head.repo?.full_name
  const liveHeadRepositoryId = pullRequest.head.repo?.id
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
  if (
    !Number.isSafeInteger(liveRepositoryId) ||
    liveRepositoryId !== repositoryId
  ) {
    throw new Error(
      'Live Pull Request base repository ID does not match the event repository; refusing a CLA signature write'
    )
  }
  if (pullRequest.base.ref !== requiredBaseRef) {
    throw new Error(
      `Live Pull Request base branch is '${pullRequest.base.ref}', not '${requiredBaseRef}'; refusing a CLA signature write`
    )
  }
  if (
    !pullRequest.head.sha?.trim() ||
    !pullRequest.head.ref?.trim() ||
    !liveHeadRepository?.trim() ||
    !Number.isSafeInteger(liveHeadRepositoryId) ||
    Number(liveHeadRepositoryId) <= 0
  ) {
    throw new Error(
      'Live Pull Request head has no complete repository identity; refusing a CLA signature write'
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
    headRef: pullRequest.head.ref,
    headRepository: liveHeadRepository,
    headRepositoryId: Number(liveHeadRepositoryId),
    baseRef: pullRequest.base.ref,
    baseRepository: liveRepository,
    baseRepositoryId: Number(liveRepositoryId),
    opener: { id: opener.id, login: opener.login }
  }
  if (
    expected &&
    (snapshot.headSha !== expected.headSha ||
      snapshot.headRef !== expected.headRef ||
      snapshot.headRepository.toLowerCase() !==
        expected.headRepository.toLowerCase() ||
      snapshot.headRepositoryId !== expected.headRepositoryId ||
      snapshot.baseRef !== expected.baseRef ||
      snapshot.baseRepository.toLowerCase() !==
        expected.baseRepository.toLowerCase() ||
      snapshot.baseRepositoryId !== expected.baseRepositoryId ||
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

function validateEvent(repository: string): number {
  const payloadRepository = context.payload.repository?.full_name
  const payloadRepositoryId = context.payload.repository?.id
  if (
    typeof payloadRepository !== 'string' ||
    payloadRepository.toLowerCase() !== repository.toLowerCase() ||
    !Number.isSafeInteger(payloadRepositoryId) ||
    Number(payloadRepositoryId) <= 0
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
    return Number(payloadRepositoryId)
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
    return Number(payloadRepositoryId)
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
    pullRequest.head.ref !== live.headRef ||
    pullRequest.head.repo?.full_name?.toLowerCase() !==
      live.headRepository.toLowerCase() ||
    pullRequest.head.repo?.id !== live.headRepositoryId ||
    pullRequest.base?.ref !== live.baseRef ||
    pullRequest.base.repo?.full_name?.toLowerCase() !==
      repository.toLowerCase() ||
    pullRequest.base.repo?.id !== live.baseRepositoryId
  ) {
    throw new Error(
      'pull_request_target payload does not match the live Pull Request identity'
    )
  }
}
