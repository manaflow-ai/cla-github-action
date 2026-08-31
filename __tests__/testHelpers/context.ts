import * as github from '@actions/github'

interface TestContext {
  owner: string
  repo: string
  issueNumber: number
  actor: string
  eventName: string
  workflow: string
  payload: any
}

const defaults: TestContext = {
  owner: 'acme',
  repo: 'widgets',
  issueNumber: 42,
  actor: 'alice',
  eventName: 'pull_request_target',
  workflow: 'cla-check',
  payload: {}
}

/** Overwrite the @actions/github context with test values. */
export function setContext(overrides: Partial<TestContext> = {}): TestContext {
  const ctx = { ...defaults, ...overrides }
  const payload = { ...ctx.payload }
  payload.repository = {
    id: 5555,
    full_name: `${ctx.owner}/${ctx.repo}`,
    ...(payload.repository || {})
  }
  if (ctx.eventName === 'pull_request_target' && payload.pull_request) {
    const pullRequest = payload.pull_request
    payload.pull_request = {
      number: ctx.issueNumber,
      state: 'open',
      ...pullRequest,
      head: { sha: 'headsha', ...(pullRequest.head || {}) },
      base: {
        ref: 'main',
        ...(pullRequest.base || {}),
        repo: {
          full_name: `${ctx.owner}/${ctx.repo}`,
          ...(pullRequest.base?.repo || {})
        }
      }
    }
  }
  if (ctx.eventName === 'issue_comment') {
    payload.issue = {
      number: ctx.issueNumber,
      state: 'open',
      pull_request: {},
      ...(payload.issue || {})
    }
  }
  // @ts-ignore — overwrite the readonly Context instance for test setup
  github.context = {
    repo: { owner: ctx.owner, repo: ctx.repo },
    issue: { owner: ctx.owner, repo: ctx.repo, number: ctx.issueNumber },
    actor: ctx.actor,
    eventName: ctx.eventName,
    workflow: ctx.workflow,
    payload
  }
  return { ...ctx, payload }
}

/** Drop the module cache for src/octokit.ts so a test-owned GITHUB_TOKEN is picked up. */
export function reloadOctokit(): void {
  const p = require.resolve('../../src/octokit')
  delete require.cache[p]
}
