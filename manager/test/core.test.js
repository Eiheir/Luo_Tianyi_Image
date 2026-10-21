'use strict';
/**
 * 单元测试：核心纯函数
 * ---------------------------------------------------------------
 * 运行方式：在 manager/ 目录执行 `npm test`（等价于 `node --test`）。
 *
 * 覆盖范围（仅挑选不依赖文件系统/网络/sharp 的纯函数，保证测试轻量且确定性）：
 *  1. config.safeJoinImage  —— 路径穿越防护
 *  2. classify.decideCategory / sanitizeTheme / categoryDir —— 分类与目录规则
 *  3. links.encodeUrlPath / buildLink / exportLinks / linkBundle —— 链接生成与导出
 *
 * 说明：loadConfig 会读取真实配置并可能探测 git，属环境相关逻辑，不纳入单元测试。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { safeJoinImage, DEFAULTS } = require('../core/config');
const classify = require('../core/classify');
const links = require('../core/links');

/** 构造一份最小可用配置：字段与 DEFAULTS 保持一致，只取被测函数用到的部分 */
function makeCfg() {
  return {
    imageRoot: 'LTYpicture',
    linkFormat: 'jsdelivr',
    classify: { ...DEFAULTS.classify },
    repo: { owner: 'Eiheir', name: 'Luo_Tianyi_Image', branch: 'main' }
  };
}

// ---------------- 1. 路径安全：safeJoinImage ----------------
test('safeJoinImage：正常相对路径解析到图库根内', () => {
  const root = path.resolve('C:/fake-gallery');
  const cfg = { _paths: { imageRoot: root } };
  const abs = safeJoinImage(cfg, 'avatar/0001.jpg');
  assert.ok(abs, '合法路径应返回绝对路径');
  assert.strictEqual(abs, path.join(root, 'avatar', '0001.jpg'));
});

test('safeJoinImage：拒绝路径穿越与非法输入', () => {
  const root = path.resolve('C:/fake-gallery');
  const cfg = { _paths: { imageRoot: root } };
  // 各类越界/非法输入，均须返回 null
  assert.strictEqual(safeJoinImage(cfg, '../secret.txt'), null);
  assert.strictEqual(safeJoinImage(cfg, '..\\..\\windows\\hosts'), null);
  assert.strictEqual(safeJoinImage(cfg, 'a/../../b.jpg'), null);
  assert.strictEqual(safeJoinImage(cfg, '.'), null);   // 指向根目录本身，拒绝
  assert.strictEqual(safeJoinImage(cfg, ''), null);    // 空串
  assert.strictEqual(safeJoinImage(cfg, 123), null);   // 非字符串
  assert.strictEqual(safeJoinImage(cfg, null), null);
});

// ---------------- 2. 分类：classify ----------------
test('decideCategory：近方形 / 横图 / 竖图 / 尺寸缺失', () => {
  const cfg = makeCfg();
  assert.strictEqual(classify.decideCategory(100, 100, cfg), 'avatar'); // 正方形
  assert.strictEqual(classify.decideCategory(120, 100, cfg), 'avatar'); // 1.2 恰好命中
  assert.strictEqual(classify.decideCategory(200, 100, cfg), 'heng');   // 横图
  assert.strictEqual(classify.decideCategory(100, 200, cfg), 'shu');    // 竖图
  assert.strictEqual(classify.decideCategory(0, 100, cfg), 'temporary'); // 尺寸异常→临时
});

test('sanitizeTheme：剔除非法字符并提供默认主题', () => {
  assert.strictEqual(classify.sanitizeTheme('a/b:c'), 'abc'); // 斜杠冒号被清除
  assert.strictEqual(classify.sanitizeTheme('流光'), '流光'); // 中文保留
  assert.strictEqual(classify.sanitizeTheme(''), '默认');     // 空→默认
  assert.strictEqual(classify.sanitizeTheme('  '), '默认');   // 纯空白→默认
});

test('categoryDir：各分类目录映射正确', () => {
  const cfg = makeCfg();
  assert.strictEqual(classify.categoryDir('avatar', '', cfg), 'wallpapers&illustration/avatar');
  assert.strictEqual(classify.categoryDir('heng', '', cfg), 'wallpapers&illustration/heng');
  assert.strictEqual(classify.categoryDir('shu', '', cfg), 'wallpapers&illustration/shu');
  assert.strictEqual(classify.categoryDir('temporary', '', cfg), 'wallpapers&illustration/temporary');
  assert.strictEqual(classify.categoryDir('emoticon', '流光', cfg), 'emoticon/流光');
  assert.throws(() => classify.categoryDir('bad', '', cfg)); // 未知分类应抛错
});

// ---------------- 3. 链接：links ----------------
test('encodeUrlPath：仅编码会破坏 URL 语义的字符', () => {
  assert.strictEqual(links.encodeUrlPath('a b?c#d'), 'a%20b%3Fc%23d');
  // "&" 在路径段中合法，必须保持原样（否则图库路径 wallpapers&illustration 会失效）
  assert.strictEqual(links.encodeUrlPath('wallpapers&illustration/x.png'), 'wallpapers&illustration/x.png');
  // 非 ASCII（中文目录名）逐字符百分号编码，浏览器地址栏仍显示中文
  assert.strictEqual(links.encodeUrlPath('emoticon/流光/001.gif'),
    'emoticon/%E6%B5%81%E5%85%89/001.gif');
});

test('buildLink：jsDelivr 与 raw 两种格式', () => {
  const cfg = makeCfg();
  assert.strictEqual(
    links.buildLink(cfg, 'emoji/a.png', 'jsdelivr'),
    'https://cdn.jsdelivr.net/gh/Eiheir/Luo_Tianyi_Image@main/LTYpicture/emoji/a.png'
  );
  assert.strictEqual(
    links.buildLink(cfg, 'emoji/a.png', 'raw'),
    'https://raw.githubusercontent.com/Eiheir/Luo_Tianyi_Image/main/LTYpicture/emoji/a.png'
  );
  // "&" 目录名不被编码
  assert.ok(links.buildLink(cfg, 'wallpapers&illustration/heng/0001.jpg', 'jsdelivr')
    .includes('wallpapers&illustration/heng/0001.jpg'));
});

test('buildLink：仓库归属缺失时抛错', () => {
  const cfg = makeCfg();
  cfg.repo = { owner: '', name: '', branch: 'main' };
  assert.throws(() => links.buildLink(cfg, 'a.png', 'jsdelivr'));
});

test('exportLinks：txt/json/csv/markdown 四种导出格式', () => {
  const cfg = makeCfg();
  const rows = [{ rel: 'avatar/0001.jpg', name: '0001.jpg', w: 100, h: 100, size: 2048, category: 'avatar' }];

  // txt：纯链接，一行一个
  const txt = links.exportLinks(cfg, rows, 'jsdelivr', 'txt');
  assert.ok(txt.startsWith('https://cdn.jsdelivr.net/gh/Eiheir/Luo_Tianyi_Image@main/LTYpicture/avatar/0001.jpg'));

  // json：可被解析，且字段完整
  const json = JSON.parse(links.exportLinks(cfg, rows, 'jsdelivr', 'json'));
  assert.strictEqual(json[0].name, '0001.jpg');
  assert.strictEqual(json[0].width, 100);
  assert.ok(json[0].url.includes('/LTYpicture/avatar/0001.jpg'));

  // csv：含中文表头，使用 Windows 换行；前置 UTF-8 BOM（Excel 依赖 BOM 识别编码）
  const csv = links.exportLinks(cfg, rows, 'jsdelivr', 'csv');
  assert.ok(csv.startsWith('\uFEFF文件名,分类,宽,高,大小(字节),链接'));
  assert.ok(csv.includes('"0001.jpg","avatar"'));

  // markdown：图片语法
  const md = links.exportLinks(cfg, rows, 'jsdelivr', 'markdown');
  assert.strictEqual(md, '![0001](https://cdn.jsdelivr.net/gh/Eiheir/Luo_Tianyi_Image@main/LTYpicture/avatar/0001.jpg)');
});

test('linkBundle：包含四种复制片段', () => {
  const cfg = makeCfg();
  const b = links.linkBundle(cfg, { rel: 'avatar/0001.jpg', name: '0001.jpg' }, 'jsdelivr');
  assert.ok(b.url.includes('/LTYpicture/avatar/0001.jpg'));
  assert.strictEqual(b.markdown, `![0001](${b.url})`);
  assert.strictEqual(b.html, `<img src="${b.url}" alt="0001" />`);
  assert.strictEqual(b.bbcode, `[img]${b.url}[/img]`);
});

// ---------------- 4. 回收站：moveToTrash / restoreFromTrash（临时目录集成） ----------------
const os = require('node:os');
const fsp = require('node:fs/promises');
const storage = require('../core/storage');

/** fs/promises 无 exists（Node 22 起才提供），用 stat 实现探测 */
async function fileExists(p) {
  try { await fsp.stat(p); return true; } catch (e) { return false; }
}

/** 构造一份隔离的临时"图库 + 回收站"环境，测试结束自动销毁 */
async function makeTrashCfg() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lti-trash-test-'));
  const cfg = {
    _paths: {
      imageRoot: path.join(root, 'LTYpicture'),
      trashDir: path.join(root, '.trash')
    }
  };
  return { root, cfg };
}

