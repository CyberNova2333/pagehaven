# -*- coding: utf-8 -*-
# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
"""tools/install_hooks.py 显式安装与保护既有钩子回归测试。"""

import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "install_hooks.py"


def isolated_env():
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update({
        "LC_ALL": "C",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_CONFIG_NOSYSTEM": "1",
    })
    return env


def init_repo(root: Path, env, *, hooks=("pre-commit", "commit-msg", "pre-push")):
    subprocess.run(["git", "init", "-b", "main"], cwd=root, env=env, check=True, stdout=subprocess.DEVNULL)
    hooks_dir = root / "tools" / "githooks"
    hooks_dir.mkdir(parents=True, exist_ok=True)
    for name in hooks:
        target = hooks_dir / name
        target.write_text("#!/usr/bin/env sh\nexit 0\n", encoding="utf-8")
        target.chmod(0o644)


class InstallHooksTests(unittest.TestCase):
    def test_fresh_install_and_idempotency(self):
        env = isolated_env()
        with tempfile.TemporaryDirectory(prefix="pagehaven-hooks-") as tmp:
            repo = Path(tmp)
            init_repo(repo, env)
            res = subprocess.run([sys.executable, str(SCRIPT)], cwd=repo, env=env, capture_output=True, text=True)
            self.assertEqual(res.returncode, 0, res.stderr)
            configured = subprocess.check_output(["git", "config", "--get", "core.hooksPath"], cwd=repo, env=env, text=True).strip()
            self.assertEqual(configured, "tools/githooks")
            for name in ("pre-commit", "commit-msg", "pre-push"):
                mode = (repo / "tools" / "githooks" / name).stat().st_mode
                self.assertTrue(mode & stat.S_IXUSR, f"{name} should be executable")

            again = subprocess.run([sys.executable, str(SCRIPT)], cwd=repo, env=env, capture_output=True, text=True)
            self.assertEqual(again.returncode, 0, again.stderr)

    def test_refuses_custom_hooks_path_without_overwriting(self):
        env = isolated_env()
        with tempfile.TemporaryDirectory(prefix="pagehaven-hooks-") as tmp:
            repo = Path(tmp)
            init_repo(repo, env)
            subprocess.run(["git", "config", "--local", "core.hooksPath", ".custom-hooks"], cwd=repo, env=env, check=True)
            res = subprocess.run([sys.executable, str(SCRIPT)], cwd=repo, env=env, capture_output=True, text=True)
            self.assertEqual(res.returncode, 1)
            self.assertIn("core.hooksPath", res.stderr)
            configured = subprocess.check_output(["git", "config", "--get", "core.hooksPath"], cwd=repo, env=env, text=True).strip()
            self.assertEqual(configured, ".custom-hooks")

    def test_refuses_non_sample_default_hooks(self):
        env = isolated_env()
        with tempfile.TemporaryDirectory(prefix="pagehaven-hooks-") as tmp:
            repo = Path(tmp)
            init_repo(repo, env)
            default_hooks = repo / ".git" / "hooks"
            for item in list(default_hooks.iterdir()):
                if not item.name.endswith(".sample"):
                    if item.is_dir():
                        shutil.rmtree(item)
                    else:
                        item.unlink()
            (default_hooks / "pre-commit").write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")

            res = subprocess.run([sys.executable, str(SCRIPT)], cwd=repo, env=env, capture_output=True, text=True)
            self.assertEqual(res.returncode, 1)
            self.assertIn("默认钩子目录已有钩子", res.stderr)
            probe = subprocess.run(["git", "config", "--get", "core.hooksPath"], cwd=repo, env=env, capture_output=True, text=True)
            self.assertNotEqual(probe.returncode, 0)

    def test_refuses_when_project_hook_missing(self):
        env = isolated_env()
        with tempfile.TemporaryDirectory(prefix="pagehaven-hooks-") as tmp:
            repo = Path(tmp)
            init_repo(repo, env, hooks=("pre-commit", "commit-msg"))
            res = subprocess.run([sys.executable, str(SCRIPT)], cwd=repo, env=env, capture_output=True, text=True)
            self.assertEqual(res.returncode, 1)
            self.assertIn("pre-push", res.stderr)
            probe = subprocess.run(["git", "config", "--get", "core.hooksPath"], cwd=repo, env=env, capture_output=True, text=True)
            self.assertNotEqual(probe.returncode, 0)


if __name__ == "__main__":
    unittest.main()
