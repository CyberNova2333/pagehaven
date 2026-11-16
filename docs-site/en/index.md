---
layout: home

hero:
  name: Pagehaven
  text: Static Comic Archive & Search Engine
  tagline: Pure-static Astro manga reader, browser-side SQLite Wasm dialogue search, and portable multi-host delivery backed by private R2.
  actions:
    - theme: brand
      text: Start & Deploy
      link: /en/docs/
    - theme: alt
      text: API & Components
      link: /en/api-reference/
    - theme: alt
      text: Contracts & Limits
      link: /en/docs/boundaries
    - theme: alt
      text: Architecture
      link: /en/docs/architecture

features:
  - title: One HTML per Chapter
    details: Fits free static hosting budgets on EdgeOne, ESA (2,000-file cap), GitHub Pages, and Workers while remaining readable without JavaScript.
  - title: Browser SQLite Wasm Search
    details: Compiles normalized FTS5 trigram indexes at build time and jumps from search hits straight to #p<n>b<i> dialogue boxes.
  - title: Private R2 Immutable Releases
    details: Separates static HTML from CDN-proxied WebP and SQLite artifacts with random deployment proofs and ETag-guarded pointer activation.
---

## Capabilities & Explicit Limits

::: info What Pagehaven Delivers
- **Serverless Multi-Target Static Publishing**: One `site.config.yaml` SSOT drives Astro 7.4 to compile one static HTML page per chapter portable across EdgeOne, Alibaba Cloud ESA Pages (<=1,999 app files), GitHub Pages, and Cloudflare Workers, paired with private R2 uploads, live HTTPS proof checks, and ETag `If-Match` `manifest.json` activation.
- **Browser SQLite Wasm Dialogue Search & Progressive Reader**: Deterministic 5-step `normalizeText` + `FTS5 trigram` / `LIKE` search resolves hits to `#p<n>b<i>` speech boxes; the progressive reader offers single-page, O(log N) binary-search long-strip, double-page, 100-chapter TOC shards, and optional Comimi enhancement.
- **Local Library & Schema-Checked JSON Migration**: Progress, statuses, and 200-char notes live in browser `localStorage` and migrate cleanly via strict `pagehaven-reading-backup` JSON validation (up to 5 MiB / 20,000 records).
:::

::: warning Explicit Non-Goals & Hard Boundaries
- **No User Accounts, Comments, or Dynamic Backend**: Never includes authentication, server-side sessions, web-based media uploads, or persistent VPS processes; personal shelves stay browser-local.
- **Bounded Search Size & Minimum Query Length**: Browser search enforces `db.whole_download_max_bytes` (`30 MiB` default) and rejects queries normalizing to `< 2` characters before fetching SQLite; `@gallery/core/chunkfetch` implements verified HTTP Range primitives, not yet wired into browser SQLite VFS.
- **Hard Hosting Budgets & Human-Reviewed Search Input**: ESA enforces `2,000` total files / `1,024,000,000 B`; raw `ingest:ocr` drafts never enter production search without `--accept-reviewed`; credentials never enter `site.config.yaml` or client bundles.
:::

## Interactive Pipeline Overview

<div class="archify-diagram-card" style="margin: 1.5rem 0; border: 1px solid var(--vp-c-border); border-radius: 12px; overflow: hidden; background: var(--vp-c-bg-soft);">
  <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px 18px; background: var(--vp-c-bg-elv); border-bottom: 1px solid var(--vp-c-border); font-size: 13px;">
    <span style="font-weight: 600; color: var(--vp-c-text-1);">
      Pagehaven Pipeline: 01 Raw Ingest → 02 Normalized IR → 03 Bundle → 04 Reader Engine (pan & zoom)
    </span>
    <a href="/diagrams/pagehaven-pipeline.html" target="_blank" rel="noreferrer" style="font-size: 12px; color: var(--vp-c-brand-1); text-decoration: none; font-weight: 500;">
      Open fullscreen ↗
    </a>
  </div>
  <iframe src="/diagrams/pagehaven-pipeline.html" width="100%" height="520px" frameborder="0" style="display: block; border: none;" allowfullscreen loading="lazy"></iframe>
</div>

## 10-Second Local Verification

The repository starts as a clean template catalog. Verify a complete static build locally:

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run check
pnpm --filter @gallery/site run preview
# Preview opens at http://localhost:4321 (pass DATA_DIR=packages/core/test/fixtures/data for sample chapters)
```

## Documentation Map

::: tip Jump by Reader Goal
- **Site Operators & DevOps**: Start with [Overview & Quick Start](/en/docs/) → [Deployment Matrix](/en/docs/deployment), and check [Troubleshooting FAQ](/en/docs/faq);
- **Schemas, SDKs & CLI Reference**: Open the interactive [API & Component Reference](/en/api-reference/) or inspect [Config & Data Contracts](/en/docs/configuration) and [Boundaries & Security Model](/en/docs/boundaries);
- **Reader, Search & Internals**: Study [Subsystems & Architecture](/en/docs/architecture), [One Real Run Walkthrough](/en/docs/walkthrough), and [Code Map & Workflow](/en/docs/code-map);
- **Migrations & Decisions**: Browse [Changelog, Migrations & ADRs](/en/docs/changelog) alongside in-repo `repo-docs/README.md`.
:::
