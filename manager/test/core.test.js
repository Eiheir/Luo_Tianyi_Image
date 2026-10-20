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

test('organize：编号规整消除空洞且两阶段改名无碰撞', async () => {
  const { root, cfg, index } = await makeOrgEnv();
  try {
    const dir = path.join(cfg._paths.imageRoot, 'avatar');
    await fsp.mkdir(dir, { recursive: true });
    // 编号集合 {1,3,5}，含"3→2 时 1 不冲突"的常规情形；索引登记 0003
    await fsp.writeFile(path.join(dir, '0001.jpg'), 'a');
    await fsp.writeFile(path.join(dir, '0003.jpg'), 'b');
    await fsp.writeFile(path.join(dir, '0005.jpg'), 'c');
    await fsp.writeFile(path.join(dir, 'readme.txt'), 'skip'); // 非编号文件不动
    dedup.setIndexItem(index, 'avatar/0003.jpg', { mtime: 1, size: 1, w: 1, h: 1, md5: '', dhash: '' });

    const r = await organize.renumberDirectory(cfg, index, 'wallpapers&illustration/avatar'.replace('wallpapers&illustration/', ''));
    // 上面一行等价于 'avatar'（direct dir），返回映射应把 0003→0002
    assert.strictEqual(r.total, 3);
    assert.strictEqual(r.renumbered, 2); // 0003→0002、0005→0003（0001 不变）
    assert.ok((await fsp.readFile(path.join(dir, '0002.jpg'))).toString() === 'b');
    assert.ok((await fsp.readFile(path.join(dir, '0003.jpg'))).toString() === 'c');
    assert.ok(await fileExists(path.join(dir, '0001.jpg')));
    assert.ok(await fileExists(path.join(dir, 'readme.txt')), '非编号文件不应被动');
    assert.ok(index.items['avatar/0002.jpg'], '索引应换到新键 0002');
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
    dedup: { hammingThreshold: 5, onExactDuplicate: 'skip' },
    linkFormat: 'jsdelivr',
    git: { purgeCdn: false },
    _paths: { secret: 'x' }
  });
  assert.deepStrictEqual(Object.keys(view).sort(),
    ['dedup.hammingThreshold', 'dedup.onExactDuplicate', 'git.purgeCdn',
     'linkFormat', 'upload.maxBatchFiles', 'upload.maxFileMB', 'upload.quality'].sort());
});

test('settings：SETTABLE 校验函数拒绝越界值', () => {
  assert.strictEqual(settings.SETTABLE['upload.quality'](50), 50);
  assert.strictEqual(settings.SETTABLE['upload.quality'](10), null);   // 低于下限
  assert.strictEqual(settings.SETTABLE['upload.quality']('abc'), null); // 非数字
  assert.strictEqual(settings.SETTABLE['linkFormat']('fastly'), 'fastly');
  assert.strictEqual(settings.SETTABLE['linkFormat']('evil'), null);
  assert.strictEqual(settings.SETTABLE['git.purgeCdn'](true), true);
  assert.strictEqual(settings.SETTABLE['git.purgeCdn'](1), null);
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
