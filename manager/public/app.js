'use strict';
/**
 * 智能图床管理器 - 前端逻辑（原生 JS，无框架、无构建步骤）
 * ---------------------------------------------------------------
 * 模块划分：
 *  1. 基础工具：请求封装 / 提示气泡 / 格式化
 *  2. 全局状态与视图切换
 *  3. 上传视图：拖拽选图 → 队列 → 批量提交 → 结果渲染
 *  4. 图片库视图：筛选 / 网格懒加载 / 多选批量操作 / 查重 / 回收站
 *  5. 统计视图：汇总卡片 / SVG 环形图 / 条形图 / 明细
 *  6. Git 同步：状态徽标与手动同步
 */

/* ================================================================
 * 1. 基础工具
 * ================================================================ */

/** 统一请求封装：后端约定 {ok:true,data} / {ok:false,error}；非成功时抛中文错误 */
async function api(url, options = {}) {
  const res = await fetch(url, options);
  let body = null;
  try { body = await res.json(); } catch (e) { /* 响应非 JSON 时按错误处理 */ }
  if (!res.ok || !body || body.ok !== true) {
    throw new Error((body && body.error) || `请求失败（HTTP ${res.status}）`);
  }
  return body.data;
}

/** 右上角提示气泡（3.5 秒自动消失） */
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

/** 人类可读字节数 */
function fmtSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, n = Number(bytes) || 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 本地时间格式化（yyyy-MM-dd HH:mm） */
function fmtTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** HTML 转义（文件名可能含特殊字符，防破坏结构） */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 复制文本到剪贴板（剪贴板 API 不可用时降级为临时输入框） */
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

/** 通过 Blob 触发浏览器下载 */
function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

/* ================================================================
 * 2. 全局状态与视图切换
 * ================================================================ */

/** 分类展示名映射（与后端分类值对应） */
const CAT_NAMES = {
  all: '全部', heng: '横图', shu: '竖图', avatar: '方形',
  emoticon: '表情包', temporary: '临时', '其他': '其他'
};

const state = {
  cfg: null,          // /api/config 返回的配置
  linkType: 'jsdelivr', // 链接类型：jsdelivr | fastly | testingcf | gcore | raw
  queue: [],          // 上传队列 [{file, previewUrl}]
  lib: [],            // 图片库「过滤后」列表（网格渲染用）
  libAll: [],         // 图片库全量列表（本地过滤的数据源：目录树 / chips / 网格共用）
  selected: new Set(),// 图片库多选集合（rel 相对路径）
  dir: '',            // 当前目录筛选（'' = 图库根；'__other__' = 不属于任何标准目录的散图）
  collapsed: new Set(),// 目录树中处于折叠状态的目录路径集合
  format: 'all',      // 当前格式筛选
  keyword: '',        // 搜索关键词
  minSize: 0,         // 最小文件字节数（0 = 不过滤）
  minWidth: 0,        // 最小像素宽度（0 = 不过滤）
  sort: 'numAsc',     // 排序模式：numAsc 序号升序 | numDesc 序号降序 | timeAsc/Desc 时间 | sizeDesc 体积降序
  stats: null,        // 统计数据缓存
  catCounts: null     // 全库分类计数（来自 /api/stats，供筛选 chips 使用，不随当前筛选变化）
};

const $ = (id) => document.getElementById(id);

