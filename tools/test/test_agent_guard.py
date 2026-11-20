# -*- coding: utf-8 -*-
# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
"""tools/agent-guard.py 绕过检测与只读钩子状态核对回归。"""

import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "agent_guard", Path(__file__).resolve().parents[1] / "agent-guard.py")
agent_guard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(agent_guard)


def isolated_env():
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update({
        "LC_ALL": "C",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_CONFIG_NOSYSTEM": "1",
    })
    return env


class AgentGuardTests(unittest.TestCase):
    def test_offending_detects_bypasses_and_ignores_safe_commands(self):
        blocked = [
            "git commit --no-verify -m x",
            "git commit -n -m x",
            "git commit -an -m x",
            "git push --no-verify origin main",
            "git -c core.hooksPath=/tmp commit -m x",
            "git -ccore.hooksPath=/tmp push origin main",
            "git -C /tmp/repo commit --no-verify -m x",
            "echo ok && git commit -n -m x",
            "git commit \\\n --no-verify -m x",
        ]
        for cmd in blocked:
            with self.subTest(blocked=cmd):
                self.assertIsNotNone(agent_guard.offending(cmd))

        allowed = [
            "git status",
            "git push -n origin main",
            'git commit -m "不要用 -n 或 --no-verify 参数"',
            'git commit -m "a; git commit -n"',
            "git commit -- -n",
            "pnpm run check",
        ]
        for cmd in allowed:
            with self.subTest(allowed=cmd):
                self.assertIsNone(agent_guard.offending(cmd))

    def test_ensure_hooks_path_is_readonly(self):
        env = isolated_env()
        with tempfile.TemporaryDirectory(prefix="pagehaven-guard-") as tmp:
            repo = Path(tmp)
            subprocess.run(["git", "init", "-b", "main"], cwd=repo, env=env, check=True, stdout=subprocess.DEVNULL)
            (repo / "tools" / "githooks").mkdir(parents=True)

            with patch.dict(os.environ, env, clear=True):
                missing_note = agent_guard.ensure_hooks_path(str(repo))
                self.assertIsNotNone(missing_note)
                self.assertIn("不自动修改", missing_note)
                probe = subprocess.run(["git", "config", "--get", "core.hooksPath"], cwd=repo, env=env, capture_output=True, text=True)
                self.assertNotEqual(probe.returncode, 0)

                subprocess.run(["git", "config", "--local", "core.hooksPath", "tools/githooks"], cwd=repo, env=env, check=True)
                self.assertIsNone(agent_guard.ensure_hooks_path(str(repo)))

                subprocess.run(["git", "config", "--local", "core.hooksPath", ".other-hooks"], cwd=repo, env=env, check=True)
                custom_note = agent_guard.ensure_hooks_path(str(repo))
                self.assertIsNotNone(custom_note)
                self.assertIn(".other-hooks", custom_note)
                cur = subprocess.check_output(["git", "config", "--get", "core.hooksPath"], cwd=repo, env=env, text=True).strip()
                self.assertEqual(cur, ".other-hooks")


if __name__ == "__main__":
    unittest.main()
