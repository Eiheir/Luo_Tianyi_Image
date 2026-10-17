'use strict';
/**
 * 模块：Git 手动同步（用户在界面上显式点击"同步到 GitHub"才执行）
 * ---------------------------------------------------------------
 * 安全边界（确保原有图床业务不受影响）：
 *  1. git add 严格限定图库根目录（LTYpicture），绝不把 manager/node_modules
 *     等模块私有文件提交进仓库（manager/.gitignore 亦作第二道防线）
 *  2. commit / push 任一环节失败，仅返回错误文本——已落盘的图片文件不受任何影响，
 *     用户可随时用命令行手动重试
 *  3. 子进程统一超时保护（默认 120 秒），防止网络挂起拖死整个服务
 */

const { execFile } = require('child_process');

/**
 * 以 Promise 包装 execFile，附带超时与 utf8 输出
 */
function run(repoRoot, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: repoRoot, encoding: 'utf8', timeout: timeoutMs, windowsHide: true },
      (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

/**
 * 校验分支名合法性：拒绝以 "-" 开头（会被 git 当成选项）、含空白或 .. ~ ^ : ? * [ \ 等
 * 非法字符的名称，防止分支名被用于向 git 注入额外参数。
 * @returns {string|null} 合法返回分支名，非法返回 null
 */
function safeBranch(name) {
  const b = String(name || '').trim();
  if (!b || /^-/.test(b) || /[\s~^:?*\[\\]/.test(b) || b.includes('..')) return null;
  return b;
}

/**
 * 读取图库范围内的变更摘要（同步前预览）
 * @returns {{count:number, entries:Array<{flag:string, path:string}>}}
 */
async function status(cfg) {
  const { err, stdout, stderr } = await run(cfg._paths.repoRoot,
    ['status', '--porcelain', '--', cfg.imageRoot], 15000);
  if (err) return { ok: false, error: stderr || err.message, count: 0, entries: [] };
  const entries = stdout.split('\n').map((s) => s.trim()).filter(Boolean)
    .map((line) => ({ flag: line.slice(0, 2).trim(), path: line.slice(2).trim() }));
  return { ok: true, count: entries.length, entries };
}

/**
 * 执行完整同步：pull（快进+自动暂存）→ add（限定图库）→ commit → push → CDN 缓存刷新
 * @returns {{ok:boolean, message:string, steps:Array<{step:string, ok:boolean, detail:string}>}}
 */
async function sync(cfg) {
  const timeout = Number(cfg.git.timeoutMs) || 120000;
  const steps = [];
  const stamp = new Date().toLocaleString('zh-CN', { hour12: false });

  // 第 0 步：拉取远端更新。多机使用时本地可能落后 origin（仓库历史里已有多次手动
  // 合并记录）；先 rebase 本地未推送提交、自动暂存/恢复工作区，push 才不会被拒。
  // 失败（如冲突）不中止流程：继续尝试提交，push 被拒时用户可命令行处理。
  const root0 = cfg._paths.repoRoot;
  const pull = await run(root0,
    ['pull', '--rebase', '--autostash', '--', 'origin', safeBranch(cfg.repo.branch) || 'main'],
    timeout);
  steps.push({
    step: '拉取远端更新',
    ok: !pull.err || /up to date|already up to date/i.test(pull.stdout + pull.stderr),
    detail: pull.err ? (pull.stderr || pull.err.message).split('\n')[0] : (pull.stdout.trim().split('\n').pop() || '已是最新')
  });

  // 第 1 步：检查图库范围内是否有变更
  const st = await status(cfg);
  if (!st.ok) {
    steps.push({ step: '检查状态', ok: false, detail: st.error });
    return { ok: false, message: '无法读取 Git 状态', steps };
  }
  if (st.count === 0) {
    return { ok: true, message: '图库没有需要同步的变更', steps };
  }

  // 第 2 步：仅暂存图库目录（关键安全边界）
  const add = await run(cfg._paths.repoRoot, ['add', '--', cfg.imageRoot], timeout);
  steps.push({ step: '暂存图库文件', ok: !add.err, detail: add.err ? (add.stderr || add.err.message) : `${st.count} 项` });
  if (add.err) return { ok: false, message: '暂存失败，已中止（图片文件不受影响）', steps };

  // 第 3 步：提交
  const commit = await run(cfg._paths.repoRoot,
    ['commit', '-m', `图床管理器同步：${st.count} 项变更（${stamp}）`], timeout);
  const commitOk = !commit.err || /nothing to commit/.test(commit.stdout + commit.stderr);
  steps.push({ step: '提交', ok: commitOk, detail: commitOk ? '完成' : (commit.stderr || commit.err.message) });
  if (!commitOk) return { ok: false, message: '提交失败，已中止（图片文件不受影响）', steps };

  // 第 4 步：推送（失败不影响本地文件，可稍后重试）
  // 分支名先校验，并用 "--" 终止 git 的选项解析，避免分支名被当作命令参数注入
  const branch = safeBranch(cfg.repo.branch);
  if (!branch) {
    steps.push({ step: '推送到 GitHub', ok: false, detail: `分支名不合法：${cfg.repo.branch}` });
    return { ok: false, message: '分支名不合法，已跳过推送（本地已提交，可修正配置后重试）', steps };
  }
  const push = await run(cfg._paths.repoRoot, ['push', '--', 'origin', branch], timeout);
  steps.push({ step: '推送到 GitHub', ok: !push.err, detail: push.err ? (push.stderr || push.err.message) : `已推送至 origin/${branch}` });

  let ok = !push.err;
  let message = ok ? '同步完成：链接约 1~5 分钟内在 jsDelivr 生效（CDN 缓存刷新周期）' : '推送失败：本地已提交，可稍后重试推送';

  // 第 5 步（尽力而为）：主动刷新 jsDelivr 缓存。仅同步"覆盖旧路径"（如转换替换原图）
  // 时有意义；纯新增文件的链接本来就是冷的，刷新无害但无用。失败不影响同步结果。
  if (ok && cfg.git.purgeCdn) {
    const purge = await purgeJsDelivrCache(cfg.repo.owner, cfg.repo.name, branch);
    steps.push({ step: '刷新 CDN 缓存', ok: purge.ok, detail: purge.detail });
  }

  return { ok, message, steps };
}

/**
 * 请求 jsDelivr 清除指定仓库/分支的文件缓存（ purge API，无需鉴权，限频 50 次/分钟）。
 * 逐路径请求；部分失败只记录，不抛错——CDN 缓存最终也会自然过期。
 */
async function purgeJsDelivrCache(owner, name, branch) {
  const files = await listChangedFiles();
  if (!files.length) return { ok: true, detail: '无变更文件需要刷新' };
  let okN = 0, failN = 0;
  for (const f of files) {
    const url = `https://purge.jsdelivr.net/gh/${owner}/${name}@${branch}/${f}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.ok) okN += 1; else failN += 1;
    } catch (e) { failN += 1; }
  }
  return { ok: failN === 0, detail: `已刷新 ${okN} 个文件缓存${failN ? `，失败 ${failN}（缓存稍后自动过期）` : ''}` };
}

/** 读取图库范围内本批次实际变更的文件列表（相对图库根，已含 imageRoot 前缀） */
async function listChangedFiles() {
  const { execFile } = require('child_process');
  const runLocal = (args) => new Promise((resolve) => {
    execFile('git', args, { encoding: 'utf8', timeout: 15000, windowsHide: true },
      (err, stdout) => resolve(err ? '' : String(stdout || '')));
  });
  const out = await runLocal(['diff', '--name-only', 'HEAD@{1}']);
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

module.exports = { status, sync };