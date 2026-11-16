---
layout: page
sidebar: false
title: API & Component Reference
description: Apifox-style interactive explorer for Pagehaven configuration schemas, Web-standard @gallery/core & @gallery/search APIs, reader deep links, backup schemas, and R2 release CLIs.
---

<script setup lang="ts">
import { apiSpecEn } from '../../.vitepress/data/api-spec'
</script>

<ApiExplorer :spec="apiSpecEn">

### SSOT Configuration `site.config.yaml` (`parseSiteConfig`) {#schema-site-config}

Validates canonical hostnames, CDN origins, aligned SQLite `page_size` / `chunk_size`, and multi-target static budgets.

### Series, Issue & Chapter Metadata Schema (`parseSeriesMeta`) {#schema-meta-yaml}

Enforces lowercase-hyphen IDs, contiguous 1-based page indices, and 12-hex SHA-256 image digests under `data/meta/*.yaml`.

### Dialogue Layer ChapterTextSchema (`parseChapterText`) {#schema-text-layer}

Validates normalized `[0, 1]` dialogue coordinates and raw transcripts under `data/text/*.json`.

### Text Normalization & Hybrid Search (`normalizeText` / `queryLines`) {#core-search-query}

Runs 5-step idempotent normalization with `<2`-char rejection, 2-char `LIKE`, and `>=3`-char `FTS5` `MATCH` returning `#p<n>b<i>` links.

### Pinned & SHA-256 Verified DB Loader (`loadGalleryDb`) {#core-load-db}

Downloads build-pinned `gallery-*.sqlite` files under `30 MiB` stream guards and SHA-256 digest checks.

### Multi-Source Range Module (`@gallery/core/chunkfetch`) {#core-chunkfetch}

Probes HTTP 206 Range compliance with `SourceSet` EMA host selection and 64 KiB block SHA-256 verification.

### Reader Deep Links & Progressive Enhancement (`#p<n>b<i>`) {#reader-hash-and-modes}

Delivers zero-JS readable chapter pages plus binary-search long-strip scrolling, 100-item TOC shards, and optional Comimi enhancement.

### Portable Reading Backup JSON Schema (`parseReadingBackup`) {#reader-backup-schema}

Strict `pagehaven-reading-backup` v1 JSON allowlist enforcing `5 MiB` and `20,000`-record ceilings.

### Full Build & Target Budget Gate (`pnpm run build` / `check`) {#ops-build-and-check}

Compiles config templates, SQLite index, and Astro output while verifying multi-platform file and byte budgets.

### R2 Immutable Upload & Proof-Verified Activation (`release:activate`) {#ops-release-pipeline}

Uploads versioned artifacts to private R2, verifies live HTTPS deployment proofs, and activates `manifest.json` via ETag CAS.

</ApiExplorer>
