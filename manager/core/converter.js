'use strict';
/**
 * 模块：图片格式自动转换
 * ---------------------------------------------------------------
 * 基于 sharp（libvips 内核），性能远高于逐像素处理的库。
 *
 * 三个关键处理细节：
 *  1. EXIF 方向转正：手机竖拍照片的物理像素是横的、靠 EXIF 标记旋转显示。
 *     本模块统一调用 .rotate()（无参=按 EXIF 自动转正）把物理像素转正后落盘，
 *     避免不同 CDN/浏览器对 EXIF 解释不一致导致的宽高比误判与显示差异。
 *  2. 透明通道压平：webp/png 转 jpg 时，透明像素直接转会变黑底，
 *     必须先 flatten 到白色背景。
 *  3. 动图保护：GIF/动图 WebP 转静态格式只会保留第一帧，
 *     默认跳过这类转换并如实告知调用方，除非显式声明"接受丢帧"。
 *
 * 隐私策略：默认剥离 EXIF（图床公开在 GitHub 上，拍摄参数/GPS 不应外泄），
 * 但保留 ICC 色彩配置文件，避免转换后偏色。
 */

const sharp = require('sharp');

/** 支持的转换目标格式（键=前端传入值，值=落盘扩展名） */
const TARGETS = { keep: null, jpg: 'jpg', png: 'png', webp: 'webp', avif: 'avif' };

/**
 * 判断图片是否为动图（多帧）
 */
async function detectAnimated(inputBuffer) {
  const meta = await sharp(inputBuffer, { pages: 1 }).metadata();
  // gif/webp 的帧数在 pages / nPages 字段；>1 即动图
  const pages = meta.pages || meta.nPages || 1;
  const isMultiFrameExt = ['gif', 'webp'].includes((meta.format || '').toLowerCase());
  return { meta, animated: isMultiFrameExt && pages > 1 };
}

/**
 * 处理单张图片（方向转正 + 按需格式转换）
 * @param {Buffer} inputBuffer 原始字节
 * @param {object} opts
 *   - target: 'keep'|'jpg'|'png'|'webp'|'avif'
 *   - quality: 压缩质量（对 png 无效，png 使用最高压缩级别）
 *   - stripMeta: 是否剥离 EXIF 等元数据（默认 true，防隐私泄露）
 *   - allowAnimatedLoss: 动图转静态格式是否接受只留第一帧（默认 false）
 * @returns {Promise<{buffer, ext, width, height, animated, converted, notice?}>}
 */
async function processImage(inputBuffer, opts = {}) {
  const { meta, animated } = await detectAnimated(inputBuffer);
  const targetKey = TARGETS[opts.target] !== undefined ? opts.target : 'keep';
  let ext = (meta.format || 'jpg').toLowerCase();
  // jpeg 统一记作 jpg，方便命名与统计
  if (ext === 'jpeg') ext = 'jpg';

  let notice;
  let finalExt = ext;

  // 动图保护：目标格式与原格式不同且是动图 → 默认放弃转换
  if (animated && targetKey !== 'keep' && TARGETS[targetKey] !== ext && !opts.allowAnimatedLoss) {
    notice = '动图已保留原格式（转静态格式仅会保留第一帧）';
  } else if (targetKey !== 'keep') {
    finalExt = TARGETS[targetKey];
  }

  const quality = clampQuality(opts.quality);

  // 组装 sharp 管道：rotate() 按 EXIF 自动转正物理像素。
  // 隐私说明：不调用 keepExif() 时，输出默认丢弃 EXIF（防止 GPS/拍摄参数外泄）；
  // ICC 色彩配置文件用 keepIccProfile() 显式保留，避免转换后偏色。
  const pipe = opts.stripMeta === false
    ? sharp(inputBuffer).rotate().keepExif().keepIccProfile()
    : sharp(inputBuffer).rotate().keepIccProfile();

  let buffer;
  switch (finalExt) {
    case 'jpg':
      // 白底压平透明通道后再压缩；mozjpeg 提升压缩率与兼容性
      buffer = await pipe.flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true }).toBuffer();
      break;
    case 'png':
      buffer = await pipe.png({ compressionLevel: 9, palette: true }).toBuffer();
      break;
    case 'webp':
      buffer = await pipe.webp({ quality }).toBuffer();
      break;
    case 'avif':
      // AVIF 压缩率高但编码慢，quality 稍降即可获得极佳体积
      buffer = await pipe.avif({ quality: Math.min(quality, 80) }).toBuffer();
      break;
    default:
      // keep：保留原格式重新编码（仅完成方向转正/压平）
      switch (ext) {
        case 'png':
          buffer = await pipe.png({ compressionLevel: 9, palette: true }).toBuffer();
          break;
        case 'webp':
          buffer = await pipe.webp({ quality }).toBuffer();
          break;
        case 'gif':
        case 'avif':
          // gif 动图与 avif 不重编码，保留原始字节（转正对动图无意义）
          buffer = inputBuffer;
          break;
        default:
          buffer = await pipe.flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true }).toBuffer();
          finalExt = 'jpg';
      }
  }

  // 读取输出尺寸（rotate 后的真实宽高）
  const outMeta = await sharp(buffer).metadata();
  return {
    buffer,
    ext: finalExt,
    width: outMeta.width,
    height: outMeta.height,
    animated,
    converted: finalExt !== ext,
    notice
  };
}

/** 质量参数约束到合法区间 */
function clampQuality(q) {
  const n = Number(q);
  if (!Number.isFinite(n)) return 82;
  return Math.max(30, Math.min(100, Math.round(n)));
}

module.exports = { processImage, detectAnimated, TARGETS, clampQuality };
