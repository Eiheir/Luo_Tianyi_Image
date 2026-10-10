'use strict';
/**
 * 模块：图库查询 / 统计聚合 / 缩略图缓存 / 回收站
 * ---------------------------------------------------------------
 *  1. listImages：基于索引的列表查询（分类/格式/关键词过滤）
 *  2. buildStats：聚合统计（分类、格式、容量、编号使用进度），供前端可视化
 *  3. makeThumbnail：动态缩略图（sharp 缩放 → webp，落盘缓存，二次访问零开销）
 *  4. 回收站：删除操作一律"移动"到 manager/.trash/<批次>/，支持恢复，
 *     绝不物理删除——这是"不影响原有图床业务"的兜底保障
 */

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const sharp = require('sharp');

/** 从相对路径推断分类（与 classify.categoryDir 的目录约定一一对应） */
function categoryOf(relPath, cfg) {
  const c = cfg.classify;
  const rel = relPath.replace(/\\/g, '/');
  if (rel.startsWith(`${c.emoticonDir}/`)) return 'emoticon';
  if (rel.startsWith(`${c.wallpaperDir}/heng/`)) return 'heng';
  if (rel.startsWith(`${c.wallpaperDir}/shu/`)) return 'shu';
  if (rel.startsWith(`${c.wallpaperDir}/avatar/`)) return 'avatar';
  if (rel.startsWith(`${c.temporaryDir.replace(/\\/g, '/')}/`)) return 'temporary';
  return '其他';
}

/**
 * 列表查询
 * @param {{category?:string, format?:string, q?:string}} filters
 *   category: 全部分类值或 '其他'；format: jpg/png/...；q: 文件名关键词
 */
function listImages(index, cfg, filters = {}) {
  const rows = [];
  for (const [rel, it] of Object.entries(index.items)) {
    const cat = categoryOf(rel, cfg);
    if (filters.category && filters.category !== 'all' && cat !== filters.category) continue;
    const ext = path.extname(rel).slice(1).toLowerCase();
    if (filters.format && filters.format !== 'all' && ext !== filters.format.toLowerCase()) continue;
    if (filters.q) {
      const kw = String(filters.q).toLowerCase();
      const base = path.basename(rel).toLowerCase();
      if (!base.includes(kw) && !rel.toLowerCase().includes(kw)) continue;
    }
    rows.push({
      rel,
      category: cat,
      format: ext,
      name: path.basename(rel),
      w: it.w, h: it.h,
      size: it.size,
      mtime: it.mtime,
      md5: it.md5 || '',
      dhash: it.dhash || ''
    });
  }
  rows.sort((a, b) => b.mtime - a.mtime); // 最近更新在前
  return rows;
}

/** 人类可读字节数（统计卡片直接展示用） */
function humanSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * 聚合统计：
 *  - total：总数/总容量
 *  - byCategory：每分类 数量/容量/最大编号/编号上限
 *  - byFormat：每种格式的 数量/容量
 *  - latest：最近更新的 8 张图
 */
function buildStats(index, cfg) {
  const byCategory = {};
  const byFormat = {};
  let total = { count: 0, size: 0 };
  let latest = [];
  const capMain = Math.pow(10, cfg.naming.padding) - 1;    // 主图编号上限 9999
  const capEmo = Math.pow(10, cfg.naming.emoticonPadding) - 1; // 表情包上限 999

  for (const [rel, it] of Object.entries(index.items)) {
    const cat = categoryOf(rel, cfg);
    const ext = path.extname(rel).slice(1).toLowerCase();

    if (!byCategory[cat]) byCategory[cat] = { count: 0, size: 0, maxNumber: 0 };
    byCategory[cat].count += 1;
    byCategory[cat].size += it.size;

    // 解析编号（用于"编号使用进度"可视化）
    const m = path.basename(rel).match(/^(\d+)\./);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > byCategory[cat].maxNumber) byCategory[cat].maxNumber = n;
    }

    if (!byFormat[ext]) byFormat[ext] = { count: 0, size: 0 };
    byFormat[ext].count += 1;
    byFormat[ext].size += it.size;

    total.count += 1;
    total.size += it.size;

    latest.push({ rel, category: cat, mtime: it.mtime, size: it.size });
  }

  // 附加编号上限与进度
  for (const [cat, v] of Object.entries(byCategory)) {
    v.cap = cat === 'emoticon' ? capEmo : capMain;
    v.usage = v.cap ? +(v.maxNumber / v.cap * 100).toFixed(1) : 0;
    v.sizeText = humanSize(v.size);
  }

  latest.sort((a, b) => b.mtime - a.mtime);
  latest = latest.slice(0, 8).map((x) => ({ ...x, sizeText: humanSize(x.size) }));

  return {
    total: { ...total, sizeText: humanSize(total.size) },
    byCategory,
    byFormat,
    latest,
    categoryCount: Object.keys(byCategory).length,
    generatedAt: Date.now()
  };
}

