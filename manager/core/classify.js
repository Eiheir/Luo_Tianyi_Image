'use strict';
/**
 * 模块：自动分类归档与命名规则
 * ---------------------------------------------------------------
 * 分类规则来源：仓库根目录《图片命名规则.md》（仅只读参考，绝不修改该文件）
 *  - 方形 avatar：宽高比（长边/短边）≤ avatarRatioMax（默认 1.2，"接近正方形"）
 *  - 横图 heng  ：宽 > 高（且超出 avatar 范围）
 *  - 竖图 shu   ：宽 ≤ 高（且超出 avatar 范围）
 *  - 表情包 emoticon：由用户上传时显式指定主题，存入 emoticon/<主题>/，3 位数编号
 *  - 临时 temporary：用户强制指定时的中转目录，4 位数编号
 *
 * 编号规则（对应文档"4.1 重复序号处理"）：
 *  - 取目标目录现有最大编号 + 1 起分配，不足位前补 0
 *  - 批量上传在服务端串行处理，编号依次递增，天然不重号
 *  - 落盘前最后一刻仍会复查目标文件是否存在，存在则跳号，双保险
 */

const fsp = require('fs/promises');
const path = require('path');

/** 合法的显式分类（前端下拉可选值） */
const CATEGORIES = ['auto', 'avatar', 'heng', 'shu', 'emoticon', 'temporary'];

/**
 * 分类决策：输入"转正后"的真实宽高（已按 EXIF 方向旋转），返回目标分类。
 * 说明：先判"接近正方形"（长边/短边 ≤ 阈值）再分横竖，避免一张 1.1:1 的图
 * 同时命中"宽>高 → heng"与"接近正方形 → avatar"的规则冲突。
 */
function decideCategory(width, height, cfg) {
  if (!width || !height) return 'temporary'; // 尺寸读取失败时落入临时目录，不盲目归档
  const ratio = Math.max(width, height) / Math.min(width, height);
  if (ratio <= Number(cfg.classify.avatarRatioMax)) {
    return 'avatar';
  }
  return width > height ? 'heng' : 'shu';
}

/** 表情包主题名安全化：剔除路径分隔符与 Windows 非法字符，防目录注入 */
function sanitizeTheme(theme) {
  const t = String(theme || '').replace(/[\\/:*?"<>|.]/g, '').trim();
  return t || '默认';
}

/**
 * 计算某分类对应的目标目录（相对图库根，统一用 / 分隔，便于生成 URL 与索引键）
 * @param {string} category avatar|heng|shu|emoticon|temporary
 * @param {string} theme    表情包主题（仅 emoticon 分类使用）
 */
function categoryDir(category, theme, cfg) {
  const c = cfg.classify;
  switch (category) {
    case 'emoticon':
      return `${c.emoticonDir}/${sanitizeTheme(theme)}`;
    case 'temporary':
      return c.temporaryDir.replace(/\\/g, '/');
    case 'avatar':
    case 'heng':
    case 'shu':
      return `${c.wallpaperDir}/${category}`;
    default:
      throw new Error(`未知分类：${category}`);
  }
}

/**
 * 从目录内现有文件中解析最大编号。
 * 仅匹配 纯数字编号.图片后缀 的文件（如 0001.jpg），忽略其他文件。
 * @returns {number} 最大编号；目录为空或无编号文件时返回 0
 */
async function scanMaxNumber(dirAbs, allowedExt) {
  const extSet = new Set(allowedExt.map((e) => e.toLowerCase()));
  let max = 0;
  let entries;
  try {
    entries = await fsp.readdir(dirAbs);
  } catch (e) {
    if (e.code === 'ENOENT') return 0; // 目录尚不存在视为空目录
    throw e;
  }
  for (const name of entries) {
    const m = name.match(/^(\d+)\.(\w+)$/);
    if (!m) continue;
    if (!extSet.has(m[2].toLowerCase())) continue;
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

/**
 * 在目标目录内分配一个"当前不存在"的编号文件名。
 * 从 lastNumber+1 起逐个试探，直到文件名未被占用——彻底杜绝重名覆盖。
 * @returns {{number:number, absPath:string, fileName:string}}
 */
async function allocatePath(dirAbs, lastNumber, padding, ext, cfg) {
  // 目标目录不存在则创建（recursive：只新增目录，不影响既有层级）
  await fsp.mkdir(dirAbs, { recursive: true });
  let n = lastNumber;
  for (;;) {
    n += 1;
    const fileName = `${String(n).padStart(padding, '0')}.${ext}`;
    const absPath = path.join(dirAbs, fileName);
    try {
      // 用 wx 标志独占创建 0 字节探测文件：存在即抛 EEXIST（原子操作，无竞态窗口）
      const fh = await fsp.open(absPath, 'wx');
      await fh.close();
      // 探测成功后立即删除占位，稍后由上传管道正式写入
      await fsp.unlink(absPath);
      return { number: n, absPath, fileName };
    } catch (e) {
      if (e.code === 'EEXIST') continue; // 编号被占，跳号重试
      throw e;
    }
  }
}

module.exports = { CATEGORIES, decideCategory, categoryDir, sanitizeTheme, scanMaxNumber, allocatePath };
