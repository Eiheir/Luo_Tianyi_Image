'use strict';
/**
 * 智能图床管理器 - 服务入口
 * ---------------------------------------------------------------
 * 独立性保证（对应需求 1/5）：
 *  - 本服务是全新独立进程，只读写 LTYpicture 图库目录与 manager 模块私有目录，
 *    不修改原项目任何既有文件、目录层级与配置
 *  - 仅监听 127.0.0.1（本机访问），复用本地 Git 仓库的权限体系，无需登录
 *  - 全部路由统一异常捕获；进程级未捕获异常仅记录日志，绝不崩溃退出，
 *    保证"原有图床业务不受任何影响"
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');

const { loadConfig, safeJoinImage, ASSET_ROOT } = require('./core/config');
const classify = require('./core/classify');
const dedup = require('./core/dedup');
const storage = require('./core/storage');
const links = require('./core/links');
const gitops = require('./core/gitops');
const uploader = require('./core/uploader');
const converter = require('./core/converter');
const organize = require('./core/organize');
const settings = require('./core/settings');
const history = require('./core/history');
const zipstream = require('./core/zipstream');

/* ---------------------------------------------------------------
 * 启动准备：配置、私有目录、索引
 * --------------------------------------------------------------- */
const cfg = loadConfig();

/** 确保模块私有目录存在（全部位于 manager/.cache 与 manager/.trash，不碰图库） */
async function ensureDirs() {
  for (const dir of [cfg._paths.tmpDir, cfg._paths.thumbDir, cfg._paths.logDir, cfg._paths.trashDir]) {
    await fsp.mkdir(dir, { recursive: true });
  }
}

/** 清理上传暂存目录的残留文件（进程异常退出可能遗留），避免暂存文件长期占用磁盘 */
async function cleanTmp() {
  let entries;
  try { entries = await fsp.readdir(cfg._paths.tmpDir); }
  catch (e) { return; } // 目录不存在等情况静默跳过
  for (const name of entries) {
    await fsp.unlink(path.join(cfg._paths.tmpDir, name)).catch(() => {});
  }
}

/** 错误日志单文件大小上限：超过则轮转，防止长期运行把日志写成超大文件 */
const MAX_LOG_BYTES = 2 * 1024 * 1024; // 2MB

/** 进程级错误日志（记录到模块私有目录，不影响服务运行） */
async function logError(scope, err) {
  const line = `[${new Date().toISOString()}] [${scope}] ${err && err.stack ? err.stack : err}\n`;
  const logFile = path.join(cfg._paths.logDir, 'error.log');
  try {
    // 轮转：超过上限就把当前日志改名为 error.log.1（覆盖旧备份，只保留一份历史）
    const st = await fsp.stat(logFile).catch(() => null);
    if (st && st.size > MAX_LOG_BYTES) await fsp.rename(logFile, `${logFile}.1`).catch(() => {});
    await fsp.appendFile(logFile, line, 'utf8');
  } catch (e) { /* 日志写失败时仅打印，避免二次异常 */ }
  console.error(`[${scope}]`, err);
}

// 进程级兜底：未捕获异常/拒绝 只记日志，不退出进程（需求 5：异常处理机制）
process.on('uncaughtException', (err) => logError('uncaughtException', err));
process.on('unhandledRejection', (err) => logError('unhandledRejection', err));

/* ---------------------------------------------------------------
 * Express 应用
 * --------------------------------------------------------------- */
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' })); // JSON 请求体上限 1MB（仅承载路径列表等小数据）

// 基础安全响应头：本服务虽默认仅监听本机回环，仍补齐基础防护，降低误暴露/被嵌入的风险
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); // 禁止浏览器对响应做 MIME 嗅探
  res.setHeader('Referrer-Policy', 'no-referrer');    // 不外泄引用来源
  res.setHeader('X-Frame-Options', 'DENY');           // 禁止被 iframe 嵌入
  next();
});

/* ---------- 访问令牌鉴权（可选，config.accessToken 非空时启用） ----------
 * 启用场景：监听局域网地址 / 开放外部工具上传时。
 * 放行规则：Authorization: Bearer <token> 或 ?token=<token>（后者给浏览器下载/外部工具用）。
 * 健康检查放行，便于监控探活；比较使用恒定时间算法，避免时序侧信道。 */
