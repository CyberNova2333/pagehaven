#!/usr/bin/env node
// 把 GitHub Secret 中的 YAML/JSON 对象注入单个子进程，不打印或落盘秘密。
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

export function environmentFromSecrets(source) {
  if (typeof source !== 'string' || source.trim() === '') throw new Error('密钥变量为空或不是字符串');
  const value = yaml.load(source);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('密钥内容必须是 YAML/JSON 对象');
  const environment = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    if (key.startsWith('allow_')) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('密钥对象包含无效环境变量名');
    if (item === null || !['string', 'number', 'boolean'].includes(typeof item)) throw new Error(`密钥字段 ${key} 必须是标量`);
    environment[key] = String(item);
  }
  return environment;
}

export async function runWithSecrets(secretVariable, command, args = []) {
  if (!secretVariable || !command) throw new Error('用法：run-with-secrets.mjs <密钥变量名> <命令> [参数...]');
  const secrets = environmentFromSecrets(process.env[secretVariable]);
  const child = spawn(command, args, {
    env: { ...process.env, ...secrets },
    stdio: 'inherit',
    shell: false,
  });
  return await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`命令被信号 ${signal} 终止`));
      else resolve(code ?? 1);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [secretVariable, command, ...args] = process.argv.slice(2);
  runWithSecrets(secretVariable, command, args)
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error(`密钥命令启动失败：${error.message}`);
      process.exitCode = 1;
    });
}
