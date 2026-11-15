import { getOctokit } from '@actions/github'
import * as core from '@actions/core'

/** The Octokit instance type returned by @actions/github's getOctokit. */
export type Octokit = ReturnType<typeof getOctokit>

let defaultClient: Octokit | undefined
let patClient: Octokit | undefined

function readEnvToken(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} environment variable is required`)
  return v
}

type OctokitOptions = Parameters<typeof getOctokit>[1]

function buildOctokit(token: string, options?: OctokitOptions): Octokit {
  return getOctokit(token, options)
}

type RequestOptions = {
  method?: string
  url?: string
  query?: unknown
  headers?: Record<string, unknown>
  [key: string]: unknown
}

/**
 * Whether a request only reads: a GET or HEAD, or a GraphQL query (never a
 * mutation). Only these may move to the read token.
 */
export function isReadRequest(options: RequestOptions): boolean {
  const method = (options.method || 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD') return true
  if (method !== 'POST' || options.url !== '/graphql') return false
  const query = typeof options.query === 'string' ? options.query.trim() : ''
  return query.startsWith('{') || /^query\b/.test(query)
}

/**
 * Whether GitHub refused a request for a spent budget: a 403 or 429 that says
 * so, or that carries X-RateLimit-Remaining 0.
 */
export function isRateLimited(error: unknown): boolean {
  const e = error as {
    status?: number
    message?: string
    response?: { headers?: Record<string, unknown> }
  }
  if (e?.status !== 403 && e?.status !== 429) return false
  const remaining = e.response?.headers?.['x-ratelimit-remaining']
  return (
    String(remaining) === '0' || /rate limit/i.test(String(e.message || ''))
  )
}

/**
 * Whether a GraphQL response that resolved (HTTP 200) reports a spent budget:
 * GitHub answers a spent GraphQL budget with an `errors` entry of type
 * RATE_LIMITED, not with a 403.
 */
export function isGraphqlRateLimited(response: unknown): boolean {
  const errors = (response as { data?: { errors?: unknown } })?.data?.errors
  if (!Array.isArray(errors)) return false
  return errors.some(item => {
    const e = item as { type?: unknown; message?: unknown }
    return (
      e?.type === 'RATE_LIMITED' || /rate limit/i.test(String(e?.message || ''))
    )
  })
}

let readFallbackNoted = false

/**
 * The workflow token's client. When CLA_READ_TOKEN is set, a read that the
 * workflow token's spent budget refuses (a 403 or 429, or a GraphQL response
 * reporting RATE_LIMITED) is sent once more on that token (another
 * installation, another budget). Writes always stay on GITHUB_TOKEN, so
 * comments and ledger commits keep the github-actions[bot] identity the
 * marker-comment check trusts.
 */
export function withReadFallback(
  client: Octokit,
  readToken: string,
  clientOptions?: OctokitOptions
): Octokit {
  let reader: Octokit | undefined
  const retryOnReader = async (requestOptions: RequestOptions) => {
    if (!readFallbackNoted) {
      readFallbackNoted = true
      core.warning(
        'GITHUB_TOKEN rate limit reached; reads continue on CLA_READ_TOKEN, writes stay on GITHUB_TOKEN.'
      )
    }
    reader = reader || buildOctokit(readToken, clientOptions)
    const { headers, request: _transport, ...rest } = requestOptions
    const plain = { ...(headers || {}) }
    delete plain.authorization
    return reader.request({ ...rest, headers: plain } as never)
  }
  client.hook.wrap('request', async (request, options) => {
    const requestOptions = options as RequestOptions
    const read = isReadRequest(requestOptions)
    let response
    try {
      response = await request(options)
    } catch (error) {
      if (!read || !isRateLimited(error)) throw error
      return retryOnReader(requestOptions)
    }
    if (read && isGraphqlRateLimited(response)) {
      return (await retryOnReader(requestOptions)) as typeof response
    }
    return response
  })
  return client
}

export function getDefaultOctokitClient(): Octokit {
  if (!defaultClient) {
    const client = buildOctokit(readEnvToken('GITHUB_TOKEN'))
    const readToken = process.env.CLA_READ_TOKEN
    defaultClient = readToken ? withReadFallback(client, readToken) : client
  }
  return defaultClient
}

export function getPATOctokit(): Octokit {
  if (!patClient) {
    const token = process.env.PERSONAL_ACCESS_TOKEN
    if (!token) {
      core.setFailed(
        `Please add a personal access token as an environment variable for writing signatures in a remote repository/organization as mentioned in the README.md file`
      )
      throw new Error(
        'PERSONAL_ACCESS_TOKEN is required for remote signatures repo'
      )
    }
    patClient = buildOctokit(token)
  }
  return patClient
}

/**
 * The default client used for all non-remote-repo operations. Lazily
 * constructed on first property access so importing this module has no
 * side effects.
 */
export const octokit: Octokit = new Proxy({} as Octokit, {
  get(_target, prop: string | symbol) {
    const client = getDefaultOctokitClient() as unknown as Record<
      string | symbol,
      unknown
    >
    const value = client[prop]
    return typeof value === 'function'
      ? (value as Function).bind(client)
      : value
  }
})

export function isPersonalAccessTokenPresent(): boolean {
  return Boolean(process.env.PERSONAL_ACCESS_TOKEN)
}

/** For tests: reset cached clients so a subsequent call picks up new env. */
export function _resetOctokitClientsForTests(): void {
  defaultClient = undefined
  patClient = undefined
  readFallbackNoted = false
}
