# Modes, Platforms & Environment Matrix

Pagehaven decouples static site hosting from large binary storage: **one shared `dist/` artifact deploys across static edge hosts while WebP pages and versioned SQLite files reside in private Cloudflare R2 behind CDN hosts.**

## Local Execution Modes

| Mode | Command | Purpose | Output / Port |
| --- | --- | --- | --- |
| Full pipeline build | `pnpm run build` | Runs `build:config` → `build:manifest` → `build:db` → `build:site` → `build:index` → `build:sitemap` | `dist/` & `out/` |
| Fixture dry build | `DATA_DIR=packages/core/test/fixtures/data DIST_DIR=... OUT_DIR=... pnpm run build` | Tests complete pipeline using sample comic fixtures | Custom output dirs (`src/generated/` updated) |
| Static Astro preview | `pnpm --filter @gallery/site run preview` | Verifies static HTML chapters, text overlays, search, and `404.html` | `http://localhost:4321` |
| Local config UI | `pnpm run customize` | Edits `site.config.yaml` appearance and feature flags with YAML backups | `http://127.0.0.1:4318/#token=...` |
| Standalone docs dev | `pnpm --dir docs-site install --frozen-lockfile && pnpm --dir docs-site run docs:dev` | Live-edits `docs-site/` with cache-busted bilingual search reload | Managed dev port (`scripts/docs-dev.mjs`) |

## Multi-Target Hosting Matrix

`@gallery/platform` (`packages/platform/src/targets.js`) registers five deploy targets; `DEFAULT_RELEASE_TARGETS` (`--target all`) expands to `edgeone`, `esa`, `github`, and `workers`, while legacy Cloudflare Pages stays standalone as `cloudflare`:

| Target ID | File Limit / App Guard | Size Limit | Preview Mode | Config & Template Handling |
| --- | --- | --- | --- | --- |
| `edgeone` | No extra target file cap | 20 MiB per-file guard | Supported (`-e preview`) | Public `edgeone.json`, `_headers`, `404.html` |
| `esa` | Hard cap `2,000` (`1` proof file → **1,999 app files**) | `1,024,000,000 B` (`4,096 B` proof reserve) | Supported (staging DNS + TLS verification) | `esa.jsonc` excluded from `dist/`; project name injected in staging copy |
| `github` | No extra target cap (`18,000` global guard) | `1,000,000,000 B` total | **Unsupported** (`preview` rejects `github`/`all`) | Requires `.nojekyll`, `404.html`, `index.html`; pushes `gh-pages` |
| `workers` | `18,000` (`1` proof file → **17,999 app files**) | 20 MiB per-file guard | Supported (`CLOUDFLARE_PREVIEW_WORKER_NAME`) | `wrangler.jsonc` excluded from `dist/`; Static Assets only |
| `cloudflare` | `18,000` | `20 MiB` per file | Supported (`--branch preview`) | Legacy Pages entry (excluded from `all`) |

> When `features.platform_config: false`, `_headers`, `_redirects`, and `edgeone.json` are omitted and the site operates purely via relative URLs and static HTML.

## Immutable R2 & Three-Phase Release Flow

1. **`pnpm run publish:r2`**: Validates safe object paths, uploads missing WebP images, versioned `db/gallery-<version>.sqlite` + `.chunks.json`, and immutable `manifest-<version>.json` to R2; archives previous pointer to `out/manifest-previous.json`.
2. **`pnpm run release:prepare`**: Saves current production `manifest.json` ETag and fingerprint into `out/release-state.json`.
3. **`pnpm run deploy:<target>`**: Invokes pinned CLIs (`wrangler@4`, `edgeone@1`, `esa-cli@1.0.13`) via `pnpm --package=... dlx`. Workers and ESA receive a temporary copy with a unique random deployment proof file, then `waitForDeployment` fetches and verifies that exact proof over HTTPS (ESA staging overrides DNS connection target while preserving Host, SNI, and TLS validation) before writing a receipt.
4. **`pnpm run release:activate`**: Requires identical `(version, fingerprint)` receipts from every planned target, then atomically updates R2 `manifest.json` using `If-Match: <etag>` (or `If-None-Match: *` on initial release).
5. **`pnpm run push:search` & `pnpm run status`**: Computes newly added URLs between `manifest.json` and `manifest-previous.json`, submits batches (`<= 10,000`) to IndexNow if `seo.indexnow_key` is set, and updates `STATUS.md`.

