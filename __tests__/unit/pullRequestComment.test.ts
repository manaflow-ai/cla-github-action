import {
  captureJson,
  installMockAgent,
  MockAgentHarness
} from '../testHelpers/mockAgent'
import { resetEnv, setDefaultInputs } from '../testHelpers/env'
import { reloadOctokit, setContext } from '../testHelpers/context'

const modulePath = require.resolve('../../src/pullrequest/pullRequestComment')
function loadModule() {
  reloadOctokit()
  delete require.cache[modulePath]
  return require('../../src/pullrequest/pullRequestComment').default as (
    committerMap: any,
    committers: any
  ) => Promise<any>
}

function listCommentsInterceptor(
  http: MockAgentHarness,
  body: any[],
  times: number = 1
) {
  http
    .github()
    .intercept({
      path: /\/repos\/acme\/widgets\/issues\/42\/comments(\?.*)?$/,
      method: 'GET'
    })
    .reply(200, body, { headers: { 'content-type': 'application/json' } })
    .times(times)
}

function canonicalBotInterceptor(http: MockAgentHarness) {
  http
    .github()
    .intercept({
      path: /\/users\/github-actions(?:%5B|\[)bot(?:%5D|\])$/i,
      method: 'GET'
    })
    .reply(
      200,
      { login: 'github-actions[bot]', id: 41898282, type: 'Bot' },
      { headers: { 'content-type': 'application/json' } }
    )
}

describe('prCommentSetup', () => {
  let http: MockAgentHarness

  beforeEach(() => {
    setDefaultInputs()
    http = installMockAgent()
    setContext({ issueNumber: 42, payload: { repository: { id: 5555 } } })
  })

  afterEach(async () => {
    await http.close()
    resetEnv()
  })

  it('creates a new CLA comment when no prior bot comment exists and unsigned committers remain', async () => {
    listCommentsInterceptor(http, [])
    const captured = captureJson(
      http.github(),
      { path: '/repos/acme/widgets/issues/42/comments', method: 'POST' },
      { status: 201, body: { id: 999 } }
    )

    const prCommentSetup = loadModule()
    await prCommentSetup(
      {
        signed: [{ name: 'alice', id: 1, pullRequestNo: 42 }],
        notSigned: [{ name: 'bob', id: 2, pullRequestNo: 42 }],
        unknown: []
      },
      [
        { name: 'alice', id: 1, pullRequestNo: 42 },
        { name: 'bob', id: 2, pullRequestNo: 42 }
      ]
    )

    expect(captured.body.body).toContain('CLA Assistant Lite bot')
    expect(captured.body.body).toContain(':x: @bob')
    expect(captured.body.body).toContain(
      ':white_check_mark: [alice](https://github.com/alice)'
    )
    http.assertClean()
  })

  it('posts an all-signed comment when there is no prior bot comment and everyone is already signed', async () => {
    listCommentsInterceptor(http, [])
    const captured = captureJson(
      http.github(),
      { path: '/repos/acme/widgets/issues/42/comments', method: 'POST' },
      { status: 201, body: { id: 999 } }
    )

    const prCommentSetup = loadModule()
    await prCommentSetup(
      {
        signed: [{ name: 'alice', id: 1, pullRequestNo: 42 }],
        notSigned: [],
        unknown: []
      },
      [{ name: 'alice', id: 1, pullRequestNo: 42 }]
    )
    expect(captured.body.body).toMatch(/all contributors have signed the cla/i)
    http.assertClean()
  })

  it('finds the existing bot comment by the "CLA Assistant Lite bot" marker and updates it', async () => {
    canonicalBotInterceptor(http)
    listCommentsInterceptor(
      http,
      [
        {
          id: 1,
          body: 'I agree to the CLA',
          user: { login: 'someone', id: 5 },
          created_at: '2024-01-01'
        },
        {
          id: 777,
          body: 'something **CLA Assistant Lite bot** says',
          user: { login: 'github-actions[bot]', id: 41898282, type: 'Bot' },
          created_at: '2024-01-02'
        }
      ],
      2
    )
    http
      .github()
      .intercept({
        path: '/repos/acme/widgets/issues/comments/777',
        method: 'PATCH'
      })
      .reply(
        200,
        { id: 777 },
        { headers: { 'content-type': 'application/json' } }
      )
      .times(2)

    const prCommentSetup = loadModule()
    await prCommentSetup(
      {
        signed: [{ name: 'alice', id: 1, pullRequestNo: 42 }],
        notSigned: [],
        unknown: []
      },
      [{ name: 'alice', id: 1, pullRequestNo: 42 }]
    )

    http.assertClean()
  })

  it('finds the DCO bot comment when use-dco-flag is true', async () => {
    setDefaultInputs({ 'use-dco-flag': 'true' })
    canonicalBotInterceptor(http)
    listCommentsInterceptor(
      http,
      [
        {
          id: 1,
          body: 'unrelated',
          user: { login: 'x', id: 2 },
          created_at: '2024-01-01'
        },
        {
          id: 555,
          body: '**DCO Assistant Lite bot**: content',
          user: { login: 'github-actions[bot]', id: 41898282, type: 'Bot' },
          created_at: '2024-01-02'
        }
      ],
      2
    )
    http
      .github()
      .intercept({
        path: '/repos/acme/widgets/issues/comments/555',
        method: 'PATCH'
      })
      .reply(
        200,
        { id: 555 },
        { headers: { 'content-type': 'application/json' } }
      )
      .times(2)

    const prCommentSetup = loadModule()
    await prCommentSetup(
      {
        signed: [{ name: 'alice', id: 1, pullRequestNo: 42 }],
        notSigned: [],
        unknown: []
      },
      [{ name: 'alice', id: 1, pullRequestNo: 42 }]
    )
    http.assertClean()
  })

  it('rejects a spoofed marker comment and creates a new trusted marker', async () => {
    canonicalBotInterceptor(http)
    listCommentsInterceptor(http, [
      {
        id: 666,
        body: 'spoofed **CLA Assistant Lite bot** marker',
        user: { login: 'mallory', id: 9001, type: 'User' },
        created_at: '2024-01-01'
      }
    ])
    const captured = captureJson(
      http.github(),
      { path: '/repos/acme/widgets/issues/42/comments', method: 'POST' },
      {
        status: 201,
        body: {
          id: 999,
          user: {
            login: 'github-actions[bot]',
            id: 41898282,
            type: 'Bot'
          }
        }
      }
    )

    const prCommentSetup = loadModule()
    await prCommentSetup(
      {
        signed: [],
        notSigned: [{ name: 'alice', id: 1, pullRequestNo: 42 }],
        unknown: []
      },
      [{ name: 'alice', id: 1, pullRequestNo: 42 }]
    )

    expect(captured.body.body).toContain('CLA Assistant Lite bot')
    http.assertClean()
  })
})
