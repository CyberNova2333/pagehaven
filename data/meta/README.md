# data/meta —— 作品元数据（人工维护）

[返回「页间 · Pagehaven」项目说明](../../README.md)

默认模板不附带作品；发布自己的漫画时，先在这里添加对应元数据。
每个作品一个 `<series>.yaml`，`<series>` 同时是 URL 段与图片 key 的一段。
schema 由 `@gallery/core` 定义（ARCHITECTURE §4），修改后先用 `npm run check:data` 检查，
无需构建站点；完整检查与测试仍由 `npm run check` / `npm test` 执行。
元数据扩展名必须小写 `.yaml` 或 `.yml`，正式台词扩展名必须小写 `.json`；大写或混合
大小写扩展名会明确报错，避免上传的文件被静默忽略。

```yaml
id: sample              # = 文件名，URL 段：/<series>/
title: 作品标题
sort: 1                   # 首页排序
issues:
  - id: vol03             # URL 段：/<series>/<issue>/
    number: 3
    title: 第三卷
    published: 2020-01-01
    chapters:
      - id: c012          # URL 段：/<series>/<issue>/<chapter>/（每话恰好一个 HTML）
        number: 12
        title: 第十二话
        pages:
          - n: 1
            img: 0123456789ab   # 内容 sha256 前 12 位；key = img/<series>/<issue>/<chapter>/<n>-<img>.webp
            w: 1200
            h: 1700
```

图片本身不进仓库（进对象存储，经 CDN 读）；这里只有 key 的组成部分与尺寸。

作品 `id` 不能是 `search` `api` `index` `series` `404` `cname`——它们是站点固定路由或平台
基线文件，撞上时 Astro 只会静默让静态路由赢，`build:site` 会直接报错拦下。
