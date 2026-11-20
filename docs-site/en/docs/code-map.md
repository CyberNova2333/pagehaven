# Code Map & Contribution Workflow

Quick directory orientation, standalone VitePress dev workflow, CI checks, and commit/push hook policies (see `repo-docs/code-map.md` for full evidence locators).

## Repository Layout

| Path | Role | Representative Files |
| --- | --- | --- |
| `packages/core/` | Web-standard schemas, normalization, SQLite Wasm builder & chunkfetch | `src/schema.js`, `src/normalize.js`, `src/labelplus.js`, `src/object-path.js`, `src/db/`, `src/chunkfetch/` |
| `packages/platform/` | Config validation, 5-target registry & hosting file generators | `src/site-config.js`, `src/targets.js`, `src/deploy-name.js`, `src/generators/`, `generated/` |
| `packages/search/` | Browser SQLite loader, query planner & `/search/` DOM binding | `src/load.js`, `src/query.js`, `src/mount.js` |
| `packages/site/` | Astro 7.4 static comic gallery, progressive reader & local shelf | `astro.config.mjs`, `src/layouts/Base.astro`, `src/pages/`, `src/lib/`, `public/` |
| `scripts/` | Build orchestration, validation, ingestion & multi-target deploy | `build-*.mjs`, `check.mjs`, `check-data.mjs`, `init-site.mjs`, `customize.mjs`, `ingest-*.mjs`, `publish-r2.mjs`, `deploy.mjs`, `release.mjs`, `seo-push.mjs`, `docs-dev.mjs`, `ci/{run-with-secrets,git-signing,release-writeback}.mjs` |
| `scripts/lib/` | Unit-tested pure logic & CI pipeline policy checkers | `manifest.mjs`, `deploy-plan.mjs`, `deploy-budget.mjs`, `deploy-proof.mjs`, `deploy-ready.mjs`, `github-pages-publish.mjs`, `fetch-signal.mjs`, `redact.mjs`, `pipeline-policy.mjs`, `readme-links.mjs`, `static-output.mjs`, `pnpm-runner.mjs` |
| `data/` | Metadata YAML, text JSON, and raw LabelPlus / OCR scripts | `meta/`, `text/`, `raw/labelplus/`, `raw/ocr/` |
| `docs/` | Hard-referenced architecture archive | `docs/ARCHITECTURE.md` (referenced directly by `check.mjs` & `placeholder.mjs` — always retained) |
| `docs-site/` | Standalone bilingual VitePress documentation site | `.vitepress/config.mts`, `docs/`, `en/docs/`, `public/diagrams/` |
| `repo-docs/` | Standard-mode contributor engineering docs | `README.md`, `walkthroughs/one-real-run.md`, `code-map.md`, `modules/`, `glossary.md`, `references/`, `change-log.md` |
| `tools/` & `guardrails/` | Git hooks, maintenance guards & verification tiers | `tools/githooks/{commit_msg.py,pre_push.py,_generated.py,_msgrules.py}`, `tools/github_repo.py`, `tools/install_hooks.py`, `tools/repo_maintenance_guard.py`, `tools/verification-tier.py` |

## Standalone Docs Site & Live Search Refresh

`docs-site/` isolates VitePress and Vite 8 in its own `package.json` and lockfile:
- **`pnpm run test:docs`**:
  - `scripts/test/docs-site.test.mjs`: Runs `vitepress build` into a temp directory, verifies `<h1>` presence, zero unresolved `@include`, 100% reachable internal links & `#anchors`, and loads MiniSearch indexes to confirm locale isolation.
  - `scripts/test/docs-workflow.test.mjs`: Audits `.github/workflows/checks.yml` and `docs-pages.yml` offline so docs install, moderate audit, and unified tests cannot be skipped or silenced.
  - `scripts/test/docs-dev.test.mjs`: Launches `startDocsDev` and verifies markdown saves trigger server restart, browser reload, and cache-busted search indexes.

## Contribution & Verification Tiers

Following trunk-based `main` development (`CONTRIBUTING.md`):
- **Commit Hooks**: Enforce `<type>(<scope>): <Chinese summary>` (`<= 100` chars), a `文档:` body summary line, and `Co-authored-by:` trailer; `pre-commit` / `pre-push` block secrets and oversized assets.
- **CI Gates**: `scripts/lib/pipeline-policy.mjs` directly audits `.github/workflows/{checks,release,archive,docs-pages}.yml`, forbidding auto-deploy steps on normal pushes; releases and docs-pages publishing remain manual triggers only.

| Change Scope | Required Local Commands |
| --- | --- |
| Docs / README only | `pnpm run check`, `pnpm --dir docs-site run docs:build`, `pnpm run test:docs` (plus `validate_repo_docs.py`) |
| Scripts / core schemas / search | `pnpm test`, `pnpm run check` |
| Site UI / Astro build / styling | `pnpm run build`, `pnpm run check`, `pnpm test` |
| Platform adapters / release / budgets | `DEPLOY_TARGET=all pnpm run check`, `pnpm test`, plus `DEPLOY_ENV=preview` live verification |
