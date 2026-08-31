import { context } from '@actions/github'
import { Committer } from './interfaces'
import { octokit } from './octokit'
import { errorMessage } from './shared/errors'

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
      commits: {
        totalCount: number
        edges: GraphQLEdge[]
        pageInfo: { endCursor: string | null; hasNextPage: boolean }
      }
    }
  }
}

const COMMITS_QUERY = `
query($owner:String! $name:String! $number:Int! $cursor:String){
    repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
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
 * author is always first. Trailer-derived actors remain assertions, so callers
 * require a current-PR signature for every node after index zero.
 */
export default async function getCommitters(): Promise<Committer[]> {
  try {
    const committers = new Map<string, Committer>()

    const addActor = (
      actor: GraphQLActor | null | undefined,
      requiresCurrentSignature = false
    ): void => {
      if (!actor) {
        addCommitter(committers, {
          name: 'Unknown Git identity',
          id: 0,
          pullRequestNo: context.issue.number,
          requiresCurrentSignature
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
        requiresCurrentSignature
      })
    }

    let cursor: string | null = null
    let hasNextPage = true

    while (hasNextPage) {
      const response = (await octokit.graphql(COMMITS_QUERY, {
        owner: context.repo.owner,
        name: context.repo.repo,
        number: context.issue.number,
        cursor
      })) as GraphQLResponse

      const page = response.repository.pullRequest.commits
      for (const edge of page.edges) {
        const commit = edge.node.commit
        if (commit.authors.pageInfo.hasNextPage) {
          throw new Error(
            'A commit has more than 100 authors. The action cannot verify every identity and will fail closed.'
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

        addActor(commit.author)
        commit.authors.nodes.slice(1).forEach(actor => addActor(actor, true))
        addActor(commit.committer)
      }

      cursor = page.pageInfo.endCursor
      hasNextPage = page.pageInfo.hasNextPage
    }

    return [...committers.values()]
  } catch (e) {
    throw new Error(
      `GraphQL call to get commit identities failed: ${errorMessage(e)}`
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

  // If any occurrence is a trailer assertion, keep the stricter rule after
  // deduplication. Also retain the best available diagnostic email.
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
