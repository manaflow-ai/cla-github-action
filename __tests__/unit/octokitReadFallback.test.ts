import { getOctokit } from '@actions/github'
import {
  isGraphqlRateLimited,
  isReadRequest,
  isRateLimited,
  rateLimitWait,
  readTokens,
  withReadFallback,
  _resetOctokitClientsForTests,
  _setRateLimitClockForTests
} from '../../src/octokit'

type Call = { method: string; url: string; auth: string }

function fakeFetch(calls: Call[], refuse: (call: Call) => number | null) {
  return jest.fn(async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers)
    const call = {
      method: init.method || 'GET',
      url: String(url),
      auth: headers.get('authorization') || ''
    }
    calls.push(call)
    const status = refuse(call)
    if (status) {
      return new Response(
        JSON.stringify({
          message: 'API rate limit exceeded for installation.'
        }),
        {
          status,
          headers: {
            'content-type': 'application/json',
            'x-ratelimit-remaining': '0'
          }
        }
      )
    }
    return new Response(
      JSON.stringify({ data: { ok: true }, served: call.auth }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }
    )
  })
}

function clients(calls: Call[], refuse: (call: Call) => number | null) {
  const options = { request: { fetch: fakeFetch(calls, refuse) } }
  const client = withReadFallback(
    getOctokit('workflow-token', options),
    'app-read-token',
    options
  )
  return { client, restore: () => undefined }
}

const workflowRefused = (call: Call) =>
  call.auth.includes('workflow-token') ? 403 : null

afterEach(() => {
  delete process.env.CLA_RATE_LIMIT_MAX_WAIT_SECONDS
  _resetOctokitClientsForTests()
})

describe('CLA_READ_TOKEN fallback', () => {
  // These cases are about which token carries a request, not about waiting.
  beforeEach(() => {
    process.env.CLA_RATE_LIMIT_MAX_WAIT_SECONDS = '0'
  })

  it('sends a read the workflow budget refused again on the read token', async () => {
    const calls: Call[] = []
    const { client, restore } = clients(calls, workflowRefused)
    try {
      const response = await client.rest.pulls.get({
        owner: 'o',
        repo: 'r',
        pull_number: 1
      })
      expect((response.data as unknown as { served: string }).served).toContain(
        'app-read-token'
      )
      expect(calls.map(c => c.auth.split(' ')[1])).toEqual([
        'workflow-token',
        'app-read-token'
      ])
    } finally {
      restore()
    }
  })

  it('never sends a write on the read token', async () => {
    const calls: Call[] = []
    const { client, restore } = clients(calls, workflowRefused)
    try {
      await expect(
        client.rest.issues.createComment({
          owner: 'o',
          repo: 'r',
          issue_number: 1,
          body: 'x'
        })
      ).rejects.toMatchObject({ status: 403 })
      expect(calls).toHaveLength(1)
    } finally {
      restore()
    }
  })

  it('moves a GraphQL query but not a mutation', async () => {
    const calls: Call[] = []
    const { client, restore } = clients(calls, workflowRefused)
    try {
      await client.graphql('query { viewer { login } }')
      expect(calls.map(c => c.auth.split(' ')[1])).toEqual([
        'workflow-token',
        'app-read-token'
      ])
      calls.length = 0
      await expect(client.graphql('mutation { x }')).rejects.toBeTruthy()
      expect(calls).toHaveLength(1)
    } finally {
      restore()
    }
  })

  it('moves a GraphQL query whose 200 response reports RATE_LIMITED', async () => {
    const calls: Call[] = []
    const fetch = jest.fn(async (url: string, init: RequestInit) => {
      const auth = new Headers(init.headers).get('authorization') || ''
      calls.push({ method: init.method || 'GET', url: String(url), auth })
      const body = auth.includes('workflow-token')
        ? {
            errors: [
              { type: 'RATE_LIMITED', message: 'API rate limit exceeded' }
            ]
          }
        : { data: { viewer: { login: 'reader' } } }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    })
    const options = { request: { fetch } }
    const client = withReadFallback(
      getOctokit('workflow-token', options),
      'app-read-token',
      options
    )
    const result = (await client.graphql('query { viewer { login } }')) as {
      viewer: { login: string }
    }
    expect(result.viewer.login).toBe('reader')
    expect(calls.map(c => c.auth.split(' ')[1])).toEqual([
      'workflow-token',
      'app-read-token'
    ])
    calls.length = 0
    await expect(client.graphql('mutation { x }')).rejects.toBeTruthy()
    expect(calls).toHaveLength(1)
  })

  it('leaves a refusal that is not a spent budget alone', async () => {
    expect(
      isRateLimited({
        status: 403,
        message: 'Resource not accessible by integration'
      })
    ).toBe(false)
    expect(isRateLimited({ status: 404, message: 'rate limit' })).toBe(false)
    expect(
      isRateLimited({
        status: 429,
        message: 'x',
        response: { headers: { 'x-ratelimit-remaining': '0' } }
      })
    ).toBe(true)
    expect(isReadRequest({ method: 'PUT', url: '/repos/o/r/contents/x' })).toBe(
      false
    )
    expect(
      isReadRequest({
        method: 'POST',
        url: '/graphql',
        query: '  mutation { x }'
      })
    ).toBe(false)
    expect(isReadRequest({ method: 'GET', url: '/repos/o/r' })).toBe(true)
    expect(
      isGraphqlRateLimited({ data: { errors: [{ type: 'NOT_FOUND' }] } })
    ).toBe(false)
    expect(isGraphqlRateLimited({ data: { viewer: {} } })).toBe(false)
  })
})