/* ---------------------------------------------------------------
 * 缩略图缓存服务
 * --------------------------------------------------------------- */

/** 缓存键：图相对路径 + mtime + 宽度 → sha1，保证图片更新后缓存自动失效 */
function thumbCacheKey(rel, mtime, width) {
  return crypto.createHash('sha1').update(`${rel}|${mtime}|${width}`).digest('hex') + '.webp';
}

/**
 * 生成/读取缩略图，返回 Buffer。
 * 无缓存时实时缩放并落盘；源文件更新（mtime 变化）后自动重算。
 */
async function makeThumbnail(cfg, rel, width = 360) {
  const abs = path.join(cfg._paths.imageRoot, rel.replace(/\//g, path.sep));
  const st = await fsp.stat(abs);
  const cacheFile = path.join(cfg._paths.thumbDir, thumbCacheKey(rel, st.mtimeMs, width));
  try {
    return await fsp.readFile(cacheFile);
  } catch (e) { /* 缓存未命中，走生成流程 */ }

  const buf = await fsp.readFile(abs);
  const thumb = await sharp(buf)
    .rotate() // 缩略图同样按 EXIF 转正
    .resize({ width, withoutEnlargement: true }) // 小图不放大
    .webp({ quality: 75 })
    .toBuffer();

  await fsp.mkdir(cfg._paths.thumbDir, { recursive: true });
  // 缓存写失败不影响返回（例如磁盘只读时仍可正常浏览，仅失去缓存加速）
  try { await fsp.writeFile(cacheFile, thumb); } catch (e) { /* 忽略缓存写失败 */ }
  return thumb;
}

/* ---------------------------------------------------------------
 * 回收站（可恢复的软删除）
 * --------------------------------------------------------------- */

/** 把图库文件移动到回收站（保留批次与路径映射，方便精确恢复） */
async function moveToTrash(cfg, rels) {
  const batchId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const batchDir = path.join(cfg._paths.trashDir, batchId);
  await fsp.mkdir(batchDir, { recursive: true });
  const moved = [];
  const manifest = {}; // flat → 原始相对路径 的精确映射（避免文件名含 __ 时还原出错）
  for (const rel of rels) {
    const abs = path.join(cfg._paths.imageRoot, rel.replace(/\//g, path.sep));
    // 回收站内文件名用"路径压平"（目录分隔符替换为 __），避免重名覆盖
    const flat = rel.replace(/[\\/]/g, '__');
    try {
      await fsp.rename(abs, path.join(batchDir, flat));
      manifest[flat] = rel;
      moved.push({ rel, flat, batchId });
    } catch (e) {
      moved.push({ rel, error: e.message });
    }
  }
  // 每批次写入映射清单，恢复时按清单精确还原
  await fsp.writeFile(path.join(batchDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return { batchId, moved };
}

/** 列出回收站全部批次与文件（从 manifest.json 读取精确路径映射） */
async function listTrash(cfg) {
  const out = [];
  let batches;
  try { batches = await fsp.readdir(cfg._paths.trashDir); }
  catch (e) { return out; } // 回收站目录不存在 = 空回收站
  for (const b of batches) {
    const dir = path.join(cfg._paths.trashDir, b);
    let manifest = {};
    try {
      manifest = JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8'));
    } catch (e) { /* 无清单的旧批次按空处理 */ }
    for (const [flat, rel] of Object.entries(manifest)) {
      const st = await fsp.stat(path.join(dir, flat)).catch(() => null);
      if (!st) continue; // 已恢复的文件不再列出
      out.push({
        batchId: b,
        flat,
        rel,
        size: st.size,
        sizeText: humanSize(st.size),
        trashedAt: st.mtimeMs
      });
    }
  }
  return out.sort((a, b) => b.trashedAt - a.trashedAt);
}

/** 从回收站恢复文件到图库原位置（按 manifest 映射精确还原；原目录不存在时自动重建） */
async function restoreFromTrash(cfg, batchId, flat) {
  const batchDir = path.join(cfg._paths.trashDir, batchId);
  const src = path.join(batchDir, flat);
  let manifest = {};
  try {
    manifest = JSON.parse(await fsp.readFile(path.join(batchDir, 'manifest.json'), 'utf8'));
  } catch (e) { /* 无清单时退回压平规则还原 */ }
  const rel = manifest[flat] || flat.replace(/__/g, '/');
  const dst = path.join(cfg._paths.imageRoot, rel.replace(/\//g, path.sep));
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await fsp.rename(src, dst);
  // 同步更新清单：已恢复的条目移除，防止重复列出
  if (manifest[flat]) {
    delete manifest[flat];
    await fsp.writeFile(path.join(batchDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  }
  return rel;
}

module.exports = { listImages, buildStats, makeThumbnail, categoryOf, humanSize, moveToTrash, listTrash, restoreFromTrash };
