'use strict';
/**
 * 智能图床管理器 - 前端逻辑（原生 JS，无框架、无构建步骤）
 * ---------------------------------------------------------------
 * 模块划分：
 *  1. 基础工具 / Toast / 弹窗控制器 / 确认对话框
 *  2. 全局状态与视图切换
 *  3. 上传：拖拽 / 文件夹 / 剪贴板 / 队列 / 逐文件进度
 *  4. 图片库：目录树 / 筛选 / 分组 / 多选 / 键盘操作
 *  5. 灯箱：高清预览 / 缩放拖拽 / 下载 / 复制 / 删除
 *  6. 批量操作：复制、导出、移动、转换、回收站
 *  7. 查重 / 回收站 / 整理
 *  8. 统计 / 设置 / Git 同步 / 初始化
 */

/* ================================================================
 * 1. 基础工具
 * ================================================================ */

const $ = (id) => document.getElementById(id);

/** 统一请求封装：后端约定 {ok:true,data} / {ok:false,error}；非成功时抛中文错误 */
async function api(url, options = {}) {
  const res = await fetch(url, options);
  let body = null;
  try { body = await res.json(); } catch (e) { /* 非 JSON 按错误处理 */ }
  if (!res.ok || !body || body.ok !== true) {
    throw new Error((body && body.error) || `请求失败（HTTP ${res.status}）`);
  }
  return body.data;
}

