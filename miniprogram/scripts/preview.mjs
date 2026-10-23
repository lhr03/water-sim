/**
 * 生成预览二维码：手机微信扫了就能在真机上跑当前代码（不用等后台审核）。
 *
 * 用法：
 *   node scripts/preview.mjs                # 默认打开首页，二维码输出到 ../preview-qr.png
 *   node scripts/preview.mjs -o x.png       # 指定输出路径
 *
 * 注意：微信给的预览二维码有效期约 25 分钟，过期重新跑一次即可。
 */
import ci from 'miniprogram-ci';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-o' || a === '--out') out.out = argv[++i];
    else if (a === '-p' || a === '--page') out.page = argv[++i];
  }
  return out;
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const cfg = JSON.parse(readFileSync(join(ROOT, 'project.config.json'), 'utf8'));
const args = parseArgs(process.argv.slice(2));
const appid = cfg.appid;

const keyPath = join(ROOT, `private.${appid}.key`);
if (!existsSync(keyPath)) {
  console.error(`\n找不到上传密钥：${keyPath}`);
  console.error('先去 mp 后台「开发管理 → 开发设置」下载小程序代码上传密钥。\n');
  process.exit(1);
}

const outPath = resolve(ROOT, args.out || '../preview-qr.png');

const project = new ci.Project({
  appid,
  type: 'miniProgram',
  projectPath: ROOT,
  privateKeyPath: keyPath,
  ignores: ['node_modules/**/*', 'scripts/**/*', '*.key'],
});

try {
  await ci.preview({
    project,
    version: pkg.version || '1.0.0',
    desc: `预览 ${pkg.description || ''}`.trim(),
    qrcodeFormat: 'image',
    qrcodeOutputDest: outPath,
    pagePath: args.page || 'pages/index/index',
    setting: {
      es6: true,
      enhance: true,
      minified: true,
      minifyJS: true,
      minifyWXML: true,
      minifyWXSS: true,
      ignoreUploadUnusedFiles: true,
      autoPrefixWXSS: true,
    },
    onProgressUpdate: (task) => {
      if (task && task._status === 'done') return;
      process.stdout.write(`\r${task._msg || ''}`.padEnd(60));
    },
  });
} catch (err) {
  const msg = String((err && err.message) || err);
  const ip = msg.match(/invalid ip:\s*([\d.]+)/);
  if (ip) {
    console.error(`\n✗ 被 IP 白名单拦住，当前公网 IP：${ip[1]}`);
    console.error('到 mp 后台 → 开发管理 → 开发设置 →「代码上传IP白名单」加上它再跑。\n');
  } else {
    console.error(`\n✗ 生成失败：${msg}\n`);
  }
  process.exit(1);
}

console.log(`\n二维码已生成：${outPath}`);
console.log('用微信扫一扫即可打开（25 分钟内有效）。');
