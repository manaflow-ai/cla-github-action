/** Stable result values emitted by the action for downstream policy jobs. */
export type ApiResult = 'success' | 'unsigned' | 'retryable_error' | 'error'

type GitHubApiErrorKind = 'http' | 'transport'

interface GitHubApiErrorOptions {
  operation: string
  kind: GitHubApiErrorKind
  status?: number
  retryable: boolean
  cause: unknown
}

/**
 * Error raised at a GitHub API boundary. The type keeps transport failures
 * separate from HTTP responses without changing the action's fail-closed
 * control flow. Callers must still decide whether a failed operation is safe
 * to repeat, so the action never retries writes automatically.
 */
export class GitHubApiError extends Error {
  readonly operation: string
  readonly kind: GitHubApiErrorKind
  readonly status: number | undefined
  readonly retryable: boolean

  constructor(options: GitHubApiErrorOptions) {
    const statusText =
      options.status === undefined ? '' : ` (HTTP ${options.status})`
    super(
      `GitHub ${options.operation} failed${statusText}: ${errorMessage(options.cause)}`,
      { cause: options.cause }
    )
    this.name = 'GitHubApiError'
    this.operation = options.operation
    this.kind = options.kind
    this.status = options.status
    this.retryable = options.retryable
  }
}

const RETRYABLE_HTTP_STATUSES = new Set([
  408, 409, 425, 429, 500, 502, 503, 504
])

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    const serialized = JSON.stringify(err)
    return serialized === undefined ? String(err) : serialized
  } catch {
    return String(err)
  }
}

/** Status code from an Octokit RequestError or a wrapped cause. */
export function errorStatus(err: unknown): number | undefined {
  return findPropertyNumber(err, 'status')
}

/** Convert one API-boundary failure to a typed, retry-aware error. */
export function toGitHubApiError(
  err: unknown,
  operation: string
): GitHubApiError {
  if (err instanceof GitHubApiError) return err
  const candidateStatus = errorStatus(err)
  const status =
    candidateStatus !== undefined &&
    Number.isInteger(candidateStatus) &&
    candidateStatus >= 100 &&
    candidateStatus <= 599
      ? candidateStatus
      : undefined
  const kind: GitHubApiErrorKind = status === undefined ? 'transport' : 'http'
  return new GitHubApiError({
    operation,
    kind,
    ...(status === undefined ? {} : { status }),
    retryable: status === undefined || RETRYABLE_HTTP_STATUSES.has(status),
    cause: err
  })
}

/** Run one API request and preserve its failure classification for callers. */
export async function withGitHubApiError<T>(
  operation: string,
  request: () => Promise<T>
): Promise<T> {
  try {
    return await request()
  } catch (err) {
    throw toGitHubApiError(err, operation)
  }
}

/** Map a typed API failure to the stable action output contract. */
export function apiResultForError(
  error: unknown
): Extract<ApiResult, 'retryable_error' | 'error'> {
  return findGitHubApiError(error)?.retryable ? 'retryable_error' : 'error'
}

/** Find a typed API failure through contextual Error causes. */
function findGitHubApiError(error: unknown): GitHubApiError | undefined {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && !seen.has(current)) {
    seen.add(current)
    if (current instanceof GitHubApiError) return current
    if (typeof current !== 'object' && typeof current !== 'function') {
      return undefined
    }
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

function findPropertyNumber(
  value: unknown,
  property: string
): number | undefined {
  const seen = new Set<unknown>()
  let current: unknown = value
  while (current && !seen.has(current)) {
    seen.add(current)
    if (typeof current === 'object' || typeof current === 'function') {
      const candidate = (current as Record<string, unknown>)[property]
      if (typeof candidate === 'number') return candidate
      current = (current as { cause?: unknown }).cause
    } else {
      break
    }
  }
  return undefined
}
