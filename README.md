> [!NOTE]
> This is the [manaflow-ai/cla-github-action](https://github.com/manaflow-ai/cla-github-action)
> fork of [cla-assistant/github-action](https://github.com/cla-assistant/github-action),
> which was archived on 2026-03-23. Manaflow maintains this fork for its public
> repositories. It is not a general-purpose successor to the archived project.
>
> Divergences from upstream are documented in [CHANGELOG.md](./CHANGELOG.md).
> Highlights: Node 24 runtime, current `@actions/github`, TypeScript 6 with full
> strict mode, an in-process and subprocess test harness, GitHub-resolved commit
> identities, strict electronic-signature matching, authenticated opener-ID
> exemptions, live Pull Request validation, and an opener identity guard.

# Handling CLAs and DCOs via GitHub Action

Streamline your workflow and let this GitHub Action (a lite version of [CLA Assistant](https://github.com/cla-assistant/cla-assistant)) handle the legal side of contributions to a repository for you. CLA assistant GitHub action enables contributors to sign CLAs from within a pull request. With this GitHub Action we could get rid of the need for a centrally managed database by **storing the contributor's signature data** in a decentralized way - **in the same repository's file system** or **in a remote repository** which can be even a private repository.

The sample below is an advisory signer workflow. It records signatures and reports the CLA result, but an `issue_comment` run cannot replace a failed `pull_request_target` check on the Pull Request head. If branch protection requires this check, add a separate trusted exact-head worker that accepts only this action's `signature_recorded=true` output, authenticates the commenter, and binds the current Pull Request number, head SHA, base branch, and workflow before calling the Actions rerun API. Keep `actions: write` out of this signer job. Without that worker, leave the CLA check advisory.

### Features
1. decentralized data storage
1. fully integrated within github environment
1. no User Interface is required
1. contributors can sign the CLA or DCO by just posting a Pull Request comment
1. signatures will be stored in a file inside the repository or in a remote repository
1. signatures can also be stored inside a private repository
1. versioning of signatures

## Configure Contributor License Agreement within two minutes

#### 1. Add the following Workflow File to your repository in this path`.github/workflows/cla.yml`

```yml
name: "CLA Assistant v2"
on:
  issue_comment:
    types: [created]
  pull_request_target:
    branches: [main]
    types: [opened,edited,closed,reopened,synchronize]

permissions: {}

jobs:
  CLACommentGate:
    if: >-
      (github.event_name == 'pull_request_target' &&
      (github.event.action == 'opened' || github.event.action == 'edited' ||
      github.event.action == 'closed' || github.event.action == 'reopened' ||
      github.event.action == 'synchronize')) ||
      (github.event_name == 'issue_comment' &&
      github.event.action == 'created' &&
      github.event.comment.user.type == 'User' &&
      github.event.comment.user.id > 0 &&
      github.event.issue.state == 'open' && github.event.issue.pull_request &&
      (github.event.comment.body == 'recheck' ||
      github.event.comment.body == 'I have read the CLA Document and I hereby sign the CLA'))
    name: "CLA Comment Gate"
    runs-on: ubuntu-latest
    timeout-minutes: 2
    permissions: {}
    concurrency:
      group: cla-admission-${{ github.repository }}-${{ github.event_name }}-${{ github.event.issue.number || github.event.pull_request.number }}
      cancel-in-progress: false
    steps:
      - name: "Validate exact CLA comment"
        if: github.event_name == 'issue_comment'
        shell: bash
        env:
          COMMENT_BODY: ${{ github.event.comment.body }}
          SIGN_PHRASE: I have read the CLA Document and I hereby sign the CLA
        run: |
          if [[ "$COMMENT_BODY" != "recheck" && "$COMMENT_BODY" != "$SIGN_PHRASE" ]]; then
            echo "::error::Comment must match the recheck command or signing declaration exactly."
            exit 1
          fi

  CLAAssistant:
    name: "CLA Assistant v2"
    needs: CLACommentGate
    if: always() && needs.CLACommentGate.result == 'success'
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: write # this can be read if signatures are in a remote repository
      issues: write
      pull-requests: write
    # Advisory signer only. A separate trusted exact-head worker is required
    # when this check is required by branch protection. Serialize signer runs
    # for one Pull Request. A separate lock job uses the
    # distinct cla-lock group documented below and validates the live PR too.
    concurrency:
      group: cla-signatures-${{ github.repository }}-${{ github.event.pull_request.number || github.event.issue.number }}
      # Keep cancellation disabled. GitHub retains one running and one
      # pending run for this group. CLACommentGate rejects case variants and
      # arbitrary comments before this privileged queue.
      cancel-in-progress: false
    steps:
      - name: "CLA Assistant v2"
        # Pin to a full 40-character commit SHA, not a tag — see "Pinning by commit SHA" below.
        uses: manaflow-ai/cla-github-action@76fc8306627c4f89d1d53e2d6fe8faf2087c013a
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          # Only set this token for a remote signature repository. Prefer a
          # fine-grained token limited to that repository with Contents read
          # and write access.
          # PERSONAL_ACCESS_TOKEN: ${{ secrets.PERSONAL_ACCESS_TOKEN }}
        with:
          path-to-signatures: 'signatures/version1/cla.json'
          path-to-document: '<REPLACE_WITH_CLA_URL>' # Required absolute HTTPS URL
          # Initialize this branch, then restrict writes to trusted CLA automation.
          branch: 'cla-signatures'
          required-base-ref: 'main'
          require-opener-as-author: 'true'
          # Add allowlist-ids only for a documented automated PR opener, using
          # that opener's numeric GitHub account ID. Never allowlist a name or
          # email from commit metadata.

         # the followings are the optional inputs - If the optional inputs are not given, then default values will be taken
          #remote-organization-name: enter the remote organization name where the signatures should be stored (Default is storing the signatures in the same repository)
          #remote-repository-name: enter the  remote repository name where the signatures should be stored (Default is storing the signatures in the same repository)
          #create-file-commit-message: 'For example: Creating file for storing CLA Signatures'
          #signed-commit-message: 'For example: $contributorName has signed the CLA in $owner/$repo#$pullRequestNo'
          #custom-notsigned-prcomment: 'pull request comment with Introductory message to ask new contributors to sign'
          #custom-pr-sign-comment: 'The signature to be committed in order to sign the CLA'
          # If set, replace the default declaration in the job `if` guard with this exact text.
          #custom-allsigned-prcomment: 'pull request comment when all contributors has signed, defaults to **CLA Assistant Lite bot** All Contributors have signed the CLA.'
          #lock-pullrequest-aftermerge: false - if you don't want this bot to automatically lock the pull request after merging (default - true)
          #use-dco-flag: true - If you are using DCO instead of CLA
          #require-opener-as-author: false - if your workflow involves submitters legitimately opening PRs containing only commits authored by others (cherry-picks, release engineering). Default is true.

```

Replace `<REPLACE_WITH_CLA_URL>` with the non-empty absolute HTTPS URL of the CLA or DCO. The action rejects an empty, relative, or non-HTTPS value before it makes a GitHub write.

The `CLACommentGate` job admits the listed `pull_request_target` lifecycle actions and filtered new `issue_comment` events from a GitHub `User` with a positive account ID. It has no write permission. Its bounded concurrency group separates each repository, event class, and Pull Request. Its `if` guard filters most comments, but GitHub expression equality is case-insensitive. The shell step runs for comments and is the authority for the required case-sensitive comparison. The advisory `CLAAssistant` signer requires gate success for both event classes and enters its own signer concurrency group only after the gate succeeds. A required-check deployment also needs the separate trusted exact-head worker described above. If you set `custom-pr-sign-comment`, replace the default declaration in the gate `if` guard and `SIGN_PHRASE` with that custom text. If you set `use-dco-flag: true`, replace both with `I have read the DCO Document and I hereby sign the DCO`. Keep `recheck` as the separate exact alternative. Do not broaden the signer job to run for every issue comment.

GitHub workflow event admission cannot compare a comment body case-sensitively. The unprivileged gate must start a runner to reject a case variant. GitHub keeps only one pending run in each concurrency group, so a same-PR case variant can replace one pending gate run before the exact shell check. It cannot enter the privileged signer queue. The contributor must post the exact comment again when this occurs. A high-volume public repository needs a trusted webhook or GitHub App classifier, or an external rate limit, when this fairness or runner-resource denial-of-service risk is material.

The shell step and the action compare the raw comment body and do not trim whitespace. Contributors must post the declaration with no leading or trailing whitespace for it to count as an electronic signature. Keep the `pull_request_target.branches` filter and `required-base-ref` input set to the same protected branch. The event filter avoids unnecessary runs; the action input revalidates the live base branch before a write or lock.

This version accepts signing and `recheck` only on newly created comments. A declaration comment must have matching GitHub creation and update timestamps. A comment edited into the declaration stays invalid on a later `recheck`. The workflow does not trigger on `issue_comment` `edited` events. The `pull_request_target` `edited` lifecycle event is admitted for the action's live validation. Do not add an issue-comment `edited` trigger unless a later action version validates the edited event and the exact updated declaration at runtime.

The sample lets any authenticated human Pull Request commenter use `recheck` only to refresh this action. Do not reuse that condition for a job with `actions: write` or another privileged queue operation. A separate rerun worker must authenticate the commenter, then bind the request to the current Pull Request number, head SHA, workflow file, and base branch. The signer sample remains advisory until that worker is installed.

The action exposes `signature_recorded=true` only after it persists a new signature. A separate rerun worker may use that output to refresh the exact failed check for the same Pull Request. Do not authorize a rerun from an arbitrary signing comment when this output is false.

The action publishes an all-signed bot comment only after it revalidates the signing comments and persists any new signatures. If a signer edits or deletes the declaration during the run, the ledger and the previous trusted bot status stay unchanged.

If the signature ledger does not exist, the first run creates an empty ledger and leaves any declaration from that run pending. Post a new `recheck` comment after the ledger exists. The action then validates and records the prior exact declaration before it publishes all-signed status.

If two Pull Requests try to create the first ledger together, the losing run makes at most three safe reads. It continues only when a read confirms a valid ledger. Otherwise it fails closed. An unsigned contributor stays pending, and a valid signing declaration can reach all-signed status only after the confirmed ledger records it.

The action re-fetches accepted signing comments immediately before a ledger write. It rejects a comment that was edited, deleted, or moved to another identity during the run. GitHub does not provide one transaction for comments and repository contents, so a short race remains between this final check and the ledger write.

> [!IMPORTANT]
> **Pinning by commit SHA**
>
> The `uses:` line above references this action by its **full 40-character commit
> SHA**, not by a version tag like `@v3.0.0`. This is intentional and strongly
> recommended for all third-party GitHub Actions.
>
> Git tags are mutable: a maintainer (or a compromised maintainer account) can
> retarget `v3.0.0` to a different commit at any time, silently changing what
> code runs in your CI with full access to `GITHUB_TOKEN`. A commit SHA is
> content-addressed and immutable — once you have audited the code at that SHA,
> it cannot change underneath you. See
> [Why you should pin GitHub Actions by commit hash](https://blog.rafaelgss.dev/why-you-should-pin-actions-by-commit-hash)
> and GitHub's own
> [security hardening guide](https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions#using-third-party-actions)
> for the full rationale.
>
> **To find the SHA to pin to:**
>
> ```bash
> # Latest commit on master:
> git ls-remote https://github.com/manaflow-ai/cla-github-action.git refs/heads/master
> ```
>
> Or browse to the [releases page](https://github.com/manaflow-ai/cla-github-action/releases)
> or [commits page](https://github.com/manaflow-ai/cla-github-action/commits/master),
> pick a commit, and copy the full SHA. After pinning, add the human-readable
> reference as a trailing comment so future readers know what they're looking at:
>
> ```yaml
> uses: manaflow-ai/cla-github-action@bc206ed9b52ad0b0cbe85244ce522e5e9b65c10e
> ```
>
> Tools like [Dependabot](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/keeping-your-actions-up-to-date-with-dependabot)
> and [Renovate](https://docs.renovatebot.com/modules/manager/github-actions/)
> understand this format and will open PRs to bump the SHA when a newer commit
> is available, preserving the comment.


##### Demo for step 1

![add-cla-file](https://github.com/cla-assistant/github-action/blob/master/images/adding-clafile.gif?raw=true)

#### 2. Pull Request event triggers CLA Workflow

CLA action workflow will be triggered on Pull Request `opened, edited, closed, reopened, synchronize` events. This workflow will always run in the base repository and that's why we are making use of the [pull_request_target](https://docs.github.com/en/actions/reference/events-that-trigger-workflows#pull_request_target) event. The action validates the live Pull Request state, opener, base repository ID, base branch, head repository ID, head branch, and head commit before it writes signature data.

The action fails closed for every unlinked committer, including metadata that claims to be `GitHub <noreply@github.com>` or `web-flow`. Git names and email addresses are not authenticated and can be forged. `allowlist-ids` cannot match an unresolved identity.

GitHub can map an author, co-author, or committer email to an account ID, but this mapping does not authenticate authorship. Every non-opener identity from git metadata must post the exact declaration on the current Pull Request. A stored signature is reusable only for the account authenticated by the live Pull Request API as the opener. A committer-only match does not satisfy the opener author/co-author guard.
<br/> When the CLA workflow is triggered on pull request `closed` event and the Pull Request was merged, it will lock the Pull Request conversation with GitHub's `resolved` reason so that the contributors cannot modify or delete the signatures (Pull Request comment) later. The action re-fetches the closed Pull Request and matches its immutable base repository, base branch, opener, and merge state. A later source branch advance or deletion does not prevent locking. This feature is optional. A failed lock request fails the action. The action never removes a conversation lock. A maintainer must unlock a reopened Pull Request before contributors can sign.

The action fails closed when a Pull Request has more than 1,000 commits, more than 101,000 git identity assertions, or more than 1,000 comments. The identity bound is the finite envelope of 1,000 commits with up to 100 author/co-author identities plus one committer assertion per commit. A signature ledger also fails closed above 10,000 entries or 1,000,000 bytes. The byte limit matches the GitHub Contents API limit and applies before reads and writes. These limits bound work on untrusted Pull Request and ledger data. Split a larger contribution or start a new versioned ledger before running the CLA check.

#### 3. Signing the CLA

CLA workflow creates a comment on Pull Request asking contributors who have not signed  CLA to sign and also fails the pull request status check with a `failure`. Contributors must post a new comment with **"I have read the CLA Document and I hereby sign the CLA"** as the full raw Pull Request comment body. Leading or trailing whitespace, blank lines, case changes, wording changes, punctuation, and internal whitespace changes do not count. An edited `issue_comment` does not trigger the workflow, and an edited declaration remains invalid. Put `recheck` in a separate new comment. Only a comment author that GitHub identifies as a `User` with a positive numeric account ID can sign. Bot, organization, mannequin, missing-type, and invalid-ID actors fail closed.
If the contributor has already signed the CLA, then the PR status will pass with `success`. <br/>

This action does not rerun an earlier workflow after it records a signature. Repositories that need an immediate required-check update must use a separate trusted job. That job must authenticate the exact signing event, bind the rerun to the current Pull Request number, head commit SHA, workflow file, and base branch, and then call the Actions rerun API. The sample signer has no `actions: write` permission and is advisory for `issue_comment` runs by design.

The action does not automatically retry GitHub API requests. A transient GitHub failure fails the current run, which can then be rerun after GitHub recovers. This avoids duplicate comments or ledger writes when GitHub completed a state change but its response was lost.

##### Demo for step 2 and 3

![signature-process](https://github.com/cla-assistant/github-action/blob/master/images/signature-process.gif?raw=true)

<br/>

#### 4. Signatures stored in a JSON file

After the contributor signed a CLA, the contributor's signature with metadata will be stored in a JSON file inside the repository and you can specify the custom path to this file with `path-to-signatures` input in the workflow. <br/> The default path is `path-to-signatures: 'signatures/version1/cla.json'`.

Protect the signature ledger from normal collaborator writes. Use a repository ruleset that permits only the trusted CLA automation identity, or store the ledger in a private repository where only that identity can write. The action token or configured App/PAT must have permission to update the protected target.

If you split merged-pull-request locking into another job, keep the signer group as `cla-signatures-${{ github.repository }}-${{ github.event.pull_request.number || github.event.issue.number }}` and give the lock job the distinct `cla-lock-${{ github.repository }}-${{ github.event.pull_request.number || github.event.issue.number }}` group. Set `cancel-in-progress: false` in both groups. The lock and signer jobs may overlap, but each must validate the live Pull Request immediately before its write. Separate groups prevent a pending lock run from replacing a signer run.

Ledger entries do not contain a CLA document hash or terms version. If the CLA text changes, use a new ledger path and signing declaration, and require contributors to sign again. Without this policy, an old ledger entry cannot prove which document version the contributor accepted.

The signature can be also stored in a remote repository which can be done by enabling the optional inputs `remote-organization-name`: `<your org name>`
and `remote-repository-name`: `<your repo name>` in your CLA workflow file.

**NOTE:** You do not need to create this file manually. Our workflow will create the signature file if it does not already exist. Manually creating this file will cause the workflow to fail.

##### Demo for step 4

![signature-storage-file](https://github.com/cla-assistant/github-action/blob/master/images/signature-storage-file.gif?raw=true)

#### 5. Authenticated opener ID allowlist

Use `allowlist-ids` only when a specific automated Pull Request opener must be exempt. Values are comma-separated numeric GitHub database IDs. The action applies an exemption only when the live Pull Request API authenticates that ID as the opener. It never exempts an author, co-author, or committer derived only from git metadata. The deprecated `allowlist` name, email, and glob input is ignored because commit metadata can spoof those values.

##### Demo for step 5

![allowlist](https://github.com/cla-assistant/github-action/blob/master/images/allowlist.gif?raw=true)

#### 6. Adding Personal Access Token as a Secret

Do not configure `PERSONAL_ACCESS_TOKEN` when signatures stay in the current repository. For a remote signature repository, create a [repository secret](https://docs.github.com/en/actions/security-guides/encrypted-secrets#creating-encrypted-secrets-for-a-repository) with that name. Prefer a fine-grained token limited to the remote repository with Contents read and write access. A classic `repo` token is broader than necessary and should be used only when the target cannot use a fine-grained token.

##### Demo for step 6

![personal-access-token](https://github.com/cla-assistant/github-action/blob/master/images/personal-access-token.gif?raw=true)

### Environmental Variables:


| Name                  | Requirement | Description |
| --------------------- | ----------- | ----------- |
| `GITHUB_TOKEN`        | _required_ | Usage: `GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}`,  CLA Action uses this in-built GitHub token to make the API calls for interacting with GitHub. It is built into Github Actions and does not need to be manually specified in your secrets store. [More Info](https://help.github.com/en/actions/configuring-and-managing-workflows/authenticating-with-the-github_token)|
| `PERSONAL_ACCESS_TOKEN` | _optional_ | Required only for a remote signature repository. Use a fine-grained token limited to that repository with Contents read and write access, and store it as `PERSONAL_ACCESS_TOKEN`. |

### Inputs Description:

| Name                  | Requirement | Description | Example |
| --------------------- | ----------- | ----------- | ------- |
| `path-to-document`     | _required_ | Non-empty absolute HTTPS URL of the CLA or DCO document. The action validates it before any GitHub write. | `<REPLACE_WITH_CLA_URL>` |
| `path-to-signatures`       | _optional_ |  Path to the JSON file where  all the signatures of the contributors will be stored inside the repository. | signatures/version1/cla.json |
| `branch`   | _optional_ |  Branch in which all the signatures of the contributors will be stored and Default branch is `master`.  | master |
| `required-base-ref`   | _optional_ | Only a Pull Request with this live base branch can write signature data or be locked after merge. The compatibility default is empty, which accepts any base branch and emits a runtime warning. Set this input explicitly for protected use. | main |
| `allowlist-ids`   | _optional_ | Comma-separated numeric GitHub user IDs. Only the authenticated live Pull Request opener can be exempt. Commit-derived identities are never exempt. | Leave empty unless a documented automated opener was reviewed. |
| `allowlist`   | _deprecated_ | Ignored. Raw names, emails, and globs are unsafe identity evidence. | |
| `remote-repository-name`   | _optional_ | provide the remote repository name where all the signatures should be stored . | remote repository name |
| `remote-organization-name`   | _optional_ | provide the remote organization name where all the signatures should be stored. | remote organization name |
| `create-file-commit-message`   | _optional_ |Commit message when a new CLA file is created. | Creating file for storing CLA Signatures. |
| `signed-commit-message`   | _optional_ | Commit message when a new contributor signs the CLA in a Pull Request. |  $contributorName has signed the CLA in $pullRequestNo |
| `custom-notsigned-prcomment`   | _optional_ | Introductory Pull Request comment to ask new contributors to sign. | Thank you for your contribution and please kindly read and sign our $pathToCLADocument |
| `custom-pr-sign-comment`   | _optional_ | The signature to be committed in order to sign the CLA. | I have read the Developer Terms Document and I hereby accept the Terms |
| `custom-allsigned-prcomment`   | _optional_ | pull request comment when everyone has signed | All Contributors have signed the CLA. |
| `lock-pullrequest-aftermerge`   | _optional_ | Boolean input for locking the pull request after merging. Default is set to `true`.  It is highly recommended to lock the Pull Request after merging so that the Contributors won't be able to revoke their signature comments after merge | false |
| `suggest-recheck`   | _optional_ | Boolean input for indicating if the action's comment should suggest that users comment `recheck`. Default is set to `true`. | false |
| `use-dco-flag`   | _optional_ | Boolean input. Set to `true` to run the action in DCO (Developer Certificate of Origin) mode instead of CLA mode. The bot's prompts and persistence logic use DCO wording. Default is `false`. | true |
| `require-opener-as-author`   | _optional_ | Boolean input. When `true` (the default), fail the check if the Pull Request opener is not recorded as an author or co-author of any commit. Committer metadata does not qualify. Set to `false` for legitimate cherry-pick or patch-submission workflows. | false |

### Outputs

| Name                  | Description |
| --------------------- | ----------- |
| `opener_not_in_commits` | Set to `'true'` when the Pull Request opener is not recorded as an author or co-author of any commit in the PR. Emitted regardless of whether `require-opener-as-author` caused the check to fail. |
| `signature_recorded` | Set to `'true'` only after this run persists a new signature in the ledger. |

## Contributors

<!-- readme: collaborators,contributors -start -->
<table>
<tr>
    <td align="center">
        <a href="https://github.com/iainmcgin">
            <img src="https://avatars.githubusercontent.com/u/309153?v=4" width="100;" alt="iainmcgin"/>
            <br />
            <sub><b>Iain McGinniss</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/ibakshay">
            <img src="https://avatars.githubusercontent.com/u/33329946?v=4" width="100;" alt="ibakshay"/>
            <br />
            <sub><b>Akshay Iyyadurai Balasundaram</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/michael-spengler">
            <img src="https://avatars.githubusercontent.com/u/43786652?v=4" width="100;" alt="michael-spengler"/>
            <br />
            <sub><b>Michael Spengler</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/AnandChowdhary">
            <img src="https://avatars.githubusercontent.com/u/2841780?v=4" width="100;" alt="AnandChowdhary"/>
            <br />
            <sub><b>Anand Chowdhary</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/kingthorin">
            <img src="https://avatars.githubusercontent.com/u/7570458?v=4" width="100;" alt="kingthorin"/>
            <br />
            <sub><b>Rick M</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/Writhe">
            <img src="https://avatars.githubusercontent.com/u/2022097?v=4" width="100;" alt="Writhe"/>
            <br />
            <sub><b>Filip Moroz</b></sub>
        </a>
    </td></tr>
<tr>
    <td align="center">
        <a href="https://github.com/mmv08">
            <img src="https://avatars.githubusercontent.com/u/16622558?v=4" width="100;" alt="mmv08"/>
            <br />
            <sub><b>Mikhail</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/manifestinteractive">
            <img src="https://avatars.githubusercontent.com/u/508411?v=4" width="100;" alt="manifestinteractive"/>
            <br />
            <sub><b>Peter Schmalfeldt</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/mattrosno">
            <img src="https://avatars.githubusercontent.com/u/1691245?v=4" width="100;" alt="mattrosno"/>
            <br />
            <sub><b>Matt Rosno</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/Or-Geva">
            <img src="https://avatars.githubusercontent.com/u/9606235?v=4" width="100;" alt="Or-Geva"/>
            <br />
            <sub><b>Or Geva</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/pellared">
            <img src="https://avatars.githubusercontent.com/u/5067549?v=4" width="100;" alt="pellared"/>
            <br />
            <sub><b>Robert Pająk</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/ScottBrenner">
            <img src="https://avatars.githubusercontent.com/u/416477?v=4" width="100;" alt="ScottBrenner"/>
            <br />
            <sub><b>Scott Brenner</b></sub>
        </a>
    </td></tr>
<tr>
    <td align="center">
        <a href="https://github.com/silviogutierrez">
            <img src="https://avatars.githubusercontent.com/u/92824?v=4" width="100;" alt="silviogutierrez"/>
            <br />
            <sub><b>Silvio</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/azzamsa">
            <img src="https://avatars.githubusercontent.com/u/17734314?v=4" width="100;" alt="azzamsa"/>
            <br />
            <sub><b>Azzam S.A</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/Tropicao">
            <img src="https://avatars.githubusercontent.com/u/4692087?v=4" width="100;" alt="Tropicao"/>
            <br />
            <sub><b>Alexis Lothoré</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/alohr51">
            <img src="https://avatars.githubusercontent.com/u/3623618?v=4" width="100;" alt="alohr51"/>
            <br />
            <sub><b>Andrew Lohr</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/aymanbagabas">
            <img src="https://avatars.githubusercontent.com/u/3187948?v=4" width="100;" alt="aymanbagabas"/>
            <br />
            <sub><b>Ayman Bagabas</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/fishcharlie">
            <img src="https://avatars.githubusercontent.com/u/860375?v=4" width="100;" alt="fishcharlie"/>
            <br />
            <sub><b>Charlie Fish</b></sub>
        </a>
    </td></tr>
<tr>
    <td align="center">
        <a href="https://github.com/darrellwarde">
            <img src="https://avatars.githubusercontent.com/u/8117355?v=4" width="100;" alt="darrellwarde"/>
            <br />
            <sub><b>Darrell Warde</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/Holzhaus">
            <img src="https://avatars.githubusercontent.com/u/1834516?v=4" width="100;" alt="Holzhaus"/>
            <br />
            <sub><b>Jan Holthuis</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/nwalters512">
            <img src="https://avatars.githubusercontent.com/u/1476544?v=4" width="100;" alt="nwalters512"/>
            <br />
            <sub><b>Nathan Walters</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/rokups">
            <img src="https://avatars.githubusercontent.com/u/19151258?v=4" width="100;" alt="rokups"/>
            <br />
            <sub><b>Rokas Kupstys</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/shunkakinoki">
            <img src="https://avatars.githubusercontent.com/u/39187513?v=4" width="100;" alt="shunkakinoki"/>
            <br />
            <sub><b>Shun Kakinoki</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/simonmeggle">
            <img src="https://avatars.githubusercontent.com/u/1897410?v=4" width="100;" alt="simonmeggle"/>
            <br />
            <sub><b>Simon Meggle</b></sub>
        </a>
    </td></tr>
<tr>
    <td align="center">
        <a href="https://github.com/t8">
            <img src="https://avatars.githubusercontent.com/u/20846869?v=4" width="100;" alt="t8"/>
            <br />
            <sub><b>Tate Berenbaum</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/Krinkle">
            <img src="https://avatars.githubusercontent.com/u/156867?v=4" width="100;" alt="Krinkle"/>
            <br />
            <sub><b>Timo Tijhof</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/AndrewGable">
            <img src="https://avatars.githubusercontent.com/u/2838819?v=4" width="100;" alt="AndrewGable"/>
            <br />
            <sub><b>Andrew Gable</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/knanao">
            <img src="https://avatars.githubusercontent.com/u/50069775?v=4" width="100;" alt="knanao"/>
            <br />
            <sub><b>Knanao</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/tada5hi">
            <img src="https://avatars.githubusercontent.com/u/13162758?v=4" width="100;" alt="tada5hi"/>
            <br />
            <sub><b>Peter</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/wh201906">
            <img src="https://avatars.githubusercontent.com/u/62299611?v=4" width="100;" alt="wh201906"/>
            <br />
            <sub><b>Self Not Found</b></sub>
        </a>
    </td></tr>
<tr>
    <td align="center">
        <a href="https://github.com/woxiwangshunlibiye">
            <img src="https://avatars.githubusercontent.com/u/106640041?v=4" width="100;" alt="woxiwangshunlibiye"/>
            <br />
            <sub><b>Woyaoshunlibiye </b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/yahavi">
            <img src="https://avatars.githubusercontent.com/u/11367982?v=4" width="100;" alt="yahavi"/>
            <br />
            <sub><b>Yahav Itzhak</b></sub>
        </a>
    </td></tr>
</table>
<!-- readme: collaborators,contributors -end -->

## License

Contributor License Agreement assistant

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
