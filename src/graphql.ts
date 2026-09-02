import { context } from '@actions/github'
import { Committer } from './interfaces'
import { octokit } from './octokit'
import { errorMessage, withGitHubApiError } from './shared/errors'
import {
  MAX_AUTHORS_PER_COMMIT,
  MAX_GIT_IDENTITY_ASSERTIONS,
  MAX_PULL_REQUEST_COMMITS
} from './shared/limits'

interface GraphQLUser {
  databaseId?: number | null
  login?: string | null
}

interface GraphQLActor {
  email?: string | null
  name?: string | null
  user?: GraphQLUser | null
}

interface GraphQLAuthorsConnection {
  nodes: Array<GraphQLActor | null>
  pageInfo: { endCursor: string | null; hasNextPage: boolean }
}

interface GraphQLCommit {
  author?: GraphQLActor | null
  authors: GraphQLAuthorsConnection
  committer?: GraphQLActor | null
}

interface GraphQLEdge {
  node: { commit: GraphQLCommit }
  cursor: string
}

interface GraphQLResponse {
  repository: {
    pullRequest: {
      headRefOid: string | null
      commits: {
        totalCount: number
        edges: GraphQLEdge[]
        pageInfo: { endCursor: string | null; hasNextPage: boolean }
      }
    }
  }
}

type CommitIdentityRole = 'primaryAuthor' | 'coAuthor' | 'committer'

// Bound work on untrusted Pull Request data. These limits are well above a
// normal contribution but stop a single PR from consuming an unbounded number
// of GraphQL pages or creating an unbounded signature set.
const COMMITS_QUERY = `
query($owner:String! $name:String! $number:Int! $cursor:String){
    repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
            headRefOid
            commits(first: 100, after: $cursor) {
                totalCount
                edges {
                    node {
                        commit {
                            author {
                                email
                                name
                                user { databaseId login }
                            }
                            authors(first: 100) {
                                nodes {
                                    email
                                    name
                                    user { databaseId login }
                                }
                                pageInfo { endCursor hasNextPage }
                            }
                            committer {
                                email
                                name
                                user { databaseId login }
                            }
                        }
                    }
                    cursor
                }
                pageInfo { endCursor hasNextPage }
            }
        }
    }
}`

/**
 * GitHub's Commit.authors connection is the identity source for the primary
 * author and Co-authored-by trailers. GitHub documents that the primary git
 * author is always first. Every actor in git metadata remains an assertion,
 * even when GitHub maps its email to an account. Callers require a current-PR
 * signature unless the live Pull Request API independently authenticates the
 * same account as the opener. Committer metadata does not qualify an opener
 * for the author/co-author guard.
 */
