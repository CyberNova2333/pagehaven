# Boundaries & Security Model

Pagehaven enforces seven foundational engineering laws verified automatically by `scripts/check.mjs`, tests, and Git hooks.

## The Seven Iron Laws

1. **Web-Standard APIs Only in Core, Search & Site**
   `packages/core/`, `packages/site/`, and `packages/search/` must use only Web-standard APIs (`crypto.subtle`, `Uint8Array`, `TextEncoder`, `fetch`, `URL`, Wasm) and never import `node:*` built-ins. Node-only filesystem/CLI tooling belongs strictly in `scripts/` and `packages/platform/`.
2. **Pure-Static Baseline**
   With `features.platform_config: false` (no `_headers`, `_redirects`, or `edgeone.json`), all series, chapters, text layers, shelves, backups, and SQLite Wasm search must remain 100% functional. Cloud functions are optional slots, never prerequisites.
3. **Strict R2 Privacy & Read/Write Split**
   Cloudflare R2 remains strictly private. Write keys (`R2_*`) exist only in CI secrets; browsers read WebP pages and `.sqlite` files solely via `images.hosts` (1–2 CDN domains backed by S3v4 private origin access).
4. **Aligned SQLite Page & Chunk Sizes**
   `db.page_size` and `search.request_chunk_size` must stay aligned (`4096` default), with WAL mode disabled (`journal_mode=DELETE`) and `VACUUM` applied before export.
5. **One Static HTML per Chapter**
   Every chapter compiles into a single HTML page containing all page `<img>` tags and transparent `.box` overlays, keeping file counts within free-tier limits while lazy-loading `/index/<series>.json` TOC chunks.
6. **Zero Secret or Private Path Leakage**
   Account IDs, bucket names, API tokens, local workstation paths, and internal drafts must never enter source, configs, fixtures, commits, or docs. Example domains default to `gallery.example.org` and `images.example.org`.
7. **Fail Loud on Misconfiguration**
   Missing secrets, invalid YAML, `sourceSha256` drift, unsafe object keys, or oversized bundles fail immediately with non-zero exit codes rather than silently degrading or shipping partial outputs.

## Security & Trust Boundaries

### Object Paths & Bounded Database Fetch

- **Safe Object Paths (`packages/core/src/object-path.js`)**: `isSafeObjectPrefix` and `isSafeObjectKey` allow only unescaped ASCII relative paths, rejecting whitespace, `.` / `..`, empty segments, and control characters.
- **Stream-Guarded Whole Download (`packages/search/src/whole.js`)**: Before opening SQLite Wasm, `loadGalleryDb` validates embedded `gallery.searchDb` metadata (`key`, `size > 0`, 64-hex `sha256`, `size <= whole_download_max_bytes`), aborts any response stream exceeding declared or max byte caps, and verifies full-file SHA-256 before passing bytes to SQLite.

### Local Shelf & JSON Backup Hardening

`packages/site/src/lib/reading-backup.js` validates imported `pagehaven-reading-backup` v1 files strictly:
- Hard cap of **5 MiB** (`5 * 1024 * 1024 B`) and **20,000** total records;
- Exact schema & plain-object prototype checks across `library`, `progress`, `bookmarks`, and `notes` (max **200** chars per note); rejects arbitrary keys, URLs, or executable payloads.

### Privacy & Known Limitations

- `/library/` and `preview` builds emit `<meta name="robots" content="noindex" />` without canonical tags.
- Fonts (`IBM Plex Sans`) and licenses are bundled locally in `packages/site/public/` — zero third-party font beacons or analytics.
- Enable `features.range_search` in `site.config.yaml` and rebuild to read verified SQLite blocks on demand in a dedicated worker. The default build uses a bounded whole-file download (30 MiB by default).
