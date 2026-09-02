import {
  GitHubApiError,
  apiResultForError,
  errorMessage,
  errorStatus,
  toGitHubApiError,
  withGitHubApiError
} from '../../src/shared/errors'

describe('GitHub API error contract', () => {
  it('classifies transient HTTP responses as retryable without losing status', () => {
    const error = toGitHubApiError(
      { status: 503, message: 'service unavailable' },
      'contents.get'
    )

    expect(error).toMatchObject({
      kind: 'http',
      operation: 'contents.get',
      status: 503,
      retryable: true
    })
    expect(error).toBeInstanceOf(GitHubApiError)
    expect(apiResultForError(error)).toBe('retryable_error')
    expect(errorStatus(error)).toBe(503)
  })

  it('classifies a network failure as retryable transport', () => {
    const cause = Object.assign(new TypeError('socket reset'), {
      code: 'ECONNRESET'
    })
    const error = toGitHubApiError(cause, 'graphql.committers')

    expect(error).toMatchObject({
      kind: 'transport',
      operation: 'graphql.committers',
      retryable: true
    })
    expect(errorStatus(error)).toBeUndefined()
    expect(apiResultForError(error)).toBe('retryable_error')
  })

  it('keeps unknown status-less failures terminal', () => {
    const error = toGitHubApiError(
      new TypeError('response shape is invalid'),
      'graphql.committers'
    )

    expect(error).toMatchObject({
      kind: 'transport',
      retryable: false
    })
    expect(apiResultForError(error)).toBe('error')
  })

  it('recognizes a wrapped undici transport timeout', () => {
    const cause = Object.assign(new Error('connect timeout'), {
      code: 'UND_ERR_CONNECT_TIMEOUT',
      name: 'ConnectTimeoutError'
    })
    const wrapped = new Error('GraphQL request failed', { cause })
    const error = toGitHubApiError(wrapped, 'graphql.committers')

    expect(error.retryable).toBe(true)
    expect(apiResultForError(error)).toBe('retryable_error')
  })

  it('keeps authorization failures terminal', () => {
    const error = toGitHubApiError(
      { status: 403, message: 'forbidden' },
      'comments.update'
    )

    expect(error).toMatchObject({
      kind: 'http',
      status: 403,
      retryable: false
    })
    expect(apiResultForError(error)).toBe('error')
  })

  it('wraps one request and never retries a failed write', async () => {
    const request = jest
      .fn<Promise<never>, []>()
      .mockRejectedValue({ status: 503, message: 'upstream' })

    await expect(
      withGitHubApiError('contents.update', request)
    ).rejects.toMatchObject({
      kind: 'http',
      status: 503,
      retryable: true
    })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('does not relabel a validation error as transport', () => {
    expect(apiResultForError(new Error('invalid response shape'))).toBe('error')
  })

  it('does not serialize request metadata into the diagnostic', () => {
    const error = {
      message: 'GitHub rejected the request',
      status: 403,
      request: {
        url: 'https://api.github.com/repos/acme/widgets?access_token=secret-token',
        headers: {
          authorization: 'Bearer secret-token',
          cookie: 'session=private-cookie'
        },
        options: { body: { token: 'nested-secret' } }
      },
      response: { data: { privateKey: 'response-secret' } }
    }

    const message = errorMessage(error)

    expect(message).toBe('GitHub rejected the request')
    expect(message).not.toContain('secret-token')
    expect(message).not.toContain('private-cookie')
    expect(message).not.toContain('nested-secret')
    expect(message).not.toContain('response-secret')
  })

  it('redacts URLs and bearer credentials from Error messages', () => {
    const message = errorMessage(
      new Error(
        'request failed https://api.github.com/repos/acme/widgets?access_token=secret-token with Authorization: Bearer another-secret'
      )
    )

    expect(message).toContain('request failed')
    expect(message).not.toContain('https://api.github.com')
    expect(message).not.toContain('secret-token')
    expect(message).not.toContain('another-secret')
  })

  it('uses a generic diagnostic when an object has no safe message', () => {
    expect(
      errorMessage({
        request: {
          headers: { authorization: 'Bearer secret-token' },
          options: { body: { password: 'private' } }
        }
      })
    ).toBe('Unknown GitHub API error')
  })
})
