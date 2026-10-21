'use strict';
/**
 * 模块：重复图片智能检测 + 图库索引缓存
 * ---------------------------------------------------------------
 * 两级检测策略：
 *  1. MD5 字节级哈希  ：完全相同的文件（同一张图重复上传）——判定"完全重复"
 *  2. dHash 感知哈希  ：将图片缩放为 9×8 灰度格，比较每行相邻像素明暗梯度，
 *     得到 64 位指纹；两张图指纹的"汉明距离"≤ 阈值（默认 5）判定"疑似相似"
 *
 * 归组范围：壁纸三分类（横图/方图/竖图）跨目录统一比对；表情包只在各自
 * 主题目录（emoticon/<主题>/）内比对，不跨主题、不跨分类。同一张作品的不同
 * 方向版本若指纹相近会进入同一组。
 *
 * 局部裁切识别：跨方向（竖图是横图的一部分截取）和同方向（横图被二次裁切后
 * 宽高比明显变化，如 4800×2620 → 1852×1080）都会在整图 dHash 不命中时，
 * 用多位置裁切指纹 / 缩略图滑窗 NCC 兜底。
 *
 * 保留规则（清理相似/重复组时的默认决策）：
 *  - 跨方向局部裁切组：智能识别哪张是被截取的图，保留完整原图、去除截取版本，
 *    不再按方向强制保留（完整图可能是横图，也可能是竖图/方图）
 *  - 其他组：横图 > 方图 > 竖图；同方向内保留像素面积最大的一张，
 *    面积相同再比较文件体积。可通过 dedup.keepPriority 覆盖顺序。
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

/** 4 位十六进制值 → 二进制 1 的个数（查表比逐位循环快，跨方向裁切比对次数多） */
const POPCOUNT4 = new Uint8Array(16);
for (let i = 0; i < 16; i++) POPCOUNT4[i] = (i & 1) + ((i >> 1) & 1) + ((i >> 2) & 1) + ((i >> 3) & 1);

/** 汉明距离：两个 64 位指纹（16 hex）逐位比较不同位的数量 */
function hammingDistance(a, b) {
  if (!a || !b || a.length !== b.length) return 64; // 缺失指纹按"最不相似"处理
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff += POPCOUNT4[parseInt(a[i], 16) ^ parseInt(b[i], 16)];
  }
  return diff;
}

/* ---------------------------------------------------------------
 * 跨方向局部裁切指纹
 * ---------------------------------------------------------------
 * 问题：竖图可能是横图的一部分截取（或反过来）。整图 dHash 会把两张图各自
 * 拉伸到 9×8，截取导致的内容范围不同，距离通常很大，无法归组。
 *
 * 方案：为每张壁纸额外保存一组"多位置、多宽高比"的裁切指纹：
 *  - 横图保存竖裁切 + 方裁切（横图内部可能包含一张竖图）
 *  - 竖图保存横裁切 + 方裁切（竖图内部可能包含一张横图）
 *  - 方图保存横裁切 + 竖裁切
 * 每个宽高比在 0%/25%/50%/75%/100% 五个位置各取一次，覆盖常见的居中/偏左/偏右截取。
 *
 * 实现：先把图片转正并缩到最长边 512px 的灰度图，建立积分图；任意矩形区域的
 * 平均值 O(1) 可得，因此 9×8 指纹的计算非常快，且整图与裁切指纹使用完全相同的
 * 采样方式，跨方向比较不会因重采样差异产生假距离。
 *
 * 比较：固定位置裁切指纹用于跨方向快速命中；滑窗 NCC 跨方向始终启用，
 * 同方向则在宽高比明显不同时启用（见 sameOrientationCropCandidate）。
 */

const CROP_VERSION = 2; // v2 = 增加缩略图 + 行列投影（滑窗 NCC）
const CROP_MAX_DIM = 512; // 裁切指纹的工作分辨率：9×8 输出足够，512px 兼顾细长裁切
const CROP_POSITIONS = [0, 0.25, 0.5, 0.75, 1];
const CROP_PORTRAIT_AR = [0.5625, 0.6667, 0.75]; // 9:16 / 2:3 / 3:4
const CROP_LANDSCAPE_AR = [1.3333, 1.5, 1.7778]; // 4:3 / 3:2 / 16:9
const CROP_AR_BY_ORIENTATION = {
  heng: [...CROP_PORTRAIT_AR, 1],
  shu: [...CROP_LANDSCAPE_AR, 1],
  avatar: [...CROP_PORTRAIT_AR, ...CROP_LANDSCAPE_AR]
};
/** 整图宽高比与裁切目标宽高比的最大相对偏差（30% 足以覆盖 0.63~0.75 等常见竖图比例） */
const CROP_AR_TOLERANCE = 0.3;

/* ---- 滑窗 NCC 参数 ----
 * 固定位置的裁切指纹只能命中"恰好对齐"的截图；真实截图位置任意。
 * 这里额外保存一张最长边 72px 的灰度缩略图 + 32 段行列投影：
 *  - 行列投影做廉价预筛（不相关的图直接挡掉）
 *  - 预筛通过后，把两张缩略图归一化到 48px，沿被裁切的方向逐像素滑动求 NCC
 * 实测本图库：两对真实局部裁切 NCC = 0.995 / 0.958，最高误报 0.82。
 */
const CROP_THUMB_MAX = 72;
const CROP_PROFILE_SAMPLES = 32;
/* 预筛阈值：实测同方向 11.2 万对中 0.9 只放行 1.5%，真命中全部在其中；
 * 放宽到 0.8 会把候选放大 4 倍、全库扫描多花约 3 秒，却不会多出任何命中。 */
const CROP_PROFILE_MIN = 0.9;
/** 同方向也做局部裁切复核的最小宽高比相对差异：低于该值构图窗口基本一致，交给整图 dHash */
const CROP_SAME_AR_DIFF_MIN = 0.02;
const CROP_NCC_SIZE = 48;
const CROP_NCC_MIN = 0.9;
/* 灰区缩放复核：同一作品如果被缩放后再裁切，固定 48px 归一化的 NCC 会掉到 0.82~0.90。
 * 对灰区候选再做 ±6% 的小范围缩放搜索即可把真命中拉回 0.92+，而无关图仍 <0.81。
 * 只对灰区候选执行，全库通常只有十几对，开销可忽略。 */
const CROP_NCC_REFINE_MIN = 0.75;
const CROP_REFINE_SCALES = [0.94, 0.97, 1.03, 1.06];

