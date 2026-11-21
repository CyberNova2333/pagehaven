# Troubleshooting FAQ

This page covers build, validation, deployment-budget, and browser runtime failures. For architecture selection questions, see `README.en.md`.

## Build & Check Failures

### 1. `build:site` rejects mismatched `manifest.sourceSha256`, domain, or version

- **Symptom**: `pnpm run build:site` exits non-zero saying `manifest.json` does not match current content fingerprint, site domain, or release version.
- **Root Cause**: `data/` or `site.config.yaml` changed without re-running `build:manifest` and `build:db`, risking a mismatch between compiled pages and `gallery.searchDb`.
- **Diagnostic Command**:
  ```sh
  pnpm run check:data
  head -n 20 out/manifest.json
  ```
- **Resolution**: Run the full build pipeline `pnpm run build` so manifest, SQLite DB, and static HTML share one fingerprint and version.

### 2. `pnpm run check` fails on `astro>sharp` or unexpected native build flags

- **Symptom**: Dependency guard detects `sharp`, `libvips`, or unapproved `allowBuilds` entries.
- **Root Cause**: `pnpm-workspace.yaml` override `astro>sharp: '-'` was bypassed or altered, introducing LGPL native binaries prohibited by runtime constraints.
- **Diagnostic Command**:
  ```sh
  grep -n "sharp" pnpm-lock.yaml pnpm-workspace.yaml || true
  ```
- **Resolution**: Restore `astro>sharp: '-'` in `pnpm-workspace.yaml` (keeping only `esbuild` in `allowBuilds`) and run `pnpm install --frozen-lockfile`.

### 3. `Cannot find module 'vitepress'` during `pnpm test` or docs build

- **Symptom**: `test:docs` or `docs:build` fails because `vitepress` is missing.
- **Root Cause**: `docs-site/` maintains a separate `package.json` and `pnpm-lock.yaml` so documentation tooling never leaks into business security audits.
- **Resolution**:
  ```sh
  pnpm --dir docs-site install --frozen-lockfile
  pnpm run test:docs
  ```

### 4. `checkReadmeLinks` flags broken `#fragment` links in README files

- **Symptom**: `pnpm run check` reports an unmatched `#anchor` in `README.md` or `README.en.md`.
- **Root Cause**: Heading edits diverged from link fragments or used non-normalized slugs (lowercased, punctuation stripped except `_-`, whitespace mapped 1:1 to `-`).
- **Resolution**: Update the `#fragment` to match `scripts/lib/readme-links.mjs` output and re-run `node --test scripts/test/readme-links.test.mjs`.

## Deployment & Budget Errors

### 5. `esa` or `--target all` fails budget validation at 2,000 files

- **Symptom**: `DEPLOY_TARGET=all pnpm run check` fails stating ESA exceeds 2,000 files or `1,024,000,000 B`.
- **Root Cause**: ESA's hard limit is 2,000 files including 1 reserved slot (4,096 B) for the random deployment proof file, capping application files in `dist/` at **1,999**.
- **Diagnostic Command**:
  ```sh
  find dist -type f | wc -l
  ```
- **Resolution**: Remove unnecessary static redirects/files or target `workers` (`17,999` app files), `github`, or `edgeone` for larger catalogs.

### 6. Workers / ESA CLI exits 0 but deployment fails proof verification

- **Symptom**: CLI upload finishes, yet `deploy.mjs` reports proof mismatch and withholds the deployment receipt and R2 pointer activation.
- **Root Cause**: `WORKERS_DEPLOY_URL` or `ESA_DEPLOY_URL` still routes to a cached CDN or a different platform instance instead of the newly uploaded deployment.
- **Resolution**: Point each target's verification URL directly to that target's preview/staging endpoint without redirect hops, re-deploy, and confirm matching proofs.

### 7. `DEPLOY_ENV=preview` rejects `github` or `all`

- **Symptom**: Release plan aborts before upload when `preview` is combined with `github` or `all`.
- **Root Cause**: GitHub Pages currently supports a single production `gh-pages` branch without isolated preview targets.
- **Resolution**: Explicitly choose `edgeone`, `esa`, `workers`, or `cloudflare` for preview deployments.

## Browser Search & Reader Behavior

### 8. Dialogue search fails to load DB or exceeds `whole_download_max_bytes`

- **Symptom**: Queries of `>=2` characters fail with host/CORS, SHA-256 mismatch, or size-limit errors.
- **Root Cause**: Missing CDN CORS headers (`Access-Control-Allow-Origin`), CDN compression modifying `.sqlite` bytes, or a whole-file fallback exceeding the default `31,457,280 B` (30 MiB).
- **Resolution**. Verify CORS and uncompressed 206 responses with an exposed `Content-Range` header. For larger databases, rebuild with `features.range_search: true`.

### 9. Opt-in enhanced pagination pauses in long-strip or `#p<n>b<i>` mode

- **Symptom**: With `features.comimi_reader: true`, enabling long-strip mode, toggling text overlays, or opening `#p<n>b<i>` search links switches back to the standard reader.
- **Root Cause**: Intentional fallback guard in `packages/site/src/lib/enhanced-reader.js`: standard reader guarantees text-box coordinates, `#p<n>b<i>` highlighting, and long-strip scroll tracking.
- **Resolution**: Expected behavior; enhanced pagination automatically resumes when returning to single/double-page reading with text overlay unchecked.