/** 顶部视图切换（上传 / 图片库 / 统计） */
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === btn));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${btn.dataset.view}`));
    if (btn.dataset.view === 'library') refreshLibrary();
    if (btn.dataset.view === 'stats') refreshStats();
  });
});

/** 通用弹窗开关（查重面板 / 回收站面板共用结构） */
document.querySelectorAll('[data-close]').forEach((btn) => {
  btn.addEventListener('click', () => {
    $(btn.dataset.close).hidden = true;
  });
});

/* ================================================================
 * 3. 上传视图
 * ================================================================ */

const dz = $('dropzone');
const fileInput = $('fileInput');

// 点击选择文件
dz.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });

// 拖拽上传：进入/悬停高亮，离开/放下还原
['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => {
  e.preventDefault();
  dz.classList.add('dragover');
}));
['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => {
  e.preventDefault();
  dz.classList.remove('dragover');
}));
dz.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

// 剪贴板粘贴上传：截图后 Ctrl+V 直接进队列（在整个上传视图内监听）
document.addEventListener('paste', (e) => {
  // 输入框获得焦点时不劫持粘贴（如主题名输入框粘贴文本）
  if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
  const files = [...(e.clipboardData ? e.clipboardData.files : [])];
  if (!files.length) return;
  addFiles(files);
  toast(`已从剪贴板加入 ${files.length} 张图片`, 'ok');
  document.querySelector('.tab[data-view="upload"]').click(); // 自动跳到上传视图
});

/** 把本地文件加入上传队列（过滤非图片；生成本地预览 URL） */
function addFiles(fileList) {
  const max = (state.cfg && state.cfg.upload.maxBatchFiles) || 200;
  for (const f of fileList) {
    if (!/^image\//.test(f.type) && !/\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i.test(f.name)) {
      toast(`已跳过非图片文件：${f.name}`, 'warn');
      continue;
    }
    if (state.queue.length >= max) { toast(`单批最多 ${max} 张`, 'warn'); break; }
    state.queue.push({ file: f, previewUrl: URL.createObjectURL(f) });
  }
  renderQueue();
}

/** 渲染上传队列。
 * 缩略图来源：待上传/失败项用本地 Blob 预览；已入库项（成功/重复跳过）用服务端
 * 缩略图接口——上传成功即释放本地预览，src 若还指着旧 Blob 会成破图。 */
function renderQueue() {
  const list = $('queueList');
  list.innerHTML = '';
  $('queueEmpty').hidden = state.queue.length > 0;
  $('queueActions').hidden = state.queue.length === 0;
  $('btnCopyBatch').hidden = true; // 新队列尚未上传，无链接可复制
  const pending = state.queue.filter((it) => !it.done);
  const failed = state.queue.filter((it) => it.done && it.result && it.result.status === 'failed');
  $('btnRetryFailed').hidden = failed.length === 0 || pending.length > 0;
  $('queueSummary').textContent = state.queue.length
    ? `共 ${state.queue.length} 张 · 待上传 ${pending.length}${failed.length ? ` · 失败 ${failed.length}` : ''}`
    : '';

  state.queue.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = 'qitem';
    const statusTag = !item.done
      ? '<span class="tag">待上传</span>'
      : item.result.status === 'ok'
        ? `<span class="tag ok">已归档 ${escapeHtml(item.result.assignedName)}</span>`
        : item.result.status === 'duplicate'
          ? '<span class="tag dup">重复跳过</span>'
          : '<span class="tag fail">失败</span>';
    const catTag = item.result && item.result.category
      ? `<span class="tag cat">${CAT_NAMES[item.result.category] || item.result.category}</span>` : '';
    const dim = item.result && item.result.w ? ` · ${item.result.w}×${item.result.h}` : '';
    const notice = item.result && item.result.notice ? `<div class="qitem-notice">${escapeHtml(item.result.notice)}</div>` : '';
    const err = item.result && item.result.error ? `<div class="qitem-err">${escapeHtml(item.result.error)}</div>` : '';
    const copyBtn = item.result && item.result.status === 'ok' && item.result.url
      ? `<button class="btn small" data-copy-url="${escapeHtml(item.result.url)}">复制链接</button>` : '';
    // 已入库（ok/duplicate 的 result.rel）→ 服务端缩略图（优先）；失败/待上传 → 本地预览
    const serverThumb = item.result && (item.result.status === 'ok' || item.result.status === 'duplicate') && item.result.rel
      ? `/api/thumb?p=${encodeURIComponent(item.result.rel)}&w=120` : '';
    const thumbSrc = serverThumb || item.previewUrl;
    const thumb = thumbSrc
      ? `<img class="qitem-thumb" src="${thumbSrc}" alt="" />`
      : '<div class="qitem-thumb qitem-thumb-empty">⇪</div>';
    row.innerHTML = `
      ${thumb}
      <div>
        <div class="qitem-name">${escapeHtml(item.file.name)}</div>
        <div class="qitem-meta">${statusTag} ${catTag} <span>${fmtSize(item.file.size)}${dim}</span></div>
        ${notice}${err}
      </div>
      <div>${copyBtn}<button class="icon-btn" data-remove="${i}" title="移出队列" ${item.done ? 'hidden' : ''}>✕</button></div>`;
    list.appendChild(row);
  });
}

// 队列事件委托：移除单项 / 复制链接
$('queueList').addEventListener('click', async (e) => {
  const rm = e.target.closest('[data-remove]');
  if (rm) {
    const i = Number(rm.dataset.remove);
    URL.revokeObjectURL(state.queue[i].previewUrl);
    state.queue.splice(i, 1);
    renderQueue();
    return;
  }
  const cp = e.target.closest('[data-copy-url]');
  if (cp) {
    try { await copyText(cp.dataset.copyUrl); toast('链接已复制', 'ok'); }
    catch (err) { toast(err.message, 'err'); }
  }
});

// 分类方式选择"表情包"时显示主题输入框
$('optCategory').addEventListener('change', () => {
  $('optThemeWrap').hidden = $('optCategory').value !== 'emoticon';
});

// 质量滑杆联动显示数值
$('optQuality').addEventListener('input', () => {
  $('qualityVal').textContent = $('optQuality').value;
});

/** 开始上传：逐文件串行提交（服务端本就串行处理）。
 * 相比整批一个请求：每张完成即刷新状态（真进度）、单张失败可单独重试、
 * 中途可点"停止"放弃余下文件；网络中断不再导致整批重来。 */
let uploadAbort = false;

$('btnUpload').addEventListener('click', async () => {
  const pending = state.queue.filter((it) => !it.done);
  if (pending.length === 0) { toast('队列中没有待上传的文件', 'warn'); return; }
  const btn = $('btnUpload');
  const opts = JSON.stringify({
    category: $('optCategory').value,
    theme: $('optTheme').value,
    convert: $('optConvert').value,
    quality: Number($('optQuality').value),
    onDuplicate: $('optDuplicate').value,
    stripMeta: $('optStripMeta').checked
  });
  btn.disabled = true;
  uploadAbort = false;
  let stopBtn = null;
  try {
    // 逐张提交；done 计数实时刷新按钮文案作为整体进度
    let done = 0;
    const setProgress = () => { btn.textContent = `上传中 ${done}/${pending.length}…`; };
    setProgress();
    const addStop = () => {
      stopBtn = document.createElement('button');
      stopBtn.className = 'btn ghost';
      stopBtn.textContent = '停止';
      stopBtn.addEventListener('click', () => { uploadAbort = true; stopBtn.disabled = true; });
      btn.parentElement.insertBefore(stopBtn, btn.nextSibling);
    };
    addStop();
    let okN = 0, dupN = 0, failN = 0;
    for (const it of pending) {
      if (uploadAbort) { toast(`已停止：余下 ${pending.length - done} 张未上传`, 'warn'); break; }
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
        it.result = { status: 'failed', error: e.message, retryable: true };
        failN += 1;
      }
      if (it.previewUrl) { URL.revokeObjectURL(it.previewUrl); it.previewUrl = ''; }
      done += 1;
      setProgress();
      renderQueue();
    }
    $('btnCopyBatch').hidden = state.queue.every((it) => !(it.result && it.result.status === 'ok'));
    if (done === pending.length) {
      toast(`上传完成：成功 ${okN} · 重复跳过 ${dupN} · 失败 ${failN}`, failN ? 'warn' : 'ok');
    }
    refreshGitStatus();
  } catch (e) {
    toast(`上传失败：${e.message}`, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '开始上传';
    if (stopBtn) stopBtn.remove();
  }
});

// 队列内"重试失败项"：把 failed 且可重试的项重置为待上传
$('btnRetryFailed').addEventListener('click', () => {
  const failed = state.queue.filter((it) => it.done && it.result && it.result.status === 'failed');
  if (!failed.length) { toast('没有失败的文件', 'warn'); return; }
  for (const it of failed) { it.done = false; it.result = null; }
  renderQueue();
  toast(`已将 ${failed.length} 个失败文件重新加入队列`, 'ok');
});

// 清空队列（释放预览 URL）
$('btnClearQueue').addEventListener('click', () => {
  state.queue.forEach((it) => { if (it.previewUrl) URL.revokeObjectURL(it.previewUrl); });
  state.queue = [];
  renderQueue();
});

// 复制本批全部成功链接
$('btnCopyBatch').addEventListener('click', async () => {
  const urls = state.queue.filter((it) => it.result && it.result.status === 'ok' && it.result.url)
    .map((it) => it.result.url);
  if (!urls.length) { toast('没有可复制的链接', 'warn'); return; }
  try { await copyText(urls.join('\n')); toast(`已复制 ${urls.length} 条链接`, 'ok'); }
  catch (e) { toast(e.message, 'err'); }
});

/* ================================================================
 * 4. 图片库视图
 * ================================================================ */

/** 分类 chips → 目录路径映射（与后端 classify 的目录约定一一对应） */
const CHIP_DIR = {
  all: '',
  heng: 'wallpapers&illustration/heng',
  shu: 'wallpapers&illustration/shu',
  avatar: 'wallpapers&illustration/avatar',
  emoticon: 'emoticon',
  temporary: 'wallpapers&illustration/temporary',
  '其他': '__other__'   // 特殊值：不落在任何标准目录下的散图
};

/**
 * 渲染分类筛选 chips（目录快捷方式，与左侧目录树联动高亮）。
 * 关键点 1：计数必须基于全库统计（state.catCounts），而非当前已筛选的列表 state.lib——
 *          否则选中某分类后，其余分类计数会归 0 导致 chips 整排消失、无法切换回来。
 * 关键点 2：点击 chip 通过 setDir 切换目录并本地过滤，无需重新请求服务端。
 */
function renderCatChips() {
  const cats = ['all', 'heng', 'shu', 'avatar', 'emoticon', 'temporary', '其他'];
  const wrap = $('catChips');
  wrap.innerHTML = '';
  const cc = state.catCounts; // /api/stats 返回的全库统计（可能尚未就绪）
  for (const c of cats) {
    // 计数优先级：全库统计 → 退回全量列表本地计数（统计未就绪时的兜底）
    const n = c === 'all'
      ? (cc && cc.total ? cc.total.count : state.libAll.length)
      : (cc && cc.byCategory && cc.byCategory[c])
        ? cc.byCategory[c].count
        : state.libAll.filter((r) => r.category === c).length;
    if (c !== 'all' && n === 0) continue; // 没有图片的分类不显示
    const chip = document.createElement('button');
    chip.className = `chip${CHIP_DIR[c] === state.dir ? ' active' : ''}`;
    chip.textContent = `${CAT_NAMES[c] || c} ${n}`;
    chip.addEventListener('click', () => {
      if (CHIP_DIR[c] === state.dir) return; // 重复点击同一目录不刷新
      setDir(CHIP_DIR[c]); // 切换目录：树与 chips 联动高亮，本地过滤网格
    });
    wrap.appendChild(chip);
  }
}

/** 渲染格式下拉（按当前数据动态生成） */
function renderFmtOptions() {
  const sel = $('fmtFilter');
  const cur = state.format;
  const fmts = [...new Set(state.libAll.map((r) => r.format))].sort();
  sel.innerHTML = '<option value="all">全部格式</option>' +
    fmts.map((f) => `<option value="${f}">${f.toUpperCase()}</option>`).join('');
  sel.value = fmts.includes(cur) ? cur : 'all';
  if (sel.value !== cur) state.format = sel.value;
}

/**
 * 刷新图片库：并行拉取「全量列表」与「全库统计」，再统一渲染。
 * 筛选（目录/格式/关键词）全部在前端本地完成：点目录树/输入关键词都是瞬时响应，
 * 仅在进入图片库、上传或删除后重新拉取全量数据。
 */
async function refreshLibrary() {
  try {
    const [list, st] = await Promise.all([
      api('/api/images'),
      api('/api/stats')
    ]);
    state.libAll = list;
    state.catCounts = st;
    renderCatChips();
    renderFmtOptions();
    renderTree();
    applyFilters();
  } catch (e) {
    toast(`图片库加载失败：${e.message}`, 'err');
  }
}

/**
 * 从全量列表构建目录树。
 * 递归计数：每个文件计入其所有祖先目录（含根），父目录计数 = 该目录下全部图片数（含子目录）。
 */
function buildTree(items) {
  const root = { name: '图库根（全部）', path: '', count: 0, children: new Map() };
  for (const it of items) {
    const parts = it.rel.split('/');
    let node = root;
    node.count++; // 文件计入根节点（= 全部数量）
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
      node.count++; // 文件计入每一级祖先目录
    }
  }
  return root;
}

/** 渲染左侧目录树（默认全部展开，折叠状态记录在 state.collapsed） */
function renderTree() {
  const wrap = $('dirTree');
  wrap.innerHTML = '';
  if (!state.libAll.length) {
    wrap.innerHTML = '<div class="tree-row" style="cursor:default">暂无图片</div>';
    return;
  }
  renderTreeNode(wrap, buildTree(state.libAll));
}

/** 递归渲染一个目录节点：节点行 + 可折叠子级 */
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

/** 生成单个树节点行（箭头/图标/目录名/计数），点击行切换目录，点箭头折叠展开 */
function makeTreeRow(node) {
  const row = document.createElement('div');
  row.className = `tree-row${state.dir === node.path ? ' active' : ''}`;
  const hasKids = node.children && node.children.size > 0;
  const collapsed = state.collapsed.has(node.path);

  const arrow = document.createElement('span');
  arrow.className = 'tree-arrow' + (hasKids ? (collapsed ? '' : ' open') : ' hidden-arrow');
  arrow.textContent = '▶';
  arrow.title = hasKids ? (collapsed ? '展开' : '折叠') : '';
  if (hasKids) {
    arrow.setAttribute('role', 'button'); // 语义化折叠按钮：无障碍与自动化工具可识别
    arrow.setAttribute('aria-label', (collapsed ? '展开 ' : '折叠 ') + node.name);
    arrow.tabIndex = 0;
  }

  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.textContent = '📁';

  const name = document.createElement('span');
  name.className = 'tree-name';
  name.textContent = node.name;
  name.title = node.path || '图库根（全部图片）';

  const count = document.createElement('span');
  count.className = 'tree-count';
  count.textContent = node.count;

  row.append(arrow, icon, name, count);
  row.setAttribute('role', 'button'); // 语义化：无障碍阅读与自动化工具可识别为可点击元素
  row.tabIndex = 0;
  row.addEventListener('click', () => { if (state.dir !== node.path) setDir(node.path); });
  if (hasKids) {
    arrow.addEventListener('click', (e) => {
      e.stopPropagation(); // 点箭头只折叠/展开，不切换目录
      if (state.collapsed.has(node.path)) state.collapsed.delete(node.path);
      else state.collapsed.add(node.path);
      renderTree(); // 重绘整棵树（目录数量少，开销可忽略）
    });
  }
  return row;
}

/** 切换当前目录：树与 chips 联动高亮，并对全量列表做本地过滤渲染 */
function setDir(dir) {
  state.dir = dir;
  renderTree();
  renderCatChips();
  applyFilters();
}

/** 按当前目录 / 格式 / 关键词 / 大小 / 宽度对全量列表做本地过滤，并按所选模式排序后渲染网格（纯前端，瞬时响应） */
function applyFilters() {
  const d = state.dir;
  const kw = state.keyword.toLowerCase();
  state.lib = state.libAll.filter((r) => {
    if (d === '__other__') { if (r.category !== '其他') return false; }
    else if (d && !r.rel.startsWith(d + '/')) return false; // 目录前缀匹配（含子目录）
    if (state.format !== 'all' && r.format !== state.format) return false;
    if (kw && !r.name.toLowerCase().includes(kw)) return false;
    if (state.minSize && !(r.size >= state.minSize)) return false;
    if (state.minWidth && !((r.w || 0) >= state.minWidth)) return false;
    return true;
  });

  /* ---------- 排序 ----------
   * 序号排序：先按分类分组（横 → 竖 → 方 → 表情包 → 临时 → 其他），
   * 组内按文件名中的数字序号（如 0001.png → 1）；无数字的排在组尾。
   * 时间排序：按文件修改时间 mtime；体积排序：按文件字节数降序。
   * 降序模式 = 升序结果整体反转（分类组顺序随之反转，保持「完全倒序」语义）。 */
  const CAT_ORDER = { heng: 0, shu: 1, avatar: 2, emoticon: 3, temporary: 4, '其他': 5 };
  // 提取文件名中的第一段连续数字作为序号；没有数字返回 NaN（视为无穷大，排组尾）
  const numOf = (name) => { const m = String(name).match(/\d+/); return m ? Number(m[0]) : NaN; };
  const isTime = state.sort.startsWith('time');
  if (state.sort === 'sizeDesc') {
    state.lib.sort((a, b) => (b.size || 0) - (a.size || 0)); // 体积降序，分组无关
  } else {
    state.lib.sort((a, b) => {
      if (isTime) return a.mtime - b.mtime; // 时间：升序 = 最早在前
      // 序号：先比分类组序
      const ca = CAT_ORDER[a.category] ?? 99, cb = CAT_ORDER[b.category] ?? 99;
      if (ca !== cb) return ca - cb;
      // 再比文件名数字序号（NaN 当 Infinity 处理，无序号的排组尾）
      const na = numOf(a.name), nb = numOf(b.name);
      const va = Number.isNaN(na) ? Infinity : na, vb = Number.isNaN(nb) ? Infinity : nb;
      if (va !== vb) return va - vb;
      // 序号相同（或都无数字）时按文件名稳定排序
      return String(a.name).localeCompare(String(b.name));
    });
  }
  if (state.sort.endsWith('Desc') && state.sort !== 'sizeDesc') state.lib.reverse(); // 降序：整体反转

  state.selected.clear(); // 筛选变化后清空多选，避免操作到不可见图片
  renderGrid();
}

/** 渲染图片网格（缩略图懒加载；点击=选中；右上角↗=灯箱预览） */
function renderGrid() {
  const grid = $('libGrid');
  grid.innerHTML = '';
  $('libEmpty').hidden = state.lib.length > 0;
  $('libCount').textContent = `${state.lib.length} 张`;
  updateBulkbar();

  for (const row of state.lib) {
    const cell = document.createElement('div');
    cell.className = `cell${state.selected.has(row.rel) ? ' selected' : ''}`;
    cell.dataset.rel = row.rel;
    const dim = row.w && row.h ? `${row.w}×${row.h}` : '';
    cell.innerHTML = `
      <div class="cell-check">✓</div>
      <img class="cell-img" loading="lazy" alt=""
           src="/api/thumb?p=${encodeURIComponent(row.rel)}&w=360" />
      <button class="icon-btn cell-open" title="预览大图">↗</button>
      <div class="cell-info">
        <div class="cell-name" title="${escapeHtml(row.rel)}">${escapeHtml(row.name)}</div>
        <div class="cell-meta"><span>${CAT_NAMES[row.category] || row.category}</span><span>${dim} · ${fmtSize(row.size)}</span></div>
      </div>`;
    // 点击卡片主体 = 切换选中
    cell.addEventListener('click', (e) => {
      if (e.target.closest('.cell-open')) return; // ↗ 按钮单独处理
      toggleSelect(row.rel, cell);
    });
    // ↗ 按钮 = 灯箱预览（←/→ 连续浏览，可直接复制/删除）
    cell.querySelector('.cell-open').addEventListener('click', (e) => {
      e.stopPropagation();
      openLightbox(row.rel);
    });
    grid.appendChild(cell);
  }
}

/** 切换单张选中状态并刷新批量条 */
function toggleSelect(rel, cell) {
  if (state.selected.has(rel)) { state.selected.delete(rel); cell.classList.remove('selected'); }
  else { state.selected.add(rel); cell.classList.add('selected'); }
  updateBulkbar();
}

/** 批量操作条显隐与计数 */
function updateBulkbar() {
  $('bulkbar').hidden = state.selected.size === 0;
  $('selCount').textContent = state.selected.size;
}

/** 当前选中项的 rel 数组 */
function selRels() { return [...state.selected]; }

// 全选 / 取消全选
$('btnSelAll').addEventListener('click', () => {
  state.lib.forEach((r) => state.selected.add(r.rel));
  renderGrid();
});
$('btnSelNone').addEventListener('click', () => { state.selected.clear(); renderGrid(); });

// 筛选控件事件（格式/关键词/排序/大小/宽度均为本地过滤，无需重新请求服务端）
$('fmtFilter').addEventListener('change', () => { state.format = $('fmtFilter').value; applyFilters(); });
$('sizeFilter').addEventListener('change', () => { state.minSize = Number($('sizeFilter').value) || 0; applyFilters(); });
$('widthFilter').addEventListener('change', () => { state.minWidth = Number($('widthFilter').value) || 0; applyFilters(); });
// 排序下拉变化：记住模式后重新过滤+排序渲染
$('sortSel').addEventListener('change', () => { state.sort = $('sortSel').value; applyFilters(); });
let searchTimer = null;
$('searchBox').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.keyword = $('searchBox').value.trim(); applyFilters(); }, 300);
});

// 顶部链接类型切换后，清空旧选择避免新旧链接混用
$('linkType').addEventListener('change', () => {
  state.linkType = $('linkType').value;
});

/** 批量复制链接（格式跟随 bulkbar 中的格式选择） */
$('btnCopySel').addEventListener('click', async () => {
  if (!state.selected.size) { toast('请先选择图片', 'warn'); return; }
  const fmt = $('copyFmt').value;
  try {
    const { text } = await api('/api/links/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: selRels(), linkType: state.linkType, format: fmt })
    });
    await copyText(text);
    const fmtNames = { txt: '纯链接', markdown: 'Markdown', html: 'HTML', bbcode: 'BBCode' };
    toast(`已复制 ${state.selected.size} 条${fmtNames[fmt] || ''}链接`, 'ok');
  } catch (e) { toast(e.message, 'err'); }
});

/** 批量导出链接（格式由用户输入，下载为文件） */
$('btnExportSel').addEventListener('click', async () => {
  if (!state.selected.size) { toast('请先选择图片', 'warn'); return; }
  const fmt = prompt('导出格式：txt / json / csv / markdown', 'txt');
  if (!fmt) return;
  try {
    const { text, count } = await api('/api/links/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: selRels(), linkType: state.linkType, format: fmt })
    });
    const ext = { txt: 'txt', json: 'json', csv: 'csv', markdown: 'md' }[fmt] || 'txt';
    downloadText(`图床链接_${new Date().toISOString().slice(0, 10)}.${ext}`, text);
    toast(`已导出 ${count} 条链接`, 'ok');
  } catch (e) { toast(e.message, 'err'); }
});

/** 批量格式转换（目标格式与替换策略由用户决定） */
$('btnConvertSel').addEventListener('click', async () => {
  if (!state.selected.size) { toast('请先选择图片', 'warn'); return; }
  const target = prompt('目标格式：jpg / png / webp / avif', 'webp');
  if (!target) return;
  const replaceOriginal = confirm('转换完成后是否将原格式文件移入回收站？\n（确定 = 替换原图，取消 = 保留原图）');
  try {
    toast('正在转换…', 'info');
    const { results } = await api('/api/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paths: selRels(), target,
        quality: Number($('optQuality').value) || 100,
        replaceOriginal, allowAnimatedLoss: false
      })
    });
    const okN = results.filter((r) => r.ok).length;
    const fails = results.filter((r) => !r.ok)
      .map((r) => `${r.rel}：${r.error}`).join('\n');
    toast(`转换完成：成功 ${okN}/${results.length}`, okN === results.length ? 'ok' : 'warn');
    if (fails) console.warn(fails);
    refreshLibrary();
    refreshGitStatus();
  } catch (e) { toast(e.message, 'err'); }
});

/** 批量移入回收站（软删除，可恢复） */
$('btnTrashSel').addEventListener('click', async () => {
  if (!state.selected.size) { toast('请先选择图片', 'warn'); return; }
  if (!confirm(`将选中的 ${state.selected.size} 张图片移入回收站？（不直接删除，可随时恢复）`)) return;
  try {
    const { moved } = await api('/api/trash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: selRels() })
    });
    const failN = moved.filter((m) => m.error).length;
    toast(`已移入回收站 ${moved.length - failN} 张${failN ? `，失败 ${failN} 张` : ''}`, failN ? 'warn' : 'ok');
    refreshLibrary();
    refreshGitStatus();
  } catch (e) { toast(e.message, 'err'); }
});

/* ---------- 查重面板 ---------- */

$('btnDupScan').addEventListener('click', async () => {
  $('dupPanel').hidden = false;
  $('dupBody').innerHTML = '<div class="empty">正在扫描（首次全量需计算全部图片指纹）…</div>';
  $('dupIgnoredSec') && $('dupIgnoredSec').remove(); // 重扫后重建"已忽略"区块
  try {
    const r = await api('/api/duplicates/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deep: true })
    });
    $('dupMeta').textContent =
      `已扫描 ${r.scanned} 张 · 完全重复组 ${r.exactGroups.length} · 相似组 ${r.similarGroups.length}` +
      (r.ignoredPairs ? ` · 已忽略 ${r.ignoredPairs} 张` : '');
    renderDupGroups(r.exactGroups, '完全重复（字节级相同）');
    renderDupGroups(r.similarGroups, '疑似相似（感知哈希）', true);
    if (!r.exactGroups.length && !r.similarGroups.length) {
      $('dupBody').insertAdjacentHTML('beforeend', '<div class="empty">未发现重复或相似图片</div>');
    }
    if (r.ignoredPairs > 0) await appendIgnoredSection();
  } catch (e) {
    $('dupBody').innerHTML = `<div class="empty">扫描失败：${escapeHtml(e.message)}</div>`;
  }
});

/** 在查重面板底部追加"已忽略的图片"管理区块（取消忽略后下次扫描重新参与归组） */
async function appendIgnoredSection() {
  let ignored;
  try { ignored = await api('/api/duplicates/ignored'); }
  catch (e) { return; }
  if (!ignored.items.length) return;
  const sec = document.createElement('div');
  sec.className = 'dup-group ignored-sec';
  sec.id = 'dupIgnoredSec';
  sec.innerHTML = `
    <div class="dup-group-title"><span class="tag">已忽略</span> ${ignored.items.length} 张
      <span class="muted">（不再参与相似归组；取消忽略后下次扫描生效）</span></div>
    <div class="dup-row">
      ${ignored.items.map((it) => `
        <div class="dup-item">
          <img loading="lazy" src="/api/thumb?p=${encodeURIComponent(it.rel)}&w=264" alt="" />
          <div class="name" title="${escapeHtml(it.rel)}">${escapeHtml(it.name)}</div>
          <div class="muted">${it.sizeText || ''}</div>
          <button class="btn small" data-unignore="${escapeHtml(it.rel)}">取消忽略</button>
        </div>`).join('')}
    </div>`;
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
      // 剩余为空时移除整个区块
      if (!sec.querySelectorAll('.dup-item').length) sec.remove();
    } catch (e2) { toast(e2.message, 'err'); }
  });
  $('dupBody').appendChild(sec);
}

/** 渲染一组重复/相似图片（每组可整体勾选后移入回收站；支持"保留最高清"一键清理；
 *  疑似相似组额外支持"忽略本组"——确认不是重复后不再归组提示） */
function renderDupGroups(groups, label, ignorable = false) {
  if (!groups.length) return;
  const body = $('dupBody');
  groups.forEach((g, gi) => {
    const sec = document.createElement('div');
    sec.className = 'dup-group';
    // 预计算"保留最高清"目标：像素面积最大者（并列取靠前者）
    let best = 0;
    g.forEach((it, i) => {
      if ((it.w || 0) * (it.h || 0) > (g[best].w || 0) * (g[best].h || 0)) best = i;
    });
    sec.innerHTML = `
      <div class="dup-group-title"><span class="tag">${label}</span> 第 ${gi + 1} 组（${g.length} 张）
        <label style="margin-left:8px"><input type="checkbox" class="dup-group-sel" /> 全选本组</label>
        <button class="btn small warn keep-best" style="margin-left:8px"
          title="保留分辨率最高的一张，其余移入回收站">保留最高清</button>
        ${ignorable ? `<button class="btn small ignore-group" style="margin-left:8px"
          title="这些图只是画风相似——之后查重不再提示它们（其他图片之间的提示不受影响）">忽略本组</button>` : ''}
        <button class="btn small danger" style="margin-left:8px">删除所选</button>
      </div>
      <div class="dup-row">
        ${g.map((it, i) => `
          <div class="dup-item${i === best ? ' best' : ''}">
            <img loading="lazy" src="/api/thumb?p=${encodeURIComponent(it.rel)}&w=264" alt="" />
            <label><input type="checkbox" class="dup-item-sel" value="${escapeHtml(it.rel)}"
              ${i === best ? 'disabled data-best="1"' : ''} /> 删除</label>
            <div class="name" title="${escapeHtml(it.rel)}">${escapeHtml(it.name)}${i === best ? ' ⭐' : ''}</div>
            <div class="muted">${it.w && it.h ? `${it.w}×${it.h} · ` : ''}${it.sizeText}</div>
          </div>`).join('')}
      </div>`;
    // 组内全选/取消全选（"保留最高清"那张不参与勾选）
    sec.querySelector('.dup-group-sel').addEventListener('change', (e) => {
      sec.querySelectorAll('.dup-item-sel:not([data-best])').forEach((c) => { c.checked = e.target.checked; });
    });
    // 一键"保留最高清"：其余全部移入回收站
    sec.querySelector('.keep-best').addEventListener('click', async () => {
      const rels = g.map((it) => it.rel).filter((rel) => rel !== g[best].rel);
      if (!rels.length) { toast('本组只有一张，无需清理', 'warn'); return; }
      if (!confirm(`保留 ${g[best].name}（${g[best].w}×${g[best].h}），其余 ${rels.length} 张移入回收站？`)) return;
      try {
        await api('/api/trash', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paths: rels })
        });
        toast(`已保留最高清一张，${rels.length} 张移入回收站`, 'ok');
        sec.remove();
        refreshLibrary();
        refreshGitStatus();
      } catch (e) { toast(e.message, 'err'); }
    });
    // 忽略本组：组内图片全部静音，之后相似归组彻底跳过这些图
    const ignoreBtn = sec.querySelector('.ignore-group');
    if (ignoreBtn) {
      ignoreBtn.addEventListener('click', async () => {
        if (!confirm(`忽略本组 ${g.length} 张图片？\n它们之后不再参与相似归组（其他图片之间的相似提示不受影响），\n可随时在面板底部"已忽略"中取消。`)) return;
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
    // 手动删除所选
    sec.querySelector('.btn.danger').addEventListener('click', async () => {
      const rels = [...sec.querySelectorAll('.dup-item-sel:checked')].map((c) => c.value);
      if (!rels.length) { toast('请先勾选要删除的图片（建议保留一张）', 'warn'); return; }
      if (!confirm(`将勾选的 ${rels.length} 张移入回收站？`)) return;
      try {
        await api('/api/trash', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paths: rels })
        });
        toast('已移入回收站', 'ok');
        sec.remove();
        refreshLibrary();
        refreshGitStatus();
      } catch (e) { toast(e.message, 'err'); }
    });
    body.appendChild(sec);
  });
}

/* ---------- 回收站面板 ---------- */

/** 打开回收站：按批次分组展示（缩略图 / 单条恢复 / 整批恢复 / 单条彻底删除） */
$('btnTrash').addEventListener('click', async () => {
  $('trashPanel').hidden = false;
  $('trashBody').innerHTML = '<div class="empty">加载中…</div>';
  try {
    const rows = await api('/api/trash');
    $('btnTrashPurgeAll').hidden = rows.length === 0;
    if (!rows.length) { $('trashBody').innerHTML = '<div class="empty">回收站是空的</div>'; return; }
    // 按 batchId 分组（listTrash 已按时间倒序）
    const byBatch = new Map();
    for (const r of rows) {
      if (!byBatch.has(r.batchId)) byBatch.set(r.batchId, []);
      byBatch.get(r.batchId).push(r);
    }
    $('trashBody').innerHTML = '';
    for (const [batchId, items] of byBatch) {
      const sec = document.createElement('div');
      sec.className = 'dup-group';
      sec.innerHTML = `
        <div class="dup-group-title">
          <span class="tag">批次 ${escapeHtml(batchId)}</span> ${items.length} 项
          <button class="btn small restore-batch" style="margin-left:8px">整批恢复</button>
          <button class="btn small danger purge-batch" title="不可恢复">清空本批</button>
        </div>
        <div class="dup-row">
          ${items.map((r) => `
            <div class="dup-item">
              <img loading="lazy" src="/api/trash/thumb?b=${encodeURIComponent(r.batchId)}&f=${encodeURIComponent(r.flat)}" alt="" />
              <div class="name" title="${escapeHtml(r.rel)}">${escapeHtml(r.rel)}</div>
              <div class="muted">${r.sizeText} · ${fmtTime(r.trashedAt)}</div>
              <div>
                <button class="btn small" data-batch="${escapeHtml(r.batchId)}" data-flat="${escapeHtml(r.flat)}">恢复</button>
                <button class="btn small danger" data-purge-batch="${escapeHtml(r.batchId)}" data-purge-flat="${escapeHtml(r.flat)}"
                  title="彻底删除，不可恢复">✕</button>
              </div>
            </div>`).join('')}
        </div>`;
      // 整批恢复
      sec.querySelector('.restore-batch').addEventListener('click', async () => {
        if (!confirm(`恢复批次 ${batchId} 的全部 ${items.length} 项？\n（编号已被占用时会自动改号）`)) return;
        try {
          const { results } = await api('/api/trash/restore-batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ batchId })
          });
          const okN = results.filter((r) => !r.error).length;
          const renN = results.filter((r) => r.renamed).length;
          toast(`已恢复 ${okN}/${results.length} 项${renN ? `（${renN} 项因编号占用自动改号）` : ''}`, 'ok');
          sec.remove();
          refreshLibrary();
          refreshGitStatus();
        } catch (e) { toast(e.message, 'err'); }
      });
      // 清空本批（不可逆）
      sec.querySelector('.purge-batch').addEventListener('click', async () => {
        if (!confirm(`彻底删除批次 ${batchId} 的全部 ${items.length} 项？\n⚠ 此操作不可恢复！`)) return;
        try {
          await api('/api/trash/purge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ batchId })
          });
          toast('批次已彻底删除', 'ok');
          sec.remove();
        } catch (e) { toast(e.message, 'err'); }
      });
      $('trashBody').appendChild(sec);
    }
  } catch (e) {
    $('trashBody').innerHTML = `<div class="empty">加载失败：${escapeHtml(e.message)}</div>`;
  }
});

// 单条恢复 / 单条彻底删除（事件委托）
$('trashBody').addEventListener('click', async (e) => {
  const purgeBtn = e.target.closest('[data-purge-batch]');
  if (purgeBtn) {
    if (!confirm(`彻底删除 ${purgeBtn.dataset.purgeFlat}？\n⚠ 此操作不可恢复！`)) return;
    try {
      await api('/api/trash/purge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchId: purgeBtn.dataset.purgeBatch, flats: [purgeBtn.dataset.purgeFlat] })
      });
      purgeBtn.closest('.dup-item').remove();
      toast('已彻底删除', 'ok');
    } catch (e2) { toast(e2.message, 'err'); }
    return;
  }
  const btn = e.target.closest('[data-batch]');
  if (!btn) return;
  try {
    const { restored, renamed } = await api('/api/trash/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batchId: btn.dataset.batch, flat: btn.dataset.flat })
    });
    toast(renamed ? `目标编号已被占用，已恢复为：${restored}` : `已恢复：${restored}`, 'ok');
    btn.closest('.dup-item').remove();
    refreshLibrary();
    refreshGitStatus();
  } catch (e2) { toast(e2.message, 'err'); }
});

// 清空整个回收站（不可逆）
$('btnTrashPurgeAll').addEventListener('click', async () => {
  if (!confirm('⚠ 彻底清空回收站全部批次？\n此操作不可恢复！')) return;
  try {
    const rows = await api('/api/trash');
    const batchIds = [...new Set(rows.map((r) => r.batchId))];
    for (const batchId of batchIds) {
      await api('/api/trash/purge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchId })
      });
    }
    toast(`已清空回收站（${batchIds.length} 个批次）`, 'ok');
    $('trashBody').innerHTML = '<div class="empty">回收站是空的</div>';
    $('btnTrashPurgeAll').hidden = true;
  } catch (e) { toast(e.message, 'err'); }
});

/* ---------- 批量移动分类 ---------- */

$('btnMoveSel').addEventListener('click', () => {
  if (!state.selected.size) { toast('请先选择图片', 'warn'); return; }
  const cat = prompt('目标分类：heng / shu / avatar / emoticon / temporary', 'avatar');
  if (!cat) return;
  if (!['heng', 'shu', 'avatar', 'emoticon', 'temporary'].includes(cat)) {
    toast(`无效分类：${cat}`, 'err'); return;
  }
  let theme = '';
  if (cat === 'emoticon') {
    theme = prompt('表情包主题（目标文件夹名）：', '默认');
    if (!theme) return;
  }
  moveSelected(cat, theme);
});

async function moveSelected(category, theme) {
  if (!confirm(`将选中的 ${state.selected.size} 张移动到「${CAT_NAMES[category] || category}${theme ? '/' + theme : ''}」？\n（目标目录内按最大编号续排；旧链接将失效）`)) return;
  try {
    toast('正在移动…', 'info');
    const { results, movedCount } = await api('/api/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: selRels(), category, theme })
    });
    toast(movedCount === results.length
      ? `已移动 ${movedCount} 张`
      : `移动失败，已全部回滚（${results.find((r) => r.error) && results.find((r) => r.error).error || '未知错误'}）`,
      movedCount === results.length ? 'ok' : 'err');
    refreshLibrary();
    refreshGitStatus();
  } catch (e) { toast(e.message, 'err'); }
}

/* ---------- 整理面板（编号规整 / 主题改名） ---------- */

$('btnOrganize').addEventListener('click', () => {
  const body = $('organizeBody');
  // 收集目录清单（标准分类目录 + 表情包主题目录）
  const dirs = [...new Set(state.libAll.map((r) => r.rel.split('/').slice(0, -1).join('/')))]
    .filter(Boolean).sort();
  body.innerHTML = `
    <h4 style="margin:6px 0 4px">编号规整</h4>
    <p class="muted" style="margin:4px 0 8px">把目录内文件重排为 0001..N 连续编号，消除删除留下的空洞。
      <b>注意：已发布的链接按文件名寻址，重排后旧链接会失效！</b></p>
    <div class="opt-grid">
      <label class="opt">
        <span class="opt-label">选择目录</span>
        <select id="orgDir">${dirs.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('')}</select>
      </label>
    </div>
    <div class="queue-actions">
      <button class="btn primary" id="btnRenumber">规整所选目录</button>
    </div>
    <h4 style="margin:16px 0 4px">表情包主题改名</h4>
    <div class="opt-grid">
      <label class="opt">
        <span class="opt-label">现有主题</span>
        <select id="orgTheme">${dirs.filter((d) => d.startsWith('emoticon/'))
          .map((d) => `<option value="${escapeHtml(d.slice('emoticon/'.length))}">${escapeHtml(d.slice('emoticon/'.length))}</option>`).join('')}</select>
      </label>
      <label class="opt">
        <span class="opt-label">新主题名</span>
        <input type="text" id="orgNewTheme" placeholder="例如：流光2" />
      </label>
    </div>
    <div class="queue-actions">
      <button class="btn primary" id="btnRenameTheme">重命名主题</button>
    </div>`;
  $('organizePanel').hidden = false;

  $('btnRenumber').addEventListener('click', async () => {
    const dir = $('orgDir').value;
    if (!confirm(`把「${dir}」内的文件重排为 0001..N 连续编号？\n⚠ 该目录内编号≥起点的文件旧链接将全部失效！`)) return;
    try {
      toast('正在规整…', 'info');
      const r = await api('/api/renumber', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir })
      });
      toast(`规整完成：共 ${r.total} 个文件，重命名 ${r.renumbered} 个`, 'ok');
      $('organizePanel').hidden = true;
      refreshLibrary();
      refreshGitStatus();
    } catch (e) { toast(e.message, 'err'); }
  });

  $('btnRenameTheme').addEventListener('click', async () => {
    const from = $('orgTheme').value;
    const to = $('orgNewTheme').value.trim();
    if (!from || !to) { toast('请填写新主题名', 'warn'); return; }
    if (!confirm(`把表情包主题「${from}」改名为「${to}」？\n（目录内 ${'所有'} 文件随之迁移，旧主题链接失效）`)) return;
    try {
      const r = await api('/api/rename-theme', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to })
      });
      toast(`已改名：${r.oldRel} → ${r.newRel}（${r.count} 个文件）`, 'ok');
      $('organizePanel').hidden = true;
      refreshLibrary();
      refreshGitStatus();
    } catch (e) { toast(e.message, 'err'); }
  });
});

/* ---------- 灯箱（大图预览：←/→ 切换、Esc 关闭、就地复制/删除） ---------- */

const lb = {
  list: [],   // 当前可导航的 rel 列表（= 过滤后网格顺序）
  pos: -1     // 当前下标
};

function openLightbox(rel) {
  lb.list = state.lib.map((r) => r.rel);
  lb.pos = lb.list.indexOf(rel);
  if (lb.pos < 0) return;
  $('lightbox').hidden = false;
  renderLightbox();
}

function closeLightbox() { $('lightbox').hidden = true; }

function lbStep(delta) {
  if (!lb.list.length) return;
  lb.pos = (lb.pos + delta + lb.list.length) % lb.list.length; // 循环浏览
  renderLightbox();
}

function renderLightbox() {
  const rel = lb.list[lb.pos];
  const row = state.libAll.find((r) => r.rel === rel) || {};
  $('lbImg').src = `/api/raw?p=${encodeURIComponent(rel)}`;
  $('lbTitle').textContent = row.name || rel;
  $('lbTitle').title = rel;
  $('lbMeta').textContent =
    `${lb.pos + 1}/${lb.list.length} · ${CAT_NAMES[row.category] || row.category || ''}` +
    `${row.w ? ` · ${row.w}×${row.h}` : ''}${row.size ? ` · ${fmtSize(row.size)}` : ''}`;
}

$('lbPrev').addEventListener('click', () => lbStep(-1));
$('lbNext').addEventListener('click', () => lbStep(1));
$('lbClose').addEventListener('click', closeLightbox);
// 点击遮罩空白处关闭（点图片/按钮不关）
$('lightbox').addEventListener('click', (e) => { if (e.target === $('lightbox')) closeLightbox(); });

// 键盘导航：仅在灯箱打开时生效
document.addEventListener('keydown', (e) => {
  if ($('lightbox').hidden) return;
  if (e.key === 'Escape') closeLightbox();
  else if (e.key === 'ArrowLeft') lbStep(-1);
  else if (e.key === 'ArrowRight') lbStep(1);
});

// 灯箱内复制链接（跟随顶部链接类型）
$('lbCopy').addEventListener('click', async () => {
  const rel = lb.list[lb.pos];
  if (!rel) return;
  try {
    const b = await api(`/api/link?p=${encodeURIComponent(rel)}&type=${state.linkType}`);
    await copyText(b.url);
    toast('链接已复制', 'ok');
  } catch (e) { toast(e.message, 'err'); }
});

// 灯箱内直接移入回收站并自动跳到下一张
$('lbTrash').addEventListener('click', async () => {
  const rel = lb.list[lb.pos];
  if (!rel) return;
  if (!confirm(`将 ${rel} 移入回收站？（可恢复）`)) return;
  try {
    await api('/api/trash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [rel] })
    });
    toast('已移入回收站', 'ok');
    lb.list.splice(lb.pos, 1);
    if (!lb.list.length) { closeLightbox(); }
    else { lb.pos %= lb.list.length; renderLightbox(); }
    refreshLibrary();
    refreshGitStatus();
  } catch (e) { toast(e.message, 'err'); }
});

/* ================================================================
 * 5. 统计视图
 * ================================================================ */

/** 环形图配色（克制的主色系衍生色板） */
const PALETTE = ['#4f6ef2', '#7c5cf0', '#3aa675', '#e0a13e', '#d9776e', '#5aa9e6', '#9aa2b1'];

async function refreshStats() {
  try {
    state.stats = await api('/api/stats');
    renderStats(state.stats);
  } catch (e) { toast(`统计加载失败：${e.message}`, 'err'); }
}

function renderStats(s) {
  // —— 汇总卡片 ——
  $('statCards').innerHTML = `
    <div class="stat-card"><div class="stat-num">${s.total.count}</div><div class="stat-label">图片总数</div></div>
    <div class="stat-card"><div class="stat-num">${s.total.sizeText}</div><div class="stat-label">占用空间</div></div>
    <div class="stat-card"><div class="stat-num">${s.categoryCount}</div><div class="stat-label">分类数</div></div>
    <div class="stat-card"><div class="stat-num">${Object.keys(s.byFormat).length}</div><div class="stat-label">格式数</div></div>`;

  // —— 分类占比环形图（纯 SVG，无第三方库） ——
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
    <div class="legend-item">
      <span class="legend-dot" style="background:${PALETTE[i % PALETTE.length]}"></span>
      <span>${CAT_NAMES[cat] || cat}：${v.count} 张 · ${v.sizeText}</span>
    </div>`).join('');
  $('donutWrap').innerHTML = `
    <svg viewBox="0 0 120 120" width="150" height="150" role="img" aria-label="分类占比环形图">${segs}</svg>
    <div class="legend">${legend}</div>`;

  // —— 格式分布条形图 ——
  const fmts = Object.entries(s.byFormat).sort((a, b) => b[1].count - a[1].count);
  const maxN = Math.max(1, ...fmts.map(([, v]) => v.count));
  $('fmtBars').innerHTML = fmts.map(([f, v]) => `
    <div class="bar-row">
      <span>${escapeHtml(f.toUpperCase())}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${(v.count / maxN * 100).toFixed(1)}%"></div></div>
      <span class="bar-val">${v.count} 张 · ${fmtSize(v.size)}</span>
    </div>`).join('') || '<div class="empty">暂无数据</div>';

  // —— 分类明细（数量 / 容量 / 编号使用进度） ——
  $('catDetail').innerHTML = cats.map(([cat, v]) => `
    <div class="cat-detail-row">
      <span>${CAT_NAMES[cat] || cat}</span>
      <div>
        <div class="usage-track"><div class="usage-fill" style="width:${Math.min(100, v.usage)}%"></div></div>
        <div class="usage-text">编号已用至 ${String(v.maxNumber).padStart(4, '0')} / ${v.cap}（${v.usage}%）</div>
      </div>
      <span class="muted">${v.count} 张 · ${v.sizeText}</span>
    </div>`).join('') || '<div class="empty">暂无数据</div>';

  // —— 最近更新列表 ——
  $('recentList').innerHTML = s.latest.map((r) => `
    <div class="recent-row">
      <span class="name" title="${escapeHtml(r.rel)}">${escapeHtml(r.rel)}</span>
      <span class="time">${fmtTime(r.mtime)}</span>
    </div>`).join('') || '<div class="empty">暂无数据</div>';

  // —— 近 12 个月新增条形图（按图库全量列表的 mtime 聚合；无全量数据时跳过） ——
  if (state.libAll.length) {
    const now = new Date();
    const months = []; // [{key:'YYYY-MM', label:'MM月', count, size}]
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({
        key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
        label: `${d.getMonth() + 1}月`,
        count: 0, size: 0
      });
    }
    const byKey = new Map(months.map((m) => [m.key, m]));
    for (const r of state.libAll) {
      const d = new Date(r.mtime);
      const m = byKey.get(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
      if (m) { m.count += 1; m.size += r.size || 0; }
    }
    const maxC = Math.max(1, ...months.map((m) => m.count));
    $('trendBars').innerHTML = months.map((m) => `
      <div class="bar-row" title="${m.key}：${m.count} 张 · ${fmtSize(m.size)}">
        <span>${m.label}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${(m.count / maxC * 100).toFixed(1)}%"></div></div>
        <span class="bar-val">${m.count} 张 · ${fmtSize(m.size)}</span>
      </div>`).join('');
  }
}

