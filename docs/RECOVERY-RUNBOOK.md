# Recovery runbook — restoring AssetModel and CLV from Vercel

Two production sites lost their GitHub repositories:

| Vercel project | Production deployment | Commit | Deleted repo |
| --- | --- | --- | --- |
| `assetmodel-web` (prj_nDUGu674YALesJiEohB0KTCqicy2) | `dpl_4BPrap2CmxSxup1JKuznTejN3yMw` (2026-08-22, paused) | `64d0299` "Recover AssetModel production source from Vercel" on `main` | `enc0ding/AssetModel` id 1342838712 |
| `clv-gg-app` (prj_aQm1oeuCaaZHmrL2gX2EnLXWN9jb) | `dpl_6EXeE7P9R2XX3So7ssrRmPcBcDSJ` (2026-08-14, live) | `ae0c3da` "fix(web): add problem-gambling helpline…" on `main` | `enc0ding/CLV.gg` id 1220593230 |

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
```

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

## Verifying a recovery later

```bash
node -e "import('./tools/vercel-recover/vercel-recover.mjs').then(async m=>{const p=await m.verify(process.argv[1]);console.log(p.length?p:'ok');process.exit(p.length?1:0)})" recovered/clv-prod
```
