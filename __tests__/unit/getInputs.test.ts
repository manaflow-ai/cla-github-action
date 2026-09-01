import { resetEnv, setInput } from '../testHelpers/env'
import * as inputs from '../../src/shared/getInputs'

describe('getInputs wrappers', () => {
  afterEach(resetEnv)

  const stringInputs: Array<[keyof typeof inputs, string]> = [
    ['getRemoteRepoName', 'remote-repository-name'],
    ['getRemoteOrgName', 'remote-organization-name'],
    ['getPathToSignatures', 'path-to-signatures'],
    ['getPathToDocument', 'path-to-document'],
    ['getBranch', 'branch'],
    ['getExpectedHeadSha', 'expected-head-sha'],
    ['getExpectedBaseSha', 'expected-base-sha'],
    ['getAllowListItem', 'allowlist'],
    ['getSignedCommitMessage', 'signed-commit-message'],
    ['getCreateFileCommitMessage', 'create-file-commit-message'],
    ['getCustomNotSignedPrComment', 'custom-notsigned-prcomment'],
    ['getCustomAllSignedPrComment', 'custom-allsigned-prcomment'],
    ['getCustomPrSignComment', 'custom-pr-sign-comment']
  ]
  const booleanInputs: Array<[keyof typeof inputs, string]> = [
    ['getUseDcoFlag', 'use-dco-flag'],
    ['lockPullRequestAfterMerge', 'lock-pullrequest-aftermerge'],
    ['suggestRecheck', 'suggest-recheck']
  ]

  it.each(stringInputs)(
    '%s reads the "%s" action input as a string',
    (fn, inputName) => {
      setInput(inputName, 'expected-value')
      expect((inputs[fn] as () => string)()).toBe('expected-value')
    }
  )

  it.each(booleanInputs)('%s parses "%s" as a boolean', (fn, inputName) => {
    setInput(inputName, 'true')
    expect((inputs[fn] as () => boolean)()).toBe(true)
    setInput(inputName, 'false')
    expect((inputs[fn] as () => boolean)()).toBe(false)
    setInput(inputName, 'TRUE')
    expect((inputs[fn] as () => boolean)()).toBe(true)
    setInput(inputName, '')
    expect((inputs[fn] as () => boolean)()).toBe(false)
  })

  it('returns an empty string when the input is unset', () => {
    expect(inputs.getBranch()).toBe('')
  })

  it('defaults the action mode to the write-capable signing path', () => {
    expect(inputs.getMode()).toBe('sign')
  })

  it('reads the explicit signer preflight mode', () => {
    setInput('mode', 'signer-preflight')
    expect(inputs.getMode()).toBe('signer-preflight')
  })

  it('defaults the required base branch to main', () => {
    expect(inputs.getRequiredBaseRef()).toBe('main')
  })

  it('returns an explicitly configured required base branch', () => {
    setInput('required-base-ref', 'release')
    expect(inputs.getRequiredBaseRef()).toBe('release')
  })

  it('reads a complete preflight comment identity tuple', () => {
    setInput('expected-comment-id', '12345')
    setInput('expected-comment-created-at', '2026-09-01T20:00:00.000Z')
    setInput('expected-comment-author-id', '67890')

    expect(inputs.getExpectedSigningComment()).toEqual({
      id: 12345,
      createdAt: '2026-09-01T20:00:00.000Z',
      authorId: 67890
    })
  })

  it.each([
    'expected-comment-id',
    'expected-comment-created-at',
    'expected-comment-author-id'
  ])('rejects a partial preflight comment identity tuple (%s)', provided => {
    setInput(
      provided,
      provided === 'expected-comment-created-at' ? 'timestamp' : '1'
    )
    expect(() => inputs.getExpectedSigningComment()).toThrow(
      /must be provided together/i
    )
  })

  it('rejects malformed preflight comment identity values', () => {
    setInput('expected-comment-id', '0')
    setInput('expected-comment-created-at', 'timestamp')
    setInput('expected-comment-author-id', '2')
    expect(() => inputs.getExpectedSigningComment()).toThrow(/malformed/i)
  })

  it('trims whitespace around the input value (core.getInput behaviour)', () => {
    setInput('branch', '  main  ')
    expect(inputs.getBranch()).toBe('main')
  })
})
