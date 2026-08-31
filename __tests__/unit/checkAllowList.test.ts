import * as core from '@actions/core'
import { resetEnv, setInput } from '../testHelpers/env'
import { checkAllowList } from '../../src/checkAllowList'
import { Committer } from '../../src/interfaces'

function committer(name: string, id: number, email?: string): Committer {
  return { name, id, pullRequestNo: 1, ...(email ? { email } : {}) }
}

describe('checkAllowList', () => {
  afterEach(() => {
    jest.restoreAllMocks()
    resetEnv()
  })

  it('exempts only verified numeric GitHub IDs', () => {
    setInput('allowlist-ids', '1001, 2002')
    const result = checkAllowList([
      committer('alice', 1001),
      committer('bob', 2002),
      committer('carol', 3003)
    ])
    expect(result.map(c => c.name)).toEqual(['carol'])
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
      committer('alice', 1001),
      committer('bob', 2002)
    ])

    expect(result.map(c => c.name)).toEqual(['bob'])
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
