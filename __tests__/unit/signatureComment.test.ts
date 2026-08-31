import { resetEnv, setInput } from '../testHelpers/env'
import {
  commentContainsSignature,
  isCommentSignedByUser
} from '../../src/pullrequest/signatureComment'

const CLA = 'I have read the CLA Document and I hereby sign the CLA'
const DCO = 'I have read the DCO Document and I hereby sign the DCO'

describe('commentContainsSignature', () => {
  it.each([
    ['exact phrase', CLA],
    ['surrounding spaces', `  ${CLA}  `],
    ['surrounding blank lines', `\n\n${CLA}\n\n`],
    ['CRLF around the phrase', `\r\n${CLA}\r\n`]
  ])('accepts %s', (_, body) => {
    expect(commentContainsSignature(body, CLA)).toBe(true)
  })

  it.each([
    ['empty body', ''],
    ['unrelated text', 'recheck'],
    ['lower-case wording', CLA.toLowerCase()],
    [
      'changed whitespace inside the phrase',
      CLA.replace('CLA Document', 'CLA  Document')
    ],
    ['trailing period', `${CLA}.`],
    ['trailing exclamation', `${CLA}!`],
    ['appended recheck', `${CLA}\nrecheck`],
    ['prepended greeting', `Hi,\n\n${CLA}`],
    ['appended qualification', `${CLA}\nfor this change only`],
    ['edited after signing', `${CLA}\nI withdraw this declaration`],
    ['phrase inside a markdown blockquote', `> ${CLA}`],
    ['phrase after a markdown blockquote', `> context\n${CLA}`],
    ['near-miss wording', 'I have read the CLA and I sign it']
  ])('rejects %s', (_, body) => {
    expect(commentContainsSignature(body, CLA)).toBe(false)
  })

  it('requires an exact custom phrase as the whole body', () => {
    const phrase = 'I accept the Contributor Terms'
    expect(commentContainsSignature(phrase, phrase)).toBe(true)
    expect(commentContainsSignature(`${phrase}.`, phrase)).toBe(false)
    expect(commentContainsSignature(`${phrase}\nrecheck`, phrase)).toBe(false)
  })

  it('requires every line of a multi-line custom phrase exactly', () => {
    const phrase = 'I have read the Contributor Terms\nI sign the CLA'
    expect(commentContainsSignature(phrase, phrase)).toBe(true)
    expect(commentContainsSignature(`${phrase}\nrecheck`, phrase)).toBe(false)
    expect(
      commentContainsSignature(
        'I have read the Contributor Terms\n> I sign the CLA',
        phrase
      )
    ).toBe(false)
  })
})

describe('isCommentSignedByUser', () => {
  afterEach(resetEnv)

  it('rejects every GitHub Bot actor type', () => {
    expect(isCommentSignedByUser(CLA, 'renovate[bot]', 'Bot', 1001)).toBe(false)
    expect(isCommentSignedByUser(CLA, 'github-actions[bot]', 'Bot', 1001)).toBe(
      false
    )
  })

  it('rejects a bot-suffixed login even when actor type is missing or wrong', () => {
    expect(isCommentSignedByUser(CLA, 'example[bot]', undefined, 1001)).toBe(
      false
    )
    expect(isCommentSignedByUser(CLA, 'example[bot]', 'User', 1001)).toBe(false)
  })

  it('requires a GitHub User actor type and a positive safe integer ID', () => {
    expect(isCommentSignedByUser(CLA, 'alice', undefined, 1001)).toBe(false)
    expect(isCommentSignedByUser(CLA, 'alice', 'Organization', 1001)).toBe(
      false
    )
    expect(isCommentSignedByUser(CLA, 'alice', 'Mannequin', 1001)).toBe(false)
    expect(isCommentSignedByUser(CLA, 'alice', 'User', 0)).toBe(false)
    expect(isCommentSignedByUser(CLA, 'alice', 'User', -1)).toBe(false)
    expect(isCommentSignedByUser(CLA, 'alice', 'User', 1.5)).toBe(false)
    expect(
      isCommentSignedByUser(CLA, 'alice', 'User', Number.MAX_SAFE_INTEGER + 1)
    ).toBe(false)
  })

  it('uses the CLA phrase by default', () => {
    expect(isCommentSignedByUser(CLA, 'alice', 'User', 1001)).toBe(true)
    expect(isCommentSignedByUser(DCO, 'alice', 'User', 1001)).toBe(false)
  })

  it('uses the DCO phrase when use-dco-flag is true', () => {
    setInput('use-dco-flag', 'true')
    expect(isCommentSignedByUser(DCO, 'alice', 'User', 1001)).toBe(true)
    expect(isCommentSignedByUser(CLA, 'alice', 'User', 1001)).toBe(false)
  })

  it('uses the custom phrase when configured', () => {
    setInput('custom-pr-sign-comment', 'I accept the terms')
    expect(
      isCommentSignedByUser('I accept the terms', 'alice', 'User', 1001)
    ).toBe(true)
    expect(
      isCommentSignedByUser('I accept the terms.', 'alice', 'User', 1001)
    ).toBe(false)
  })
})
