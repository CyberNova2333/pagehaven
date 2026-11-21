# Changelog, Migrations & Architecture Decisions

Summary of breaking changes, migration steps, and durable Architecture Decision Records (grounded in `docs/ARCHITECTURE.md` and `repo-docs/change-log.md`).

## Breaking Changes & Migration Guides

### 1. Workspace Migration to `pnpm` & Astro 7.4.12

- **Change**: Root workspace now targets `pnpm >=10.0.0` (`pnpm@12.6.0`) and `Node.js >=22.19.0`, linking internal `@gallery/*` packages via `workspace:*`. `@gallery/site` resolves Astro **7.4.12** directly while `pnpm-workspace.yaml` removes unused `astro>sharp` (LGPL libvips).
- **Migration Actions**:
  - Replace npm `--workspace` flags with `pnpm --filter @gallery/site run preview` (or `dev`).
  - Deployment CLIs run through `scripts/lib/pnpm-runner.mjs` using explicit `pnpm --package=<pkg>@<ver> dlx` invocations.
  - Update docs dependencies separately via `pnpm --dir docs-site install --frozen-lockfile`.

### 2. Four-Target Static Matrix & Three-Phase Immutable Release

- **Change**: Default `--target all` now deploys `edgeone`, `esa`, `github`, and `workers` (legacy Cloudflare Pages remains standalone as `cloudflare`). Releases split into `publish:r2` → `release:prepare` → `deploy:<target>` → `release:activate`.
- **Rationale**:
  - **ESA 1,999 App File Guard**: ESA caps total files at 2,000 (1,024,000,000 B); reserving 1 file (4,096 B) for per-deploy random proof lowers safe application caps to **1,999** on ESA and **17,999** on Workers.
  - **Zero Partial Rollouts**: Each build pins its own `gallery.searchDb`; shared `manifest.json` moves conditionally via `If-Match` only after all targets verify matching `(version, fingerprint)` proofs.

### 3. Search Fallback, Coverage Gate & OCR Review Gate

- **Change**: `@gallery/search` serves live search via SHA-256-verified whole-DB downloads (`whole_download_max_bytes: 31457280`), skips network downloads when `coverage` shows zero text or queries are `< 2` chars, and requires explicit `--accept-reviewed` promotion for `ingest:ocr` drafts.
- **Migration Reminder**: Keep `db.page_size` and `search.request_chunk_size` equal when customizing `site.config.yaml` and rebuild after enabling `features.range_search` to pin the chunk manifest digest.

### 4. Template Reset, Feature Toggles & Enterprise Appearance

- **Change**: Sample copyrighted works were removed in favor of an empty template catalog with placeholder domains (`gallery.example.org`, `images.example.org`). `features.comimi_reader` defaults to `false`, preserving the standard reader as fallback for long-strip, text overlays, and `#p<n>b<i>` links. Built-in presets (`paper`, `ocean`, `plum`) now share Enterprise Brand Blue (`#0c5cab` / `#0a4a8a`), zero shadows, bundled `IBM Plex Sans`, and reduced-motion-safe Anime.js transitions.

## Architecture Decision Records (Summary)

| Decision | Chosen Approach | Rejected Alternative & Rationale |
| --- | --- | --- |
| **Per-Chapter HTML** | Single static HTML containing all pages & overlays per chapter | Rejected one HTML per page: exceeds ESA (2k) and Workers (18k) file limits on multi-thousand-page archives |
| **Idempotent Text Normalization** | `NFKC → strip → NFKC → opencc-js/t2cn → lowercase`, preserving unassigned `Cn` | Rejected OpenCC-before-NFKC (misses Kangxi radicals) and 1.2 MB bidirectional dictionaries |
| **Scalable Chapter TOC & Scroll** | Lazy `/index/<series>.json` paginated at 100 chapters/group + binary search scroll offsets | Rejected embedding 10k+ chapter lists in every HTML or O(n) scroll frame DOM reads |
| **Isolated Docs Workspace** | Standalone `docs-site/package.json` & manual-only `docs-pages.yml` trigger | Prevents VitePress dependencies from polluting business security audits or auto-publishing drafts on push |