export default async function getCommitters(
  expectedHeadSha: string
): Promise<Committer[]> {
  try {
    if (!expectedHeadSha.trim()) {
      throw new Error(
        'The live Pull Request head commit is missing; refusing to query commit identities'
      )
    }
    const committers = new Map<string, Committer>()

    const addActor = (
      actor: GraphQLActor | null | undefined,
      role: CommitIdentityRole
    ): void => {
      const roles = {
        isPrimaryAuthor: role === 'primaryAuthor',
        isCoAuthor: role === 'coAuthor',
        isCommitter: role === 'committer',
        requiresCurrentSignature: true
      }
      if (!actor) {
        addCommitter(committers, {
          name: 'Unknown Git identity',
          id: 0,
          pullRequestNo: context.issue.number,
          ...roles
        })
        return
      }

      const id = actor.user?.databaseId || 0
      const email = actor.email?.trim() || undefined
      const name =
        actor.user?.login?.trim() ||
        actor.name?.trim() ||
        email ||
        'Unknown Git identity'
      addCommitter(committers, {
        name,
        id,
        pullRequestNo: context.issue.number,
        ...(id ? {} : email ? { email } : {}),
        ...roles
      })
    }

    let cursor: string | null = null
    let hasNextPage = true
    let observedCommitCount = 0
    let reportedCommitCount: number | null = null
    let identityAssertionCount = 0
    const seenCursors = new Set<string>()

    while (hasNextPage) {
      const response = (await withGitHubApiError('graphql.committers', () =>
        octokit.graphql(COMMITS_QUERY, {
          owner: context.repo.owner,
          name: context.repo.repo,
          number: context.issue.number,
          cursor
        })
      )) as GraphQLResponse

      const pullRequest = response?.repository?.pullRequest
      if (
        !pullRequest ||
        typeof pullRequest.headRefOid !== 'string' ||
        pullRequest.headRefOid.length === 0 ||
        pullRequest.headRefOid !== expectedHeadSha
      ) {
        throw new Error(
          'GraphQL Pull Request head commit does not match the live Pull Request head; refusing to use unbound commit identities'
        )
      }
      const page = pullRequest.commits
      if (
        !Number.isSafeInteger(page.totalCount) ||
        page.totalCount < 0 ||
        page.totalCount > MAX_PULL_REQUEST_COMMITS
      ) {
        throw new Error(
          `A Pull Request reports more than ${MAX_PULL_REQUEST_COMMITS} commits or an invalid commit count. The action will fail closed.`
        )
      }
      if (
        reportedCommitCount !== null &&
        page.totalCount !== reportedCommitCount
      ) {
        throw new Error(
          'GitHub changed the reported commit count during pagination. The action will fail closed.'
        )
      }
      reportedCommitCount = page.totalCount
      observedCommitCount += page.edges.length
      for (const edge of page.edges) {
        const commit = edge.node.commit
        if (commit.authors.pageInfo.hasNextPage) {
          throw new Error(
            `A commit has more than ${MAX_AUTHORS_PER_COMMIT} authors. The action cannot verify every identity and will fail closed.`
          )
        }
        if (!commit.author || commit.authors.nodes.length === 0) {
          throw new Error(
            'GitHub returned a commit without an author identity. The action will fail closed.'
          )
        }
        if (!actorsMatch(commit.author, commit.authors.nodes[0])) {
          throw new Error(
            'GitHub returned an author connection that did not start with the primary author. The action will fail closed.'
          )
        }

        identityAssertionCount += commit.authors.nodes.length + 1
        if (identityAssertionCount > MAX_GIT_IDENTITY_ASSERTIONS) {
          throw new Error(
            `A Pull Request reports more than ${MAX_GIT_IDENTITY_ASSERTIONS} git identity assertions. The action will fail closed.`
          )
        }

        addActor(commit.author, 'primaryAuthor')
        commit.authors.nodes
          .slice(1)
          .forEach(actor => addActor(actor, 'coAuthor'))
        addActor(commit.committer, 'committer')
      }

      hasNextPage = page.pageInfo.hasNextPage
      if (hasNextPage) {
        const nextCursor = page.pageInfo.endCursor
        if (!nextCursor || seenCursors.has(nextCursor)) {
          throw new Error(
            'GitHub returned invalid commit pagination. The action will fail closed.'
          )
        }
        seenCursors.add(nextCursor)
        cursor = nextCursor
      }
    }

    if (
      observedCommitCount === 0 ||
      observedCommitCount > MAX_PULL_REQUEST_COMMITS ||
      observedCommitCount !== reportedCommitCount
    ) {
      throw new Error(
        `A Pull Request reports no commits, incomplete pagination, or more than ${MAX_PULL_REQUEST_COMMITS} commits. The action will fail closed.`
      )
    }

    return [...committers.values()]
  } catch (e) {
    throw new Error(
      `GraphQL call to get commit identities failed: ${errorMessage(e)}`,
      { cause: e }
    )
  }
}

function addCommitter(
  committers: Map<string, Committer>,
  incoming: Committer
): void {
  const key = identityKey(incoming)
  const current = committers.get(key)
  if (!current) {
    committers.set(key, incoming)
    return
  }

  current.isPrimaryAuthor = Boolean(
    current.isPrimaryAuthor || incoming.isPrimaryAuthor
  )
  current.isCoAuthor = Boolean(current.isCoAuthor || incoming.isCoAuthor)
  current.isCommitter = Boolean(current.isCommitter || incoming.isCommitter)
  // Every git role is attacker-controlled metadata. Dedupe must never relax
  // the current-signature rule. The authenticated live opener is added later.
  current.requiresCurrentSignature = Boolean(
    current.requiresCurrentSignature || incoming.requiresCurrentSignature
  )
  if (!current.email && incoming.email) current.email = incoming.email
}

function identityKey(committer: Committer): string {
  if (committer.id > 0) return `id:${committer.id}`
  if (committer.email) return `email:${committer.email.toLowerCase()}`
  return `unknown:${committer.name.toLowerCase()}`
}

function actorsMatch(
  left: GraphQLActor,
  right: GraphQLActor | null | undefined
): boolean {
  if (!right) return false
  const leftId = left.user?.databaseId
  const rightId = right.user?.databaseId
  if (leftId && rightId) return leftId === rightId
  const leftEmail = left.email?.trim().toLowerCase()
  const rightEmail = right.email?.trim().toLowerCase()
  return Boolean(leftEmail && rightEmail && leftEmail === rightEmail)
}
