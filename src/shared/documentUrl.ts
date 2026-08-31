import { getPathToDocument } from './getInputs'

const INVALID_DOCUMENT_URL =
  "The 'path-to-document' input must be a non-empty absolute HTTPS URL"

export function requireHttpsDocumentUrl(): string {
  const documentUrl = getPathToDocument()
  let parsed: URL

  try {
    parsed = new URL(documentUrl)
  } catch {
    throw new Error(INVALID_DOCUMENT_URL)
  }

  if (
    !/^https:\/\//i.test(documentUrl) ||
    parsed.protocol !== 'https:' ||
    !parsed.hostname
  ) {
    throw new Error(INVALID_DOCUMENT_URL)
  }

  return documentUrl
}
