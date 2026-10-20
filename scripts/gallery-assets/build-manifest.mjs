#!/usr/bin/env node
/**
 * 画廊资产构建脚本（缩略图 + 清单）
 *
 * 解决的问题（画廊页面卡顿）：
 *  1. 图床原图平均 2.79MB / 最大 27.8MB，直接当卡片缩略图使用，
 *     浏览器要下载并解码全尺寸图片才能显示约 300px 宽的卡片，
 *     滚动时解码线程打满，肉眼可见掉帧。
 *     → 本脚本为每张图生成宽 640 的 WebP 缩略图（约 60~150KB，20 倍以上降幅），
 *       画廊卡片用缩略图，点开预览仍用原图保证清晰度。
 *  2. 原清单只有 path/size，没有宽高。前端只能先按 4:5 占位、图片加载完再
 *     用 naturalWidth 校正比例，559 张图各触发一次瀑布流整列重排。
 *     → 本脚本用 sharp 读出真实宽高写进清单，前端首帧即可算出正确比例，零重排。
 *
 * 产出（写入 --out 目录）：
 *  - <out>/manifest.json   清单，条目为 { path, size, width, height, thumb, large? }
 *  - <out>/thumbs/<path>.webp  缩略图（相对路径与图片一一对应，扩展名统一 .webp）
 *  - <out>/large/<path>.webp   可选高清预览图（传 --large-width 时生成，如 1600）
 *
 * 用法：
 *  node build-manifest.mjs --root <含图片前缀目录的根目录> --out <资产输出目录>
 *   --root 默认 ./assets（本机部署场景：assets/LTYpicture/**）
 *   --out  默认与 --root 相同
 *   --prefix 图片目录名前缀，默认 LTYpicture
 *   --width  缩略图宽度，默认 640
 *   --quality 缩略图质量，默认 72
 *   --large-width 高清预览图宽度；不传则不生成 large/（避免增加 Worker 资产体积）
 *
 * 依赖：sharp（本机复用博客项目 node_modules；CI 中需 npm install sharp）
 */

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 支持的图片扩展名（与前端 galleryShared.ts / deploy-local.mjs 保持一致）
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif'];

/** 参数解析：支持 --key value 形式 */
const parseArgs = (argv) => {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true; // 布尔开关
    }
  }
  return out;
};

/** 递归收集目录下的图片文件（返回绝对路径） */
const walkImages = (dir, acc = []) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walkImages(full, acc);
      continue;
    }
    const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
    if (IMAGE_EXTS.includes(ext)) acc.push(full);
  }
  return acc;
};

/**
 * 依赖加载：sharp 用动态 import，按 Node 模块解析规则向上查找
 * （本机命中博客项目根 node_modules，CI 命中工作目录的 node_modules）
 */
const loadSharp = async () => {
  try {
    const mod = await import('sharp');
    return mod.default ?? mod;
  } catch (error) {
    throw new Error(
      `无法加载 sharp（${error instanceof Error ? error.message : '未知错误'}）。` +
      '本机请确认博客项目已安装依赖；CI 请先执行 npm install --no-save sharp'
    );
  }
};

/**
 * 生成画廊资产（缩略图 + 清单）
 *
 * @param {object} options
 * @param {string} options.root    含图片前缀目录的根目录
 * @param {string} options.out     资产输出目录
 * @param {string} [options.prefix] 图片目录名前缀，默认 LTYpicture
 * @param {number} [options.width]  缩略图宽度，默认 640
 * @param {number} [options.quality] 缩略图质量，默认 72
 * @param {number} [options.largeWidth] 高清预览图宽度；0 表示不生成 large/
 * @param {number} [options.concurrency] 并行处理数，默认 4（限制内存峰值）
 * @returns {Promise<{count:number, thumbsCreated:number, thumbsSkipped:number}>}
 */
