# -*- coding: utf-8 -*-
# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
"""GitHub 主仓库定位与等价提交匹配回归。"""

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

TOOLS_DIR = Path(__file__).resolve().parents[1]
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import github_repo  # noqa: E402


def isolated_env(extra=None):
    env = {k: v for k, v in os.environ.items()
           if not k.startswith("GIT_") and not k.startswith("SSH_")}
    env.update({
        "LC_ALL": "C",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_AUTHOR_NAME": "Fixture",
        "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
        "GIT_COMMITTER_NAME": "Fixture",
        "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
    })
    if extra:
        env.update(extra)
    return env


class GithubRepoTests(unittest.TestCase):
    def test_github_slug_valid_and_invalid(self):
        valid = {
            "https://github.com/CyberNova2333/pagehaven": "CyberNova2333/pagehaven",
            "https://github.com/CyberNova2333/pagehaven.git": "CyberNova2333/pagehaven",
            "https://github.com/CyberNova2333/pagehaven/": "CyberNova2333/pagehaven",
            "git@github.com:CyberNova2333/pagehaven.git": "CyberNova2333/pagehaven",
            "ssh://github.com/owner-1/repo_2.js.git": "owner-1/repo_2.js",
        }
        for url, expected in valid.items():
            with self.subTest(url=url):
                self.assertEqual(github_repo.github_slug(url), expected)

        invalid = [
            "",
            "https://example.invalid/owner/repo.git",
            "http://github.com/owner/repo",
            "https://github.com/owner/repo?tab=1",
            "https://github.com/owner/repo#readme",
            "https://github.com/owner/repo/extra",
            "https://github.com/owner/",
            "git@gitlab.com:owner/repo.git",
        ]
        for url in invalid:
            with self.subTest(url=url):
                self.assertIsNone(github_repo.github_slug(url))

    def test_github_remote_priority_and_ambiguity(self):
        remotes = {
            "origin": "https://example.invalid/mirror/repo.git",
            "github": "https://github.com/owner/main.git",
            "fork": "git@github.com:other/fork.git",
        }

        def fake_git(*args):
            if args == ("remote",):
                return "\n".join(remotes)
            if args[:2] == ("remote", "get-url"):
                return remotes[args[2]]
            return ""

        with patch.object(github_repo, "git", side_effect=fake_git):
            self.assertEqual(github_repo.github_remote(), ("github", "owner/main"))
            self.assertEqual(github_repo.github_remote("fork"), ("fork", "other/fork"))

        remotes_origin_only = {
            "origin": "https://github.com/owner/origin.git",
            "fork": "https://github.com/other/fork.git",
        }
        with patch.object(github_repo, "git", side_effect=lambda *a: "\n".join(remotes_origin_only) if a == ("remote",) else remotes_origin_only[a[2]]):
            self.assertEqual(github_repo.github_remote(), ("origin", "owner/origin"))

        remotes_single = {"upstream": "ssh://github.com/owner/single.git"}
        with patch.object(github_repo, "git", side_effect=lambda *a: "upstream" if a == ("remote",) else remotes_single[a[2]]):
            self.assertEqual(github_repo.github_remote(), ("upstream", "owner/single"))

        remotes_ambiguous = {
            "fork-a": "https://github.com/a/repo.git",
            "fork-b": "https://github.com/b/repo.git",
        }
        with patch.object(github_repo, "git", side_effect=lambda *a: "\n".join(remotes_ambiguous) if a == ("remote",) else remotes_ambiguous[a[2]]):
            with self.assertRaises(ValueError):
                github_repo.github_remote()

        with patch.object(github_repo, "git", side_effect=lambda *a: "origin" if a == ("remote",) else "https://example.invalid/a/b.git"):
            with self.assertRaises(ValueError):
                github_repo.github_remote()

    def test_equivalent_commit_matches_tree_and_message(self):
        env = isolated_env()
        with tempfile.TemporaryDirectory(prefix="pagehaven-ghrepo-") as tmp:
            repo = Path(tmp)
            subprocess.run(["git", "init", "-b", "main"], cwd=repo, env=env, check=True, stdout=subprocess.DEVNULL)
            (repo / "file.txt").write_text("hello\n", encoding="utf-8")
            subprocess.run(["git", "add", "file.txt"], cwd=repo, env=env, check=True)
            msg = "feat(core): 初始化测试内容\n\n文档: 测试不影响文档\n"
            subprocess.run(
                ["git", "-c", "commit.gpgsign=false", "commit", "-m", msg],
                cwd=repo, env={**env, "GIT_AUTHOR_DATE": "2026-11-01T00:00:00Z", "GIT_COMMITTER_DATE": "2026-11-01T00:00:00Z"},
                check=True, stdout=subprocess.DEVNULL,
            )
            main_sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, env=env, text=True).strip()
            tree_sha = subprocess.check_output(["git", "rev-parse", f"{main_sha}^{{tree}}"], cwd=repo, env=env, text=True).strip()

            mirror_sha = subprocess.check_output(
                ["git", "commit-tree", tree_sha, "-m", msg],
                cwd=repo,
                env={**env, "GIT_AUTHOR_NAME": "Mirror", "GIT_AUTHOR_DATE": "2026-11-02T00:00:00Z", "GIT_COMMITTER_DATE": "2026-11-02T00:00:00Z"},
                text=True,
            ).strip()
            diff_msg_sha = subprocess.check_output(
                ["git", "commit-tree", tree_sha, "-m", "chore(core): 不同信息\n"],
                cwd=repo, env=env, text=True,
            ).strip()

            (repo / "file.txt").write_text("changed\n", encoding="utf-8")
            subprocess.run(["git", "add", "file.txt"], cwd=repo, env=env, check=True)
            other_tree = subprocess.check_output(["git", "write-tree"], cwd=repo, env=env, text=True).strip()
            diff_tree_sha = subprocess.check_output(
                ["git", "commit-tree", other_tree, "-m", msg],
                cwd=repo, env=env, text=True,
            ).strip()

            def repo_git(*args):
                res = subprocess.run(["git", *args], cwd=repo, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace")
                return res.stdout.strip() if res.returncode == 0 else ""

            with patch.object(github_repo, "git", side_effect=repo_git):
                self.assertEqual(github_repo.equivalent_commit(mirror_sha, "origin"), main_sha)
                self.assertIsNone(github_repo.equivalent_commit(diff_msg_sha, "origin"))
                self.assertIsNone(github_repo.equivalent_commit(diff_tree_sha, "origin"))


if __name__ == "__main__":
    unittest.main()
