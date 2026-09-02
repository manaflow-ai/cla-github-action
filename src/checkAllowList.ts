import * as core from '@actions/core'
import { Committer } from './interfaces'
import * as input from './shared/getInputs'

/**
 * Exempt every identity whose GitHub database ID is explicitly configured,
 * whether it is the authenticated opener or a commit author. Configured IDs
 * are maintainers whose contributions are already covered, so a commit that
 * GitHub attributes to one of them needs no signature in any Pull Request.
 * Unlinked identities (id 0) can never match.
 */
export function checkAllowList(committers: Committer[]): Committer[] {
  const legacy = input.getAllowListItem().trim()
  if (legacy) {
    core.warning(
      "The deprecated 'allowlist' input is ignored because names, emails, and globs can be spoofed in commit metadata. Use 'allowlist-ids' only for authenticated Pull Request opener IDs."
    )
  }

  const { ids, invalid } = parseAllowListIds(input.getAllowListIds())
  if (invalid.length > 0) {
    core.warning(
      `Invalid allowlist-ids entries were ignored: ${invalid.join(', ')}`
    )
  }

  return committers.filter(
    committer => committer && !isAllowlistedId(committer.id, ids)
  )
}

/**
 * Check an authenticated live Pull Request opener against the numeric ID
 * allowlist. This decides whether the opener authorship guard may hard-fail.
 * Invalid configuration is ignored here; the normal filtering path reports
 * configuration warnings before it removes any contributor.
 */
export function isPullRequestOpenerAllowlisted(opener: {
  id: number
}): boolean {
  const { ids } = parseAllowListIds(input.getAllowListIds())
  return isAllowlistedId(opener.id, ids)
}

function isAllowlistedId(id: number, ids: Set<number>): boolean {
  return Number.isSafeInteger(id) && id > 0 && ids.has(id)
}

function parseAllowListIds(value: string): {
  ids: Set<number>
  invalid: string[]
} {
  const ids = new Set<number>()
  const invalid: string[] = []

  for (const raw of value.split(',')) {
    const entry = raw.trim()
    if (!entry) continue
    if (!/^\d+$/.test(entry)) {
      invalid.push(entry)
      continue
    }
    const id = Number(entry)
    if (!Number.isSafeInteger(id) || id <= 0) {
      invalid.push(entry)
      continue
    }
    ids.add(id)
  }

  return { ids, invalid }
}