/** 索引条目的宽高比；尺寸缺失返回 0 */
function arOf(item) {
  const w = Number(item && item.w) || 0;
  const h = Number(item && item.h) || 0;
  return w > 0 && h > 0 ? w / h : 0;
}

/**
 * 同方向是否值得做局部裁切复核。
 * 宽高比差异小说明两张图的构图窗口基本一致，整图 dHash 足够；差异明显
 * （如 1.832 vs 1.715）往往是二次裁切/重新构图，dHash 会因内容窗口不同而失真。
 */
function sameOrientationCropCandidate(a, b) {
  const arA = arOf(a);
  const arB = arOf(b);
  if (!arA || !arB) return false;
  return Math.abs(arA - arB) / Math.max(arA, arB) >= CROP_SAME_AR_DIFF_MIN;
}

/** 壁纸目录正则（按配置缓存，避免逐文件重复构造；支持自定义 wallpaperDir） */
let wallpaperReCache = { base: '', re: null };
function wallpaperDirRe(cfg) {
  const base = (cfg && cfg.classify && cfg.classify.wallpaperDir) || 'wallpapers&illustration';
  if (wallpaperReCache.base !== base) {
    const escaped = String(base).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    wallpaperReCache = { base, re: new RegExp(`^${escaped}/(heng|avatar|shu)/`) };
  }
  return wallpaperReCache.re;
}

/** 裁切指纹只对壁纸三分类有意义：表情包/临时目录不参与跨方向裁切匹配 */
function isWallpaperRel(rel, cfg) {
  return wallpaperDirRe(cfg).test(String(rel || ''));
}

/**
 * 表情包主题目录：
 *  - 非表情包路径返回 null
 *  - emoticon/<主题>/... 返回主题名（同一主题下的子目录视为同一作用域）
 *  - 直接位于 emoticon/ 根目录返回 ''
 */
function emoticonThemeOf(rel, cfg) {
  const base = String((cfg && cfg.classify && cfg.classify.emoticonDir) || 'emoticon')
    .replace(/\\/g, '/').replace(/\/+$/, '');
  const p = String(rel || '').replace(/\\/g, '/');
  if (!p.startsWith(`${base}/`)) return null;
  const rest = p.slice(base.length + 1);
  const slash = rest.indexOf('/');
  return slash < 0 ? '' : rest.slice(0, slash);
}

/**
 * 表情包只在各自主题目录内比对，不跨文件夹：
 *  - 双方都不是表情包 → 允许（壁纸仍按横/方/竖跨目录比对）
 *  - 任一方是表情包 → 必须双方同属一个主题目录
 */
function emoticonPairAllowed(aRel, bRel, cfg) {
  const ta = emoticonThemeOf(aRel, cfg);
  const tb = emoticonThemeOf(bRel, cfg);
  if (ta === null && tb === null) return true;
  return ta !== null && ta === tb;
}

/** 灰度图积分图：任意矩形像素和可 O(1) 求出 */
function buildIntegral(data, width, height) {
  const I = new Uint32Array((width + 1) * (height + 1));
  for (let y = 1; y <= height; y++) {
    let row = 0;
    for (let x = 1; x <= width; x++) {
      row += data[(y - 1) * width + (x - 1)];
      I[y * (width + 1) + x] = I[(y - 1) * (width + 1) + x] + row;
    }
  }
  return I;
}

/** 矩形区域平均灰度（积分图 O(1)） */
function rectAverage(I, width, x0, y0, x1, y1) {
  const sum = I[y1 * (width + 1) + x1] - I[y0 * (width + 1) + x1] -
    I[y1 * (width + 1) + x0] + I[y0 * (width + 1) + x0];
  const area = (x1 - x0) * (y1 - y0);
  return area > 0 ? sum / area : 0;
}

