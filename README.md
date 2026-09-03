# AssetModel Web Terminal

Home for the **AssetModel** website and quant terminal (assetmodel.com), currently
deployed from the Vercel project `assetmodel-web`
(`prj_nDUGu674YALesJiEohB0KTCqicy2`, team `psybourg's projects`).

## Why this repository exists

The original `enc0ding/AssetModel` repository (GitHub id 1342838712) was deleted.
Vercel still holds every deployment, including production
(`dpl_4BPrap2CmxSxup1JKuznTejN3yMw`, commit `64d0299`, Next.js 16 / pnpm 10, 25
routes including the auth-gated `/terminal` and `/api/terminal/*`). The project is
**paused** on Vercel until the recovered source has been scanned and reviewed.

This repository ships the kit to bring the code back safely and to keep future
work from being tampered with again:

| Path | What it is |
| --- | --- |
| `tools/vercel-recover/` | downloads a deployment's full source tree from Vercel (needs a token), writes SHA-256 manifest |
| `tools/scan-source/` | static triage scanner: obfuscation, exfiltration, shells, prompt injection, hidden DOM text, supply-chain, CI, secrets, invisible Unicode, config |
| `recovery/vercel-deployments.json` | inventory of every deployment Vercel still holds, with commit SHAs and branch names |
| `docs/RECOVERY-RUNBOOK.md` | the two recovery paths (GitHub deleted-repo restore, or Vercel download) step by step |
| `docs/INCIDENT-REPORT-2026-09-03.md` | what was found across ixprt.com, assetmodel.com and app.clv.gg |
| `docs/SECURITY-HARDENING.md` | owner checklist: contain the account, rotate, restore, harden |
| `scripts/github-harden.sh` | idempotent `gh api` script applying rulesets, Actions policy, secret scanning, Dependabot |
| `.github/` | SHA-pinned, read-only-token CI with the scanner as a blocking gate; CodeQL; dependency review; Dependabot; CODEOWNERS; Copilot review instructions |

## Recover the site

```bash
npm test                                   # 13 tests, no dependencies
cp .env.example .env && $EDITOR .env       # VERCEL_TOKEN (short expiry)
set -a; . ./.env; set +a
npm run recover -- --deployment dpl_4BPrap2CmxSxup1JKuznTejN3yMw --team team_w9arIt9t47jpM9nRkZSwxjGM --out recovered/assetmodel-prod
node tools/scan-source/scan-source.mjs recovered/assetmodel-prod --md scan.md --fail-on none
```

Or pull production plus every branch head in one run with `npm run recover -- --project <prj_id> --team team_w9arIt9t47jpM9nRkZSwxjGM --out recovered/all`.

Note: the tool needs to reach `https://api.vercel.com`; a sandboxed agent session whose network policy blocks that host must run it elsewhere.

Then follow `docs/RECOVERY-RUNBOOK.md` to land the tree on a branch, let CI /
CodeQL / Copilot review it, re-link the Vercel project to this repository, rotate
the environment variables (Databento, terminal session secret, IXPRT API token)
and only then unpause.

If the deleted repository can still be restored on GitHub (Settings →
Repositories → Deleted repositories, 90-day window), do that instead: it brings
back full history, PRs #1/#5/#6 and the `agent/redesign/clearstreet` branch.

## Harden

```bash
gh auth login
npm run harden -- enc0ding/AssetModel-Web-Terminal
```

`docs/SECURITY-HARDENING.md` lists the account-level steps the script cannot do.
