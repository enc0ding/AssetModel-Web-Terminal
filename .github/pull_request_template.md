## What changed

<!-- one paragraph, plain language -->

## Why

## Security checklist (required)

- [ ] No new third-party `<script src>`, iframe, or external fetch/rewrite target was added, or it is listed here with the reason:
- [ ] No lifecycle scripts (`preinstall`/`postinstall`/`prepare`) or non-registry dependency sources were added.
- [ ] No secrets, tokens, or connection strings in the diff (CI secret scan passes).
- [ ] Workflow changes keep `permissions: contents: read` and SHA-pinned actions.
- [ ] Any text addressed to AI agents (README, docs, comments, `llms.txt`, `.github/copilot-instructions.md`, `CLAUDE.md`) was reviewed for injected instructions.
- [ ] `node tools/scan-source/scan-source.mjs . --fail-on high` passes locally.

## How it was tested
