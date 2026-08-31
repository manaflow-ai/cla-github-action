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
    ['changed whitespace inside the phrase', CLA.replace('CLA Document', 'CLA  Document')],
    ['trailing period', `${CLA}.`],
    ['trailing exclamation', `${CLA}!`],
    ['appended recheck', `${CLA}\nrecheck`],
    ['prepended greeting', `Hi,\n\n${CLA}`],
    ['appended qualification', `${CLA}\nfor this change only`],
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
      commentContainsSignature('I have read the Contributor Terms\n> I sign the CLA', phrase)
    ).toBe(false)
  })
})

describe('isCommentSignedByUser', () => {
  afterEach(resetEnv)

  it('rejects every GitHub Bot actor type', () => {
    expect(isCommentSignedByUser(CLA, 'renovate[bot]', 'Bot')).toBe(false)
    expect(isCommentSignedByUser(CLA, 'github-actions[bot]', 'Bot')).toBe(false)
  })

  it('does not reject a human account based only on its login spelling', () => {
    expect(isCommentSignedByUser(CLA, 'example[bot]', 'User')).toBe(true)
  })

  it('uses the CLA phrase by default', () => {
    expect(isCommentSignedByUser(CLA, 'alice', 'User')).toBe(true)
    expect(isCommentSignedByUser(DCO, 'alice', 'User')).toBe(false)
  })

  it('uses the DCO phrase when use-dco-flag is true', () => {
    setInput('use-dco-flag', 'true')
    expect(isCommentSignedByUser(DCO, 'alice', 'User')).toBe(true)
    expect(isCommentSignedByUser(CLA, 'alice', 'User')).toBe(false)
  })

  it('uses the custom phrase when configured', () => {
    setInput('custom-pr-sign-comment', 'I accept the terms')
    expect(isCommentSignedByUser('I accept the terms', 'alice', 'User')).toBe(
      true
    )
    expect(isCommentSignedByUser('I accept the terms.', 'alice', 'User')).toBe(
      false
    )
  })
})
