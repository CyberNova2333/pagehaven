# -*- coding: utf-8 -*-
# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
"""发布生成提交窄例外（tools/githooks/_generated.py）回归测试。"""

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

GITHOOKS_DIR = Path(__file__).resolve().parents[1] / "githooks"
if str(GITHOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(GITHOOKS_DIR))

import _generated  # noqa: E402


VALID_STATUS_MSG = (
    "chore(status): 发布后更新状态与台词\n\n"
    "文档: 发布工作流生成状态与导入台词，其他文档不变。\n\n"
    "Generated-by: Pagehaven release\n"
)
VALID_DATA_MSG = (
    "chore(data): 发布中断后保全台词\n\n"
    "文档: 发布工作流保留已导入台词，其他文档不变。\n\n"
    "Generated-by: Pagehaven release\n"
)


def isolated_env(extra=None):
    env = {k: v for k, v in os.environ.items()
           if not k.startswith("GIT_") and not k.startswith("SSH_")}
    env.update({
        "LC_ALL": "C",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_CONFIG_NOSYSTEM": "1",
    })
    if extra:
        env.update(extra)
    return env


class GeneratedCommitTests(unittest.TestCase):
    def test_requested_exact_line_only(self):
        self.assertTrue(_generated.requested(VALID_STATUS_MSG))
        self.assertFalse(_generated.requested("Generated-by: Pagehaven release extra\n"))
        self.assertFalse(_generated.requested("  Generated-by: Pagehaven release\n"))
        self.assertFalse(_generated.requested("chore(status): normal commit\n"))

    def test_validate_message_accepts_and_rejects(self):
        self.assertIs(_generated.validate_message(VALID_STATUS_MSG), True)
        self.assertIs(_generated.validate_message(VALID_DATA_MSG), False)

        bad_messages = [
            "chore(other): 非法标题\n\n文档: x\n\nGenerated-by: Pagehaven release\n",
            "chore(status): 发布后更新状态与台词\n\n文档: x\n\nGenerated-by: Pagehaven release\nextra\n",
            "chore(status): 发布后更新状态与台词\n\n文档: x\n\nGenerated-by: Pagehaven release\n\nGenerated-by: Pagehaven release\n",
            "chore(status): 发布后更新状态与台词\n\n文档: x\n\nCo-authored-by: Codex <noreply@openai.com>\nGenerated-by: Pagehaven release\n",
            "chore(status): 发布后更新状态与台词\n\n文档: x\n\n[skip-hooks]\nGenerated-by: Pagehaven release\n",
            "chore(status): 发布后更新状态与台词\n\nGenerated-by: Pagehaven release\n",
        ]
        for msg in bad_messages:
            with self.subTest(msg=msg):
                with self.assertRaises(ValueError):
                    _generated.validate_message(msg)

    def test_validate_paths_boundaries(self):
        _generated.validate_paths("M\0STATUS.md\0A\0data/text/s/i/c.json\0", allow_status=True)
        _generated.validate_paths("A\0data/text/s/i/c.json\0", allow_status=False)

        invalid = [
            ("", True),
            ("A\0STATUS.md\0broken", True),
            ("M\0STATUS.md\0", False),
            ("D\0data/text/s/i/c.json\0", True),
            ("R100\0data/text/s/i/a.json\0data/text/s/i/b.json\0", True),
            ("A\0data/text/s/i/c.txt\0", True),
            ("A\0data/text/../secret.json\0", True),
            ("A\0README.md\0", True),
        ]
        for records, allow_status in invalid:
            with self.subTest(records=records, allow_status=allow_status):
                with self.assertRaises(ValueError):
                    _generated.validate_paths(records, allow_status)

    def test_validate_index_and_commit_in_temp_repo(self):
        with tempfile.TemporaryDirectory(prefix="pagehaven-gen-test-") as tmp:
            root = Path(tmp)
            repo = root / "repo"
            repo.mkdir()
            key_file = root / "signing_key"
            subprocess.run(
                ["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", _generated.EMAIL, "-f", str(key_file)],
                check=True,
            )
            pub = Path(str(key_file) + ".pub").read_text(encoding="utf-8").strip()
            allowed = root / "allowed_signers"
            allowed.write_text(f"{_generated.EMAIL} {pub}\n", encoding="utf-8")

            env = isolated_env({
                "GIT_AUTHOR_NAME": "CyberNova",
                "GIT_AUTHOR_EMAIL": _generated.EMAIL,
                "GIT_COMMITTER_NAME": "CyberNova",
                "GIT_COMMITTER_EMAIL": _generated.EMAIL,
            })

            def run_git(*args, input_text=None, extra_env=None):
                return subprocess.run(
                    ["git", *args],
                    cwd=repo,
                    env={**env, **(extra_env or {})},
                    input=input_text,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                )

            def patched_git(*args, extra_env=None):
                res = run_git(*args, extra_env=extra_env)
                if res.returncode:
                    raise ValueError("生成提交检查无法读取 Git 对象或配置")
                return res.stdout

            self.assertEqual(run_git("init", "-b", "main").returncode, 0)
            self.assertEqual(run_git("config", "user.name", "CyberNova").returncode, 0)
            self.assertEqual(run_git("config", "user.email", _generated.EMAIL).returncode, 0)
            self.assertEqual(run_git("config", "gpg.format", "ssh").returncode, 0)
            self.assertEqual(run_git("config", "user.signingkey", str(key_file)).returncode, 0)
            self.assertEqual(run_git("config", "commit.gpgsign", "true").returncode, 0)
            self.assertEqual(run_git("config", "gpg.ssh.allowedSignersFile", str(allowed)).returncode, 0)

            (repo / "STATUS.md").write_text("init\n", encoding="utf-8")
            (repo / "data/text/s/i").mkdir(parents=True)
            (repo / "data/text/s/i/c.json").write_text("{}\n", encoding="utf-8")
            self.assertEqual(run_git("add", ".").returncode, 0)
            self.assertEqual(run_git("commit", "-m", "chore: initial").returncode, 0)
            parent_sha = run_git("rev-parse", "HEAD").stdout.strip()

            (repo / "STATUS.md").write_text("updated\n", encoding="utf-8")
            (repo / "data/text/s/i/c.json").write_text('{"ok":true}\n', encoding="utf-8")
            self.assertEqual(run_git("add", "STATUS.md", "data/text/s/i/c.json").returncode, 0)

            with patch.object(_generated, "git", side_effect=lambda *a: patched_git(*a)):
                _generated.validate_index(VALID_STATUS_MSG)

                # 未开启 commit.gpgsign 时拒绝
                self.assertEqual(run_git("config", "commit.gpgsign", "false").returncode, 0)
                with self.assertRaises(ValueError):
                    _generated.validate_index(VALID_STATUS_MSG)
                self.assertEqual(run_git("config", "commit.gpgsign", "true").returncode, 0)

                # 错误身份时拒绝
                with patch.object(_generated, "git", side_effect=lambda *a: patched_git(*a, extra_env={"GIT_AUTHOR_EMAIL": "other@example.invalid"})):
                    with self.assertRaises(ValueError):
                        _generated.validate_index(VALID_STATUS_MSG)

                # 暂存可执行权限时拒绝
                self.assertEqual(run_git("update-index", "--chmod=+x", "STATUS.md").returncode, 0)
                with self.assertRaises(ValueError):
                    _generated.validate_index(VALID_STATUS_MSG)
                self.assertEqual(run_git("update-index", "--chmod=-x", "STATUS.md").returncode, 0)

                # 提交并校验合法生成提交
                self.assertEqual(run_git("commit", "-F", "-", input_text=VALID_STATUS_MSG).returncode, 0)
                good_sha = run_git("rev-parse", "HEAD").stdout.strip()
                _generated.validate_commit(good_sha, VALID_STATUS_MSG)

                # 未签名提交被拒绝
                (repo / "STATUS.md").write_text("unsigned\n", encoding="utf-8")
                self.assertEqual(run_git("add", "STATUS.md").returncode, 0)
                self.assertEqual(run_git("-c", "commit.gpgsign=false", "commit", "-F", "-", input_text=VALID_STATUS_MSG).returncode, 0)
                unsigned_sha = run_git("rev-parse", "HEAD").stdout.strip()
                with self.assertRaises(ValueError):
                    _generated.validate_commit(unsigned_sha, VALID_STATUS_MSG)

                # 双父合并提交被拒绝
                tree_sha = run_git("rev-parse", f"{good_sha}^{{tree}}").stdout.strip()
                merge_sha = run_git("commit-tree", tree_sha, "-p", parent_sha, "-p", good_sha, "-S", "-F", "-", input_text=VALID_STATUS_MSG).stdout.strip()
                with self.assertRaises(ValueError):
                    _generated.validate_commit(merge_sha, VALID_STATUS_MSG)


if __name__ == "__main__":
    unittest.main()
