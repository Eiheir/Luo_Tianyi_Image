'use strict';
/**
 * 模块：上传管道（批量上传的单文件处理流水线）
 * ---------------------------------------------------------------
 * 单文件流水线：读取 → 有效性校验 → 指纹(MD5+dHash) → 查重 → 分类 →
 *              格式转换 → 编号分配 → 原子落盘 → 更新索引
 *
 * 异常隔离原则：任何一步失败，仅该文件标记为 failed（附中文原因），
 * 同批其余文件继续处理；整批接口永不因单文件异常而整体失败。
 *
 * 落盘安全性：先写 .tmp 暂存，再 rename 到目标位置（同盘 rename 为原子操作），
 * 不会出现"半个文件"污染图库目录。
 */

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');

const classify = require('./classify');
const converter = require('./converter');
const dedup = require('./dedup');
const { buildLink } = require('./links');

/** 单文件处理结果 */
function makeResult(originalName) {
  return { originalName, status: 'pending', rel: '', assignedName: '', category: '', ext: '', w: 0, h: 0, size: 0, url: '', similar: [], notice: '', error: '' };
}

/**
 * 处理一个上传的临时文件
 * @param {object} cfg      运行配置
 * @param {object} index    当前索引（内存态，处理后由调用方决定持久化时机）
 * @param {string} tmpPath  multer 落盘的暂存文件绝对路径
 * @param {string} originalName 原始文件名（仅用于展示）
 * @param {object} opts     批级选项 { category, theme, convert, quality, onDuplicate, stripMeta, allowAnimatedLoss }
 */
async function processOne(cfg, index, tmpPath, originalName, opts) {
  const result = makeResult(originalName);
  try {
    // ---------- 1. 读取 ----------
    const input = await fsp.readFile(tmpPath);
    if (!input || input.length === 0) throw new Error('文件内容为空');

    // ---------- 2. 格式转换 / EXIF 方向转正（先行） ----------
    // 设计说明：转换必须在查重之前——指纹应基于"最终归档字节"。
    // 这样同一张原图转成 WebP 后视为新文件可正常入库（用户意图优先），
    // 而保留原格式的重复上传仍会被准确识别为完全重复。
    const processed = await converter.processImage(input, {
      target: opts.convert || 'keep',
      quality: opts.quality ?? cfg.upload.quality,
      stripMeta: opts.stripMeta !== false,
      allowAnimatedLoss: !!opts.allowAnimatedLoss
    });
    result.ext = processed.ext;
    result.w = processed.width;
    result.h = processed.height;
    result.converted = processed.converted;
    if (processed.notice) result.notice = processed.notice;

    // ---------- 3. 指纹计算（基于最终字节：MD5 精确 + dHash 感知） ----------
    const md5 = dedup.md5Of(processed.buffer);
    let dhash = '';
    try { dhash = await dedup.dhashOf(processed.buffer); } catch (e) { dhash = ''; /* 指纹失败不阻断上传 */ }

    // ---------- 4. 查重比对 ----------
    const threshold = Number(cfg.dedup.hammingThreshold) || 5;
    const dup = dedup.compareAgainstLibrary(index, md5, dhash, threshold);
    result.similar = dup.similar;
    if (dup.exact.length > 0) {
      const policy = opts.onDuplicate || cfg.dedup.onExactDuplicate;
      if (policy === 'skip') {
        // 完全重复且策略为跳过：不落盘，返回已有文件的链接
        result.status = 'duplicate';
        result.rel = dup.exact[0];
        result.assignedName = path.basename(result.rel);
        result.category = require('./storage').categoryOf(result.rel, cfg);
        result.url = buildLink(cfg, result.rel, cfg.linkFormat);
        result.error = `与库内 ${result.assignedName} 完全相同，已按策略跳过`;
        return result;
      }
      result.notice = result.notice ? `${result.notice}；` : '';
      result.notice += `注意：与库内 ${path.basename(dup.exact[0])} 字节级完全相同，仍按你的选择保留`;
    } else if (dup.similar.length > 0) {
      const simText = `疑似相似：${dup.similar.map((s) => `${path.basename(s.rel)}(距离${s.distance})`).join('、')}`;
      result.notice = result.notice ? `${result.notice}；${simText}` : simText;
    }

    // ---------- 5. 分类决策 ----------
    let category = opts.category;
    if (!category || category === 'auto') {
      // 自动分类：动图与静图统一按宽高比判定（长边/短边≤1.2 → avatar）
      category = classify.decideCategory(processed.width, processed.height, cfg);
    }
    if (!classify.CATEGORIES.includes(category)) throw new Error(`无效分类：${category}`);
    result.category = category;

    // ---------- 6. 编号分配（目录扫描 + 占位探测双保险） ----------
    const relDir = classify.categoryDir(category, opts.theme, cfg);
    const dirAbs = path.join(cfg._paths.imageRoot, relDir.replace(/\//g, path.sep));
    const padding = category === 'emoticon' ? cfg.naming.emoticonPadding : cfg.naming.padding;
    const maxNo = await classify.scanMaxNumber(dirAbs, cfg.naming.allowedExt);
    const allocated = await classify.allocatePath(dirAbs, maxNo, padding, result.ext, cfg);

    // ---------- 7. 原子落盘（.tmp → rename） ----------
    const tmpTarget = allocated.absPath + '.tmp';
    await fsp.writeFile(tmpTarget, processed.buffer);
    try {
      await fsp.rename(tmpTarget, allocated.absPath);
    } catch (e) {
      // rename 失败时清理半成品，向上抛错交由外层标记 failed
      await fsp.unlink(tmpTarget).catch(() => {});
      throw new Error(`写入图库失败：${e.message}`);
    }

    // ---------- 8. 更新索引（内存 + 持久化） ----------
    const rel = `${relDir}/${allocated.fileName}`;
    const st = await fsp.stat(allocated.absPath);
    result.rel = rel;
    result.assignedName = allocated.fileName;
    result.size = st.size;
    result.url = buildLink(cfg, rel, cfg.linkFormat);
    result.status = 'ok';
    await dedup.indexSingle(cfg, index, rel, {
      mtime: st.mtimeMs, size: st.size, w: processed.width, h: processed.height, md5, dhash
    });
    return result;
  } catch (err) {
    // 单文件异常隔离：记录原因，整批继续
    result.status = 'failed';
    result.error = err && err.message ? err.message : String(err);
    return result;
  }
}

/**
 * 批量处理入口：串行处理每个文件（串行保证编号分配无竞态）
 * @param {Array<{tmpPath, originalName}>} files
 */
async function processBatch(cfg, index, files, opts) {
  const results = [];
  for (const f of files) {
    const r = await processOne(cfg, index, f.tmpPath, f.originalName, opts);
    results.push(r);
    // 每个文件处理完立即清理 multer 暂存文件（无论成败）
    await fsp.unlink(f.tmpPath).catch(() => {});
  }
  const summary = {
    total: results.length,
    ok: results.filter((r) => r.status === 'ok').length,
    duplicate: results.filter((r) => r.status === 'duplicate').length,
    failed: results.filter((r) => r.status === 'failed').length
  };
  return { results, summary };
}

module.exports = { processOne, processBatch, makeResult };
