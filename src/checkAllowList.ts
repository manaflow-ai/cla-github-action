import * as core from '@actions/core'
import { Committer } from './interfaces'
import * as input from './shared/getInputs'

/**
 * Exempt only the identity authenticated by the live Pull Request API as the
 * opener, and only when its database ID is explicitly configured. GitHub may
 * map forgeable commit emails to account IDs, so a commit-derived ID alone is
 * never enough for an exemption.
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
    committer =>
      committer &&
      !(
        committer.isPullRequestOpener &&
        committer.id > 0 &&
        ids.has(committer.id)
      )
  )
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
