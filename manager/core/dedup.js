'use strict';
/**
 * 模块：重复图片智能检测 + 图库索引缓存
 * ---------------------------------------------------------------
 * 两级检测策略：
 *  1. MD5 字节级哈希  ：完全相同的文件（同一张图重复上传）——判定"完全重复"
 *  2. dHash 感知哈希  ：将图片缩放为 9×8 灰度格，比较每行相邻像素明暗梯度，
 *     得到 64 位指纹；两张图指纹的"汉明距离"≤ 阈值（默认 5）判定"疑似相似"
 *
 * 索引缓存（.cache/index.json）：
 *  - 记录每个图库文件的 mtime/size/宽高/md5/dhash
 *  - 增量策略：mtime 与 size 均未变化的文件直接复用缓存哈希，只对新文件/变更文件
 *    重新计算，全量扫描时性能开销极小
 *  - 索引文件仅存于 manager/.cache/（模块私有目录，已列入 .gitignore）
 */

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const sharp = require('sharp');

/** 图库内认可的图片扩展名（小写） */
function extSetOf(cfg) {
  return new Set(cfg.naming.allowedExt.map((e) => e.toLowerCase()));
}

/** 计算字节级 MD5 */
function md5Of(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

/**
 * 计算 dHash 感知指纹：
 *  1. 忽略 EXIF 方向差异（rotate），缩放到 9×8 灰度（fit:fill 拉伸，保留整体明暗结构）
 *  2. 每行 9 个像素产生 8 个相邻差值，8 行共 64 位
 *  3. 输出 16 位十六进制字符串
 */
async function dhashOf(buffer) {
  const { data } = await sharp(buffer)
    .rotate()
    .resize(9, 8, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let hex = '';
  for (let y = 0; y < 8; y++) {
    let bits = 0;
    for (let x = 0; x < 8; x++) {
      bits = (bits << 1) | (data[y * 9 + x] < data[y * 9 + x + 1] ? 1 : 0);
    }
    hex += bits.toString(16).padStart(2, '0');
  }
  return hex;
}

/** 汉明距离：两个 64 位指纹（16 hex）逐位比较不同位的数量 */
function hammingDistance(a, b) {
  if (!a || !b || a.length !== b.length) return 64; // 缺失指纹按"最不相似"处理
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { diff += x & 1; x >>= 1; }
  }
  return diff;
}

/* ---------------------------------------------------------------
 * 索引缓存管理
 * --------------------------------------------------------------- */

/** 读取索引缓存；文件损坏/缺失时返回空索引（自动降级，不报错中断） */
async function loadIndex(cfg) {
  try {
    const raw = await fsp.readFile(cfg._paths.indexFile, 'utf8');
    const obj = JSON.parse(raw);
    if (obj && obj.items && typeof obj.items === 'object') return obj;
  } catch (e) { /* ENOENT 或 JSON 损坏均按空索引处理 */ }
  return { version: 1, items: {} };
}

/** 写回索引缓存（原子写：先写临时文件再改名，防中途崩溃损坏索引） */
async function saveIndex(cfg, index) {
  await fsp.mkdir(path.dirname(cfg._paths.indexFile), { recursive: true });
  const tmp = cfg._paths.indexFile + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(index), 'utf8');
  await fsp.rename(tmp, cfg._paths.indexFile);
}

/**
 * 递归扫描图库目录，收集全部图片文件的相对路径。
 * 跳过隐藏文件与 .tmp 暂存文件。
 */
async function walkImages(cfg, dirAbs = cfg._paths.imageRoot, relBase = '') {
  const exts = extSetOf(cfg);
  const out = [];
  let entries;
  try {
    entries = await fsp.readdir(dirAbs, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return out; // 图库目录尚未创建
    throw e;
  }
  for (const ent of entries) {
    const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      out.push(...await walkImages(cfg, path.join(dirAbs, ent.name), rel));
    } else if (ent.isFile()) {
      const ext = path.extname(ent.name).slice(1).toLowerCase();
      if (!exts.has(ext)) continue;
      if (ent.name.startsWith('.')) continue;
      out.push(rel);
    }
  }
  return out;
}

/**
 * 刷新单个文件的索引条目（惰性计算：md5/dhash 仅在缺失时计算）
 * @param {object|null} cached 索引中的旧条目（可为 null）
 */
