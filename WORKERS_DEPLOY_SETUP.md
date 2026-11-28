# Workers Static Assets 图床部署说明

## 历史（2026-10-17）：方案由 R2 改为 Workers Static Assets

R2 激活强制绑定境外银行卡无法开通，图片托管改为 **Workers Static Assets**
（免费档：静态资产请求免费不限量、单 Worker 单版本 20,000 文件、单文件 25MiB）。
Worker 配置（`wrangler.toml` 等）维护在博客仓库 `cloudflare/gallery-assets/`，
本仓库 Action 部署时自动拉取，日常使用习惯不变：**继续往 `LTYpicture/` push 图片即可**，
`manager/` 图床管理软件与仓库其他代码不会被部署。

## 部署产物（2026-11-28 起：按变体拆分三个 Worker）

单 Worker 单版本上限 20,000 文件，而每张图会生成原图 + thumb + large 三份资产，
全部放一个 Worker 会先撞上限。现在按顶层目录拆成三个 Worker，各自拥有 20,000 额度：

| Worker | 资产 | 对外路径 | 当前文件数 |
| --- | --- | --- | ---: |
| `gallery-assets` | `LTYpicture/**` + `manifest.json` + `_headers` | `/LTYpicture/**`、`/manifest.json` | 1,520 |
| `gallery-thumbs` | `thumbs/**` + `_headers` | `/thumbs/**` | 1,519 |
| `gallery-large` | `large/**` + `_headers` | `/large/**` | 1,351 |

- `gallery-assets` 保留 `img.xinchengp.cn` Custom Domain；`/thumbs/*`、`/large/*`
  由同 hostname 上更具体的 Workers Route 先命中分片 Worker，**对外 URL 完全不变**，
  manifest 相对路径与画廊前端拼接逻辑无需改动。
- 当前 1,518 张图（168 张动图不生成 large）→ 4,388 个资产，拆分后总计 4,390 个文件
  （每个分片多一份 `_headers`）。
- 有效容量约 **20,000 张图**（瓶颈是原图/thumb），按当前净增约 12 张/天约 **4 年**；
  拆分前单 Worker 约 6,900 张、约 14 个月。
- `split-assets.mjs` 会在任一分片达到 19,000 时告警、达到 20,000 时直接失败，
  避免部署到一半才撞上限。
- 三个 Worker 不是同一个原子版本：**新增图**不受影响；同一次部署里被替换/删除的图，
  旧 thumb/large 可能在最长约 2 分钟（manifest 缓存）内 404。

## 首次启用配置（一次性）

在仓库 Settings → Secrets and variables → Actions → New repository secret 配置：

| Secret 名 | 值 | 获取方式 |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | API Token | Cloudflare 仪表盘 → My Profile → API Tokens → Create Token，使用模板 **"Edit Cloudflare Workers"**，账号资源限定本账号；需要 Workers Scripts:Edit、Workers Routes:Edit、Zone:Read；无需绑卡 |
| `CLOUDFLARE_ACCOUNT_ID` | 账号 ID | Cloudflare 仪表盘首页右栏（Workers & Pages 概览页也有） |

如果 token 是旧模板创建的、缺少 Workers Routes 权限，部署分片时会报认证错误，
重建 token 并更新 Secret 即可。

## 运行行为

- push 到 `main` 且改动涉及 `LTYpicture/**` → 触发部署。
- 手动补部署：Actions 页选 "Deploy images to Workers" → Run workflow。
  **修改本 workflow 或博客仓库配置本身不会自动触发**，合并后需手动跑一次。
- Action 会为每张原图生成两种变体，并拆分到三个 Worker：

| 路径 | 内容 | 用途 |
| --- | --- | --- |
| `LTYpicture/**` | 原图 | 原图直链 |
| `thumbs/**` | 640 宽 WebP | 画廊网格卡片 |
| `large/**` | 1600 宽 WebP（不放大） | 灯箱高清预览；动图不生成，灯箱回退原 GIF |
| `manifest.json` | `{ path, size, width, height, thumb, large?, animated? }` | 画廊数据源 |

- 部署顺序固定为 **thumbs → large → 主 Worker**：主 Worker 最后上，manifest 才
  不会指向尚未部署的变体；任一步失败，主 Worker 仍保留旧清单。
- 图片地址 `https://img.xinchengp.cn/LTYpicture/...`；
  缩略图 `https://img.xinchengp.cn/thumbs/...`；
  高清预览 `https://img.xinchengp.cn/large/...`；
  清单 `https://img.xinchengp.cn/manifest.json`。
- 部署前会校验 manifest：静图必须同时有 `thumb`、`large`、宽高；动图（GIF/APNG/动态 WebP）
  允许没有 `large`，灯箱会回退原文件以保留动画。任一分片文件数与 manifest 不一致、
  或任一分片触达 20,000 上限都会中止部署。
- Action 会缓存 `thumbs/` 与 `large/`（key 为图库内容哈希，未变图片直接复用变体），
  每次部署只重新生成新增/变化的图片；拆分用硬链接，不额外复制 GB 级资产。
- 同步失败会在 Actions 页标红，可点 Re-run。

## 容量继续扩展

- **免费**：把某个变体再按二级目录拆 Worker（例如 thumbs 拆成 `heng`/`shu`），
  每个新 Worker 重新获得 20,000 额度；注意 `wallpapers&illustration` 含 `&`，
  路由模式需要实测，优先按不含特殊字符的二级目录拆。
- **Workers Paid**（$5/月）：单 Worker 100,000 文件/版本，当前配置不用改，
  wrangler 需 ≥ 4.34（CI 安装的 `wrangler@^4` 已满足）。
- **R2**：没有单版本文件数限制，但需要绑卡并把上传/直链流程迁到 R2。

## 相关文件

- 本仓库：`.github/workflows/deploy-gallery.yml`、`scripts/gallery-assets/`（CI 副本）
- 博客仓库：`cloudflare/gallery-assets/`（`wrangler.toml`、`wrangler.thumbs.toml`、
  `wrangler.large.toml`、`split-assets.mjs`、`build-manifest.mjs`、`_headers`、README）
