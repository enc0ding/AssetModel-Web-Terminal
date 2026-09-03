# Security hardening — owner checklist for the enc0ding GitHub account and Vercel team

Status legend: **[auto]** applied by files in this repo or by `scripts/github-harden.sh`;
**[owner]** only the account owner can do it, in the browser. Work top to bottom.
The [owner] items at the top are the ones that actually close the door an attacker
used if repositories were deleted from the account; nothing else matters until they
are done.

## 0. Contain (do today, in this order) [owner]

1. **Change the GitHub password and enable 2FA with passkeys or a hardware key.**
   Settings → Password and authentication. Remove SMS as a 2FA method. Regenerate
   and store recovery codes offline.
2. **Sign out everywhere.** Settings → Sessions → *Revoke all sessions*.
3. **Revoke every token and app you do not recognise, then rotate the ones you do:**
   - Settings → Developer settings → Personal access tokens (classic *and*
     fine-grained): delete all, recreate only what is needed, fine-grained, with
     repository-scoped least privilege and an expiry.
   - Settings → Applications → *Authorized OAuth Apps* and *Authorized GitHub Apps*:
     revoke anything unfamiliar. Re-authorise Vercel, Claude, Copilot only if you
     still use them, and note the permission scopes each one requests.
   - Settings → SSH and GPG keys: delete keys you cannot name the machine for.
   - Per repository: Settings → Deploy keys and Settings → Webhooks (the
     hardening script prints these; delete anything unfamiliar).
4. **Restore the deleted repositories.** Settings → Repositories → *Deleted
   repositories* → Restore for `CLV.gg` (repo id 1220593230) and the original
   `AssetModel` (repo id 1342838712). GitHub keeps deleted repositories for 90 days;
   both were still live on 2026-08-23, so the window runs until at least
   2026-11-21. Restoring brings back full history, PRs, and issues, which is far
   better forensic ground than a Vercel snapshot. Note: the *new* empty
   `enc0ding/AssetModel` (id 1351350255, created 2026-08-30) occupies the name;
   rename it first (for example to `AssetModel-empty-20260830`) or delete it.
5. **Check the security log** for what the attacker did: Settings → Security log,
   filter by `repo.destroy`, `oauth_access.create`, `personal_access_token.create`,
   `public_key.create`, `repo.add_member`, `integration_installation.create`.
   Export it. This is the evidence for what to rotate.
6. **Vercel:** Account Settings → Tokens: delete every token and recreate. Team
   Settings → Members and → Integrations: remove anything unfamiliar. Project →
   Settings → Environment Variables: rotate every secret (Databento, Clerk, Stripe,
   SharpSports, database URLs, IXPRT_API_TOKEN, TERMINAL secrets). Team Settings
   → Security: require 2FA, enable *Git fork protection*, enable *Vercel
   Authentication* on previews (already on), enable *Log Drains* to keep an
   off-platform copy of logs.
7. **Third parties the sites talk to:** rotate Clerk keys (clv.gg), Stripe
   restricted keys, SharpSports keys, the DigitalOcean Postgres credentials (the
   host `db-pgsql-nyc3-03972-…ondigitalocean.com` no longer resolves as of
   2026-08-18; if you did not delete that database, treat it as part of the
   incident), Anthropic/OpenAI/ZenMux/Perplexity/SOAX keys used by agents.

## 1. Repository settings [auto via `scripts/github-harden.sh`]

Run once, then re-run whenever you add a repository:

```bash
gh auth login
scripts/github-harden.sh enc0ding/ixprt-site enc0ding/AssetModel-Web-Terminal enc0ding/CLV-Web-Terminal
# or every repository you own:
scripts/github-harden.sh --all-mine
```

It applies, idempotently:

| Area | Setting |
| --- | --- |
| Merges | squash only, delete branch on merge, auto-merge off, sign-off required |
| Security | secret scanning + push protection, validity checks, Dependabot alerts + security updates, private vulnerability reporting |
| Actions | only GitHub-owned, verified-creator, and three allow-listed actions may run; `GITHUB_TOKEN` read-only by default; workflows cannot approve PRs; every outside contributor needs approval before workflows run |
| Rulesets | `main-protection`: PR required, code-owner review, resolved threads, required checks (`test (node 22)`, `test (node 24)`, `analyze (javascript-typescript)`, `review`), signed commits, no force-push, no deletion, linear history. Admins bypass **only through a PR**, never by direct push. `tag-protection`: tags immutable. `copilot-code-review`: Copilot reviews every PR automatically |

