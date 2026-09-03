#!/usr/bin/env node
// status —— 由 release.yml 在发布末尾调用，写 STATUS.md（铁律 10：不手改）
import { placeholder } from './lib/placeholder.mjs';
placeholder('status', [
  '写 STATUS.md：版本、当前部署目标、对象存储对象清单、DB 大小、dist 文件数、耗时',
  '它是弃维护后别人接手的入口；只由 release.yml 调用并以 CI 身份提交',
]);
