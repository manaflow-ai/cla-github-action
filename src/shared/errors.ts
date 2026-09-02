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

const UNKNOWN_ERROR_MESSAGE = 'Unknown GitHub API error'
const MAX_ERROR_MESSAGE_LENGTH = 512

// These are the network failures that the Node and Undici clients document as
// safe to classify as transient. An unknown status-less error stays terminal.
const RETRYABLE_TRANSPORT_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'EHOSTDOWN',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
  'ERR_NETWORK',
  'ERR_SOCKET_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_PRX_CONN',
  'UND_ERR_SOCKET'
])

const RETRYABLE_TRANSPORT_NAMES = new Set([
  'BodyTimeoutError',
  'ConnectTimeoutError',
  'FetchError',
  'HeadersTimeoutError',
  'NetworkError',
  'ProxyConnectionError',
  'SecureProxyConnectionError',
  'SocketError'
])

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
    const status = validHttpStatus(options.status)
    const statusText = status === undefined ? '' : ` (HTTP ${status})`
    super(
      `GitHub ${safeOperation(options.operation)} failed${statusText}: ${errorMessage(options.cause)}`,
      { cause: options.cause }
    )
    this.name = 'GitHubApiError'
    this.operation = safeOperation(options.operation)
    this.kind = options.kind
    this.status = status
    this.retryable = options.retryable
  }
}

const RETRYABLE_HTTP_STATUSES = new Set([
  408, 409, 425, 429, 500, 502, 503, 504
])

export function errorMessage(err: unknown): string {
  const fields = readErrorFields(err)
  const message = sanitizeDiagnostic(fields.message)
  if (message) return message

  const identity = [fields.name, fields.code]
    .map(value => sanitizeToken(value))
    .filter((value): value is string => Boolean(value) && value !== 'Error')
  if (identity.length > 0) {
    return `GitHub API error (${identity.join(', ')})`
  }
  return UNKNOWN_ERROR_MESSAGE
}

/** Status code from an Octokit RequestError or a wrapped cause. */
export function errorStatus(err: unknown): number | undefined {
  const seen = new Set<object>()
  let current: unknown = err
  while (isObjectLike(current) && !seen.has(current)) {
    seen.add(current)
    const status = firstValidStatus(current, ['status', 'statusCode'])
    if (status !== undefined) return status

    const response = readDataProperty(current, 'response')
    const responseStatus = firstValidStatus(response, ['status', 'statusCode'])
    if (responseStatus !== undefined) return responseStatus

    current = readDataProperty(current, 'cause')
  }
  return undefined
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
    retryable:
      status === undefined
        ? isRetryableTransportError(err)
        : RETRYABLE_HTTP_STATUSES.has(status),
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

function isRetryableTransportError(error: unknown): boolean {
  const seen = new Set<object>()
  let current: unknown = error
  while (isObjectLike(current) && !seen.has(current)) {
    seen.add(current)
    const code = readDataProperty(current, 'code')
    if (
      typeof code === 'string' &&
      RETRYABLE_TRANSPORT_CODES.has(code.toUpperCase())
    ) {
      return true
    }

    const name = readDataProperty(current, 'name')
    if (typeof name === 'string' && RETRYABLE_TRANSPORT_NAMES.has(name)) {
      return true
    }

    current = readDataProperty(current, 'cause')
  }
  return false
}

interface SafeErrorFields {
  message?: string
  name?: string
  code?: string
}

function readErrorFields(error: unknown): SafeErrorFields {
  if (typeof error === 'string') return { message: error }
  if (
    typeof error === 'number' ||
    typeof error === 'boolean' ||
    typeof error === 'bigint'
  ) {
    return { message: String(error) }
  }

  const seen = new Set<object>()
  let current: unknown = error
  let name: string | undefined
  let code: string | undefined
  while (isObjectLike(current) && !seen.has(current)) {
    seen.add(current)
    const message = readDataProperty(current, 'message')
    if (typeof message === 'string' && message.length > 0) {
      const resolvedName = name ?? readStringProperty(current, 'name')
      const resolvedCode = code ?? readStringProperty(current, 'code')
      return {
        message,
        ...(resolvedName ? { name: resolvedName } : {}),
        ...(resolvedCode ? { code: resolvedCode } : {})
      }
    }
    name ??= readStringProperty(current, 'name')
    code ??= readStringProperty(current, 'code')
    current = readDataProperty(current, 'cause')
  }
  return {
    ...(name ? { name } : {}),
    ...(code ? { code } : {})
  }
}

function readStringProperty(
  value: unknown,
  property: string
): string | undefined {
  const candidate = readDataProperty(value, property)
  return typeof candidate === 'string' && candidate.length > 0
    ? candidate
    : undefined
}

function readDataProperty(value: unknown, property: string): unknown {
  if (!isObjectLike(value)) return undefined
  const seen = new Set<object>()
  let current: object | null = value
  while (current && !seen.has(current)) {
    seen.add(current)
    try {
      const descriptor = Object.getOwnPropertyDescriptor(current, property)
      if (descriptor)
        return 'value' in descriptor ? descriptor.value : undefined
      current = Object.getPrototypeOf(current)
    } catch {
      return undefined
    }
  }
  return undefined
}

function isObjectLike(value: unknown): value is object {
  return (
    (typeof value === 'object' && value !== null) || typeof value === 'function'
  )
}

function validHttpStatus(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 100 &&
    value <= 599
    ? value
    : undefined
}

function firstValidStatus(
  value: unknown,
  properties: readonly string[]
): number | undefined {
  for (const property of properties) {
    const status = validHttpStatus(readDataProperty(value, property))
    if (status !== undefined) return status
  }
  return undefined
}

function safeOperation(operation: string): string {
  const sanitized = sanitizeDiagnostic(operation)
  return sanitized || 'API request'
}

function sanitizeToken(value: string | undefined): string | undefined {
  if (!value || !/^[A-Za-z0-9._:-]{1,64}$/.test(value)) return undefined
  return value
}

function sanitizeDiagnostic(value: string | undefined): string | undefined {
  if (!value) return undefined
  const sanitized = value
    // Remove URLs before key/value redaction so query parameters cannot leak.
    .replace(/\b[a-z][a-z\d+.-]{1,20}:\/\/[^\s<>"'`]+/gi, '[REDACTED_URL]')
    .replace(/\b(Bearer|Basic)\s+[^\s,;}\]"']+/gi, '$1 [REDACTED]')
    .replace(
      /((?:["']?(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|passwd|secret|token)["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^,\s}\]]+)/gi,
      '$1[REDACTED]'
    )
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!sanitized) return undefined
  return sanitized.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${sanitized.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1)}…`
    : sanitized
}
