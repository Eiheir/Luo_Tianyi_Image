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
 * 执行完整同步：add（限定图库）→ commit → push
 * @returns {{ok:boolean, message:string, steps:Array<{step:string, ok:boolean, detail:string}>}}
 */
async function sync(cfg) {
  const timeout = Number(cfg.git.timeoutMs) || 120000;
  const steps = [];
  const stamp = new Date().toLocaleString('zh-CN', { hour12: false });

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
  const push = await run(cfg._paths.repoRoot, ['push', 'origin', cfg.repo.branch], timeout);
  steps.push({ step: '推送到 GitHub', ok: !push.err, detail: push.err ? (push.stderr || push.err.message) : `已推送至 origin/${cfg.repo.branch}` });

  const ok = !push.err;
  return {
    ok,
    message: ok ? '同步完成：链接约 1~5 分钟内在 jsDelivr 生效（CDN 缓存刷新周期）' : '推送失败：本地已提交，可稍后重试推送',
    steps
  };
}

module.exports = { status, sync };
