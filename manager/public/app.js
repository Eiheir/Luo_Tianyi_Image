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
  linkType: 'jsdelivr', // 链接类型：jsdelivr | raw
  queue: [],          // 上传队列 [{file, previewUrl}]
  lib: [],            // 图片库「过滤后」列表（网格渲染用）
  libAll: [],         // 图片库全量列表（本地过滤的数据源：目录树 / chips / 网格共用）
  selected: new Set(),// 图片库多选集合（rel 相对路径）
  dir: '',            // 当前目录筛选（'' = 图库根；'__other__' = 不属于任何标准目录的散图）
  collapsed: new Set(),// 目录树中处于折叠状态的目录路径集合
  format: 'all',      // 当前格式筛选
  keyword: '',        // 搜索关键词
  sort: 'numAsc',     // 排序模式：numAsc 序号升序 | numDesc 序号降序 | timeAsc 时间升序 | timeDesc 时间降序
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

/** 把本地文件加入上传队列（过滤非图片；生成本地预览 URL） */
function addFiles(fileList) {
  const max = (state.cfg && state.cfg.upload.maxBatchFiles) || 200;
  for (const f of fileList) {
    if (!/^image\//.test(f.type) && !/\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(f.name)) {
      toast(`已跳过非图片文件：${f.name}`, 'warn');
      continue;
    }
    if (state.queue.length >= max) { toast(`单批最多 ${max} 张`, 'warn'); break; }
    state.queue.push({ file: f, previewUrl: URL.createObjectURL(f) });
  }
  renderQueue();
}