/** 对积分图中的任意矩形计算 9×8 dHash（与整图使用同一套采样） */
function hashRect(I, width, x0, y0, x1, y1) {
  const vals = new Float64Array(72);
  for (let ty = 0; ty < 8; ty++) {
    const ya = Math.floor(y0 + (y1 - y0) * ty / 8);
    const yb = Math.max(ya + 1, Math.floor(y0 + (y1 - y0) * (ty + 1) / 8));
    for (let tx = 0; tx < 9; tx++) {
      const xa = Math.floor(x0 + (x1 - x0) * tx / 9);
      const xb = Math.max(xa + 1, Math.floor(x0 + (x1 - x0) * (tx + 1) / 9));
      vals[ty * 9 + tx] = rectAverage(I, width, xa, ya, xb, yb);
    }
  }
  let hex = '';
  for (let ty = 0; ty < 8; ty++) {
    let bits = 0;
    for (let tx = 0; tx < 8; tx++) {
      bits = (bits << 1) | (vals[ty * 9 + tx] < vals[ty * 9 + tx + 1] ? 1 : 0);
    }
    hex += bits.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * 32 段行列投影：每行/每列的平均灰度，再归一化为零均值、单位方差。
 * 用于 NCC 前的廉价预筛——裁剪后的图沿"未裁切轴"的投影应与原图高度相关。
 */
function profilesOf(data, width, height) {
  const n = CROP_PROFILE_SAMPLES;
  const row = new Float64Array(n);
  const col = new Float64Array(n);
  const rowCount = new Uint32Array(n);
  const colCount = new Uint32Array(n);
  for (let y = 0; y < height; y++) {
    const ry = Math.min(n - 1, Math.floor(y * n / height));
    for (let x = 0; x < width; x++) {
      const v = data[y * width + x];
      const cx = Math.min(n - 1, Math.floor(x * n / width));
      row[ry] += v; rowCount[ry]++;
      col[cx] += v; colCount[cx]++;
    }
  }
  const normalize = (arr, counts) => {
    const vals = new Array(n);
    for (let i = 0; i < n; i++) vals[i] = counts[i] ? arr[i] / counts[i] : 0;
    const mean = vals.reduce((s, v) => s + v, 0) / n;
    let variance = 0;
    for (const v of vals) variance += (v - mean) * (v - mean);
    const sd = Math.sqrt(variance / n) || 1;
    return vals.map((v) => Math.round(((v - mean) / sd) * 10000) / 10000);
  };
  return { row: normalize(row, rowCount), col: normalize(col, colCount) };
}

/**
 * 计算一张图片的裁切识别数据：
 *  - chash / crops：整图 + 多位置裁切指纹（固定位置，快速命中）
 *  - thumb / rowProf / colProf：最长边 72px 灰度缩略图与行列投影（任意位置滑窗 NCC）
 * 只解码一次：先按 EXIF 转正并缩到最长边 512px，再建积分图 / 生成缩略图。
 *
 * @returns {Promise<{chash:string, crops:Array<[number,...string]>, cropVersion:number,
 *   thumb:{w:number,h:number,data:string}, rowProf:number[], colProf:number[]}>}
 *   crops 形如 [[0.5625, 'hash1', 'hash2', ...], ...]，同一宽高比下重复的位置指纹已去重
 */
async function cropHashesOf(buffer, cfg) {
  const { data, info } = await sharp(buffer)
    .rotate()
    .resize({ width: CROP_MAX_DIM, height: CROP_MAX_DIM, fit: 'inside', withoutEnlargement: true })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const width = info.width;
  const height = info.height;
  if (!width || !height) throw new Error('无法读取图片尺寸');
  if (info.channels !== 1) throw new Error('灰度转换未得到单通道数据');

  const integral = buildIntegral(data, width, height);
  const chash = hashRect(integral, width, 0, 0, width, height);
  const orientation = orientationOf(width, height, cfg);
  const ars = CROP_AR_BY_ORIENTATION[orientation] || [...CROP_PORTRAIT_AR, ...CROP_LANDSCAPE_AR, 1];

  const crops = [];
  for (const ar of ars) {
    let cw, ch;
    if (ar < width / height) { ch = height; cw = Math.round(height * ar); }
    else { cw = width; ch = Math.round(width / ar); }
    cw = Math.max(1, Math.min(width, cw));
    ch = Math.max(1, Math.min(height, ch));

    const hashes = [];
    for (const pos of CROP_POSITIONS) {
      const x = Math.round((width - cw) * pos);
      const y = Math.round((height - ch) * pos);
      hashes.push(hashRect(integral, width, x, y, x + cw, y + ch));
    }
    crops.push([ar, ...new Set(hashes)]); // 宽高比与图片一致时五个位置相同，去重
  }

  // 缩略图：从 512px 灰度图再缩到最长边 72px，用于任意位置的滑窗 NCC
  const { data: thumbData, info: thumbInfo } = await sharp(data, {
    raw: { width, height, channels: 1 }
  })
    .resize({ width: CROP_THUMB_MAX, height: CROP_THUMB_MAX, fit: 'inside', withoutEnlargement: true })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { row, col } = profilesOf(thumbData, thumbInfo.width, thumbInfo.height);

  return {
    chash,
    crops,
    cropVersion: CROP_VERSION,
    thumb: {
      w: thumbInfo.width,
      h: thumbInfo.height,
      data: thumbData.toString('base64')
    },
    rowProf: row,
    colProf: col
  };
}

/** 在裁切指纹组中找与目标宽高比匹配、汉明距离最小的一条 */
function bestCropMatch(chash, crops, targetAR) {
  let best = 64;
  if (!chash || !Array.isArray(crops) || !targetAR) return best;
  for (const group of crops) {
    const ar = Number(group[0]);
    if (!Number.isFinite(ar) || ar <= 0) continue;
    if (Math.abs(ar - targetAR) / targetAR > CROP_AR_TOLERANCE) continue;
    for (let i = 1; i < group.length; i++) {
      const d = hammingDistance(chash, group[i]);
      if (d < best) best = d;
    }
  }
  return best;
}

/**
 * 跨方向裁切相似度：仅当两张图方向不同时启用（固定位置裁切指纹只为跨方向生成）。
 * 双向比较——A 的整图可能对应 B 的某个部位，反之亦然。
 * 同方向的二次裁切没有对应宽高比的裁切指纹，由 nccCropMatch 兜底。
 * @returns {number|null} 命中返回最小距离，未命中返回 null
 */
function cropDistanceOf(a, b, cropThreshold, cfg) {
  if (!a || !b || !a.chash || !b.chash || !Array.isArray(a.crops) || !Array.isArray(b.crops)) return null;
  // 仅壁纸三分类参与裁切比对（旧索引若给表情包残留过裁切指纹，这里直接拒绝）
  if ((a.rel && !isWallpaperRel(a.rel, cfg)) || (b.rel && !isWallpaperRel(b.rel, cfg))) return null;
  const orientA = orientationOfItem(a, cfg);
  const orientB = orientationOfItem(b, cfg);
  if (!orientA || !orientB || orientA === orientB) return null; // 同方向交给整图 dHash
  const arA = arOf(a);
  const arB = arOf(b);
  if (!arA || !arB) return null;

  // A 整图 vs B 中与 A 同宽高比的裁切；B 整图 vs A 中与 B 同宽高比的裁切
  const d = Math.min(
    bestCropMatch(a.chash, b.crops, arA),
    bestCropMatch(b.chash, a.crops, arB)
  );
  return d <= cropThreshold ? d : null;
}

/* ---------------------------------------------------------------
 * 任意位置裁切：投影预筛 + 缩略图滑窗 NCC
 * ---------------------------------------------------------------
 * 固定位置的裁切指纹对"刚好对齐"的截图有效，但真实截取位置是任意的。
 * 这里用最长边 72px 的缩略图做逐像素滑动，位置连续覆盖：
 *  1. 行列投影预筛：裁剪图沿未裁切轴的投影与原图高度相关（先把 90%+ 的组合挡掉）
 *  2. 同宽纵向 / 同高横向两种归一化，各自滑动求最大 NCC
 *  3. NCC ≥ 0.9 判定为同一作品的局部截取；0.75~0.9 的灰区再做 ±6% 小幅缩放复核，
 *     覆盖"先缩放再裁切"的版本（真实案例从 0.82 提升到 0.93，无关图仍 <0.81）
 * 跨方向始终启用；同方向仅在宽高比差异 ≥ 2% 时启用。且只对壁纸三分类生效。
 */

/** 两个已归一化投影的相关系数（点积均值） */
function profileCorr(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return -1;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum / a.length;
}

/** 双线性缩放单通道灰度图 */
function resizeGray(src, sw, sh, tw, th) {
  const out = new Uint8Array(tw * th);
  for (let y = 0; y < th; y++) {
    const sy = (y + 0.5) * sh / th - 0.5;
    const y0 = Math.max(0, Math.min(sh - 1, Math.floor(sy)));
    const y1 = Math.min(sh - 1, y0 + 1);
    const fy = Math.max(0, Math.min(1, sy - y0));
    for (let x = 0; x < tw; x++) {
      const sx = (x + 0.5) * sw / tw - 0.5;
      const x0 = Math.max(0, Math.min(sw - 1, Math.floor(sx)));
      const x1 = Math.min(sw - 1, x0 + 1);
      const fx = Math.max(0, Math.min(1, sx - x0));
      const a = src[y0 * sw + x0];
      const b = src[y0 * sw + x1];
      const c = src[y1 * sw + x0];
      const d = src[y1 * sw + x1];
      out[y * tw + x] = Math.round(
        a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) +
        c * (1 - fx) * fy + d * fx * fy
      );
    }
  }
  return out;
}

/**
 * 取某张图在指定归一化模式下的 48px 缩略图（结果缓存）。
 * mode='w'：统一宽度，适合"同宽、纵向被裁"的图；
 * mode='h'：统一高度，适合"同高、横向被裁"的图。
 */
function thumbVariant(item, mode, cache) {
  if (!item || !item.thumb || typeof item.thumb.data !== 'string') return null;
  const key = `${item.rel || ''}|${mode}|${CROP_NCC_SIZE}`;
  if (cache && cache.has(key)) return cache.get(key);
  const sw = Number(item.thumb.w) || 0;
  const sh = Number(item.thumb.h) || 0;
  if (!sw || !sh) return null;
  const src = Buffer.from(item.thumb.data, 'base64');
  if (src.length < sw * sh) return null;
  let tw, th;
  if (mode === 'w') {
    tw = CROP_NCC_SIZE;
    th = Math.max(1, Math.round(sh * CROP_NCC_SIZE / sw));
  } else {
    th = CROP_NCC_SIZE;
    tw = Math.max(1, Math.round(sw * CROP_NCC_SIZE / sh));
  }
  const variant = { data: resizeGray(src, sw, sh, tw, th), w: tw, h: th };
  if (cache) cache.set(key, variant);
  return variant;
}

/** 两块灰度图在给定偏移下的皮尔逊相关系数 */
function nccAt(full, crop, ox, oy) {
  const x1 = Math.min(crop.w, full.w - ox);
  const y1 = Math.min(crop.h, full.h - oy);
  if (x1 <= 0 || y1 <= 0) return -1;
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let y = 0; y < y1; y++) {
    let fi = (y + oy) * full.w + ox;
    let ci = y * crop.w;
    for (let x = 0; x < x1; x++) {
      const a = crop.data[ci + x];
      const b = full.data[fi + x];
      n++; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
    }
  }
  if (n < 32) return -1;
  const cov = sab - sa * sb / n;
  const va = saa - sa * sa / n;
  const vb = sbb - sb * sb / n;
  if (va <= 0 || vb <= 0) return -1;
  return cov / Math.sqrt(va * vb);
}