test('回收站：中文主题目录的文件可移入并精确恢复', async () => {
  const { root, cfg } = await makeTrashCfg();
  try {
    // 准备图库内一个中文目录文件（回归用例：旧白名单正则会拒绝中文 flat 标识）
    const rel = 'emoticon/流光/001.gif';
    const abs = path.join(cfg._paths.imageRoot, 'emoticon', '流光', '001.gif');
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, Buffer.from('gif-data-001'));

    // 移入回收站
    const { batchId, moved } = await storage.moveToTrash(cfg, [rel]);
    assert.strictEqual(moved.length, 1);
    assert.ok(!moved[0].error, `移入不应报错：${moved[0].error || ''}`);
    assert.strictEqual(await fileExists(path.join(cfg._paths.trashDir, batchId)), true, '批次目录应存在');
    // 原位置应已不存在
    assert.strictEqual(await fileExists(abs), false, '原图库文件应已移走');

    // 从回收站恢复：原图库位置（含中文目录）完整还原
    const { rel: restoredRel, renamed } = await storage.restoreFromTrash(cfg, batchId, moved[0].flat);
    assert.strictEqual(renamed, false, '目标无冲突时不应改名');
    assert.strictEqual(restoredRel, rel);
    assert.strictEqual((await fsp.readFile(abs)).toString(), 'gif-data-001', '内容应原样恢复');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('回收站：恢复时目标编号被占自动改号，不覆盖同号新图', async () => {
  const { root, cfg } = await makeTrashCfg();
  // 补齐恢复逻辑所需的分类/命名配置
  cfg.classify = { emoticonDir: 'emoticon' };
  cfg.naming = { padding: 4, emoticonPadding: 3, allowedExt: ['jpg', 'png', 'gif'] };
  try {
    // 图库内 avatar/0001.jpg，先删掉它
    const abs1 = path.join(cfg._paths.imageRoot, 'avatar', '0001.jpg');
    await fsp.mkdir(path.dirname(abs1), { recursive: true });
    await fsp.writeFile(abs1, 'old-0001');
    const { batchId, moved } = await storage.moveToTrash(cfg, ['avatar/0001.jpg']);
    assert.ok(!moved[0].error);

    // 上传新图复用了编号 0001（模拟"删除→新图补位"）
    await fsp.writeFile(abs1, 'new-0001');

    // 恢复旧 0001：必须改号到 0002，且新图内容完好
    const { rel: restoredRel, renamed } = await storage.restoreFromTrash(cfg, batchId, moved[0].flat);
    assert.strictEqual(renamed, true, '编号冲突时应自动改号');
    assert.strictEqual(restoredRel, 'avatar/0002.jpg');
    assert.strictEqual((await fsp.readFile(abs1)).toString(), 'new-0001', '同号新图绝不能被覆盖');
    assert.strictEqual(
      (await fsp.readFile(path.join(cfg._paths.imageRoot, 'avatar', '0002.jpg'))).toString(),
      'old-0001');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('回收站：整批恢复与彻底删除', async () => {
  const { root, cfg } = await makeTrashCfg();
  try {
    for (const n of ['0001', '0002']) {
      const p = path.join(cfg._paths.imageRoot, 'avatar', `${n}.jpg`);
      await fsp.mkdir(path.dirname(p), { recursive: true });
      await fsp.writeFile(p, `data-${n}`);
    }
    const { batchId } = await storage.moveToTrash(cfg, ['avatar/0001.jpg', 'avatar/0002.jpg']);
    assert.strictEqual(await fileExists(path.join(cfg._paths.imageRoot, 'avatar', '0001.jpg')), false);

    // 整批恢复：两项都回图库
    const { results } = await storage.restoreBatch(cfg, batchId);
    assert.strictEqual(results.filter((r) => !r.error).length, 2);
    assert.strictEqual((await fsp.readFile(path.join(cfg._paths.imageRoot, 'avatar', '0001.jpg'))).toString(), 'data-0001');

    // 再次移入后整批 purge：目录连 manifest 一起消失
    const b2 = await storage.moveToTrash(cfg, ['avatar/0001.jpg']);
    await storage.purgeTrash(cfg, b2.batchId);
    assert.strictEqual(await fileExists(path.join(cfg._paths.trashDir, b2.batchId)), false, '整批 purge 后批次目录应消失');

    // purge 非法批次 ID 必须拒绝
    assert.rejects(() => storage.purgeTrash(cfg, '../escape'));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('回收站：过期批次清理', async () => {
  const { root, cfg } = await makeTrashCfg();
  try {
    const p = path.join(cfg._paths.imageRoot, 'avatar', '0001.jpg');
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, 'x');
    const { batchId } = await storage.moveToTrash(cfg, ['avatar/0001.jpg']);

    // cleanExpiredTrash 按批次目录名中的时间戳判断过期（mtime 会因其他操作变化，不可靠）。
    // 构造一个 40 天前的假批次目录验证过期清理，同时验证真批次不受影响。
    const oldBatchId = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
      .replace(/[:.]/g, '-').slice(0, 19) + '-deadbeef';
    const oldDir = path.join(cfg._paths.trashDir, oldBatchId);
    await fsp.mkdir(oldDir, { recursive: true });
    await fsp.writeFile(path.join(oldDir, '0001.jpg'), 'old');
    await fsp.writeFile(path.join(oldDir, 'manifest.json'), '{}');

    const { batches } = await storage.cleanExpiredTrash(cfg, 30 * 24 * 60 * 60 * 1000);
    assert.strictEqual(batches, 1, '过期批次应被清理');
    assert.strictEqual(await fileExists(oldDir), false, '过期批次目录应被删除');
    assert.strictEqual(await fileExists(path.join(cfg._paths.trashDir, batchId)), true, '新鲜批次不应被动');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('回收站：恢复标识携带路径分隔符或 ".." 时拒绝', async () => {
  const { root, cfg } = await makeTrashCfg();
  try {
    const rel = 'avatar/0001.jpg';
    const abs = path.join(cfg._paths.imageRoot, 'avatar', '0001.jpg');
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, 'x');
    const { batchId, moved } = await storage.moveToTrash(cfg, [rel]);

    // flat 携带分隔符（伪造子路径）必须在 restoreFromTrash 内被拒绝
    await assert.rejects(
      () => storage.restoreFromTrash(cfg, batchId, path.join('a', 'b.jpg')),
      /非法/
    );
    // 清单中不存在的标识按压平规则回退后应还原失败（文件不存在）
    await assert.rejects(() => storage.restoreFromTrash(cfg, batchId, '不存在__0.jpg'));
    void moved;
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('回收站：批次 ID 含随机后缀，同秒两批不冲突', async () => {
  const { root, cfg } = await makeTrashCfg();
  try {
    const abs = (n) => path.join(cfg._paths.imageRoot, 'avatar', `000${n}.jpg`);
    await fsp.mkdir(path.dirname(abs(1)), { recursive: true });
    await fsp.writeFile(abs(1), 'a');
    await fsp.writeFile(abs(2), 'b');

    const b1 = await storage.moveToTrash(cfg, ['avatar/0001.jpg']);
    const b2 = await storage.moveToTrash(cfg, ['avatar/0002.jpg']);
    // 旧实现时间戳截断到秒：同秒两批会共用目录并互相覆盖 manifest
    assert.notStrictEqual(b1.batchId, b2.batchId, '同秒两批的批次 ID 必须不同');
    // 两批的清单都必须完整保留各自的映射
    const m1 = JSON.parse(await fsp.readFile(
      path.join(cfg._paths.trashDir, b1.batchId, 'manifest.json'), 'utf8'));
    const m2 = JSON.parse(await fsp.readFile(
      path.join(cfg._paths.trashDir, b2.batchId, 'manifest.json'), 'utf8'));
    assert.ok(Object.values(m1)[0].endsWith('0001.jpg'));
    assert.ok(Object.values(m2)[0].endsWith('0002.jpg'));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('缩略图缓存清理：只删超期文件，保留新鲜缓存', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lti-thumb-test-'));
  try {
    const thumbDir = path.join(root, 'thumbs');
    await fsp.mkdir(thumbDir, { recursive: true });
    const cfg = { _paths: { thumbDir } };
    const old = path.join(thumbDir, 'old.webp');
    const fresh = path.join(thumbDir, 'fresh.webp');
    await fsp.writeFile(old, 'o');
    await fsp.writeFile(fresh, 'f');
    const past = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000); // 40 天前
    await fsp.utimes(old, past, past);

    const removed = await storage.cleanThumbCache(cfg, 30 * 24 * 60 * 60 * 1000);
    assert.strictEqual(removed, 1);
    assert.strictEqual(await fileExists(old), false, '超期缓存应被删除');
    assert.strictEqual(await fileExists(fresh), true, '新鲜缓存应保留');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// ---------------- 5. 镜像链接 ----------------
test('buildLink：jsDelivr 镜像域名', () => {
  const cfg = makeCfg();
  const expect = (host) =>
    `https://${host}/gh/Eiheir/Luo_Tianyi_Image@main/LTYpicture/emoticon/%E6%B5%81%E5%85%89/001.gif`;
  assert.strictEqual(links.buildLink(cfg, 'emoticon/流光/001.gif', 'fastly'),
    expect('fastly.jsdelivr.net'));
  assert.strictEqual(links.buildLink(cfg, 'emoticon/流光/001.gif', 'testingcf'),
    expect('testingcf.jsdelivr.net'));
  assert.strictEqual(links.buildLink(cfg, 'emoticon/流光/001.gif', 'gcore'),
    expect('gcore.jsdelivr.net'));
  // 未知类型回退主站
  assert.strictEqual(links.buildLink(cfg, 'a.png', 'unknown'), 
    'https://cdn.jsdelivr.net/gh/Eiheir/Luo_Tianyi_Image@main/LTYpicture/a.png');
});

// ---------------- 6. 图库整理（organize） ----------------
const dedup = require('../core/dedup');
const organize = require('../core/organize');

/** 构造带最小索引的整理测试环境 */
async function makeOrgEnv() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lti-org-test-'));
  const cfg = {
    linkFormat: 'jsdelivr',
    repo: { owner: 'Eiheir', name: 'Luo_Tianyi_Image', branch: 'main' },
    classify: {
      avatarRatioMax: 1.2,
      wallpaperDir: 'wallpapers&illustration',
      emoticonDir: 'emoticon',
      temporaryDir: 'wallpapers&illustration/temporary'
    },
    naming: { padding: 4, emoticonPadding: 3, allowedExt: ['jpg', 'png', 'gif'] },
    _paths: { imageRoot: path.join(root, 'LTYpicture') }
  };
  const index = { version: 1, items: {} };
  return { root, cfg, index };
}

test('organize：移动到其他分类并续排编号，索引同步更新', async () => {
  const { root, cfg, index } = await makeOrgEnv();
  try {
    const src = path.join(cfg._paths.imageRoot, 'wallpapers&illustration', 'shu', '0001.jpg');
    await fsp.mkdir(path.dirname(src), { recursive: true });
    await fsp.writeFile(src, 'img');
    dedup.setIndexItem(index, 'wallpapers&illustration/shu/0001.jpg', { mtime: 1, size: 3, w: 10, h: 20, md5: 'a', dhash: 'b' });

    const { results, movedCount } = await organize.moveImages(cfg, index,
      ['wallpapers&illustration/shu/0001.jpg'], { category: 'avatar' });
    assert.strictEqual(movedCount, 1);
    assert.strictEqual(results[0].newRel, 'wallpapers&illustration/avatar/0001.jpg');
    assert.strictEqual((await fsp.readFile(
      path.join(cfg._paths.imageRoot, 'wallpapers&illustration', 'avatar', '0001.jpg'))).toString(), 'img');
    assert.ok(index.items['wallpapers&illustration/avatar/0001.jpg'], '索引应更新到新路径');
    assert.strictEqual(index.items['wallpapers&illustration/shu/0001.jpg'], undefined, '旧索引键应移除');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('organize：移动批次失败时全部回滚', async () => {
  const { root, cfg, index } = await makeOrgEnv();
  try {
    const good = path.join(cfg._paths.imageRoot, 'avatar', '0001.jpg');
    await fsp.mkdir(path.dirname(good), { recursive: true });
    await fsp.writeFile(good, 'good');
    dedup.setIndexItem(index, 'avatar/0001.jpg', { mtime: 1, size: 4, w: 1, h: 1, md5: '', dhash: '' });

    // 第一个文件可移动，第二个源文件不存在 → 批次失败 → 全部回滚
    const { results, movedCount } = await organize.moveImages(cfg, index,
      ['avatar/0001.jpg', 'avatar/不存在.jpg'], { category: 'heng' });
    assert.strictEqual(movedCount, 0);
    assert.strictEqual(results.every((r) => !r.ok), true);
    assert.strictEqual((await fsp.readFile(good)).toString(), 'good', '文件应被回滚回原目录');
    assert.ok(index.items['avatar/0001.jpg'], '索引应回滚');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('organize：编号规整用末尾编号回填空位，只改最少的文件', async () => {
  const { root, cfg, index } = await makeOrgEnv();
  try {
    const dir = path.join(cfg._paths.imageRoot, 'avatar');
    await fsp.mkdir(dir, { recursive: true });
    // 编号集合 {1,3,5}：1、3 已在连续区间内，只把末尾的 5 填到空位 2
    await fsp.writeFile(path.join(dir, '0001.jpg'), 'a');
    await fsp.writeFile(path.join(dir, '0003.jpg'), 'b');
    await fsp.writeFile(path.join(dir, '0005.jpg'), 'c');
    await fsp.writeFile(path.join(dir, 'readme.txt'), 'skip'); // 非编号文件不动
    dedup.setIndexItem(index, 'avatar/0003.jpg', { mtime: 1, size: 2, w: 1, h: 1, md5: 'b', dhash: '' });
    dedup.setIndexItem(index, 'avatar/0005.jpg', { mtime: 1, size: 3, w: 1, h: 1, md5: 'c', dhash: '' });

    const r = await organize.renumberDirectory(cfg, index, 'avatar');
    assert.strictEqual(r.total, 3);
    assert.strictEqual(r.renumbered, 1, '只需把 0005 改名为 0002');
    assert.strictEqual(r.filled, 1);
    assert.strictEqual(r.alreadyInPlace, 2);
    assert.strictEqual((await fsp.readFile(path.join(dir, '0001.jpg'))).toString(), 'a');
    assert.strictEqual((await fsp.readFile(path.join(dir, '0002.jpg'))).toString(), 'c');
    assert.strictEqual((await fsp.readFile(path.join(dir, '0003.jpg'))).toString(), 'b');
    assert.ok(await fileExists(path.join(dir, 'readme.txt')), '非编号文件不应被动');
    // 索引随移动迁移：0003 原地不动，0005 → 0002
    assert.ok(index.items['avatar/0003.jpg'], '已在正确编号的文件索引不变');
    assert.ok(index.items['avatar/0002.jpg'], '被移动文件的索引应换到新键');
    assert.strictEqual(index.items['avatar/0005.jpg'], undefined, '旧索引键应移除');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('organize：多个空洞按“末尾优先”回填，重命名次数等于空位数', async () => {
  const { root, cfg, index } = await makeOrgEnv();
  try {
    const dir = path.join(cfg._paths.imageRoot, 'avatar');
    await fsp.mkdir(dir, { recursive: true });
    // {1,3,5,9} → 空位 {2,4}；用最大的 9 填 2、5 填 4
    await fsp.writeFile(path.join(dir, '0001.jpg'), 'a');
    await fsp.writeFile(path.join(dir, '0003.jpg'), 'b');
    await fsp.writeFile(path.join(dir, '0005.jpg'), 'c');
    await fsp.writeFile(path.join(dir, '0009.jpg'), 'd');

    const r = await organize.renumberDirectory(cfg, index, 'avatar');
    assert.strictEqual(r.total, 4);
    assert.strictEqual(r.renumbered, 2);
    assert.strictEqual(r.filled, 2);
    assert.strictEqual(r.alreadyInPlace, 2);
    assert.strictEqual((await fsp.readFile(path.join(dir, '0001.jpg'))).toString(), 'a');
    assert.strictEqual((await fsp.readFile(path.join(dir, '0002.jpg'))).toString(), 'd');
    assert.strictEqual((await fsp.readFile(path.join(dir, '0003.jpg'))).toString(), 'b');
    assert.strictEqual((await fsp.readFile(path.join(dir, '0004.jpg'))).toString(), 'c');
    assert.strictEqual(await fileExists(path.join(dir, '0005.jpg')), false);
    assert.strictEqual(await fileExists(path.join(dir, '0009.jpg')), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('organize：编号已连续时不做任何改名', async () => {
  const { root, cfg, index } = await makeOrgEnv();
  try {
    const dir = path.join(cfg._paths.imageRoot, 'avatar');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, '0001.jpg'), 'a');
    await fsp.writeFile(path.join(dir, '0002.jpg'), 'b');
    await fsp.writeFile(path.join(dir, '0003.jpg'), 'c');

    const r = await organize.renumberDirectory(cfg, index, 'avatar');
    assert.strictEqual(r.total, 3);
    assert.strictEqual(r.renumbered, 0);
    assert.strictEqual(r.filled, 0);
    assert.strictEqual(r.alreadyInPlace, 3);
    assert.strictEqual((await fsp.readFile(path.join(dir, '0001.jpg'))).toString(), 'a');
    assert.strictEqual((await fsp.readFile(path.join(dir, '0002.jpg'))).toString(), 'b');
    assert.strictEqual((await fsp.readFile(path.join(dir, '0003.jpg'))).toString(), 'c');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('organize：目标文件名被非编号文件占用时中止且不改名', async () => {
  const { root, cfg, index } = await makeOrgEnv();
  try {
    const dir = path.join(cfg._paths.imageRoot, 'avatar');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, '0001.jpg'), 'a');
    await fsp.writeFile(path.join(dir, '0003.jpg'), 'b');
    // 目录名恰好占用了空位 0002.jpg；规整不得覆盖它
    await fsp.mkdir(path.join(dir, '0002.jpg'));

    await assert.rejects(
      () => organize.renumberDirectory(cfg, index, 'avatar'),
      /目标文件名已被占用/
    );
    assert.strictEqual((await fsp.readFile(path.join(dir, '0001.jpg'))).toString(), 'a');
    assert.strictEqual((await fsp.readFile(path.join(dir, '0003.jpg'))).toString(), 'b');
    assert.ok(await fileExists(path.join(dir, '0002.jpg')), '冲突目标应保持原样');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('organize：手动排序按新顺序改名并同步索引', async () => {
  const { root, cfg, index } = await makeOrgEnv();
  try {
    const dir = path.join(cfg._paths.imageRoot, 'avatar');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, '0001.jpg'), 'a');
    await fsp.writeFile(path.join(dir, '0002.jpg'), 'b');
    await fsp.writeFile(path.join(dir, '0003.jpg'), 'c');
    dedup.setIndexItem(index, 'avatar/0001.jpg', { mtime: 1, size: 1, w: 1, h: 1, md5: 'a', dhash: '' });
    dedup.setIndexItem(index, 'avatar/0002.jpg', { mtime: 1, size: 1, w: 1, h: 1, md5: 'b', dhash: '' });
    dedup.setIndexItem(index, 'avatar/0003.jpg', { mtime: 1, size: 1, w: 1, h: 1, md5: 'c', dhash: '' });

    // A、C、B：A 原地不动，B/C 交换
    const r = await organize.reorderDirectory(cfg, index, 'avatar',
      ['0001.jpg', '0003.jpg', '0002.jpg']);
    assert.strictEqual(r.total, 3);
    assert.strictEqual(r.renumbered, 2);
    assert.strictEqual(r.unchanged, 1);
    assert.strictEqual((await fsp.readFile(path.join(dir, '0001.jpg'))).toString(), 'a');
    assert.strictEqual((await fsp.readFile(path.join(dir, '0002.jpg'))).toString(), 'c');
    assert.strictEqual((await fsp.readFile(path.join(dir, '0003.jpg'))).toString(), 'b');
    assert.strictEqual(index.items['avatar/0001.jpg'].md5, 'a');
    assert.strictEqual(index.items['avatar/0002.jpg'].md5, 'c');
    assert.strictEqual(index.items['avatar/0003.jpg'].md5, 'b');
    // 不应残留临时文件
    const left = (await fsp.readdir(dir)).filter((n) => n.includes('.order-'));
    assert.deepStrictEqual(left, []);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('organize：手动排序保留目录已有编号空洞', async () => {
  const { root, cfg, index } = await makeOrgEnv();
  try {
    const dir = path.join(cfg._paths.imageRoot, 'avatar');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, '0001.jpg'), 'a');
    await fsp.writeFile(path.join(dir, '0003.jpg'), 'b');
    await fsp.writeFile(path.join(dir, '0005.jpg'), 'c');

    // 倒序：C、B、A → 目标编号仍是 1/3/5（B 原地不动）
    const r = await organize.reorderDirectory(cfg, index, 'avatar',
      ['0005.jpg', '0003.jpg', '0001.jpg']);
    assert.strictEqual(r.renumbered, 2);
    assert.strictEqual(r.unchanged, 1);
    assert.strictEqual((await fsp.readFile(path.join(dir, '0001.jpg'))).toString(), 'c');
    assert.strictEqual((await fsp.readFile(path.join(dir, '0003.jpg'))).toString(), 'b');
    assert.strictEqual((await fsp.readFile(path.join(dir, '0005.jpg'))).toString(), 'a');
    assert.strictEqual(await fileExists(path.join(dir, '0002.jpg')), false);
    assert.strictEqual(await fileExists(path.join(dir, '0004.jpg')), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('organize：输入序号交换只重命名两张图', async () => {
  const { root, cfg, index } = await makeOrgEnv();
  try {
    const dir = path.join(cfg._paths.imageRoot, 'avatar');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, '0001.jpg'), 'a');
    await fsp.writeFile(path.join(dir, '0002.jpg'), 'b');
    await fsp.writeFile(path.join(dir, '0003.jpg'), 'c');

    // 前端输入目标序号执行的是交换：A、C 互换，B 原地不动
    const r = await organize.reorderDirectory(cfg, index, 'avatar',
      ['0003.jpg', '0002.jpg', '0001.jpg']);
    assert.strictEqual(r.renumbered, 2, '交换只应改两张图');
    assert.strictEqual(r.unchanged, 1, '中间那张保持原名');
    assert.strictEqual((await fsp.readFile(path.join(dir, '0001.jpg'))).toString(), 'c');
    assert.strictEqual((await fsp.readFile(path.join(dir, '0002.jpg'))).toString(), 'b');
    assert.strictEqual((await fsp.readFile(path.join(dir, '0003.jpg'))).toString(), 'a');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('organize：排序列表不完整/重复/含未知文件时拒绝且不改名', async () => {
  const { root, cfg, index } = await makeOrgEnv();
  try {
    const dir = path.join(cfg._paths.imageRoot, 'avatar');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, '0001.jpg'), 'a');
    await fsp.writeFile(path.join(dir, '0002.jpg'), 'b');
    await fsp.writeFile(path.join(dir, '0003.jpg'), 'c');

    await assert.rejects(
      () => organize.reorderDirectory(cfg, index, 'avatar', ['0001.jpg', '0002.jpg']),
      /必须包含目录内全部编号图片/
    );
    await assert.rejects(
      () => organize.reorderDirectory(cfg, index, 'avatar', ['0001.jpg', '0001.jpg', '0003.jpg']),
      /无效或重复文件/
    );
    await assert.rejects(
      () => organize.reorderDirectory(cfg, index, 'avatar', ['0001.jpg', '0002.jpg', 'nope.jpg']),
      /无效或重复文件/
    );
    assert.strictEqual((await fsp.readFile(path.join(dir, '0001.jpg'))).toString(), 'a');
    assert.strictEqual((await fsp.readFile(path.join(dir, '0002.jpg'))).toString(), 'b');
    assert.strictEqual((await fsp.readFile(path.join(dir, '0003.jpg'))).toString(), 'c');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('organize：重复编号拒绝手动排序', async () => {
  const { root, cfg, index } = await makeOrgEnv();
  try {
    const dir = path.join(cfg._paths.imageRoot, 'avatar');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, '0001.jpg'), 'a');
    await fsp.writeFile(path.join(dir, '0001.png'), 'b');
    await fsp.writeFile(path.join(dir, '0002.jpg'), 'c');

    await assert.rejects(
      () => organize.reorderDirectory(cfg, index, 'avatar', ['0001.png', '0002.jpg', '0001.jpg']),
      /重复编号/
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('organize：手动排序目标名被目录占用时中止且不改名', async () => {
  const { root, cfg, index } = await makeOrgEnv();
  try {
    const dir = path.join(cfg._paths.imageRoot, 'avatar');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, '0001.png'), 'a');
    await fsp.writeFile(path.join(dir, '0002.jpg'), 'b');
    // 目标 0001.jpg 被目录占用：不能覆盖
    await fsp.mkdir(path.join(dir, '0001.jpg'));

    await assert.rejects(
      () => organize.reorderDirectory(cfg, index, 'avatar', ['0002.jpg', '0001.png']),
      /目标文件名已被占用/
    );
    assert.strictEqual((await fsp.readFile(path.join(dir, '0001.png'))).toString(), 'a');
    assert.strictEqual((await fsp.readFile(path.join(dir, '0002.jpg'))).toString(), 'b');
    assert.ok(await fileExists(path.join(dir, '0001.jpg')));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('organize：表情包主题改名', async () => {
  const { root, cfg, index } = await makeOrgEnv();
  try {
    const dir = path.join(cfg._paths.imageRoot, 'emoticon', '旧主题');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, '001.gif'), 'e');
    dedup.setIndexItem(index, 'emoticon/旧主题/001.gif', { mtime: 1, size: 1, w: 1, h: 1, md5: '', dhash: '' });

    const r = await organize.renameTheme(cfg, index, '旧主题', '新主题');
    assert.strictEqual(r.count, 1);
    assert.ok(await fileExists(path.join(cfg._paths.imageRoot, 'emoticon', '新主题', '001.gif')));
    assert.ok(!await fileExists(dir), '旧目录应不存在');
    assert.ok(index.items['emoticon/新主题/001.gif'], '索引键应换到新主题');
    // 目标已存在时应拒绝
    await assert.rejects(() => organize.renameTheme(cfg, index, '新主题', '新主题'));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// ---------------- 7. 设置白名单 ----------------
const settings = require('../core/settings');

test('settings：publicView 只含白名单字段', () => {
  const view = settings.publicView({
    upload: { quality: 100, maxBatchFiles: 200, maxFileMB: 60 },
    dedup: { hammingThreshold: 5, cropThreshold: 5, onExactDuplicate: 'skip' },
    linkFormat: 'jsdelivr',
    git: { purgeCdn: false },
    accessToken: '',
    _paths: { secret: 'x' }
  });
  assert.deepStrictEqual(Object.keys(view).sort(),
    ['accessToken', 'dedup.hammingThreshold', 'dedup.cropThreshold', 'dedup.onExactDuplicate',
     'git.purgeCdn', 'linkFormat', 'upload.maxBatchFiles', 'upload.maxFileMB', 'upload.quality'].sort());
});

test('settings：SETTABLE 校验函数拒绝越界值', () => {
  assert.strictEqual(settings.SETTABLE['upload.quality'](50), 50);
  assert.strictEqual(settings.SETTABLE['upload.quality'](10), null);   // 低于下限
  assert.strictEqual(settings.SETTABLE['upload.quality']('abc'), null); // 非数字
  assert.strictEqual(settings.SETTABLE['linkFormat']('fastly'), 'fastly');
  assert.strictEqual(settings.SETTABLE['linkFormat']('evil'), null);
  assert.strictEqual(settings.SETTABLE['git.purgeCdn'](true), true);
  assert.strictEqual(settings.SETTABLE['git.purgeCdn'](1), null);
  // 局部裁切阈值：与整图阈值同范围
  assert.strictEqual(settings.SETTABLE['dedup.cropThreshold'](5), 5);
  assert.strictEqual(settings.SETTABLE['dedup.cropThreshold'](21), null);
  // 访问令牌：任意字符串（含空串=关闭鉴权）；超长拒绝
  assert.strictEqual(settings.SETTABLE['accessToken']('abc-123'), 'abc-123');
  assert.strictEqual(settings.SETTABLE['accessToken'](''), '');
  assert.strictEqual(settings.SETTABLE['accessToken']('x'.repeat(200)), null);
  assert.strictEqual(settings.SETTABLE['accessToken'](123), null);
});

// ---------------- 8. 链接导出：html / bbcode ----------------
test('exportLinks：html 与 bbcode 格式', () => {
  const cfg = makeCfg();
  const rows = [{ rel: 'avatar/0001.jpg', name: '0001.jpg', w: 100, h: 100, size: 2048, category: 'avatar' }];
  assert.strictEqual(links.exportLinks(cfg, rows, 'jsdelivr', 'html'),
    `<img src="https://cdn.jsdelivr.net/gh/Eiheir/Luo_Tianyi_Image@main/LTYpicture/avatar/0001.jpg" alt="0001" />`);
  assert.strictEqual(links.exportLinks(cfg, rows, 'jsdelivr', 'bbcode'),
    `[img]https://cdn.jsdelivr.net/gh/Eiheir/Luo_Tianyi_Image@main/LTYpicture/avatar/0001.jpg[/img]`);
});

// ---------------- 9. 查重手动忽略（按图静音） ----------------
test('忽略：持久化与 v1 pairs 格式迁移', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lti-ignore-test-'));
  try {
    const cfg = { _paths: { ignoreFile: path.join(root, 'dedup-ignore.json') } };
    // 空集合读
    assert.strictEqual((await dedup.loadIgnoreSet(cfg)).size, 0);
    // 写入后可读回（v2 muted 格式）
    await dedup.saveIgnoreSet(cfg, new Set(['a.jpg', 'b.jpg']));
    assert.deepStrictEqual([...await dedup.loadIgnoreSet(cfg)].sort(), ['a.jpg', 'b.jpg']);
    // v1 pairs 格式自动迁移：对的两端都变成 muted
    await fsp.writeFile(cfg._paths.ignoreFile,
      JSON.stringify({ version: 1, pairs: ['a.jpg||b.jpg', 'c.jpg||d.jpg'] }));
    const migrated = await dedup.loadIgnoreSet(cfg);
    assert.strictEqual(migrated.size, 4);
    assert.ok(migrated.has('a.jpg') && migrated.has('d.jpg'));
    // 损坏文件按空集合降级
    await fsp.writeFile(cfg._paths.ignoreFile, '{broken');
    assert.strictEqual((await dedup.loadIgnoreSet(cfg)).size, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('忽略：addIgnorePairs 按图登记并跳过索引中不存在的路径', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lti-ignore-test-'));
  try {
    const cfg = { _paths: { ignoreFile: path.join(root, 'dedup-ignore.json') } };
    const index = { items: { 'a.jpg': {}, 'b.jpg': {}, 'c.jpg': {} } };
    const r = await dedup.addIgnorePairs(cfg, index, ['a.jpg', 'b.jpg', '不存在.jpg']);
    assert.strictEqual(r.added, 2);
    assert.strictEqual(r.skipped, 1);
    assert.strictEqual(r.total, 2);
    // 幂等：重复提交不新增
    const r2 = await dedup.addIgnorePairs(cfg, index, ['a.jpg', 'b.jpg']);
    assert.strictEqual(r2.added, 0);
    // 取消忽略
    const r3 = await dedup.removeIgnorePairs(cfg, ['a.jpg']);
    assert.strictEqual(r3.removed, 1);
    assert.strictEqual(r3.total, 1);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('忽略：被静音的图片彻底退出相似归组', () => {
  // 三张图两两相似，不忽略时应聚成一组
  const mkIndex = () => ({ items: {
    'a.jpg': { dhash: '0000000000000001' },
    'b.jpg': { dhash: '0000000000000003' },
    'c.jpg': { dhash: '0000000000000005' }
  } });
  const th = 8;
  let g = dedup.findDuplicateGroups(mkIndex(), th);
  assert.strictEqual(g.similarGroups.length, 1);
  assert.strictEqual(g.similarGroups[0].length, 3);

  // 静音 a 后：a 彻底消失，b-c 仍聚成一组（v1 配对语义下 a 会继续与其他图组队）
  g = dedup.findDuplicateGroups(mkIndex(), th, new Set(['a.jpg']));
  assert.strictEqual(g.similarGroups.length, 1);
  assert.deepStrictEqual(g.similarGroups[0], ['b.jpg', 'c.jpg']);
  assert.ok(!g.similarGroups[0].includes('a.jpg'));

  // 全部静音：无相似组
  g = dedup.findDuplicateGroups(mkIndex(), th, new Set(['a.jpg', 'b.jpg', 'c.jpg']));
  assert.strictEqual(g.similarGroups.length, 0);

  // MD5 完全重复组不受忽略影响（客观事实）
  const dupIndex = { items: {
    'x.jpg': { md5: 'same', dhash: '' },
    'y.jpg': { md5: 'same', dhash: '' }
  } };
  g = dedup.findDuplicateGroups(dupIndex, th, new Set(['x.jpg', 'y.jpg']));
  assert.strictEqual(g.exactGroups.length, 1, '完全重复组不应被忽略');
});

test('忽略：pruneIgnorePairs 清理索引中已失效的路径', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lti-ignore-test-'));
  try {
    const cfg = { _paths: { ignoreFile: path.join(root, 'dedup-ignore.json') } };
    const index = { items: { 'alive.jpg': {} } };
    await dedup.saveIgnoreSet(cfg, new Set(['deleted.jpg', 'moved-old.jpg', 'alive.jpg']));
    const r = await dedup.pruneIgnorePairs(cfg, index);
    assert.strictEqual(r.pruned, 2);
    const rest = await dedup.loadIgnoreSet(cfg);
    assert.strictEqual(rest.size, 1);
    assert.ok(rest.has('alive.jpg'));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('organize：去重保留图自动压缩到组内最小序号，目标被占用时保持原名', async () => {
  const { root, cfg, index } = await makeOrgEnv();
  try {
    const dir = path.join(cfg._paths.imageRoot, 'wallpapers&illustration', 'heng');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, '0007.png'), 'keep');

    const group = [
      'wallpapers&illustration/heng/0003.jpg',
      'wallpapers&illustration/heng/0007.png',
      'wallpapers&illustration/heng/0011.jpg',
    ];
    dedup.setIndexItem(index, group[1], { mtime: 1, size: 4, w: 100, h: 100, md5: 'm', dhash: 'd' });

    const r = await organize.compactKeptSequence(cfg, index, group, group[1]);
    assert.strictEqual(r.renamed, true);
    assert.strictEqual(r.keptRel, 'wallpapers&illustration/heng/0003.png');
    assert.ok(await fsp.stat(path.join(dir, '0003.png')).then(() => true, () => false));
    assert.ok(index.items['wallpapers&illustration/heng/0003.png'], '索引应更新到新序号');
    assert.strictEqual(index.items[group[1]], undefined, '旧序号索引应移除');

    // 目标序号被同目录其他文件占用：不覆盖、保持原名
    await fsp.writeFile(path.join(dir, '0007.png'), 'keep2');
    await fsp.writeFile(path.join(dir, '0003.png'), 'occupied');
    const index2 = { version: 1, items: {} };
    dedup.setIndexItem(index2, group[1], { mtime: 1, size: 4, w: 100, h: 100, md5: 'm', dhash: 'd' });
    const blocked = await organize.compactKeptSequence(cfg, index2, group, group[1]);
    assert.strictEqual(blocked.renamed, false);
    assert.strictEqual(blocked.reason, 'target-occupied');
    assert.ok(await fsp.stat(path.join(dir, '0007.png')).then(() => true, () => false));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// ---------------- 10. 查重保留规则：横 > 方 > 竖 ----------------
test('保留规则：跨方向时横图优先于更大的方图/竖图', () => {
  const cfg = { classify: { avatarRatioMax: 1.2 }, dedup: {} };
  const items = [
    { rel: 'wallpapers&illustration/shu/0001.jpg', w: 4000, h: 6000, size: 5000000 },
    { rel: 'wallpapers&illustration/avatar/0001.jpg', w: 3000, h: 3000, size: 4000000 },
    { rel: 'wallpapers&illustration/heng/0001.jpg', w: 1920, h: 1080, size: 2000000 },
  ];
  const r = dedup.pickKeep(items, cfg);
  assert.strictEqual(r.rel, 'wallpapers&illustration/heng/0001.jpg', '横图应优先，即使面积更小');
  assert.strictEqual(r.orientation, 'heng');
  // 没有横图时，方图优先于面积更大的竖图
  const r2 = dedup.pickKeep(items.slice(0, 2), cfg);
  assert.strictEqual(r2.rel, 'wallpapers&illustration/avatar/0001.jpg', '方图应优先于竖图');
  assert.strictEqual(r2.orientation, 'avatar');
});

test('保留规则：同方向比面积，面积相同比体积，仍相同保持原顺序', () => {
  const cfg = { classify: { avatarRatioMax: 1.2 }, dedup: {} };
  const r = dedup.pickKeep([
    { rel: 'a.jpg', w: 1920, h: 1080, size: 100 },
    { rel: 'b.jpg', w: 2560, h: 1440, size: 90 },
    { rel: 'c.jpg', w: 1280, h: 720, size: 999 },
  ], cfg);
  assert.strictEqual(r.rel, 'b.jpg', '同为横图时保留面积最大的');
  const r2 = dedup.pickKeep([
    { rel: 'a.jpg', w: 1920, h: 1080, size: 100 },
    { rel: 'b.jpg', w: 1920, h: 1080, size: 200 },
  ], cfg);
  assert.strictEqual(r2.rel, 'b.jpg', '面积相同保留体积更大的');
  const r3 = dedup.pickKeep([
    { rel: 'a.jpg', w: 1920, h: 1080, size: 100 },
    { rel: 'b.jpg', w: 1920, h: 1080, size: 100 },
  ], cfg);
  assert.strictEqual(r3.rel, 'a.jpg', '完全同分保持组内原顺序');
});

test('保留规则：dedup.keepPriority 可覆盖默认顺序', () => {
  const cfg = { classify: { avatarRatioMax: 1.2 }, dedup: { keepPriority: ['shu', 'avatar', 'heng'] } };
  const r = dedup.pickKeep([
    { rel: 'heng.jpg', w: 4000, h: 2000, size: 1 },
    { rel: 'shu.jpg', w: 1000, h: 2000, size: 1 },
  ], cfg);
  assert.strictEqual(r.rel, 'shu.jpg');
  assert.deepStrictEqual(r.priority, ['shu', 'avatar', 'heng']);
});

test('方向判定：尺寸缺失时按目录兜底，非法优先级回退默认', () => {
  const cfg = { classify: { avatarRatioMax: 1.2 }, dedup: { keepPriority: ['heng', 'heng', 'shu'] } };
  assert.strictEqual(dedup.orientationOf(1920, 1080, cfg), 'heng');
  assert.strictEqual(dedup.orientationOf(1080, 1920, cfg), 'shu');
  assert.strictEqual(dedup.orientationOf(1080, 1080, cfg), 'avatar');
  assert.strictEqual(dedup.orientationOf(0, 1080, cfg), '');
  assert.strictEqual(dedup.orientationOfItem({ rel: 'wallpapers&illustration/shu/0001.jpg' }, cfg), 'shu');
  assert.deepStrictEqual(dedup.keepPriorityOf(cfg), ['heng', 'avatar', 'shu'], '非法顺序应回退默认');
});

test('相似归组：横/方/竖不同目录的相似图进入同一组', () => {
  const index = { items: {
    'wallpapers&illustration/heng/0001.jpg': { dhash: '0000000000000000' },
    'wallpapers&illustration/shu/0001.jpg': { dhash: '0000000000000001' },
    'wallpapers&illustration/avatar/0001.jpg': { dhash: '0000000000000003' },
  } };
  const g = dedup.findDuplicateGroups(index, 3);
  assert.strictEqual(g.similarGroups.length, 1);
  assert.deepStrictEqual(g.similarGroups[0].slice().sort(), [
    'wallpapers&illustration/avatar/0001.jpg',
    'wallpapers&illustration/heng/0001.jpg',
    'wallpapers&illustration/shu/0001.jpg',
  ]);
});

test('表情包归组：只在同一主题目录内比对，不跨文件夹', () => {
  const cfg = makeCfg();
  const index = { items: {
    'emoticon/A/001.png': { md5: 'a1', dhash: '0000000000000000' },
    'emoticon/A/002.png': { md5: 'a2', dhash: '0000000000000001' },
    'emoticon/B/001.png': { md5: 'b1', dhash: '0000000000000000' },
    'emoticon/B/002.png': { md5: 'b2', dhash: '0000000000000001' },
    'wallpapers&illustration/heng/0001.jpg': { md5: 'w1', dhash: '0000000000000000' },
    'wallpapers&illustration/shu/0001.jpg': { md5: 'w2', dhash: '0000000000000001' },
  } };
  const g = dedup.findDuplicateGroups(index, 3, new Set(), { cfg });
  const groups = g.similarGroups.map((gr) => gr.slice().sort());
  assert.deepStrictEqual(groups, [
    ['emoticon/A/001.png', 'emoticon/A/002.png'],
    ['emoticon/B/001.png', 'emoticon/B/002.png'],
    ['wallpapers&illustration/heng/0001.jpg', 'wallpapers&illustration/shu/0001.jpg'],
  ]);
});

test('表情包归组：MD5 完全相同也不跨主题归组', () => {
  const cfg = makeCfg();
  const index = { items: {
    'emoticon/A/001.png': { md5: 'same', dhash: '0000000000000000' },
    'emoticon/A/002.png': { md5: 'same', dhash: '0000000000000000' },
    'emoticon/B/001.png': { md5: 'same', dhash: '0000000000000000' },
  } };
  const g = dedup.findDuplicateGroups(index, 3, new Set(), { cfg });
  assert.deepStrictEqual(g.exactGroups.map((gr) => gr.slice().sort()), [
    ['emoticon/A/001.png', 'emoticon/A/002.png'],
  ]);
});

test('表情包上传查重：只命中同主题目录', () => {
  const cfg = makeCfg();
  const index = { items: {
    'emoticon/A/001.png': { md5: 'old-a', dhash: '0000000000000000' },
    'emoticon/B/001.png': { md5: 'old-b', dhash: '0000000000000000' },
    'wallpapers&illustration/heng/0001.jpg': { md5: 'old-w', dhash: '0000000000000000' },
  } };
  const hitA = dedup.compareAgainstLibrary(index, 'new-md5', '0000000000000000', 3, {
    item: { rel: 'emoticon/A/__incoming__', w: 100, h: 100 }, cfg
  });
  assert.deepStrictEqual(hitA.similar.map((s) => s.rel), ['emoticon/A/001.png']);

  const hitB = dedup.compareAgainstLibrary(index, 'new-md5', '0000000000000000', 3, {
    item: { rel: 'emoticon/B/__incoming__', w: 100, h: 100 }, cfg
  });
  assert.deepStrictEqual(hitB.similar.map((s) => s.rel), ['emoticon/B/001.png']);

  const exactA = dedup.compareAgainstLibrary(index, 'old-a', '0000000000000000', 3, {
    item: { rel: 'emoticon/A/__incoming__', w: 100, h: 100 }, cfg
  });
  assert.deepStrictEqual(exactA.exact, ['emoticon/A/001.png']);

  // 壁纸上传不与该表情包互相比对
  const hitW = dedup.compareAgainstLibrary(index, 'new-md5', '0000000000000000', 3, {
    item: { rel: 'wallpapers&illustration/heng/__incoming__', w: 1920, h: 1080 }, cfg
  });
  assert.deepStrictEqual(hitW.similar.map((s) => s.rel), ['wallpapers&illustration/heng/0001.jpg']);
});

// ---------------- 11. 跨方向局部裁切识别 ----------------
test('局部裁切：整图 dHash 差很远时，竖图仍可凭裁切指纹与横图归组', () => {
  const cfg = { classify: { avatarRatioMax: 1.2 } };
  const heng = 'wallpapers&illustration/heng/0001.jpg';
  const shu = 'wallpapers&illustration/shu/0001.jpg';
  const index = { items: {
    [heng]: {
      w: 1920, h: 1080, dhash: '0000000000000000',
      chash: 'aaaaaaaaaaaaaaaa', cropVersion: 1,
      crops: [[0.5625, 'bbbbbbbbbbbbbbbb'], [1, 'cccccccccccccccc']]
    },
    [shu]: {
      w: 1080, h: 1920, dhash: 'ffffffffffffffff',
      chash: 'bbbbbbbbbbbbbbbb', cropVersion: 1,
      crops: [[1.7778, 'dddddddddddddddd'], [1, 'eeeeeeeeeeeeeeee']]
    }
  } };
  // 整图 dHash 距离 64；竖图整图 = 横图 9:16 位置的裁切指纹 → 应归组
  const g = dedup.findDuplicateGroups(index, 3, new Set(), { cfg, cropThreshold: 5 });
  assert.strictEqual(g.similarGroups.length, 1);
  assert.deepStrictEqual(g.similarGroups[0].slice().sort(), [heng, shu].sort());
});

test('局部裁切：同方向同宽高比仍交给整图 dHash', () => {
  const cfg = { classify: { avatarRatioMax: 1.2 } };
  const a = 'wallpapers&illustration/heng/0001.jpg';
  const b = 'wallpapers&illustration/heng/0002.jpg';
  const index = { items: {
    [a]: {
      w: 1920, h: 1080, dhash: '0000000000000000',
      chash: 'aaaaaaaaaaaaaaaa', cropVersion: 1,
      crops: [[0.5625, 'bbbbbbbbbbbbbbbb']]
    },
    [b]: {
      w: 2560, h: 1440, dhash: 'ffffffffffffffff',
      chash: 'bbbbbbbbbbbbbbbb', cropVersion: 1,
      crops: [[0.5625, 'cccccccccccccccc']]
    }
  } };
  const g = dedup.findDuplicateGroups(index, 3, new Set(), { cfg, cropThreshold: 5 });
  assert.strictEqual(g.similarGroups.length, 0, '宽高比一致时应交给整图 dHash，不启用局部裁切比对');
});

test('局部裁切：阈值边界生效（距离 6 时 5 不命中、6 命中）', () => {
  const cfg = { classify: { avatarRatioMax: 1.2 } };
  const heng = 'wallpapers&illustration/heng/0001.jpg';
  const shu = 'wallpapers&illustration/shu/0001.jpg';
  const index = { items: {
    [heng]: {
      w: 1920, h: 1080, dhash: '0000000000000000',
      chash: 'aaaaaaaaaaaaaaaa', cropVersion: 1,
      crops: [[0.5625, 'bbbbbbbbbbbbbbbb']]
    },
    [shu]: {
      w: 1080, h: 1920, dhash: 'ffffffffffffffff',
      chash: 'bbbbbbbbbbbbbb00', cropVersion: 1,
      crops: [[1.7778, 'dddddddddddddddd']]
    }
  } };
  assert.strictEqual(dedup.findDuplicateGroups(index, 3, new Set(), { cfg, cropThreshold: 5 }).similarGroups.length, 0);
  assert.strictEqual(dedup.findDuplicateGroups(index, 3, new Set(), { cfg, cropThreshold: 6 }).similarGroups.length, 1);
});

test('局部裁切：上传前查重能标记 via=crop', () => {
  const cfg = { classify: { avatarRatioMax: 1.2 } };
  const shu = 'wallpapers&illustration/shu/0001.jpg';
  const index = { items: {
    [shu]: {
      w: 1080, h: 1920, md5: 'old', dhash: 'ffffffffffffffff',
      chash: 'cccccccccccccccc', cropVersion: 1,
      crops: [[1.7778, 'bbbbbbbbbbbbbbbb'], [1, 'dddddddddddddddd']]
    }
  } };
  // 新上传的横图整图与库内竖图的 16:9 裁切位置一致
  const incoming = {
    w: 1920, h: 1080,
    chash: 'bbbbbbbbbbbbbbbb',
    crops: [[0.5625, 'eeeeeeeeeeeeeeee']]
  };
  const cmp = dedup.compareAgainstLibrary(index, 'new-md5', '0000000000000000', 3, {
    item: incoming, cfg, cropThreshold: 5
  });
  assert.strictEqual(cmp.similar.length, 1);
  assert.strictEqual(cmp.similar[0].rel, shu);
  assert.strictEqual(cmp.similar[0].via, 'crop');
});

test('局部裁切指纹：cropHashesOf 生成整图与多宽高比裁切哈希', async () => {
  const sharp = require('sharp');
  const width = 240, height = 120;
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      raw[i] = Math.round(255 * x / width);
      raw[i + 1] = Math.round(255 * y / height);
      raw[i + 2] = 128;
    }
  }
  const buf = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
  const c = await dedup.cropHashesOf(buf, makeCfg());
  assert.match(c.chash, /^[0-9a-f]{16}$/);
  assert.strictEqual(c.cropVersion, dedup.CROP_VERSION);
  // v2 数据：缩略图 + 32 段行列投影（供任意位置 NCC）
  assert.ok(c.thumb && c.thumb.w > 0 && c.thumb.h > 0);
  assert.strictEqual(typeof c.thumb.data, 'string');
  assert.ok(c.thumb.data.length > 0);
  assert.strictEqual(c.rowProf.length, 32);
  assert.strictEqual(c.colProf.length, 32);
  // 横图应有 3 个竖裁切宽高比 + 1 个方裁切
  assert.strictEqual(c.crops.length, 4);
  for (const g of c.crops) {
    assert.strictEqual(typeof g[0], 'number');
    assert.ok(g.length >= 2);
    for (let i = 1; i < g.length; i++) assert.match(g[i], /^[0-9a-f]{16}$/);
  }
});

test('局部裁切 NCC：任意位置截取可命中，明显无关的图不命中', async () => {
  const sharp = require('sharp');
  const cfg = makeCfg();
  const width = 240, height = 120;
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      raw[i] = Math.round(255 * x / width);
      raw[i + 1] = Math.round(255 * y / height);
      raw[i + 2] = Math.round(128 + 64 * Math.sin(x / 12) * Math.cos(y / 9));
    }
  }
  const buf = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
  // 任意位置（偏左 73px）截取一张 80×120 的竖图
  const cropBuf = await sharp(buf).extract({ left: 73, top: 0, width: 80, height: 120 }).png().toBuffer();
  const A = await dedup.cropHashesOf(buf, cfg);
  const B = await dedup.cropHashesOf(cropBuf, cfg);
  const score = dedup.nccCropMatch(
    { rel: 'wallpapers&illustration/heng/a.png', w: width, h: height, ...A },
    { rel: 'wallpapers&illustration/shu/b.png', w: 80, h: 120, ...B },
    new Map(), cfg
  );
  assert.ok(score !== null && score >= 0.9, `任意位置裁切应命中，实际 NCC=${score}`);

  // 反相渐变：结构完全不同，不应命中
  const raw2 = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw2.length; i += 3) {
    raw2[i] = 255 - raw[i];
    raw2[i + 1] = 255 - raw[i + 1];
    raw2[i + 2] = 255 - raw[i + 2];
  }
  const otherBuf = await sharp(raw2, { raw: { width, height, channels: 3 } }).png().toBuffer();
  const C = await dedup.cropHashesOf(otherBuf, cfg);
  const miss = dedup.nccCropMatch(
    { rel: 'wallpapers&illustration/heng/c.png', w: width, h: height, ...C },
    { rel: 'wallpapers&illustration/shu/b.png', w: 80, h: 120, ...B },
    new Map(), cfg
  );
  assert.strictEqual(miss, null, '反相图不应被判为同一裁切');
});

test('局部裁切 NCC：整图与固定裁切指纹都不命中时仍能归组', async () => {
  const sharp = require('sharp');
  const cfg = makeCfg();
  const width = 240, height = 120;
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      raw[i] = Math.round(255 * x / width);
      raw[i + 1] = Math.round(255 * y / height);
      raw[i + 2] = Math.round(128 + 64 * Math.sin(x / 12) * Math.cos(y / 9));
    }
  }
  const buf = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
  const cropBuf = await sharp(buf).extract({ left: 73, top: 0, width: 80, height: 120 }).png().toBuffer();
  const A = await dedup.cropHashesOf(buf, cfg);
  const B = await dedup.cropHashesOf(cropBuf, cfg);
  const heng = 'wallpapers&illustration/heng/0001.png';
  const shu = 'wallpapers&illustration/shu/0001.png';
  const base = (x, w, h) => ({
    w, h,
    // 故意让整图 dHash 与固定裁切指纹都不命中，只保留 NCC 所需的缩略图/投影
    dhash: x, chash: x, crops: [], cropVersion: dedup.CROP_VERSION,
    thumb: null, rowProf: null, colProf: null
  });
  const index = { items: {
    [heng]: { ...base('0000000000000000', width, height), thumb: A.thumb, rowProf: A.rowProf, colProf: A.colProf },
    [shu]: { ...base('ffffffffffffffff', 80, 120), thumb: B.thumb, rowProf: B.rowProf, colProf: B.colProf }
  } };
  const g = dedup.findDuplicateGroups(index, 3, new Set(), { cfg, cropThreshold: 5 });
  assert.strictEqual(g.similarGroups.length, 1);
  assert.deepStrictEqual(g.similarGroups[0].slice().sort(), [heng, shu].sort());

  // 同一套数据走"上传前查重"路径：应返回 via=ncc 并带上 NCC 分数
  const uploadIndex = { items: {
    [shu]: {
      w: 80, h: 120, md5: 'old', dhash: 'ffffffffffffffff',
      chash: 'ffffffffffffffff', crops: [], cropVersion: dedup.CROP_VERSION,
      thumb: B.thumb, rowProf: B.rowProf, colProf: B.colProf
    }
  } };
  const cmp = dedup.compareAgainstLibrary(uploadIndex, 'new-md5', '0000000000000000', 3, {
    item: {
      w: width, h: height, chash: '0000000000000000', crops: [],
      thumb: A.thumb, rowProf: A.rowProf, colProf: A.colProf
    },
    cfg, cropThreshold: 5
  });
  assert.strictEqual(cmp.similar.length, 1);
  assert.strictEqual(cmp.similar[0].via, 'ncc');
  assert.ok(cmp.similar[0].score >= 0.9);
});

test('同方向局部裁切：横图被二次裁切后凭 NCC 归组', async () => {
  const sharp = require('sharp');
  const cfg = makeCfg();
  const width = 400, height = 200;
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      raw[i] = Math.round(255 * x / width);
      raw[i + 1] = Math.round(255 * y / height);
      raw[i + 2] = Math.round(128 + 64 * Math.sin(x / 12) * Math.cos(y / 9));
    }
  }
  const fullBuf = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
  // 同方向二次裁切：只截掉左右，宽高比从 2.0 变成 1.4（仍属横图）
  const cropBuf = await sharp(fullBuf).extract({ left: 60, top: 0, width: 280, height }).png().toBuffer();
  const full = await dedup.cropHashesOf(fullBuf, cfg);
  const crop = await dedup.cropHashesOf(cropBuf, cfg);
  const fullRel = 'wallpapers&illustration/heng/0001.png';
  const cropRel = 'wallpapers&illustration/heng/0002.png';
  // 故意让整图 hash 不命中，强制走局部裁切 NCC
  const item = (w, h, dhash, C) => ({
    w, h, dhash, chash: dhash, crops: [], cropVersion: dedup.CROP_VERSION,
    thumb: C.thumb, rowProf: C.rowProf, colProf: C.colProf
  });
  const index = { items: {
    [fullRel]: item(width, height, '0000000000000000', full),
    [cropRel]: item(280, height, 'ffffffffffffffff', crop)
  } };

  const g = dedup.findDuplicateGroups(index, 3, new Set(), { cfg, cropThreshold: 5 });
  assert.strictEqual(g.similarGroups.length, 1, '同方向二次裁切应凭 NCC 归组');
  assert.deepStrictEqual(g.similarGroups[0].slice().sort(), [fullRel, cropRel].sort());

  // 上传前查重同样命中，并标记 via=ncc
  const cmp = dedup.compareAgainstLibrary({ items: { [fullRel]: index.items[fullRel] } },
    'new-md5', 'ffffffffffffffff', 3, {
      item: {
        w: 280, h: height, chash: 'ffffffffffffffff', crops: [],
        thumb: crop.thumb, rowProf: crop.rowProf, colProf: crop.colProf
      },
      cfg, cropThreshold: 5
    });
  assert.strictEqual(cmp.similar.length, 1);
  assert.strictEqual(cmp.similar[0].via, 'ncc');

  // 同方向不参与"谁被裁切"的方向判断；清理时按面积保留完整大图
  const fullItem = { rel: fullRel, ...index.items[fullRel] };
  const cropItem = { rel: cropRel, ...index.items[cropRel] };
  assert.strictEqual(dedup.cropRelationOf(fullItem, cropItem, 5, cfg), null);
  assert.strictEqual(dedup.pickKeep([cropItem, fullItem], cfg).rel, fullRel);
});

test('同方向局部裁切：缩放后再裁切可从灰区复核命中', async () => {
  const sharp = require('sharp');
  const cfg = makeCfg();
  const width = 480, height = 240;
  // 确定性块状纹理：低频结构在缩到 48px 后仍保留，适合验证 NCC 灰区
  const raw = Buffer.alloc(width * height * 3);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const blocks = [];
  for (let k = 0; k < 40; k++) {
    blocks.push({
      x: Math.floor(rnd() * width), y: Math.floor(rnd() * height),
      w: 20 + Math.floor(rnd() * 80), h: 20 + Math.floor(rnd() * 60),
      v: Math.floor(rnd() * 255)
    });
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = Math.round(40 + 180 * (x / width));
      for (const b of blocks) {
        if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) v = b.v;
      }
      const i = (y * width + x) * 3;
      raw[i] = v; raw[i + 1] = Math.min(255, v + 20); raw[i + 2] = Math.max(0, v - 20);
    }
  }
  const fullBuf = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
  // 先裁出 340×220，再放大到 360×230：同时存在裁切与缩放
  const cropBuf = await sharp(fullBuf)
    .extract({ left: 70, top: 10, width: 340, height: 220 })
    .resize(360, 230, { fit: 'fill' }).png().toBuffer();
  const A = await dedup.cropHashesOf(fullBuf, cfg);
  const B = await dedup.cropHashesOf(cropBuf, cfg);
  const a = { rel: 'wallpapers&illustration/heng/a.png', w: width, h: height, ...A };
  const b = { rel: 'wallpapers&illustration/heng/b.png', w: 360, h: 230, ...B };

  const base = dedup.nccScore(a, b, new Map());
  assert.ok(base >= 0.75 && base < 0.9, `固定尺度应落在灰区，实际 NCC=${base}`);
  const score = dedup.nccCropMatch(a, b, new Map(), cfg);
  assert.ok(score !== null && score >= 0.9, `灰区缩放复核应命中，实际 NCC=${score}`);
});

// ---------------- 12. 裁切方向：保留完整原图 ----------------
test('裁切方向：固定裁切指纹能指出被截取的图', () => {
  const cfg = makeCfg();
  const heng = 'wallpapers&illustration/heng/0001.jpg';
  const shu = 'wallpapers&illustration/shu/0001.jpg';
  const A = {
    rel: heng, w: 1920, h: 1080,
    chash: 'aaaaaaaaaaaaaaaa',
    crops: [[0.5625, 'bbbbbbbbbbbbbbbb'], [1, 'cccccccccccccccc']]
  };
  const B = {
    rel: shu, w: 1080, h: 1920,
    chash: 'bbbbbbbbbbbbbbbb',
    crops: [[1.7778, 'dddddddddddddddd'], [1, 'eeeeeeeeeeeeeeee']]
  };
  const direction = dedup.cropRelationOf(A, B, 5, cfg);
  assert.ok(direction);
  assert.strictEqual(direction.cropRel, shu, '竖图整图命中横图裁切，竖图应是被截取图');
  assert.strictEqual(direction.fullRel, heng);

  const keep = dedup.pickCropKeeper([A, B], cfg, 5);
  assert.strictEqual(keep.keepRel, heng);
  assert.deepStrictEqual(keep.cropRels, [shu]);
});

test('裁切方向：多张截取图只保留完整原图', () => {
  const cfg = makeCfg();
  const full = {
    rel: 'wallpapers&illustration/shu/0001.jpg', w: 1080, h: 1920,
    chash: 'ffffffffffffffff',
    crops: [[1.7778, 'aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb']]
  };
  const a = { rel: 'wallpapers&illustration/heng/0001.jpg', w: 1920, h: 1080, chash: 'aaaaaaaaaaaaaaaa', crops: [] };
  const b = { rel: 'wallpapers&illustration/heng/0002.jpg', w: 1920, h: 1080, chash: 'bbbbbbbbbbbbbbbb', crops: [] };

  const keep = dedup.pickCropKeeper([full, a, b], cfg, 5);
  assert.strictEqual(keep.keepRel, full.rel);
  assert.deepStrictEqual(keep.cropRels.slice().sort(), [a.rel, b.rel].sort());
});

test('裁切方向：同方向不参与裁切方向判断', () => {
  const cfg = makeCfg();
  const a = { rel: 'wallpapers&illustration/heng/0001.jpg', w: 1920, h: 1080, chash: 'aaaaaaaaaaaaaaaa', crops: [[0.5625, 'bbbbbbbbbbbbbbbb']] };
  const b = { rel: 'wallpapers&illustration/heng/0002.jpg', w: 2560, h: 1440, chash: 'bbbbbbbbbbbbbbbb', crops: [[0.5625, 'cccccccccccccccc']] };
  assert.strictEqual(dedup.cropRelationOf(a, b, 5, cfg), null);
  assert.strictEqual(dedup.pickCropKeeper([a, b], cfg, 5), null);
});

test('裁切方向：NCC 滑窗能指出被截取的图', async () => {
  const sharp = require('sharp');
  const cfg = makeCfg();
  const width = 240, height = 120;
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      raw[i] = Math.round(255 * x / width);
      raw[i + 1] = Math.round(255 * y / height);
      raw[i + 2] = Math.round(128 + 64 * Math.sin(x / 12) * Math.cos(y / 9));
    }
  }
  const buf = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
  const cropBuf = await sharp(buf).extract({ left: 73, top: 0, width: 80, height: 120 }).png().toBuffer();
  const A = await dedup.cropHashesOf(buf, cfg);
  const B = await dedup.cropHashesOf(cropBuf, cfg);
  // 清空固定裁切指纹，强制走 NCC 方向判断
  const aItem = { rel: 'wallpapers&illustration/heng/a.png', w: width, h: height, ...A, chash: '0000000000000000', crops: [] };
  const bItem = { rel: 'wallpapers&illustration/shu/b.png', w: 80, h: 120, ...B, chash: 'ffffffffffffffff', crops: [] };

  const keep = dedup.pickCropKeeper([aItem, bItem], cfg, 5);
  assert.ok(keep);
  assert.strictEqual(keep.keepRel, aItem.rel, '完整横图应保留');
  assert.deepStrictEqual(keep.cropRels, [bItem.rel], '局部竖图应被去除');
  assert.strictEqual(keep.via, 'ncc');
});
