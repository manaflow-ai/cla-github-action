import {
  GitHubApiError,
  apiResultForError,
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
})