/**
 * 两张缩略图的最大 NCC，并记录"谁被放进谁里面滑动"。
 * 滑窗方向即裁切方向：被放入内部滑动的那张就是局部截图。
 * @returns {{score:number, cropRel:string, fullRel:string, mode:string}}
 */
function nccBest(a, b, cache) {
  let best = { score: -1, cropRel: '', fullRel: '', mode: '' };
  for (const mode of ['w', 'h']) {
    const va = thumbVariant(a, mode, cache);
    const vb = thumbVariant(b, mode, cache);
    if (!va || !vb) continue;
    if (mode === 'w') {
      // 统一宽度后，较矮的一张在较高的一张内部纵向滑动
      const aIsFull = va.h >= vb.h;
      const full = aIsFull ? va : vb;
      const crop = aIsFull ? vb : va;
      const cropRel = aIsFull ? b.rel : a.rel;
      const fullRel = aIsFull ? a.rel : b.rel;
      for (let oy = 0; oy <= full.h - crop.h; oy++) {
        const v = nccAt(full, crop, 0, oy);
        if (v > best.score) best = { score: v, cropRel, fullRel, mode };
      }
    } else {
      // 统一高度后，较窄的一张在较宽的一张内部横向滑动
      const aIsFull = va.w >= vb.w;
      const full = aIsFull ? va : vb;
      const crop = aIsFull ? vb : va;
      const cropRel = aIsFull ? b.rel : a.rel;
      const fullRel = aIsFull ? a.rel : b.rel;
      for (let ox = 0; ox <= full.w - crop.w; ox++) {
        const v = nccAt(full, crop, ox, 0);
        if (v > best.score) best = { score: v, cropRel, fullRel, mode };
      }
    }
  }
  return best;
}

/** 兼容旧调用：只要最大 NCC 分数 */
function nccScore(a, b, cache) {
  return nccBest(a, b, cache).score;
}

/**
 * 灰区缩放复核：把 48px 缩略图再按给定比例缩放后重复滑窗。
 * 只缩放任一方向作为"裁切图"的一侧，覆盖"缩放后再裁切"的组合；
 * 结果按 rel|mode|scale 缓存，避免同一张图在多个图对里重复重采样。
 */
function nccScaledBest(a, b, cache) {
  let best = { score: -1, cropRel: '', fullRel: '', mode: '' };
  const scaleVariant = (v, rel, mode, scale) => {
    if (scale === 1) return v;
    const key = `${rel}|${mode}|${CROP_NCC_SIZE}|s${scale}`;
    if (cache && cache.has(key)) return cache.get(key);
    const w = Math.max(1, Math.round(v.w * scale));
    const h = Math.max(1, Math.round(v.h * scale));
    const out = { data: resizeGray(v.data, v.w, v.h, w, h), w, h };
    if (cache) cache.set(key, out);
    return out;
  };
  for (const mode of ['w', 'h']) {
    const va = thumbVariant(a, mode, cache);
    const vb = thumbVariant(b, mode, cache);
    if (!va || !vb) continue;
    for (const scale of CROP_REFINE_SCALES) {
      for (const [baseFull, baseCrop, fullRel, cropRel] of [
        [va, vb, a.rel, b.rel],
        [vb, va, b.rel, a.rel]
      ]) {
        const crop = scaleVariant(baseCrop, cropRel, mode, scale);
        if (crop.w > baseFull.w || crop.h > baseFull.h) continue;
        if (mode === 'w') {
          for (let oy = 0; oy <= baseFull.h - crop.h; oy++) {
            const v = nccAt(baseFull, crop, 0, oy);
            if (v > best.score) best = { score: v, cropRel, fullRel, mode };
          }
        } else {
          for (let ox = 0; ox <= baseFull.w - crop.w; ox++) {
            const v = nccAt(baseFull, crop, ox, 0);
            if (v > best.score) best = { score: v, cropRel, fullRel, mode };
          }
        }
      }
    }
  }
  return best;
}

