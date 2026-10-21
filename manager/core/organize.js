'use strict';
/**
 * 模块：图库整理（移动分类 / 编号规整 / 表情包主题改名）
 * ---------------------------------------------------------------
 * 三个操作共同的实现骨架：
 *  1. 计算目标目录与目标文件名（移动/改名用"目标目录最大编号+1 起分配"，
 *     规整用"末尾编号回填空位，保持 1..N 连续且尽量少改名"）
 *  2. 逐文件 rename（同盘原子操作）；任何一步失败立即中止并回滚已完成的移动，
 *     保证目录不处于"移了一半"的中间态
 *  3. 返回新旧路径映射，由调用方（server.js）同步更新内存索引并持久化
 *
 * 安全边界：与上传管道一致——只新增/重命名图库内文件，绝不物理删除图片。
 */

const fsp = require('fs/promises');
const path = require('path');

const classify = require('./classify');
const dedup = require('./dedup');
const { buildLink } = require('./links');

/** 单文件移动结果 */
function makeResult(rel) {
  return { rel, ok: false, newRel: '', url: '', error: '' };
}

/**
 * 把一个或多个图库文件移动到目标分类目录（目标内按现有最大编号续排）。
 * @param {object} cfg    运行配置
 * @param {object} index  内存索引（本函数只改内存，调用方负责 saveIndex）
 * @param {string[]} rels 待移动文件的相对路径
 * @param {{category:string, theme?:string}} target 目标分类（emoticon 需 theme）
 * @returns {{results:Array, movedCount:number}}
 */
