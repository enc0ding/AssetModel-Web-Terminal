# Recovery runbook — restoring AssetModel, CLV and ixprt from Vercel

Nothing on Vercel is to be deleted: the deployments there are the newest versions
of all three sites and are the recovery source. Two of the three lost their GitHub
repositories; the third (ixprt-site) still has its repository, and Vercel's
production deployment is built from that repository's `main` at `9b65020`, so a
Vercel download of it is a byte-for-byte check against GitHub rather than the only
copy. Recover all three anyway so every site is rebuilt from the same audited
process.

| Vercel project | Production deployment | Commit | Deleted repo |
| --- | --- | --- | --- |
| `assetmodel-web` (prj_nDUGu674YALesJiEohB0KTCqicy2) | `dpl_4BPrap2CmxSxup1JKuznTejN3yMw` (2026-08-22, paused) | `64d0299` "Recover AssetModel production source from Vercel" on `main` | `enc0ding/AssetModel` id 1342838712 |
| `clv-gg-app` (prj_aQm1oeuCaaZHmrL2gX2EnLXWN9jb) | `dpl_6EXeE7P9R2XX3So7ssrRmPcBcDSJ` (2026-08-14, live) | `ae0c3da` "fix(web): add problem-gambling helpline…" on `main` | `enc0ding/CLV.gg` id 1220593230 |
| `ixprt-site` (prj_UA278L5R58OiLD9eG0RCNh5VDG5I) | `dpl_6Wn4SPtf8aB8VPSZz9qRKwxjqeEY` (2026-08-13, live) | `9b65020` "Merge remote-tracking branch 'origin/main'" on `main` | `enc0ding/ixprt-site` id 1210538462 (still exists) |

The full deployment inventory (every branch head Vercel still holds, with commit
messages) is in `recovery/vercel-deployments.json`.

## Path A (preferred): restore the repositories on GitHub

GitHub keeps deleted repositories for 90 days. Settings → Repositories → *Deleted
repositories* → **Restore**. This returns full history, every branch listed in the
inventory, PRs, issues and Actions history. Rename the empty `enc0ding/AssetModel`
created on 2026-08-30 first, because it occupies the name.

After restoring, audit before trusting:

```bash
git clone git@github.com:enc0ding/CLV.gg
node tools/scan-source/scan-source.mjs CLV.gg --md clv-scan.md --fail-on none
git -C CLV.gg log --since=2026-08-01 --format='%h %ad %an <%ae> %s' --date=short
```

Look for commits from identities you do not recognise, commits after
2026-08-23, and anything the scanner marks HIGH.

## Path A′: push from a machine that still has a clone

Several production deployments were made with `vercel deploy` from a local checkout
(deployment metadata shows `actor: claude-code_…_agent` and `gitDirty: 1`, for
example `dpl_2y48eRPqaQS8EUmS9xycniyQxmY6` for CLV `main` at `af4e1a1` on
2026-08-15 and `dpl_GnHJiNNf2eHek4p9ZBHJ9wXue1j8` for AssetModel on 2026-08-13).
Any laptop or server that ran those has a complete git clone with full history.
`git remote set-url origin git@github.com:enc0ding/CLV-Web-Terminal.git && git push
--all` from there is the fastest full recovery, and it needs no token.

## Path B: download the source snapshot from Vercel

Vercel stores the source tree of every deployment. The Vercel MCP connector used in
the Claude session cannot read it (it only fetches deployment *output*), so this
needs a Vercel access token.

1. Vercel → Account Settings → Tokens → *Create*. Scope: the `psybourg's projects`
   team, expiry 1 day. Copy it once.
2. Run the recovery tool (Node ≥ 18, no dependencies):

```bash
export VERCEL_TOKEN=...            # never commit this, never paste it into chat
TEAM=team_w9arIt9t47jpM9nRkZSwxjGM

# AssetModel — production
node tools/vercel-recover/vercel-recover.mjs --deployment dpl_4BPrap2CmxSxup1JKuznTejN3yMw --team $TEAM --out recovered/assetmodel-prod

# CLV — production
node tools/vercel-recover/vercel-recover.mjs --deployment dpl_6EXeE7P9R2XX3So7ssrRmPcBcDSJ --team $TEAM --out recovered/clv-prod

# ixprt — production (compare against the GitHub repo afterwards)
node tools/vercel-recover/vercel-recover.mjs --deployment dpl_6Wn4SPtf8aB8VPSZz9qRKwxjqeEY --team $TEAM --out recovered/ixprt-prod
```

   Or recover a **whole project** in one run: production plus the newest READY
   deployment of every branch Vercel still holds, each into its own directory:

```bash
node tools/vercel-recover/vercel-recover.mjs --project prj_nDUGu674YALesJiEohB0KTCqicy2 --team $TEAM --out recovered/assetmodel   # AssetModel
node tools/vercel-recover/vercel-recover.mjs --project prj_aQm1oeuCaaZHmrL2gX2EnLXWN9jb --team $TEAM --out recovered/clv          # CLV
node tools/vercel-recover/vercel-recover.mjs --project prj_UA278L5R58OiLD9eG0RCNh5VDG5I --team $TEAM --out recovered/ixprt        # ixprt
```

   Output layout: `<out>/production/`, `<out>/branches/<branch>/`,
   `<out>/deployments.json` (the listing used) and `<out>/recovery-summary.json`.

   Network note: the tool talks only to `https://api.vercel.com`. A sandboxed
   agent session whose egress policy does not allow that host must run the tool
   elsewhere (your machine is fine; the tool has no dependencies).

   Add `--dry-run` first to list the tree without downloading. The tool writes
   `.vercel-recovery/manifest.json` (SHA-256 per file) and
   `.vercel-recovery/deployment.json` (the deployment metadata) beside the files.

