import {
  captureJson,
  installMockAgent,
  MockAgentHarness
} from '../testHelpers/mockAgent'
import { resetEnv, setDefaultInputs, setInput } from '../testHelpers/env'
import { reloadOctokit, setContext } from '../testHelpers/context'

const modulePath = require.resolve('../../src/pullRerunRunner')
function loadModule() {
  reloadOctokit()
  delete require.cache[modulePath]
  return require('../../src/pullRerunRunner') as typeof import('../../src/pullRerunRunner')
}

function json(
  http: MockAgentHarness,
  method: string,
  path: string,
  body: any,
  status = 200
) {
  http
    .github()
    .intercept({ path, method })
    .reply(status, body, { headers: { 'content-type': 'application/json' } })
}

describe('reRunLastWorkFlowIfRequired', () => {
  let http: MockAgentHarness

  beforeEach(() => {
    setDefaultInputs()
    http = installMockAgent()
  })
  afterEach(async () => {
    await http.close()
    resetEnv()
  })

  it('no-ops for pull_request events', async () => {
    setContext({ eventName: 'pull_request' })
    const { reRunLastWorkFlowIfRequired } = loadModule()
    await reRunLastWorkFlowIfRequired()
    http.assertClean()
  })

  it('no-ops for pull_request_target events', async () => {
    setContext({ eventName: 'pull_request_target' })
    const { reRunLastWorkFlowIfRequired } = loadModule()
    await reRunLastWorkFlowIfRequired()
    http.assertClean()
  })

  it('makes no API request for issue_comment when rerun-workflow is false', async () => {
    setContext({ eventName: 'issue_comment', issueNumber: 9, payload: {} })
    setInput('rerun-workflow', 'false')
    const { reRunLastWorkFlowIfRequired } = loadModule()
    await reRunLastWorkFlowIfRequired()
    http.assertClean()
  })

  it('for issue_comment: locates the workflow, finds the last run, and reruns it if failed', async () => {
    setInput('rerun-workflow', 'true')
    setContext({ eventName: 'issue_comment', issueNumber: 9, payload: {} })
    // @ts-ignore — workflow name is read from context
    require('@actions/github').context.workflow = 'cla-check'

    json(http, 'GET', '/repos/acme/widgets/pulls/9', {
      head: { ref: 'feature/cla', sha: 'headsha' }
    })
    json(
      http,
      'GET',
      '/repos/acme/widgets/actions/workflows?per_page=30&page=1',
      {
        total_count: 1,
        workflows: [{ id: 12345, name: 'cla-check' }]
      }
    )
    http
      .github()
      .intercept({
        path: /\/repos\/acme\/widgets\/actions\/workflows\/12345\/runs\?.*/,
        method: 'GET'
      })
      .reply(
        200,
        {
          total_count: 1,
          workflow_runs: [
            {
              id: 777,
              conclusion: 'failure',
              head_sha: 'headsha',
              event: 'pull_request_target',
              pull_requests: [{ number: 9 }]
            }
          ]
        },
        { headers: { 'content-type': 'application/json' } }
      )
    json(http, 'GET', '/repos/acme/widgets/actions/runs/777', {
      conclusion: 'failure'
    })
    const rerun = captureJson(
      http.github(),
      { path: '/repos/acme/widgets/actions/runs/777/rerun', method: 'POST' },
      { status: 201, body: '' }
    )

    const { reRunLastWorkFlowIfRequired } = loadModule()
    await reRunLastWorkFlowIfRequired()
    expect(rerun.rawBody === undefined || rerun.rawBody === '').toBe(true)
    http.assertClean()
  })

  it('does not rerun when the last workflow conclusion is success', async () => {
    setInput('rerun-workflow', 'true')
    setContext({ eventName: 'issue_comment', issueNumber: 9, payload: {} })
    // @ts-ignore
    require('@actions/github').context.workflow = 'cla-check'

    json(http, 'GET', '/repos/acme/widgets/pulls/9', {
      head: { ref: 'feature/cla', sha: 'headsha' }
    })
    json(
      http,
      'GET',
      '/repos/acme/widgets/actions/workflows?per_page=30&page=1',
      {
        total_count: 1,
        workflows: [{ id: 12345, name: 'cla-check' }]
      }
    )
    http
      .github()
      .intercept({
        path: /\/repos\/acme\/widgets\/actions\/workflows\/12345\/runs\?.*/,
        method: 'GET'
      })
      .reply(
        200,
        {
          total_count: 1,
          workflow_runs: [
            {
              id: 777,
              conclusion: 'success',
              head_sha: 'headsha',
              event: 'pull_request_target',
              pull_requests: [{ number: 9 }]
            }
          ]
        },
        { headers: { 'content-type': 'application/json' } }
      )
    json(http, 'GET', '/repos/acme/widgets/actions/runs/777', {
      conclusion: 'success'
    })

    const { reRunLastWorkFlowIfRequired } = loadModule()
    await reRunLastWorkFlowIfRequired()
    http.assertClean()
  })

  it('does not rerun a same-branch workflow run for a different PR or head SHA', async () => {
    setInput('rerun-workflow', 'true')
    setContext({ eventName: 'issue_comment', issueNumber: 9, payload: {} })
    // @ts-ignore
    require('@actions/github').context.workflow = 'cla-check'

    json(http, 'GET', '/repos/acme/widgets/pulls/9', {
      head: { ref: 'feature/cla', sha: 'current-head' }
    })
    json(
      http,
      'GET',
      '/repos/acme/widgets/actions/workflows?per_page=30&page=1',
      {
        total_count: 1,
        workflows: [{ id: 12345, name: 'cla-check' }]
      }
    )
    http
      .github()
      .intercept({
        path: /\/repos\/acme\/widgets\/actions\/workflows\/12345\/runs\?.*/,
        method: 'GET'
      })
      .reply(
        200,
        {
          total_count: 1,
          workflow_runs: [
            {
              id: 777,
              conclusion: 'failure',
              head_sha: 'other-head',
              event: 'pull_request_target',
              pull_requests: [{ number: 44 }]
            }
          ]
        },
        { headers: { 'content-type': 'application/json' } }
      )

    const { reRunLastWorkFlowIfRequired } = loadModule()
    await reRunLastWorkFlowIfRequired()
    http.assertClean()
  })

  it('reruns an exact timed-out workflow run when explicitly enabled', async () => {
    setInput('rerun-workflow', 'true')
    setContext({ eventName: 'issue_comment', issueNumber: 9, payload: {} })
    // @ts-ignore
    require('@actions/github').context.workflow = 'cla-check'

    json(http, 'GET', '/repos/acme/widgets/pulls/9', {
      head: { ref: 'feature/cla', sha: 'headsha' }
    })
    json(
      http,
      'GET',
      '/repos/acme/widgets/actions/workflows?per_page=30&page=1',
      {
        total_count: 1,
        workflows: [{ id: 12345, name: 'cla-check' }]
      }
    )
    http
      .github()
      .intercept({
        path: /\/repos\/acme\/widgets\/actions\/workflows\/12345\/runs\?.*/,
        method: 'GET'
      })
      .reply(
        200,
        {
          total_count: 1,
          workflow_runs: [
            {
              id: 778,
              conclusion: 'timed_out',
              head_sha: 'headsha',
              event: 'pull_request_target',
              pull_requests: [{ number: 9 }]
            }
          ]
        },
        { headers: { 'content-type': 'application/json' } }
      )
    json(http, 'GET', '/repos/acme/widgets/actions/runs/778', {
      conclusion: 'timed_out'
    })
    const rerun = captureJson(
      http.github(),
      { path: '/repos/acme/widgets/actions/runs/778/rerun', method: 'POST' },
      { status: 201, body: '' }
    )

    const { reRunLastWorkFlowIfRequired } = loadModule()
    await reRunLastWorkFlowIfRequired()
    expect(rerun.rawBody === undefined || rerun.rawBody === '').toBe(true)
    http.assertClean()
  })
})
