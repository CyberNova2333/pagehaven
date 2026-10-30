# 页间 · Pagehaven：一次真实主流程

维护者更新作品元数据和文字层后，希望发布一个浏览器能直接打开的阅读站。这里沿静态构建解释数据怎样进入页面，以及为什么页面、检索库和发布清单必须来自同一次构建。

下面的 case 是依据源码分支整理的代表性输入与结果，不是本轮线上观测。

| 输入或状态 | 动作与结果 |
| --- | --- |
| 空内容模板 | 允许构建；没有章节路由，仍保留其余站点页面 |
| 同一内容、清单与检索库 | 站点能读取匹配的检索指针 |
| 内容或域名与检索清单不同 | build:site 拒绝，需完整重建 |
| 无对象存储凭据的 dry-run | 图片在线核对标为未校验 |

## Step 1: 把配置和内容固定为一次构建输入

维护者在站点配置和 data 中描述内容。完整构建先生成平台配置，再读取作品树生成清单。清单记录版本、页面地址和图片 key；没有凭据时对象存储核对会跳过并标明未校验，这不能解释为图片已在线验证。

[对应实现](../../scripts/build-manifest.mjs)，定位 `buildManifest、verifyOnly、MISSING_FILE`。

## Step 2: 给检索库绑定相同版本

文字与元数据进入可在浏览器使用的 SQLite 检索库。建库步骤核对已有清单的版本和内容指纹，写出带版本的库及分块清单，再把数据库指针回填发布清单。跳过版本核对会让页面指向另一批缓存字节，所以同名发布对象不能任意覆盖。

[对应实现](../../scripts/build-db.mjs)，定位 `readManifest、resolveVersion、galleryFingerprint`。

## Step 3: 每话生成一个可直接浏览的页面

站点步骤把内容写入生成目录，再调用 Astro 构建。空内容模板仍会生成其余页面；有内容时每话页面承载页面列表与文字层。若检索清单的指纹、域名或明确发布版本与站点不一致，步骤会在生成前报错，要求重新执行完整构建。

[对应实现](../../scripts/build-site.mjs)，定位 `writeSiteGalleryJson、manifest.sourceSha256 检查、astro build`。

## Step 4: 补齐静态托管需要的文件

构建随后写出索引和 sitemap，并按开关放入平台配置。关闭平台配置时仍保留纯静态基线；GitHub Pages 的兜底文件和必要的静态跳转页由站点步骤生成。图片与数据库不应混入站点 HTML 产物，它们有独立发布位置。

[对应实现](../../scripts/build-site.mjs)，定位 `GENERATED_FILES、.nojekyll、metaRefresh`。

## Step 5: 用预算与真实构建约束结果

维护检查守住文件数、单文件大小、每话 HTML、配置同步等约束。集成测试会用最小夹具走实际构建，但会触及共享生成目录，因此本轮只读测试证据，避免覆盖正在预览的产物。

同一检查入口还核对双语 README 的章节链接。修改标题后，导航参数必须同步到 CNB 生成的锚点，例如 `Getting started` 使用 `#getting-started`；旧的 `#section-1` 或错误大小写会导致检查失败。

[对应实现](../../scripts/test/site-build.test.mjs)，定位 `CONFIG_FILE / DATA_DIR / DIST_DIR / OUT_DIR、run`。

## 检查这条解释

```sh
npm run check
npm test
npm run build
```

以上业务检查未执行；npm run build 和站点集成测试都可能写入共享生成目录，本轮只运行独立文档站构建。正式验收仍需 npm run check、npm test、npm run build，涉及平台适配时按根规则另做预览部署。

理解这条交接后，用[代码地图定位下一次修改](../code-map.md)；需要反查依据时查看[源码调查与边界证据](../references/source-evidence.md)。

证据状态：除特别标注外，本页基于当前源码已确认。
