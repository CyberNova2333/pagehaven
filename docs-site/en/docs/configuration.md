---
title: Configuration Guide
description: Reader preferences, storage quotas, and theme customization parameters.
---

::: warning AI Translation Notice
This document was translated by an AI language model. In case of any discrepancies or ambiguities, please refer to the [original Chinese documentation](/docs/configuration) as the authoritative reference.
:::

# Configuration Guide

### Primary Configuration

```json
{
  "theme": {
    "default_mode": "auto",
    "font_family": "serif",
    "line_height": 1.75
  },
  "storage": {
    "max_offline_mb": 512,
    "auto_cache_opened": true
  }
}
```

---

## Production Recommendations

1. **Environment Variable Protection**: Never commit real API keys or sensitive credentials into Git repositories.
2. **Graceful Shutdown & Timeouts**: Set appropriate timeout constraints on long-running processes to prevent orphan executions.
3. **Continuous Monitoring**: Combine console logs and health telemetry to monitor service uptime and operational status.
