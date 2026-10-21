'use strict';
/**
 * 模块：零依赖 ZIP 打包（stored 存储式，不压缩）
 * ---------------------------------------------------------------
 * 为什么不用压缩：图库内容（jpg/png/webp/avif/gif）本身已是压缩格式，
 * deflate 压缩率接近 0 却白耗 CPU；stored 方式只做"容器封装"。
 *
 * 为什么不引第三方库：本模块依赖固定且封装极小（本地文件头 + 中央目录 + EOCD），
 * 自行实现可避免新增供应链依赖。
 *
 * 兼容性策略：CRC32 与尺寸采用"两遍读"（先流式算 CRC，再流式写出），
 * 不使用数据描述符——Windows 资源管理器/macOS 归档工具对描述符的 stored
 * 条目兼容性参差不齐，两遍读换来的是最广泛的解压兼容性（磁盘缓存使第二遍几乎免费）。
 *
 * 限制（32 位 ZIP 格式本身）：条目数 < 65535、单文件 < 4GB、包体 < ~3.5GB；
 * 超出由调用方在创建任务前拒绝（见 server.js /api/download/zip）。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { once } = require('events');

/* ---------- CRC32（ISO 3309，多项式 0xEDB88320） ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

/** 增量 CRC32：跨 chunk 调用时把上一段返回值作为 crc 传入 */
function crc32(buf, crc = 0) {
  let c = ~crc;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (~c) >>> 0;
}

/** DOS 时间/日期（ZIP 头格式；年份范围 1980-2107） */
function dosDateTime(d) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | (Math.floor(d.getSeconds() / 2) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

/**
 * 把若干文件打包成 ZIP 流式写入 HTTP 响应。
 * @param {import('http').ServerResponse} res
 * @param {Array<{abs:string, name:string}>} entries name 为包内文件名（不含目录分隔符）
 * @param {string} zipName 下载文件名（Content-Disposition 使用）
 */
async function streamZip(res, entries, zipName) {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition',
    `attachment; filename="lti-images.zip"; filename*=UTF-8''${encodeURIComponent(zipName)}`);

  let aborted = false;
  res.on('close', () => { aborted = true; }); // 客户端中断下载时停止读盘

  let offset = 0;
  const writeBuf = async (buf) => {
    if (aborted) throw new Error('client-aborted');
    if (!res.write(buf)) await once(res, 'drain');
    offset += buf.length;
  };

  const centrals = [];
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const st = await fsp.stat(e.abs);
    const { time, date } = dosDateTime(new Date(st.mtimeMs));

    // 第一遍：流式累计 CRC32 与大小（不落内存）
    let crc = 0, size = 0;
    for await (const chunk of fs.createReadStream(e.abs)) {
      if (aborted) return;
      crc = crc32(chunk, crc); size += chunk.length;
    }

    // 本地文件头（30B）+ 文件名 + 数据
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);  // 本地文件头签名
    lh.writeUInt16LE(20, 4);          // 解压所需版本
    lh.writeUInt16LE(0x0800, 6);      // 标志位：bit11 UTF-8 文件名
    lh.writeUInt16LE(0, 8);           // 方式 0 = stored
    lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(size, 18); lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    const localOffset = offset;
    await writeBuf(lh);
    await writeBuf(nameBuf);
    // 第二遍：流式写出数据
    for await (const chunk of fs.createReadStream(e.abs)) await writeBuf(chunk);

    // 中央目录记录（46B + 文件名），全部后置写入
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);  // 中央目录签名
    ch.writeUInt16LE(20, 0);          // 创建版本
    ch.writeUInt16LE(20, 2);          // 解压所需版本
    ch.writeUInt16LE(0x0800, 4);      // 同样的 UTF-8 标志
    ch.writeUInt16LE(0, 6);
    ch.writeUInt16LE(time, 8); ch.writeUInt16LE(date, 10);
    ch.writeUInt32LE(crc, 12); ch.writeUInt32LE(size, 16); ch.writeUInt32LE(size, 20);
    ch.writeUInt16LE(nameBuf.length, 28); // extra/comment/磁盘号/内外属性均 0
    ch.writeUInt32LE(0, 38);          // 外部文件属性
    ch.writeUInt32LE(localOffset, 42);
    centrals.push(Buffer.concat([ch, nameBuf]));
  }

  // 中央目录 + EOCD 收尾
  const cdStart = offset;
  for (const c of centrals) await writeBuf(c);
  const cdSize = offset - cdStart;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12); eocd.writeUInt32LE(cdStart, 16);
  res.end(eocd);
}

module.exports = { streamZip, crc32 };
