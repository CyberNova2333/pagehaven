import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

test('pre-push：Python 回归区分自动取消与真实红灯', () => {
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' };
  // 与 tools/githooks/pre-push 一致：实际执行探测，兼容 Windows 的 Python 启动器。
  const python = [['python3', []], ['python', []], ['py', ['-3']]].find(([command, args]) => {
    const probe = spawnSync(command, [...args, '-c', 'import sys; sys.exit(sys.version_info[0] != 3)'], {
      cwd: ROOT, encoding: 'utf8', env, timeout: 5_000,
    });
    return probe.status === 0;
  });
  assert.ok(python, '运行 Git 钩子回归需要 Python 3（已尝试 python3 / python / py -3）');
  const [command, args] = python;
  const result = spawnSync(command, [...args, '-B', '-m', 'unittest', 'discover', '-s', 'tools/test', '-v'], {
    cwd: ROOT, encoding: 'utf8', env, timeout: 30_000,
  });
  assert.equal(result.status, 0, [result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n'));
  assert.match(result.stderr, /Ran [1-9]\d* tests?\b/, 'Python 回归必须实际发现并执行测试');
});
