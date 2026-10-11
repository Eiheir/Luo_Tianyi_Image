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

  // csv：含中文表头，使用 Windows 换行
  const csv = links.exportLinks(cfg, rows, 'jsdelivr', 'csv');
  assert.ok(csv.startsWith('文件名,分类,宽,高,大小(字节),链接'));
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
