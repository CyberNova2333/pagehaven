#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
# 显式安装；已有钩子时拒绝覆盖，逻辑与 Windows 入口共用。
set -euo pipefail
cd "$(dirname "$0")/.."
for candidate in python3 python; do
  if "$candidate" -c 'import sys; sys.exit(sys.version_info < (3, 10))' >/dev/null 2>&1; then
    exec "$candidate" tools/install_hooks.py
  fi
done
printf '%s\n' '安装钩子需要 Python 3.10+' >&2
exit 1
