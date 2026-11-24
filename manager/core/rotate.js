'use strict';
/**
 * 模块：图片旋转 + 按新方向自动归到正确分类
 * ---------------------------------------------------------------
 * 使用场景：图片物理像素方向是歪的、但缺少 EXIF 方向信息，上传时被按
 * 错误的宽高分到了 heng/shu/avatar。手动旋转后宽高互换，本模块可选把
 * 图片移动到正确分类目录（目标目录内重新分配编号）。
 *
 * 安全边界：
 *  - 源路径必须位于图库根目录内（路由层已校验，此处再兜一层）
 *  - 先写 .rotate.tmp 再 rename，避免半成品污染图库
 *  - 原文件在目标写入成功后才删除；删除失败会回滚新文件，避免留下两份
 *  - 动图（多帧）由 converter.rotateImage 返回 skipped，不落盘
 *
 * 索引同步：旋转会改变字节、尺寸与裁切指纹，成功后重算 md5/dHash/crops
 * 并更新内存索引；调用方负责在批次结束时 saveIndex。
 */

const fsp = require('fs/promises');
const path = require('path');

const converter = require('./converter');
const classify = require('./classify');
const dedup = require('./dedup');
const storage = require('./storage');
const { buildLink } = require('./links');

const WALLPAPER_CATS = new Set(['heng', 'shu', 'avatar']);

async function exists(abs) {
  try { await fsp.stat(abs); return true; } catch (e) { return false; }
}

/**
 * 目标目录里是否已有"同序号、任意允许扩展名"的文件。
 * 例如目标目录有 0001.jpg，旋转结果就不能再叫 0001.png/0001.jpeg，
 * 否则目录里会出现两个 0001。excludeExt 用于同目录换扩展名时排除原文件本身。
 */
async function baseNameTaken(dirAbs, baseName, allowedExt, excludeExt = '') {
  const exts = new Set(allowedExt.map((e) => e.toLowerCase()));
  let names;
  try { names = await fsp.readdir(dirAbs); } catch (e) { return false; }
  const base = String(baseName).toLowerCase();
  const exclude = String(excludeExt || '').toLowerCase();
  return names.some((name) => {
    const ext = path.extname(name).slice(1).toLowerCase();
    if (!exts.has(ext) || (exclude && ext === exclude)) return false;
    return path.basename(name, path.extname(name)).toLowerCase() === base;
  });
}

/** 目录编号位数：表情包 3 位，其余 4 位 */
function paddingFor(cat, cfg) {
  return cat === 'emoticon' ? cfg.naming.emoticonPadding : cfg.naming.padding;
}

/**
 * 旋转一组图片（调用方应持有编号分配锁，避免与上传/转换并发撞号）。
 * @param {object} cfg 运行配置
 * @param {object} index 内存索引（本函数只改内存，调用方负责 saveIndex）
 * @param {string[]} rels 图库相对路径
 * @param {{angle:number, reclassify?:boolean, quality?:number}} opts
 * @returns {Promise<Array<{rel:string, ok:boolean, newRel:string, skipped:boolean,
 *   moved:boolean, w:number, h:number, category:string, notice:string, error:string, url?:string}>>}
 */
