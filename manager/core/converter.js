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

const path = require('path');
const sharp = require('sharp');

/** heic/heif 解码器（内嵌 libheif-wasm，含 HEVC 解码插件；sharp 预编译包不含）。
 *  延迟 require：仅在真正遇到 heic 上传时加载，不拖慢启动。 */
let heicConvert = null;
function decodeHeic(buffer) {
  if (!heicConvert) heicConvert = require('heic-convert');
  return heicConvert({ buffer, format: 'JPEG', quality: 0.92 }); // 返回 JPEG 编码的 Buffer
}

/** 支持的转换目标格式（键=前端传入值，值=落盘扩展名） */
const TARGETS = { keep: null, jpg: 'jpg', png: 'png', webp: 'webp', avif: 'avif' };

/** 无需像素级重编码的保留型格式：gif 重编码会丢帧、avif 重编码收益低且慢 */
const PASSTHROUGH_EXT = new Set(['gif', 'avif']);

/** HEIF 容器照片格式（iPhone HEIC 等）：可解码但浏览器/CDN 无法直出，入库时强制转 jpg */
const HEIF_EXT = new Set(['heic', 'heif']);

/** keep 模式下可直接重编码的格式白名单（不在此列的原格式一律兜底转 jpg） */
const ENCODABLE_EXT = new Set(['jpg', 'png', 'webp']);

/** 构建带方向转正与隐私策略的 sharp 管道 */
function buildPipe(inputBuffer, stripMeta) {
  // rotate() 按 EXIF 自动转正物理像素；stripMeta=true 时不 keepExif → 输出丢弃 EXIF
  // （防 GPS/拍摄参数外泄）。两种情况都 keepIccProfile 保留色彩配置，避免转换后偏色。
  return stripMeta
    ? sharp(inputBuffer).rotate().keepIccProfile()
    : sharp(inputBuffer).rotate().keepExif().keepIccProfile();
}

/**
 * 按目标扩展名编码（统一收口各格式的编码参数）。
 * 返回 sharp 的 { data, info }：info 内已含输出宽高，从而免去"编码后再解析一次 metadata"。
 */
