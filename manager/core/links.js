'use strict';
/**
 * 模块：访问链接批量生成与导出
 * ---------------------------------------------------------------
 * 链接格式（config.repo 提供归属信息）：
 *  - jsDelivr CDN：https://cdn.jsdelivr.net/gh/{owner}/{name}@{branch}/{路径}
 *  - GitHub Raw  ：https://raw.githubusercontent.com/{owner}/{name}/{branch}/{路径}
 *
 * URL 编码策略：仅对会破坏 URL 语义的字符（空格/?/#）做最小编码。
 * 仓库路径中的 "&"（如 wallpapers&illustration）在 URL 路径段中合法，
 * 保持原样兼容性最好（jsDelivr 与 GitHub Raw 均可直接访问）。
 *
 * 导出格式：txt（纯链接）/ json（完整元数据）/ csv（表格）/ markdown（可直接贴文档）
 */

const path = require('path');

/** 最小化 URL 编码：处理空格、?、# 与全部非 ASCII 字符（如中文目录名）。
 *  "&" 在 URL 路径段中合法，保持原样兼容性最好（jsDelivr 与 GitHub Raw 均可直接访问）。
 *  非 ASCII 仅做百分号编码、不改变字符本身，浏览器地址栏仍显示为中文。 */
function encodeUrlPath(p) {
  return p
    .replace(/[^\x20-\x7E&]/g, (ch) => encodeURIComponent(ch))
    .replace(/ /g, '%20').replace(/\?/g, '%3F').replace(/#/g, '%23');
}

/**
 * 由图库相对路径生成访问链接
 * @param {'jsdelivr'|'fastly'|'testingcf'|'gcore'|'raw'} linkType
 *   jsdelivr 系列仅域名不同：主站国内不稳时可用 fastly / testingcf / gcore 镜像，
 *   内容与主站完全一致（同一 CDN 缓存体系的不同接入点）。
 */
const JSDELIVR_HOSTS = {
  jsdelivr: 'cdn.jsdelivr.net',
  fastly: 'fastly.jsdelivr.net',
  testingcf: 'testingcf.jsdelivr.net',
  gcore: 'gcore.jsdelivr.net'
};

function buildLink(cfg, rel, linkType = cfg.linkFormat) {
  const { owner, name, branch } = cfg.repo;
  if (!owner || !name) {
    throw new Error('仓库归属信息缺失：请在 manager/config.json 的 repo 字段填写 owner/name');
  }
  const repoPath = `${cfg.imageRoot}/${rel}`.replace(/\\/g, '/');
  const encoded = encodeUrlPath(repoPath);
  if (linkType === 'raw') {
    return `https://raw.githubusercontent.com/${owner}/${name}/${branch}/${encoded}`;
  }
  const host = JSDELIVR_HOSTS[linkType] || JSDELIVR_HOSTS.jsdelivr;
  return `https://${host}/gh/${owner}/${name}@${branch}/${encoded}`;
}

/**
 * 批量导出链接
 * @param {Array<{rel,name,w,h,size,category}>} rows listImages 返回的行
 * @param {'txt'|'json'|'csv'|'markdown'} format
 */
function exportLinks(cfg, rows, linkType, format) {
  const lines = rows.map((r) => ({ ...r, url: buildLink(cfg, r.rel, linkType) }));

  switch (format) {
    case 'json':
      return JSON.stringify(lines.map((l) => ({
        name: l.name, path: `${cfg.imageRoot}/${l.rel}`.replace(/\\/g, '/'),
        category: l.category, width: l.w, height: l.h, size: l.size, url: l.url
      })), null, 2);

    case 'csv':
      // CSV 头 + 行；字段用双引号包裹并转义内部双引号。
      // 前置 UTF-8 BOM：Excel 依赖 BOM 识别编码，否则中文表头/内容打开即乱码。
      return '\uFEFF' + ['文件名,分类,宽,高,大小(字节),链接']
        .concat(lines.map((l) =>
          `"${l.name}","${l.category}",${l.w},${l.h},${l.size},"${l.url}"`))
        .join('\r\n'); // Windows 记事本友好换行

    case 'markdown':
      // Markdown 图片语法，便于直接粘贴到博客/文档
      return lines.map((l) => `![${path.parse(l.name).name}](${l.url})`).join('\n\n');

    case 'html':
      // HTML img 标签（每行一条，可直接贴网页）
      return lines.map((l) => `<img src="${l.url}" alt="${path.parse(l.name).name}" />`).join('\n');

    case 'bbcode':
      // BBCode（论坛常用）
      return lines.map((l) => `[img]${l.url}[/img]`).join('\n');

    case 'txt':
    default:
      return lines.map((l) => l.url).join('\n');
  }
}

/** 单图链接 + 各格式代码片段（前端"一键复制"用） */
function linkBundle(cfg, row, linkType) {
  const url = buildLink(cfg, row.rel, linkType);
  const alt = path.parse(row.name).name;
  return {
    url,
    markdown: `![${alt}](${url})`,
    html: `<img src="${url}" alt="${alt}" />`,
    bbcode: `[img]${url}[/img]`
  };
}

module.exports = { buildLink, exportLinks, linkBundle, encodeUrlPath, JSDELIVR_HOSTS };
