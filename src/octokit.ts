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
 * The read tokens CLA_READ_TOKEN names, in the order they are tried. The
 * value is one token or a comma-separated list; empty entries are dropped, so
 * an unset secret in `${{ secrets.A }},${{ steps.b.outputs.token }}` (which
 * leaves a leading comma) is ignored, and a repeated token is tried once.
 */
export function parseReadTokens(value: string | undefined): string[] {
  const tokens: string[] = []
  for (const entry of String(value || '').split(',')) {
    const token = entry.trim()
    if (token && !tokens.includes(token)) tokens.push(token)
  }
  return tokens
}

/** Whether GitHub refused a token itself: expired, revoked or malformed. */
export function isBadCredentials(error: unknown): boolean {
  return (error as { status?: number })?.status === 401
}

/**
 * The workflow token's client. When CLA_READ_TOKEN names read tokens, a read
 * that the workflow token's spent budget refuses (a 403 or 429, or a GraphQL
 * response reporting RATE_LIMITED) is sent again on those tokens in order
 * (other installations, other budgets). A read token that answers 401 is
 * skipped for the rest of the run, and one whose own budget is spent passes
 * the read to the next; the last refusal is thrown when none is left. Writes
 * always stay on GITHUB_TOKEN, so comments and ledger commits keep the
 * github-actions[bot] identity the marker-comment check trusts.
 */
export function withReadFallback(
  client: Octokit,
  readTokens: string | string[],
  clientOptions?: OctokitOptions
): Octokit {
  const tokens = Array.isArray(readTokens)
    ? parseReadTokens(readTokens.join(','))
    : parseReadTokens(readTokens)
  const readers = new Map<string, Octokit>()
  const rejected = new Set<string>()
  type Response = Awaited<ReturnType<Octokit['request']>>
  const retryOnReaders = async (
    requestOptions: RequestOptions,
    refusal: unknown
  ): Promise<Response> => {
    if (!readFallbackNoted) {
      readFallbackNoted = true
      core.warning(
        'GITHUB_TOKEN rate limit reached; reads continue on CLA_READ_TOKEN, writes stay on GITHUB_TOKEN.'
      )
    }
    const { headers, request: _transport, ...rest } = requestOptions
    const plain = { ...(headers || {}) }
    delete plain.authorization
    let last = refusal
    for (const [index, token] of tokens.entries()) {
      if (rejected.has(token)) continue
      let reader = readers.get(token)
      if (!reader) {
        reader = buildOctokit(token, clientOptions)
        readers.set(token, reader)
      }
      try {
        const response: Response = await reader.request({
          ...rest,
          headers: plain
        } as never)
        if (isReadRequest(requestOptions) && isGraphqlRateLimited(response)) {
          last = response
          continue
        }
        return response
      } catch (error) {
        if (isBadCredentials(error)) {
          rejected.add(token)
          core.warning(
            `CLA_READ_TOKEN entry ${index + 1} answered 401; skipping it for this run.`
          )
          last = error
          continue
        }
        if (isRateLimited(error)) {
          last = error
          continue
        }
        throw error
      }
    }
    if (last instanceof Error || (last as { status?: number })?.status) {
      throw last
    }
    return last as Response
  }
  if (tokens.length === 0) return client
  client.hook.wrap('request', async (request, options) => {
    const requestOptions = options as RequestOptions
    const read = isReadRequest(requestOptions)
    let response
    try {
      response = await request(options)
    } catch (error) {
      if (!read || !isRateLimited(error)) throw error
      return retryOnReaders(requestOptions, error)
    }
    if (read && isGraphqlRateLimited(response)) {
      return retryOnReaders(requestOptions, response)
    }
    return response
  })
  return client
}

export function getDefaultOctokitClient(): Octokit {
  if (!defaultClient) {
    const client = buildOctokit(readEnvToken('GITHUB_TOKEN'))
    defaultClient = withReadFallback(
      client,
      parseReadTokens(process.env.CLA_READ_TOKEN)
    )
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
