# -*- coding: utf-8 -*-
"""CNB 红灯判定回归：python -m unittest discover -s tools/test -v。"""

import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    "pre_push", Path(__file__).resolve().parents[1] / "githooks" / "pre_push.py")
pre_push = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pre_push)


def build(status, pipelines=None, count=None, total=None):
    lines = ["    - sn: example-build", "      status: " + status]
    if pipelines is not None:
        count = len(pipelines) if count is None else count
        total = count if total is None else total
        lines += ["      pipelineTotalCount: %d" % total,
                  "      pipelines[%d]{id,createTime,duration,labels,status}:" % count]
        for i, pipeline in enumerate(pipelines):
            lines.append('        example-%d,"2026-01-01T00:00:00.000Z",100,"ARCH=amd64,cpus=8,memory=16",%s'
                         % (i, pipeline))
    return "\n".join(lines)


def output(*builds):
    return "status: 200\ndata:\n  data[%d]:\n%s\n  timestamp: 1\n" % (
        len(builds), "\n".join(builds))


class RedlightOutputTests(unittest.TestCase):
    def red(self, *builds):
        return pre_push.main_redlight_from_output(output(*builds))[0]

    def test_auto_cancelled_errors_use_previous_green(self):
        # 与现场输出一致：最新 pending，三次顶层 error / 流水线 cancel，之前为绿色。
        self.assertIs(self.red(build("pending", ["pending"]),
                               build("error", ["cancel"]),
                               build("error", ["cancel"]),
                               build("error", ["cancel"]),
                               build("success", ["success"])), False)

    def test_all_cancelled_pipelines_are_not_a_failure(self):
        self.assertIsNone(self.red(build("error", ["cancel", "cancel"])))

    def test_cancellation_does_not_clear_previous_failure(self):
        self.assertIs(self.red(build("error", ["cancel"]),
                               build("error", ["error"])), True)

    def test_real_pipeline_failure_is_red(self):
        self.assertIs(self.red(build("error", ["error"]),
                               build("success", ["success"])), True)

    def test_mixed_cancellation_and_error_is_red(self):
        self.assertIs(self.red(build("error", ["cancel", "error"])), True)
        self.assertIs(self.red(build("cancel", ["cancel", "error"])), True)

    def test_pending_has_no_result_and_keeps_previous_failure(self):
        self.assertIsNone(self.red(build("pending", ["pending"])))
        self.assertIs(self.red(build("pending", ["pending"]),
                               build("error", ["error"])), True)

    def test_explicit_cancellation_keeps_previous_result(self):
        self.assertIsNone(self.red(build("cancel", ["cancel"])))
        self.assertIs(self.red(build("cancel", ["cancel"]),
                               build("error", ["error"])), True)

    def test_new_success_clears_old_failure(self):
        self.assertIs(self.red(build("success", ["success"]),
                               build("error", ["error"])), False)

    def test_missing_or_incomplete_pipeline_table_cannot_clear_error(self):
        for candidate in (build("error"), build("error", []),
                          build("error", ["cancel"], count=2),
                          build("error", ["cancel"], total=2),
                          build("error", ["cancel", "unknown"])):
            with self.subTest(candidate=candidate):
                self.assertIs(self.red(candidate), True)

    def test_malformed_csv_cannot_clear_error(self):
        candidate = build("error", ["cancel"]).replace(
            '"ARCH=amd64,cpus=8,memory=16",cancel', '"unfinished,cancel')
        self.assertIs(self.red(candidate), True)

    def test_missing_status_column_cannot_clear_error(self):
        candidate = build("error", ["cancel"]).replace("labels,status}", "labels,result}")
        self.assertIs(self.red(candidate), True)

    def test_no_records_or_failed_query_is_unknown(self):
        self.assertIsNone(self.red())
        self.assertIsNone(pre_push.main_redlight_from_output("status: 403\n")[0])

    def test_real_redlight_still_blocks_feature_but_allows_fix(self):
        state = pre_push.main_redlight_from_output(output(build("error", ["error"])))
        with patch.object(pre_push, "remote_main_is_red", return_value=state), \
                patch.object(pre_push, "new_commits", return_value=["a" * 40]), \
                patch.object(pre_push, "sh") as command:
            command.return_value = SimpleNamespace(returncode=0, stdout="feat(reader): 新增阅读功能")
            self.assertEqual(pre_push.check_redlight([("new", "main", "old")]),
                             [("a" * 8, "feat(reader): 新增阅读功能")])
            command.return_value.stdout = "fix(reader): 修复阅读错误"
            self.assertEqual(pre_push.check_redlight([("new", "main", "old")]), [])

    def test_cancelled_build_after_green_does_not_block_feature(self):
        state = pre_push.main_redlight_from_output(output(
            build("error", ["cancel"]), build("success", ["success"])))
        with patch.object(pre_push, "remote_main_is_red", return_value=state), \
                patch.object(pre_push, "new_commits") as commits:
            self.assertEqual(pre_push.check_redlight([("new", "main", "old")]), [])
            commits.assert_not_called()


if __name__ == "__main__":
    unittest.main()
