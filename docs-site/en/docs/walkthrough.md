# One Real Run Walkthrough

Aligned with `repo-docs/walkthroughs/one-real-run.md`, this walkthrough traces one complete build and immutable release from YAML inputs to verified edge hosts.

## Representative Cases & Rejection Boundaries

| Input / Condition | Action & Result |
| --- | --- |
| Default empty catalog | Succeeds cleanly; emits home, `/search/`, `/library/`, and `404.html` without chapter routes |
| Consistent catalog, `manifest.json`, and `gallery.sqlite` | `build:site` verifies matching fingerprints and embeds pinned `searchDb` metadata |
| Modifying `data/` or domain without re-running `build:manifest` & `build:db` | `build:site` aborts on `sourceSha256` or domain mismatch before altering `dist/` |
| `build:manifest` without R2 credentials | Online image audit stays marked unverified rather than claiming live availability |
| Static output hits 2,000 files on `esa` or `all` | Adding the 1 reserved proof file reaches 2,001; pre-upload budget check rejects |
| Workers / ESA CLI exits 0 but verification URL serves stale or foreign proof | Proof check rejects, skips receipt, and leaves production `manifest.json` unchanged |

## Phase 1: Pin Configuration & Manifest (`build:config` → `build:manifest`)

1. **`pnpm run build:config`**: Validates `site.config.yaml` via `@gallery/platform` and synchronizes generated headers, redirects, and deploy templates inside `packages/platform/generated/`.
2. **`pnpm run build:manifest`**: Parses `data/meta/*.yaml` and `data/text/*.json` into an in-memory `Gallery` model, verifies `db.prefix` with `isSafeObjectPrefix`, sorts `imageKeys` lexicographically, computes `sourceSha256 = galleryFingerprint(gallery)`, and writes `out/manifest.json` with `db: null`.

## Phase 2: Build Pinned SQLite Search DB (`build:db`)

1. Reloads `out/manifest.json` and verifies live `galleryFingerprint` and release version (`RELEASE_VERSION` or UTC `YYYY-MM-DD`).
2. Initializes `@sqlite.org/sqlite-wasm`, applies `PRAGMA page_size=<db.page_size>`, creates `series`, `issues`, `chapters`, `pages`, `lines`, and external-content `lines_fts USING fts5(..., tokenize='trigram')`, inserts normalized `text_norm` inside one transaction, runs `INSERT INTO lines_fts(lines_fts) VALUES('rebuild')`, creates 4 join indexes, sets `PRAGMA journal_mode=DELETE`, and compacts with `VACUUM`.
3. Writes `out/db/gallery-<version>.sqlite` and its 64 KiB `chunks.json` manifest, then patches `manifest.db`.

## Phase 3: Static Site & Supporting Indexes (`build:site` → `build:index` → `build:sitemap`)

1. **Path Pre-Flight (`redirectOutputPaths`)**: Validates all redirect routes stay strictly inside `dist/` before touching generated files or cleaning outputs.
2. **Fingerprint Gate**: Confirms `manifest.sourceSha256`, `site.domain`, and version alignment, then writes `site-config.json`, `gallery.json`, and chapter `text/*.json` to `packages/site/src/generated/`.
3. **Astro Static Compilation**: Builds one HTML per chapter with `inlineStylesheets: 'always'` and the noop image service so pages remain readable with JavaScript disabled.
4. **Static Baselines & SEO**: Writes `_headers`, `_redirects`, and `edgeone.json` (when `features.platform_config: true`), `.nojekyll`, escaped `metaRefresh` redirect HTML, `/index/series.json`, per-series `/index/<series>.json`, `sitemap.xml`, and optional `<indexnow_key>.txt`.

## Phase 4: Verification & Atomic Three-Phase Release (`check` → `publish:r2` → `release:*`)

1. **`pnpm run check` (`DEPLOY_TARGET=all`)**: Checks Web-standard boundaries, zero `sharp` binaries, platform config sync, CI policies, README anchor links, SQLite header `page_size`, chapter HTML coverage, and target budgets (ESA `<= 1,999` / Workers `<= 17,999` app files).
2. **`publish:r2` & `release:prepare`**: Uploads missing WebP images, versioned `.sqlite` / `.chunks.json`, and `manifest-<version>.json` to private R2; records previous `manifest.json` ETag in `out/release-state.json`.
3. **`deploy:<target>` & Proof Polling**: Workers and ESA stage temporary copies with unique random deployment proof files, execute pinned CLIs via `pnpm --package=... dlx`, and poll target HTTPS endpoints (with DNS override + SNI/TLS verification for ESA staging) before recording receipts.
4. **`release:activate` & `push:search`**: Once every target receipt matches `(version, fingerprint)`, updates shared R2 `manifest.json` conditionally with `If-Match`, then submits newly added URLs to IndexNow.

## Continue Reading

- Inspect package responsibilities: [Code Map & Contribution Flow](/en/docs/code-map)
- Dive into subsystem internals: [Subsystems & Architecture](/en/docs/architecture)