describe('a spent budget waits instead of failing', () => {
  const NOW = 1_800_000_000_000 // ms
  let slept: number[]
  let infos: jest.SpyInstance
  beforeEach(() => {
    slept = []
    let now = NOW
    _setRateLimitClockForTests({
      now: () => now,
      sleep: async ms => {
        slept.push(ms)
        now += ms
      }
    })
    infos = jest.spyOn(require('@actions/core'), 'info')
  })
  afterEach(() => infos.mockRestore())

  // Every token answers 429 with x-ratelimit-reset 90 s from now until
  // `spentFor` requests have been made, then the next one succeeds.
  function spentThenServed(calls: Call[], spentFor: number, headers = {}) {
    return jest.fn(async (url: string, init: RequestInit) => {
      const auth = new Headers(init.headers).get('authorization') || ''
      calls.push({ method: init.method || 'GET', url: String(url), auth })
      if (calls.length <= spentFor) {
        return new Response(
          JSON.stringify({
            message: 'API rate limit exceeded for installation.'
          }),
          {
            status: 429,
            headers: {
              'content-type': 'application/json',
              'x-ratelimit-remaining': '0',
              'x-ratelimit-reset': String(NOW / 1000 + 90),
              ...headers
            }
          }
        )
      }
      return new Response(JSON.stringify({ served: auth }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    })
  }

  it('waits for the reset when both tokens answer 429, then succeeds', async () => {
    const calls: Call[] = []
    const options = { request: { fetch: spentThenServed(calls, 2) } }
    const client = withReadFallback(
      getOctokit('workflow-token', options),
      'app-read-token',
      options
    )
    const response = await client.rest.repos.getContent({
      owner: 'o',
      repo: 'r',
      path: 'signatures/version2/cla.json'
    })
    expect(response.status).toBe(200)
    expect(slept).toEqual([91_000])
    expect(calls.map(c => c.auth.split(' ')[1])).toEqual([
      'workflow-token',
      'app-read-token',
      'workflow-token'
    ])
    const lines = infos.mock.calls.map(c => String(c[0]))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(
      /all 2 tokens spent .* waiting 91s \(x-ratelimit-reset /
    )
  })

  it('prefers retry-after, and waits on a write too', async () => {
    const calls: Call[] = []
    const options = {
      request: { fetch: spentThenServed(calls, 1, { 'retry-after': '7' }) }
    }
    const client = withReadFallback(
      getOctokit('workflow-token', options),
      'app-read-token',
      options
    )
    await client.rest.issues.createComment({
      owner: 'o',
      repo: 'r',
      issue_number: 1,
      body: 'x'
    })
    expect(slept).toEqual([7_000])
    expect(calls.map(c => c.auth.split(' ')[1])).toEqual([
      'workflow-token',
      'workflow-token'
    ])
  })

  it('fails when the reset is past the cap', async () => {
    process.env.CLA_RATE_LIMIT_MAX_WAIT_SECONDS = '60'
    const calls: Call[] = []
    const options = { request: { fetch: spentThenServed(calls, 2) } }
    const client = withReadFallback(
      getOctokit('workflow-token', options),
      'app-read-token',
      options
    )
    await expect(
      client.rest.pulls.get({ owner: 'o', repo: 'r', pull_number: 1 })
    ).rejects.toMatchObject({ status: 429 })
    expect(slept).toEqual([])
    expect(calls).toHaveLength(2)
  })

  it('tries every read token, skipping one GitHub no longer accepts', async () => {
    const calls: Call[] = []
    const fetch = jest.fn(async (url: string, init: RequestInit) => {
      const auth = new Headers(init.headers).get('authorization') || ''
      calls.push({ method: init.method || 'GET', url: String(url), auth })
      const status = auth.includes('workflow-token')
        ? 429
        : auth.includes('expired-token')
          ? 401
          : 200
      return new Response(
        JSON.stringify(
          status === 200
            ? { served: auth }
            : {
                message:
                  status === 401 ? 'Bad credentials' : 'API rate limit exceeded'
              }
        ),
        {
          status,
          headers: {
            'content-type': 'application/json',
            'x-ratelimit-remaining': '0'
          }
        }
      )
    })
    const options = { request: { fetch } }
    const client = withReadFallback(
      getOctokit('workflow-token', options),
      readTokens('expired-token, app-read-token'),
      options
    )
    const response = await client.rest.pulls.get({
      owner: 'o',
      repo: 'r',
      pull_number: 1
    })
    expect((response.data as unknown as { served: string }).served).toContain(
      'app-read-token'
    )
    expect(slept).toEqual([])
  })

  it('reads the wait off retry-after, then x-ratelimit-reset, then a minute', () => {
    expect(
      rateLimitWait({ response: { headers: { 'retry-after': '3' } } }, NOW).ms
    ).toBe(3000)
    expect(
      rateLimitWait(
        {
          response: {
            headers: { 'x-ratelimit-reset': String(NOW / 1000 + 10) }
          }
        },
        NOW
      ).ms
    ).toBe(11_000)
    expect(
      rateLimitWait(
        { headers: { 'x-ratelimit-reset': String(NOW / 1000 - 5) } },
        NOW
      ).ms
    ).toBe(1000)
    expect(rateLimitWait({}, NOW).ms).toBe(60_000)
  })
})
