# Config, Data & Client Contracts

`site.config.yaml` serves as the single source of truth (SSOT), validated by `@gallery/platform` to drive data manifests, SQLite generation, Astro static builds, and hosting configuration outputs.

## 1. `site.config.yaml` Schema Summary

| Top-Level Key | Key Fields | Defaults & Constraints | Role |
| --- | --- | --- | --- |
| `site` | `title`, `domain`, `lang`, `tagline`, `logo` | `domain` defaults to `gallery.example.org` (blocked in prod release) | Title, HTML lang, canonical & sitemap base domain |
| `appearance` | `theme`, `accent`, `font`, `show_search`, `show_library` | `theme`: `paper` \| `ocean` \| `plum`; `font`: `sans` \| `serif` | Bounded semantic CSS variables without arbitrary CSS injection |
| `images` | `hosts`, `prefix` | 1–2 CDN hostnames; safe ASCII `prefix` (`img/`) | WebP & DB CDN origins and path prefix |
| `db` | `page_size`, `chunk_size`, `prefix`, `whole_download_max_bytes` | `4096`, `65536`, `db/`, `31457280` (30 MiB) | SQLite alignment, chunk manifest size, and download safety cap |
| `search` | `request_chunk_size`, `min_match_length`, `api_path` | `4096`, `2`, `/api/search` | Search client bounds & optional edge function endpoint |
| `features` | `search_function`, `platform_config`, `text_layer`, `comimi_reader` | `false`, `true`, `true`, `false` | Toggles generated host files, reader dialogue overlay, and `@yui540/comimi` |
| `budgets` | `max_files`, `max_file_bytes` | `18000` files, `20971520` B (20 MiB) | Static build file count and single-file guards |
| `headers` / `redirects` | Header rules & redirect map | Sources validated within output root via `redirectOutputPaths` | Emits platform headers/redirects plus escaped `metaRefresh` HTML |
| `seo` | `indexnow_key` | `null` or `8–128` `[A-Za-z0-9-]+` | Writes `dist/<key>.txt` and enables `push:search` |
| `deploy` | `cloudflare`, `edgeone`, `github`, `workers`, `esa` | Project identifiers & custom domains | Synced into `packages/platform/generated/` |

### Generated Artifact Separation (`@gallery/platform`)

- **`GENERATED_FILES`** (copied to `dist/` when `features.platform_config: true`): `_headers`, `_redirects`, `edgeone.json`.
- **`DEPLOY_CONFIG_FILES`** (written to `packages/platform/generated/` only, **never copied to `dist/`**): `wrangler.jsonc`, `esa.jsonc`.

## 2. Catalog & Transcript Data Contracts (`@gallery/core`)

```text
data/
├── meta/
│   ├── <series>/series.yaml             # SeriesSchema (title, sort, authors, tags, cover key)
│   └── <series>/<issue>.yaml            # IssueSchema (number, chapters[], page dimensions & webp keys)
├── text/
│   └── <series>/<issue>/<chapter>.json  # ChapterTextSchema (boxes[]: normalized [0,1] x,y,w,h + text)
└── raw/
    ├── labelplus/<series>/<issue>/<chapter>.txt   # LabelPlus 1,0 script
    └── ocr/<series>/<issue>/<chapter>.json        # Reviewed OCR source
```

Key invariants enforced in `packages/core/src/schema.js` & `object-path.js`:
- Slugs (`series`, `issue`, `chapter`) match safe ASCII IDs for deterministic URLs `/<series>/<issue>/<chapter>/`;
- Text box coordinates `(x, y, w, h)` stay normalized within `[0, 1]`;
- Object keys (`img/<series>/cover-<hash12>.webp`, `img/<series>/<issue>/<n>-<hash12>.webp`) satisfy `isSafeObjectKey`.

## 3. Transcript Ingestion Contracts

### LabelPlus (`pnpm run ingest:labelplus`)

Parses `data/raw/labelplus/.../*.txt` with strict delimiter matching (`>>>>>>>>[filename]<<<<<<<<` and `----------------[n]----------------[x,y,group]`) so narrative dashes (`————`, `>>>`) remain intact, emits 1-based line warnings for malformed separator prefixes, and supports `--dry-run`, `CHAPTERS=...`, and `LABELPLUS_PAGES=auto|number|sequence`.

### OCR Gate (`pnpm run ingest:ocr`)

Uses a two-step human-review gate:
1. Default run requires `CHAPTERS=...` and outputs draft JSON + side-by-side HTML to `OUT_DIR` only (never touches `data/text/`).
2. After manual review in `data/raw/ocr/...`, `CHAPTERS=... pnpm run ingest:ocr -- --accept-reviewed` promotes validated text into `data/text/`.

## 4. Client DOM, Deep-Link & Storage Contracts

- **Search Page DOM IDs (`/search/`)**: `#search-config`, `#search-form`, `#search-input`, `#search-series`, `#search-coverage`, `#search-status`, `#search-results`, `#search-more`, plus catalog filter `#meta-form` / `#meta-q` / `#meta-results` reading `/index/series.json`.
- **Deep Links**: `/<series>/<issue>/<chapter>/#p<n>` focuses page `n`; `/<series>/<issue>/<chapter>/#p<n>b<i>` highlights dialogue box `i` on page `n`.
- **Storage Keys & Backup**: `gallery:library:*`, `gallery:progress:*`, `gallery:favorites:*`, `gallery:note:*` (max 200 chars), `gallery:reader:enhanced`, and `gallery:color-scheme`, portable via `pagehaven-reading-backup` v1 JSON (5 MiB / 20,000 records).