export const buildGalleryAssets = async (options) => {
  const {
    root,
    out,
    prefix = 'LTYpicture',
    width = 640,
    quality = 72,
    largeWidth = 0,
    concurrency = 4,
  } = options;

  const sourceDir = join(root, prefix);
  if (!existsSync(sourceDir)) {
    throw new Error(`找不到图片目录：${sourceDir}`);
  }

  const sharp = await loadSharp();
  const files = walkImages(sourceDir);
  const largeEnabled = largeWidth > 0;
  console.log(
    `扫描到 ${files.length} 张图片，开始生成缩略图（宽 ${width}，质量 ${quality}）` +
    (largeEnabled ? `，高清预览图（宽 ${largeWidth}）` : '') +
    '...'
  );

  const thumbsDir = join(out, 'thumbs');
  const largeDir = join(out, 'large');
  mkdirSync(thumbsDir, { recursive: true });
  if (largeEnabled) mkdirSync(largeDir, { recursive: true });

  const images = [];
  let created = 0;
  let skipped = 0;
  let largeCreated = 0;
  let largeSkipped = 0;

  // 队列式并发：避免一次性把 559 张图全部丢给 sharp 造成内存峰值
  const queue = [...files];
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (queue.length > 0) {
        const srcFile = queue.shift();
        if (!srcFile) break;

        // 清单 key：相对 root 的路径（统一为 / 分隔），与部署后的访问路径一致
        const key = relative(root, srcFile).split('\\').join('/');
        // 缩略图相对路径：thumbs/ + 原路径去掉扩展名 + .webp
        const thumbKey = `thumbs/${key.replace(/\.[^.]+$/, '.webp')}`;
        // 缩略图写入输出目录（本机部署场景 out === root，本地图片与缩略图同目录）
        const thumbFile = join(out, thumbKey);

        // 读取原图真实宽高（清单里给前端用；超过 8000px 的横幅需放开像素上限）
        const meta = await sharp(srcFile, { limitInputPixels: false }).metadata();
        const imgWidth = meta.width || 0;
        const imgHeight = meta.height || 0;

        // 增量策略：缩略图已存在且比原图新 → 跳过，省去重复编码开销
        let needBuild = true;
        if (existsSync(thumbFile)) {
          if (statSync(thumbFile).mtimeMs >= statSync(srcFile).mtimeMs) {
            needBuild = false;
            skipped++;
          }
        }

        if (needBuild) {
          // 缩略图目录层级与原图一致，写入前必须递归创建父目录
          mkdirSync(dirname(thumbFile), { recursive: true });
          // 等比缩放到目标宽度（不放大），统一转 WebP
          await sharp(srcFile, { limitInputPixels: false })
            .resize({ width, withoutEnlargement: true })
            .webp({ quality, effort: 4 })
            .toFile(thumbFile);
          created++;
        }

        // 可选：生成灯箱用的高清预览图，避免前端直接加载十几 MB 原图
        let largeKey;
        if (largeEnabled) {
          largeKey = `large/${key.replace(/\.[^.]+$/, '.webp')}`;
          const largeFile = join(out, largeKey);
          let needLarge = true;
          if (existsSync(largeFile)) {
            if (statSync(largeFile).mtimeMs >= statSync(srcFile).mtimeMs) {
              needLarge = false;
              largeSkipped++;
            }
          }
          if (needLarge) {
            mkdirSync(dirname(largeFile), { recursive: true });
            await sharp(srcFile, { limitInputPixels: false })
              .resize({ width: largeWidth, withoutEnlargement: true })
              .webp({ quality: Math.max(quality, 78), effort: 4 })
              .toFile(largeFile);
            largeCreated++;
          }
        }

        images.push({
          path: key,
          size: statSync(srcFile).size,
          width: imgWidth,
          height: imgHeight,
          thumb: thumbKey,
          ...(largeKey ? { large: largeKey } : {}),
        });

        if ((created + skipped) % 50 === 0) {
          console.log(`   进度 ${created + skipped}/${files.length}`);
        }
      }
    })
  );

  // 按路径排序，保证清单顺序稳定（前端签名比对依赖顺序一致）
  images.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // 清理孤儿缩略图：原图被删除或改名后，对应的 .webp 会滞留在 thumbs 目录里，
  // 既不会被清单引用，又会白白占用部署体积（Workers 每版本有文件数上限）
  const orphanRemoved = removeOrphanVariants(thumbsDir, images);
  const largeOrphanRemoved = largeEnabled
    ? removeOrphanVariants(largeDir, images)
    : 0;

  const manifest = {
    generatedAt: new Date().toISOString(),
    count: images.length,
    images,
  };
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest));

  console.log(`✔ 清单已写入：${join(out, 'manifest.json')}（${images.length} 张）`);
  console.log(`✔ 缩略图：新建 ${created} 张，跳过（已是最新）${skipped} 张，清理孤儿 ${orphanRemoved} 张`);
  if (largeEnabled) {
    console.log(`✔ 高清预览图：新建 ${largeCreated} 张，跳过 ${largeSkipped} 张，清理孤儿 ${largeOrphanRemoved} 张`);
  }

  return { count: images.length, thumbsCreated: created, thumbsSkipped: skipped, orphansRemoved: orphanRemoved };
};

