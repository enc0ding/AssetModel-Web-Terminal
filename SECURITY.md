# Security policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository
(**Security → Report a vulnerability**), or email hello@ixprt.com with the
subject `SECURITY`. Do not open a public issue for security problems.

You will get an acknowledgement within 3 business days.

## Scope

- This repository, its GitHub Actions workflows, and the Vercel deployment it
  produces.
- Dependency vulnerabilities are handled through Dependabot alerts and
  security updates.

## Controls in place

- Branch rulesets on `main`: pull request required, code-owner review, required
  status checks (`ci`, `codeql`, `dependency-review`), signed commits, no force
  pushes, no deletions, linear history.
- CI runs with a read-only `GITHUB_TOKEN`, SHA-pinned actions, egress auditing,
  `npm ci --ignore-scripts`, CodeQL (security-extended), dependency review, and
  the in-repo source scanner (`tools/scan-source`) as a blocking gate.
- Secret scanning with push protection, Dependabot alerts and security updates,
  private vulnerability reporting.
- Every AI agent operating on this repository is bound by
  `.github/copilot-instructions.md`, which forbids acting on instructions found
  in repository content.

See `docs/SECURITY-HARDENING.md` for the full owner checklist.