3. Scan before you install or run anything:

```bash
node tools/scan-source/scan-source.mjs recovered/clv-prod --md clv-scan.md --fail-on none
```

   Read every HIGH finding. The recovered tree is untrusted until you have.

4. Commit into the terminal repository (this one), on a branch, and open a PR so
   CI, CodeQL and the Copilot review run over the recovered code before it
   becomes `main`:

```bash
rsync -a --exclude .vercel-recovery recovered/clv-prod/ ./
git checkout -b recover/clv-production-ae0c3da
git add -A && git commit -S -m "Recover CLV production source from Vercel deployment dpl_6EXeE7P9R2XX3So7ssrRmPcBcDSJ (ae0c3da)"
git push -u origin recover/clv-production-ae0c3da
```

5. Re-link Vercel: project Settings → Git → connect `enc0ding/CLV-Web-Terminal`
   (or `AssetModel-Web-Terminal`), production branch `main`. Re-enter every
   environment variable after rotating it. For `clv-gg-app` the Postgres host in
   `DATABASE_URL` no longer resolves; point it at the restored or new database
   before unpausing anything that depends on it.

6. Unpause `assetmodel-web` only after the recovered source has been scanned and
   reviewed. It was paused deliberately; leave it paused until then.

### Which deployments to recover

Production is the minimum. The inventory also lists feature branches Vercel still
holds (for CLV: `codex/fey-ui-overhaul`, `agent/fix/ci-book-health-pending-promise`,
`agent/chore/clv-only-separation`, `standalone-main`; for AssetModel:
`claude/assetmodel-audit-session-hardening` (PR #6), `claude/assetmodel-p0-audit-dk1ynm`
(PR #5), `claude/assetmodel-ixprt-api-jvtyjf` (PR #1), `agent/redesign/clearstreet`).
Recover each branch head you care about into its own directory and commit each on
its own branch; the manifests make the trees diffable.

## Hunting the sabotage in a recovered Next.js app

Run the scanner first, then read these by hand in this order; they are the places
where a small change controls everything:

1. `middleware.ts` / `proxy.ts` and its `matcher`: anything that fetches an
   external host, reads cookies or `Authorization`, or rewrites auth routes.
2. `instrumentation.ts` / `instrumentation-client.ts`: runs on every cold start
   and every page load respectively.
3. `next.config.*`: `rewrites`, `redirects`, `headers` (CSP), `images.domains`,
   `experimental.serverActions.allowedOrigins`, `env`.
4. `app/layout.tsx`, `app/terminal/layout.tsx`: `<Script>` tags, `dangerouslySetInnerHTML`,
   third-party providers.
5. `app/api/terminal/login/route.ts`, `lib/terminal/*auth*`, Clerk callbacks
   (`app/api/clerk/webhook`), `app/api/sharpsports/*`, `app/api/billing/*`:
   where credentials, sessions and money move.
6. `package.json` scripts and dependency sources, `pnpm-lock.yaml` resolved URLs,
   `.npmrc`, `pnpm-workspace.yaml`, `turbo.json` (`globalEnv`, `pipeline`),
   `.vercelignore`, `vercel.json`, `public/`.
7. `.github/workflows/*`, `.husky/*`, `scripts/*` run at build time.
8. Any file the scanner marks `inject.*` or `unicode.*`.

Diff against the previous production deployment (recover it too; the inventory
lists the IDs) — sabotage usually shows up as a small diff against a known-good
build: `diff -r recovered/clv/production recovered/clv-prev-prod | less`.

## Bringing the apps back online after recovery

Each project's build log names the environment variables the app reads. Set
them again **after rotating every value**; do not reuse the old ones.

| Project | Variables observed | Notes |
| --- | --- | --- |
| `clv-gg-app` | `DATABASE_URL`, `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SECRET`, `NEXT_PUBLIC_CLERK_*`, `INTERNAL_ADMIN_CLERK_USER_IDS`, `SHARPSPORTS_API_KEY`, `SHARPSPORTS_WEBHOOK_SECRET`, `SHARPSPORTS_ENABLE_EXTENSION_FLOW`, `NEXT_PUBLIC_SHARPSPORTS_PUBLIC_KEY`, `SPORTSDATAIO_API_KEY`, `ODDSPAPI_V5_API_KEY`, `OPENAI_API_KEY`, `SEER_API_BASE_URL`, `SEER_API_BASIC_AUTH`, `CLV_COPILOT_ENABLED`, Stripe keys for `/api/billing/*` | The Postgres host in `DATABASE_URL` has not resolved since 2026-08-18; provision or restore the database first, run the hand-authored migrations (`fix(db): run hand-authored migrations durably` on `standalone-main`), then redeploy. Add every variable to `turbo.json` `globalEnv` or the build warns they are invisible. |
| `assetmodel-web` | `DATABENTO_API_KEY`, `IXPRT_API_URL`, `IXPRT_API_TOKEN`, terminal session secret (HMAC key used by `/api/terminal/login`, name in `lib/terminal/*auth*`), prediction-markets vendor keys (`OPTICODDS_*` / `SHARPSPORTS_*` per the quality-card code) | Databento returned 401 from 2026-08-25: the key was revoked or rotated. Unpause only after scan + review. |
| `ixprt-site` | none at build time (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` only for the local blog drafter) | Already live. |

Then, per project: Settings → Git → connect the new repository, production
branch `main` → *Redeploy* production → check Runtime Logs for 5xx → re-enable
the custom domain if it was removed.

## Verifying a recovery later

```bash
node -e "import('./tools/vercel-recover/vercel-recover.mjs').then(async m=>{const p=await m.verify(process.argv[1]);console.log(p.length?p:'ok');process.exit(p.length?1:0)})" recovered/clv-prod
```