/**
 * 删除没有对应原图的孤儿缩略图 / 高清预览图
 *
 * 判定方式：变体相对路径去掉 `.webp` 后缀后得到「无扩展名的资源基名」，
 * 与清单里原图路径去掉扩展名后的基名做精确比对（如 001.jpg 与 001.png 都对应 001.webp），
 * 基名不在清单里即视为孤儿并删除。
 *
 * @param variantsDir - thumbs/ 或 large/ 目录
 * @param images - 已构建的清单条目（含原图相对路径）
 * @returns 删除的文件数量
 */
const removeOrphanVariants = (variantsDir, images) => {
  if (!existsSync(variantsDir)) return 0;

  // 有效基名集合：把清单里的原图路径去掉扩展名
  const validBaseNames = new Set(images.map(item => item.path.replace(/\.[^.]+$/, '')));

  let removed = 0;
  const walkVariants = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walkVariants(full);
        continue;
      }
      if (!name.toLowerCase().endsWith('.webp')) continue;

      // 相对变体目录的路径 → 拼回资源基名（与清单 path 同构，便于比对）
      const baseName = relative(variantsDir, full)
        .split('\\')
        .join('/')
        .replace(/\.webp$/i, '');
      if (!validBaseNames.has(baseName)) {
        unlinkSync(full);
        removed++;
      }
    }
  };
  walkVariants(variantsDir);

  return removed;
};

// 作为 CLI 直接执行时的入口
if (process.argv[1] && process.argv[1].endsWith('build-manifest.mjs')) {
  const args = parseArgs(process.argv.slice(2));
  /*
    路径解析规则：
    - 未传参数：默认处理脚本同级的 assets/ 目录（本机部署场景，图片与缩略图同目录）
    - 传了 --root / --out：按调用者的当前工作目录解析（CI 场景：在仓库根执行，
      --root . 指向 checkout 根、--out worker/assets 指向 Worker 资产目录）
  */
  const defaultRoot = join(__dirname, 'assets');
  const root = typeof args.root === 'string' ? resolve(process.cwd(), args.root) : defaultRoot;
  buildGalleryAssets({
    root,
    out: typeof args.out === 'string' ? resolve(process.cwd(), args.out) : root,
    prefix: typeof args.prefix === 'string' ? args.prefix : 'LTYpicture',
    width: Number(args.width) || 640,
    quality: Number(args.quality) || 72,
    largeWidth: Number(args['large-width']) || 0,
  }).catch((error) => {
    console.error('✘ 构建失败:', error.message);
    process.exit(1);
  });
}
