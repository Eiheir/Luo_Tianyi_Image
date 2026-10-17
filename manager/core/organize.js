'use strict';
/**
 * 模块：图库整理（移动分类 / 编号规整 / 表情包主题改名）
 * ---------------------------------------------------------------
 * 三个操作共同的实现骨架：
 *  1. 计算目标目录与目标文件名（移动/改名用"目标目录最大编号+1 起分配"，
 *     规整用"按原顺序压缩为 1..N 连续编号"）
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
 * 目录编号规整：把目标目录内"纯编号文件"按当前顺序（文件名数字升序）压缩重排为
 * 0001..N 连续编号，消除删除留下的空洞。非编号文件（缩略图、说明等）不动。
 *
 * ⚠️ 旧链接失效：已发布的 jsDelivr/Raw 链接按文件名寻址，重排后编号≥起点的文件
 *    URL 全部改变——调用方（前端）必须先向用户确认这一点。
 *
 * @param {string} dirRel 相对图库根的目录（如 wallpapers&illustration/heng、emoticon/辟浪）
 * @returns {{dirRel:string, total:number, renumbered:number, mapping:Array<[string,string]>}}
 */
async function renumberDirectory(cfg, index, dirRel) {
  const dirAbs = path.join(cfg._paths.imageRoot, dirRel.replace(/\//g, path.sep));
  const exts = new Set(cfg.naming.allowedExt.map((e) => e.toLowerCase()));
  const stat = await fsp.stat(dirAbs).catch(() => null);
  if (!stat || !stat.isDirectory()) throw new Error(`目录不存在：${dirRel}`);

  // 只收集"纯数字编号"的图片文件，按编号升序（这是重排前的展示顺序）
  const entries = await fsp.readdir(dirAbs);
  const numbered = entries
    .map((name) => ({ name, m: name.match(/^(\d+)\.(\w+)$/) }))
    .filter(({ m }) => m && exts.has(m[2].toLowerCase()))
    .map(({ name, m }) => ({ name, no: parseInt(m[1], 10), ext: m[2].toLowerCase() }))
    .sort((a, b) => a.no - b.no);

  // 编号位数：表情包目录 3 位，其余 4 位（与命名规则一致）
  const padLen = dirRel.startsWith(`${cfg.classify.emoticonDir}/`)
    ? cfg.naming.emoticonPadding : cfg.naming.padding;

  const mapping = [];
  const phase1 = []; // { from, to } 第一阶段（→临时名）
  const phase2 = []; // { from, to } 第二阶段（临时名→最终名）
  numbered.forEach((it, i) => {
    const finalName = `${String(i + 1).padStart(padLen, '0')}.${it.ext}`;
    if (it.name === finalName) { // 已经是目标名，无需动
      mapping.push([it.name, finalName]);
      return;
    }
    const absOf = (n) => path.join(dirAbs, n);
    phase1.push({ from: absOf(it.name), to: absOf(`${it.name}.renumber-tmp`) });
    phase2.push({ from: absOf(`${it.name}.renumber-tmp`), to: absOf(finalName) });
    mapping.push([it.name, finalName]);
  });

  const done1 = [];
  try {
    for (const m of phase1) { await fsp.rename(m.from, m.to); done1.push(m); }
    for (const m of phase2) await fsp.rename(m.from, m.to);
  } catch (e) {
    // 回滚第一阶段已完成的改名（第二阶段尚未开始，临时名→原名的逆序还原即可）
    for (const m of done1.reverse()) await fsp.rename(m.to, m.from).catch(() => {});
    throw new Error(`编号规整失败，已回滚：${e.message}`);
  }

  // 索引键同步：旧 rel → 新 rel
  const changed = [];
  for (const [oldName, newName] of mapping) {
    if (oldName === newName) continue;
    const oldRel = `${dirRel}/${oldName}`;
    const newRel = `${dirRel}/${newName}`;
    const it = index.items[oldRel];
    if (it) {
      dedup.deleteIndexItem(index, oldRel);
      dedup.setIndexItem(index, newRel, it);
    }
    changed.push([oldRel, newRel]);
  }
  return { dirRel, total: numbered.length, renumbered: changed.length, mapping: changed };
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

module.exports = { moveImages, renumberDirectory, renameTheme };