async function rotateImages(cfg, index, rels, opts = {}) {
  const angle = Number(opts.angle);
  const reclassify = opts.reclassify !== false;
  const quality = opts.quality;
  const root = path.resolve(cfg._paths.imageRoot);
  const results = [];
  const list = [...new Set(Array.isArray(rels) ? rels : [])];

  for (const rel of list) {
    const result = {
      rel, ok: false, newRel: rel, skipped: false, moved: false,
      w: 0, h: 0, category: '', notice: '', error: ''
    };
    try {
      if (typeof rel !== 'string' || !rel.trim()) throw new Error('非法路径参数');
      const abs = path.resolve(root, rel.replace(/\//g, path.sep));
      if (abs === root || !abs.startsWith(root + path.sep)) throw new Error(`非法路径：${rel}`);

      const input = await fsp.readFile(abs);
      const rotated = await converter.rotateImage(input, { angle, quality, sourceName: rel });
      result.w = rotated.width;
      result.h = rotated.height;
      if (rotated.skipped) {
        result.ok = true;
        result.skipped = true;
        result.notice = rotated.notice || '已跳过';
        results.push(result);
        continue;
      }

      // 只有壁纸三分类参与自动归类；表情包/临时/其他目录保持原目录
      const currentCat = storage.categoryOf(rel, cfg);
      let targetCat = currentCat;
      if (reclassify && WALLPAPER_CATS.has(currentCat) &&
          rotated.width > 0 && rotated.height > 0) {
        const predicted = classify.decideCategory(rotated.width, rotated.height, cfg);
        if (predicted && predicted !== currentCat) targetCat = predicted;
      }

      const currentDir = path.posix.dirname(rel);
      const currentExt = path.posix.extname(rel).slice(1).toLowerCase();
      // .jpeg 与 .jpg 是同一格式：保留原扩展名，避免单纯旋转就把路径改掉
      const outExt = (currentExt === 'jpeg' && rotated.ext === 'jpg') ? 'jpeg' : rotated.ext;
      const moving = targetCat !== currentCat;
      const dirRel = moving ? classify.categoryDir(targetCat, '', cfg) : currentDir;
      const dirAbs = path.join(cfg._paths.imageRoot, dirRel.replace(/\//g, path.sep));
      await fsp.mkdir(dirAbs, { recursive: true });

      // 同目录同格式 = 原地替换；否则优先保留原编号，目标名被占用再续排
      let targetAbs = abs;
      let targetRel = rel;
      const samePath = !moving && outExt === currentExt;
      if (!samePath) {
        const baseName = path.posix.basename(rel, path.posix.extname(rel));
        const candidate = path.join(dirAbs, `${baseName}.${outExt}`);
        // 同目录换扩展名时排除原文件本身；跨目录移动则检查任意扩展名占用
        const taken = await baseNameTaken(
          dirAbs, baseName, cfg.naming.allowedExt, moving ? '' : currentExt
        );
        if (!taken && !(await exists(candidate))) {
          targetAbs = candidate;
        } else {
          const maxNo = await classify.scanMaxNumber(dirAbs, cfg.naming.allowedExt);
          const allocated = await classify.allocatePath(
            dirAbs, maxNo, paddingFor(targetCat, cfg), outExt, cfg
          );
          targetAbs = allocated.absPath;
        }
        targetRel = `${dirRel}/${path.basename(targetAbs)}`;
      }

      // 原子写：先写 .rotate.tmp，再 rename 到目标路径
      const tmp = targetAbs + '.rotate.tmp';
      await fsp.writeFile(tmp, rotated.buffer);
      try {
        await fsp.rename(tmp, targetAbs);
      } catch (e) {
        await fsp.unlink(tmp).catch(() => {});
        throw new Error(`写入旋转结果失败：${e.message}`);
      }

      // 目标路径变化时删除旧文件；删除失败则回滚新文件，避免图库出现两份
      if (targetAbs !== abs) {
        try {
          await fsp.unlink(abs);
        } catch (e) {
          await fsp.unlink(targetAbs).catch(() => {});
          throw new Error(`删除原文件失败：${e.message}`);
        }
      }

      // 旋转后的字节/尺寸都变了，重算全部指纹
      const md5 = dedup.md5Of(rotated.buffer);
      const [dhash, cropData] = await Promise.all([
        dedup.dhashOf(rotated.buffer).catch(() => ''),
        WALLPAPER_CATS.has(targetCat)
          ? dedup.cropHashesOf(rotated.buffer, cfg).catch(() => null)
          : Promise.resolve(null)
      ]);
      const st = await fsp.stat(targetAbs);
      if (targetRel !== rel) dedup.deleteIndexItem(index, rel);
      dedup.setIndexItem(index, targetRel, {
        mtime: st.mtimeMs, size: st.size, w: rotated.width, h: rotated.height, md5, dhash,
        chash: cropData && cropData.chash,
        crops: cropData && cropData.crops,
        cropVersion: cropData && cropData.cropVersion,
        thumb: cropData && cropData.thumb,
        rowProf: cropData && cropData.rowProf,
        colProf: cropData && cropData.colProf
      });

      const notes = [];
      if (rotated.notice) notes.push(rotated.notice);
      if (targetRel !== rel) notes.push(`已归到 ${targetCat} 分类`);
      result.ok = true;
      result.newRel = targetRel;
      result.moved = targetRel !== rel;
      result.category = targetCat;
      result.notice = notes.join('；');
      try { result.url = buildLink(cfg, targetRel, cfg.linkFormat); } catch (e) { result.url = ''; }
      results.push(result);
    } catch (e) {
      result.error = e && e.message ? e.message : String(e);
      results.push(result);
    }
  }
  return results;
}

module.exports = { rotateImages };
