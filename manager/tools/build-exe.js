'use strict';
/**
 * 打包脚本：把整个管理器（运行时 + 依赖 + Web 界面）编译为单个 Windows exe
 * ---------------------------------------------------------------
 * 使用：npm run build  （或 node tools/build-exe.js）
 * 产物：manager/dist/LTY-图床管理器.exe（单文件，双击即用，无需安装 Node）
 *
 * 技术要点：
 *  - 使用 @yao-pkg/pkg（社区活跃维护的 pkg 分支）把 Node 运行时打进 exe
 *  - sharp 的原生二进制位于 node_modules/@img/，pkg 的静态分析追踪不到
 *    动态加载，必须在 package.json 的 pkg.assets 中显式声明
 *  - 运行时 process.pkg 标志已由 core/config.js 识别：配置/缓存/回收站
 *    全部落到 exe 旁边（可写），Web 资源从快照内读取（只读）
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const MODULE_ROOT = path.resolve(__dirname, '..');
const OUT_NAME = 'LTY-图床管理器.exe';

/** 依次尝试的 Node 目标版本（首个可用者胜出） */
const TARGETS = ['node24-win-x64', 'node22-win-x64', 'node20-win-x64'];

function main() {
  console.log('── 步骤 1/3：检查打包依赖 ──');
  // 确认生产依赖已安装（打包必须包含 node_modules）
  if (!fs.existsSync(path.join(MODULE_ROOT, 'node_modules', 'sharp'))) {
    console.error('尚未安装依赖，请先执行：npm install');
    process.exit(1);
  }

  console.log('── 步骤 2/3：执行打包（首次运行会下载运行时，需要几分钟） ──');
  let done = false;
  let lastErr = '';
  for (const target of TARGETS) {
    try {
      execSync(
        `npx --yes @yao-pkg/pkg server.js --config package.json --target ${target} --compress GZip --output "dist/${OUT_NAME}"`,
        { cwd: MODULE_ROOT, stdio: 'inherit' }
      );
      done = true;
      break;
    } catch (e) {
      // 当前目标版本的基础二进制不可用时自动尝试下一个
      lastErr = e.message;
      console.warn(`目标 ${target} 打包失败，尝试下一版本…`);
    }
  }
  if (!done) {
    console.error('全部目标版本打包失败。最后一次错误：\n' + lastErr);
    process.exit(1);
  }

  console.log('── 步骤 3/3：校验产物 ──');
  const out = path.join(MODULE_ROOT, 'dist', OUT_NAME);
  if (!fs.existsSync(out)) {
    console.error('未找到打包产物：' + out);
    process.exit(1);
  }
  const sizeMB = (fs.statSync(out).size / 1024 / 1024).toFixed(1);
  console.log('──────────────────────────────────────────────');
  console.log(`打包完成：${out}`);
  console.log(`体积：${sizeMB} MB（含 Node 运行时 + sharp 图像引擎 + Web 界面）`);
  console.log('使用：把 exe 放到仓库根目录（与 LTYpicture 同级）后双击运行，');
  console.log('      会自动在 exe 旁生成 config.json 与 .cache/.trash 数据目录。');
  console.log('──────────────────────────────────────────────');
}

main();
