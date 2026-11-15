# Cross-Module Interactions & Extension FAQ

Pagehaven prevents version drift across static pages, R2 objects, and browser SQLite queries through explicit build fingerprints and clean package boundaries.

## Anti-Drift Handoff Chain

1. **`@gallery/platform` → `generated/`**: `build:config` validates `site.config.yaml` and synchronizes platform files (`pnpm run check` fails if committed generated templates drift).
2. **`build:manifest` → `out/manifest.json`**: Computes `sourceSha256 = galleryFingerprint(gallery)` over all series, issues, chapters, pages, and text boxes with `db: null`.
3. **`build:db` → `@gallery/core/db`**: Reloads `manifest.json`, verifies live fingerprint match, builds `gallery-<version>.sqlite` (`FTS5 trigram`) and 64 KiB `.chunks.json`, and patches only `manifest.db`.
4. **`build:site` → `@gallery/site`**: Verifies matching `version`, `site.domain`, and `sourceSha256` before writing `packages/site/src/generated/` (`gallery.json`, `site-config.json`, chapter `text/*.json`) and running `astro build`.
5. **`publish:r2` → `deploy:*` → `release:activate`**: Uploads immutable `img/*`, `db/gallery-<version>.sqlite`, and `manifest-<version>.json`; deploys proof-checked static sites bound to that fixed `gallery.searchDb`; atomically updates shared `manifest.json` via `If-Match: <etag>` only when all targets report matching `(version, fingerprint)` receipts.

## Runtime Module Coordination

### Lazy Pinned Search Loading

On `/search/`, `mountSearch()` inspects embedded `coverage` before any network traffic:
- If `chapters === 0` or `withText === 0 || boxes === 0`, renders an empty-state message with zero DB downloads;
- If normalized input is shorter than 2 characters (`mode === 'too-short'`), rejects locally without downloading SQLite;
- On the first valid `>=2`-char query, `loadGalleryDb()` fetches the exact `config.db.release` pinned during build (preventing older deployed HTML from querying newer schemas), enforces byte limits, and verifies SHA-256.

### Standard Reader vs Opt-In `@yui540/comimi` Enhancement

`EnhancedReader` (`features.comimi_reader`) delegates URL hashes (`#p<n>`, `#p<n>b<i>`), progress persistence, bookmarks (`gallery:favorites:*`), and long-strip/text-layer accuracy back to `reader.galleryReader`. Entering long-strip mode, checking "show text", or landing on a `#p<n>b<i>` search anchor automatically pauses the enhanced viewer and restores it cleanly when leaving those modes.

### Theme & Color-Scheme Synchronization

`Base.astro` runs `initializeColorScheme` inline before first paint to resolve `system` / `light` / `dark` and emit `pagehaven:color-scheme-change`. `day-night-control.js` binds the interactive day-night widget to that shared state store without hiding the fallback three-state radio control.

## Extension FAQ

**Can I use `node:fs` or `node:path` in `@gallery/core` or `@gallery/search`?**
No. `scripts/check.mjs` strictly forbids `node:*` imports in `packages/core/`, `packages/search/`, and `packages/site/`. Keep filesystem/CLI code in `scripts/` or `packages/platform/`.

**How do I customize colors and headings safely?**
Set `appearance.theme` (`paper`, `ocean`, `plum`), hex `accent`, and `font` (`sans` or `serif`) in `site.config.yaml` or via `pnpm run customize`. `site-appearance.js` auto-computes WCAG contrast (`>= 4.5`) for links and foreground button text.

**Where do I hook up Range-based SQLite paging later?**
`packages/core/src/chunkfetch/` already implements `SourceSet` EMA selection, Range probing (`probe`), per-chunk SHA-256 verification (`ChunkedFile`), and `needs-whole` fallback signaling. Attaching an SQLite synchronous/OPFS VFS sits cleanly atop `ChunkedFile.read(offset, length)` without changing `.chunks.json` or `queryLines`.
