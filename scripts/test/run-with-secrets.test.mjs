import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { environmentFromSecrets, runWithSecrets } from '../ci/run-with-secrets.mjs';

test('YAML 与 JSON 标量转为子进程环境，控制字段不进入环境', () => {
  assert.deepEqual({ ...environmentFromSecrets('STRING: value\nNUMBER: 42\nENABLED: true\nallow_branches: [main]\n') }, {
    STRING: 'value',
    NUMBER: '42',
    ENABLED: 'true',
  });
  assert.deepEqual({ ...environmentFromSecrets('{"TOKEN":"json-value"}') }, { TOKEN: 'json-value' });
});

test('拒绝空内容、集合值与无效变量名，不回显秘密', () => {
  for (const source of ['', '[]', 'VALUE:\n  nested: secret', 'BAD-NAME: secret']) {
    assert.throws(() => environmentFromSecrets(source), (error) => !error.message.includes('secret'));
  }
});

test('只在子进程中合并秘密并保留原有环境', async () => {
  const variable = 'PAGEHAVEN_TEST_SECRETS';
  process.env[variable] = 'INJECTED_VALUE: from-secret\nallow_events: [push]';
  try {
    const code = await runWithSecrets(variable, process.execPath, [
      '--input-type=module',
      '-e',
      "if (process.env.INJECTED_VALUE !== 'from-secret' || !process.env.PATH || 'allow_events' in process.env) process.exit(2)",
    ]);
    assert.equal(code, 0);
    assert.equal(process.env.INJECTED_VALUE, undefined);
  } finally {
    delete process.env[variable];
  }
});

test('命令行入口透传非零退出码，缺少变量时失败', () => {
  const script = fileURLToPath(new URL('../ci/run-with-secrets.mjs', import.meta.url));
  const missing = spawnSync(process.execPath, [script, 'PAGEHAVEN_MISSING_TEST_SECRET', process.execPath, '-e', ''], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.doesNotMatch(missing.stderr + missing.stdout, /undefined/);
});
