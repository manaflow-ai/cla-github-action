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
 * How long a rate-limited run may wait in total for GitHub's budget to come
 * back, unless CLA_RATE_LIMIT_MAX_WAIT_SECONDS says otherwise. It sits inside
 * a 10 minute job timeout with room for the check itself.
 */
export const DEFAULT_RATE_LIMIT_MAX_WAIT_S = 420
/** The wait when a refusal names neither retry-after nor x-ratelimit-reset. */
export const RATE_LIMIT_FALLBACK_WAIT_S = 60

type RateLimitClock = {
  now: () => number
  sleep: (ms: number) => Promise<void>
}

const realClock: RateLimitClock = {
  now: () => Date.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms))
}
let clock: RateLimitClock = realClock
let waitedMs = 0

function maxWaitMs(): number {
  const raw = process.env.CLA_RATE_LIMIT_MAX_WAIT_SECONDS
  const seconds = raw === undefined || raw.trim() === '' ? NaN : Number(raw)
  return (
    (Number.isFinite(seconds) && seconds >= 0
      ? seconds
      : DEFAULT_RATE_LIMIT_MAX_WAIT_S) * 1000
  )
}

function headerOf(source: unknown, name: string): string | undefined {
  const s = source as {
    headers?: Record<string, unknown>
    response?: { headers?: Record<string, unknown> }
  }
  const value = s?.response?.headers?.[name] ?? s?.headers?.[name]
  return value === undefined || value === null ? undefined : String(value)
}

/**
 * How long until a rate-limited answer (a thrown 403/429, or a resolved
 * GraphQL response reporting RATE_LIMITED) may be sent again, and why:
 * retry-after (secondary limits) first, then x-ratelimit-reset (the primary
 * budget's reset, epoch seconds) plus a second of slack, else a minute.
 */
export function rateLimitWait(
  source: unknown,
  now: number
): { ms: number; why: string } {
  const retryAfter = Number(headerOf(source, 'retry-after'))
  if (Number.isFinite(retryAfter) && retryAfter >= 0) {
    return { ms: retryAfter * 1000, why: 'retry-after' }
  }
  const reset = Number(headerOf(source, 'x-ratelimit-reset'))
  if (Number.isFinite(reset) && reset > 0) {
    return {
      ms: Math.max(0, reset * 1000 - now) + 1000,
      why: `x-ratelimit-reset ${new Date(reset * 1000).toISOString()}`
    }
  }
  return { ms: RATE_LIMIT_FALLBACK_WAIT_S * 1000, why: 'no reset header' }
}

/** Every token in CLA_READ_TOKEN (one, or several separated by commas or whitespace). */
export function readTokens(raw: string | undefined): string[] {
  return (raw || '').split(/[\s,]+/).filter(Boolean)
}

function isBadCredential(error: unknown): boolean {
  return (error as { status?: number })?.status === 401
}

/**
 * The workflow token's client. When CLA_READ_TOKEN holds one or more tokens,
 * a read that the workflow token's spent budget refuses (a 403 or 429, or a
 * GraphQL response reporting RATE_LIMITED) is sent on each of them in turn
 * (other installations, other budgets); a read token GitHub no longer
 * accepts (401) is skipped. Writes always stay on GITHUB_TOKEN, so comments
 * and ledger commits keep the github-actions[bot] identity the marker-comment
 * check trusts.
 *
 * When every token that may carry the request is rate limited, the request
 * waits for the soonest of their resets (retry-after or x-ratelimit-reset)
 * and is sent again, so a spent budget makes the check wait instead of fail.
 * The run's total wait is capped by CLA_RATE_LIMIT_MAX_WAIT_SECONDS (default
 * 420, inside the job timeout); a wait that would pass the cap fails with
 * GitHub's refusal, as before.
 */