## Environment Variables & Secrets Matrix

### Non-Secret Build & Path Overrides

| Variable | Default / Allowed | Purpose |
| --- | --- | --- |
| `CONFIG_FILE` / `DATA_DIR` / `DIST_DIR` / `OUT_DIR` | Repo root `site.config.yaml`, `data`, `dist`, `out` | Redirect config, input catalog, static site output, and build artifacts |
| `DEPLOY_TARGET` | Optional target ID or `all` | Enables target-specific budget checks in `pnpm run check` |
| `DEPLOY_ENV` | `production` \| `preview` | Selects production vs preview target configurations |
| `RELEASE_VERSION` | Defaults to UTC `YYYY-MM-DD` | Pins immutable SQLite/manifest version (`[A-Za-z0-9._-]+`) |
| `CHAPTERS` / `LABELPLUS_PAGES` | Comma-separated chapter keys; `auto` \| `number` \| `sequence` | Scopes `ingest:labelplus` / `ingest:ocr` chapters and page mapping |
| `INDEXNOW_ENDPOINT` | `https://api.indexnow.org/indexnow` | Overrides IndexNow push endpoint |

### CI Secrets (Never Committed or Logged)

| Scope | Required Secrets | Delivery Mechanism |
| --- | --- | --- |
| Private R2 Storage | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Injected during `publish:r2`, `release:*`, and `status` |
| Cloudflare Workers / Pages | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_WORKER_NAME`, `WORKERS_DEPLOY_URL` (`CLOUDFLARE_PREVIEW_WORKER_NAME` for preview) | Passed via `run-with-secrets.mjs` to child processes only |
| EdgeOne Pages | `EDGEONE_API_TOKEN`, `EDGEONE_PROJECT_ID`, `EDGEONE_PROJECT_NAME` | Project name verified against ID before CLI runs with `EDGEONE_PAGES_API_TOKEN` |
| Aliyun ESA Pages | `ESA_ACCESS_KEY_ID`, `ESA_ACCESS_KEY_SECRET`, `ESA_PROJECT_NAME`, `ESA_DEPLOY_URL` | `esa-cli@1.0.13 --no-preview` |
| GitHub Pages | `GITHUB_PAGES_REPO`, `GITHUB_PAGES_TOKEN`, `RELEASE_SIGNING_KEY` | Baseline checked before SSH-signed commit push to `gh-pages` |

> The GitHub Actions release workflow (`.github/workflows/release.yml`) injects `PUBLISH_SECRETS_YML` and `DEPLOY_SECRETS_YML` (YAML/JSON scalar key-value objects) only into targeted child processes, and uses `RELEASE_SIGNING_KEY` (dedicated Ed25519 SSH signing key) for signed `gh-pages` commits and `STATUS.md` / `data/text` writeback. **Never commit, log, or print real credentials.**

## Pre-Release Checklist

1. Replace `gallery.example.org` and `images.example.org` in `site.config.yaml` with real production hostnames (`releasePlan` blocks placeholder domains on production).
2. Configure CDN S3v4 private origin access to R2 and ensure `Access-Control-Allow-Origin` and `ETag` headers permit browser fetches for `.sqlite` files.
3. Verify `dist/<indexnow_key>.txt` exists if `seo.indexnow_key` is configured.
4. Confirm `pnpm run build` and `DEPLOY_TARGET=all pnpm run check` exit `0`.
5. Run a `DEPLOY_ENV=preview` test deployment on new targets before cutting over production DNS.