async function refreshItem(cfg, rel, cached, { needHash = true } = {}) {
  const abs = path.join(cfg._paths.imageRoot, rel.replace(/\//g, path.sep));
  const st = await fsp.stat(abs);
  // mtime+size 均未变且已有哈希 → 直接复用缓存
  if (cached && cached.mtime === st.mtimeMs && cached.size === st.size &&
      (!needHash || (cached.md5 && cached.dhash))) {
    return { rel, ...cached };
  }
  const buf = await fsp.readFile(abs);
  let w = cached && cached.w, h = cached && cached.h, md5, dhash;
  try {
    const meta = await sharp(buf).metadata();
    w = meta.width; h = meta.height;
  } catch (e) { /* 个别损坏图片读不出尺寸，记录为 0，不中断整体扫描 */ w = 0; h = 0; }
  if (needHash) {
    md5 = md5Of(buf);
    try { dhash = await dhashOf(buf); } catch (e) { dhash = ''; }
  } else {
    md5 = cached && cached.md5 || '';
    dhash = cached && cached.dhash || '';
  }
  const item = {
    mtime: st.mtimeMs, size: st.size, w: w || 0, h: h || 0, md5, dhash
  };
  return { rel, ...item };
}

/**
 * 判断索引条目是否与缓存条目等价。
 * 逐字段比较：旧实现用 JSON.stringify 比较整串，每个文件都要把对象序列化成字符串，
 * 全库扫描时开销随文件数线性放大；这里改为 O(字段数) 的直接比较。
 */
function sameItem(a, b) {
  if (!a) return false;
  return a.mtime === b.mtime && a.size === b.size &&
    a.w === b.w && a.h === b.h && a.md5 === b.md5 && a.dhash === b.dhash;
}

/**
 * 全量扫描图库并增量更新索引
 * @param {object} opts.deep 是否补算全部缺失哈希（查重扫描前调用）
 * @returns {{items:object, changed:boolean}}
 */
async function scanLibrary(cfg, { deep = false } = {}) {
  const index = await loadIndex(cfg);
  const rels = await walkImages(cfg);
  const nextItems = {};
  let changed = false;

  for (const rel of rels) {
    const cached = index.items[rel] || null;
    const item = await refreshItem(cfg, rel, cached, { needHash: deep || !cached });
    nextItems[rel] = { mtime: item.mtime, size: item.size, w: item.w, h: item.h, md5: item.md5, dhash: item.dhash };
    if (!sameItem(cached, nextItems[rel])) changed = true;
  }

  // 清理索引中已不存在的文件（图库文件被外部删除/改名后自动失效）
  for (const rel of Object.keys(index.items)) {
    if (!nextItems[rel]) { delete index.items[rel]; changed = true; }
  }
  index.items = nextItems;
  if (changed) await saveIndex(cfg, index);
  return { items: index.items, changed };
}

/**
 * 仅更新内存索引条目（不落盘）。
 * 批量操作（上传/转换/删除）应在批次结束时统一调用一次 saveIndex 持久化：旧实现
 * 每处理一张就写一次磁盘，多图批次会产生大量重复 IO。改为内存更新 + 批末一次落盘。
 */
function setIndexItem(index, rel, { mtime, size, w, h, md5, dhash }) {
  index.items[rel] = { mtime, size, w, h, md5, dhash };
}

/** 仅从内存索引移除条目（不落盘）：由调用方在批次结束时统一持久化 */
function deleteIndexItem(index, rel) {
  if (index.items[rel]) delete index.items[rel];
}

/* ---------------------------------------------------------------
 * 查重判定
 * --------------------------------------------------------------- */

/* ---------- 查重手动忽略 ----------
 * "疑似相似"但用户确认不想再看到归组提示的图片。
 * 语义：按【图片】忽略（muted）——被忽略的图片彻底退出 dHash 相似归组，
 * 不再与任何图片组队（v1 曾按"两两对"忽略，但聚类会把被忽略的图继续与
 * 其他图组队，用户视角等于"忽略了还在提示"，故升级）。
 * MD5 字节级完全重复是客观事实，不受忽略影响。
 * 存储：.cache/dedup-ignore.json，version 2 = { muted: [rel...] }；
 * 读取时兼容 v1 { pairs: ["a||b"...] }——自动把旧对的两端迁移为 muted。
 */

const SEP = '||';
const IGNORE_VERSION = 2;

/** 读取被忽略图片集合（文件缺失/损坏按空集合处理，绝不因此中断查重） */
async function loadIgnoreSet(cfg) {
  try {
    const raw = await fsp.readFile(cfg._paths.ignoreFile, 'utf8');
    const obj = JSON.parse(raw);
    const muted = new Set();
    if (Array.isArray(obj.muted)) {
      for (const m of obj.muted) if (typeof m === 'string' && m) muted.add(m);
    }
    // v1 兼容：旧"两两对"迁移为按图忽略
    if (Array.isArray(obj.pairs)) {
      for (const p of obj.pairs) {
        if (typeof p !== 'string' || !p.includes(SEP)) continue;
        const [a, b] = p.split(SEP);
        muted.add(a); muted.add(b);
      }
    }
    return muted;
  } catch (e) { /* ENOENT 或损坏按空处理 */ }
  return new Set();
}

/** 原子写回被忽略图片集合（排序后存储，diff 友好） */
async function saveIgnoreSet(cfg, muted) {
  await fsp.mkdir(path.dirname(cfg._paths.ignoreFile), { recursive: true });
  const tmp = cfg._paths.ignoreFile + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify({ version: IGNORE_VERSION, muted: [...muted].sort() }, null, 2), 'utf8');
  await fsp.rename(tmp, cfg._paths.ignoreFile);
}

/** 新增忽略图片；索引中不存在的路径（已删除/移动）自动跳过
 * @returns {{added:number, skipped:number, total:number}} */
async function addIgnorePairs(cfg, index, paths) {
  const muted = await loadIgnoreSet(cfg);
  let added = 0, skipped = 0;
  for (const rel of Array.isArray(paths) ? paths : []) {
    if (!index.items[rel]) { skipped++; continue; }
    if (!muted.has(rel)) { muted.add(rel); added++; }
  }
  if (added > 0) await saveIgnoreSet(cfg, muted);
  return { added, skipped, total: muted.size };
}

/** 取消忽略（按图片路径），该图恢复参与相似归组
 * @returns {{removed:number, total:number}} */
async function removeIgnorePairs(cfg, keys) {
  const muted = await loadIgnoreSet(cfg);
  let removed = 0;
  for (const k of Array.isArray(keys) ? keys : []) {
    if (muted.delete(k)) removed++;
  }
  if (removed > 0) await saveIgnoreSet(cfg, muted);
  return { removed, total: muted.size };
}

/** 图库文件路径变更（移动/改名/删除）后同步清理：剔除索引中已不存在的忽略项 */
async function pruneIgnorePairs(cfg, index) {
  const muted = await loadIgnoreSet(cfg);
  if (!muted.size) return { pruned: 0 };
  let pruned = 0;
  for (const rel of [...muted]) {
    if (!index.items[rel]) { muted.delete(rel); pruned++; }
  }
  if (pruned > 0) await saveIgnoreSet(cfg, muted);
  return { pruned };
}

/**
 * 上传前查重：将新文件的 md5/dhash 与索引内全部文件比对
 * @returns {{exact: Array<string>, similar: Array<{rel, distance}>}}
 *   exact   —— MD5 完全相同的库内文件（相对路径）
 *   similar —— 汉明距离 ≤ 阈值的库内文件（升序，最相似在前）
 */
function compareAgainstLibrary(index, md5, dhash, threshold) {
  const exact = [];
  const similar = [];
  for (const [rel, item] of Object.entries(index.items)) {
    if (md5 && item.md5 === md5) { exact.push(rel); continue; }
    if (dhash && item.dhash) {
      const d = hammingDistance(dhash, item.dhash);
      if (d <= threshold) similar.push({ rel, distance: d });
    }
  }
  similar.sort((a, b) => a.distance - b.distance);
  return { exact, similar: similar.slice(0, 8) }; // 相似列表最多提示 8 条，避免刷屏
}

/**
 * 全库查重：返回"重复组"列表
 *  - exactGroups：MD5 相同的组
 *  - similarGroups：dHash 相似的组（组内任两两距离 ≤ 阈值，采用简单贪心聚类）；
 *    手动忽略（muted）的图片彻底退出相似归组
 */
function findDuplicateGroups(index, threshold, muted = new Set()) {
  const items = index.items;
  const rels = Object.keys(items);

  // —— MD5 精确分组（不受忽略影响：字节级相同是客观事实） ——
  const byMd5 = new Map();
  for (const rel of rels) {
    const m = items[rel].md5;
    if (!m) continue;
    if (!byMd5.has(m)) byMd5.set(m, []);
    byMd5.get(m).push(rel);
  }
  const exactGroups = [...byMd5.values()].filter((g) => g.length > 1);

  // —— dHash 相似贪心聚类：已归组的文件不再参与后续分组，避免组爆炸；
  //     被忽略（muted）的图片不参与相似归组 ——
  const used = new Set(exactGroups.flat());
  const similarGroups = [];
  const order = rels.filter((r) => !used.has(r) && items[r].dhash && !muted.has(r));
  for (let i = 0; i < order.length; i++) {
    if (used.has(order[i])) continue;
    const group = [order[i]];
    used.add(order[i]);
    for (let j = i + 1; j < order.length; j++) {
      if (used.has(order[j])) continue;
      const d = hammingDistance(items[order[i]].dhash, items[order[j]].dhash);
      if (d <= threshold) { group.push(order[j]); used.add(order[j]); }
    }
    if (group.length > 1) similarGroups.push(group);
  }
  return { exactGroups, similarGroups };
}

module.exports = {
  md5Of, dhashOf, hammingDistance,
  loadIndex, saveIndex, scanLibrary, setIndexItem, deleteIndexItem, walkImages,
  compareAgainstLibrary, findDuplicateGroups, extSetOf,
  loadIgnoreSet, saveIgnoreSet, addIgnorePairs, removeIgnorePairs, pruneIgnorePairs
};