export function withReadFallback(
  client: Octokit,
  readToken: string | string[] | undefined,
  clientOptions?: OctokitOptions
): Octokit {
  const tokens = Array.isArray(readToken) ? readToken : readTokens(readToken)
  const readers: (Octokit | undefined)[] = tokens.map(() => undefined)
  const dead = new Set<number>()
  const sendOnReader = async (
    index: number,
    requestOptions: RequestOptions
  ) => {
    if (!readFallbackNoted) {
      readFallbackNoted = true
      core.warning(
        'GITHUB_TOKEN rate limit reached; reads continue on CLA_READ_TOKEN, writes stay on GITHUB_TOKEN.'
      )
    }
    const reader = (readers[index] =
      readers[index] || buildOctokit(tokens[index] as string, clientOptions))
    const { headers, request: _transport, ...rest } = requestOptions
    const plain = { ...(headers || {}) }
    delete plain.authorization
    return reader.request({ ...rest, headers: plain } as never)
  }
  client.hook.wrap('request', async (request, options) => {
    const requestOptions = options as RequestOptions
    const read = isReadRequest(requestOptions)
    for (;;) {
      const refusals: unknown[] = []
      let lastError: unknown
      let lastResponse: unknown
      let response
      try {
        response = await request(options)
      } catch (error) {
        if (!isRateLimited(error)) throw error
        refusals.push(error)
        lastError = error
      }
      if (response !== undefined) {
        if (!(read && isGraphqlRateLimited(response))) return response
        refusals.push(response)
        lastResponse = response
      }
      if (read) {
        for (let i = 0; i < tokens.length; i++) {
          if (dead.has(i)) continue
          let answer
          try {
            answer = await sendOnReader(i, requestOptions)
          } catch (error) {
            if (isBadCredential(error)) {
              dead.add(i)
              core.warning(
                `CLA_READ_TOKEN #${i + 1} was refused (401); reads skip it.`
              )
              continue
            }
            if (!isRateLimited(error)) throw error
            refusals.push(error)
            lastError = error
            lastResponse = undefined
            continue
          }
          if (!isGraphqlRateLimited(answer))
            return answer as NonNullable<typeof response>
          refusals.push(answer)
          lastResponse = answer
          lastError = undefined
        }
      }
      const now = clock.now()
      const wait = refusals
        .map(r => rateLimitWait(r, now))
        .reduce((a, b) => (b.ms < a.ms ? b : a))
      const cap = maxWaitMs()
      const target = `${requestOptions.method || 'GET'} ${requestOptions.url || ''}`
      const live = read ? tokens.length - dead.size + 1 : 1
      const who = live > 1 ? `all ${live} tokens` : 'GITHUB_TOKEN'
      if (waitedMs + wait.ms > cap) {
        core.warning(
          `GitHub rate limit: ${who} spent for ${target}; the next reset is in ${Math.ceil(wait.ms / 1000)}s (${wait.why}), past the ${Math.round(cap / 1000)}s wait cap (${Math.round(waitedMs / 1000)}s already waited); failing.`
        )
        if (lastError !== undefined) throw lastError
        return lastResponse as NonNullable<typeof response>
      }
      core.info(
        `GitHub rate limit: ${who} spent for ${target}; waiting ${Math.ceil(wait.ms / 1000)}s (${wait.why}), ${Math.round((cap - waitedMs - wait.ms) / 1000)}s of the ${Math.round(cap / 1000)}s cap left after.`
      )
      waitedMs += wait.ms
      await clock.sleep(wait.ms)
    }
  })
  return client
}

export function getDefaultOctokitClient(): Octokit {
  if (!defaultClient) {
    const client = buildOctokit(readEnvToken('GITHUB_TOKEN'))
    defaultClient = withReadFallback(client, process.env.CLA_READ_TOKEN)
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
  waitedMs = 0
  clock = realClock
}

/** For tests: a fake clock, so a rate-limit wait neither sleeps nor reads the wall clock. */
export function _setRateLimitClockForTests(fake: RateLimitClock): void {
  clock = fake
}
