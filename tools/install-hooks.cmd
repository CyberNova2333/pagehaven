@echo off
REM SPDX-License-Identifier: AGPL-3.0-only
REM This file is part of Pagehaven and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
setlocal
cd /d "%~dp0.."
python -c "import sys; sys.exit(sys.version_info < (3, 10))" >nul 2>&1
if errorlevel 1 goto launcher
python tools/install_hooks.py
exit /b %errorlevel%
:launcher
py -3 tools/install_hooks.py
exit /b %errorlevel%
