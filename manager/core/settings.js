'use strict';
/**
 * 模块：设置读写（图形化设置界面背后的一层）
 * ---------------------------------------------------------------
 * 设计要点：
 *  - 白名单机制：只允许写入显式列出的 config.json 字段，其余键一律忽略——
 *    防止设置接口把 _paths、repo.owner 等内部/敏感字段改坏。
 *  - 部分字段支持热生效（质量/阈值/重复策略/镜像格式），部分必须重启
 *    （端口/监听地址），publicView 中以 requiresRestart 标注。
 *  - 写回只 patch DEFAULTS 中已存在的键（复用 config.deepMerge 的语义），
 *    不新增、不重排、不破坏 config.json 里的人工注释性内容（"_说明" 等原样保留）。
 */

const fs = require('fs');
const path = require('path');
const { DATA_ROOT, DEFAULTS } = require('./config');

/** 设置界面可读写的字段白名单：键 → 校验/规范化函数（返回 null 表示值非法） */
const SETTABLE = {
  'upload.quality': (v) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= 30 && n <= 100 ? n : null;
  },
  'upload.maxBatchFiles': (v) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= 1 && n <= 1000 ? n : null;
  },
  'upload.maxFileMB': (v) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= 1 && n <= 500 ? n : null;
  },
  'dedup.hammingThreshold': (v) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= 0 && n <= 20 ? n : null;
  },
  'dedup.onExactDuplicate': (v) => (['skip', 'keep'].includes(v) ? v : null),
  'linkFormat': (v) => (['jsdelivr', 'fastly', 'testingcf', 'gcore', 'raw'].includes(v) ? v : null),
  'git.purgeCdn': (v) => (typeof v === 'boolean' ? v : null)
};

/** 白名单内的键是否需要重启才能生效（端口/地址类不开放设置，故目前全部可热生效） */
const REQUIRES_RESTART = new Set([]);

/** 读 config.json 的原始对象（损坏/缺失按空对象处理，与 config.loadConfig 一致） */
function readUserConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_ROOT, 'config.json'), 'utf8'));
  } catch (e) {
    return {};
  }
}

/** 原子写回 config.json：保留文件中的所有原始键（含 "_说明"），只 patch 白名单字段 */
function writeUserConfig(user) {
  const file = path.join(DATA_ROOT, 'config.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(user, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 按点路径读取对象字段
 * @returns {*} 找不到返回 undefined
 */
function getPath(obj, dotKey) {
  let cur = obj;
  for (const k of dotKey.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

/** 按点路径写入对象字段（中间层不存在时创建） */
function setPath(obj, dotKey, value) {
  const keys = dotKey.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] == null || typeof cur[keys[i]] !== 'object') cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

/**
 * 应用设置更新：校验 → 写 config.json → 返回热生效用的运行配置片段。
 * 全部值非法时抛错；部分非法时跳过非法项，并在 invalid 中列明，前端据此提示。
 * @returns {{runtime:object, applied:object, invalid:string[]}}
 */
function update(patch) {
  if (!patch || typeof patch !== 'object') throw new Error('无效的设置数据');
  const user = readUserConfig();
  const runtime = {}; // 热生效片段
  const applied = {};
  const invalid = [];
  for (const [key, validate] of Object.entries(SETTABLE)) {
    if (!(key in patch)) continue;
    const value = validate(patch[key]);
    if (value === null) { invalid.push(key); continue; }
    setPath(user, key, value);
    setPath(runtime, key, value);
    applied[key] = value;
  }
  if (Object.keys(applied).length === 0) throw new Error('没有可应用的合法设置项');
  writeUserConfig(user);
  return { runtime, applied, invalid };
}

/** 设置界面的只读视图：当前值 + 默认值 + 是否需重启 */
function publicView(cfg) {
  const view = {};
  for (const key of Object.keys(SETTABLE)) {
    view[key] = {
      value: getPath(cfg, key),
      default: getPath(DEFAULTS, key),
      requiresRestart: REQUIRES_RESTART.has(key)
    };
  }
  return view;
}

module.exports = { update, publicView, SETTABLE };
