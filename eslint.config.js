// ESLint 平面配置。`npm run check` 会跑它（AGENTS.md §3：check = 预算守卫 + 配置同步 + lint）。
//
// 只管 JS：.astro 文件由 astro build 自己校验；「packages 里不许 import Node 内置模块」
// 那条不放在这里——它是铁律，判定在 scripts/check.mjs 里，不能靠一份可被改掉的 lint 配置。
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'out/**',
      // 样本空跑（CI 的 stage「用测试样本全量空跑」）把产物写在仓库根的临时目录：
      // 搜索页现在会生成 _astro/*.js，eslint . 不能把它们当源码扫。
      'fixture-dist/**',
      'fixture-out/**',
      '**/.astro/**',
      'packages/site/src/generated/**',
      '**/*.astro',
    ],
  },
  js.configs.recommended,
  {
    // 构建期脚本与测试：跑在 Node 上
    files: ['scripts/**/*.mjs', 'eslint.config.js', 'packages/*/test/**/*.js', 'packages/*/astro.config.mjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.node } },
  },
  {
    // 平台无关代码：浏览器 / Worker 全局，只有 Web 标准 API
    files: ['packages/*/src/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.browser, ...globals.worker } },
  },
  {
    // 临时维护工具的界面在浏览器运行，服务端仍在 scripts/**/*.mjs。
    files: ['scripts/customize/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.browser } },
  },
  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
];