/** 图标 HTML（SVG 精灵在 index.html 顶部定义） */
function icon(name, cls = '') {
  return `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

/**
 * 右上角提示。错误默认常驻，warn 7 秒，普通 4.5 秒。
 * opts: { duration, action: { label, onClick } }
 */
function toast(msg, type = 'info', opts = {}) {
  const wrap = $('toasts');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.setAttribute('role', type === 'err' ? 'alert' : 'status');

  const text = document.createElement('div');
  text.className = 'toast-text';
  text.textContent = msg;
  el.appendChild(text);

  if (opts.action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = opts.action.label;
    btn.addEventListener('click', () => {
      el.remove();
      Promise.resolve()
        .then(opts.action.onClick)
        .catch((e) => toast(e.message, 'err'));
    });
    el.appendChild(btn);
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.textContent = '×';
  close.setAttribute('aria-label', '关闭提示');
  close.addEventListener('click', () => el.remove());
  el.appendChild(close);

  wrap.appendChild(el);
  while (wrap.children.length > 5) wrap.firstElementChild.remove();

  const duration = opts.duration != null
    ? opts.duration
    : type === 'err' ? 0 : type === 'warn' ? 7000 : 4500;
  if (duration > 0) setTimeout(() => el.remove(), duration);
  return el;
}

function fmtSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, n = Number(bytes) || 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 批次 ID（2026-10-20T16-17-05-f7b6，UTC）→ 本地可读时间 */
function fmtBatchId(id) {
  const s = String(id || '');
  const m = s.slice(0, 19).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})$/);
  if (!m) return s;
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
  return Number.isFinite(t) ? fmtTime(t) : s;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function debounce(fn, wait = 280) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}

/** 与后端 classify.sanitizeTheme 保持一致，用于前端预览 */
function sanitizeTheme(theme) {
  return String(theme || '').replace(/[\\/:*?"<>|.]/g, '').trim() || '默认';
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const done = document.execCommand('copy');
    ta.remove();
    if (!done) throw new Error('复制失败，请手动复制');
    return true;
  }
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

/* ---------------- 弹窗控制器 ---------------- */

const modalHooks = new Map();
let modalLastFocus = null;

function syncOverlayLock() {
  const anyModal = [...document.querySelectorAll('.modal')].some((m) => !m.hidden);
  const lightboxOpen = !$('lightbox').hidden;
  document.body.classList.toggle('overlay-open', anyModal || lightboxOpen);
}

function openModal(id) {
  const el = $(id);
  if (!el || !el.hidden) return;
  modalLastFocus = document.activeElement;
  el.hidden = false;
  syncOverlayLock();
  const focusable = el.querySelector('input:not([type="hidden"]), select, textarea, button');
  if (focusable) setTimeout(() => focusable.focus(), 0);
}

function closeModal(id) {
  const el = $(id);
  if (!el || el.hidden) return;
  el.hidden = true;
  syncOverlayLock();
  const hook = modalHooks.get(id);
  if (hook) { modalHooks.delete(id); hook(); }
  if (modalLastFocus && modalLastFocus.isConnected && modalLastFocus.focus) modalLastFocus.focus();
}

function onModalClose(id, cb) {
  modalHooks.set(id, cb);
}

function trapFocus(container, e) {
  const list = [...container.querySelectorAll(
    'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
  )].filter((el) => el.offsetParent !== null);
  if (!list.length) return;
  const first = list[0], last = list[list.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

document.querySelectorAll('[data-close]').forEach((btn) => {
  btn.addEventListener('click', () => closeModal(btn.dataset.close));
});
document.querySelectorAll('.modal').forEach((m) => {
  m.addEventListener('click', (e) => { if (e.target === m) closeModal(m.id); });
});

/**
 * 自定义确认框（替代原生 confirm），返回 Promise<boolean>。
 */
function confirmDialog({ title = '确认操作', message = '', detail = '', okText = '确定', danger = true }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      closeModal('confirmPanel');
      resolve(v);
    };
    $('confirmTitle').textContent = title;
    $('confirmBody').innerHTML =
      `<p>${escapeHtml(message)}</p>` +
      (detail ? `<p class="muted" style="margin-top:6px">${escapeHtml(detail)}</p>` : '');
    $('confirmOk').textContent = okText;
    $('confirmOk').className = `btn ${danger ? 'danger' : 'primary'}`;
    $('confirmOk').onclick = () => finish(true);
    onModalClose('confirmPanel', () => finish(false));
    openModal('confirmPanel');
    setTimeout(() => $('confirmOk').focus(), 0);
  });
}

/** 通用结果面板：rows 为 {status:'ok'|'skip'|'fail', title, note} */
function showResult(title, rows) {
  $('resultTitle').textContent = title;
  if (typeof rows === 'string') {
    $('resultBody').innerHTML = rows;
  } else {
    const map = { ok: ['成功', 'ok'], skip: ['跳过', 'dup'], fail: ['失败', 'fail'] };
    $('resultBody').innerHTML = rows.length
      ? `<div class="result-list">${rows.map((r) => {
        const [label, cls] = map[r.status] || ['信息', ''];
        return `<div class="result-row ${r.status || ''}"><span class="tag ${cls}">${label}</span>
          <div class="result-main"><div class="result-name">${escapeHtml(r.title || '')}</div>
          ${r.note ? `<div class="result-note">${escapeHtml(r.note)}</div>` : ''}</div></div>`;
      }).join('')}</div>`
      : '<div class="empty">没有需要展示的结果</div>';
  }
  openModal('resultPanel');
}

/* ================================================================
 * 2. 全局状态与视图切换
 * ================================================================ */

const CAT_NAMES = {
  all: '全部', heng: '横图', shu: '竖图', avatar: '方形',
  emoticon: '表情包', temporary: '临时', '其他': '其他'
};

const CHIP_DIR = {
  all: '',
  heng: 'wallpapers&illustration/heng',
  shu: 'wallpapers&illustration/shu',
  avatar: 'wallpapers&illustration/avatar',
  emoticon: 'emoticon',
  temporary: 'wallpapers&illustration/temporary',
  '其他': '__other__'
};

const PAGE_SIZE = 240;

function readStorage(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch (e) { return fallback; }
}
function writeStorage(key, value) {
  try { localStorage.setItem(key, value); } catch (e) { /* 忽略隐私模式限制 */ }
}

const state = {
  cfg: null,
  linkType: 'jsdelivr',
  queue: [],
  uploading: false,
  uploadStop: false,
  lib: [],
  libAll: [],
  selected: new Set(),
  lastClicked: null,
  dir: '',
  collapsed: new Set(),
  format: 'all',
  keyword: '',
  minSize: 0,
  minWidth: 0,
  sort: 'numAsc',
  grouped: readStorage('lti.grouped', '0') === '1',
  viewMode: readStorage('lti.viewMode', 'cover'),
  pageLimit: PAGE_SIZE,
  catCounts: null,
  stats: null,
  themeLoaded: false,
  trashRows: [],
  lb: { list: [], pos: -1, zoom: 1, x: 0, y: 0, drag: null },
  gitSyncing: false,
  convert: { running: false, stop: false }
};

function activateView(view) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
}

function switchView(view) {
  activateView(view);
  if (view === 'library') refreshLibrary();
  if (view === 'stats') refreshStats();
}

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

/* ================================================================
 * 3. 上传视图
 * ================================================================ */

const dz = $('dropzone');
const fileInput = $('fileInput');
const folderInput = $('folderInput');

function isImageFile(f) {
  return /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i.test(f.name);
}

function applyUploadDefaults() {
  if (!state.cfg) return;
  const u = state.cfg.upload || {};
  const quality = Number(u.quality) || 95;
  $('optQuality').value = quality;
  $('qualityVal').textContent = quality;
  $('optDuplicate').value = (state.cfg.dedup && state.cfg.dedup.onExactDuplicate) || 'skip';
  $('maxBatch').textContent = u.maxBatchFiles || 200;
  $('maxFileMB').textContent = u.maxFileMB || 60;
  $('linkType').value = state.linkType;
}

/** 点击选择文件 / 文件夹 */
$('btnPickFiles').addEventListener('click', (e) => {
  e.stopPropagation();
  if (state.uploading) return toast('正在上传，请等当前批次结束后再添加', 'warn');
  fileInput.click();
});
$('btnPickFolder').addEventListener('click', (e) => {
  e.stopPropagation();
  if (state.uploading) return toast('正在上传，请等当前批次结束后再添加', 'warn');
  folderInput.click();
});
dz.addEventListener('click', (e) => {
  if (e.target.closest('button')) return;
  if (state.uploading) return toast('正在上传，请等当前批次结束后再添加', 'warn');
  fileInput.click();
});
dz.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    if (!state.uploading) fileInput.click();
  }
});

fileInput.addEventListener('change', () => {
  addFiles([...fileInput.files]);
  fileInput.value = '';
});
folderInput.addEventListener('change', () => {
  const files = [...folderInput.files];
  maybeAutofillTheme(files);
  addFiles(files);
  folderInput.value = '';
});

// 拖拽视觉反馈（真正的 drop 由 window 统一处理）
['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => {
  e.preventDefault();
  dz.classList.add('dragover');
}));
['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, () => dz.classList.remove('dragover')));

// 页面级拖拽：阻止浏览器直接打开图片，并允许拖到任意位置
function hasFileDrag(e) {
  return !!(e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files'));
}
window.addEventListener('dragover', (e) => {
  if (!hasFileDrag(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  if (!state.uploading) $('dropOverlay').hidden = false;
});
window.addEventListener('dragleave', (e) => {
  if (!hasFileDrag(e)) return;
  if (!e.relatedTarget) $('dropOverlay').hidden = true;
});
['dragend', 'blur'].forEach((ev) => window.addEventListener(ev, () => {
  $('dropOverlay').hidden = true;
  dz.classList.remove('dragover');
}));
window.addEventListener('drop', async (e) => {
  if (!hasFileDrag(e)) return;
  e.preventDefault();
  $('dropOverlay').hidden = true;
  dz.classList.remove('dragover');
  if (state.uploading) return toast('正在上传，请等当前批次结束后再添加', 'warn');
  let files = [];
  try { files = await filesFromDataTransfer(e.dataTransfer); }
  catch (err) { toast(`读取拖入文件失败：${err.message}`, 'err'); return; }
  if (!files.length) return;
  maybeAutofillTheme(files);
  const added = addFiles(files);
  if (added > 0) activateView('upload');
});

/** 递归读取拖入的文件夹（Chrome/Edge 的 webkitGetAsEntry） */
async function filesFromDataTransfer(dt) {
  const items = dt.items ? [...dt.items] : [];
  const entries = items
    .map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
    .filter(Boolean);
  if (!entries.length) return [...dt.files];

  const out = [];
  async function walk(entry) {
    if (!entry) return;
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      try {
        Object.defineProperty(file, 'relativePath', { value: String(entry.fullPath || '').replace(/^\//, '') });
      } catch (e) { /* File 不可扩展时忽略，后续用 name */ }
      out.push(file);
      return;
    }
    if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await walk(child);
      }
    }
  }
  for (const entry of entries) await walk(entry);
  return out.length ? out : [...dt.files];
}

/** 文件夹上传时，如果分类选了表情包且主题为空，用顶层文件夹名自动填主题 */
function maybeAutofillTheme(files) {
  if ($('optCategory').value !== 'emoticon' || $('optTheme').value.trim()) return;
  const tops = new Set(files.map((f) => {
    const p = f.relativePath || f.webkitRelativePath || '';
    return p.includes('/') ? p.split('/')[0] : '';
  }).filter(Boolean));
  if (tops.size === 1) {
    const theme = [...tops][0];
    $('optTheme').value = theme;
    toast(`已按文件夹名填入表情包主题：${theme}`, 'ok');
  }
}

/** 把文件加入上传队列（本地预检：类型 / 大小 / 批次上限） */
function addFiles(fileList) {
  if (state.uploading) { toast('正在上传，请等当前批次结束后再添加', 'warn'); return 0; }
  const cfg = state.cfg || {};
  const max = (cfg.upload && cfg.upload.maxBatchFiles) || 200;
  const maxMB = (cfg.upload && cfg.upload.maxFileMB) || 60;
  const maxBytes = maxMB * 1024 * 1024;

  let added = 0, skipped = 0, oversize = 0;
  for (const f of fileList) {
    if (!isImageFile(f)) { skipped += 1; continue; }
    if (f.size > maxBytes) { oversize += 1; continue; }
    if (state.queue.length >= max) { toast(`单批最多 ${max} 张，超出部分已忽略`, 'warn'); break; }
    state.queue.push({
      file: f,
      previewUrl: URL.createObjectURL(f),
      relPath: f.relativePath || f.webkitRelativePath || ''
    });
    added += 1;
  }
  if (skipped) toast(`已跳过 ${skipped} 个非图片文件`, 'warn');
  if (oversize) toast(`已跳过 ${oversize} 个超过 ${maxMB} MB 的文件`, 'warn');
  if (added) renderQueue();
  return added;
}

// 表情包主题自动补全
async function ensureThemes() {
  if (state.themeLoaded) return;
  state.themeLoaded = true;
  try {
    const list = state.libAll.length ? state.libAll : await api('/api/images');
    if (!state.libAll.length) state.libAll = list;
    updateThemeDatalist();
  } catch (e) {
    state.themeLoaded = false;
  }
}

function updateThemeDatalist() {
  const themes = [...new Set(
    state.libAll
      .filter((r) => r.category === 'emoticon')
      .map((r) => r.rel.split('/')[1])
      .filter(Boolean)
  )].sort((a, b) => a.localeCompare(b));
  $('themeList').innerHTML = themes.map((t) => `<option value="${escapeHtml(t)}"></option>`).join('');
}

$('optCategory').addEventListener('change', () => {
  $('optThemeWrap').hidden = $('optCategory').value !== 'emoticon';
  if ($('optCategory').value === 'emoticon') ensureThemes();
});
$('optQuality').addEventListener('input', () => { $('qualityVal').textContent = $('optQuality').value; });

// 剪贴板粘贴上传
document.addEventListener('paste', (e) => {
  if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
  if (!$('lightbox').hidden) return;
  if ([...document.querySelectorAll('.modal')].some((m) => !m.hidden)) return;
  const files = [...(e.clipboardData ? e.clipboardData.files : [])];
  if (!files.length) return;
  const added = addFiles(files);
  if (added > 0) {
    toast(`已从剪贴板加入 ${added} 张图片`, 'ok');
    activateView('upload');
  }
});

/* ---------------- 上传队列渲染 ---------------- */

function queueStatusTag(item) {
  if (!item.done) return '<span class="tag">待上传</span>';
  const r = item.result || {};
  if (r.status === 'ok') return `<span class="tag ok">已归档 ${escapeHtml(r.assignedName || '')}</span>`;
  if (r.status === 'duplicate') return `<span class="tag dup">库内已有 ${escapeHtml(r.assignedName || '')}</span>`;
  return '<span class="tag fail">失败</span>';
}

function queueItemInner(item, i) {
  const r = item.result || null;
  const statusTag = queueStatusTag(item);
  const catTag = r && r.category
    ? `<span class="tag cat">${escapeHtml(CAT_NAMES[r.category] || r.category)}</span>` : '';
  const dim = r && r.w ? ` · ${r.w}×${r.h}` : '';
  const relPath = item.relPath && item.relPath !== item.file.name
    ? `<div class="cell-path" title="${escapeHtml(item.relPath)}">${escapeHtml(item.relPath)}</div>` : '';

  let notice = '';
  if (r && r.status === 'duplicate') {
    notice = `<div class="qitem-notice">${icon('info', 'sm')} 与库内 ${escapeHtml(r.assignedName || '')} 完全相同，已按策略跳过</div>`;
  } else if (r && r.notice) {
    notice = `<div class="qitem-notice">${escapeHtml(r.notice)}</div>`;
  }
  const err = r && r.status === 'failed' && r.error
    ? `<div class="qitem-err">${escapeHtml(r.error)}</div>` : '';

  const canCopy = r && (r.status === 'ok' || r.status === 'duplicate') && r.url;
  const copyBtn = canCopy
    ? `<button class="icon-btn" type="button" data-copy-url="${escapeHtml(r.url)}" title="复制链接">${icon('copy')}</button>` : '';
  const retryBtn = r && r.status === 'failed'
    ? `<button class="icon-btn" type="button" data-retry="${i}" title="重试这一项">${icon('retry')}</button>` : '';
  const removeBtn = !item.done
    ? `<button class="icon-btn" type="button" data-remove="${i}" title="移出队列" ${state.uploading ? 'disabled' : ''}>${icon('close')}</button>` : '';

  const serverThumb = r && (r.status === 'ok' || r.status === 'duplicate') && r.rel
    ? `/api/thumb?p=${encodeURIComponent(r.rel)}&w=160${r.mtime ? `&v=${Math.round(r.mtime)}` : ''}` : '';
  const thumbSrc = serverThumb || item.previewUrl;
  const thumb = thumbSrc
    ? `<img class="qitem-thumb" loading="lazy" src="${thumbSrc}" alt="" />`
    : `<div class="qitem-thumb qitem-thumb-empty">${icon('image')}</div>`;

  return `${thumb}
    <div class="qitem-main">
      <div class="qitem-name">${escapeHtml(item.file.name)}</div>
      ${relPath}
      <div class="qitem-meta">${statusTag} ${catTag} <span>${fmtSize(item.file.size)}${dim}</span></div>
      ${notice}${err}
    </div>
    <div class="qitem-actions">${copyBtn}${retryBtn}${removeBtn}</div>`;
}

function updateQueueSummary() {
  const q = state.queue;
  const pending = q.filter((it) => !it.done).length;
  const ok = q.filter((it) => it.result && it.result.status === 'ok').length;
  const dup = q.filter((it) => it.result && it.result.status === 'duplicate').length;
  const fail = q.filter((it) => it.result && it.result.status === 'failed').length;
  const totalSize = q.reduce((sum, it) => sum + (it.file.size || 0), 0);
  $('queueSummary').textContent = q.length
    ? `共 ${q.length} 张 · 待上传 ${pending}${ok ? ` · 成功 ${ok}` : ''}${dup ? ` · 重复 ${dup}` : ''}${fail ? ` · 失败 ${fail}` : ''} · ${fmtSize(totalSize)}`
    : '';
}

function updateQueueActionState() {
  const q = state.queue;
  const pending = q.filter((it) => !it.done).length;
  const failed = q.filter((it) => it.done && it.result && it.result.status === 'failed').length;
  const hasLinks = q.some((it) => it.result && (it.result.status === 'ok' || it.result.status === 'duplicate') && it.result.url);

  $('btnUpload').hidden = state.uploading;
  $('btnUpload').disabled = state.uploading || pending === 0;
  $('btnUpload').textContent = '开始上传';
  $('btnStop').hidden = !state.uploading;
  $('btnClearQueue').disabled = state.uploading;
  $('btnRetryFailed').hidden = state.uploading || failed === 0 || pending > 0;
  $('btnCopyBatch').hidden = state.uploading || !hasLinks;
  $('optAutoSync').disabled = state.uploading;
}

function renderQueue() {
  $('queueEmpty').hidden = state.queue.length > 0;
  $('queueActions').hidden = state.queue.length === 0;
  if (!state.queue.length) $('queueProgress').hidden = true;
  $('queueList').innerHTML = state.queue.map((item, i) => `<div class="qitem">${queueItemInner(item, i)}</div>`).join('');
  updateQueueSummary();
  updateQueueActionState();
}

function renderQueueItem(index) {
  const row = $('queueList').children[index];
  const item = state.queue[index];
  if (!row || !item) return;
  row.innerHTML = queueItemInner(item, index);
}

function renderUploadProgress(done, total, ok, dup, fail) {
  const pct = total ? Math.round(done / total * 100) : 0;
  $('queueProgress').hidden = false;
  $('uploadProgressFill').style.width = `${pct}%`;
  $('uploadProgressText').textContent = `${done} / ${total}（${pct}%）`;
  $('uploadProgressStats').textContent = `成功 ${ok} · 重复 ${dup} · 失败 ${fail}`;
}

// 队列事件委托
$('queueList').addEventListener('click', async (e) => {
  const rm = e.target.closest('[data-remove]');
  if (rm) {
    if (state.uploading) return toast('上传过程中不能移出队列', 'warn');
    const i = Number(rm.dataset.remove);
    const it = state.queue[i];
    if (!it) return;
    if (it.previewUrl) URL.revokeObjectURL(it.previewUrl);
    state.queue.splice(i, 1);
    renderQueue();
    return;
  }
  const cp = e.target.closest('[data-copy-url]');
  if (cp) {
    try { await copyText(cp.dataset.copyUrl); toast('链接已复制', 'ok'); }
    catch (err) { toast(err.message, 'err'); }
    return;
  }
  const retry = e.target.closest('[data-retry]');
  if (retry) {
    if (state.uploading) return toast('上传过程中不能重试', 'warn');
    const i = Number(retry.dataset.retry);
    const it = state.queue[i];
    if (!it) return;
    it.done = false;
    it.result = null;
    if (!it.previewUrl) it.previewUrl = URL.createObjectURL(it.file);
    renderQueue();
    toast('已重新加入待上传队列', 'ok');
  }
});

$('btnRetryFailed').addEventListener('click', () => {
  if (state.uploading) return;
  const failed = state.queue.filter((it) => it.done && it.result && it.result.status === 'failed');
  if (!failed.length) return toast('没有失败的文件', 'warn');
  for (const it of failed) {
    it.done = false;
    it.result = null;
    if (!it.previewUrl) it.previewUrl = URL.createObjectURL(it.file);
  }
  renderQueue();
  toast(`已将 ${failed.length} 个失败文件重新加入队列`, 'ok');
});

$('btnClearQueue').addEventListener('click', () => {
  if (state.uploading) return toast('上传过程中不能清空队列', 'warn');
  state.queue.forEach((it) => { if (it.previewUrl) URL.revokeObjectURL(it.previewUrl); });
  state.queue = [];
  $('queueProgress').hidden = true;
  renderQueue();
});

$('btnStop').addEventListener('click', () => {
  if (!state.uploading) return;
  state.uploadStop = true;
  $('btnStop').disabled = true;
  toast('将在当前文件处理完成后停止', 'warn');
});

$('btnCopyBatch').addEventListener('click', async () => {
  const urls = state.queue
    .filter((it) => it.result && (it.result.status === 'ok' || it.result.status === 'duplicate') && it.result.url)
    .map((it) => it.result.url);
  if (!urls.length) return toast('没有可复制的链接', 'warn');
  try { await copyText(urls.join('\n')); toast(`已复制 ${urls.length} 条链接`, 'ok'); }
  catch (e) { toast(e.message, 'err'); }
});

/** 开始上传：逐文件串行提交，逐项刷新状态与整体进度 */
$('btnUpload').addEventListener('click', async () => {
  if (state.uploading) return;
  const pending = state.queue.filter((it) => !it.done);
  if (!pending.length) return toast('队列中没有待上传的文件', 'warn');

  state.uploading = true;
  state.uploadStop = false;
  $('btnStop').disabled = false;
  const total = pending.length;
  let done = 0, okN = 0, dupN = 0, failN = 0;

  const opts = JSON.stringify({
    category: $('optCategory').value,
    theme: $('optTheme').value,
    convert: $('optConvert').value,
    quality: Number($('optQuality').value),
    onDuplicate: $('optDuplicate').value,
    stripMeta: $('optStripMeta').checked,
    linkType: state.linkType
  });

  renderUploadProgress(0, total, 0, 0, 0);
  renderQueue();

  try {
    for (const it of pending) {
      if (state.uploadStop) break;
      const fd = new FormData();
      fd.append('options', opts);
      fd.append('files', it.file, it.file.name);
      try {
        const { results } = await api('/api/upload', { method: 'POST', body: fd });
        it.done = true;
        it.result = results[0] || { status: 'failed', error: '无结果' };
        if (it.result.status === 'ok') okN += 1;
        else if (it.result.status === 'duplicate') dupN += 1;
        else failN += 1;
      } catch (e) {
        it.done = true;
        it.result = { status: 'failed', error: e.message };
        failN += 1;
      }
      if (it.previewUrl && it.result && it.result.status !== 'failed') {
        URL.revokeObjectURL(it.previewUrl);
        it.previewUrl = '';
      }
      done += 1;
      renderQueueItem(state.queue.indexOf(it));
      renderUploadProgress(done, total, okN, dupN, failN);
      updateQueueSummary();
      updateQueueActionState();
    }

    if (state.uploadStop && done < total) {
      toast(`已停止：余下 ${total - done} 张未上传`, 'warn');
    } else {
      toast(`上传完成：成功 ${okN} · 重复 ${dupN} · 失败 ${failN}`, failN ? 'warn' : 'ok');
    }
  } finally {
    state.uploading = false;
    $('btnStop').disabled = false;
    renderQueue();
    refreshGitStatus();
    if ($('optAutoSync').checked && okN > 0) {
      setTimeout(() => runGitSync(true), 400);
    }
  }
});

/* ================================================================
 * 4. 图片库视图
 * ================================================================ */

function dirOf(rel) {
  return String(rel).split('/').slice(0, -1).join('/');
}

function groupKeyOf(row) {
  return dirOf(row.rel) || '根目录';
}

function groupLabelOf(key) {
  if (!key || key === '根目录') return '根目录';
  if (key.startsWith('emoticon/')) return `表情包 · ${key.split('/')[1] || ''}`;
  if (key.startsWith('wallpapers&illustration/')) {
    const c = key.split('/').pop();
    return `${CAT_NAMES[c] || c} · ${c}`;
  }
  return key;
}

function allDirPaths() {
  const set = new Set();
  for (const r of state.libAll) {
    const parts = r.rel.split('/');
    for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join('/'));
  }
  set.delete('');
  return [...set].sort();
}

/** 渲染分类 chips（计数来自全库统计，不随当前筛选变化） */
function renderCatChips() {
  const cats = ['all', 'heng', 'shu', 'avatar', 'emoticon', 'temporary', '其他'];
  const wrap = $('catChips');
  wrap.innerHTML = '';
  const cc = state.catCounts;
  for (const c of cats) {
    const n = c === 'all'
      ? (cc && cc.total ? cc.total.count : state.libAll.length)
      : (cc && cc.byCategory && cc.byCategory[c])
        ? cc.byCategory[c].count
        : state.libAll.filter((r) => r.category === c).length;
    const active = c === 'emoticon'
      ? (state.dir === CHIP_DIR.emoticon || state.dir.startsWith('emoticon/'))
      : state.dir === CHIP_DIR[c];
    if (c !== 'all' && n === 0 && !active) continue;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `chip${active ? ' active' : ''}`;
    chip.setAttribute('aria-pressed', active ? 'true' : 'false');
    chip.textContent = `${CAT_NAMES[c] || c} ${n}`;
    chip.addEventListener('click', () => { if (!active) setDir(CHIP_DIR[c]); });
    wrap.appendChild(chip);
  }
}

function renderFmtOptions() {
  const sel = $('fmtFilter');
  const cur = state.format;
  const fmts = [...new Set(state.libAll.map((r) => r.format))].sort();
  sel.innerHTML = '<option value="all">全部格式</option>' +
    fmts.map((f) => `<option value="${f}">${f.toUpperCase()}</option>`).join('');
  if (!fmts.includes(cur)) state.format = 'all';
  sel.value = state.format;
}

function buildTree(items) {
  const root = { name: '图库根（全部）', path: '', count: 0, children: new Map() };
  for (const it of items) {
    const parts = it.rel.split('/');
    let node = root;
    node.count += 1;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      if (!node.children.has(seg)) {
        node.children.set(seg, {
          name: seg,
          path: node.path ? `${node.path}/${seg}` : seg,
          count: 0,
          children: new Map()
        });
      }
      node = node.children.get(seg);
      node.count += 1;
    }
  }
  return root;
}

function renderTree() {
  const wrap = $('dirTree');
  wrap.innerHTML = '';
  if (!state.libAll.length) {
    wrap.innerHTML = '<div class="tree-row" style="cursor:default">暂无图片</div>';
    return;
  }
  renderTreeNode(wrap, buildTree(state.libAll));
}

function renderTreeNode(container, node) {
  const item = document.createElement('div');
  item.appendChild(makeTreeRow(node));
  if (node.children.size && !state.collapsed.has(node.path)) {
    const sub = document.createElement('div');
    sub.className = 'tree-children';
    for (const kid of [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      renderTreeNode(sub, kid);
    }
    item.appendChild(sub);
  }
  container.appendChild(item);
}

function makeTreeRow(node) {
  const row = document.createElement('div');
  row.className = `tree-row${state.dir === node.path ? ' active' : ''}`;
  const hasKids = node.children && node.children.size > 0;
  const collapsed = state.collapsed.has(node.path);

  const arrow = document.createElement('button');
  arrow.type = 'button';
  arrow.className = `tree-arrow-btn${hasKids ? (collapsed ? '' : ' open') : ' leaf'}`;
  arrow.title = hasKids ? (collapsed ? '展开' : '折叠') : '';
  arrow.setAttribute('aria-label', hasKids ? (collapsed ? '展开 ' : '折叠 ') + node.name : '');
  arrow.tabIndex = hasKids ? 0 : -1;
  arrow.innerHTML = icon('chevron', 'sm');

  const iconEl = document.createElement('span');
  iconEl.className = 'tree-icon';
  iconEl.innerHTML = icon('folder', 'sm');

  const name = document.createElement('span');
  name.className = 'tree-name';
  name.textContent = node.name;
  name.title = node.path || '图库根（全部图片）';

  const count = document.createElement('span');
  count.className = 'tree-count';
  count.textContent = node.count;

  row.append(arrow, iconEl, name, count);
  row.setAttribute('role', 'button');
  row.tabIndex = 0;
  if (state.dir === node.path) row.setAttribute('aria-current', 'true');

  const activate = () => { if (state.dir !== node.path) setDir(node.path); };
  row.addEventListener('click', (e) => { if (!e.target.closest('.tree-arrow-btn')) activate(); });
  row.addEventListener('keydown', (e) => {
    if (e.target !== row) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
  });
  if (hasKids) {
    const toggle = (e) => {
      e.stopPropagation();
      if (state.collapsed.has(node.path)) state.collapsed.delete(node.path);
      else state.collapsed.add(node.path);
      renderTree();
    };
    arrow.addEventListener('click', toggle);
    arrow.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e); }
    });
  }
  return row;
}

function setDir(dir) {
  state.dir = dir;
  state.pageLimit = PAGE_SIZE;
  renderTree();
  renderCatChips();
  applyFilters();
}

function hasActiveFilters() {
  return !!(state.dir || state.format !== 'all' || state.keyword || state.minSize || state.minWidth);
}

function updateFilterControls() {
  $('fmtFilter').value = state.format;
  $('sizeFilter').value = String(state.minSize);
  $('widthFilter').value = String(state.minWidth);
  $('sortSel').value = state.sort;
  if ($('searchBox').value !== state.keyword) $('searchBox').value = state.keyword;
  $('btnClearFilters').hidden = !hasActiveFilters();
  $('btnGroup').setAttribute('aria-pressed', state.grouped ? 'true' : 'false');
  $('btnGroup').classList.toggle('active-chip', state.grouped);
  $('btnViewMode').querySelector('span').textContent = state.viewMode === 'cover' ? '完整显示' : '裁剪显示';
}

function clearFilters() {
  state.dir = '';
  state.format = 'all';
  state.keyword = '';
  state.minSize = 0;
  state.minWidth = 0;
  state.pageLimit = PAGE_SIZE;
  renderTree();
  renderCatChips();
  renderFmtOptions();
  applyFilters();
}

/** 本地过滤 + 排序 */
function applyFilters() {
  const d = state.dir;
  const kw = state.keyword.toLowerCase();
  const rows = state.libAll.filter((r) => {
    if (d === '__other__') { if (r.category !== '其他') return false; }
    else if (d && !(r.rel === d || r.rel.startsWith(d + '/'))) return false;
    if (state.format !== 'all' && r.format !== state.format) return false;
    if (kw && !r.rel.toLowerCase().includes(kw) && !r.name.toLowerCase().includes(kw)) return false;
    if (state.minSize && !(r.size >= state.minSize)) return false;
    if (state.minWidth && !((r.w || 0) >= state.minWidth)) return false;
    return true;
  });

  const CAT_ORDER = { heng: 0, shu: 1, avatar: 2, emoticon: 3, temporary: 4, '其他': 5 };
  const numOf = (name) => { const m = String(name).match(/\d+/); return m ? Number(m[0]) : NaN; };
  const isTime = state.sort.startsWith('time');

  if (state.sort === 'sizeDesc') {
    rows.sort((a, b) => (b.size || 0) - (a.size || 0));
  } else {
    rows.sort((a, b) => {
      if (isTime) return a.mtime - b.mtime;
      const ca = CAT_ORDER[a.category] ?? 99, cb = CAT_ORDER[b.category] ?? 99;
      if (ca !== cb) return ca - cb;
      // 先按目录/主题分组，避免不同主题的 001 交错在一起
      const da = dirOf(a.rel), db = dirOf(b.rel);
      if (da !== db) return da.localeCompare(db);
      const na = numOf(a.name), nb = numOf(b.name);
      const va = Number.isNaN(na) ? Infinity : na;
      const vb = Number.isNaN(nb) ? Infinity : nb;
      if (va !== vb) return va - vb;
      return String(a.name).localeCompare(String(b.name));
    });
  }
  if (state.sort.endsWith('Desc') && state.sort !== 'sizeDesc') rows.reverse();

  state.lib = rows;
  // 只保留仍在当前结果中的选中项：排序不丢选区，筛选只丢弃不可见项
  const visible = new Set(rows.map((r) => r.rel));
  state.selected = new Set([...state.selected].filter((rel) => visible.has(rel)));
  if (state.lastClicked && !visible.has(state.lastClicked)) state.lastClicked = null;
  state.pageLimit = PAGE_SIZE;
  updateFilterControls();
  renderGrid();
}

function cellHtml(row) {
  const sel = state.selected.has(row.rel);
  const dir = dirOf(row.rel);
  const pathLabel = state.dir && dir === state.dir ? '' : dir.replace('wallpapers&illustration/', '');
  const dim = row.w && row.h ? `${row.w}×${row.h}` : '';
  const label = `${row.name}，${CAT_NAMES[row.category] || row.category}，${sel ? '已选择' : '未选择'}。回车预览，空格选择`;
  return `<div class="cell${sel ? ' selected' : ''}" data-rel="${escapeHtml(row.rel)}" data-name="${escapeHtml(row.name)}"
      role="button" tabindex="0" aria-label="${escapeHtml(label)}">
    <button class="cell-check${sel ? ' checked' : ''}" type="button" data-check="1" tabindex="-1"
      aria-label="${sel ? '取消选择' : '选择'} ${escapeHtml(row.name)}">${icon('check')}</button>
    <button class="cell-open" type="button" data-preview="1" tabindex="-1" title="预览大图">${icon('expand')}</button>
    <img class="cell-img" loading="lazy" alt="${escapeHtml(row.name)}"
      src="/api/thumb?p=${encodeURIComponent(row.rel)}&w=360&v=${Math.round(row.mtime || 0)}" />
    <div class="cell-info">
      <div class="cell-name" title="${escapeHtml(row.rel)}">${escapeHtml(row.name)}</div>
      <div class="cell-path" title="${escapeHtml(dir)}">${escapeHtml(pathLabel)}</div>
      <div class="cell-meta"><span>${escapeHtml(CAT_NAMES[row.category] || row.category)}</span><span>${dim} · ${fmtSize(row.size)}</span></div>
    </div>
  </div>`;
}

function renderGrid() {
  const grid = $('libGrid');
  grid.classList.toggle('contain', state.viewMode === 'contain');
  const grouped = state.grouped && !state.dir;
  const total = state.lib.length;
  // 分组模式一次性渲染全部（分组浏览的目的是看到完整分类）；平铺模式分页，避免大库首屏卡顿
  const rows = grouped ? state.lib : state.lib.slice(0, state.pageLimit);

  $('libCount').textContent = `${total} 张${!grouped && total > rows.length ? `（已显示 ${rows.length}）` : ''}`;
  $('libEmpty').hidden = total > 0;
  $('libMore').hidden = grouped || rows.length >= total;
  if (!grouped && rows.length < total) $('btnLoadMore').textContent = `加载更多（剩余 ${total - rows.length} 张）`;

  if (!total) {
    grid.innerHTML = '';
    updateBulkbar();
    return;
  }

  let html = '';
  if (grouped) {
    const groups = new Map();
    for (const r of rows) {
      const k = groupKeyOf(r);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    for (const [k, items] of groups) {
      html += `<section class="grid-group">
        <div class="grid-group-head"><span>${escapeHtml(groupLabelOf(k))}</span><span class="muted">${items.length} 张</span></div>
        <div class="grid-inner">${items.map(cellHtml).join('')}</div>
      </section>`;
    }
  } else {
    html = `<div class="grid-inner">${rows.map(cellHtml).join('')}</div>`;
  }
  grid.innerHTML = html;
  updateBulkbar();
}

function updateBulkbar() {
  $('bulkbar').hidden = state.selected.size === 0;
  $('selCount').textContent = state.selected.size;
}

function syncGridSelection() {
  document.querySelectorAll('#libGrid .cell').forEach((cell) => {
    const rel = cell.dataset.rel;
    const sel = state.selected.has(rel);
    cell.classList.toggle('selected', sel);
    cell.setAttribute('aria-label',
      `${cell.dataset.name || rel}，${sel ? '已选择' : '未选择'}。回车预览，空格选择`);
    const check = cell.querySelector('.cell-check');
    if (check) {
      check.classList.toggle('checked', sel);
      check.setAttribute('aria-label', `${sel ? '取消选择' : '选择'} ${cell.dataset.name || rel}`);
    }
  });
}

function toggleSelect(rel, opts = {}) {
  if (opts.shift && state.lastClicked) {
    const rels = state.lib.map((r) => r.rel);
    const a = rels.indexOf(state.lastClicked);
    const b = rels.indexOf(rel);
    if (a >= 0 && b >= 0) {
      const [start, end] = a < b ? [a, b] : [b, a];
      for (let i = start; i <= end; i++) state.selected.add(rels[i]);
    } else if (state.selected.has(rel)) {
      state.selected.delete(rel);
    } else {
      state.selected.add(rel);
    }
  } else if (state.selected.has(rel)) {
    state.selected.delete(rel);
  } else {
    state.selected.add(rel);
  }
  state.lastClicked = rel;
  syncGridSelection();
  updateBulkbar();
}

function selectAllVisible() {
  state.lib.forEach((r) => state.selected.add(r.rel));
  syncGridSelection();
  updateBulkbar();
}

function clearSelection() {
  state.selected.clear();
  state.lastClicked = null;
  syncGridSelection();
  updateBulkbar();
}

function selRels() { return [...state.selected]; }

// 网格事件委托：勾选按钮 = 多选；其余点击 = 预览；Ctrl/Shift 点击 = 多选
$('libGrid').addEventListener('click', (e) => {
  const cell = e.target.closest('.cell');
  if (!cell) return;
  const rel = cell.dataset.rel;
  if (e.target.closest('[data-check]')) {
    e.stopPropagation();
    toggleSelect(rel, { shift: e.shiftKey });
    return;
  }
  if (e.target.closest('[data-preview]')) {
    openLightbox(rel);
    return;
  }
  if (e.ctrlKey || e.metaKey || e.shiftKey) {
    e.preventDefault();
    toggleSelect(rel, { shift: e.shiftKey });
    return;
  }
  openLightbox(rel);
});

// 网格键盘：方向键移动、空格选择、回车预览、Delete 删除
$('libGrid').addEventListener('keydown', (e) => {
  const cell = e.target.closest('.cell');
  if (!cell) return;
  const cells = [...$('libGrid').querySelectorAll('.cell')];
  const idx = cells.indexOf(cell);
  const rel = cell.dataset.rel;

  if (e.key === ' ' || e.key === 'Spacebar') {
    e.preventDefault();
    toggleSelect(rel, { shift: e.shiftKey });
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    openLightbox(rel);
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    trashPaths(state.selected.size ? selRels() : [rel]);
    return;
  }
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
  e.preventDefault();
  let next = idx;
  if (e.key === 'ArrowLeft') next = idx - 1;
  else if (e.key === 'ArrowRight') next = idx + 1;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = cells.length - 1;
  else {
    const inner = cell.closest('.grid-inner');
    const cols = inner
      ? getComputedStyle(inner).gridTemplateColumns.split(' ').filter(Boolean).length
      : 1;
    next = idx + (e.key === 'ArrowUp' ? -cols : cols);
  }
  const target = cells[Math.max(0, Math.min(cells.length - 1, next))];
  if (target) target.focus();
});

// 工具栏事件
$('fmtFilter').addEventListener('change', () => { state.format = $('fmtFilter').value; applyFilters(); });
$('sizeFilter').addEventListener('change', () => { state.minSize = Number($('sizeFilter').value) || 0; applyFilters(); });
$('widthFilter').addEventListener('change', () => { state.minWidth = Number($('widthFilter').value) || 0; applyFilters(); });
$('sortSel').addEventListener('change', () => { state.sort = $('sortSel').value; applyFilters(); });
$('searchBox').addEventListener('input', debounce(() => {
  state.keyword = $('searchBox').value.trim();
  applyFilters();
}));
$('btnClearFilters').addEventListener('click', clearFilters);
$('btnEmptyClear').addEventListener('click', clearFilters);

$('btnViewMode').addEventListener('click', () => {
  state.viewMode = state.viewMode === 'cover' ? 'contain' : 'cover';
  writeStorage('lti.viewMode', state.viewMode);
  renderGrid();
  updateFilterControls();
});
$('btnGroup').addEventListener('click', () => {
  state.grouped = !state.grouped;
  writeStorage('lti.grouped', state.grouped ? '1' : '0');
  renderGrid();
  updateFilterControls();
});
$('btnLoadMore').addEventListener('click', () => {
  state.pageLimit += PAGE_SIZE;
  renderGrid();
});
$('btnTreeToggle').addEventListener('click', () => {
  const dirs = allDirPaths();
  const allCollapsed = dirs.length > 0 && dirs.every((d) => state.collapsed.has(d));
  if (allCollapsed) state.collapsed.clear();
  else dirs.forEach((d) => state.collapsed.add(d));
  renderTree();
});

$('btnSelAll').addEventListener('click', selectAllVisible);
$('btnSelectAllTop').addEventListener('click', selectAllVisible);
$('btnSelNone').addEventListener('click', clearSelection);

/* ================================================================
 * 5. 灯箱
 * ================================================================ */

let lbLastFocus = null;

function previewUrl(rel, w = 1800) {
  const row = state.libAll.find((r) => r.rel === rel);
  const v = row && row.mtime ? `&v=${Math.round(row.mtime)}` : '';
  return `/api/thumb?p=${encodeURIComponent(rel)}&w=${w}${v}`;
}

function rawUrl(rel) {
  return `/api/raw?p=${encodeURIComponent(rel)}`;
}

function openLightbox(rel) {
  const list = state.lib.map((r) => r.rel);
  const pos = list.indexOf(rel);
  if (pos < 0) {
    // 不在当前筛选结果中（例如从统计页跳转）时，补进导航列表
    list.unshift(rel);
  }
  lbLastFocus = document.activeElement;
  state.lb = { list, pos: Math.max(0, list.indexOf(rel)), zoom: 1, x: 0, y: 0, drag: null };
  $('lightbox').hidden = false;
  syncOverlayLock();
  renderLightbox();
  setTimeout(() => $('lbClose').focus(), 0);
}

function closeLightbox() {
  $('lightbox').hidden = true;
  $('lbImg').src = '';
  syncOverlayLock();
  if (lbLastFocus && lbLastFocus.isConnected && lbLastFocus.focus) lbLastFocus.focus();
}

function lbStep(delta) {
  if (!state.lb.list.length) return;
  state.lb.pos = (state.lb.pos + delta + state.lb.list.length) % state.lb.list.length;
  state.lb.zoom = 1;
  state.lb.x = 0;
  state.lb.y = 0;
  renderLightbox();
}

function renderLightbox() {
  const rel = state.lb.list[state.lb.pos];
  if (!rel) return;
  const row = state.libAll.find((r) => r.rel === rel) || {};
  $('lbImg').src = previewUrl(rel);
  $('lbImg').alt = row.name || rel;
  $('lbTitle').textContent = row.name || rel;
  $('lbPath').textContent = rel;
  $('lbMeta').textContent =
    `${state.lb.pos + 1}/${state.lb.list.length}` +
    ` · ${CAT_NAMES[row.category] || row.category || ''}` +
    `${row.w ? ` · ${row.w}×${row.h}` : ''}${row.size ? ` · ${fmtSize(row.size)}` : ''}`;

  applyLbTransform();
  // 预加载前后各一张，翻页不闪白
  [-1, 1].forEach((d) => {
    const r = state.lb.list[(state.lb.pos + d + state.lb.list.length) % state.lb.list.length];
    if (r && r !== rel) { const img = new Image(); img.src = previewUrl(r); }
  });
}

function applyLbTransform() {
  const lb = state.lb;
  if (lb.zoom <= 1) { lb.zoom = 1; lb.x = 0; lb.y = 0; }
  $('lbImg').style.transform = `translate(${lb.x}px, ${lb.y}px) scale(${lb.zoom})`;
  $('lbStage').classList.toggle('zoomed', lb.zoom > 1);
  $('lbZoomReset').textContent = `${Math.round(lb.zoom * 100)}%`;
}

function lbZoom(factor) {
  state.lb.zoom = Math.max(1, Math.min(5, state.lb.zoom * factor));
  if (state.lb.zoom === 1) { state.lb.x = 0; state.lb.y = 0; }
  applyLbTransform();
}

function lbResetZoom() {
  state.lb.zoom = 1;
  state.lb.x = 0;
  state.lb.y = 0;
  applyLbTransform();
}

$('lbPrev').addEventListener('click', () => lbStep(-1));
$('lbNext').addEventListener('click', () => lbStep(1));
$('lbClose').addEventListener('click', closeLightbox);
$('lbZoomIn').addEventListener('click', () => lbZoom(1.25));
$('lbZoomOut').addEventListener('click', () => lbZoom(0.8));
$('lbZoomReset').addEventListener('click', lbResetZoom);
$('lightbox').addEventListener('click', (e) => { if (e.target === $('lightbox')) closeLightbox(); });

$('lbStage').addEventListener('wheel', (e) => {
  if ($('lightbox').hidden) return;
  e.preventDefault();
  lbZoom(e.deltaY < 0 ? 1.12 : 0.89);
}, { passive: false });

$('lbStage').addEventListener('pointerdown', (e) => {
  if (state.lb.zoom <= 1 || e.button !== 0) return;
  state.lb.drag = { startX: e.clientX, startY: e.clientY, x: state.lb.x, y: state.lb.y };
  $('lbStage').classList.add('dragging');
  $('lbStage').setPointerCapture(e.pointerId);
});
$('lbStage').addEventListener('pointermove', (e) => {
  const d = state.lb.drag;
  if (!d) return;
  state.lb.x = d.x + (e.clientX - d.startX);
  state.lb.y = d.y + (e.clientY - d.startY);
  applyLbTransform();
});
['pointerup', 'pointercancel'].forEach((ev) => $('lbStage').addEventListener(ev, () => {
  state.lb.drag = null;
  $('lbStage').classList.remove('dragging');
}));

$('lbCopy').addEventListener('click', async () => {
  const rel = state.lb.list[state.lb.pos];
  if (!rel) return;
  try {
    const b = await api(`/api/link?p=${encodeURIComponent(rel)}&type=${state.linkType}`);
    await copyText(b.url);
    toast('链接已复制', 'ok');
  } catch (e) { toast(e.message, 'err'); }
});

$('lbDownload').addEventListener('click', () => {
  const rel = state.lb.list[state.lb.pos];
  if (!rel) return;
  const row = state.libAll.find((r) => r.rel === rel);
  const a = document.createElement('a');
  a.href = rawUrl(rel);
  a.download = row ? row.name : rel.split('/').pop();
  document.body.appendChild(a);
  a.click();
  a.remove();
});
$('lbOpen').addEventListener('click', () => {
  const rel = state.lb.list[state.lb.pos];
  if (rel) window.open(rawUrl(rel), '_blank', 'noopener');
});

$('lbTrash').addEventListener('click', async () => {
  const rel = state.lb.list[state.lb.pos];
  if (!rel) return;
  const ok = await confirmDialog({
    title: '移入回收站',
    message: `将 ${rel} 移入回收站？`,
    detail: '文件不会立即删除，可在回收站恢复。',
    okText: '移入回收站'
  });
  if (!ok) return;
  const res = await trashPaths([rel], { confirm: false });
  if (!res || res.ok === 0) return;
  state.lb.list.splice(state.lb.pos, 1);
  if (!state.lb.list.length) closeLightbox();
  else {
    state.lb.pos %= state.lb.list.length;
    state.lb.zoom = 1;
    $('lbImg').src = '';
    renderLightbox();
  }
  refreshLibrary();
});

/* ================================================================
 * 6. 批量操作
 * ================================================================ */

function undoTrashBatch(batchId) {
  return api('/api/trash/restore-batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ batchId })
  }).then(({ results }) => {
    const okN = results.filter((r) => !r.error).length;
    const renN = results.filter((r) => r.renamed).length;
    toast(`已撤销删除：恢复 ${okN}/${results.length} 项${renN ? `（${renN} 项因编号占用改号）` : ''}`, 'ok');
    refreshLibrary();
    refreshGitStatus();
    if (!$('trashPanel').hidden) loadTrash();
  }).catch((e) => toast(`撤销失败：${e.message}`, 'err'));
}

/** 软删除一组路径，成功后提供“撤销” */
async function trashPaths(rels, opts = {}) {
  if (!rels.length) return null;
  if (opts.confirm !== false) {
    const ok = await confirmDialog({
      title: '移入回收站',
      message: `将选中的 ${rels.length} 张图片移入回收站？`,
      detail: '可以随时在回收站恢复；不会直接删除文件。',
      okText: '移入回收站'
    });
    if (!ok) return null;
  }
  try {
    const r = await api('/api/trash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: rels })
    });
    const failed = r.moved.filter((m) => m.error);
    const okN = r.moved.length - failed.length;
    if (failed.length) {
      showResult('移入回收站结果', failed.map((m) => ({ status: 'fail', title: m.rel, note: m.error })));
    }
    toast(
      `已移入回收站 ${okN} 张${failed.length ? `，失败 ${failed.length} 张` : ''}`,
      failed.length ? 'warn' : 'ok',
      okN ? { action: { label: '撤销', onClick: () => undoTrashBatch(r.batchId) }, duration: 12000 } : {}
    );
    refreshLibrary();
    refreshGitStatus();
    if (!$('trashPanel').hidden) loadTrash();
    return { ok: okN, fail: failed.length, result: r };
  } catch (e) {
    toast(e.message, 'err');
    return null;
  }
}

/* ---------------- 批量复制 / 导出 ---------------- */

$('btnTrashSel').addEventListener('click', () => {
  if (!state.selected.size) return toast('请先选择图片', 'warn');
  trashPaths(selRels());
});

$('btnCopySel').addEventListener('click', async () => {
  if (!state.selected.size) return toast('请先选择图片', 'warn');
  const fmt = $('copyFmt').value;
  try {
    const { text } = await api('/api/links/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: selRels(), linkType: state.linkType, format: fmt })
    });
    await copyText(text);
    const names = { txt: '纯链接', markdown: 'Markdown', html: 'HTML', bbcode: 'BBCode' };
    toast(`已复制 ${state.selected.size} 条${names[fmt] || ''}链接`, 'ok');
  } catch (e) { toast(e.message, 'err'); }
});

$('btnExportSel').addEventListener('click', () => {
  if (!state.selected.size) return toast('请先选择图片', 'warn');
  const linkLabel = $('linkType').selectedOptions[0]?.textContent || state.linkType;
  $('exportInfo').textContent = `将导出 ${state.selected.size} 条链接，链接类型：${linkLabel}`;
  openModal('exportPanel');
});

$('btnExportConfirm').addEventListener('click', async () => {
  if (!state.selected.size) return;
  const fmt = $('exportFormat').value;
  try {
    const { text, count } = await api('/api/links/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: selRels(), linkType: state.linkType, format: fmt })
    });
    const ext = { txt: 'txt', json: 'json', csv: 'csv', markdown: 'md' }[fmt] || 'txt';
    downloadText(`图床链接_${new Date().toISOString().slice(0, 10)}.${ext}`, text);
    closeModal('exportPanel');
    toast(`已导出 ${count} 条链接`, 'ok');
  } catch (e) { toast(e.message, 'err'); }
});

/* ---------------- 移动分类 ---------------- */

function updateMovePreview() {
  const cat = $('moveCategory').value;
  $('moveThemeWrap').hidden = cat !== 'emoticon';
  let target;
  if (cat === 'emoticon') target = `emoticon/${sanitizeTheme($('moveTheme').value)}`;
  else if (cat === 'temporary') target = 'wallpapers&illustration/temporary';
  else target = `wallpapers&illustration/${cat}`;
  $('movePreview').innerHTML =
    `${icon('info', 'sm')}<span>目标目录：<b>${escapeHtml(target)}</b></span>`;
}

$('btnMoveSel').addEventListener('click', () => {
  if (!state.selected.size) return toast('请先选择图片', 'warn');
  $('moveInfo').textContent = `已选 ${state.selected.size} 张图片。移动后会在目标目录内续排编号。`;
  // 默认选一个与当前选中项不同的分类，避免"原地移动"造成无意义改号
  const cats = new Set(selRels().map((rel) => {
    const row = state.libAll.find((r) => r.rel === rel);
    return row ? row.category : '';
  }));
  const order = ['heng', 'shu', 'avatar', 'temporary', 'emoticon'];
  const pick = order.find((c) => !cats.has(c)) || 'avatar';
  $('moveCategory').value = pick;
  updateMovePreview();
  openModal('movePanel');
});
$('moveCategory').addEventListener('change', updateMovePreview);
$('moveTheme').addEventListener('input', updateMovePreview);

$('btnMoveConfirm').addEventListener('click', async () => {
  if (!state.selected.size) return;
  const category = $('moveCategory').value;
  const theme = $('moveTheme').value;
  if (category === 'emoticon' && !sanitizeTheme(theme)) return;
  const target = category === 'emoticon'
    ? `emoticon/${sanitizeTheme(theme)}`
    : category === 'temporary'
      ? 'wallpapers&illustration/temporary'
      : `wallpapers&illustration/${category}`;
  const ok = await confirmDialog({
    title: '移动分类',
    message: `把 ${state.selected.size} 张图片移动到「${target}」？`,
    detail: '目标目录内按最大编号续排；移动后旧链接会失效。',
    okText: '移动'
  });
  if (!ok) return;
  try {
    const { results, movedCount } = await api('/api/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: selRels(), category, theme })
    });
    closeModal('movePanel');
    const fails = results.filter((r) => !r.ok || r.error);
    if (fails.length) {
      showResult('移动分类结果', results.map((r) => r.error || !r.ok
        ? { status: 'fail', title: r.rel, note: r.error || '移动失败，批次已回滚' }
        : { status: 'ok', title: r.rel, note: `→ ${r.newRel}` }));
    } else {
      toast(`已移动 ${movedCount} 张`, 'ok');
    }
    refreshLibrary();
    refreshGitStatus();
  } catch (e) { toast(e.message, 'err'); }
});

/* ---------------- 格式转换 ---------------- */

function renderConvertResult(rel, r) {
  const box = $('convertResults');
  const row = [...box.children].find((el) => el.dataset.rel === rel);
  if (!row) return;
  let status = 'ok', tagCls = 'ok', label = '成功';
  let note = '';
  if (!r || r.ok === false) {
    status = 'fail'; tagCls = 'fail'; label = '失败';
    note = (r && r.error) || '未知错误';
  } else if (r.skipped) {
    status = 'skip'; tagCls = 'dup'; label = '跳过';
    note = r.notice || '已跳过';
  } else {
    note = `→ ${r.newRel || r.rel}${r.trashed ? '（原图已移入回收站）' : ''}${r.notice ? ` · ${r.notice}` : ''}`;
  }
  row.className = `result-row ${status}`;
  row.innerHTML = `<span class="tag ${tagCls}">${label}</span>
    <div class="result-main"><div class="result-name">${escapeHtml(rel)}</div>
    <div class="result-note">${escapeHtml(note)}</div></div>`;
}

$('btnConvertSel').addEventListener('click', () => {
  if (!state.selected.size) return toast('请先选择图片', 'warn');
  if (state.convert.running) return toast('已有转换任务正在进行中', 'warn');
  const q = Number(state.cfg?.upload?.quality) || 95;
  $('convertInfo').textContent = `已选 ${state.selected.size} 张图片。转换会生成新文件，原图按下方选项处理。`;
  $('convertQuality').value = q;
  $('convertQualityVal').textContent = q;
  $('convertReplace').checked = false;
  $('convertAnimated').checked = false;
  $('convertResults').innerHTML = '';
  $('convertProgress').hidden = true;
  $('btnConvertStart').disabled = false;
  $('btnConvertStart').textContent = '开始转换';
  $('btnConvertStop').hidden = true;
  state.convert.running = false;
  state.convert.stop = false;
  openModal('convertPanel');
});

$('convertQuality').addEventListener('input', () => {
  $('convertQualityVal').textContent = $('convertQuality').value;
});

$('btnConvertStop').addEventListener('click', () => {
  if (!state.convert.running) return;
  state.convert.stop = true;
  $('btnConvertStop').disabled = true;
  toast('将在当前文件完成后停止转换', 'warn');
});

$('btnConvertStart').addEventListener('click', async () => {
  if (state.convert.running) return;
  const rels = selRels();
  if (!rels.length) return toast('请先选择图片', 'warn');

  state.convert.running = true;
  state.convert.stop = false;
  $('btnConvertStart').disabled = true;
  $('btnConvertStart').textContent = '转换中…';
  $('btnConvertStop').hidden = false;
  $('btnConvertStop').disabled = false;
  $('convertProgress').hidden = false;
  $('convertResults').innerHTML = rels.map((rel) =>
    `<div class="result-row pending" data-rel="${escapeHtml(rel)}"><span class="tag">处理中</span>
      <div class="result-main"><div class="result-name">${escapeHtml(rel)}</div></div></div>`).join('');

  const target = $('convertTarget').value;
  const quality = Number($('convertQuality').value) || 100;
  const replaceOriginal = $('convertReplace').checked;
  const allowAnimatedLoss = $('convertAnimated').checked;

  let done = 0, okN = 0, skipN = 0, failN = 0;
  try {
    for (const rel of rels) {
      if (state.convert.stop) break;
      try {
        const { results } = await api('/api/convert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            paths: [rel], target, quality, replaceOriginal, allowAnimatedLoss,
            linkType: state.linkType
          })
        });
        const r = results[0] || { rel, ok: false, error: '无结果' };
        renderConvertResult(rel, r);
        if (!r.ok) failN += 1;
        else if (r.skipped) skipN += 1;
        else okN += 1;
      } catch (e) {
        renderConvertResult(rel, { ok: false, error: e.message });
        failN += 1;
      }
      done += 1;
      $('convertProgressFill').style.width = `${Math.round(done / rels.length * 100)}%`;
      $('convertProgressText').textContent = `${done} / ${rels.length}`;
      $('convertProgressStats').textContent = `成功 ${okN} · 跳过 ${skipN} · 失败 ${failN}`;
    }
    if (state.convert.stop && done < rels.length) {
      toast(`已停止：余下 ${rels.length - done} 张未处理`, 'warn');
    } else {
      toast(`转换完成：成功 ${okN} · 跳过 ${skipN} · 失败 ${failN}`, failN ? 'warn' : 'ok');
    }
  } finally {
    state.convert.running = false;
    $('btnConvertStart').disabled = false;
    $('btnConvertStart').textContent = '再次转换';
    $('btnConvertStop').hidden = true;
    refreshLibrary();
    refreshGitStatus();
  }
});

/* ================================================================
 * 7. 查重 / 回收站 / 整理
 * ================================================================ */

/* ---------------- 查重 ---------------- */

$('btnDupScan').addEventListener('click', async () => {
  openModal('dupPanel');
  $('dupMeta').textContent = '';
  $('dupBody').setAttribute('aria-busy', 'true');
  $('dupBody').innerHTML = `<div class="empty">
    <div class="skeleton" style="width:42px;height:42px;border-radius:50%"></div>
    <div>正在扫描（首次全量需计算全部图片指纹）…</div></div>`;
  try {
    const r = await api('/api/duplicates/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deep: true })
    });
    $('dupMeta').textContent =
      `已扫描 ${r.scanned} 张 · 完全重复组 ${r.exactGroups.length} · 相似组 ${r.similarGroups.length}` +
      (r.ignoredPairs ? ` · 已忽略 ${r.ignoredPairs} 张` : '');
    // 关键：先清空“正在扫描”占位，避免加载文案与结果同时显示
    $('dupBody').innerHTML = '';
    $('dupBody').removeAttribute('aria-busy');
    renderDupGroups(r.exactGroups, '完全重复（字节级相同）');
    renderDupGroups(r.similarGroups, '疑似相似（感知哈希）', true);
    if (!r.exactGroups.length && !r.similarGroups.length) {
      $('dupBody').insertAdjacentHTML('beforeend', '<div class="empty">未发现重复或相似图片</div>');
    }
    if (r.ignoredPairs > 0) await appendIgnoredSection();
  } catch (e) {
    $('dupBody').removeAttribute('aria-busy');
    $('dupBody').innerHTML = `<div class="empty">扫描失败：${escapeHtml(e.message)}</div>`;
  }
});

async function appendIgnoredSection() {
  let ignored;
  try { ignored = await api('/api/duplicates/ignored'); }
  catch (e) { return; }
  if (!ignored.items.length) return;

  const collapsed = ignored.items.length > 12;
  const sec = document.createElement('div');
  sec.className = 'dup-group ignored-sec';
  sec.id = 'dupIgnoredSec';
  sec.innerHTML = `
    <div class="dup-group-title">
      <span class="tag">已忽略</span> ${ignored.items.length} 张
      <span class="muted">（不再参与相似归组；取消忽略后下次扫描生效）</span>
      <span class="flex-sp"></span>
      <button class="btn small ghost" type="button" id="btnToggleIgnored">
        ${collapsed ? '展开' : '收起'}
      </button>
    </div>
    <div class="dup-row ignored-list${collapsed ? ' collapsed' : ''}">
      ${ignored.items.map((it) => `
        <div class="dup-item">
          <img loading="lazy" src="/api/thumb?p=${encodeURIComponent(it.rel)}&w=264" alt="" />
          <div class="name" title="${escapeHtml(it.rel)}">${escapeHtml(it.name)}</div>
          <div class="muted">${it.sizeText || ''}</div>
          <button class="btn small" type="button" data-unignore="${escapeHtml(it.rel)}">取消忽略</button>
        </div>`).join('')}
    </div>`;

  sec.querySelector('#btnToggleIgnored').addEventListener('click', (e) => {
    const list = sec.querySelector('.ignored-list');
    const hide = !list.classList.toggle('collapsed');
    e.currentTarget.textContent = hide ? '收起' : '展开';
  });

  sec.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-unignore]');
    if (!btn) return;
    try {
      await api('/api/duplicates/unignore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: [btn.dataset.unignore] })
      });
      toast('已取消忽略，下次查重扫描将重新参与归组', 'ok');
      btn.closest('.dup-item').remove();
      if (!sec.querySelectorAll('.dup-item').length) sec.remove();
    } catch (e2) { toast(e2.message, 'err'); }
  });
  $('dupBody').appendChild(sec);
}

function renderDupGroups(groups, label, ignorable = false) {
  if (!groups.length) return;
  const body = $('dupBody');
  groups.forEach((g, gi) => {
    const sec = document.createElement('div');
    sec.className = 'dup-group';
    let best = 0;
    g.forEach((it, i) => {
      if ((it.w || 0) * (it.h || 0) > (g[best].w || 0) * (g[best].h || 0)) best = i;
    });
    sec.innerHTML = `
      <div class="dup-group-title">
        <span class="tag">${escapeHtml(label)}</span> 第 ${gi + 1} 组（${g.length} 张）
        <label><input type="checkbox" class="dup-group-sel" /> 全选本组</label>
        <button class="btn small warn keep-best" type="button"
          title="保留分辨率最高的一张，其余移入回收站；保留图会自动改为组内最小序号（同目录且目标未被占用时）">保留最高清</button>
        ${ignorable ? `<button class="btn small ignore-group" type="button"
          title="这些图只是画风相似——之后查重不再提示它们">忽略本组</button>` : ''}
        <button class="btn small danger dup-delete" type="button">删除所选</button>
      </div>
      <div class="dup-row">
        ${g.map((it, i) => `
          <div class="dup-item${i === best ? ' best' : ''}">
            <img loading="lazy" src="/api/thumb?p=${encodeURIComponent(it.rel)}&w=264" alt="" />
            ${i === best
              ? '<div><span class="tag ok">保留</span></div>'
              : `<label><input type="checkbox" class="dup-item-sel" value="${escapeHtml(it.rel)}" /> 删除</label>`}
            <div class="name" title="${escapeHtml(it.rel)}">${escapeHtml(it.name)}${i === best ? ' ⭐' : ''}</div>
            <div class="muted">${it.w && it.h ? `${it.w}×${it.h} · ` : ''}${it.sizeText || ''}</div>
          </div>`).join('')}
      </div>`;

    sec.querySelector('.dup-group-sel').addEventListener('change', (e) => {
      sec.querySelectorAll('.dup-item-sel').forEach((c) => { c.checked = e.target.checked; });
    });

    sec.querySelector('.keep-best').addEventListener('click', async () => {
      const rels = g.map((it) => it.rel).filter((rel) => rel !== g[best].rel);
      if (!rels.length) return toast('本组只有一张，无需清理', 'warn');
      const ok = await confirmDialog({
        title: '保留最高清',
        message: `保留 ${g[best].name}（${g[best].w}×${g[best].h}），其余 ${rels.length} 张移入回收站？`,
        detail: '保留图会自动改为同目录组内最小序号（目标序号被占用时保持原名）。',
        okText: '清理'
      });
      if (!ok) return;
      try {
        const r = await api('/api/duplicates/keep-best', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ group: g.map((it) => it.rel), keep: g[best].rel })
        });
        const failed = (r.trash && r.trash.moved ? r.trash.moved : []).filter((m) => m.error);
        let msg = `已保留最高清一张，${rels.length} 张移入回收站`;
        if (r.compact && r.compact.renamed) msg += `；保留图序号已改为 ${r.compact.keptRel.split('/').pop()}`;
        else if (r.compact && r.compact.reason === 'target-occupied') msg += '；最小序号已被占用，保留图未改名';
        if (failed.length) msg += `；${failed.length} 张移入失败`;
        toast(msg, failed.length ? 'warn' : 'ok', r.trash && r.trash.batchId && !failed.length
          ? { action: { label: '撤销删除', onClick: () => undoTrashBatch(r.trash.batchId) }, duration: 12000 }
          : {});
        sec.remove();
        refreshLibrary();
        refreshGitStatus();
      } catch (e) { toast(e.message, 'err'); }
    });

    const ignoreBtn = sec.querySelector('.ignore-group');
    if (ignoreBtn) {
      ignoreBtn.addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: '忽略相似组',
          message: `忽略本组 ${g.length} 张图片？`,
          detail: '它们之后不再参与相似归组（其他图片之间的相似提示不受影响），可随时在面板底部“已忽略”中取消。',
          okText: '忽略本组'
        });
        if (!ok) return;
        try {
          const r = await api('/api/duplicates/ignore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paths: g.map((it) => it.rel) })
          });
          toast(`已忽略 ${r.added} 张（共 ${r.total} 张）`, 'ok');
          sec.remove();
        } catch (e) { toast(e.message, 'err'); }
      });
    }

    sec.querySelector('.dup-delete').addEventListener('click', async () => {
      const rels = [...sec.querySelectorAll('.dup-item-sel:checked')].map((c) => c.value);
      if (!rels.length) return toast('请先勾选要删除的图片（建议保留一张）', 'warn');
      const res = await trashPaths(rels);
      if (res && res.ok > 0) sec.remove();
    });

    body.appendChild(sec);
  });
}

/* ---------------- 回收站 ---------------- */

$('btnTrash').addEventListener('click', () => {
  openModal('trashPanel');
  const days = state.cfg?.trashRetentionDays || 30;
  $('trashRetention').textContent = `保留 ${days} 天，过期自动清理`;
  loadTrash();
});

async function loadTrash() {
  $('trashBody').innerHTML = '<div class="empty">加载中…</div>';
  try {
    const rows = await api('/api/trash');
    state.trashRows = rows;
    renderTrash(rows);
  } catch (e) {
    state.trashRows = [];
    $('trashBody').innerHTML = `<div class="empty">加载失败：${escapeHtml(e.message)}</div>`;
  }
}

function renderTrash(rows) {
  const body = $('trashBody');
  $('btnTrashPurgeAll').hidden = rows.length === 0;
  if (!rows.length) {
    body.innerHTML = '<div class="empty">回收站是空的</div>';
    return;
  }
  const byBatch = new Map();
  for (const r of rows) {
    if (!byBatch.has(r.batchId)) byBatch.set(r.batchId, []);
    byBatch.get(r.batchId).push(r);
  }
  const days = state.cfg?.trashRetentionDays || 30;
  body.innerHTML = [...byBatch.entries()].map(([batchId, items]) => `
    <section class="trash-batch" data-batch="${escapeHtml(batchId)}">
      <div class="trash-batch-head">
        <span class="tag">批次 ${escapeHtml(fmtBatchId(batchId))}</span>
        <span>${items.length} 项</span>
        <span class="flex-sp"></span>
        <button class="btn small" type="button" data-restore-batch="${escapeHtml(batchId)}">整批恢复</button>
        <button class="btn small danger" type="button" data-purge-batch="${escapeHtml(batchId)}" title="不可恢复">清空本批</button>
      </div>
      <div class="trash-list">
        ${items.map((r) => `
          <div class="trash-item" data-flat="${escapeHtml(r.flat)}">
            <img class="trash-thumb" loading="lazy" alt=""
              src="/api/trash/thumb?b=${encodeURIComponent(r.batchId)}&f=${encodeURIComponent(r.flat)}" />
            <div class="trash-info">
              <div class="path" title="${escapeHtml(r.rel)}">${escapeHtml(r.rel)}</div>
              <div class="meta">${r.sizeText || ''} · ${fmtTime(r.trashedAt)} · ${days} 天后自动清理</div>
            </div>
            <div class="trash-actions">
              <button class="btn small" type="button" data-restore="${escapeHtml(r.batchId)}" data-flat2="${escapeHtml(r.flat)}">恢复</button>
              <button class="btn small danger" type="button" data-purge="${escapeHtml(r.batchId)}" data-flat2="${escapeHtml(r.flat)}" title="彻底删除，不可恢复">彻底删除</button>
            </div>
          </div>`).join('')}
      </div>
    </section>`).join('');
}

$('trashBody').addEventListener('click', async (e) => {
  const restoreBatch = e.target.closest('[data-restore-batch]');
  if (restoreBatch) {
    const batchId = restoreBatch.dataset.restoreBatch;
    const items = state.trashRows.filter((r) => r.batchId === batchId).length;
    const ok = await confirmDialog({
      title: '整批恢复',
      message: `恢复批次 ${fmtBatchId(batchId)} 的全部 ${items} 项？`,
      detail: '编号已被占用时会自动改号，不会覆盖现有图片。',
      okText: '恢复',
      danger: false
    });
    if (!ok) return;
    try {
      const { results } = await api('/api/trash/restore-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchId })
      });
      const okN = results.filter((r) => !r.error).length;
      const renN = results.filter((r) => r.renamed).length;
      toast(`已恢复 ${okN}/${results.length} 项${renN ? `（${renN} 项自动改号）` : ''}`, 'ok');
      refreshLibrary();
      refreshGitStatus();
      loadTrash();
    } catch (e2) { toast(e2.message, 'err'); }
    return;
  }

  const purgeBatch = e.target.closest('[data-purge-batch]');
  if (purgeBatch) {
    const batchId = purgeBatch.dataset.purgeBatch;
    const items = state.trashRows.filter((r) => r.batchId === batchId).length;
    const ok = await confirmDialog({
      title: '彻底删除批次',
      message: `彻底删除批次 ${fmtBatchId(batchId)} 的全部 ${items} 项？`,
      detail: '此操作不可恢复。',
      okText: '彻底删除'
    });
    if (!ok) return;
    try {
      await api('/api/trash/purge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchId })
      });
      toast('批次已彻底删除', 'ok');
      loadTrash();
    } catch (e2) { toast(e2.message, 'err'); }
    return;
  }

  const purge = e.target.closest('[data-purge]');
  if (purge) {
    const batchId = purge.dataset.purge;
    const flat = purge.dataset.flat2;
    const ok = await confirmDialog({
      title: '彻底删除',
      message: `彻底删除 ${flat}？`,
      detail: '此操作不可恢复。',
      okText: '彻底删除'
    });
    if (!ok) return;
    try {
      await api('/api/trash/purge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchId, flats: [flat] })
      });
      toast('已彻底删除', 'ok');
      loadTrash();
    } catch (e2) { toast(e2.message, 'err'); }
    return;
  }

  const restore = e.target.closest('[data-restore]');
  if (!restore) return;
  try {
    const { restored, renamed } = await api('/api/trash/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batchId: restore.dataset.restore, flat: restore.dataset.flat2 })
    });
    toast(renamed ? `编号被占用，已恢复为：${restored}` : `已恢复：${restored}`, 'ok');
    refreshLibrary();
    refreshGitStatus();
    loadTrash();
  } catch (e2) { toast(e2.message, 'err'); }
});

$('btnTrashPurgeAll').addEventListener('click', async () => {
  const batchIds = [...new Set(state.trashRows.map((r) => r.batchId))];
  if (!batchIds.length) return toast('回收站是空的', 'warn');
  const ok = await confirmDialog({
    title: '清空回收站',
    message: `彻底清空回收站的全部 ${batchIds.length} 个批次？`,
    detail: '此操作不可恢复。',
    okText: '清空回收站'
  });
  if (!ok) return;
  try {
    for (const batchId of batchIds) {
      await api('/api/trash/purge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchId })
      });
    }
    toast(`已清空回收站（${batchIds.length} 个批次）`, 'ok');
    loadTrash();
  } catch (e) { toast(e.message, 'err'); }
});

/* ---------------- 整理 ---------------- */

$('btnOrganize').addEventListener('click', () => {
  const dirs = [...new Set(state.libAll.map((r) => dirOf(r.rel)))].filter(Boolean).sort();
  const themes = dirs.filter((d) => d.startsWith('emoticon/')).map((d) => d.slice('emoticon/'.length));
  const defaultDir = state.dir && dirs.includes(state.dir) ? state.dir : (dirs[0] || '');

  $('organizeBody').innerHTML = `
    <h4 class="org-title">编号规整</h4>
    <p class="muted">把目录内文件重排为 0001..N 连续编号，消除删除留下的空洞。</p>
    <div class="opt-grid">
      <label class="opt">
        <span class="opt-label">选择目录</span>
        <select id="orgDir">${dirs.map((d) => `<option value="${escapeHtml(d)}"${d === defaultDir ? ' selected' : ''}>${escapeHtml(d)}</option>`).join('')}</select>
      </label>
      <div class="opt">
        <span class="opt-label">影响范围</span>
        <div class="callout" id="orgCount" style="margin-top:0"></div>
      </div>
    </div>
    <div class="callout warn" style="margin-top:12px">
      ${icon('warning', 'sm')}
      <span>已发布的链接按文件名寻址，编号规整后旧链接会失效。建议先同步 Git，确认无误后再操作。</span>
    </div>
    <div class="queue-actions">
      <button class="btn warn" id="btnRenumber" type="button">规整所选目录</button>
    </div>

    <h4 class="org-title" style="margin-top:22px">表情包主题改名</h4>
    <div class="opt-grid">
      <label class="opt">
        <span class="opt-label">现有主题</span>
        <select id="orgTheme">${themes.length
          ? themes.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('')
          : '<option value="">（暂无表情包主题）</option>'}</select>
      </label>
      <label class="opt">
        <span class="opt-label">新主题名</span>
        <input type="text" id="orgNewTheme" placeholder="例如：流光2" />
      </label>
    </div>
    <div class="callout" id="orgThemePreview"></div>
    <div class="queue-actions">
      <button class="btn warn" id="btnRenameTheme" type="button" ${themes.length ? '' : 'disabled'}>重命名主题</button>
    </div>`;

  const updateOrgCount = () => {
    const dir = $('orgDir').value;
    const n = state.libAll.filter((r) => r.rel.startsWith(dir + '/')).length;
    $('orgCount').innerHTML = `${icon('info', 'sm')}<span>将重命名 <b>${n}</b> 个文件，影响最多 <b>${n}</b> 条旧链接</span>`;
  };
  const updateThemePreview = () => {
    const from = $('orgTheme').value;
    const to = $('orgNewTheme').value;
    const safe = sanitizeTheme(to);
    if (!from || !to.trim()) {
      $('orgThemePreview').innerHTML = `${icon('info', 'sm')}<span>输入新主题名后显示最终目录名。</span>`;
      return;
    }
    const exists = state.libAll.some((r) => r.rel.startsWith(`emoticon/${safe}/`)) && safe !== from;
    $('orgThemePreview').innerHTML = exists
      ? `${icon('warning', 'sm')}<span class="warn-text">目标主题「${escapeHtml(safe)}」已存在，无法改名。</span>`
      : `${icon('info', 'sm')}<span>将把「${escapeHtml(from)}」改为「${escapeHtml(safe)}」。</span>`;
  };

  $('orgDir').addEventListener('change', updateOrgCount);
  $('orgTheme').addEventListener('change', updateThemePreview);
  $('orgNewTheme').addEventListener('input', updateThemePreview);
  updateOrgCount();
  updateThemePreview();

  $('btnRenumber').addEventListener('click', async () => {
    const dir = $('orgDir').value;
    const n = state.libAll.filter((r) => r.rel.startsWith(dir + '/')).length;
    const ok = await confirmDialog({
      title: '编号规整',
      message: `把「${dir}」内的 ${n} 个文件重排为连续编号？`,
      detail: '该目录内编号发生变化文件的旧链接将全部失效。',
      okText: '开始规整'
    });
    if (!ok) return;
    try {
      toast('正在规整…', 'info');
      const r = await api('/api/renumber', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir })
      });
      toast(`规整完成：共 ${r.total} 个文件，重命名 ${r.renumbered} 个`, 'ok');
      closeModal('organizePanel');
      refreshLibrary();
      refreshGitStatus();
    } catch (e) { toast(e.message, 'err'); }
  });

  $('btnRenameTheme').addEventListener('click', async () => {
    const from = $('orgTheme').value;
    const to = $('orgNewTheme').value.trim();
    if (!from || !to) return toast('请填写新主题名', 'warn');
    const safe = sanitizeTheme(to);
    if (safe === '默认') return toast('主题名不能为空或全部为非法字符', 'warn');
    if (safe === from) return toast('新旧主题名相同', 'warn');
    if (state.libAll.some((r) => r.rel.startsWith(`emoticon/${safe}/`))) {
      return toast(`目标主题「${safe}」已存在`, 'err');
    }
    const ok = await confirmDialog({
      title: '主题改名',
      message: `把表情包主题「${from}」改名为「${safe}」？`,
      detail: '目录内所有文件随之迁移，旧主题链接会失效。',
      okText: '改名'
    });
    if (!ok) return;
    try {
      const r = await api('/api/rename-theme', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to })
      });
      toast(`已改名：${r.oldRel} → ${r.newRel}（${r.count} 个文件）`, 'ok');
      closeModal('organizePanel');
      refreshLibrary();
      refreshGitStatus();
    } catch (e) { toast(e.message, 'err'); }
  });

  openModal('organizePanel');
});

/* ================================================================
 * 8. 统计 / 设置 / Git / 初始化
 * ================================================================ */

const PALETTE = ['#3b5bdb', '#7c5cf0', '#197a45', '#b7791f', '#b42318', '#2b7bb9', '#667085'];

async function refreshStats() {
  try {
    state.stats = await api('/api/stats');
    renderStats(state.stats);
  } catch (e) {
    toast(`统计加载失败：${e.message}`, 'err');
  }
}

function renderStats(s) {
  const formatCount = Object.keys(s.byFormat).length;
  $('statCards').innerHTML = `
    <div class="stat-card"><div class="stat-num">${s.total.count}</div><div class="stat-label">图片总数</div></div>
    <div class="stat-card"><div class="stat-num">${s.total.sizeText}</div><div class="stat-label">占用空间</div></div>
    <div class="stat-card"><div class="stat-num">${s.categoryCount}</div><div class="stat-label">分类数</div></div>
    <div class="stat-card"><div class="stat-num">${formatCount}</div><div class="stat-label">格式数</div></div>`;

  // —— 分类环形图（纯 SVG）——
  const cats = Object.entries(s.byCategory).sort((a, b) => b[1].count - a[1].count);
  const total = Math.max(1, s.total.count);
  const R = 40, C = 2 * Math.PI * R;
  let offset = 0;
  const segs = cats.map(([cat, v], i) => {
    const frac = v.count / total;
    const seg = `<circle r="${R}" cx="60" cy="60" fill="none" stroke="${PALETTE[i % PALETTE.length]}"
      stroke-width="16" stroke-dasharray="${(frac * C).toFixed(2)} ${(C - frac * C).toFixed(2)}"
      stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 60 60)" />`;
    offset += frac * C;
    return seg;
  }).join('');
  const legend = cats.map(([cat, v], i) => `
    <button class="legend-item" type="button" data-cat="${escapeHtml(cat)}">
      <span class="legend-dot" style="background:${PALETTE[i % PALETTE.length]}"></span>
      <span>${CAT_NAMES[cat] || cat}：${v.count} 张 · ${v.sizeText || fmtSize(v.size)}</span>
    </button>`).join('');
  $('donutWrap').innerHTML = `
    <div class="donut-svg">
      <svg viewBox="0 0 120 120" width="150" height="150" role="img" aria-label="分类占比环形图">${segs}</svg>
      <div class="donut-center"><b>${s.total.count}</b><span>张图片</span></div>
    </div>
    <div class="legend">${legend || '<span class="muted">暂无数据</span>'}</div>`;

  // —— 格式分布 ——
  const fmts = Object.entries(s.byFormat).sort((a, b) => b[1].count - a[1].count);
  const maxN = Math.max(1, ...fmts.map(([, v]) => v.count));
  $('fmtBars').innerHTML = fmts.map(([f, v]) => `
    <button class="bar-row clickable" type="button" data-format="${escapeHtml(f)}">
      <span>${escapeHtml(f.toUpperCase())}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${(v.count / maxN * 100).toFixed(1)}%"></div></div>
      <span class="bar-val">${v.count} 张 · ${fmtSize(v.size)}</span>
    </button>`).join('') || '<div class="empty">暂无数据</div>';

  // —— 分类明细 ——
  $('catDetail').innerHTML = cats.map(([cat, v]) => `
    <button class="cat-detail-row" type="button" data-cat="${escapeHtml(cat)}">
      <span>${CAT_NAMES[cat] || cat}</span>
      <div>
        <div class="usage-track"><div class="usage-fill" style="width:${Math.min(100, v.usage)}%"></div></div>
        <div class="usage-text">编号已用至 ${String(v.maxNumber).padStart(4, '0')} / ${v.cap}（${v.usage}%）</div>
      </div>
      <span class="muted">${v.count} 张 · ${v.sizeText || fmtSize(v.size)}</span>
    </button>`).join('') || '<div class="empty">暂无数据</div>';

  // —— 最近更新 ——
  $('recentList').innerHTML = s.latest.map((r) => `
    <button class="recent-row" type="button" data-rel="${escapeHtml(r.rel)}">
      <span class="name" title="${escapeHtml(r.rel)}">${escapeHtml(r.rel)}</span>
      <span class="time">${fmtTime(r.mtime)}</span>
    </button>`).join('') || '<div class="empty">暂无数据</div>';

  // —— 近 12 个月新增（服务端聚合，首次直接进入统计页也有数据）——
  const monthly = Array.isArray(s.monthly) && s.monthly.length ? s.monthly : [];
  if (monthly.length) {
    const maxC = Math.max(1, ...monthly.map((m) => m.count));
    $('trendBars').innerHTML = monthly.map((m) => `
      <div class="bar-row" title="${escapeHtml(m.key)}：${m.count} 张 · ${m.sizeText || fmtSize(m.size)}">
        <span>${escapeHtml(m.label)}</span>
        <div class="bar-track"><div class="bar-fill${m.count ? '' : ' zero'}" style="width:${m.count ? (m.count / maxC * 100).toFixed(1) : 0}%"></div></div>
        <span class="bar-val">${m.count} 张 · ${m.sizeText || fmtSize(m.size)}</span>
      </div>`).join('');
  } else {
    $('trendBars').innerHTML = '<div class="empty">暂无数据</div>';
  }
}

