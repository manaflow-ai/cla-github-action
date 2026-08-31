/**
 * Parse Co-authored-by trailers from a commit message.
 *
 * A trailer looks like:
 *   Co-authored-by: Alice Example <alice@example.com>
 *
 * GitHub recognises this when rendering the "Co-authored by" avatars on a
 * commit. It is conventionally placed as a footer trailer (one per line,
 * after a blank line separating the body from the trailer block) but in
 * practice we accept it anywhere on a line.
 */

interface CoAuthor {
  name: string
  email: string
  /** GitHub login extracted from an @users.noreply.github.com email, if present. */
  noreplyLogin?: string
}

/**
 * Matches a single trailer. Case-insensitive on the 'co-authored-by' prefix
 * because git is forgiving about it. The name can contain spaces; the email
 * must be inside angle brackets and contain exactly one '@'.
 */
const TRAILER_RE = /^\s*co-authored-by:\s*(.+?)\s+<([^<>\s]+@[^<>\s]+)>\s*$/i

/**
 * Extract a GitHub login from an
 * @users.noreply.github.com email. Two shapes are supported:
 *   <id>+<login>@users.noreply.github.com
 *   <login>@users.noreply.github.com
 *
 * The numeric prefix is untrusted commit text. It is intentionally discarded.
 */
function parseNoreply(email: string): { login?: string } {
  const m = /^(.+)@users\.noreply\.github\.com$/i.exec(email)
  if (!m) return {}
  const local = m[1]!
  const plus = local.indexOf('+')
  if (plus < 0) return { login: local }
  const loginPart = local.slice(plus + 1)
  return { login: loginPart }
}

export function parseCoAuthors(message: string): CoAuthor[] {
  const seen = new Set<string>()
  const out: CoAuthor[] = []
  for (const rawLine of message.split(/\r?\n/)) {
    const m = TRAILER_RE.exec(rawLine)
    if (!m) continue
    const name = m[1]!.trim()
    const email = m[2]!.trim()
    const key = `${name.toLowerCase()}:${email.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    const noreply = parseNoreply(email)
    out.push({
      name,
      email,
      ...(noreply.login ? { noreplyLogin: noreply.login } : {})
    })
  }
  return out
}
