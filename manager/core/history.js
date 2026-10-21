'use strict';
/**
 * 模块：操作历史（谁、什么时候、做了什么）
 * ---------------------------------------------------------------
 * 存储：.cache/logs/history.jsonl（每行一条 JSON，与 error.log 同目录）。
 *  - 只记录"改变图库/远端状态"的动作：上传、移入回收站、恢复、彻底删除、
 *    移动分类、格式转换、编号规整、主题改名、Git 同步；查询类动作不记。
 *  - 追加写，永不修改历史行；单文件超过上限时轮转为 history.jsonl.1
 *    （与 error.log 同一套轮转策略，只保留一份历史备份）。
 *  - 任何写入失败仅打印，不影响主流程（历史是审计，不是业务前提）。
 */

const fsp = require('fs/promises');
const path = require('path');

/** 历史文件大小上限：超过则轮转，防止长期运行无限增长 */
const MAX_HISTORY_BYTES = 2 * 1024 * 1024; // 2MB
/** 单次查询最多返回条数（前端面板分页加载也按此粒度） */
const MAX_READ = 1000;

function historyFile(cfg) {
  return path.join(cfg._paths.logDir, 'history.jsonl');
}

/**
 * 追加一条操作历史。
 * @param {string} type 动作类型：upload/trash/restore/purge/move/convert/renumber/rename-theme/sync
 * @param {string} summary 一行中文摘要（列表直接展示）
 * @param {object} [detail] 可选补充信息（数量、关键路径等，不存敏感内容）
 */
async function record(cfg, type, summary, detail = null) {
  try {
    const entry = { ts: Date.now(), type: String(type || 'unknown'), summary: String(summary || '') };
    if (detail && typeof detail === 'object') entry.detail = detail;
    const file = historyFile(cfg);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    // 轮转：超过上限改名为 .1（覆盖旧备份），与 error.log 策略一致
    const st = await fsp.stat(file).catch(() => null);
    if (st && st.size > MAX_HISTORY_BYTES) {
      await fsp.rename(file, `${file}.1`).catch(() => {});
    }
    await fsp.appendFile(file, JSON.stringify(entry) + '\n', 'utf8');
  } catch (e) {
    console.warn('[历史] 写入失败：', e.message);
  }
}

/**
 * 读取最近的历史记录（新→旧）。文件损坏行直接跳过。
 * @param {number} limit 返回条数上限（默认 200，最大 MAX_READ）
 * @param {number} [offset] 跳过的条数（前端"加载更多"用）
 */
async function list(cfg, limit = 200, offset = 0) {
  limit = Math.max(1, Math.min(MAX_READ, Number(limit) || 200));
  offset = Math.max(0, Number(offset) || 0);
  let raw;
  try {
    raw = await fsp.readFile(historyFile(cfg), 'utf8');
  } catch (e) {
    return { entries: [], total: 0 }; // 还没有任何历史
  }
  const lines = raw.split('\n').filter((l) => l.trim());
  const total = lines.length;
  const entries = [];
  // 从尾部向前取，避免全量解析无关旧行
  for (let i = lines.length - 1; i >= 0 && entries.length < offset + limit; i--) {
    try { entries.push(JSON.parse(lines[i])); } catch (e) { /* 跳过损坏行 */ }
  }
  return { entries: entries.slice(offset, offset + limit), total };
}

module.exports = { record, list, MAX_READ };