// 统计页点击穿透到图片库
$('view-stats').addEventListener('click', (e) => {
  const cat = e.target.closest('[data-cat]');
  if (cat) return goLibraryFilter({ cat: cat.dataset.cat });
  const fmt = e.target.closest('[data-format]');
  if (fmt) return goLibraryFilter({ format: fmt.dataset.format });
  const rel = e.target.closest('[data-rel]');
  if (rel) return goToImage(rel.dataset.rel);
});

function goLibraryFilter({ cat, format }) {
  state.dir = cat ? (CHIP_DIR[cat] ?? '') : '';
  state.format = format || 'all';
  state.keyword = '';
  state.minSize = 0;
  state.minWidth = 0;
  state.pageLimit = PAGE_SIZE;
  activateView('library');
  refreshLibrary();
}

async function goToImage(rel) {
  state.dir = '';
  state.format = 'all';
  state.keyword = '';
  state.minSize = 0;
  state.minWidth = 0;
  state.pageLimit = PAGE_SIZE;
  activateView('library');
  await refreshLibrary();
  openLightbox(rel);
}

/* ---------------- 设置 ---------------- */

function fillSettings(view) {
  $('setQuality').value = view['upload.quality'].value;
  $('setQualityVal').textContent = view['upload.quality'].value;
  $('setMaxBatch').value = view['upload.maxBatchFiles'].value;
  $('setMaxFileMB').value = view['upload.maxFileMB'].value;
  $('setHamming').value = view['dedup.hammingThreshold'].value;
  $('setOnDup').value = view['dedup.onExactDuplicate'].value;
  $('setLinkFormat').value = view['linkFormat'].value;
  $('setPurgeCdn').checked = !!view['git.purgeCdn'].value;
  $('settingsMsg').hidden = true;
  $('settingsMsg').className = 'form-msg';
}

