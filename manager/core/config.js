'use strict';
/**
 * 模块：配置加载与路径安全
 * ---------------------------------------------------------------
 * 职责：
 *  1. 读取 manager/config.json（本模块独立配置，不触碰原项目任何文件）
 *  2. 将相对路径解析为绝对路径，缓存/回收站等模块私有目录统一收口
 *  3. 提供防路径穿越校验：任何来自前端的路径参数，必须落在图库根目录内
 *
 * 设计原则：本模块对原项目"只读参考、只增写图库目录"，绝不改动原有文件。
 */

const fs = require('fs');
const path = require('path');

/**
 * 双根设计（为 exe 打包做准备，源码模式下两者相同）：
 *  - ASSET_ROOT：静态资源根（Web 界面、内置配置模板）。
 *    pkg 打包后 __dirname 指向只读虚拟快照，静态资源从快照内读取。
 *  - DATA_ROOT：可写数据根（config.json / .cache / .trash）。
 *    pkg 打包后 exe 可能从任何目录运行，数据必须落在 exe 所在目录旁。
 */
const IS_PKG = !!process.pkg;                       // pkg 打包运行时注入的标志
const ASSET_ROOT = path.resolve(__dirname, '..');   // 源码态 = manager/
const DATA_ROOT = IS_PKG ? path.dirname(process.execPath) : ASSET_ROOT;

/** 默认配置：仅当 config.json 缺失对应字段时作为兜底，保证模块总能启动 */
const DEFAULTS = {
  port: 3210,
  host: '127.0.0.1',
  // 访问令牌：为空 = 不启用鉴权（仅监听本机回环时推荐）；
  // 配置后所有 /api/* 请求需携带 Authorization: Bearer <token> 或 ?token=<token>，
  // 外部工具（PicGo/快捷指令）上传也走同一令牌。
  accessToken: '',
  // 源码态：图库在 manager 上一级；exe 态：默认 exe 与图库根同级
  repoRoot: IS_PKG ? '.' : '..',
  imageRoot: 'LTYpicture',
  repo: { owner: '', name: '', branch: 'main' },
  classify: {
    avatarRatioMax: 1.2,
    wallpaperDir: 'wallpapers&illustration',
    emoticonDir: 'emoticon',
    temporaryDir: 'wallpapers&illustration/temporary'
  },
  naming: {
    padding: 4,
    emoticonPadding: 3,
    // heic/heif：iPhone 等设备的原生照片格式。sharp 预编译包可解码但不可编码（缺 HEVC
    // 编码器），入库时由 converter 兜底转 jpg 存档；avif 同属 heif 容器（可读可写）
    allowedExt: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'avif', 'heic', 'heif']
  },
  // keepPriority：非截取组的默认保留顺序（横图 > 方图 > 竖图）；
  // 跨方向裁切组始终智能保留完整原图，不受此顺序影响。
  // 必须是 ['heng','avatar','shu'] 的排列，其余值自动回退默认顺序
  // cropThreshold：跨方向"局部裁切"相似阈值（竖图是横图的一部分截取时使用），
  // 通常比整图 hammingThreshold 略宽（默认 5）
  dedup: {
    hammingThreshold: 5,
    cropThreshold: 5,
    onExactDuplicate: 'skip',
    keepPriority: ['heng', 'avatar', 'shu']
  },
  upload: { maxBatchFiles: 200, maxFileMB: 60, quality: 100 },
  git: { enabled: true, timeoutMs: 120000, purgeCdn: false },
  linkFormat: 'jsdelivr'
};

/**
 * 深合并配置：以 DEFAULTS 的键为骨架，用户配置只覆盖已有键。
 * 这样 config.json 中的说明性键（如 "_说明"）会被自动忽略，不污染运行配置。
 */
function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(over || {})) {
    const bv = base ? base[k] : undefined;
    const ov = over[k];
    if (bv && typeof bv === 'object' && !Array.isArray(bv) &&
        ov && typeof ov === 'object' && !Array.isArray(ov)) {
      out[k] = deepMerge(bv, ov);
    } else if (k in (base || {})) {
      out[k] = ov; // 仅覆盖默认配置中已存在的键
    }
  }
  return out;
}

