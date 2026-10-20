# R2 图床同步接入说明

## 更新（2026-10-17）：方案由 R2 改为 Workers Static Assets

R2 激活强制绑定境外银行卡无法开通，图片托管改为 **Workers Static Assets**
（免费档：静态资产请求免费不限量、单版本 20,000 文件、单文件 25MiB，均够用）。
Worker 配置（`wrangler.toml`）维护在博客仓库 `cloudflare/gallery-assets/`，
本仓库 Action 部署时自动拉取，日常使用习惯不变：**继续往 `LTYpicture/` push 图片即可**，
`manager/` 图床管理软件与仓库其他代码不会被部署。

## 部署产物（2026-10-20 起）

Action 现在会为每张原图生成两种变体，并把 `_headers` 一并部署：

| 路径 | 内容 | 用途 |
| --- | --- | --- |
| `LTYpicture/**` | 原图 | 原图直链 |
| `thumbs/**` | 640 宽 WebP | 画廊网格卡片 |
| `large/**` | 1600 宽 WebP（不放大） | 灯箱高清预览，避免直接加载十几 MB 原图 |
| `manifest.json` | `{ path, size, width, height, thumb, large }` | 画廊数据源 |

- 构建脚本与 `_headers` 在本仓库 `scripts/gallery-assets/` 留有 CI 副本；
  博客仓库的 `cloudflare/gallery-assets/build-manifest.mjs` 更新后需同步该副本
  （博客仓库的 `assets/` 被 gitignore，`_headers` 无法随骨架进入 CI）。
- 当前资产总量约 1.9GB / 2198 个文件（732 原图 + 732 缩略图 + 732 高清图 + 清单 + 头），
  低于 Workers 每版本 20,000 文件限制。

## 首次启用配置（一次性）

在 仓库 Settings → Secrets and variables → Actions → New repository secret 配置：

| Secret 名 | 值 | 获取方式 |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | API Token | Cloudflare 仪表盘 → My Profile → API Tokens → Create Token，使用模板 **"Edit Cloudflare Workers"**，账号资源限定本账号；无需绑卡 |
| `CLOUDFLARE_ACCOUNT_ID` | 账号 ID | Cloudflare 仪表盘首页右栏（Workers & Pages 概览页也有） |

## 运行行为

- push 到 `main` 且改动涉及 `LTYpicture/**` → 触发部署（wrangler 按内容哈希增量上传，只传新图）。
- 手动补部署：Actions 页选 "Deploy images to Workers" → Run workflow。
- 图片地址 `https://img.xinchengp.cn/LTYpicture/...`；
  缩略图 `https://img.xinchengp.cn/thumbs/...`；
  高清预览 `https://img.xinchengp.cn/large/...`；
  清单 `https://img.xinchengp.cn/manifest.json`。
- 部署前会校验 manifest：任一图片缺 `thumb`、`large`、宽高即中止，防止画廊回退原图。
- 同步失败会在 Actions 页标红，可点 Re-run。