function setCfgByKey(key, value) {
  if (!state.cfg) return;
  const parts = key.split('.');
  let cur = state.cfg;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

const SETTING_LABELS = {
  'upload.quality': '默认压缩质量',
  'upload.maxBatchFiles': '单批最多文件数',
  'upload.maxFileMB': '单文件上限',
  'dedup.hammingThreshold': '相似判定阈值',
  'dedup.onExactDuplicate': '完全重复策略',
  'linkFormat': '默认链接格式',
  'git.purgeCdn': '同步后刷新缓存'
};

$('btnSettings').addEventListener('click', async () => {
  try {
    const view = await api('/api/settings');
    fillSettings(view);
    openModal('settingsPanel');
  } catch (e) { toast(`设置加载失败：${e.message}`, 'err'); }
});

$('setQuality').addEventListener('input', () => {
  $('setQualityVal').textContent = $('setQuality').value;
});

$('btnSaveSettings').addEventListener('click', async () => {
  try {
    const res = await api('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        'upload.quality': Number($('setQuality').value),
        'upload.maxBatchFiles': Number($('setMaxBatch').value),
        'upload.maxFileMB': Number($('setMaxFileMB').value),
        'dedup.hammingThreshold': Number($('setHamming').value),
        'dedup.onExactDuplicate': $('setOnDup').value,
        'linkFormat': $('setLinkFormat').value,
        'git.purgeCdn': $('setPurgeCdn').checked
      })
    });
    // 把服务端确认后的值写回内存配置，上传面板立刻使用新默认值
    for (const [key, info] of Object.entries(res.settings || {})) setCfgByKey(key, info.value);
    state.linkType = state.cfg.linkFormat || state.linkType;
    applyUploadDefaults();

    if (res.invalid && res.invalid.length) {
      $('settingsMsg').hidden = false;
      $('settingsMsg').className = 'form-msg err';
      $('settingsMsg').textContent =
        `以下设置无效，未保存：${res.invalid.map((k) => SETTING_LABELS[k] || k).join('、')}`;
      toast('部分设置无效，请检查数值范围', 'warn');
    } else {
      closeModal('settingsPanel');
      toast('设置已保存', 'ok');
    }
  } catch (e) {
    $('settingsMsg').hidden = false;
    $('settingsMsg').className = 'form-msg err';
    $('settingsMsg').textContent = `保存失败：${e.message}`;
    toast(`保存失败：${e.message}`, 'err');
  }
});