async function moveImages(cfg, index, rels, target) {
  const category = target && target.category;
  if (!classify.CATEGORIES.includes(category) || category === 'auto') {
    throw new Error(`无效分类：${category}`);
  }
  const relDir = classify.categoryDir(category, target.theme, cfg);
  const dirAbs = path.join(cfg._paths.imageRoot, relDir.replace(/\//g, path.sep));
  const padding = category === 'emoticon' ? cfg.naming.emoticonPadding : cfg.naming.padding;

  const results = [];
  const moved = []; // { fromAbs, toAbs, fromRel, toRel } 已完成的移动，出错时逆序回滚
  let nextNo = await classify.scanMaxNumber(dirAbs, cfg.naming.allowedExt);

  for (const rel of rels) {
    const r = makeResult(rel);
    try {
      const abs = path.join(cfg._paths.imageRoot, rel.replace(/\//g, path.sep));
      const st = await fsp.stat(abs); // 源不存在（路径错/已移动）则该文件失败
      const ext = path.extname(rel).slice(1).toLowerCase();

      nextNo += 1;
      let fileName = `${String(nextNo).padStart(padding, '0')}.${ext}`;
      let toAbs = path.join(dirAbs, fileName);
      // 编号被外部文件占用时跳号（与上传管道的占位探测同思路）
      while (await fsp.stat(toAbs).then(() => true, () => false)) {
        nextNo += 1;
        fileName = `${String(nextNo).padStart(padding, '0')}.${ext}`;
        toAbs = path.join(dirAbs, fileName);
      }
      await fsp.mkdir(dirAbs, { recursive: true });
      await fsp.rename(abs, toAbs);

      const toRel = `${relDir}/${fileName}`;
      moved.push({ fromAbs: abs, toAbs, fromRel: rel, toRel });
      // 索引键从旧路径换到新路径，尺寸/哈希等元数据随文件迁移
      const it = index.items[rel];
      if (it) {
        dedup.deleteIndexItem(index, rel);
        dedup.setIndexItem(index, toRel, { ...it, mtime: st.mtimeMs });
      }
      r.ok = true;
      r.newRel = toRel;
      r.assignedName = fileName;
      r.category = category;
      r.url = buildLink(cfg, toRel, cfg.linkFormat);
    } catch (e) {
      r.error = e.message;
    }
    results.push(r);
  }

  // 任一文件移动失败 → 回滚全部已完成的移动，保持目录与索引的原始状态
  if (results.some((r) => !r.ok) && moved.length) {
    for (const m of moved.reverse()) {
      await fsp.rename(m.toAbs, m.fromAbs).catch(() => {});
      const it = index.items[m.toRel];
      if (it) {
        dedup.deleteIndexItem(index, m.toRel);
        dedup.setIndexItem(index, m.fromRel, it);
      }
    }
    for (const r of results) { r.ok = false; r.newRel = ''; r.url = ''; r.error = r.error || '批次中有文件移动失败，已全部回滚'; }
  }
  return { results, movedCount: results.filter((r) => r.ok).length };
}

/**
 * 目录编号规整（最小代价）：只消除编号空洞，不把所有文件重排一遍。
 *
 * 目标编号为 1..N。已经在 1..N 区间内、且编号未被重复占用的文件保持原名不动；
 * 把区间外的文件按编号从大到小，依次填入最小的空位：
 *   {1,3,5,9} → 空位 {2,4} → 9→2、5→4（只改 2 个，而不是 3→2、5→3、9→4）
 *
 * 这样既保证 1..N 连续，又让改名数量严格等于空位数量（最小理论值），
 * 已发布的旧链接中只有被移动文件的链接会失效。
 * 非编号文件（说明、缩略图等）不动；目标文件名被占用时中止且不做任何修改。
 *
 * @param {string} dirRel 相对图库根的目录（如 wallpapers&illustration/heng、emoticon/辟浪）
 * @returns {{dirRel:string, total:number, renumbered:number, filled:number,
 *   alreadyInPlace:number, mapping:Array<[string,string]>}}
 */
async function renumberDirectory(cfg, index, dirRel) {
  const dirAbs = path.join(cfg._paths.imageRoot, dirRel.replace(/\//g, path.sep));
  const exts = new Set(cfg.naming.allowedExt.map((e) => e.toLowerCase()));
  const stat = await fsp.stat(dirAbs).catch(() => null);
  if (!stat || !stat.isDirectory()) throw new Error(`目录不存在：${dirRel}`);

  // 只收集"纯数字编号"的图片文件（真正的文件，不含同名目录），按编号升序
  const entries = await fsp.readdir(dirAbs, { withFileTypes: true });
  const numbered = entries
    .filter((ent) => ent.isFile())
    .map((ent) => ({ name: ent.name, m: ent.name.match(/^(\d+)\.(\w+)$/) }))
    .filter(({ m }) => m && exts.has(m[2].toLowerCase()))
    .map(({ name, m }) => ({ name, no: parseInt(m[1], 10), ext: m[2].toLowerCase() }))
    .sort((a, b) => a.no - b.no || a.name.localeCompare(b.name));

  const total = numbered.length;
  if (total === 0) {
    return { dirRel, total: 0, renumbered: 0, filled: 0, alreadyInPlace: 0, mapping: [] };
  }

  // 编号位数：表情包目录 3 位，其余 4 位（与命名规则一致）
  const padLen = dirRel.startsWith(`${cfg.classify.emoticonDir}/`)
    ? cfg.naming.emoticonPadding : cfg.naming.padding;
  const pad = (n) => String(n).padStart(padLen, '0');

  // 1..N 内、编号唯一占用的文件保持不动；同号多文件只留第一个，其余视为待移动
  const occupied = new Set();
  const inPlace = [];
  const surplus = [];
  for (const it of numbered) {
    if (it.no >= 1 && it.no <= total && !occupied.has(it.no)) {
      occupied.add(it.no);
      inPlace.push(it);
    } else {
      surplus.push(it);
    }
  }

  const gaps = [];
  for (let n = 1; n <= total; n++) if (!occupied.has(n)) gaps.push(n);

  // 末尾优先：最大编号填最小空位（{1,3,5,9} → 9→2、5→4）
  const surplusDesc = surplus.slice().sort((a, b) => b.no - a.no || b.name.localeCompare(a.name));
  const moves = [];
  for (let i = 0; i < gaps.length; i++) {
    const src = surplusDesc[i];
    if (!src) break; // 理论上 surplus 数量恒等于空位数量
    moves.push({ src, targetName: `${pad(gaps[i])}.${src.ext}` });
  }

  // 目标名冲突预检：空位可能被目录/非编号文件占用，绝不覆盖
  for (const m of moves) {
    const targetAbs = path.join(dirAbs, m.targetName);
    if (await fsp.stat(targetAbs).then(() => true, () => false)) {
      throw new Error(`目标文件名已被占用：${m.targetName}，未做任何修改`);
    }
  }

  // 目标都是空位，直接改名即可；失败时逆序还原已改的文件
  const done = [];
  try {
    for (const m of moves) {
      const fromAbs = path.join(dirAbs, m.src.name);
      const toAbs = path.join(dirAbs, m.targetName);
      await fsp.rename(fromAbs, toAbs);
      done.push({ fromName: m.src.name, toName: m.targetName });
    }
  } catch (e) {
    for (const m of done.reverse()) {
      await fsp.rename(path.join(dirAbs, m.toName), path.join(dirAbs, m.fromName)).catch(() => {});
    }
    throw new Error(`编号规整失败，已回滚：${e.message}`);
  }

  // 索引键同步：只有被移动的文件需要换键
  const mapping = [];
  for (const m of done) {
    const oldRel = `${dirRel}/${m.fromName}`;
    const newRel = `${dirRel}/${m.toName}`;
    const it = index.items[oldRel];
    if (it) {
      dedup.deleteIndexItem(index, oldRel);
      dedup.setIndexItem(index, newRel, it);
    }
    mapping.push([oldRel, newRel]);
  }

  return {
    dirRel,
    total,
    renumbered: mapping.length,
    filled: moves.length,
    alreadyInPlace: inPlace.length,
    mapping
  };
}

/**
 * 手动调整目录内图片顺序：按 orderedNames 的先后重新分配编号。
 *
 * 目标编号沿用目录当前已有的编号集合（升序），不主动填补空洞：
 *   原编号 0001/0003/0005，新顺序 C/A/B → C→0001、A→0003、B→0005。
 * 位置未变的文件保持原名（不强制补零/改大小写），只重命名真正移动的文件。
 * 改名采用两阶段临时名，支持任意交换/循环；任一步失败都会全部回滚。
 *
 * @param {string} dirRel 相对图库根的目录
 * @param {string[]} orderedNames 目录内全部编号图片文件名的新顺序（必须完整、无重复）
 * @returns {{dirRel:string, total:number, renumbered:number, unchanged:number,
 *   mapping:Array<[string,string]>}}
 */
async function reorderDirectory(cfg, index, dirRel, orderedNames) {
  if (!Array.isArray(orderedNames) || orderedNames.length === 0) {
    throw new Error('排序列表为空');
  }
  const dirAbs = path.join(cfg._paths.imageRoot, dirRel.replace(/\//g, path.sep));
  const exts = new Set(cfg.naming.allowedExt.map((e) => e.toLowerCase()));
  const stat = await fsp.stat(dirAbs).catch(() => null);
  if (!stat || !stat.isDirectory()) throw new Error(`目录不存在：${dirRel}`);

  // 目录内全部“纯数字编号”的图片文件（不含同名目录/非编号文件）
  const entries = await fsp.readdir(dirAbs, { withFileTypes: true });
  const numbered = new Map();
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const m = ent.name.match(/^(\d+)\.(\w+)$/);
    if (!m || !exts.has(m[2].toLowerCase())) continue;
    numbered.set(ent.name, { name: ent.name, no: parseInt(m[1], 10), ext: m[2].toLowerCase() });
  }
  if (numbered.size === 0) throw new Error('目录内没有可排序的编号图片');

  // 排序列表必须恰好覆盖目录内全部编号图片，且无重复/未知文件
  const seen = new Set();
  for (const name of orderedNames) {
    if (typeof name !== 'string' || !numbered.has(name) || seen.has(name)) {
      throw new Error(`排序列表包含无效或重复文件：${name}`);
    }
    seen.add(name);
  }
  if (seen.size !== numbered.size) {
    throw new Error('排序列表必须包含目录内全部编号图片');
  }

  // 目标编号 = 当前已有编号升序集合；重复编号无法形成唯一顺序，先让用户整理
  const numbers = [...numbered.values()].map((it) => it.no).sort((a, b) => a - b);
  if (new Set(numbers).size !== numbers.length) {
    throw new Error('目录内存在重复编号，请先使用“填补空位”整理编号');
  }

  const padLen = dirRel.startsWith(`${cfg.classify.emoticonDir}/`)
    ? cfg.naming.emoticonPadding : cfg.naming.padding;
  const pad = (n) => String(n).padStart(padLen, '0');

  const moves = [];
  let unchanged = 0;
  orderedNames.forEach((name, i) => {
    const src = numbered.get(name);
    const targetNo = numbers[i];
    if (targetNo === src.no) { // 位置没变：保持原名，哪怕位数/大小写不标准
      unchanged += 1;
      return;
    }
    moves.push({ src, targetNo, targetName: `${pad(targetNo)}.${src.ext}` });
  });

  if (moves.length === 0) {
    return { dirRel, total: numbered.size, renumbered: 0, unchanged, mapping: [] };
  }

  // 目标名可能与另一个“将要移动”的文件当前名相同（交换/循环），这些不算冲突；
  // 若被其余文件/目录占用，则中止且不做任何修改。
  const movingNames = new Set(moves.map((m) => m.src.name));
  for (const m of moves) {
    const targetAbs = path.join(dirAbs, m.targetName);
    const exists = await fsp.stat(targetAbs).then(() => true, () => false);
    if (exists && !movingNames.has(m.targetName)) {
      throw new Error(`目标文件名已被占用：${m.targetName}，未做任何修改`);
    }
  }

  // 两阶段改名：先全部改成唯一临时名，再落到目标名，避免交换时互相覆盖
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  for (let i = 0; i < moves.length; i++) {
    let tmpName = `${moves[i].src.name}.order-${stamp}-${i}.tmp`;
    while (await fsp.stat(path.join(dirAbs, tmpName)).then(() => true, () => false)) {
      tmpName = `${moves[i].src.name}.order-${stamp}-${i}-${Math.random().toString(36).slice(2, 6)}.tmp`;
    }
    moves[i].tmpName = tmpName;
  }

  const done1 = [];
  try {
    for (const m of moves) {
      const fromAbs = path.join(dirAbs, m.src.name);
      const tmpAbs = path.join(dirAbs, m.tmpName);
      await fsp.rename(fromAbs, tmpAbs);
      done1.push({ ...m, fromAbs, tmpAbs });
    }
  } catch (e) {
    for (const d of done1.reverse()) await fsp.rename(d.tmpAbs, d.fromAbs).catch(() => {});
    throw new Error(`保存顺序失败，已回滚：${e.message}`);
  }

  const done2 = [];
  try {
    for (const d of done1) {
      const toAbs = path.join(dirAbs, d.targetName);
      await fsp.rename(d.tmpAbs, toAbs);
      done2.push({ ...d, toAbs });
    }
  } catch (e) {
    for (const d of done2.reverse()) await fsp.rename(d.toAbs, d.tmpAbs).catch(() => {});
    for (const d of done1.reverse()) await fsp.rename(d.tmpAbs, d.fromAbs).catch(() => {});
    throw new Error(`保存顺序失败，已回滚：${e.message}`);
  }

  // 索引键随文件迁移（位置未变的文件不动）。
  // 交换/循环时旧键可能同时是另一个文件的新键，必须"先取出并删除全部旧键，再写新键"。
  const oldKeys = done2.map((d) => `${dirRel}/${d.src.name}`);
  const oldItems = oldKeys.map((k) => index.items[k]);
  for (const k of oldKeys) dedup.deleteIndexItem(index, k);
  const mapping = [];
  done2.forEach((d, i) => {
    const newRel = `${dirRel}/${d.targetName}`;
    if (oldItems[i]) dedup.setIndexItem(index, newRel, oldItems[i]);
    mapping.push([oldKeys[i], newRel]);
  });

  return { dirRel, total: numbered.size, renumbered: moves.length, unchanged, mapping };
}

/**
 * 表情包主题目录改名（emoticon/<旧名> → emoticon/<新名>，目录内文件不变）。
 * @returns {{oldRel:string, newRel:string, count:number, movedNames:string[]}}
 */
async function renameTheme(cfg, index, oldTheme, newTheme) {
  const safeOld = classify.sanitizeTheme(oldTheme);
  const safeNew = classify.sanitizeTheme(newTheme);
  if (!safeOld || safeNew === '默认') throw new Error('主题名无效');
  if (safeOld === safeNew) throw new Error('新旧主题名相同');
  const oldDir = path.join(cfg._paths.imageRoot, cfg.classify.emoticonDir, safeOld);
  const newDir = path.join(cfg._paths.imageRoot, cfg.classify.emoticonDir, safeNew);
  if (await fsp.stat(newDir).then(() => true, () => false)) {
    throw new Error(`目标主题目录已存在：${safeNew}`);
  }
  const names = (await fsp.readdir(oldDir).catch(() => null));
  if (!names) throw new Error(`主题目录不存在：${safeOld}`);

  await fsp.rename(oldDir, newDir);

  // 索引键批量换前缀
  const movedNames = [];
  for (const name of names) {
    const oldRel = `${cfg.classify.emoticonDir}/${safeOld}/${name}`;
    const newRel = `${cfg.classify.emoticonDir}/${safeNew}/${name}`;
    const it = index.items[oldRel];
    if (it) {
      dedup.deleteIndexItem(index, oldRel);
      dedup.setIndexItem(index, newRel, it);
    }
    movedNames.push(name);
  }
  return { oldRel: `${cfg.classify.emoticonDir}/${safeOld}`, newRel: `${cfg.classify.emoticonDir}/${safeNew}`, count: movedNames.length, movedNames };
}

/**
 * 去重清理后把保留下来的图片序号压缩到组内最小序号。
 *
 * 只处理“与保留图同目录”的组内图片：不同目录的编号彼此独立，跨目录比大小没有意义。
 * 例如 heng 目录相似组 0003/0007/0011，保留 0007，其余移入回收站后，
 * 0007 会改名为 0003（最小序号）；若 0003 已被同目录非组内文件占用，则不改名并说明原因。
 *
 * @param {object} cfg
 * @param {object} index 内存索引（本函数只改内存，调用方负责 saveIndex）
 * @param {string[]} groupRels 相似/重复组的全部相对路径
 * @param {string} keepRel 保留图片的相对路径
 * @returns {{oldRel?:string, keptRel:string, renamed:boolean, reason:string}}
 */
async function compactKeptSequence(cfg, index, groupRels, keepRel) {
  const keepDir = path.posix.dirname(keepRel);
  const sameDir = groupRels.filter((rel) => path.posix.dirname(rel) === keepDir);
  if (sameDir.length < 2) {
    return { keptRel: keepRel, renamed: false, reason: 'no-same-dir-group' };
  }

  const baseNameOf = (rel) => path.posix.basename(rel, path.posix.extname(rel));
  const numberOf = (rel) => {
    const base = baseNameOf(rel);
    return /^\d+$/.test(base) ? parseInt(base, 10) : null;
  };

  const keepNo = numberOf(keepRel);
  if (keepNo === null) {
    return { keptRel: keepRel, renamed: false, reason: 'keep-not-numbered' };
  }

  const numbers = sameDir.map(numberOf).filter((n) => Number.isFinite(n));
  if (numbers.length === 0) {
    return { keptRel: keepRel, renamed: false, reason: 'group-not-numbered' };
  }

  const minNo = Math.min(...numbers);
  if (keepNo <= minNo) {
    return { keptRel: keepRel, renamed: false, reason: 'already-min' };
  }

  const padding = keepDir.startsWith(`${cfg.classify.emoticonDir}/`)
    ? cfg.naming.emoticonPadding
    : cfg.naming.padding;
  const ext = path.posix.extname(keepRel).slice(1).toLowerCase();
  const targetName = `${String(minNo).padStart(padding, '0')}.${ext}`;
  const targetRel = `${keepDir}/${targetName}`;
  const keepAbs = path.join(cfg._paths.imageRoot, keepRel.replace(/\//g, path.sep));
  const targetAbs = path.join(cfg._paths.imageRoot, targetRel.replace(/\//g, path.sep));

  // 目标序号可能被同目录、不同扩展名的非组内文件占用；不覆盖，直接放弃改名
  if (await fsp.stat(targetAbs).then(() => true, () => false)) {
    return { keptRel: keepRel, renamed: false, reason: 'target-occupied' };
  }

  await fsp.rename(keepAbs, targetAbs);
  const st = await fsp.stat(targetAbs);
  const item = index.items[keepRel];
  if (item) {
    dedup.deleteIndexItem(index, keepRel);
    dedup.setIndexItem(index, targetRel, { ...item, mtime: st.mtimeMs });
  }

  return { oldRel: keepRel, keptRel: targetRel, renamed: true, reason: '' };
}

module.exports = { moveImages, renumberDirectory, reorderDirectory, renameTheme, compactKeptSequence };
