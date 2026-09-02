import * as core from '@actions/core'
import { resetEnv, setInput } from '../testHelpers/env'
import {
  checkAllowList,
  checkExemptOpener,
  isPullRequestOpenerAllowlisted
} from '../../src/checkAllowList'
import { Committer } from '../../src/interfaces'

function committer(
  name: string,
  id: number,
  email?: string,
  isPullRequestOpener = false
): Committer {
  return {
    name,
    id,
    pullRequestNo: 1,
    ...(email ? { email } : {}),
    isPullRequestOpener
  }
}

describe('checkAllowList', () => {
  afterEach(() => {
    jest.restoreAllMocks()
    resetEnv()
  })

  it('does not remove contributors for an opener-authorship allowlist', () => {
    setInput('allowlist-ids', '1001, 2002')
    const result = checkAllowList([
      committer('alice', 1001, undefined, true),
      committer('bob', 2002),
      committer('carol', 3003)
    ])
    expect(result.map(c => c.name)).toEqual(['alice', 'bob', 'carol'])
  })

  it('does not exempt a matching raw login or email from the deprecated allowlist', () => {
    const warning = jest.spyOn(core, 'warning').mockImplementation(() => {})
    setInput('allowlist', 'alice,*[bot],noreply@example.com')
    const committers = [
      committer('alice', 1001),
      committer('dependabot[bot]', 49699333),
      committer('service', 4004, 'noreply@example.com')
    ]

    expect(checkAllowList(committers)).toEqual(committers)
    expect(warning).toHaveBeenCalledWith(
      expect.stringMatching(/allowlist.*ignored.*allowlist-ids/i)
    )
  })

  it('ignores malformed and non-positive allowlist IDs with a warning', () => {
    const warning = jest.spyOn(core, 'warning').mockImplementation(() => {})
    setInput('allowlist-ids', '1001,bob,0,-2,3.5')
    const result = checkAllowList([
      committer('alice', 1001, undefined, true),
      committer('bob', 2002)
    ])

    expect(result.map(c => c.name)).toEqual(['alice', 'bob'])
    expect(warning).toHaveBeenCalledWith(
      expect.stringMatching(/invalid allowlist-ids/i)
    )
  })

  it('does not exempt an unlinked identity with id zero', () => {
    setInput('allowlist-ids', '0')
    expect(
      checkAllowList([committer('Mystery', 0, 'mystery@example.com')])
    ).toHaveLength(1)
  })

  it('returns the full list when allowlist-ids is empty', () => {
    setInput('allowlist-ids', '')
    const committers = [committer('alice', 1001), committer('bob', 2002)]
    expect(checkAllowList(committers)).toEqual(committers)
  })

  it('removes only the exact live opener for an authenticated legal exemption', () => {
    setInput('exempt-opener-ids', '1001, 2002')
    const result = checkExemptOpener(
      [
        committer('alice', 1001, undefined, true),
        committer('bob', 2002),
        committer('carol', 3003, undefined, true)
      ],
      { id: 1001 }
    )
    expect(result.map(c => c.name)).toEqual(['bob', 'carol'])
  })

  it('does not remove a commit-derived identity that only matches the configured ID', () => {
    setInput('exempt-opener-ids', '1001')
    const result = checkExemptOpener(
      [committer('forged-alice', 1001), committer('bob', 2002)],
      { id: 1001 }
    )
    expect(result.map(c => c.name)).toEqual(['forged-alice', 'bob'])
  })

  it('ignores malformed legal exemption IDs and never exempts an invalid opener', () => {
    const warning = jest.spyOn(core, 'warning').mockImplementation(() => {})
    setInput('exempt-opener-ids', '1001,bob,0,-2,3.5,9007199254740992')
    const committers = [committer('alice', 1001, undefined, true)]

    expect(checkExemptOpener(committers, { id: Number.NaN })).toEqual(
      committers
    )
    expect(warning).toHaveBeenCalledWith(
      expect.stringMatching(/invalid exempt-opener-ids/i)
    )
  })

  it('matches only a configured authenticated opener ID', () => {
    setInput('allowlist-ids', '38676809,67667005')
    expect(isPullRequestOpenerAllowlisted({ id: 38676809 })).toBe(true)
    expect(isPullRequestOpenerAllowlisted({ id: 67667005 })).toBe(true)
    expect(isPullRequestOpenerAllowlisted({ id: 2002 })).toBe(false)
  })

  it('rejects invalid opener IDs even when the text is configured', () => {
    setInput('allowlist-ids', '0,9007199254740992')
    expect(isPullRequestOpenerAllowlisted({ id: 0 })).toBe(false)
    expect(isPullRequestOpenerAllowlisted({ id: Number.NaN })).toBe(false)
  })

  it('skips null and undefined entries without creating an exemption', () => {
    setInput('allowlist-ids', '')
    const result = checkAllowList([
      committer('alice', 1001),
      null as unknown as Committer,
      undefined as unknown as Committer
    ])
    expect(result.map(c => c.name)).toEqual(['alice'])
  })
})