/* ---------------- Git 同步 ---------------- */

async function refreshGitStatus() {
  const badge = $('gitCount');
  try {
    const st = await api('/api/git/status');
    if (st.enabled === false) {
      badge.textContent = '—';
      badge.classList.add('warn');
      $('btnGitSync').disabled = true;
      $('btnGitSync').title = '同步功能已在配置中关闭';
      return;
    }
    badge.textContent = st.count;
    badge.classList.toggle('warn', st.count > 0);
    $('btnGitSync').disabled = !!state.gitSyncing;
    $('btnGitSync').title = st.count
      ? `${st.count} 项变更待同步`
      : '没有本地变更；同步仍会先拉取远端更新';
  } catch (e) {
    badge.textContent = '!';
    badge.classList.add('warn');
    $('btnGitSync').title = `无法读取同步状态：${e.message}`;
  }
}

$('btnGitStatus').addEventListener('click', refreshGitStatus);

async function runGitSync(auto = false) {
  if (state.gitSyncing) return;
  if (state.cfg && state.cfg.git && state.cfg.git.enabled === false) {
    if (!auto) toast('同步功能已在配置中关闭', 'warn');
    return;
  }
  if (!auto) {
    const ok = await confirmDialog({
      title: '同步到 GitHub',
      message: '将图库全部变更提交并推送到 GitHub？',
      detail: '会先拉取远端更新；同步失败不会影响本地图片文件。',
      okText: '同步',
      danger: false
    });
    if (!ok) return;
  }
  state.gitSyncing = true;
  const btn = $('btnGitSync');
  const label = $('gitSyncLabel');
  btn.disabled = true;
  label.textContent = '同步中…';
  try {
    const r = await api('/api/git/sync', { method: 'POST' });
    const rows = (r.steps || []).map((s) => ({
      status: s.ok ? 'ok' : 'fail',
      title: s.step,
      note: s.detail || ''
    }));
    if (r.ok) {
      toast(r.message, 'ok');
      if (!auto) showResult('Git 同步结果', rows);
    } else {
      toast(r.message, 'err');
      showResult('Git 同步结果', rows.length ? rows : '<div class="empty">同步失败</div>');
    }
    refreshGitStatus();
  } catch (e) {
    toast(`同步失败：${e.message}`, 'err');
  } finally {
    state.gitSyncing = false;
    btn.disabled = false;
    label.textContent = '同步到 GitHub';
    refreshGitStatus();
  }
}