/** 从 git remote 兜底解析仓库 owner/name（config 未填 owner/name 时使用） */
function detectRepoFromGit(repoRoot) {
  try {
    const { execFileSync } = require('child_process');
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: repoRoot, encoding: 'utf8', timeout: 8000
    }).trim();
    // 兼容 https://github.com/owner/name(.git) 与 git@github.com:owner/name(.git)
    const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/i);
    if (m) return { owner: m[1], name: m[2] };
  } catch (e) {
    // git 不可用或无 remote 时静默忽略——仓库信息以 config.json 为准
  }
  return null;
}

/** 加载并规范化配置。返回值中的 _paths 为派生绝对路径，勿写入配置文件 */
function loadConfig() {
  // 数据根下的 config.json（exe 态位于 exe 旁，可写可改；源码态位于 manager/）
  const file = path.join(DATA_ROOT, 'config.json');
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT' && IS_PKG) {
      // exe 首次运行：把内置配置模板释放到 exe 旁，方便用户直接修改。
      // 关键修正：模板中的 repoRoot 是源码态相对路径（'..'），exe 态必须
      // 改写为 '.'（exe 与图库根同级），否则图库会定位到错误目录。
      try {
        fs.copyFileSync(path.join(ASSET_ROOT, 'config.json'), file);
        const patch = JSON.parse(fs.readFileSync(file, 'utf8'));
        patch.repoRoot = '.';
        fs.writeFileSync(file, JSON.stringify(patch, null, 2), 'utf8');
        user = JSON.parse(fs.readFileSync(file, 'utf8'));
        console.log(`[配置] 已在 ${file} 生成默认配置，可按需修改`);
      } catch (e2) { /* 释放失败则使用内置默认值 */ }
    } else {
      // 配置损坏时退回默认值并记录告警，绝不因配置问题崩溃退出
      console.warn('[配置] config.json 读取失败，使用默认配置：', e.message);
    }
  }
  const cfg = deepMerge(DEFAULTS, user);

  // 派生路径（统一收口，其他模块禁止自行拼接模块私有路径；全部位于可写数据根）
  const repoRootAbs = path.resolve(DATA_ROOT, cfg.repoRoot);
  const cacheDir = path.join(DATA_ROOT, '.cache');
  cfg._paths = {
    moduleRoot: DATA_ROOT,
    repoRoot: repoRootAbs,
    imageRoot: path.resolve(repoRootAbs, cfg.imageRoot),
    cacheDir,
    tmpDir: path.join(cacheDir, 'tmp'),        // 上传暂存
    thumbDir: path.join(cacheDir, 'thumbs'),   // 缩略图缓存
    indexFile: path.join(cacheDir, 'index.json'), // 图片索引缓存
    ignoreFile: path.join(cacheDir, 'dedup-ignore.json'), // 查重手动忽略对（"疑似相似"但用户不想归组的图片对）
    logDir: path.join(cacheDir, 'logs'),       // 错误日志
    trashDir: path.join(DATA_ROOT, '.trash')   // 回收站（软删除，可恢复）
  };

  // 仓库归属信息兜底：config 未填则尝试从 git remote 自动探测
  if (!cfg.repo.owner || !cfg.repo.name) {
    const detected = detectRepoFromGit(repoRootAbs);
    if (detected) {
      cfg.repo.owner = cfg.repo.owner || detected.owner;
      cfg.repo.name = cfg.repo.name || detected.name;
    }
  }
  return cfg;
}

/**
 * 路径安全校验（防路径穿越攻击）
 * 把前端传来的相对路径解析后，强制校验其仍位于图库根目录之内。
 * @returns {string|null} 合法返回绝对路径；非法返回 null
 */
function safeJoinImage(cfg, relPath) {
  if (typeof relPath !== 'string' || !relPath.trim()) return null;
  // 统一使用 / 作为相对路径分隔符（前端与索引中均以 / 存储路径）
  const abs = path.resolve(cfg._paths.imageRoot, relPath.replace(/\//g, path.sep));
  const root = cfg._paths.imageRoot;
  if (abs === root) return null; // 不允许指向根目录本身
  if (!abs.startsWith(root + path.sep)) return null;
  return abs;
}

module.exports = { loadConfig, safeJoinImage, ASSET_ROOT, DATA_ROOT, IS_PKG, DEFAULTS };
