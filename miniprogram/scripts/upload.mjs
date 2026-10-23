/**
 * 用官方 miniprogram-ci 上传小程序代码。
 *
 * 用法：
 *   node scripts/upload.mjs                       # 用 package.json 的版本号 + 默认备注
 *   node scripts/upload.mjs -v 1.0.1              # 指定版本号
 *   node scripts/upload.mjs -v 1.0.1 -d "说明"     # 指定版本号和备注
 *   node scripts/upload.mjs --robot 3             # 指定 CI 机器人编号（1~30，后台需配置）
 *
 * 前置：把 mp 后台下载的上传密钥放到项目根目录，文件名 private.<appid>.key
 * 位置：https://mp.weixin.qq.com -> 开发 -> 开发管理 -> 开发设置 -> 小程序代码上传密钥
 */
import ci from 'miniprogram-ci';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 极简命令行参数解析：-v/-d/--robot */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-v' || a === '--version') out.version = argv[++i];
    else if (a === '-d' || a === '--desc') out.desc = argv[++i];
    else if (a === '--robot') out.robot = Number(argv[++i]);
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
  console.error('请到 mp 后台下载「小程序代码上传密钥」，按这个文件名放进项目根目录。');
  console.error('路径：mp.weixin.qq.com -> 开发 -> 开发管理 -> 开发设置\n');
  process.exit(1);
}

const version = args.version || pkg.version || '1.0.0';
const desc = args.desc || `${cfg.description || pkg.description || ''} v${version}`.trim();

const project = new ci.Project({
  appid,
  type: 'miniProgram',
  projectPath: ROOT,
  privateKeyPath: keyPath,
  ignores: ['node_modules/**/*', 'scripts/**/*', '*.key'],
});

console.log(`准备上传：${desc}（${appid}）`);

const uploadResult = await ci.upload({
  project,
  version,
  desc,
  robot: args.robot || 1,
  setting: {
    es6: true,
    enhance: true,
    minified: true,
    minifyJS: true,
    minifyWXML: true,
    minifyWXSS: true,
    ignoreUploadUnusedFiles: true,
    codeProtect: false,
    autoPrefixWXSS: true,
  },
  onProgressUpdate: (task) => {
    if (task && task._status === 'done') return;
    process.stdout.write(`\r${task._msg || ''}`.padEnd(60));
  },
});

console.log('\n上传完成 ✓');
console.log('下一步到 mp 后台「版本管理」把这一版设为体验版或提交审核：');
console.log(`https://mp.weixin.qq.com/wxamp/version/list?appid=${appid}`);
if (uploadResult && uploadResult.subPackageInfo) {
  console.log('分包信息：', JSON.stringify(uploadResult.subPackageInfo));
}
if (uploadResult && uploadResult.pluginInfo) {
  console.log('插件信息：', JSON.stringify(uploadResult.pluginInfo));
}