async function encode(pipe, ext, quality) {
  switch (ext) {
    case 'jpg':
      // 白底压平透明通道后再压缩；mozjpeg 提升压缩率与兼容性
      return pipe.flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true }).toBuffer({ resolveWithObject: true });
    case 'png':
      return pipe.png({ compressionLevel: 9, palette: true }).toBuffer({ resolveWithObject: true });
    case 'webp':
      return pipe.webp({ quality }).toBuffer({ resolveWithObject: true });
    case 'avif':
      // AVIF 压缩率高但编码慢，quality 稍降即可获得极佳体积
      return pipe.avif({ quality: Math.min(quality, 80) }).toBuffer({ resolveWithObject: true });
    default:
      // 未知/不支持的目标：兜底按 jpg 输出
      return pipe.flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  }
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
  // 仅解析一次元数据：同时拿到 format（原格式）、pages（判断是否动图）、
  // orientation（是否需转正）、exif（是否需剥离）与物理宽高，避免重复解码
  const meta = await sharp(inputBuffer).metadata();
  // pages > 1 视为动图（GIF、动图 WebP 等），单帧或多帧静态图均为此字段缺省
  const animated = (meta.pages || 1) > 1;

  const targetKey = TARGETS[opts.target] !== undefined ? opts.target : 'keep';
  let ext = (meta.format || 'jpg').toLowerCase();
  // jpeg 统一记作 jpg，方便命名与统计
  if (ext === 'jpeg') ext = 'jpg';
  // sharp 对整个 heif 容器（avif 与 heic）的 format 都报 "heif"；
  // 用容器内压缩编码区分：av1 = avif（可原样保留），hevc = heic（须转 jpg）。
  // metadata 不可靠时再看原文件扩展名兜底。
  if (ext === 'heif') {
    const comp = String(meta.compression || '').toLowerCase();
    if (comp === 'av1') ext = 'avif';
    else if (comp === 'hevc') ext = 'heic';
    else {
      const srcExt = path.extname(opts.sourceName || '').slice(1).toLowerCase();
      ext = srcExt === 'avif' ? 'avif' : 'heic';
    }
  }

  const quality = clampQuality(opts.quality);
  // stripMeta 默认 true：未显式传 false 即剥离 EXIF（防 GPS/拍摄参数外泄）
  const stripMeta = opts.stripMeta !== false;

  // ---- 模式一：保留原格式（keep）----
  if (targetKey === 'keep') {
    // heic/heif：浏览器与 jsDelivr 分发均不支持直出，必须转 jpg。
    // sharp 预编译包无 HEVC 解码插件，先用 heic-convert（libheif-wasm）解成 JPEG，
    // 再走既有 sharp 管线（EXIF 转正对 JPEG 仍生效；heic 的 irot 方向盒在解码时已应用）。
    if (HEIF_EXT.has(ext)) {
      const jpegBuffer = Buffer.from(await decodeHeic(inputBuffer));
      const { data, info } = await encode(buildPipe(jpegBuffer, stripMeta), 'jpg', quality);
      return {
        buffer: data,
        ext: 'jpg',
        width: info.width,
        height: info.height,
        animated: false, // heic 序列（Live Photo 的视频部分）不在图片文件内，按静图处理
        converted: true,
        notice: `${ext.toUpperCase()} 照片已转为 JPG（浏览器/CDN 不支持直出 HEIF）`
      };
    }
    // orientation 存在且不为 1，说明物理像素是歪的、需按 EXIF 转正
    const needRotate = !!meta.orientation && meta.orientation !== 1;
    // 勾选了剥离且确实含 EXIF 时才需重编码去元数据
    const needStrip = stripMeta && !!meta.exif;
    // 原样保留条件：① gif/avif 恒原样（重编码会丢帧或得不偿失）
    //              ② 既不需转正、也不需剥离元数据 → 逐字节原样输出
    // 关键点：此时不做任何重编码，画质与体积与原文件完全一致（"真的原样保留"）
    if (PASSTHROUGH_EXT.has(ext) || (!needRotate && !needStrip)) {
      return {
        buffer: inputBuffer,
        ext,
        width: meta.width,
        height: meta.height,
        animated,
        converted: false
      };
    }
    // 需转正或剥离 EXIF 时才重编码：仅 jpg/png/webp 可直接编码，其余格式兜底转 jpg
    const outExt = ENCODABLE_EXT.has(ext) ? ext : 'jpg';
    const { data, info } = await encode(buildPipe(inputBuffer, stripMeta), outExt, quality);
    return {
      buffer: data,
      ext: outExt,
      width: info.width,
      height: info.height,
      animated,
      converted: outExt !== ext,
      // 仅当原格式被迫改变时给出提示，否则静默完成转正/去元数据
      notice: outExt !== ext ? `原格式 ${ext} 无法原样转正，已转为 ${outExt}` : undefined
    };
  }

  // ---- 模式二：转换为指定格式 ----
  const targetExt = TARGETS[targetKey];
  // 动图保护：动图转不同格式只会保留第一帧，默认放弃转换并原样返回
  if (animated && targetExt !== ext && !opts.allowAnimatedLoss) {
    return {
      buffer: inputBuffer,
      ext,
      width: meta.width,
      height: meta.height,
      animated,
      converted: false,
      skipped: true, // 调用方据此跳过落盘，避免"转换"出一份同格式副本
      notice: '动图已保留原格式（转静态格式仅会保留第一帧），本次未转换'
    };
  }
  // heic 输入：sharp 无法直接解码，先经 heic-convert 落到 JPEG 再编码
  let pipeInput = inputBuffer;
  if (HEIF_EXT.has(ext)) pipeInput = Buffer.from(await decodeHeic(inputBuffer));
  // 统一走 encode：info 内已含输出宽高，无需再解析一次 metadata
  const { data, info } = await encode(buildPipe(pipeInput, stripMeta), targetExt, quality);
  return {
    buffer: data,
    ext: targetExt,
    width: info.width,
    height: info.height,
    animated: HEIF_EXT.has(ext) ? false : animated,
    converted: targetExt !== ext || HEIF_EXT.has(ext)
  };
}

/** 质量参数约束到合法区间 */
function clampQuality(q) {
  const n = Number(q);
  if (!Number.isFinite(n)) return 100;
  return Math.max(30, Math.min(100, Math.round(n)));
}

module.exports = { processImage, TARGETS, clampQuality };
