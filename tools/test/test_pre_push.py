# -*- coding: utf-8 -*-
# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
"""GitHub Actions 红灯判定回归：python -m unittest discover -s tools/test -v。"""

import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    "pre_push", Path(__file__).resolve().parents[1] / "githooks" / "pre_push.py")
pre_push = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pre_push)


def run_item(status, conclusion=None, head_branch="main", event="push", head_sha="a" * 40):
    return {
        "status": status,
        "conclusion": conclusion,
        "headBranch": head_branch,
        "event": event,
        "headSha": head_sha,
    }


def output(*runs):
    return json.dumps(list(runs))


class RedlightOutputTests(unittest.TestCase):
    def red(self, *runs):
        return pre_push.main_redlight_from_output(output(*runs))[0]

    def test_in_progress_and_cancelled_use_previous_green(self):
        self.assertIs(self.red(
            run_item("in_progress", None),
            run_item("queued", None),
            run_item("completed", "cancelled"),
            run_item("completed", "skipped"),
            run_item("completed", "neutral"),
            run_item("completed", "success"),
        ), False)

    def test_only_non_conclusive_runs_are_unknown(self):
        for conclusion in ("cancelled", "skipped", "neutral"):
            with self.subTest(conclusion=conclusion):
                self.assertIsNone(self.red(run_item("completed", conclusion)))

    def test_cancelled_skipped_neutral_do_not_clear_previous_failure(self):
        for conclusion in ("cancelled", "skipped", "neutral"):
            with self.subTest(conclusion=conclusion):
                self.assertIs(self.red(
                    run_item("completed", conclusion),
                    run_item("completed", "failure"),
                ), True)

    def test_in_progress_and_queued_keep_previous_failure_or_unknown(self):
        for status in ("in_progress", "queued"):
            with self.subTest(status=status):
                self.assertIsNone(self.red(run_item(status, None)))
                self.assertIs(self.red(
                    run_item(status, None),
                    run_item("completed", "failure"),
                ), True)

    def test_failure_conclusions_are_red(self):
        for conclusion in ("failure", "timed_out", "action_required", "startup_failure", "stale"):
            with self.subTest(conclusion=conclusion):
                self.assertIs(self.red(
                    run_item("completed", conclusion),
                    run_item("completed", "success"),
                ), True)

    def test_new_success_clears_old_failure(self):
        self.assertIs(self.red(
            run_item("completed", "success"),
            run_item("completed", "failure"),
        ), False)

    def test_non_main_or_non_push_runs_are_ignored(self):
        self.assertIs(self.red(
            run_item("completed", "success", head_branch="hotfix/1"),
            run_item("completed", "success", event="workflow_dispatch"),
            run_item("completed", "failure"),
        ), True)
        self.assertIs(self.red(
            run_item("completed", "failure", head_branch="surgery/x"),
            run_item("completed", "failure", event="workflow_dispatch"),
            run_item("completed", "success"),
        ), False)

    def test_unknown_conclusion_returns_none(self):
        self.assertIsNone(self.red(
            run_item("completed", "unknown"),
            run_item("completed", "success"),
        ))

    def test_invalid_or_empty_json_returns_none(self):
        self.assertIsNone(self.red())
        for raw in ("not-json", "{}", '["bad"]'):
            with self.subTest(raw=raw):
                self.assertIsNone(pre_push.main_redlight_from_output(raw)[0])

    def test_real_redlight_blocks_feature_but_allows_fix_and_revert(self):
        state = pre_push.main_redlight_from_output(output(run_item("completed", "failure")))
        with patch.object(pre_push, "remote_main_is_red", return_value=state), \
                patch.object(pre_push, "new_commits", return_value=["a" * 40]), \
                patch.object(pre_push, "sh") as command:
            command.return_value = SimpleNamespace(returncode=0, stdout="feat(reader): 新增阅读功能")
            self.assertEqual(
                pre_push.check_redlight([("new", "main", "old")]),
                [("a" * 8, "feat(reader): 新增阅读功能")],
            )
            for allowed_subject in ("fix(reader): 修复阅读错误", "fix: 修补构建立刻生效", "revert: 回退问题提交"):
                with self.subTest(subject=allowed_subject):
                    command.return_value.stdout = allowed_subject
                    self.assertEqual(pre_push.check_redlight([("new", "main", "old")]), [])

    def test_non_main_push_skips_redlight_check(self):
        with patch.object(pre_push, "remote_main_is_red") as query:
            self.assertEqual(pre_push.check_redlight([("new", "hotfix/1", "old")]), [])
            query.assert_not_called()

    def test_cancelled_build_after_green_does_not_block_feature(self):
        state = pre_push.main_redlight_from_output(output(
            run_item("completed", "cancelled"),
            run_item("completed", "success"),
        ))
        with patch.object(pre_push, "remote_main_is_red", return_value=state), \
                patch.object(pre_push, "new_commits") as commits:
            self.assertEqual(pre_push.check_redlight([("new", "main", "old")]), [])
            commits.assert_not_called()


if __name__ == "__main__":
    unittest.main()