/* ================================================================
 * 6. Git 同步
 * ================================================================ */

/** 刷新未同步变更数徽标 */
async function refreshGitStatus() {
  const badge = $('gitCount');
  try {
    const st = await api('/api/git/status');
    badge.textContent = st.count;
    badge.classList.toggle('warn', st.count > 0);
  } catch (e) {
    badge.textContent = '!';
    badge.classList.add('warn');
  }
}

/** 手动同步到 GitHub（显式确认后执行） */
$('btnGitSync').addEventListener('click', async () => {
  if (!confirm('将图库全部变更提交并推送到 GitHub？')) return;
  const btn = $('btnGitSync');
  btn.disabled = true;
  btn.textContent = '同步中…';
  try {
    const r = await api('/api/git/sync', { method: 'POST' });
    toast(r.message, r.ok ? 'ok' : 'warn');
    if (r.steps) console.table(r.steps);
    refreshGitStatus();
  } catch (e) {
    toast(`同步失败：${e.message}`, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '同步到 GitHub';
  }
});

// 点击徽标 = 手动刷新状态
$('btnGitStatus').addEventListener('click', refreshGitStatus);

/* ================================================================
 * 6.5 设置面板（读写 config.json 白名单字段）
 * ================================================================ */

/** 打开设置面板：拉取服务端当前值填充表单 */
$('btnSettings').addEventListener('click', async () => {
  try {
    const view = await api('/api/settings');
    $('setQuality').value = view['upload.quality'].value;
    $('setQualityVal').textContent = view['upload.quality'].value;
    $('setMaxBatch').value = view['upload.maxBatchFiles'].value;
    $('setMaxFileMB').value = view['upload.maxFileMB'].value;
    $('setHamming').value = view['dedup.hammingThreshold'].value;
    $('setOnDup').value = view['dedup.onExactDuplicate'].value;
    $('setLinkFormat').value = view['linkFormat'].value;
    $('setPurgeCdn').checked = !!view['git.purgeCdn'].value;
    $('settingsPanel').hidden = false;
  } catch (e) { toast(`设置加载失败：${e.message}`, 'err'); }
});

$('setQuality').addEventListener('input', () => {
  $('setQualityVal').textContent = $('setQuality').value;
});

/** 保存设置：提交白名单字段，成功后同步本地 UI（质量滑杆 / 批量上限 / 链接格式） */
$('btnSaveSettings').addEventListener('click', async () => {
  try {
    await api('/api/settings', {
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
    // 同步到当前界面的对应控件
    $('optQuality').value = $('setQuality').value;
    $('qualityVal').textContent = $('setQuality').value;
    $('maxBatch').textContent = $('setMaxBatch').value;
    state.linkType = $('setLinkFormat').value;
    $('linkType').value = state.linkType;
    $('settingsPanel').hidden = true;
    toast('设置已保存（写入了 manager/config.json）', 'ok');
  } catch (e) { toast(`保存失败：${e.message}`, 'err'); }
});

/* ================================================================
 * 7. 初始化
 * ================================================================ */

(async function init() {
  try {
    state.cfg = await api('/api/config');
    state.linkType = state.cfg.linkFormat || 'jsdelivr';
    $('linkType').value = state.linkType;
    $('repoLabel').textContent = `${state.cfg.repo.owner}/${state.cfg.repo.name}`;
    $('maxBatch').textContent = state.cfg.upload.maxBatchFiles;
    refreshGitStatus();
  } catch (e) {
    toast(`初始化失败：${e.message}`, 'err');
  }
})();