$('btnGitSync').addEventListener('click', () => runGitSync(false));

/* ---------------- 图片库数据加载 ---------------- */

let libPromise = null;

function refreshLibrary() {
  if (libPromise) return libPromise;
  const firstLoad = state.libAll.length === 0;
  if (firstLoad) {
    $('libGrid').innerHTML = Array.from({ length: 12 }, () => '<div class="cell skeleton" aria-hidden="true"></div>').join('');
    $('libGrid').setAttribute('aria-busy', 'true');
  }
  libPromise = (async () => {
    try {
      const [list, st] = await Promise.all([api('/api/images'), api('/api/stats')]);
      state.libAll = list;
      state.catCounts = st;
      updateThemeDatalist();
      renderCatChips();
      renderFmtOptions();
      renderTree();
      applyFilters();
    } catch (e) {
      toast(`图片库加载失败：${e.message}`, 'err');
      if (firstLoad) $('libGrid').innerHTML = '';
    } finally {
      $('libGrid').removeAttribute('aria-busy');
    }
  })();
  libPromise.finally(() => { libPromise = null; });
  return libPromise;
}

/* ---------------- 全局键盘 ---------------- */

function isTypingTarget(el) {
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

document.addEventListener('keydown', (e) => {
  // 灯箱优先
  if (!$('lightbox').hidden) {
    if (e.key === 'Escape') { e.preventDefault(); closeLightbox(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); lbStep(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); lbStep(1); }
    else if (e.key === '+' || e.key === '=') { e.preventDefault(); lbZoom(1.25); }
    else if (e.key === '-') { e.preventDefault(); lbZoom(0.8); }
    else if (e.key === '0') { e.preventDefault(); lbResetZoom(); }
    return;
  }

  // 模态框：Esc 关闭 + Tab 焦点锁定
  const openModalEl = [...document.querySelectorAll('.modal')].find((m) => !m.hidden);
  if (openModalEl) {
    if (e.key === 'Escape') { e.preventDefault(); closeModal(openModalEl.id); }
    else if (e.key === 'Tab') trapFocus(openModalEl, e);
    return;
  }

  // 图片库快捷键
  if (!document.querySelector('#view-library').classList.contains('active')) return;
  if (isTypingTarget(e.target)) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    selectAllVisible();
  } else if (e.key === 'Escape') {
    clearSelection();
  }
});

/* ---------------- 初始化 ---------------- */

(async function init() {
  try {
    state.cfg = await api('/api/config');
    state.linkType = state.cfg.linkFormat || 'jsdelivr';
    $('linkType').value = state.linkType;
    $('repoLabel').textContent = `${state.cfg.repo.owner}/${state.cfg.repo.name}`;
    applyUploadDefaults();
    refreshGitStatus();
    // 上传页默认视图，后台预热一次主题清单（失败不影响使用）
    ensureThemes();
  } catch (e) {
    toast(`初始化失败：${e.message}`, 'err');
  }
})();
