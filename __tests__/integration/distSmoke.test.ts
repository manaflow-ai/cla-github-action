import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  startFakeGitHubHttp,
  FakeGitHubHttp
} from '../testHelpers/fakeGithubHttp'

const distPath = path.resolve(__dirname, '..', '..', 'dist', 'index.js')

function writeEventFile(payload: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-smoke-'))
  const file = path.join(dir, 'event.json')
  fs.writeFileSync(file, JSON.stringify(payload))
  return file
}

interface SpawnResult {
  code: number | null
  stdout: string
  stderr: string
}

function runDist(
  env: Record<string, string>,
  timeoutMs = 15000
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    // Start from a clean env so `NODE_ENV=test` from jest does NOT leak in and
    // disable the action's auto-run block at the bottom of src/main.ts.
    const child = spawn(process.execPath, [distPath], {
      env: { PATH: process.env.PATH || '', ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', c => out.push(c))
    child.stderr.on('data', c => err.push(c))

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`dist/index.js timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.on('exit', code => {
      clearTimeout(timer)
      resolve({
        code,
        stdout: Buffer.concat(out).toString('utf-8'),
        stderr: Buffer.concat(err).toString('utf-8')
      })
    })
  })
}

function defaultInputEnv(
  overrides: Record<string, string> = {}
): Record<string, string> {
  const base: Record<string, string> = {
    'INPUT_PATH-TO-SIGNATURES': 'signatures/cla.json',
    'INPUT_PATH-TO-DOCUMENT': 'https://example.com/cla',
    INPUT_BRANCH: 'main',
    'INPUT_REQUIRED-BASE-REF': 'main',
    'INPUT_EXPECTED-HEAD-SHA': '',
    'INPUT_EXPECTED-BASE-SHA': '',
    'INPUT_EXPECTED-COMMENT-ID': '',
    'INPUT_EXPECTED-COMMENT-CREATED-AT': '',
    'INPUT_EXPECTED-COMMENT-AUTHOR-ID': '',
    INPUT_ALLOWLIST: '',
    'INPUT_ALLOWLIST-IDS': '',
    'INPUT_USE-DCO-FLAG': 'false',
    'INPUT_LOCK-PULLREQUEST-AFTERMERGE': 'true'
  }
  return { ...base, ...overrides }
}

function githubEnv(
  fake: FakeGitHubHttp,
  params: {
    eventName: string
    eventPath: string
    repo?: string
    actor?: string
    workflow?: string
  }
): Record<string, string> {
  return {
    GITHUB_API_URL: fake.baseUrl,
    GITHUB_GRAPHQL_URL: `${fake.baseUrl}/graphql`,
    GITHUB_TOKEN: 'smoke-token',
    PERSONAL_ACCESS_TOKEN: 'smoke-pat',
    GITHUB_REPOSITORY: params.repo || 'acme/widgets',
    GITHUB_ACTOR: params.actor || 'alice',
    GITHUB_EVENT_NAME: params.eventName,
    GITHUB_EVENT_PATH: params.eventPath,
    GITHUB_WORKFLOW: params.workflow || 'cla-check'
  }
}

describe('Layer 4 smoke test: dist/index.js against HTTP fake', () => {
  let fake: FakeGitHubHttp

  beforeEach(async () => {
    fake = await startFakeGitHubHttp()
  })
  afterEach(async () => {
    await fake.close()
  })

  it('bundled action rejects a non-HTTPS document URL before GitHub writes', async () => {
    const repositoryId = fake.repo('acme', 'widgets').state.id
    fake.repo('acme', 'widgets').addPullRequest({
      number: 7,
      head: { sha: 'headsha', ref: 'feature/cla' },
      commits: [{ author: { login: 'alice', id: 1001 } }]
    })
    fake
      .repo('acme', 'widgets')
      .setFile('signatures/cla.json', { signedContributors: [] })
    const eventPath = writeEventFile({
      action: 'opened',
      pull_request: {
        number: 7,
        state: 'open',
        head: {
          sha: 'headsha',
          ref: 'feature/cla',
          repo: { id: repositoryId, full_name: 'acme/widgets' }
        },
        base: {
          ref: 'main',
          repo: { id: repositoryId, full_name: 'acme/widgets' }
        }
      },
      repository: { id: repositoryId, full_name: 'acme/widgets' }
    })

    const result = await runDist({
      ...defaultInputEnv({
        'INPUT_PATH-TO-DOCUMENT': 'http://example.com/cla'
      }),
      ...githubEnv(fake, { eventName: 'pull_request_target', eventPath })
    })

    expect(result.stdout).toMatch(
      /::error::.*path-to-document.*non-empty absolute HTTPS URL/i
    )
    expect(result.code).toBe(1)
    expect(fake.repo('acme', 'widgets').listComments(7)).toHaveLength(0)
  }, 20000)

  it('bundled action posts a notice comment and reports failure for an unsigned contributor', async () => {
    fake.repo('acme', 'widgets').addPullRequest({
      number: 7,
      head: { sha: 'headsha', ref: 'feature/cla' },
      commits: [{ author: { login: 'alice', id: 1001 } }]
    })
    fake
      .repo('acme', 'widgets')
      .setFile('signatures/cla.json', { signedContributors: [] })

    const eventPath = writeEventFile({
      action: 'opened',
      pull_request: {
        number: 7,
        state: 'open',
        head: {
          sha: 'headsha',
          ref: 'feature/test',
          repo: {
            id: fake.repo('acme', 'widgets').state.id,
            full_name: 'acme/widgets'
          }
        },
        base: {
          ref: 'main',
          repo: {
            id: fake.repo('acme', 'widgets').state.id,
            full_name: 'acme/widgets'
          }
        }
      },
      repository: {
        id: fake.repo('acme', 'widgets').state.id,
        full_name: 'acme/widgets'
      }
    })

    const result = await runDist({
      ...defaultInputEnv(),
      ...githubEnv(fake, { eventName: 'pull_request_target', eventPath })
    })

    // The GitHub Actions toolkit emits `::error::...` on stdout for setFailed,
    // which also sets the process exit code to 1.
    expect(result.stdout).toMatch(
      /::error::.*Committers of Pull Request number 7/
    )
    expect(result.code).toBe(1)

    const comments = fake.repo('acme', 'widgets').listComments(7)
    expect(comments).toHaveLength(1)
    expect(comments[0]!.body).toMatch(/CLA Assistant Lite bot/)
  }, 20000)

  it('bundled action writes a signature and leaves reruns to an exact-head workflow job', async () => {
    fake.repo('acme', 'widgets').addPullRequest({
      number: 7,
      head: { sha: 'headsha', ref: 'feature/cla' },
      commits: [{ author: { login: 'alice', id: 1001 } }]
    })
    fake
      .repo('acme', 'widgets')
      .setFile('signatures/cla.json', { signedContributors: [] })
    fake.repo('acme', 'widgets').addComment(7, {
      body: 'something **CLA Assistant Lite bot** says',
      user: { login: 'github-actions[bot]', id: 41898282, type: 'Bot' }
    })
    fake.repo('acme', 'widgets').addComment(7, {
      body: 'I have read the CLA Document and I hereby sign the CLA',
      user: { login: 'alice', id: 1001, type: 'User' }
    })
    fake
      .repo('acme', 'widgets')
      .addWorkflow('cla-check', [{ id: 777, conclusion: 'failure' }])

    const eventPath = writeEventFile({
      action: 'created',
      issue: { number: 7, state: 'open', pull_request: {} },
      comment: {
        body: 'I have read the CLA Document and I hereby sign the CLA',
        user: { login: 'alice', id: 1001, type: 'User' }
      },
      repository: {
        id: fake.repo('acme', 'widgets').state.id,
        full_name: 'acme/widgets'
      }
    })

    const result = await runDist({
      ...defaultInputEnv(),
      ...githubEnv(fake, { eventName: 'issue_comment', eventPath })
    })

    expect(result.code).toBe(0)

    const sigFile = fake
      .repo('acme', 'widgets')
      .getFile('signatures/cla.json') as any
    expect(sigFile.signedContributors.map((c: any) => c.name)).toContain(
      'alice'
    )

    expect(fake.recordedRerunRequests).toEqual([])
  }, 20000)

  it('bundled signer-preflight admits a contributor without write requests', async () => {
    const repository = fake.repo('acme', 'widgets')
    repository.addPullRequest({
      number: 17,
      head: { sha: 'headsha', ref: 'feature/preflight' },
      user: { login: 'alice', id: 1001 },
      commits: [{ author: { login: 'alice', id: 1001 } }]
    })
    const comment = repository.addComment(17, {
      body: 'I have read the CLA Document and I hereby sign the CLA',
      user: { login: 'alice', id: 1001, type: 'User' }
    })
    const eventPath = writeEventFile({
      action: 'created',
      issue: { number: 17, state: 'open', pull_request: {} },
      comment: {
        id: comment.id,
        body: comment.body,
        user: comment.user,
        created_at: comment.created_at,
        updated_at: comment.updated_at
      },
      repository: {
        id: repository.state.id,
        full_name: 'acme/widgets'
      }
    })

    const result = await runDist({
      ...defaultInputEnv({
        INPUT_MODE: 'signer-preflight',
        INPUT_BRANCH: 'cla-signatures'
      }),
      ...githubEnv(fake, {
        eventName: 'issue_comment',
        eventPath,
        actor: 'alice'
      })
    })

    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/signer_authorized::true/)
    expect(result.stdout).toMatch(/signer_decision::authorized/)
    expect(result.stdout).toMatch(/head_sha::headsha/)
    expect(result.stdout).toMatch(/base_sha::base-sha/)
    expect(result.stdout).toMatch(/comment_id::1/)
    expect(result.stdout).toMatch(/comment_created_at::/)
    expect(result.stdout).toMatch(/comment_author_id::1001/)
    expect(repository.listComments(17)).toHaveLength(1)
    expect(repository.getFile('signatures/cla.json')).toBeUndefined()
    expect(
      fake.requestLog.filter(request => {
        if (request.method === 'GET') return false
        return !(request.method === 'POST' && request.path.endsWith('/graphql'))
      })
    ).toEqual([])
  }, 20000)

  it('bundled action calls the lock endpoint on a merged PR close event', async () => {
    const repositoryId = fake.repo('acme', 'widgets').state.id
    fake.repo('acme', 'widgets').addPullRequest({
      number: 10,
      head: {
        sha: 'headsha',
        ref: 'feature/merged',
        apiRef: 'feature/merged'
      },
      user: { login: 'alice', id: 1001 },
      merged: true,
      state: 'closed',
      commits: [{ author: { login: 'alice', id: 1001 } }]
    })
    const eventPath = writeEventFile({
      action: 'closed',
      pull_request: {
        number: 10,
        state: 'closed',
        merged: true,
        head: {
          sha: 'headsha',
          ref: 'feature/merged',
          repo: { full_name: 'acme/widgets', id: repositoryId }
        },
        base: {
          ref: 'main',
          repo: { full_name: 'acme/widgets', id: repositoryId }
        },
        user: { login: 'alice', id: 1001 }
      },
      repository: { id: repositoryId, full_name: 'acme/widgets' }
    })

    const result = await runDist({
      ...defaultInputEnv(),
      ...githubEnv(fake, { eventName: 'pull_request_target', eventPath })
    })

    expect(result.code).toBe(0)
    expect(fake.recordedLocks).toEqual([
      { owner: 'acme', repo: 'widgets', issue: 10 }
    ])
  }, 20000)
})
