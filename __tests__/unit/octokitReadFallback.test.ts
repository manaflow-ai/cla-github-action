import { getOctokit } from '@actions/github'
import {
  isGraphqlRateLimited,
  isReadRequest,
  isRateLimited,
  withReadFallback
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

describe('CLA_READ_TOKEN fallback', () => {
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
