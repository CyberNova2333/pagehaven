# Overview & Quick Start

Pagehaven is a **pure-static comic library, multi-mode reader, and browser-side dialogue search engine** engineered to survive without a backend server, database VM, or ongoing maintenance.

## Capabilities & Explicit Limits

| Area | What Pagehaven Delivers | Explicit Non-Goals & Hard Bounds |
| --- | --- | --- |
| Archive & Reader | Series/issue/chapter catalogs, zero-JS fallback, single/long-strip/double/Comimi modes | No user accounts, login sessions, comments, SSR servers, or online media upload UI |
| Dialogue Search | 5-step `normalizeText` + SQLite Wasm (`MATCH` >=3 / `LIKE` 2) jumping to `#p<n>b<i>` | Rejects `<2`-char normalized queries; `30 MiB` whole-DB cap; unreviewed OCR excluded |
| Vault & Chunking | `pagehaven-reading-backup` JSON migration (<= `5 MiB` / `20,000` rows); verified `chunkfetch` SDK | No cloud account sync; `@gallery/core/chunkfetch` is not yet wired to browser SQLite VFS |
| Static Delivery | Shared `dist/` for EdgeOne, ESA (<= `1,999` files), GitHub Pages, Workers + R2 ETag activation | Rejects `preview` on `github`/`all`; refuses placeholder hosts or embedded secrets |

> Want interactive schemas, Web-standard SDK signatures, and release CLI examples in one view? Jump to the [API & Component Reference](/en/api-reference/).

## Prerequisites

- **Node.js**: `>=22.19.0` (matches `.nvmrc`)
- **pnpm**: `>=10.0.0` (lockfile maintained with `pnpm@12.6.0` using explicit `workspace:*` links)
- **Standalone docs dependencies**: `docs-site/` uses its own `package.json` and lockfile, isolated from production audits

## First Local Build & Preview

### 1. Install Dependencies & Initialize Configuration

```sh
pnpm install --frozen-lockfile
# Interactive YAML setup (updates site.config.yaml while preserving comments)
pnpm run init
# Non-interactive preview (--write persists changes)
pnpm run init -- --ui-lang en --title "My Archive" --domain manga.example.com --image-host img.example.com --target edgeone --dry-run
```

To adjust branding, logo, theme presets (`paper`, `ocean`, `plum`), or feature toggles in a local browser UI:

```sh
pnpm run customize
# Listens on http://127.0.0.1:4318/#token=<session-token> (use -- --host 0.0.0.0 in Codespaces)
```

`customize` updates `site.config.yaml` and saves backups under `out/customize/`. Commit and run the manual release pipeline for changes to reach readers.

### 2. Full Static Build, Verification & Preview

```sh
pnpm run build
pnpm run check
pnpm --filter @gallery/site run preview
```

Out of the box, `data/` contains only format READMEs, so `build` produces a valid empty-catalog site. To inspect a populated comic catalog locally without altering tracked data, point `DATA_DIR` to the core fixture dataset:

```sh
DATA_DIR=packages/core/test/fixtures/data DIST_DIR=/tmp/pagehaven-dist OUT_DIR=/tmp/pagehaven-out pnpm run build
pnpm --filter @gallery/site run preview -- --port 4321
```

`pnpm --filter @gallery/site run preview` serves `dist/` at `http://localhost:4321`. For Astro component hot-reloading, first generate `packages/site/src/generated/` via `build:config` / `build:site` and run `pnpm --filter @gallery/site run dev`.

## Next Steps

- Configure multi-target deployments, private R2, and CI secrets: [Modes, Platforms & Env Matrix](/en/docs/deployment)
- Import LabelPlus scripts or OCR drafts: [Config, Data & Client Contracts](/en/docs/configuration)
- Diagnose build or check errors: [Troubleshooting FAQ](/en/docs/faq)
