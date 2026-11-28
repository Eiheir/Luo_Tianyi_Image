#!/usr/bin/env node
/**
 * 把 build-manifest.mjs 的产物拆成三个 Worker 的资产目录
 *
 * Workers Static Assets 免费档每个 Worker 版本最多 20,000 个文件。
 * 图床每张图会生成原图 + thumb + large 三份资产，全部放一个 Worker 会先撞上限；
 * 按顶层目录拆开后，每个 Worker 各自拥有 20,000 额度，对外 URL 不变：
 *
 *   shards/main/    LTYpicture/** + manifest.json + _headers  → img.xinchengp.cn
 *   shards/thumbs/  thumbs/** + _headers                      → img.xinchengp.cn/thumbs/*
 *   shards/large/   large/** + _headers                       → img.xinchengp.cn/large/*
 *
 * 变体目录保持原来的 /thumbs、/large 前缀，路由不需要重写路径，manifest
 * 里的相对路径和前端拼接逻辑都无需改动。
 *
 * 文件用硬链接落盘（跨盘时回退复制），不复制 GB 级图片；构建目录还要给
 * actions/cache 保存，不能直接 mv 走。
 *
 * 用法：
 *   node split-assets.mjs [src] [out]
 *   src 默认 ./assets，out 默认 ./shards（相对当前工作目录）
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  linkSync,
  copyFileSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';

// Workers 免费档单 Worker 单版本上限；拆分脚本在接近/达到时提前报错
const LIMIT = 20000;
const WARN_AT = 19000;

const src = resolve(process.argv[2] ?? 'assets');
const out = resolve(process.argv[3] ?? 'shards');

if (src === out || out.startsWith(src + sep)) {
  throw new Error(`输出目录不能等于或位于源目录内：src=${src} out=${out}`);
}
if (!existsSync(join(src, 'manifest.json'))) {
  throw new Error(`找不到 manifest.json：${join(src, 'manifest.json')}`);
}
if (!existsSync(join(src, '_headers'))) {
  throw new Error(`找不到 _headers：${join(src, '_headers')}`);
}

const manifest = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf-8'));
const images = manifest.images ?? [];
const isAnimated = (x) => x.animated === true || /\.gif$/i.test(x.path);
const animatedCount = images.filter(isAnimated).length;

const linkTree = (from, to) => {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const s = join(from, name);
    const d = join(to, name);
    if (statSync(s).isDirectory()) {
      linkTree(s, d);
      continue;
    }
    try {
      linkSync(s, d);
    } catch {
      // 跨盘 / 不支持硬链接时退回复制
      copyFileSync(s, d);
    }
  }
};

const countFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).reduce(
    (n, e) => n + (e.isDirectory() ? countFiles(join(dir, e.name)) : 1),
    0
  );

rmSync(out, { recursive: true, force: true });

// main：原图 + 清单 + 头
const mainDir = join(out, 'main');
linkTree(join(src, 'LTYpicture'), join(mainDir, 'LTYpicture'));
copyFileSync(join(src, 'manifest.json'), join(mainDir, 'manifest.json'));
copyFileSync(join(src, '_headers'), join(mainDir, '_headers'));

// thumbs：缩略图 + 头
const thumbsDir = join(out, 'thumbs');
linkTree(join(src, 'thumbs'), join(thumbsDir, 'thumbs'));
copyFileSync(join(src, '_headers'), join(thumbsDir, '_headers'));

// large 可选（本机不带 --large-width 时不存在）
const largeDir = join(out, 'large');
const hasLarge = existsSync(join(src, 'large'));
if (hasLarge) {
  linkTree(join(src, 'large'), join(largeDir, 'large'));
  copyFileSync(join(src, '_headers'), join(largeDir, '_headers'));
}

const mainCount = countFiles(mainDir);
const thumbsCount = countFiles(thumbsDir);
const largeCount = hasLarge ? countFiles(largeDir) : 0;
const expectedLarge = images.length - animatedCount;

console.log(`✔ 分片完成：${out}`);
console.log(`  main   ${mainCount} 个文件（原图 ${images.length} + 清单/头 2）`);
console.log(`  thumbs ${thumbsCount} 个文件（缩略图 ${images.length} + 头 1）`);
if (hasLarge) {
  console.log(`  large  ${largeCount} 个文件（静图 ${expectedLarge} + 头 1）`);
} else {
  console.log('  large  未生成（未传 --large-width）');
}

// 计数校验：防止构建/拆分漏文件，顺便盯住 20,000 上限
const checks = [
  ['main', mainCount, images.length + 2],
  ['thumbs', thumbsCount, images.length + 1],
];
if (hasLarge) checks.push(['large', largeCount, expectedLarge + 1]);

for (const [name, actual, expected] of checks) {
  if (actual !== expected) {
    throw new Error(`${name} 分片文件数异常：实际 ${actual}，期望 ${expected}`);
  }
  if (actual >= LIMIT) {
    throw new Error(
      `${name} 分片已有 ${actual} 个文件，达到 ${LIMIT} 上限，需要继续拆分或升级 Workers Paid`
    );
  }
  if (actual >= WARN_AT) {
    console.warn(`⚠ ${name} 分片已有 ${actual} 个文件，接近 ${LIMIT} 上限`);
  }
}
