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
const classify = require('./classify');

/** 展示/筛选统一格式别名：jpeg 归并为 jpg（现有图库两者并存，分开统计会误导） */
function normalizeFormat(ext) {
  const e = String(ext || '').toLowerCase();
  return e === 'jpeg' ? 'jpg' : e;
}

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
 * @param {{category?:string, format?:string, q?:string, minSize?:*, minWidth?:*}} filters
 *   category: 全部分类值或 '其他'；format: jpg/png/...；q: 文件名关键词；
 *   minSize: 最小文件字节数；minWidth: 最小像素宽度（大图排查用）
 */
function listImages(index, cfg, filters = {}) {
  const minSize = Number(filters.minSize) || 0;
  const minWidth = Number(filters.minWidth) || 0;
  const rows = [];
  for (const [rel, it] of Object.entries(index.items)) {
    const cat = categoryOf(rel, cfg);
    if (filters.category && filters.category !== 'all' && cat !== filters.category) continue;
    const ext = path.extname(rel).slice(1).toLowerCase();
    const fmt = normalizeFormat(ext);
    if (filters.format && filters.format !== 'all' && fmt !== normalizeFormat(filters.format)) continue;
    if (filters.q) {
      const kw = String(filters.q).toLowerCase();
      const base = path.basename(rel).toLowerCase();
      if (!base.includes(kw) && !rel.toLowerCase().includes(kw)) continue;
    }
    if (minSize && !(it.size >= minSize)) continue;
    if (minWidth && !(it.w >= minWidth)) continue;
    rows.push({
      rel,
      category: cat,
      format: fmt,
      name: path.basename(rel),
      w: it.w, h: it.h,
      size: it.size,
      mtime: it.mtime
      // 说明：md5/dhash 仅用于服务端查重比对，前端列表用不到，故不下发以缩小响应体
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

  // 近 12 个月新增趋势（按文件修改时间聚合；在服务端算，避免前端依赖图片列表是否已加载）
  const now = new Date();
  const monthly = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthly.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}`,
      count: 0,
      size: 0
    });
  }
  const monthMap = new Map(monthly.map((m) => [m.key, m]));

  for (const [rel, it] of Object.entries(index.items)) {
    const cat = categoryOf(rel, cfg);
    const ext = normalizeFormat(path.extname(rel).slice(1).toLowerCase());

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

    const md = new Date(it.mtime);
    const mk = `${md.getFullYear()}-${String(md.getMonth() + 1).padStart(2, '0')}`;
    const bucket = monthMap.get(mk);
    if (bucket) { bucket.count += 1; bucket.size += it.size; }
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
    monthly: monthly.map((m) => ({ ...m, sizeText: humanSize(m.size) })),
    latest,
    categoryCount: Object.keys(byCategory).length,
    generatedAt: Date.now()
  };
}

/* ---------------------------------------------------------------
 * 缩略图缓存服务
 * ---------------------------------------------------------------
 * 缓存键 = sha1(源路径|mtime|宽度[|a])：源图更新后键变化，旧缓存自动失效；
 * GIF 缩略图带 |a 动画标志，与静态缓存键隔离。
 */

/**
 * 生成/读取缩略图，返回 Buffer。
 * 无缓存时实时缩放并落盘；源文件更新（mtime 变化）后自动重算。
 */
async function makeThumbnail(cfg, rel, width = 360) {
  const abs = path.join(cfg._paths.imageRoot, rel.replace(/\//g, path.sep));
  const st = await fsp.stat(abs);
  // GIF 使用带动画标志的缓存键：与旧版静态缩略图缓存隔离，确保升级后重建为动画版
  const animated = /\.gif$/i.test(rel);
  return makeThumbFromAbs(cfg, abs, width, {
    cacheKey: `${rel}|${st.mtimeMs}|${width}${animated ? '|a' : ''}`
  });
}

/**
 * 回收站条目缩略图（恢复前先"看一眼"再决定删/留）。
 * 缓存键带 trash- 前缀与图库缩略图隔离；条目被恢复/删除后文件消失，缓存自然成孤儿，
 * 由既有的 cleanThumbCache 按期回收。
 */
async function makeTrashThumbnail(cfg, batchId, flat, width = 264) {
  const abs = path.join(cfg._paths.trashDir, batchId, flat);
  // 与恢复接口相同的边界防御：杜绝 flat 携带路径分隔符的越界读取
  if (abs !== path.join(cfg._paths.trashDir, batchId, path.basename(flat))) {
    throw new Error('回收站文件标识非法');
  }
  const st = await fsp.stat(abs);
  const animated = /\.gif$/i.test(flat);
  return makeThumbFromAbs(cfg, abs, width, {
    cacheKey: `trash-${batchId}|${flat}|${st.mtimeMs}|${width}${animated ? '|a' : ''}`
  });
}

/** 缩略图公共管线：从绝对路径读源图 → sharp 缩放 → webp → 落盘缓存（键由调用方给出） */
async function makeThumbFromAbs(cfg, abs, width, { cacheKey }) {
  const cacheFile = path.join(cfg._paths.thumbDir,
    crypto.createHash('sha1').update(cacheKey).digest('hex') + '.webp');
  try {
    return await fsp.readFile(cacheFile);
  } catch (e) { /* 缓存未命中，走生成流程 */ }

  const buf = await fsp.readFile(abs);
  // GIF 属于动画格式：开启 animated 管线逐帧缩放，缩略图仍是动画（WebP 动图），
  // 浏览器 <img> 可直接自动播放；sharp 默认只取第一帧，会导致 GIF 预览静止
  const animated = /\.gif$/i.test(abs);
  const thumb = await sharp(buf, { animated })
    .rotate() // 缩略图同样按 EXIF 转正（GIF 通常无 EXIF，此处为空操作）
    .resize({ width, withoutEnlargement: true }) // 小图不放大（逐帧缩放）
    .webp({ quality: 75 })
    .toBuffer();

  await fsp.mkdir(cfg._paths.thumbDir, { recursive: true });
  // 缓存写失败不影响返回（例如磁盘只读时仍可正常浏览，仅失去缓存加速）
  try { await fsp.writeFile(cacheFile, thumb); } catch (e) { /* 忽略缓存写失败 */ }
  return thumb;
}

/* ---------------------------------------------------------------
 * 缩略图缓存清理
 * ---------------------------------------------------------------
 * 缓存键含 mtime：源图一旦更新，旧缩略图即成孤儿；宽度参数每换一档也会
 * 生成一套新文件——这些残留永远不会被复用，只增不减。
 * 策略：服务启动时异步清理一次，删除"修改时间早于保留期"的缓存文件。
 * 缓存键含 mtime 保证仍在保留期内被访问过的条目会被重新生成，不会误伤热点。
 */

/** 缩略图缓存保留期（毫秒）：默认 30 天 */
const THUMB_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** 清理超期缩略图缓存；失败仅记录，不影响服务启动 */
async function cleanThumbCache(cfg, retentionMs = THUMB_RETENTION_MS) {
  let entries;
  try { entries = await fsp.readdir(cfg._paths.thumbDir); }
  catch (e) { return 0; } // 缓存目录尚未创建 = 无需清理
  const deadline = Date.now() - retentionMs;
  let removed = 0;
  for (const name of entries) {
    const file = path.join(cfg._paths.thumbDir, name);
    try {
      const st = await fsp.stat(file);
      if (st.isFile() && st.mtimeMs < deadline) {
        await fsp.unlink(file);
        removed += 1;
      }
    } catch (e) { /* 单个文件失败不影响其余 */ }
  }
  return removed;
}

/* ---------------------------------------------------------------
 * 回收站（可恢复的软删除）
 * --------------------------------------------------------------- */

/** 把图库文件移动到回收站（保留批次与路径映射，方便精确恢复） */
async function moveToTrash(cfg, rels) {
  // 批次 ID 加随机后缀：时间戳只精确到秒，同秒内两次删除会复用同一目录并覆盖 manifest，
  // 导致第一批的"压平名→原路径"精确映射丢失（只能退化按 __ 规则还原）
  const batchId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) +
    '-' + crypto.randomBytes(2).toString('hex');
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

/**
 * 从回收站恢复文件到图库原位置（按 manifest 映射精确还原；原目录不存在时自动重建）。
 * 防覆盖：目标编号已被同目录其他文件占用时（删除旧 0009 后新图复用了编号，再恢复旧 0009
 * 会把新图无提示覆盖掉），自动改用下一个可用编号，并在返回值中说明改名情况。
 * @returns {{rel:string, renamed:boolean}}
 */
async function restoreFromTrash(cfg, batchId, flat) {
  const batchDir = path.join(cfg._paths.trashDir, batchId);
  const src = path.join(batchDir, flat);
  // 防御：源文件必须落在该批次目录内，杜绝 flat 携带路径分隔符导致的越界读取
  if (src !== path.join(batchDir, path.basename(flat))) throw new Error('回收站文件标识非法');
  let manifest = {};
  try {
    manifest = JSON.parse(await fsp.readFile(path.join(batchDir, 'manifest.json'), 'utf8'));
  } catch (e) { /* 无清单时退回压平规则还原 */ }
  const rel = manifest[flat] || flat.replace(/__/g, '/');
  const dst = path.resolve(cfg._paths.imageRoot, rel.replace(/\//g, path.sep));
  // 防御：恢复目标必须落在图库根目录内，杜绝清单被篡改导致的越界写入
  const root = cfg._paths.imageRoot;
  if (dst === root || !dst.startsWith(root + path.sep)) throw new Error('恢复目标路径非法');
  await fsp.mkdir(path.dirname(dst), { recursive: true });

  let finalDst = dst;
  let renamed = false;
  // Windows 的 rename 会静默覆盖已存在文件；编号被占时改用下一个空闲编号
  if (await fsp.stat(dst).then(() => true, () => false)) {
    const dirAbs = path.dirname(dst);
    const ext = path.extname(rel).slice(1).toLowerCase();
    const padding = rel.startsWith(`${cfg.classify.emoticonDir}/`)
      ? cfg.naming.emoticonPadding : cfg.naming.padding;
    const baseName = path.basename(rel, path.extname(rel));
    const startNo = parseInt(baseName, 10);
    if (Number.isFinite(startNo) && /^\d+$/.test(baseName)) {
      // 纯编号文件名：从原编号+1 起探测下一个空闲位
      const maxNo = await classify.scanMaxNumber(dirAbs, cfg.naming.allowedExt);
      const allocated = await classify.allocatePath(dirAbs, Math.max(startNo, maxNo), padding, ext, cfg);
      finalDst = allocated.absPath;
      renamed = true;
    } else {
      throw new Error('目标位置已被同名文件占用，无法恢复（请先处理同名文件）');
    }
  }
  await fsp.rename(src, finalDst);
  // 同步更新清单：已恢复的条目移除，防止重复列出
  if (manifest[flat]) {
    delete manifest[flat];
    await fsp.writeFile(path.join(batchDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  }
  const finalRel = path.relative(cfg._paths.imageRoot, finalDst).replace(/\\/g, '/');
  return { rel: finalRel, renamed };
}

/**
 * 按批次整体恢复：遍历该批次 manifest 逐条调用单条恢复。
 * 单条失败（如目标被同名非编号文件占用）不阻断其余条目，逐条返回结果。
 * @returns {{batchId:string, results:Array<{rel?:string, renamed?:boolean, flat:string, error?:string}>}}
 */
async function restoreBatch(cfg, batchId) {
  const batchDir = path.join(cfg._paths.trashDir, batchId);
  let manifest = {};
  try {
    manifest = JSON.parse(await fsp.readFile(path.join(batchDir, 'manifest.json'), 'utf8'));
  } catch (e) { /* 无清单 = 空批次 */ }
  const results = [];
  for (const flat of Object.keys(manifest)) {
    try {
      const r = await restoreFromTrash(cfg, batchId, flat);
      results.push({ flat, ...r });
    } catch (e) {
      results.push({ flat, error: e.message });
    }
  }
  return { batchId, results };
}

/**
 * 彻底删除：物理移除回收站条目（或整批）。这是唯一的不可逆删除入口，
 * 图库内的文件必须先经 moveToTrash 进入回收站，才可被 purge。
 * @param {string} batchId
 * @param {string[]=} flats 要删除的条目；缺省 = 整批清空并删除批次目录
 * @returns {{removed:number}}
 */
async function purgeTrash(cfg, batchId, flats) {
  // 批次 ID 白名单校验（与恢复接口一致），杜绝拼接越界路径
  if (!/^[\w-]+$/.test(batchId)) throw new Error('非法批次标识');
  const batchDir = path.join(cfg._paths.trashDir, batchId);
  if (batchDir !== path.join(cfg._paths.trashDir, path.basename(batchId))) {
    throw new Error('非法批次标识');
  }

  // 未指定条目 = 整批清空
  if (!Array.isArray(flats) || flats.length === 0) {
    await fsp.rm(batchDir, { recursive: true, force: true });
    return { removed: -1 }; // 整批模式，调用方无需精确计数
  }

  let manifest = {};
  try {
    manifest = JSON.parse(await fsp.readFile(path.join(batchDir, 'manifest.json'), 'utf8'));
  } catch (e) { /* 无清单按空处理 */ }
  let removed = 0;
  for (const flat of flats) {
    // 与恢复接口相同的边界防御
    const file = path.join(batchDir, flat);
    if (file !== path.join(batchDir, path.basename(flat))) continue;
    await fsp.unlink(file).catch(() => {});
    delete manifest[flat];
    removed += 1;
  }
  // 清单已空 = 批次作废，连目录一起删；否则回写清单
  if (Object.keys(manifest).length === 0) {
    await fsp.rm(batchDir, { recursive: true, force: true });
  } else {
    await fsp.writeFile(path.join(batchDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  }
  return { removed };
}

/**
 * 回收站过期清理：删除"入站时间早于保留期"的批次目录。
 * 入站时间 = 批次目录名前缀（ISO 时间戳，moveToTrash 生成），无文件系统依赖。
 * 服务启动时调用一次，防止 .trash 无限膨胀。
 * @returns {{batches:number, freed:number}} 清理的批次数与释放字节数（尽力统计）
 */
async function cleanExpiredTrash(cfg, retentionMs = TRASH_RETENTION_MS) {
  let batches;
  try { batches = await fsp.readdir(cfg._paths.trashDir); }
  catch (e) { return { batches: 0, freed: 0 }; }
  const deadline = Date.now() - retentionMs;
  let n = 0, freed = 0;
  for (const b of batches) {
    // 批次目录名 = ISO 时间戳（前 19 字符，冒号已被替换为 -）+ 随机后缀。
    // 显式按位解析回标准 ISO 形式再 Date.parse（2026-10-17T20-45-30 → 20:45:30），
    // 解析失败的时间戳按"未过期"跳过，绝不误删。
    const m = b.slice(0, 19).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})$/);
    const ts = m ? Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`) : NaN;
    if (!Number.isFinite(ts) || ts >= deadline) continue;
    const dir = path.join(cfg._paths.trashDir, b);
    freed += await dirSize(dir).catch(() => 0);
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    n += 1;
  }
  return { batches: n, freed };
}

/** 回收站保留期（毫秒）：默认 30 天 */
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** 递归统计目录字节数（过期清理的报告用，统计失败不影响删除） */
async function dirSize(dir) {
  let total = 0;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch (e) { return 0; }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) total += await dirSize(p);
    else total += (await fsp.stat(p).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

module.exports = { listImages, buildStats, makeThumbnail, makeTrashThumbnail, cleanThumbCache, categoryOf, humanSize, moveToTrash, listTrash, restoreFromTrash, restoreBatch, purgeTrash, cleanExpiredTrash, normalizeFormat, TRASH_RETENTION_MS };
