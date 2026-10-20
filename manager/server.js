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

/** 内存态索引：启动时加载，上传/转换/删除时增量更新 */
let index = null;

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

// 前端所需配置（脱敏：不暴露服务器内部路径）
app.get('/api/config', (req, res) => ok(res, {
  repo: cfg.repo,
  imageRoot: cfg.imageRoot,
  classify: cfg.classify,
  naming: cfg.naming,
  dedup: { hammingThreshold: cfg.dedup.hammingThreshold },
  upload: cfg.upload,
  git: { enabled: cfg.git.enabled !== false, purgeCdn: !!cfg.git.purgeCdn },
  linkFormat: cfg.linkFormat,
  linkHosts: links.JSDELIVR_HOSTS,
  categories: classify.CATEGORIES,
  trashRetentionDays: Math.round(storage.TRASH_RETENTION_MS / 86400000)
}));

/* ---------- 上传（批量） ---------- */

// multer 磁盘暂存配置：文件先落到 manager/.cache/tmp/，处理后即删
const uploadMiddleware = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, cfg._paths.tmpDir),
    filename: (req, file, cb) => {
      // 随机暂存名，避免中文文件名编码问题
      cb(null, `up-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    }
  }),
  limits: {
    files: Number(cfg.upload.maxBatchFiles) || 200,
    fileSize: (Number(cfg.upload.maxFileMB) || 60) * 1024 * 1024
  }
}).array('files');

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

  const { results, summary } = await uploader.processBatch(cfg, index, files, opts);
  ok(res, { results, summary });
}

app.post('/api/upload', wrap(uploadHandler));

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
  ok(res, storage.buildStats(index, cfg));
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
  // deep=true 时补算全部缺失哈希（首次全量查重）；之后增量
  const scan = await dedup.scanLibrary(cfg, { deep: deep || Object.values(index.items).every((i) => !i.dhash) });
  index.items = scan.items;
  const threshold = Number(cfg.dedup.hammingThreshold) || 5;
  // 手动忽略：用户确认"看着像但不是重复"的图片，相似归组时彻底跳过
  const muted = await dedup.loadIgnoreSet(cfg);
  const groups = dedup.findDuplicateGroups(index, threshold, muted);
  // 组内附带缩略图信息，前端直接渲染
  const decorate = (group) => group.map((rel) => {
    const it = index.items[rel] || {};
    return { rel, name: path.basename(rel), w: it.w, h: it.h, size: it.size, sizeText: storage.humanSize(it.size) };
  });
  ok(res, {
    exactGroups: groups.exactGroups.map(decorate),
    similarGroups: groups.similarGroups.map(decorate),
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
    return { rel, name: path.basename(rel), w: it.w, h: it.h, sizeText: storage.humanSize(it.size) };
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

      const newRel = `${relDir}/${allocated.fileName}`;
      const st = await fsp.stat(allocated.absPath);
      const md5 = dedup.md5Of(processed.buffer);
      const dhash = await dedup.dhashOf(processed.buffer).catch(() => '');
      dedup.setIndexItem(index, newRel, {
        mtime: st.mtimeMs, size: st.size, w: processed.width, h: processed.height, md5, dhash
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
  ok(res, result);
}));

app.get('/api/trash', wrap(async (req, res) => ok(res, await storage.listTrash(cfg))));

/* ---------- 查重清理：保留最高清 + 序号压到组内最小值 ---------- */

app.post('/api/duplicates/keep-best', wrap(async (req, res) => {
  const { group, keep } = req.body || {};
  if (!Array.isArray(group) || group.length < 2 || !keep || !group.includes(keep)) {
    return fail(res, 400, '参数不完整：需要 group 数组和其中的 keep');
  }
  for (const rel of group) {
    if (!safeJoinImage(cfg, rel)) return fail(res, 400, `非法路径：${rel}`);
  }
  if (!index.items[keep]) return fail(res, 400, '保留的图片不在索引中');

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
  ok(res, { trash: result, compact });
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
  ok(res, { restored: rel, renamed });
}));

// 整批恢复：遍历批次 manifest 逐条还原，单条失败不阻断
app.post('/api/trash/restore-batch', wrap(async (req, res) => {
  const { batchId } = req.body || {};
  if (!batchId || !/^[\w-]+$/.test(batchId)) return fail(res, 400, '非法批次标识');
  const result = await storage.restoreBatch(cfg, batchId);
  const scan = await dedup.scanLibrary(cfg, { deep: false });
  index.items = scan.items;
  ok(res, result);
}));

// 彻底删除（不可逆）：单条或整批；仅回收站内容可被 purge
app.post('/api/trash/purge', wrap(async (req, res) => {
  const { batchId, flats } = req.body || {};
  if (!batchId || !/^[\w-]+$/.test(batchId)) return fail(res, 400, '非法批次标识');
  const result = await storage.purgeTrash(cfg, batchId, flats);
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
  ok(res, await gitops.sync(cfg));
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
  // 安全提示：本服务无鉴权，仅应监听本机回环；若配置成其他地址会暴露到局域网
  if (!['127.0.0.1', 'localhost', '::1'].includes(cfg.host)) {
    console.warn(`  [安全告警] 监听地址为 ${cfg.host}（非本机回环），服务无鉴权，可能被局域网内其他设备访问`);
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
