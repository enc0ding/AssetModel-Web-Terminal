# Incident report — ixprt / AssetModel / CLV.gg web properties, 2026-09-03

Prepared from a read-only audit of the Vercel team `psybourg's projects` and the
GitHub account `enc0ding`, performed through the Vercel and GitHub connectors in a
sandboxed Claude Code session. Every artifact fetched from the sites was treated as
untrusted data; nothing from the deployments was executed.

## Summary

| Property | State found | Root cause of outage | Malicious code found | Action taken |
| --- | --- | --- | --- | --- |
| ixprt.com (`ixprt-site`) | 503 `DEPLOYMENT_PAUSED` | Vercel project was **paused** | **None** in the production commit, repository history, dependencies, or live HTML | Production commit audited, then project **unpaused**; site serving again with all security headers |
| assetmodel.com (`assetmodel-web`) | 503 `DEPLOYMENT_PAUSED` | Project paused; linked GitHub repo `enc0ding/AssetModel` (id 1342838712) **deleted** | Cannot be established: source not readable through the connector | Left paused; deployment inventory captured; recovery tooling shipped |
| app.clv.gg (`clv-gg-app`) | Live, degraded | Linked GitHub repo `enc0ding/CLV.gg` (id 1220593230) **deleted**; production Postgres host unresolvable since 2026-08-18 | Live HTML is clean (first-party Clerk only, no foreign scripts). Source not readable through the connector | Left running; inventory captured; recovery tooling shipped |

## Evidence: ixprt-site is clean

Production deployment `dpl_6Wn4SPtf8aB8VPSZz9qRKwxjqeEY` is built from `main` at
`9b65020` (2026-08-13). That exact commit was cloned and examined:

- **Scripts.** 44 pages carry one identical inline analytics shim plus
  `/_vercel/insights/script.js`; the homepage has one hero-video controller;
  blog pages share one TOC highlighter; `/contact` builds a `mailto:`;
  `/products/diagest` fetches `https://diagest.ixprt.com/api/v1/summary`
  (allowed by CSP); `/widgets/agent-feed.js` reads
  `https://dailywallstreet.com/api/agent-feed` with a strict URL allow-list.
  No `eval`, `atob`, `Function`, `document.write`, external `<script src>`,
  iframes, meta-refresh, or base64 blobs anywhere.
- **Headers.** `vercel.json` sets CSP (`default-src 'self'`, no `unsafe-eval`),
  `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`;
  the live response carries them.
- **Text surfaces read by AI systems** (`llms.txt`, `robots.txt`, `/answers`,
  JSON-LD, HTML comments, blog Markdown, the drafting agent's prompt
  templates) contain no imperative instructions aimed at models.
- **Dependencies.** 52 lockfile packages, all resolved from
  `registry.npmjs.org`, none with install scripts. `npm ci --ignore-scripts`,
  `npm test` (9/9), `npm run build:check` (generated output matches sources) and
  `validate:seo` all pass.
- **History.** 123 commits, authors are the owner's three identities plus one
  scaffold commit by `Prometheus <agent@ixprt.local>` (2026-04-13, README and
  `.gitignore` only). Only collaborator on every repository: `enc0ding` (admin).
- **Branches/PRs.** PR #8 "Enable Aikido Security plugin" (2026-08-24) would
  have added `.claude/settings.json` enabling a plugin marketplace; it is
  **closed, unmerged**. `copilot/secure-site-configuration` (Copilot agent run,
  2026-08-31) points at the same commit as `main` with no changes.
- **Scanner.** `tools/scan-source` reports 0 high / 0 medium on the tree.

Conclusion: ixprt.com was down because someone paused the project, not because
its content was tampered with. Whether the pause was defensive (you) or hostile
(an attacker with Vercel access) is answerable from Vercel's **Team Settings →
Activity/Audit log**; check it.

## Evidence: what is *not* clean

1. **Two repositories were deleted from GitHub.** Deleting a repository requires
   admin on the repo, which only the account owner or a token/app with
   `delete_repo` had. If you did not delete `CLV.gg` and `AssetModel`, the
   account (a password/session, a PAT, an OAuth app, or a GitHub App
   installation) was used by someone else. GitHub's security log
   (`repo.destroy`) will show the actor, IP and token. This is the single most
   important finding.
