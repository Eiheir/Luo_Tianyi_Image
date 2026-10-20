#!/usr/bin/env node
/**
 * CI 专用：压缩超过 Workers Static Assets 单文件上限的图片
 *
 * 背景：Workers 单文件上限 25 MiB，图床里个别原图（如 heng/0029.jpg 27.8MB）
 * 会被 wrangler 拒绝。本机部署靠 overridden.json 保留压缩版，CI 每次从
 * 原始 checkout 复制图片，没有这一步，因此需要在生成缩略图前现场压缩。
 *
 * 用法：node scripts/gallery-assets/compress-oversized-ci.mjs --root worker/assets
 *
 * 说明：
 * - 只处理图片文件；超过 --limit-mb（默认 24）的图片等比缩到 8000px 宽、
 *   质量 90 的 JPEG，并统一为 .jpg 后缀（manifest 之后生成，会记录新路径）。
 * - GIF 超限无法在不丢动画的前提下压缩，直接报错让部署失败，交人工处理。
 */

import { readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

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
      out[key] = true;
    }
  }
  return out;
};

const args = parseArgs(process.argv.slice(2));
const root = resolve(process.cwd(), typeof args.root === 'string' ? args.root : 'worker/assets');
const limitMb = Number(args['limit-mb']) || 24;
const limit = limitMb * 1024 * 1024;
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif'];

const walk = (dir, acc = []) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
};

const sharp = (await import('sharp')).default;
const files = walk(root).filter((file) => {
  const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
  return IMAGE_EXTS.includes(ext) && statSync(file).size > limit;
});

console.log(`发现 ${files.length} 张超过 ${limitMb}MiB 的图片`);
let failed = false;

for (const file of files) {
  const rel = relative(root, file).split('\\').join('/');
  const before = statSync(file).size;

  if (file.toLowerCase().endsWith('.gif')) {
    console.error(`✘ 超限 GIF 无法自动压缩（会丢动画），请人工处理: ${rel}`);
    failed = true;
    continue;
  }

  const buf = await sharp(file, { limitInputPixels: false })
    .resize({ width: 8000, withoutEnlargement: true })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();

  if (buf.length > limit) {
    console.error(`✘ 压缩后仍超过 ${limitMb}MiB: ${rel}（${(buf.length / 1048576).toFixed(1)}MiB）`);
    failed = true;
    continue;
  }

  const target = file.replace(/\.(png|webp|avif|jpeg)$/i, '.jpg');
  writeFileSync(target, buf);
  if (target !== file) unlinkSync(file);

  console.log(
    `✔ ${rel}: ${(before / 1048576).toFixed(1)}MiB → ${(buf.length / 1048576).toFixed(1)}MiB`
  );
}

if (failed) process.exit(1);
console.log('超大图片压缩完成');
