# R2 图床同步接入说明

## 更新（2026-10-17）：方案由 R2 改为 Workers Static Assets

R2 激活强制绑定境外银行卡无法开通，图片托管改为 **Workers Static Assets**
（免费档：静态资产请求免费不限量、单版本 20,000 文件、单文件 25MiB，均够用）。
Worker 骨架维护在博客仓库 `cloudflare/gallery-assets/`，本仓库 Action 部署时
自动拉取，日常使用习惯不变：**继续往 `LTYpicture/` push 图片即可**，
push 后 1~3 分钟全站可见（`manager/` 图床管理软件与仓库其他代码不会被部署）。

## 首次启用配置（一次性）

在 仓库 Settings → Secrets and variables → Actions → New repository secret 配置：

| Secret 名 | 值 | 获取方式 |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | API Token | Cloudflare 仪表盘 → My Profile → API Tokens → Create Token，使用模板 **"Edit Cloudflare Workers"**，账号资源限定本账号；无需绑卡 |
| `CLOUDFLARE_ACCOUNT_ID` | 账号 ID | Cloudflare 仪表盘首页右栏（Workers & Pages 概览页也有） |

## 运行行为

- push 到 `main` 且改动涉及 `LTYpicture/**` → 触发部署（wrangler 按内容哈希增量上传，只传新图）。
- 手动补部署：Actions 页选 "Deploy images to Workers" → Run workflow。
- 图片地址 `https://img.xinchengp.cn/LTYpicture/...`；清单 `https://img.xinchengp.cn/list`。
- 同步失败会在 Actions 页标红，可点 Re-run；画廊侧检测不到新清单时自动回退 jsDelivr 镜像，不会白屏。
