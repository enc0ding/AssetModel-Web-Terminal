#!/usr/bin/env bash
# github-harden.sh — apply repository-level security settings with the GitHub CLI.
#
# Idempotent: safe to re-run. Requires `gh` authenticated as the repository
# owner with the `repo` and `admin:repo_hook` scopes (gh auth login covers it).
#
# Usage:
#   scripts/github-harden.sh owner/repo [owner/repo ...]
#   scripts/github-harden.sh --all-mine          # every non-fork repo you own
#   DRY_RUN=1 scripts/github-harden.sh owner/repo
#
# What it sets (per repository):
#   1. Repo settings: squash-only merges, delete head branches on merge,
#      web commit sign-off required, wiki/projects off.
#   2. Security: secret scanning + push protection, Dependabot alerts,
#      Dependabot security updates, private vulnerability reporting,
#      secret scanning validity checks (where available).
#   3. Actions policy: only GitHub-owned, verified-creator, and the explicit
#      allowlist below may run; default GITHUB_TOKEN is read-only; workflows
#      cannot approve PRs; every outside contributor's PR needs approval to run.
#   4. Rulesets: main-protection (PR required, code-owner review, required
#      checks, signed commits, no force-push/deletion, linear history),
#      tag-protection, and Copilot automatic code review.
#
# Account-level settings (2FA, passkeys, revoking OAuth/GitHub Apps, PATs,
# SSH keys, restoring deleted repositories) cannot be scripted: see
# docs/SECURITY-HARDENING.md.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RULESETS="$HERE/rulesets"
DRY_RUN="${DRY_RUN:-0}"
ALLOWED_ACTION_PATTERNS='["step-security/harden-runner@*","pnpm/action-setup@*","ossf/scorecard-action@*"]'

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARN\033[0m %s\n' "$*" >&2; }

api() {
  # api METHOD PATH [gh api args...]
  local method="$1" path="$2"; shift 2
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "  [dry-run] gh api -X $method $path $*"
    return 0
  fi
  gh api -X "$method" "$path" "$@" >/dev/null
}

require_gh() {
  command -v gh >/dev/null || { echo "gh CLI is required: https://cli.github.com" >&2; exit 1; }
  gh auth status >/dev/null 2>&1 || { echo "run: gh auth login" >&2; exit 1; }
}

repo_settings() {
  local repo="$1"
  log "$repo: repository settings"
  api PATCH "/repos/$repo" \
    -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false \
    -F delete_branch_on_merge=true -F allow_auto_merge=false \
    -F web_commit_signoff_required=true \
    -F has_wiki=false -F has_projects=false \
    -F allow_update_branch=true \
    -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY \
    || warn "$repo: some repository settings were rejected (plan or permissions)"
}

security_features() {
  local repo="$1"
  log "$repo: secret scanning, push protection, Dependabot, vulnerability reporting"
  api PATCH "/repos/$repo" --input - <<JSON || warn "$repo: security_and_analysis update rejected (private repo without GHAS?)"
{"security_and_analysis":{"secret_scanning":{"status":"enabled"},"secret_scanning_push_protection":{"status":"enabled"},"secret_scanning_validity_checks":{"status":"enabled"},"secret_scanning_non_provider_patterns":{"status":"enabled"}}}
JSON
  api PUT "/repos/$repo/vulnerability-alerts" || warn "$repo: could not enable Dependabot alerts"
  api PUT "/repos/$repo/automated-security-fixes" || warn "$repo: could not enable Dependabot security updates"
  api PUT "/repos/$repo/private-vulnerability-reporting" || warn "$repo: could not enable private vulnerability reporting"
}

actions_policy() {
  local repo="$1"
  log "$repo: Actions policy (allowlist, read-only token, fork PR approval)"
  api PUT "/repos/$repo/actions/permissions" --input - <<'JSON'
{"enabled":true,"allowed_actions":"selected"}
JSON
  api PUT "/repos/$repo/actions/permissions/selected-actions" --input - <<JSON
{"github_owned_allowed":true,"verified_allowed":true,"patterns_allowed":$ALLOWED_ACTION_PATTERNS}
JSON
  api PUT "/repos/$repo/actions/permissions/workflow" --input - <<'JSON'
{"default_workflow_permissions":"read","can_approve_pull_request_reviews":false}
JSON
  api PUT "/repos/$repo/actions/permissions/fork-pr-contributor-approval" --input - <<'JSON' || warn "$repo: fork PR approval policy endpoint unavailable"
{"approval_policy":"all_external_contributors"}
JSON
}

upsert_ruleset() {
  local repo="$1" file="$2"
  local name; name="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["name"])' "$file")"
  local existing
  existing="$(gh api "/repos/$repo/rulesets" --paginate -q ".[] | select(.name==\"$name\") | .id" 2>/dev/null | head -n1 || true)"
  if [[ -n "$existing" ]]; then
    log "$repo: update ruleset '$name' (#$existing)"
    api PUT "/repos/$repo/rulesets/$existing" --input "$file" || warn "$repo: ruleset '$name' update rejected"
  else
    log "$repo: create ruleset '$name'"
    api POST "/repos/$repo/rulesets" --input "$file" || warn "$repo: ruleset '$name' create rejected"
  fi
}

rulesets() {
  local repo="$1"
  upsert_ruleset "$repo" "$RULESETS/main-protection.json"
  upsert_ruleset "$repo" "$RULESETS/tag-protection.json"
  upsert_ruleset "$repo" "$RULESETS/copilot-review.json"
}

audit_access() {
  local repo="$1"
  log "$repo: access audit"
  echo "  collaborators:"; gh api "/repos/$repo/collaborators" -q '.[] | "    \(.login) (\(.role_name))"' || true
  echo "  deploy keys:";   gh api "/repos/$repo/keys" -q '.[] | "    \(.title) ro=\(.read_only) added=\(.created_at)"' || echo "    (none)"
  echo "  webhooks:";      gh api "/repos/$repo/hooks" -q '.[] | "    \(.config.url) active=\(.active)"' || echo "    (none)"
  echo "  actions secrets:"; gh api "/repos/$repo/actions/secrets" -q '.secrets[] | "    \(.name) updated=\(.updated_at)"' || echo "    (none)"
}

harden_repo() {
  local repo="$1"
  repo_settings "$repo"
  security_features "$repo"
  actions_policy "$repo"
  rulesets "$repo"
  audit_access "$repo"
}

main() {
  require_gh
  local repos=()
  if [[ "${1:-}" == "--all-mine" ]]; then
    mapfile -t repos < <(gh repo list --no-archived --source --limit 200 --json nameWithOwner -q '.[].nameWithOwner')
  else
    repos=("$@")
  fi
  [[ ${#repos[@]} -gt 0 ]] || { echo "usage: $0 owner/repo [...] | --all-mine" >&2; exit 1; }
  for r in "${repos[@]}"; do harden_repo "$r"; done
  log "done. Account-level items remain manual: see docs/SECURITY-HARDENING.md"
}

main "$@"