function tokenMatch(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
app.use('/api', (req, res, next) => {
  if (!cfg.accessToken) return next();
  if (req.path === '/health') return next();
  const bearer = String(req.headers.authorization || '');
  const token = bearer.startsWith('Bearer ') ? bearer.slice(7)
    : (typeof req.query.token === 'string' ? req.query.token : '');
  if (tokenMatch(token, cfg.accessToken)) return next();
  fail(res, 401, '未授权：缺少或错误的访问令牌');
});

/** 内存态索引：启动时加载，上传/转换/删除时增量更新 */
let index = null;

/* 编号分配互斥锁：上传（含外部工具）/批量转换都先"扫描目录最大编号再落盘"，
 * 前端 3 路并发上传时，若不串行化这段，两个请求会读到同一 maxNo → 同号互相覆盖。
 * 锁只包住"处理+落盘"，不阻塞请求体接收：3 个文件的字节仍在并发上传，
 * 服务端按到达顺序逐个处理——网络并行、落盘串行，兼得速度与正确性。 */
let processLock = Promise.resolve();
function withProcessLock(fn) {
  const run = () => Promise.resolve().then(fn);
  const p = processLock.then(run, run);
  processLock = p.catch(() => {}); // 失败也要放行后续任务
  return p;
}

// —— 扫描缓存（消除 /api/images 与 /api/stats 并发时的重复扫库与索引竞态）——
// 前端刷新列表时这两个接口并行调用，旧实现各自 scanLibrary → 同一时刻把整个图库 stat 两遍，
// 且两次扫描各自赋值 index.items 存在相互覆盖风险。这里用"在途 Promise + TTL"合并：
//  - 已有在途扫描：后续请求直接复用同一个 Promise（并发合并）
//  - TTL 窗口内的结果：直接复用，不再触发新的全库 stat
// 注意：promise 解析出的正是 index 对象引用，因此上传/转换/删除对内存索引的增量修改
// 会即时反映，TTL 仅用于"省掉重复的磁盘扫描"。
let scanCache = { at: 0, promise: null };
const SCAN_TTL_MS = 1500; // 扫描结果复用窗口（毫秒）

/** 获取最新索引：带 TTL 复用与并发合并，确保同一时刻只扫描一次图库 */
function getIndex() {
  const now = Date.now();
  if (scanCache.promise && now - scanCache.at < SCAN_TTL_MS) return scanCache.promise;
  scanCache.at = now;
  scanCache.promise = dedup.scanLibrary(cfg, { deep: false }).then((scan) => {
    index.items = scan.items;
    return index;
  }).catch((e) => {
    // 扫描失败：清空缓存，避免把失败状态缓存住导致后续请求持续异常
    scanCache.promise = null;
    throw e;
  });
  return scanCache.promise;
}

/** 统一成功响应 */
function ok(res, data) { res.json({ ok: true, data }); }
/** 统一失败响应 */
function fail(res, status, error) { res.status(status).json({ ok: false, error }); }

/** 异步路由包装：捕获业务异常 → 统一 JSON 错误，防止进程崩溃 */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(async (e) => {
  await logError(req.path, e);
  fail(res, 500, e.message || '服务器内部错误');
});

/** 路径参数安全解析：非法立即 400 */
function requireSafePath(req, res) {
  const abs = safeJoinImage(cfg, req.query.p || (req.body && req.body.p));
  if (!abs) {
    fail(res, 400, '非法路径参数');
    return null;
  }
  return abs;
}

/* ---------- 基础信息 ---------- */

app.get('/api/health', (req, res) => ok(res, { status: 'up', time: Date.now() }));

// 前端所需配置（脱敏：不暴露服务器内部路径与令牌）
app.get('/api/config', (req, res) => ok(res, {
  repo: cfg.repo,
  imageRoot: cfg.imageRoot,
  classify: cfg.classify,
  naming: cfg.naming,
  dedup: {
    hammingThreshold: cfg.dedup.hammingThreshold,
    cropThreshold: Number(cfg.dedup.cropThreshold) || 5,
    keepPriority: dedup.keepPriorityOf(cfg) // 默认 ['heng','avatar','shu']
  },
  upload: cfg.upload,
  git: { enabled: cfg.git.enabled !== false, purgeCdn: !!cfg.git.purgeCdn },
  linkFormat: cfg.linkFormat,
  linkHosts: links.JSDELIVR_HOSTS,
  categories: classify.CATEGORIES,
  trashRetentionDays: Math.round(storage.TRASH_RETENTION_MS / 86400000),
  authRequired: !!cfg.accessToken,          // 前端据此决定是否可能弹出令牌输入框
  externalUploadPath: '/api/external/upload' // 外部工具上传端点（PicGo 等）
}));

/* ---------- 上传（批量） ---------- */

// multer 磁盘暂存配置：文件先落到 manager/.cache/tmp/，处理后即删
const uploadDiskStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, cfg._paths.tmpDir),
  filename: (req, file, cb) => {
    // 随机暂存名，避免中文文件名编码问题
    cb(null, `up-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  }
});
const uploadLimits = {
  files: Number(cfg.upload.maxBatchFiles) || 200,
  fileSize: (Number(cfg.upload.maxFileMB) || 60) * 1024 * 1024
};
const uploadMiddleware = multer({ storage: uploadDiskStorage, limits: uploadLimits }).array('files');
// 外部工具端点：字段名不固定（PicGo 用 file，ShareX 用 sharex，快捷指令自定义），用 any 全收
const uploadAnyMiddleware = multer({ storage: uploadDiskStorage, limits: uploadLimits }).any();

// 包装 multer：解析失败（超数量/超大文件）返回友好中文错误。
// 关键修正：返回 Promise，使 handleUpload 内部的异步异常能通过 reject 冒泡到外层 wrap，
// 由 wrap 统一记录日志并返回 500；否则异步异常会逃逸成"未处理的 Promise 拒绝"，
// 前端会一直等不到响应直到超时（旧实现遗漏了 await/catch）。
function uploadHandler(req, res) {
  return new Promise((resolve, reject) => {
    uploadMiddleware(req, res, (err) => {
      if (err) {
        const msg = /LIMIT_FILE_COUNT/.test(err.code || '') ? `单批最多 ${cfg.upload.maxBatchFiles} 个文件`
          : /LIMIT_FILE_SIZE/.test(err.code || '') ? `单个文件不能超过 ${cfg.upload.maxFileMB} MB`
          : err.message;
        fail(res, 400, msg);
        return resolve();
      }
      // 异步执行的 handleUpload：成功/失败分别交回 resolve/reject，统一由 wrap 收口
      handleUpload(req, res).then(resolve, reject);
    });
  });
}

async function handleUpload(req, res) {
  if (!req.files || req.files.length === 0) return fail(res, 400, '未收到任何文件');
  // 批级选项：以 JSON 字符串随表单上传，前端传 options 字段
  let opts = {};
  try { opts = JSON.parse(req.body.options || '{}'); } catch (e) { /* 选项解析失败按默认处理 */ }

  const files = req.files.map((f) => ({ tmpPath: f.path, originalName: Buffer.from(f.originalname, 'latin1').toString('utf8') }));
  // 注：multer 在部分环境下按 latin1 传输原始文件名，此处转回 utf8 保证中文名展示正常

  const { results, summary } = await withProcessLock(() => uploader.processBatch(cfg, index, files, opts));
  await history.record(cfg, 'upload',
    `上传 ${summary.total} 张：成功 ${summary.ok} · 重复 ${summary.duplicate} · 失败 ${summary.failed}`,
    { via: 'web', ok: summary.ok, failed: summary.failed });
  ok(res, { results, summary });
}

app.post('/api/upload', wrap(uploadHandler));

/* ---------- 外部工具上传（PicGo / ShareX / 快捷指令） ----------
 * POST /api/external/upload（multipart，任意文件字段名）
 * 选项可走 query 或表单字段：category/theme/convert/quality/onDuplicate/stripMeta/linkType，
 * 缺省使用管理器当前设置；响应顶层直接给首个可用 url（PicGo 自定义图床取 url 字段最省事）。 */
function externalUploadHandler(req, res) {
  return new Promise((resolve, reject) => {
    uploadAnyMiddleware(req, res, (err) => {
      if (err) {
        const msg = /LIMIT_FILE_COUNT/.test(err.code || '') ? `单批最多 ${cfg.upload.maxBatchFiles} 个文件`
          : /LIMIT_FILE_SIZE/.test(err.code || '') ? `单个文件不能超过 ${cfg.upload.maxFileMB} MB`
          : err.message;
        fail(res, 400, msg);
        return resolve();
      }
      handleExternalUpload(req, res).then(resolve, reject);
    });
  });
}

async function handleExternalUpload(req, res) {
  if (!req.files || req.files.length === 0) {
    return fail(res, 400, '未收到任何文件（multipart 任意文件字段名均可，如 file/files/image/sharex）');
  }
  const q = req.query || {};
  const b = req.body || {};
  const pick = (k) => (q[k] != null && q[k] !== '' ? q[k] : b[k]);
  const opts = {
    category: pick('category') || 'auto',
    theme: pick('theme') || '',
    convert: pick('convert') || 'keep',
    quality: Number(pick('quality')) || undefined,
    onDuplicate: pick('onDuplicate') || undefined,
    stripMeta: String(pick('stripMeta')) !== 'false',
    linkType: pick('linkType') || cfg.linkFormat
  };
  const files = req.files.map((f) => ({ tmpPath: f.path, originalName: Buffer.from(f.originalname, 'latin1').toString('utf8') }));
  const { results, summary } = await withProcessLock(() => uploader.processBatch(cfg, index, files, opts));
  const firstOk = results.find((r) => r.status === 'ok' || r.status === 'duplicate');
  await history.record(cfg, 'upload',
    `外部工具上传 ${summary.total} 张：成功 ${summary.ok} · 重复 ${summary.duplicate} · 失败 ${summary.failed}`,
    { via: 'external', ok: summary.ok, failed: summary.failed });
  ok(res, { url: firstOk ? firstOk.url : '', results, summary });
}

app.post('/api/external/upload', wrap(externalUploadHandler));

/* ---------- 图库查询 / 统计 / 预览 ---------- */

app.get('/api/images', wrap(async (req, res) => {
  // 复用带 TTL 的扫描结果：与 /api/stats 并发时只扫一次库，消除重复 stat 与索引竞态
  await getIndex();
  ok(res, storage.listImages(index, cfg, {
    category: req.query.category, format: req.query.format, q: req.query.q,
    minSize: req.query.minSize, minWidth: req.query.minWidth
  }));
}));

app.get('/api/stats', wrap(async (req, res) => {
  // 与 /api/images 共用同一份扫描结果（TTL 内合并），避免重复扫库
  await getIndex();
  const stats = storage.buildStats(index, cfg);
  // 磁盘剩余空间（图库所在卷）。statfs 不可用的环境（旧 Node/平台限制）返回 null，前端自动隐藏
  let disk = null;
  try {
    if (typeof fsp.statfs === 'function') {
      const s = await fsp.statfs(cfg._paths.imageRoot);
      disk = { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) };
    }
  } catch (e) { /* 降级为本功能缺席，不影响统计主体 */ }
  ok(res, { ...stats, disk });
}));

// 缩略图（动态生成 + 落盘缓存）
app.get('/api/thumb', wrap(async (req, res) => {
  const abs = requireSafePath(req, res);
  if (!abs) return;
  const rel = path.relative(cfg._paths.imageRoot, abs).replace(/\\/g, '/');
  const width = Math.max(64, Math.min(2400, parseInt(req.query.w, 10) || 360));
  try {
    const buf = await storage.makeThumbnail(cfg, rel, width);
    res.set('Content-Type', 'image/webp');
    res.set('Cache-Control', 'public, max-age=86400'); // 缓存键含 mtime，图片更新自动失效
    res.send(buf);
  } catch (e) {
    fail(res, 404, `无法生成缩略图：${e.message}`);
  }
}));

// 原图预览（浏览器内查看大图）
app.get('/api/raw', wrap(async (req, res) => {
  const abs = requireSafePath(req, res);
  if (!abs) return;
  res.sendFile(abs);
}));

/* ---------- 重复图片检测 ---------- */

app.post('/api/duplicates/scan', wrap(async (req, res) => {
  const deep = !!(req.body && req.body.deep);
  // deep=true 时补齐缺失的整图指纹；withCrops 确保壁纸拥有局部裁切指纹（首次会慢一些）
  const scan = await dedup.scanLibrary(cfg, {
    deep: deep || Object.values(index.items).every((i) => !i.dhash),
    withCrops: true
  });
  index.items = scan.items;
  const threshold = Number(cfg.dedup.hammingThreshold) || 5;
  const cropThreshold = Number(cfg.dedup.cropThreshold) || 5;
  // 手动忽略：用户确认"看着像但不是重复"的图片，相似归组时彻底跳过
  const muted = await dedup.loadIgnoreSet(cfg);
  const groups = dedup.findDuplicateGroups(index, threshold, muted, { cfg, cropThreshold });
  // 组内附带缩略图信息 + 方向 + 默认保留标记，前端直接渲染
  const decorate = (group) => {
    // 内部条目保留裁切指纹/缩略图，用于判断谁是被截取的图；响应中不下发这些大字段
    const internal = group.map((rel) => ({ rel, ...(index.items[rel] || {}) }));
    const items = internal.map((it) => ({
      rel: it.rel, name: path.basename(it.rel), w: it.w || 0, h: it.h || 0,
      size: it.size || 0, sizeText: storage.humanSize(it.size), mtime: it.mtime || 0,
      orientation: dedup.orientationOfItem({ rel: it.rel, w: it.w, h: it.h }, cfg),
      crossOrientation: false,
      cropGroup: false,
      isCrop: false,
      keepReason: 'rule',
      keeper: false
    }));
    // 组内出现横/方/竖不同方向 → 可能来自"整图 + 局部裁切"识别
    const orientations = new Set(items.map((it) => it.orientation).filter(Boolean));
    const cross = orientations.size > 1;
    for (const it of items) it.crossOrientation = cross;

    // 跨方向裁切组：智能识别完整原图，保留原图、去除被截取的图；
    // 非裁切组仍按方向规则（横 > 方 > 竖）选保留项。
    const cropInfo = dedup.pickCropKeeper(internal, cfg, cropThreshold);
    const keep = cropInfo ? { rel: cropInfo.keepRel } : dedup.pickKeep(items, cfg);
    const cropSet = new Set(cropInfo ? cropInfo.cropRels : []);
    for (const it of items) {
      it.keeper = it.rel === keep.rel;
      it.cropGroup = !!cropInfo;
      it.isCrop = cropSet.has(it.rel);
      it.keepReason = cropInfo ? 'crop' : 'rule';
    }
    return items;
  };
  ok(res, {
    exactGroups: groups.exactGroups.map(decorate),
    similarGroups: groups.similarGroups.map(decorate),
    keepPriority: dedup.keepPriorityOf(cfg),
    cropThreshold,
    scanned: Object.keys(index.items).length,
    ignoredPairs: muted.size
  });
}));

/* ---------- 查重手动忽略 ---------- */

// 查看全部被忽略的图片（取消忽略管理界面用）
app.get('/api/duplicates/ignored', wrap(async (req, res) => {
  const muted = await dedup.loadIgnoreSet(cfg);
  const items = [...muted].map((rel) => {
    const it = index.items[rel] || {};
    return {
      rel, name: path.basename(rel), w: it.w || 0, h: it.h || 0,
      size: it.size || 0, mtime: it.mtime || 0, sizeText: storage.humanSize(it.size)
    };
  });
  ok(res, { items });
}));

// 新增忽略：整组图片全部静音（按图忽略，之后相似归组彻底跳过这些图）
app.post('/api/duplicates/ignore', wrap(async (req, res) => {
  const { paths } = req.body || {};
  if (!Array.isArray(paths) || paths.length === 0) return fail(res, 400, '未指定图片');
  ok(res, await dedup.addIgnorePairs(cfg, index, paths));
}));

// 取消忽略（按图片路径），恢复参与相似归组
app.post('/api/duplicates/unignore', wrap(async (req, res) => {
  const { keys } = req.body || {};
  if (!Array.isArray(keys) || keys.length === 0) return fail(res, 400, '未指定要取消的忽略项');
  ok(res, await dedup.removeIgnorePairs(cfg, keys));
}));

/* ---------- 批量格式转换 ---------- */

app.post('/api/convert', wrap(async (req, res) => {
  const { paths, target, quality, replaceOriginal, allowAnimatedLoss, linkType } = req.body || {};
  if (!Array.isArray(paths) || paths.length === 0) return fail(res, 400, '未指定要转换的图片');
  if (!converter.TARGETS[target] || target === 'keep') return fail(res, 400, '无效的目标格式');
  const chosenLinkType = linkType || cfg.linkFormat;
  const results = [];
  for (const rel of paths) {
    const abs = safeJoinImage(cfg, rel);
    if (!abs) { results.push({ rel, ok: false, error: '非法路径' }); continue; }
    try {
      const input = await fsp.readFile(abs);
      const processed = await converter.processImage(input, {
        target, quality, stripMeta: true, allowAnimatedLoss: !!allowAnimatedLoss,
        sourceName: rel // heif 容器歧义（avif vs heic）时的扩展名兜底
      });
      // 动图保护：格式未变时不落盘、不动原图，只回报跳过原因
      if (processed.skipped) {
        results.push({
          rel, ok: true, skipped: true, converted: false,
          notice: processed.notice || '已跳过',
          url: links.buildLink(cfg, rel, chosenLinkType)
        });
        continue;
      }
      // 与上传共用编号互斥锁：扫描最大编号 → 原子落盘，避免与并发上传撞号
      const { newRel, st } = await withProcessLock(async () => {
        const cat = storage.categoryOf(rel, cfg);
        const relDir = cat === 'emoticon'
          ? `${cfg.classify.emoticonDir}/${path.basename(path.dirname(rel))}` // 表情包保持原主题目录
          : classify.categoryDir(cat, '', cfg);
        const dirAbs = path.join(cfg._paths.imageRoot, relDir.replace(/\//g, path.sep));
        const padding = cat === 'emoticon' ? cfg.naming.emoticonPadding : cfg.naming.padding;
        const maxNo = await classify.scanMaxNumber(dirAbs, cfg.naming.allowedExt);
        const allocated = await classify.allocatePath(dirAbs, maxNo, padding, processed.ext, cfg);
        const tmpTarget = allocated.absPath + '.tmp';
        await fsp.writeFile(tmpTarget, processed.buffer);
        await fsp.rename(tmpTarget, allocated.absPath);
        return { newRel: `${relDir}/${allocated.fileName}`, st: await fsp.stat(allocated.absPath) };
      });
      const md5 = dedup.md5Of(processed.buffer);
      const dhash = await dedup.dhashOf(processed.buffer).catch(() => '');
      // 壁纸类补充局部裁切指纹，转换后的新文件同样参与跨方向裁切匹配
      let cropData = null;
      if (['heng', 'shu', 'avatar'].includes(storage.categoryOf(newRel, cfg))) {
        try { cropData = await dedup.cropHashesOf(processed.buffer, cfg); } catch (e) { cropData = null; }
      }
      dedup.setIndexItem(index, newRel, {
        mtime: st.mtimeMs, size: st.size, w: processed.width, h: processed.height, md5, dhash,
        chash: cropData && cropData.chash,
        crops: cropData && cropData.crops,
        cropVersion: cropData && cropData.cropVersion,
        thumb: cropData && cropData.thumb,
        rowProf: cropData && cropData.rowProf,
        colProf: cropData && cropData.colProf
      });

      // 替换原图：原文件移入回收站（可恢复），并从索引移除
      let trashed = false;
      if (replaceOriginal) {
        dedup.deleteIndexItem(index, rel);
        await storage.moveToTrash(cfg, [rel]);
        trashed = true;
      }
      results.push({
        rel, ok: true, newRel, converted: processed.converted,
        notice: processed.notice || '', trashed,
        url: links.buildLink(cfg, newRel, chosenLinkType)
      });
    } catch (e) {
      results.push({ rel, ok: false, error: e.message }); // 单文件失败不阻断批次
    }
  }
  // 批末一次性持久化索引（仅当本批确有成功转换时），避免逐张写盘
  if (results.some((r) => r.ok)) await dedup.saveIndex(cfg, index);
  const convOk = results.filter((r) => r.ok && !r.skipped).length;
  await history.record(cfg, 'convert',
    `批量转换 ${convOk} 张为 ${target.toUpperCase()}${replaceOriginal ? '（原图已入回收站）' : ''}`,
    { target, ok: convOk, skipped: results.filter((r) => r.skipped).length, failed: results.filter((r) => !r.ok).length });
  ok(res, { results });
}));

/* ---------- 链接生成与导出 ---------- */

// 单图链接包（含 Markdown/HTML/BBCode 片段）
app.get('/api/link', wrap(async (req, res) => {
  const abs = requireSafePath(req, res);
  if (!abs) return;
  const rel = path.relative(cfg._paths.imageRoot, abs).replace(/\\/g, '/');
  const it = index.items[rel] || {};
  ok(res, links.linkBundle(cfg, { rel, name: path.basename(rel), w: it.w, h: it.h }, req.query.type || cfg.linkFormat));
}));

// 批量导出（返回文本，前端负责复制/下载）
app.post('/api/links/export', wrap(async (req, res) => {
  const { paths, linkType, format } = req.body || {};
  if (!Array.isArray(paths) || paths.length === 0) return fail(res, 400, '未指定图片');
  const rows = paths.map((rel) => {
    const it = index.items[rel] || {};
    return { rel, name: path.basename(rel), w: it.w, h: it.h, size: it.size, category: storage.categoryOf(rel, cfg) };
  });
  const text = links.exportLinks(cfg, rows, linkType || cfg.linkFormat, format || 'txt');
  ok(res, { text, count: rows.length });
}));

/* ---------- 打包下载（ZIP，stored 无压缩流式输出） ----------
 * 两步走：POST 校验路径并创建一次性任务（5 分钟有效）→ GET 按任务 id 流式下载。
 * 这样浏览器原生下载（显示系统下载进度）不受 fetch 内存 Blob 的大小限制。 */
const zipJobs = new Map(); // id → { entries: [{abs, name}], at }

app.post('/api/download/zip', wrap(async (req, res) => {
  const { paths } = req.body || {};
  if (!Array.isArray(paths) || paths.length === 0) return fail(res, 400, '未指定图片');
  const entries = [];
  let totalBytes = 0;
  for (const rel of paths) {
    const abs = safeJoinImage(cfg, rel);
    if (!abs) return fail(res, 400, `非法路径：${rel}`);
    const st = await fsp.stat(abs).catch(() => null);
    if (!st) return fail(res, 404, `文件不存在：${rel}`);
    totalBytes += st.size;
    // 包内文件名：相对路径压平（/ → __），中文名原样保留（ZIP 头标 UTF-8）
    entries.push({ abs, name: rel.replace(/\//g, '__') });
  }
  if (entries.length > 60000 || totalBytes > 3.5e9) {
    return fail(res, 400, '单次打包上限约 3.5GB / 6 万文件，请缩小选择范围分批下载');
  }
  const id = crypto.randomBytes(8).toString('hex');
  zipJobs.set(id, { entries, at: Date.now() });
  // 顺手清理过期任务，防止 Map 无限增长
  for (const [k, v] of zipJobs) if (Date.now() - v.at > 5 * 60 * 1000) zipJobs.delete(k);
  ok(res, { id, count: entries.length, totalBytes });
}));

app.get('/api/download/zip', wrap(async (req, res) => {
  const id = String(req.query.id || '');
  const job = zipJobs.get(id);
  if (!job) return fail(res, 404, '下载任务不存在或已过期，请重新发起');
  zipJobs.delete(id);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const name = `洛佬の美图-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.zip`;
  await zipstream.streamZip(res, job.entries, name);
}));

/* ---------- 回收站 ---------- */

app.post('/api/trash', wrap(async (req, res) => {
  const { paths } = req.body || {};
  if (!Array.isArray(paths) || paths.length === 0) return fail(res, 400, '未指定图片');
  // 全部路径必须合法（防穿越），任一非法则整批拒绝
  for (const rel of paths) {
    if (!safeJoinImage(cfg, rel)) return fail(res, 400, `非法路径：${rel}`);
  }
  const result = await storage.moveToTrash(cfg, paths);
  // 仅对成功移入回收站的文件移除索引；批末统一持久化一次，避免逐张写盘
  for (const m of result.moved) {
    if (!m.error) dedup.deleteIndexItem(index, m.rel);
  }
  await dedup.saveIndex(cfg, index);
  const movedOk = result.moved.filter((m) => !m.error).length;
  await history.record(cfg, 'trash', `移入回收站 ${movedOk} 张`, { moved: movedOk, failed: result.moved.length - movedOk });
  ok(res, result);
}));

app.get('/api/trash', wrap(async (req, res) => ok(res, await storage.listTrash(cfg))));

/* ---------- 查重清理：按方向规则保留（横>方>竖）+ 序号压到组内最小值 ---------- */

app.post('/api/duplicates/keep-best', wrap(async (req, res) => {
  const { group, keep: requestedKeep, manual } = req.body || {};
  if (!Array.isArray(group) || group.length < 2) {
    return fail(res, 400, '参数不完整：需要至少 2 张图片的 group 数组');
  }
  for (const rel of group) {
    if (!safeJoinImage(cfg, rel)) return fail(res, 400, `非法路径：${rel}`);
  }

  // 默认由服务端决策：跨方向裁切组保留完整原图、去除截取图；
  // 其他组仍按方向规则（横图 > 方图 > 竖图，同方向取最高清）。
  // 只有显式 manual=true 才允许前端指定 keep 覆盖默认决策。
  const items = group.map((rel) => ({ rel, ...(index.items[rel] || {}) }));
  const cropInfo = dedup.pickCropKeeper(items, cfg, Number(cfg.dedup.cropThreshold) || 5);
  const auto = cropInfo ? { rel: cropInfo.keepRel } : dedup.pickKeep(items, cfg);
  let keep = auto.rel;
  if (manual) {
    if (!requestedKeep || !group.includes(requestedKeep)) {
      return fail(res, 400, '手动指定的保留图片不在组内');
    }
    keep = requestedKeep;
  }
  if (!index.items[keep]) return fail(res, 400, '保留的图片不在索引中');
  const keepOrientation = dedup.orientationOfItem({ rel: keep, ...index.items[keep] }, cfg);

  // 先把同组其他图片移入回收站
  const result = await storage.moveToTrash(cfg, group.filter((rel) => rel !== keep));
  const failed = result.moved.filter((m) => m.error);
  for (const m of result.moved) {
    if (!m.error) dedup.deleteIndexItem(index, m.rel);
  }

  // 全部移入成功才改名；否则保留图仍留在原序号，避免半成功状态
  let compact = { keptRel: keep, renamed: false, reason: 'trash-failed' };
  if (failed.length === 0) {
    try {
      compact = await organize.compactKeptSequence(cfg, index, group, keep);
    } catch (e) {
      compact = { keptRel: keep, renamed: false, reason: e.message };
    }
  }

  await dedup.saveIndex(cfg, index);
  await dedup.pruneIgnorePairs(cfg, index);
  ok(res, {
    trash: result,
    compact,
    keep,
    keepOrientation,
    keepReason: manual ? 'manual' : (cropInfo ? 'crop' : 'rule'),
    cropRels: cropInfo ? cropInfo.cropRels : [],
    keepPriority: dedup.keepPriorityOf(cfg)
  });
}));

// 回收站条目缩略图（恢复前预览）
app.get('/api/trash/thumb', wrap(async (req, res) => {
  const batchId = String(req.query.b || '');
  const flat = String(req.query.f || '');
  // 与恢复接口相同的标识校验（黑名单拒绝分隔符/非法字符/..）
  const flatOk = typeof flat === 'string' && flat.length > 0 &&
    !/[\\/:*?"<>|]/.test(flat) && !flat.includes('..');
  if (!flatOk || !/^[\w-]+$/.test(batchId)) return fail(res, 400, '非法标识');
  try {
    const buf = await storage.makeTrashThumbnail(cfg, batchId, flat, 264);
    res.set('Content-Type', 'image/webp');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch (e) {
    fail(res, 404, `无法生成缩略图：${e.message}`);
  }
}));

// 单条恢复（防覆盖：目标编号被占时自动改号，renamed=true 提示前端）
app.post('/api/trash/restore', wrap(async (req, res) => {
  const { batchId, flat } = req.body || {};
  if (!batchId || !flat) return fail(res, 400, '缺少批次或文件标识');
  // 标识校验：flat 由服务端用 rel 压平生成（分隔符→"__"），此处按"黑名单"拒绝
  // 路径分隔符与 Windows 非法文件名字符（含 ".."，防穿越）；中文等 Unicode 字符必须放行，
  // 旧白名单正则 [\w&.-] 不匹配中文，导致中文主题目录（如 emoticon/流光/）的文件无法恢复。
  // 分隔符/越界的最终防线在 storage.restoreFromTrash 内（path.basename 比对 + 目标路径校验）。
  const flatOk = typeof flat === 'string' && flat.length > 0 &&
    !/[\\/:*?"<>|]/.test(flat) && !flat.includes('..');
  if (!flatOk || !/^[\w-]+$/.test(batchId)) return fail(res, 400, '非法标识');
  const { rel, renamed } = await storage.restoreFromTrash(cfg, batchId, flat);
  // 恢复后重新入索引
  const scan = await dedup.scanLibrary(cfg, { deep: false });
  index.items = scan.items;
  await history.record(cfg, 'restore', `从回收站恢复 ${rel}${renamed ? '（编号冲突已改号）' : ''}`);
  ok(res, { restored: rel, renamed });
}));

// 整批恢复：遍历批次 manifest 逐条还原，单条失败不阻断
app.post('/api/trash/restore-batch', wrap(async (req, res) => {
  const { batchId } = req.body || {};
  if (!batchId || !/^[\w-]+$/.test(batchId)) return fail(res, 400, '非法批次标识');
  const result = await storage.restoreBatch(cfg, batchId);
  const scan = await dedup.scanLibrary(cfg, { deep: false });
  index.items = scan.items;
  const restoredN = Array.isArray(result.restored) ? result.restored.filter((r) => !r.error).length : 0;
  await history.record(cfg, 'restore', `整批恢复回收站批次（${restoredN} 张）`);
  ok(res, result);
}));

// 彻底删除（不可逆）：单条或整批；仅回收站内容可被 purge
app.post('/api/trash/purge', wrap(async (req, res) => {
  const { batchId, flats } = req.body || {};
  if (!batchId || !/^[\w-]+$/.test(batchId)) return fail(res, 400, '非法批次标识');
  const result = await storage.purgeTrash(cfg, batchId, flats);
  await history.record(cfg, 'purge',
    Array.isArray(flats) && flats.length ? `彻底删除回收站 ${flats.length} 条` : '清空回收站批次');
  ok(res, result);
}));

/* ---------- 图库整理：移动分类 / 编号规整 / 主题改名 ---------- */

// 移动文件到其他分类（目标内按最大编号续排；批次内任一失败则全部回滚）
app.post('/api/move', wrap(async (req, res) => {
  const { paths, category, theme } = req.body || {};
  if (!Array.isArray(paths) || paths.length === 0) return fail(res, 400, '未指定图片');
  if (!classify.CATEGORIES.includes(category) || category === 'auto') {
    return fail(res, 400, `无效分类：${category}`);
  }
  if (category === 'emoticon' && !String(theme || '').trim()) {
    return fail(res, 400, '移动到表情包需要指定主题');
  }
  const { results, movedCount } = await organize.moveImages(cfg, index, paths, { category, theme });
  if (movedCount > 0) {
    await dedup.saveIndex(cfg, index);
    await dedup.pruneIgnorePairs(cfg, index); // 路径已变，清理含失效路径的忽略对
    await history.record(cfg, 'move',
      `移动 ${movedCount} 张到 ${category}${theme ? ' · ' + theme : ''}`, { category, theme, moved: movedCount });
  }
  ok(res, { results, movedCount });
}));

// 目录编号规整（消除删除空洞，1..N 连续；旧链接会失效，前端负责二次确认）
app.post('/api/renumber', wrap(async (req, res) => {
  const { dir } = req.body || {};
  if (!dir) return fail(res, 400, '未指定目录');
  // 目录必须是图库内的标准归档目录，拒绝任意路径
  const norm = String(dir).replace(/\\/g, '/');
  const known = new Set([
    `${cfg.classify.wallpaperDir}/heng`, `${cfg.classify.wallpaperDir}/shu`,
    `${cfg.classify.wallpaperDir}/avatar`, cfg.classify.temporaryDir
  ]);
  const isTheme = norm.startsWith(`${cfg.classify.emoticonDir}/`) && !norm.includes('..');
  if (!known.has(norm) && !isTheme) return fail(res, 400, `不支持的目录：${dir}`);
  const result = await organize.renumberDirectory(cfg, index, norm);
  if (result.renumbered > 0) {
    await dedup.saveIndex(cfg, index);
    await dedup.pruneIgnorePairs(cfg, index); // 编号已变，清理含失效路径的忽略对
    await history.record(cfg, 'renumber',
      `编号规整 ${norm}：填补 ${result.filled} 个空位，重命名 ${result.renumbered} 张（保持 ${result.alreadyInPlace} 张不变）`);
  }
  ok(res, result);
}));

// 手动调整目录内图片顺序（按新顺序改写编号）
app.post('/api/reorder', wrap(async (req, res) => {
  const { dir, order } = req.body || {};
  if (!dir) return fail(res, 400, '未指定目录');
  if (!Array.isArray(order) || order.length === 0) return fail(res, 400, '未指定排序列表');
  const norm = String(dir).replace(/\\/g, '/');
  const known = new Set([
    `${cfg.classify.wallpaperDir}/heng`, `${cfg.classify.wallpaperDir}/shu`,
    `${cfg.classify.wallpaperDir}/avatar`, cfg.classify.temporaryDir
  ]);
  const isTheme = norm.startsWith(`${cfg.classify.emoticonDir}/`) && !norm.includes('..');
  if (!known.has(norm) && !isTheme) return fail(res, 400, `不支持的目录：${dir}`);

  // 与上传/转换共用编号互斥锁：避免排序改名期间有并发编号分配
  const result = await withProcessLock(() => organize.reorderDirectory(cfg, index, norm, order));
  if (result.renumbered > 0) {
    await dedup.saveIndex(cfg, index);
    await dedup.pruneIgnorePairs(cfg, index); // 旧路径已变，清理失效的忽略记录
    await history.record(cfg, 'reorder',
      `手动排序 ${norm}：重命名 ${result.renumbered} 张（共 ${result.total} 张，${result.unchanged} 张保持原名）`);
  }
  ok(res, result);
}));

// 表情包主题目录改名
app.post('/api/rename-theme', wrap(async (req, res) => {
  const { from, to } = req.body || {};
  if (!from || !to) return fail(res, 400, '缺少旧主题名或新主题名');
  const result = await organize.renameTheme(cfg, index, from, to);
  await dedup.saveIndex(cfg, index);
  await dedup.pruneIgnorePairs(cfg, index); // 主题路径已变，清理含失效路径的忽略对
  await history.record(cfg, 'rename-theme', `表情包主题改名：${from} → ${to}`);
  ok(res, result);
}));

/* ---------- 设置（持久化到 config.json 的白名单字段） ---------- */

app.get('/api/settings', wrap(async (req, res) => {
  ok(res, settings.publicView(cfg));
}));

app.post('/api/settings', wrap(async (req, res) => {
  const { runtime, applied, invalid } = await settings.update(req.body || {});
  // 热生效：深合并到运行中的 cfg。runtime 片段是嵌套对象（如 {git:{purgeCdn}}），
  // 浅 Object.assign 会用片段整体替换 cfg.git，把 enabled/timeoutMs 等未编辑字段丢掉，
  // 导致"同步功能已在配置中关闭"——必须逐键深合并（与 config.deepMerge 同语义）。
  deepMergeInto(cfg, runtime);
  ok(res, { settings: settings.publicView(cfg), applied, invalid });
}));

/** 把更新片段深合并进目标对象（仅覆盖片段中出现的键，目标其余键原样保留） */
function deepMergeInto(target, patch) {
  for (const k of Object.keys(patch)) {
    const pv = patch[k];
    if (pv && typeof pv === 'object' && !Array.isArray(pv) &&
        target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      deepMergeInto(target[k], pv);
    } else {
      target[k] = pv;
    }
  }
}

/* ---------- Git 手动同步 ---------- */

app.get('/api/git/status', wrap(async (req, res) => {
  if (cfg.git.enabled === false) return ok(res, { enabled: false, count: 0, entries: [] });
  ok(res, { enabled: true, ...(await gitops.status(cfg)) });
}));

app.post('/api/git/sync', wrap(async (req, res) => {
  if (cfg.git.enabled === false) return fail(res, 403, '同步功能已在配置中关闭');
  const result = await gitops.sync(cfg);
  await history.record(cfg, 'sync', `Git 同步${result.ok ? '成功' : '失败'}${result.detail ? '：' + String(result.detail).slice(0, 120) : ''}`);
  ok(res, result);
}));

/* ---------- 操作历史 ---------- */

app.get('/api/history', wrap(async (req, res) => {
  ok(res, await history.list(cfg, req.query.limit, req.query.offset));
}));

/* ---------- 静态资源（Web 界面） ---------- */

// 静态资源固定取自快照内/源码内的 public 目录（ASSET_ROOT），与可写数据根无关。
// 显式禁用一切缓存（no-store）：本管理器为本地单机工具，静态资源无缓存收益，
// 若依赖浏览器默认的启发式缓存，会导致「前端文件已更新、界面仍跑旧脚本」的排查困扰
// （典型表现：功能改完点击无反应，但服务端接口实测正常）。
app.use(express.static(path.join(ASSET_ROOT, 'public'), {
  etag: false,
  lastModified: false,
  cacheControl: true,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store')
}));
// 单页应用兜底：未匹配路径回到首页
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(ASSET_ROOT, 'public', 'index.html'));
});

/* ---------- 启动 ---------- */

(async () => {
  await ensureDirs();
  await cleanTmp(); // 清理上次异常退出可能遗留的上传暂存文件
  index = await dedup.loadIndex(cfg);

  // 缩略图缓存清理（异步、不阻塞启动）：删除超过保留期的孤儿缓存，防止 .cache 只增不减
  storage.cleanThumbCache(cfg).then((n) => {
    if (n > 0) console.log(`[缓存] 已清理 ${n} 个超期缩略图缓存文件`);
  }).catch((e) => logError('cleanThumbCache', e));

  // 回收站过期清理（异步、不阻塞启动）：入站超过保留期的批次连同文件一起清除
  storage.cleanExpiredTrash(cfg).then(({ batches, freed }) => {
    if (batches > 0) console.log(`[回收站] 已清理 ${batches} 个过期批次，释放 ${storage.humanSize(freed)}`);
  }).catch((e) => logError('cleanExpiredTrash', e));

  // 端口占用自愈：自动递增重试，保证服务总能启动
  let port = Number(cfg.port) || 3210;
  const maxTry = 10;
  for (let i = 0; i < maxTry; i++) {
    try {
      await new Promise((resolve, reject) => {
        const server = app.listen(port, cfg.host, () => resolve(server));
        server.on('error', reject);
      });
      break;
    } catch (e) {
      if (e.code === 'EADDRINUSE' && i < maxTry - 1) {
        console.warn(`[启动] 端口 ${port} 被占用，尝试 ${port + 1}`);
        port += 1;
      } else {
        await logError('startup', e);
        process.exitCode = 1;
        return;
      }
    }
  }

  const url = `http://${cfg.host}:${port}`;
  console.log('──────────────────────────────────────────────');
  console.log('  智能图床管理器已启动（独立模块，未改动原有图床）');
  console.log(`  管理界面：${url}`);
  console.log(`  图库目录：${cfg._paths.imageRoot}`);
  // 安全提示：非回环监听时必须配合访问令牌，否则等同于把图库管理权交给整个局域网
  if (!['127.0.0.1', 'localhost', '::1'].includes(cfg.host)) {
    if (cfg.accessToken) {
      console.log('  访问令牌：已启用（局域网访问需凭令牌）');
    } else {
      console.warn(`  [安全告警] 监听地址为 ${cfg.host}（非本机回环）且未配置 accessToken！`);
      console.warn('  [安全告警] 局域网内任何设备都可上传/删除你的图库，请立即在 config.json 设置 accessToken');
    }
  } else if (cfg.accessToken) {
    console.log('  访问令牌：已启用');
  }
  console.log('  按 Ctrl+C 停止服务');
  console.log('──────────────────────────────────────────────');

  // 自动打开浏览器（失败不影响服务）
  if (process.argv.includes('--no-open')) return;
  const { exec } = require('child_process');
  exec(`start "" "${url}"`, { shell: 'cmd.exe' }, () => {});
})().catch(async (e) => {
  // 启动阶段异常兜底：记录日志并以非零码退出，便于排障
  await logError('startup', e);
  process.exitCode = 1;
});
