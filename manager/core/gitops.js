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
 * 以 Promise 包装 execFile，附带超时与 utf8 输出。
 * GIT_TERMINAL_PROMPT=0：网络/凭据异常时直接失败并返回错误，避免 git 在后台
 * 等待用户名密码输入而一直挂到超时。
 */
function run(repoRoot, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    },
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
 * 读取图库范围内的变更摘要 + 本地分支领先/落后情况（同步前预览）
 * @returns {{ok:boolean, count:number, entries:Array, branch:string, upstream:string,
 *   ahead:number, behind:number, pendingPush:boolean, lastCommit:string, error?:string}}
 */
async function status(cfg) {
  const root = cfg._paths.repoRoot;
  const { err, stdout, stderr } = await run(root,
    ['status', '--porcelain', '--', cfg.imageRoot], 15000);
  if (err) {
    return {
      ok: false, error: stderr || err.message, count: 0, entries: [],
      branch: '', upstream: '', ahead: 0, behind: 0, pendingPush: false, lastCommit: ''
    };
  }
  const entries = stdout.split('\n').map((s) => s.trim()).filter(Boolean)
    .map((line) => ({ flag: line.slice(0, 2).trim(), path: line.slice(2).trim() }));

  const branchRes = await run(root, ['rev-parse', '--abbrev-ref', 'HEAD'], 10000);
  const branch = branchRes.err ? '' : branchRes.stdout.trim();
  const upstreamRes = await run(root,
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], 10000);
  const upstream = upstreamRes.err ? '' : upstreamRes.stdout.trim();

  // 有 upstream 时看 origin/xxx..HEAD；没有 upstream 时退化为"不在任何远端上的提交"
  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const [a, b] = await Promise.all([
      run(root, ['rev-list', '--count', '@{u}..HEAD'], 10000),
      run(root, ['rev-list', '--count', 'HEAD..@{u}'], 10000)
    ]);
    ahead = parseInt(a.stdout, 10) || 0;
    behind = parseInt(b.stdout, 10) || 0;
  } else {
    const a = await run(root, ['rev-list', '--count', 'HEAD', '--not', '--remotes'], 10000);
    ahead = parseInt(a.stdout, 10) || 0;
  }

  const lastRes = await run(root, ['log', '-1', '--pretty=format:%h %s'], 10000);
  const lastCommit = lastRes.err ? '' : lastRes.stdout.trim();

  return {
    ok: true,
    count: entries.length,
    entries,
    branch,
    upstream,
    ahead,
    behind,
    pendingPush: ahead > 0,
    lastCommit
  };
}

/**
 * 把 git push 的报错翻译成可执行的中文提示。
 * retry 表示错误是否可能由网络抖动引起、值得自动重试。
 */
function classifyPushFailure(text) {
  const s = String(text || '');
  if (/non-fast-forward|\[rejected\]|fetch first|failed to push some refs|Updates were rejected/i.test(s)) {
    return { retry: false, hint: '远端有新提交，请先点“同步到 GitHub”拉取并 rebase，再重试推送。' };
  }
  if (/does not appear to be a git repository|No such remote|No configured push destination|Please make sure you have the correct access rights|Repository not found/i.test(s)) {
    return { retry: false, hint: '远端仓库不可访问，请检查 origin 地址与仓库权限。' };
  }
  if (/Authentication failed|could not read Username|Permission denied|HTTP 403|access denied|Invalid username or password/i.test(s)) {
    return { retry: false, hint: 'GitHub 认证失败，请检查本机 Git 凭据（Token / SSH / 凭据管理器）。' };
  }
  if (/Could not resolve host|Failed to connect|Couldn't connect|Connection timed out|Recv failure|RPC failed|HTTP 5\d\d|SSL|TLS|early EOF|unexpected disconnect|remote end hung up|Connection reset|timed out/i.test(s)) {
    return { retry: true, hint: '网络连接失败，请检查代理 / VPN / 网络后重试；提交已在本地保留，不会丢失。' };
  }
  return { retry: true, hint: '推送失败，提交已在本地保留；请检查网络或 Git 配置后重试。' };
}

/**
 * 只推送本地已提交但未推送的提交，不 add、不 commit、不改动工作区。
 * 用于"commit 成功但 push 因网络失败"的补救：随时可以重试，提交不会丢。
 * 网络类错误自动重试最多 3 次（1s/2s 退避）；认证/非快进错误不重试。
 * @returns {{ok:boolean, message:string, steps:Array, ahead:number, branch:string,
 *   upstream:string, error?:string}}
 */