/** 渲染上传队列 */
function renderQueue() {
  const list = $('queueList');
  list.innerHTML = '';
  $('queueEmpty').hidden = state.queue.length > 0;
  $('queueActions').hidden = state.queue.length === 0;
  $('btnCopyBatch').hidden = true; // 新队列尚未上传，无链接可复制
  const pending = state.queue.filter((it) => !it.done);
  $('queueSummary').textContent = state.queue.length
    ? `共 ${state.queue.length} 张 · 待上传 ${pending.length}`
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
    row.innerHTML = `
      <img class="qitem-thumb" src="${item.previewUrl}" alt="" />
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

/** 开始上传：组装 FormData（文件 + 批级选项 JSON）提交后端 */
$('btnUpload').addEventListener('click', async () => {
  const pending = state.queue.filter((it) => !it.done);
  if (pending.length === 0) { toast('队列中没有待上传的文件', 'warn'); return; }
  const btn = $('btnUpload');
  btn.disabled = true;
  btn.textContent = '上传处理中…';
  const fd = new FormData();
  fd.append('options', JSON.stringify({
    category: $('optCategory').value,
    theme: $('optTheme').value,
    convert: $('optConvert').value,
    quality: Number($('optQuality').value),
    onDuplicate: $('optDuplicate').value,
    stripMeta: $('optStripMeta').checked
  }));
  for (const it of pending) fd.append('files', it.file, it.file.name);
  try {
    const { results, summary } = await api('/api/upload', { method: 'POST', body: fd });
    // 把服务端结果写回队列项，渲染最终状态
    let ri = 0;
    for (const it of state.queue) {
      if (it.done) continue;
      it.done = true;
      it.result = results[ri++] || { status: 'failed', error: '无结果' };
      if (it.previewUrl) { URL.revokeObjectURL(it.previewUrl); it.previewUrl = ''; }
    }
    renderQueue();
    $('btnCopyBatch').hidden = summary.ok === 0;
    toast(`上传完成：成功 ${summary.ok} · 重复跳过 ${summary.duplicate} · 失败 ${summary.failed}`,
      summary.failed ? 'warn' : 'ok');
    refreshGitStatus(); // 有新文件落盘，未同步数变化
  } catch (e) {
    toast(`上传失败：${e.message}`, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '开始上传';
  }
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

/** 按当前目录 / 格式 / 关键词对全量列表做本地过滤，并按所选模式排序后渲染网格（纯前端，瞬时响应） */
function applyFilters() {
  const d = state.dir;
  const kw = state.keyword.toLowerCase();
  state.lib = state.libAll.filter((r) => {
    if (d === '__other__') { if (r.category !== '其他') return false; }
    else if (d && !r.rel.startsWith(d + '/')) return false; // 目录前缀匹配（含子目录）
    if (state.format !== 'all' && r.format !== state.format) return false;
    if (kw && !r.name.toLowerCase().includes(kw)) return false;
    return true;
  });

  /* ---------- 排序 ----------
   * 序号排序：先按分类分组（横 → 竖 → 方 → 表情包 → 临时 → 其他），
   * 组内按文件名中的数字序号（如 0001.png → 1）；无数字的排在组尾。
   * 时间排序：按文件修改时间 mtime。
   * 降序模式 = 升序结果整体反转（分类组顺序随之反转，保持「完全倒序」语义）。 */
  const CAT_ORDER = { heng: 0, shu: 1, avatar: 2, emoticon: 3, temporary: 4, '其他': 5 };
  // 提取文件名中的第一段连续数字作为序号；没有数字返回 NaN（视为无穷大，排组尾）
  const numOf = (name) => { const m = String(name).match(/\d+/); return m ? Number(m[0]) : NaN; };
  const isTime = state.sort.startsWith('time');
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
  if (state.sort.endsWith('Desc')) state.lib.reverse(); // 降序：整体反转

  state.selected.clear(); // 筛选变化后清空多选，避免操作到不可见图片
  renderGrid();
}

/** 渲染图片网格（缩略图懒加载；点击=选中；右上角↗=打开原图） */
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
      <button class="icon-btn cell-open" title="查看原图">↗</button>
      <div class="cell-info">
        <div class="cell-name" title="${escapeHtml(row.rel)}">${escapeHtml(row.name)}</div>
        <div class="cell-meta"><span>${CAT_NAMES[row.category] || row.category}</span><span>${dim} · ${fmtSize(row.size)}</span></div>
      </div>`;
    // 点击卡片主体 = 切换选中
    cell.addEventListener('click', (e) => {
      if (e.target.closest('.cell-open')) return; // ↗ 按钮单独处理
      toggleSelect(row.rel, cell);
    });
    // ↗ 按钮 = 新标签页打开原图
    cell.querySelector('.cell-open').addEventListener('click', () => {
      window.open(`/api/raw?p=${encodeURIComponent(row.rel)}`, '_blank');
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

// 筛选控件事件（格式/关键词/排序均为本地过滤，无需重新请求服务端）
$('fmtFilter').addEventListener('change', () => { state.format = $('fmtFilter').value; applyFilters(); });
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

/** 批量复制链接 */
$('btnCopySel').addEventListener('click', async () => {
  if (!state.selected.size) { toast('请先选择图片', 'warn'); return; }
  try {
    const { text } = await api('/api/links/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: selRels(), linkType: state.linkType, format: 'txt' })
    });
    await copyText(text);
    toast(`已复制 ${state.selected.size} 条链接（${state.linkType === 'raw' ? 'Raw' : 'CDN'}）`, 'ok');
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
  try {
    const r = await api('/api/duplicates/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deep: true })
    });
    $('dupMeta').textContent = `已扫描 ${r.scanned} 张 · 完全重复组 ${r.exactGroups.length} · 相似组 ${r.similarGroups.length}`;
    renderDupGroups(r.exactGroups, '完全重复（字节级相同）');
    renderDupGroups(r.similarGroups, '疑似相似（感知哈希）');
    if (!r.exactGroups.length && !r.similarGroups.length) {
      $('dupBody').insertAdjacentHTML('beforeend', '<div class="empty">未发现重复或相似图片</div>');
    }
  } catch (e) {
    $('dupBody').innerHTML = `<div class="empty">扫描失败：${escapeHtml(e.message)}</div>`;
  }
});

/** 渲染一组重复/相似图片（每组可整体勾选后移入回收站） */
function renderDupGroups(groups, label) {
  if (!groups.length) return;
  const body = $('dupBody');
  groups.forEach((g, gi) => {
    const sec = document.createElement('div');
    sec.className = 'dup-group';
    sec.innerHTML = `
      <div class="dup-group-title"><span class="tag">${label}</span> 第 ${gi + 1} 组（${g.length} 张）
        <label style="margin-left:8px"><input type="checkbox" class="dup-group-sel" /> 全选本组</label>
        <button class="btn small danger" style="margin-left:8px">删除所选</button>
      </div>
      <div class="dup-row">
        ${g.map((it) => `
          <div class="dup-item">
            <img loading="lazy" src="/api/thumb?p=${encodeURIComponent(it.rel)}&w=264" alt="" />
            <label><input type="checkbox" class="dup-item-sel" value="${escapeHtml(it.rel)}" /> 删除</label>
            <div class="name" title="${escapeHtml(it.rel)}">${escapeHtml(it.name)}</div>
            <div class="muted">${it.sizeText}</div>
          </div>`).join('')}
      </div>`;
    // 组内全选/取消全选
    sec.querySelector('.dup-group-sel').addEventListener('change', (e) => {
      sec.querySelectorAll('.dup-item-sel').forEach((c) => { c.checked = e.target.checked; });
    });
    // 删除所选（第一张默认保留：未勾选任何项时提示）
    sec.querySelector('.btn.danger').addEventListener('click', async () => {
      const rels = [...sec.querySelectorAll('.dup-item-sel:checked')].map((c) => c.value);
      if (!rels.length) { toast('请先勾选要删除的图片（建议每组保留一张）', 'warn'); return; }
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

$('btnTrash').addEventListener('click', async () => {
  $('trashPanel').hidden = false;
  $('trashBody').innerHTML = '<div class="empty">加载中…</div>';
  try {
    const rows = await api('/api/trash');
    if (!rows.length) { $('trashBody').innerHTML = '<div class="empty">回收站是空的</div>'; return; }
    $('trashBody').innerHTML = rows.map((r) => `
      <div class="trash-row">
        <span class="path">${escapeHtml(r.rel)} <span class="muted">${r.sizeText} · ${fmtTime(r.trashedAt)}</span></span>
        <button class="btn small" data-batch="${escapeHtml(r.batchId)}" data-flat="${escapeHtml(r.flat)}">恢复</button>
      </div>`).join('');
  } catch (e) {
    $('trashBody').innerHTML = `<div class="empty">加载失败：${escapeHtml(e.message)}</div>`;
  }
});

// 回收站恢复（事件委托）
$('trashBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-batch]');
  if (!btn) return;
  try {
    const restored = await api('/api/trash/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batchId: btn.dataset.batch, flat: btn.dataset.flat })
    });
    toast(`已恢复：${restored}`, 'ok');
    btn.closest('.trash-row').remove();
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
