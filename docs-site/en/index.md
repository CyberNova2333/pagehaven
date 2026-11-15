---
layout: home

hero:
  name: Pagehaven
  text: Static Comic Archive & Search Engine
  tagline: Pure-static Astro manga reader, browser-side SQLite Wasm dialogue search, and portable multi-host delivery backed by private R2.
  actions:
    - theme: brand
      text: 1. Start & Deploy
      link: /en/docs/
    - theme: alt
      text: 2. Contracts
      link: /en/docs/boundaries
    - theme: alt
      text: 3. Architecture
      link: /en/docs/architecture
    - theme: alt
      text: GitHub Repo
      link: https://github.com/CyberNova2333/pagehaven

features:
  - title: One HTML per Chapter
    details: Fits free static hosting budgets on EdgeOne, ESA (2,000-file cap), GitHub Pages, and Workers while remaining readable without JavaScript.
  - title: Browser SQLite Wasm Search
    details: Compiles normalized FTS5 trigram indexes at build time and jumps from search hits straight to #p<n>b<i> dialogue boxes.
  - title: Private R2 Immutable Releases
    details: Separates static HTML from CDN-proxied WebP and SQLite artifacts with random deployment proofs and ETag-guarded pointer activation.
---

## Quick Entry by Role

| Your Role & Goal | Recommended Docs Route | Repo Source Guide (`repo-docs/`) |
| --- | --- | --- |
| **Site Owner / Operator**: Configure, preview, and deploy to edge static hosts | [Overview & Quick Start](/en/docs/) → [Deployment Matrix](/en/docs/deployment) | `repo-docs/modules/release-pipeline-and-proofs.md` |
| **Content & Localization Editor**: Author YAML metadata or ingest LabelPlus / OCR scripts | [Config, Data & Client Contracts](/en/docs/configuration) | `repo-docs/modules/data-model-and-normalization.md` |
| **Frontend / Search Integrator**: Extend themes, reader modes, backups, or search mounts | [Boundaries & Security Model](/en/docs/boundaries) → [Interactions & Extension FAQ](/en/docs/interactions) | `repo-docs/modules/search-db-and-chunkfetch.md` |
| **Contributor / Reviewer**: Trace a real build run and inspect CI/githook gates | [One Real Run Walkthrough](/en/docs/walkthrough) → [Code Map & Contribution Flow](/en/docs/code-map) | `repo-docs/walkthroughs/one-real-run.md` |

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

## Four-Stage Documentation Map

1. **Getting Started & Deployment**: [Overview](/en/docs/) · [Deployment Matrix](/en/docs/deployment) · [Troubleshooting FAQ](/en/docs/faq)
2. **Contracts & Extension**: [Boundaries & Security](/en/docs/boundaries) · [Config & Data Contracts](/en/docs/configuration) · [Interactions & FAQ](/en/docs/interactions)
3. **Architecture & Internals**: [One Real Run](/en/docs/walkthrough) · [Subsystems & Architecture](/en/docs/architecture) · [Code Map & Workflow](/en/docs/code-map)
4. **Releases & Migrations**: [Changelog, Migrations & ADRs](/en/docs/changelog)
