# Secure Contribution Workflow

This repository runs `dist/index.js` as a GitHub Action. Workflow and release
files can grant tokens or select code to execute, so review them as privileged
changes. CODEOWNERS routes the security-sensitive paths to the designated
maintainers.

## Contributor checklist

- Set `permissions: {}` at workflow level. Grant only the documented scopes on
  the job that needs them. Never use `write-all`.
- Pin every external action to a full 40-character commit SHA. Verify that the
  SHA resolves to the intended upstream commit. Keep a release comment for
  maintenance, but do not treat a tag or comment as the pin.
- Keep `pull_request` jobs unprivileged. Do not check out or execute
  Pull Request code in a `pull_request_target` or `workflow_run` job that has
  write access. If a privileged worker is necessary, validate the event,
  repository, ref, and exact commit before writing.
- Pass untrusted event values through environment variables and quote shell
  expansions. Do not interpolate `${{ ... }}` directly into a `run` command.
- Keep the generated `dist/` bundle synchronized with `src/` and review both
  in the same change.
- Do not put secrets in logs, artifacts, issue comments, or generated files.
- Preserve branch protection and CODEOWNERS. Do not bypass a failed required
  check by changing its name or trigger.
- Follow the reporting process in [SECURITY.md](SECURITY.md) for suspected
  vulnerabilities. Do not disclose them in a public issue.

## Maintainer checklist

- Review workflow, action, dependency, policy, and bundle changes through the
  CODEOWNERS assignments.
- Confirm each changed action SHA resolves to the intended release. Run
  actionlint and the project test suite.
- Re-check token permissions and event trust after every workflow change.
- Rotate or revoke credentials if a workflow may have exposed one.