async function pushOnly(cfg) {
  const timeout = Number(cfg.git.timeoutMs) || 120000;
  const root = cfg._paths.repoRoot;
  const steps = [];
  const branch = safeBranch(cfg.repo.branch);
  if (!branch) {
    return {
      ok: false, message: `分支名不合法：${cfg.repo.branch}`,
      steps: [{ step: '检查分支', ok: false, detail: `分支名不合法：${cfg.repo.branch}` }],
      ahead: 0, branch: '', upstream: ''
    };
  }

  const currentRes = await run(root, ['rev-parse', '--abbrev-ref', 'HEAD'], 10000);
  const current = currentRes.err ? '' : currentRes.stdout.trim();
  if (!current || current === 'HEAD') {
    return {
      ok: false, message: '无法确定当前分支（可能是 detached HEAD），请切换到配置分支后重试。',
      steps: [{ step: '检查分支', ok: false, detail: current ? 'detached HEAD' : (currentRes.stderr || '无法读取当前分支') }],
      ahead: 0, branch: '', upstream: ''
    };
  }
  if (current !== branch) {
    return {
      ok: false,
      message: `当前在 ${current} 分支，配置要推送 ${branch}；请切换分支或修改 config.json 后重试。`,
      steps: [{ step: '检查分支', ok: false, detail: `当前 ${current}，配置 ${branch}` }],
      ahead: 0, branch: current, upstream: ''
    };
  }

  const upstreamRes = await run(root,
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], 10000);
  const hasUpstream = !upstreamRes.err;
  const upstream = hasUpstream ? upstreamRes.stdout.trim() : '';

  let ahead = 0;
  if (hasUpstream) {
    const a = await run(root, ['rev-list', '--count', '@{u}..HEAD'], 10000);
    ahead = parseInt(a.stdout, 10) || 0;
  } else {
    const a = await run(root, ['rev-list', '--count', 'HEAD', '--not', '--remotes'], 10000);
    ahead = parseInt(a.stdout, 10) || 0;
  }

  const lastRes = await run(root, ['log', '-1', '--pretty=format:%h %s'], 10000);
  const lastCommit = lastRes.err ? '' : lastRes.stdout.trim();
  steps.push({
    step: '检查待推送提交',
    ok: true,
    detail: ahead > 0
      ? `${ahead} 个提交待推送${lastCommit ? `（最新：${lastCommit}）` : ''}`
      : '没有待推送的提交'
  });
  if (ahead === 0) {
    return { ok: true, message: '本地没有待推送的提交', steps, ahead: 0, branch, upstream };
  }

  const attempts = 3;
  const pushArgs = hasUpstream
    ? ['push', '--', 'origin', branch]
    : ['push', '-u', '--', 'origin', branch];
  let lastDetail = '';
  let lastHint = '';

  for (let i = 1; i <= attempts; i++) {
    // 网络挂起时不要让一次 push 占满整个请求；单次最多 60 秒
    const push = await run(root, pushArgs, Math.min(timeout, 60000));
    if (!push.err) {
      steps.push({
        step: '推送到 GitHub',
        ok: true,
        detail: `已推送 ${ahead} 个提交至 origin/${branch}`
      });
      return {
        ok: true,
        message: `推送完成：${ahead} 个提交已同步到 GitHub`,
        steps, ahead, branch, upstream: `origin/${branch}`
      };
    }

    lastDetail = push.err.killed
      ? `推送超时（单次 ${Math.min(timeout, 60000) / 1000} 秒）${push.stderr ? `：${push.stderr.trim()}` : ''}`
      : (push.stderr || push.err.message || '').trim();
    const info = classifyPushFailure(lastDetail);
    lastHint = info.hint;
    steps.push({
      step: `推送尝试 ${i}/${attempts}`,
      ok: false,
      detail: lastDetail.split('\n').slice(-3).join(' ').slice(0, 500) || '未知错误'
    });

    if (!info.retry || i === attempts) break;
    // 网络抖动退避：1s、2s
    await new Promise((r) => setTimeout(r, i * 1000));
  }

  steps.push({ step: '建议', ok: false, detail: lastHint });
  return {
    ok: false,
    message: `推送失败：${lastHint}`,
    steps, ahead, branch, upstream, error: lastDetail
  };
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
    // 工作区没有变更，但可能存在"已提交、push 失败"的本地提交：补推而不是直接返回
    if (st.ahead > 0) {
      steps.push({ step: '检查本地提交', ok: true, detail: `有 ${st.ahead} 个提交待推送` });
      const pushed = await pushOnly(cfg);
      return { ok: pushed.ok, message: pushed.message, steps: [...steps, ...pushed.steps] };
    }
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

  // 第 4 步：推送（失败不影响本地文件；pushOnly 内含网络重试与中文错误提示）
  const pushed = await pushOnly(cfg);
  steps.push(...pushed.steps);
  const ok = pushed.ok;
  const message = ok
    ? '同步完成：链接约 1~5 分钟内在 jsDelivr 生效（CDN 缓存刷新周期）'
    : pushed.message;

  // 第 5 步（尽力而为）：主动刷新 jsDelivr 缓存。仅同步"覆盖旧路径"（如转换替换原图）
  // 时有意义；纯新增文件的链接本来就是冷的，刷新无害但无用。失败不影响同步结果。
  if (ok && cfg.git.purgeCdn) {
    const branch = safeBranch(cfg.repo.branch) || safeBranch(pushed.branch) || 'main';
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

module.exports = { status, sync, pushOnly };