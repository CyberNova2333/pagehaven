# data/meta —— 作品元数据（人工维护）

每个作品一个 `<series>.yaml`，`<series>` 同时是 URL 段与图片 key 的一段。
schema 由 `@gallery/core` 定义（ARCHITECTURE §4），`npm run check` / `npm test` 校验。

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
            img: 0123456789ab   # 内容 sha256 前 12 位；key = img/<series>/<issue>/<chapter>/<n>-<img>.avif（另出同名 .webp）
            w: 1200
            h: 1700
```

图片本身不进仓库（进对象存储，经 CDN 读）；这里只有 key 的组成部分与尺寸。