2. **The CLV production database disappeared on 2026-08-18.** Runtime logs show
   `getaddrinfo ENOTFOUND db-pgsql-nyc3-03972-do-user-37680663-0.g.db.ondigitalocean.com`
   across 140+ requests up to 2026-08-30 for `/api/public/historical-proof`,
   `/api/public/sample-edges`, `/api/sharpsports/webhook`,
   `/api/billing/founding-counter` and the root RSC user lookup. Either the
   DigitalOcean cluster was deleted/renamed, or the DigitalOcean account is
   part of the incident.
3. **AssetModel's Databento key stopped working** (`401`, 22 requests
   2026-08-25 → 08-29, plus "not configured" on the PR-6 preview). Consistent
   with a key rotation or revocation; harmless by itself but rotate it anyway.
4. **The AssetModel repository was already a recovery.** Its production commit
   is literally "Recover AssetModel production source from Vercel" (2026-08-22),
   preceded by an "Initialize repository for source recovery" commit whose build
   failed. This incident had an earlier episode around 2026-08-22.
5. **A new, empty `enc0ding/AssetModel` was created on 2026-08-30** with a single
   "Initial commit". Vercel's `assetmodel-web` project still records repo id
   1342838712, so the new repo is not linked and will not deploy. Rename or
   delete it before restoring the original from GitHub's deleted-repositories
   page.

## Timeline (UTC)

| When | Event |
| --- | --- |
| 2026-08-13 | Last `main` push to `ixprt-site` (`9b65020`), deployed to production |
| 2026-08-14 | `clv-gg-app` production `ae0c3da` deployed; CLV branch work continues through 08-15 |
| 2026-08-18 | CLV Postgres host stops resolving |
| 2026-08-22 | `assetmodel-web`: "Initialize repository for source recovery" (build error) then "Recover AssetModel production source from Vercel" promoted to production |
| 2026-08-22 → 08-23 | AssetModel PRs #1, #5, #6 (Claude-authored hardening/audit work) deploy previews |
| 2026-08-23 | CLV `codex/fey-ui-overhaul` branch: 9 preview deployments in 4 hours by "Codex <codex@openai.com>" (last one 11:15 UTC). This is the last activity Vercel saw from the `CLV.gg` repo |
| 2026-08-24 | `ixprt-site` PR #8 (Aikido plugin) opened by Claude session; closed unmerged |
| 2026-08-30 | New empty `enc0ding/AssetModel` created; last CLV runtime errors recorded |
| 2026-08-31 | Copilot coding agent run on `ixprt-site` (branch `copilot/secure-site-configuration`, no diff) |
| between 08-23 and 09-03 | `CLV.gg` and original `AssetModel` repos deleted; `ixprt-site` and `assetmodel-web` projects paused |
| 2026-09-03 04:20 | Owner creates empty `AssetModel-Web-Terminal` (public) and `CLV-Web-Terminal` (private) |
| 2026-09-03 04:34 | `ixprt-site` unpaused; ixprt.com serving |

## What could not be done from this session, and why

- **Pulling AssetModel/CLV source from Vercel.** The Vercel connector exposes
  deployment metadata, logs and rendered output, but not the source-file
  endpoints (`/v6/deployments/{id}/files`, `/v8/deployments/{id}/files/{uid}`),
  which need a bearer token. `tools/vercel-recover` is ready for the moment a
  token exists; `docs/RECOVERY-RUNBOOK.md` has the two commands.
- **Changing GitHub account settings** (2FA, tokens, OAuth apps, rulesets,
  Actions policy, deleted-repo restore). These are owner-only; the repo-level
  ones are scripted in `scripts/github-harden.sh`, the rest are in
  `docs/SECURITY-HARDENING.md`.
- **Reaching the custom domains directly.** The sandbox's egress policy blocks
  arbitrary hosts; verification went through the `*.vercel.app` production
  aliases, which serve the same deployment.

## Recommendations, in priority order

1. Contain the GitHub account (section 0 of `docs/SECURITY-HARDENING.md`).
2. Restore `CLV.gg` and `AssetModel` from GitHub's deleted repositories page
   (90-day window) — or run the Vercel recovery with a token.
3. Read the GitHub security log and the Vercel audit log to learn *who* deleted
   and paused what; rotate whatever credential they used.
4. Rotate every secret the three projects hold; point CLV at a working database.
5. Apply `scripts/github-harden.sh` to every repository and merge the hardening
   branches so future agent work is gated by PR review, CodeQL, dependency
   review, secret scanning and the source scanner.