/**
 * 先固定尺度求 NCC；若落在灰区（0.75~0.9），再做小幅缩放复核。
 * 返回最优的方向与分数，供归组（只关心分数）和保留决策（关心方向）共用。
 */
function nccBestRefined(a, b, cache) {
  const best = nccBest(a, b, cache);
  if (best.score >= CROP_NCC_MIN || best.score < CROP_NCC_REFINE_MIN) return best;
  const refined = nccScaledBest(a, b, cache);
  return refined.score > best.score ? refined : best;
}

/**
 * 任意位置裁切匹配：投影预筛 → 滑窗 NCC → 灰区缩放复核。
 * 跨方向始终复核；同方向在宽高比差异明显时复核（同方向二次裁切）。
 * @returns {number|null} 命中返回 NCC 分数，未命中返回 null
 */
function nccCropMatch(a, b, cache, cfg) {
  if (!a || !b || !a.thumb || !b.thumb ||
      !Array.isArray(a.rowProf) || !Array.isArray(b.rowProf) ||
      !Array.isArray(a.colProf) || !Array.isArray(b.colProf)) return null;
  if ((a.rel && !isWallpaperRel(a.rel, cfg)) || (b.rel && !isWallpaperRel(b.rel, cfg))) return null;
  const orientA = orientationOfItem(a, cfg);
  const orientB = orientationOfItem(b, cfg);
  if (!orientA || !orientB) return null;
  if (orientA === orientB && !sameOrientationCropCandidate(a, b)) return null;

  const profile = Math.max(
    profileCorr(a.rowProf, b.rowProf),
    profileCorr(a.colProf, b.colProf)
  );
  if (profile < CROP_PROFILE_MIN) return null;
  const best = nccBestRefined(a, b, cache);
  return best.score >= CROP_NCC_MIN ? best.score : null;
}

/**
 * 判断两张图之间的裁切方向（谁是完整图、谁是被截取的图）。
 *  - 固定位置裁切指纹先给方向：A 的整图命中 B 的裁切 → A 是被截取的那张
 *  - 未命中时用滑窗 NCC 的方向：被放入另一张内部滑动的那张是截取图
 * @returns {{cropRel:string, fullRel:string, via:'crop'|'ncc', distance:number, score?:number}|null}
 */
function cropRelationOf(a, b, cropThreshold, cfg, cache) {
  if (!a || !b || !a.rel || !b.rel) return null;
  if (!isWallpaperRel(a.rel, cfg) || !isWallpaperRel(b.rel, cfg)) return null;
  const orientA = orientationOfItem(a, cfg);
  const orientB = orientationOfItem(b, cfg);
  if (!orientA || !orientB || orientA === orientB) return null;

  const arA = arOf(a);
  const arB = arOf(b);
  if (arA && arB && a.chash && b.chash && Array.isArray(a.crops) && Array.isArray(b.crops)) {
    const dA = bestCropMatch(a.chash, b.crops, arA); // A 整图 = B 的局部 → A 是截取图
    const dB = bestCropMatch(b.chash, a.crops, arB); // B 整图 = A 的局部 → B 是截取图
    const candidates = [];
    if (dA <= cropThreshold) candidates.push({ distance: dA, cropRel: a.rel, fullRel: b.rel, via: 'crop' });
    if (dB <= cropThreshold) candidates.push({ distance: dB, cropRel: b.rel, fullRel: a.rel, via: 'crop' });
    if (candidates.length) {
      candidates.sort((x, y) => x.distance - y.distance);
      // 两个方向等距命中时方向不明确，不用它做保留决策
      if (candidates.length > 1 && candidates[0].distance === candidates[1].distance) return null;
      return candidates[0];
    }
  }

  const best = nccBestRefined(a, b, cache || new Map());
  if (best.score < CROP_NCC_MIN) return null;
  return {
    cropRel: best.cropRel,
    fullRel: best.fullRel,
    via: 'ncc',
    distance: Math.round((1 - best.score) * 64),
    score: best.score
  };
}

/**
 * 跨方向裁切组的保留决策：智能识别完整原图，保留它并去掉被截取的图。
 * 与方向优先级（横>方>竖）无关——完整图可能是竖图，也可能横图。
 * 同方向组不参与方向判断（构图窗口相同，谁更完整无法可靠判断），
 * 返回 null，由调用方回退 pickKeep() 按面积保留更高清的一张。
 *
 * @returns {{keepRel:string, cropRels:string[], via:string}|null}
 *   非裁切组（同方向/无裁切关系/方向成环）返回 null，调用方回退 pickKeep()
 */
function pickCropKeeper(items, cfg, cropThreshold, cache) {
  const list = Array.isArray(items) ? items : [];
  if (list.length < 2) return null;
  const workCache = cache || new Map();
  const cropCount = new Map();
  const fullCount = new Map();
  const relations = [];

  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const rel = cropRelationOf(list[i], list[j], cropThreshold, cfg, workCache);
      if (!rel) continue;
      relations.push(rel);
      cropCount.set(rel.cropRel, (cropCount.get(rel.cropRel) || 0) + 1);
      fullCount.set(rel.fullRel, (fullCount.get(rel.fullRel) || 0) + 1);
    }
  }
  if (!relations.length) return null;

  // 保留被判定为"截取"次数最少、作为完整图次数最多的一张；
  // 次数相同再取像素面积更大的（分辨率更高）。
  let keeper = null;
  for (const it of list) {
    const c = cropCount.get(it.rel) || 0;
    const f = fullCount.get(it.rel) || 0;
    const area = (Number(it.w) || 0) * (Number(it.h) || 0);
    if (!keeper || c < keeper.c ||
        (c === keeper.c && f > keeper.f) ||
        (c === keeper.c && f === keeper.f && area > keeper.area)) {
      keeper = { rel: it.rel, c, f, area };
    }
  }
  // 所有图都被判定为截取 → 方向成环/不明确，回退方向规则
  if (!keeper || keeper.c > 0) return null;

  const cropRels = list
    .map((it) => it.rel)
    .filter((rel) => rel !== keeper.rel && (cropCount.get(rel) || 0) > 0);

  return {
    keepRel: keeper.rel,
    cropRels,
    via: relations.some((r) => r.via === 'ncc') ? 'ncc' : 'crop'
  };
}

/* ---------------------------------------------------------------
 * 索引缓存管理
 * --------------------------------------------------------------- */

/** 索引结构版本：2 = 增加整图裁切指纹（chash）与多位置裁切指纹（crops） */
const INDEX_VERSION = 2;