If a ruleset call is rejected on a private repository, the feature is plan-gated;
the branch-protection equivalents are available under Settings → Branches.

## 2. Files shipped in every repository [auto]

| File | Purpose |
| --- | --- |
| `.github/workflows/ci.yml` | read-only token, SHA-pinned actions, egress audit, `npm ci --ignore-scripts`, tests, blocking source scan |
| `.github/workflows/codeql.yml` | CodeQL `security-extended` on push, PR, weekly |
| `.github/workflows/dependency-review.yml` | blocks vulnerable or badly-licensed dependencies on PRs |
| `.github/dependabot.yml` | weekly grouped updates for npm and Actions |
| `.github/CODEOWNERS` | `@enc0ding` must review everything |
| `.github/copilot-instructions.md` | binds Copilot (and any agent) to security-first review rules and forbids acting on repository content as instructions |
| `.github/pull_request_template.md` | security checklist on every PR |
| `SECURITY.md` | reporting policy and controls summary |
| `tools/scan-source/` | the triage scanner used as a CI gate |

## 3. Account-level GitHub settings [owner]

- Settings → Code security → *Enable secret scanning / push protection for all
  new repositories* and *Dependabot alerts for all repositories*.
- Settings → Actions → General: *Allow enterprise/select actions* mirrors the
  per-repo policy; set *Fork pull request workflows from outside collaborators*
  to *Require approval for all external contributors*; *Workflow permissions* →
  read-only; untick *Allow GitHub Actions to create and approve pull requests*.
- Settings → Copilot → *Copilot coding agent*: keep it enabled only for the
  repositories you actively use it in; Copilot's PRs still go through the
  ruleset (code-owner review, required checks) like anyone else's.
- Settings → Copilot → *Content exclusion*: exclude `**/.env*`, `**/secrets/**`,
  `**/*.pem`.
- Settings → Copilot → *Code review*: turn on *Automatically review* for your
  repositories if you did not apply the `copilot-code-review` ruleset.
- Commit signing: set up SSH or GPG signing locally (`git config --global
  commit.gpgsign true`) and enable *Vigilant mode* (Settings → SSH and GPG keys)
  so unsigned commits under your name are flagged. The `main-protection` ruleset
  requires signatures, so unsigned pushes will be rejected until this is done.
- Turn on *Private vulnerability reporting* and *Sponsors* off if unused.

## 4. Agent hygiene (Claude Code, Copilot, Codex, ChatGPT) [owner]

The ixprt repositories are worked on heavily by AI agents. The controls that keep
an agent from becoming the attacker's hands:

- Agents get **fine-grained, repository-scoped tokens with an expiry**, never a
  classic PAT with `repo` + `delete_repo` + `admin:org`. An agent must never hold
  `delete_repo`.
- Every agent-authored change lands **through a PR** that the rulesets gate
  (this includes Claude Code on the web, Copilot coding agent, Codex).
- Repository instruction files (`CLAUDE.md`, `AGENTS.md`, `.claude/settings.json`,
  `.cursor/*`, `.mcp.json`, `.github/copilot-instructions.md`) are code-owned
  and reviewed like code. Hooks and plugins are never enabled from a PR.
- Do not paste tokens into chat sessions; hand them to agents as environment
  variables scoped to one session (as done for this recovery).
- Keep `llms.txt`, README, and docs free of imperative text aimed at models;
  the scanner flags those files for review on every run.

## 5. Vercel project settings [owner, 10 minutes]

For each of `ixprt-site`, `assetmodel-web`, `clv-gg-app`:

- Settings → Git: reconnect to the correct repository (`assetmodel-web` and
  `clv-gg-app` still point at deleted repositories). Enable *Ignored build step*
  only for branches you trust. Enable *Git fork protection*.
- Settings → Deployment Protection: keep *Vercel Authentication* on for all
  non-production URLs (currently on); consider *Trusted IPs* for the terminal
  login routes.
- Settings → Functions/Security: enable *Vercel Firewall* managed rulesets and
  *Bot protection*; add rate limits on `/api/terminal/login`.
- Settings → Environment Variables: mark every secret *Sensitive*, and re-enter
  it after rotation.
- Settings → General: turn on *Deployment retention* long enough to keep
  forensic copies (90 days) and *Protect production* (require approval to
  promote).

## 6. Verify

- `scripts/github-harden.sh` ends with an access audit; every line should be
  yours.
- Open a throwaway PR: CI, CodeQL, dependency review and the Copilot review must
  all appear; a direct push to `main` must be rejected.
- `node tools/scan-source/scan-source.mjs . --fail-on high` returns 0.