/** 读取索引缓存；文件损坏/缺失时返回空索引（自动降级，不报错中断） */
async function loadIndex(cfg) {
  try {
    const raw = await fsp.readFile(cfg._paths.indexFile, 'utf8');
    const obj = JSON.parse(raw);
    if (obj && obj.items && typeof obj.items === 'object') return obj;
  } catch (e) { /* ENOENT 或 JSON 损坏均按空索引处理 */ }
  return { version: INDEX_VERSION, items: {} };
}

/** 写回索引缓存（原子写：先写临时文件再改名，防中途崩溃损坏索引） */
async function saveIndex(cfg, index) {
  await fsp.mkdir(path.dirname(cfg._paths.indexFile), { recursive: true });
  index.version = INDEX_VERSION;
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
 * 刷新单个文件的索引条目（惰性计算：只在缺失/变更时重算，避免 deep 扫描重复解码）
 * @param {object|null} cached 索引中的旧条目（可为 null）
 * @param {object} opts.needCrops 是否确保裁切指纹存在（查重扫描 / 新增壁纸时）
 */
async function refreshItem(cfg, rel, cached, { needCrops = false } = {}) {
  const abs = path.join(cfg._paths.imageRoot, rel.replace(/\//g, path.sep));
  const st = await fsp.stat(abs);
  const changed = !cached || cached.mtime !== st.mtimeMs || cached.size !== st.size;
  const eligible = isWallpaperRel(rel, cfg); // 只有壁纸三分类需要局部裁切指纹
  const needCropsNow = needCrops && eligible;
  const hasHash = !!(cached && cached.md5 && cached.dhash);
  const hasCrops = !!(eligible && cached && cached.cropVersion === CROP_VERSION &&
    cached.chash && Array.isArray(cached.crops) &&
    cached.thumb && Array.isArray(cached.rowProf) && Array.isArray(cached.colProf));
  const staleCrops = !!(!eligible && cached && cached.cropVersion); // 旧索引可能给表情包算过，需剔除

  // 文件未变且所需指纹齐全 → 直接复用（deep 扫描也只补缺失项）
  if (!changed && !staleCrops && hasHash && (!needCropsNow || hasCrops)) return { rel, ...cached };

  const buf = await fsp.readFile(abs);
  let w = cached && cached.w, h = cached && cached.h;
  try {
    const meta = await sharp(buf).metadata();
    w = meta.width; h = meta.height;
    // EXIF 5–8 表示需要旋转 90°/270°，物理宽高与显示宽高相反
    if (meta.orientation && meta.orientation >= 5 && meta.orientation <= 8) [w, h] = [h, w];
  } catch (e) { /* 个别损坏图片读不出尺寸，记录为 0，不中断整体扫描 */ w = 0; h = 0; }

  let md5, dhash;
  if (changed || !hasHash) {
    md5 = md5Of(buf);
    try { dhash = await dhashOf(buf); } catch (e) { dhash = ''; }
  } else {
    md5 = cached.md5;
    dhash = cached.dhash;
  }

  // 裁切识别数据：仅壁纸三分类计算；文件变更或缓存缺失时重算，未变文件复用缓存
  let chash, crops, cropVersion, thumb, rowProf, colProf;
  if (!eligible) {
    // 表情包/临时目录：明确不写裁切字段（同时清掉旧索引可能残留的值）
    chash = undefined; crops = undefined; cropVersion = undefined;
    thumb = undefined; rowProf = undefined; colProf = undefined;
  } else if (needCropsNow && (changed || !hasCrops)) {
    try {
      const c = await cropHashesOf(buf, cfg);
      chash = c.chash; crops = c.crops; cropVersion = c.cropVersion;
      thumb = c.thumb; rowProf = c.rowProf; colProf = c.colProf;
    } catch (e) {
      // 指纹失败不阻断扫库；cropVersion=0 让下次扫描重试
      chash = ''; crops = []; cropVersion = 0;
      thumb = undefined; rowProf = undefined; colProf = undefined;
    }
  } else if (!changed && cached) {
    chash = cached.chash; crops = cached.crops; cropVersion = cached.cropVersion;
    thumb = cached.thumb; rowProf = cached.rowProf; colProf = cached.colProf;
  }

  return {
    rel,
    mtime: st.mtimeMs, size: st.size,
    w: w || 0, h: h || 0, md5, dhash,
    chash, crops, cropVersion, thumb, rowProf, colProf
  };
}

/**
 * 判断索引条目是否与缓存条目等价。
 * 逐字段比较：旧实现用 JSON.stringify 比较整串，每个文件都要把对象序列化成字符串，
 * 全库扫描时开销随文件数线性放大；这里改为 O(字段数) 的直接比较。
 * 裁切指纹由 mtime/size + cropVersion 唯一确定，无需逐条比较数组内容。
 */
function sameItem(a, b) {
  if (!a) return false;
  return a.mtime === b.mtime && a.size === b.size &&
    a.w === b.w && a.h === b.h && a.md5 === b.md5 && a.dhash === b.dhash &&
    a.chash === b.chash && a.cropVersion === b.cropVersion &&
    (!!a.thumb === !!b.thumb);
}

/**
 * 全量扫描图库并增量更新索引
 * @param {object} opts.deep 首次全量查重时确保缺失的整图指纹被补齐
 * @param {object} opts.withCrops 是否确保壁纸的局部裁切指纹存在（查重扫描时开启）
 * @returns {{items:object, changed:boolean}}
 */
async function scanLibrary(cfg, { deep = false, withCrops = false } = {}) {
  const index = await loadIndex(cfg);
  const rels = await walkImages(cfg);
  const nextItems = {};
  let changed = false;

  for (const rel of rels) {
    const cached = index.items[rel] || null;
    // deep 不再强制重算已有指纹，只补缺失项；withCrops 控制裁切指纹
    const item = await refreshItem(cfg, rel, cached, { needCrops: withCrops || deep });
    nextItems[rel] = {
      mtime: item.mtime, size: item.size, w: item.w, h: item.h,
      md5: item.md5, dhash: item.dhash,
      chash: item.chash, crops: item.crops, cropVersion: item.cropVersion,
      thumb: item.thumb, rowProf: item.rowProf, colProf: item.colProf
    };
    if (!sameItem(cached, nextItems[rel])) changed = true;
  }

  // 清理索引中已不存在的文件（图库文件被外部删除/改名后自动失效）
  for (const rel of Object.keys(index.items)) {
    if (!nextItems[rel]) { delete index.items[rel]; changed = true; }
  }
  index.items = nextItems;
  index.version = INDEX_VERSION;
  if (changed) await saveIndex(cfg, index);
  return { items: index.items, changed };
}

/**
 * 仅更新内存索引条目（不落盘）。
 * 批量操作（上传/转换/删除）应在批次结束时统一调用一次 saveIndex 持久化：旧实现
 * 每处理一张就写一次磁盘，多图批次会产生大量重复 IO。改为内存更新 + 批末一次落盘。
 */
function setIndexItem(index, rel, {
  mtime, size, w, h, md5, dhash, chash, crops, cropVersion,
  thumb, rowProf, colProf
}) {
  const item = { mtime, size, w, h, md5, dhash };
  // 裁切字段仅在有值时写入，避免旧调用方产生大量空字段
  if (chash) item.chash = chash;
  if (Array.isArray(crops)) item.crops = crops;
  if (cropVersion) item.cropVersion = cropVersion;
  if (thumb && typeof thumb.data === 'string') item.thumb = thumb;
  if (Array.isArray(rowProf)) item.rowProf = rowProf;
  if (Array.isArray(colProf)) item.colProf = colProf;
  index.items[rel] = item;
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
 * 上传前查重：将新文件的 md5/dhash（以及可选的裁切指纹）与索引内全部文件比对
 * @param {object} opts.item 新文件的 { rel, w, h, chash, crops }
 *   rel 为预计落点（如 emoticon/<主题>/__incoming__），用于表情包同目录比对；
 *   省略时不做目录限定（兼容旧调用）
 * @param {object} opts.cfg 运行配置（方向判定/目录作用域用）
 * @param {number} opts.cropThreshold 局部裁切相似阈值
 * @returns {{exact: Array<string>, similar: Array<{rel, distance, via}>}}
 *   exact   —— MD5 完全相同的库内文件（相对路径）
 *   similar —— 整图 dHash 或局部裁切命中（升序，最相似在前）；via='crop' 表示裁切命中
 */
function compareAgainstLibrary(index, md5, dhash, threshold, opts = {}) {
  const cfg = opts.cfg || null;
  const incoming = opts.item || null;
  const incomingRel = incoming && incoming.rel;
  const cropThreshold = Number.isFinite(Number(opts.cropThreshold)) ? Number(opts.cropThreshold) : 5;
  const exact = [];
  const similar = [];
  const nccCache = new Map();

  for (const [rel, item] of Object.entries(index.items)) {
    // 表情包只与本主题目录内的文件比对；壁纸/临时目录不受影响
    if (incomingRel && !emoticonPairAllowed(incomingRel, rel, cfg)) continue;
    if (md5 && item.md5 === md5) { exact.push(rel); continue; }

    let distance = 64;
    let via = '';
    let score = 0;
    if (dhash && item.dhash) {
      const d = hammingDistance(dhash, item.dhash);
      if (d <= threshold) { distance = d; via = 'dhash'; }
    }
    // 整图不像时，检查新图是否为库内某图的局部裁切：
    // 跨方向先试固定位置裁切指纹，再试任意位置滑窗 NCC；同方向直接走 NCC。
    if (!via && incoming) {
      const inItem = { rel: '', ...incoming };
      const libItem = { rel, ...item };
      const d = cropDistanceOf(inItem, libItem, cropThreshold, cfg);
      if (d !== null) {
        distance = d;
        via = 'crop';
      } else {
        const ncc = nccCropMatch(inItem, libItem, nccCache, cfg);
        if (ncc !== null) {
          score = ncc;
          distance = Math.round((1 - ncc) * 64); // 伪距离：NCC 越高越靠前
          via = 'ncc';
        }
      }
    }
    if (via) similar.push({ rel, distance, via, ...(via === 'ncc' ? { score } : {}) });
  }
  similar.sort((a, b) => a.distance - b.distance);
  return { exact, similar: similar.slice(0, 8) }; // 相似列表最多提示 8 条，避免刷屏
}

/* ---------------------------------------------------------------
 * 清理保留规则（横 > 方 > 竖）
 * --------------------------------------------------------------- */

/** 默认保留优先级：横图 > 方图 > 竖图（可被 config.dedup.keepPriority 覆盖） */
const KEEP_PRIORITY = ['heng', 'avatar', 'shu'];

/** 方向在默认规则中的权重：横图最高、方图次之、竖图最后 */
const KEEP_RANK = { heng: 3, avatar: 2, shu: 1 };

/** 方向中文名（服务端/前端提示共用语义） */
const ORIENTATION_LABELS = { heng: '横图', avatar: '方图', shu: '竖图' };

/**
 * 按真实宽高判定方向，阈值与 classify.decideCategory 保持一致：
 *  长边/短边 ≤ avatarRatioMax → 方图，否则宽>高为横图、宽≤高为竖图。
 * @returns {'heng'|'avatar'|'shu'|''} 尺寸缺失返回空串
 */
function orientationOf(width, height, cfg) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (w <= 0 || h <= 0) return '';
  const limit = Number(cfg && cfg.classify && cfg.classify.avatarRatioMax) || 1.2;
  const ratio = Math.max(w, h) / Math.min(w, h);
  if (ratio <= limit) return 'avatar';
  return w > h ? 'heng' : 'shu';
}

/** 尺寸缺失时按目录兜底判定方向（索引旧条目可能没有 w/h） */
function orientationOfItem(item, cfg) {
  if (!item) return '';
  const bySize = orientationOf(item.w, item.h, cfg);
  if (bySize) return bySize;
  const m = wallpaperDirRe(cfg).exec(String(item.rel || ''));
  return m ? m[1] : '';
}

/** 读取保留优先级；非法/缺失时回退默认值（必须是 heng/avatar/shu 的完整排列） */
function keepPriorityOf(cfg) {
  const p = cfg && cfg.dedup && cfg.dedup.keepPriority;
  if (Array.isArray(p) && p.length === KEEP_PRIORITY.length) {
    const set = new Set(p);
    if (set.size === KEEP_PRIORITY.length && KEEP_PRIORITY.every((k) => set.has(k))) {
      return p.slice();
    }
  }
  return KEEP_PRIORITY.slice();
}

/**
 * 非裁切组的保留决策（同方向/无截取关系时使用）：
 *  1. 方向优先级：横图 > 方图 > 竖图（可由 dedup.keepPriority 调整）
 *  2. 同方向：像素面积更大者优先（保留更清晰的一张）
 *  3. 面积相同：文件体积更大者优先
 *  4. 仍相同：保持组内原顺序（稳定，避免每次扫描结果跳动）
 *
 * @param {Array<{rel:string,w?:number,h?:number,size?:number}>} items
 * @param {object} cfg
 * @returns {{rel:string, orientation:string, index:number, priority:string[]}}
 */
function pickKeep(items, cfg) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return { rel: '', orientation: '', index: -1, priority: keepPriorityOf(cfg) };

  const priority = keepPriorityOf(cfg);
  const rank = new Map(priority.map((key, i) => [key, priority.length - i]));
  let bestIndex = 0;
  let bestRank = -1;
  let bestArea = -1;
  let bestSize = -1;
  let bestOrientation = '';

  list.forEach((item, index) => {
    const orientation = orientationOfItem(item, cfg);
    const r = rank.get(orientation) || 0;
    const area = (Number(item.w) || 0) * (Number(item.h) || 0);
    const size = Number(item.size) || 0;
    // 逐级比较：方向 > 面积 > 体积；全部相同则保留先出现的一张
    const better = r > bestRank ||
      (r === bestRank && area > bestArea) ||
      (r === bestRank && area === bestArea && size > bestSize);
    if (better) {
      bestIndex = index;
      bestRank = r;
      bestArea = area;
      bestSize = size;
      bestOrientation = orientation;
    }
  });

  return { rel: list[bestIndex].rel, orientation: bestOrientation, index: bestIndex, priority };
}

/**
 * 全库查重：返回"重复组"列表
 *  - exactGroups：MD5 相同的组
 *  - similarGroups：整图 dHash 相近，或跨方向/同方向局部裁切指纹与 NCC 匹配的组
 *    （贪心聚类，已归组的文件不再参与后续分组，避免组爆炸）；
 *    壁纸三分类不限目录；表情包只在同一主题目录内比对，不跨文件夹；
 *    手动忽略（muted）的图片彻底退出相似归组
 *
 * @param {object} opts.cfg 运行配置（用于方向判定，可省略）
 * @param {number} opts.cropThreshold 局部裁切相似阈值（默认 5）
 */
function findDuplicateGroups(index, threshold, muted = new Set(), opts = {}) {
  const items = index.items;
  const rels = Object.keys(items);
  const cfg = opts.cfg || null;
  const cropThreshold = Number.isFinite(Number(opts.cropThreshold)) ? Number(opts.cropThreshold) : 5;

  // 表情包作用域预计算：全库按图对比对时避免重复解析路径
  const emoticonTheme = new Map();
  for (const rel of rels) emoticonTheme.set(rel, emoticonThemeOf(rel, cfg));
  const sameEmoticonScope = (a, b) => {
    const ta = emoticonTheme.get(a);
    const tb = emoticonTheme.get(b);
    if (ta === null && tb === null) return true;
    return ta !== null && ta === tb;
  };

  // —— MD5 精确分组（不受忽略影响：字节级相同是客观事实） ——
  //     表情包按主题目录隔离：同 md5 也不跨主题、不跨分类归组 ——
  const byMd5 = new Map();
  for (const rel of rels) {
    const m = items[rel].md5;
    if (!m) continue;
    const theme = emoticonTheme.get(rel);
    const key = theme === null ? m : `${m}#emoticon:${theme}`;
    if (!byMd5.has(key)) byMd5.set(key, []);
    byMd5.get(key).push(rel);
  }
  const exactGroups = [...byMd5.values()].filter((g) => g.length > 1);

  // —— 相似贪心聚类：整图 dHash 优先；不命中时追加局部裁切比对 ——
  //     跨方向走固定裁切指纹 + NCC，同方向（宽高比差异明显）走 NCC ——
  //     被忽略（muted）的图片不参与相似归组 ——
  const used = new Set(exactGroups.flat());
  const similarGroups = [];
  const nccCache = new Map(); // 缩略图 48px 版本缓存，跨组复用
  const order = rels.filter((r) => !used.has(r) && (items[r].dhash || items[r].chash) && !muted.has(r));

  // 索引条目本身不含 rel（rel 是 Map 的 key），而裁切比对需要 rel 做
  // 壁纸目录判断与缩略图缓存键；这里统一包一层，避免缓存键全部变成 undefined。
  const decorated = new Map();
  const itemOf = (rel) => {
    if (!decorated.has(rel)) decorated.set(rel, { rel, ...items[rel] });
    return decorated.get(rel);
  };

  for (let i = 0; i < order.length; i++) {
    if (used.has(order[i])) continue;
    const pivot = itemOf(order[i]);
    const group = [order[i]];
    used.add(order[i]);
    for (let j = i + 1; j < order.length; j++) {
      if (used.has(order[j])) continue;
      const other = itemOf(order[j]);
      // 表情包只与本主题目录内的文件比对，避免跨主题/跨分类误报
      if (!sameEmoticonScope(pivot.rel, other.rel)) continue;
      let d = pivot.dhash && other.dhash ? hammingDistance(pivot.dhash, other.dhash) : 64;
      if (d > threshold) {
        // 整图不像时，再看"一张图是否为另一张图的局部裁切"：
        // 跨方向先试固定位置裁切指纹（快），未命中再用投影预筛 + 滑窗 NCC；
        // 同方向没有对应宽高比的裁切指纹，直接走 NCC（仅宽高比差异明显时）
        const cropD = cropDistanceOf(pivot, other, cropThreshold, cfg);
        if (cropD !== null) {
          d = cropD;
        } else {
          const nccD = nccCropMatch(pivot, other, nccCache, cfg);
          if (nccD === null) continue;
          d = nccD;
        }
      }
      group.push(order[j]);
      used.add(order[j]);
    }
    if (group.length > 1) similarGroups.push(group);
  }
  return { exactGroups, similarGroups };
}

module.exports = {
  md5Of, dhashOf, hammingDistance,
  loadIndex, saveIndex, scanLibrary, setIndexItem, deleteIndexItem, walkImages,
  compareAgainstLibrary, findDuplicateGroups, extSetOf,
  orientationOf, orientationOfItem, keepPriorityOf, pickKeep,
  cropHashesOf, cropDistanceOf, nccCropMatch, nccScore, profileCorr, CROP_VERSION,
  cropRelationOf, pickCropKeeper,
  KEEP_PRIORITY, ORIENTATION_LABELS,
  loadIgnoreSet, saveIgnoreSet, addIgnorePairs, removeIgnorePairs, pruneIgnorePairs
};
