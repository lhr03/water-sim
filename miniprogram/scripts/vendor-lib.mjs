// 把 three-platformize / cannon-es 里真正用到的文件抽出来，放进 pkg-water/lib/
//
// 为什么要这么做：
//   微信开发者工具的「构建 npm」会把整个包复制进 miniprogram_npm。three-platformize
//   光 examples/ 就有 9.5MB，整包 14MB，而小程序单个分包上限是 2MB，必然上传失败。
//   这里按 import 图精确抽取，只保留 entry 及其相对依赖。
//
// 用法：先在本目录执行 npm install，然后
//   node scripts/vendor-lib.mjs

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, rmSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TP = join(ROOT, 'node_modules/three-platformize');
const OUT = join(ROOT, 'pkg-water/lib');

if (!existsSync(join(TP, 'package.json'))) {
  console.error('未找到 node_modules/three-platformize，请先在本目录执行 npm install');
  process.exit(1);
}

// 入口：主渲染库、平台适配层、以及实际用到的 addon
// 模型导入已砍掉（小程序沙箱里 GLTFLoader 取贴图必失败），所以不再抽 GLTFLoader /
// OBJLoader / STLLoader / ConvexHull —— 少 0.3MB 左右。
const ENTRIES = [
  'build/three.module.js',
  'src/WechatPlatform/index.js',
  'examples/jsm/controls/OrbitControls.js',
];

const RE_IMPORT = /(?:from|import)\s+['"](\.[^'"]+)['"]/g;

const seen = new Set();
const queue = [...ENTRIES];
const missing = [];

while (queue.length) {
  const rel = queue.shift();
  if (seen.has(rel)) continue;
  const abs = join(TP, rel);
  if (!existsSync(abs)) {
    missing.push(rel);
    continue;
  }
  seen.add(rel);

  const src = readFileSync(abs, 'utf8');
  for (const m of src.matchAll(RE_IMPORT)) {
    let spec = m[1];
    // 解析相对路径，扩展名可能被省略
    let target = resolve(dirname(abs), spec);
    if (!existsSync(target)) {
      if (existsSync(target + '.js')) target += '.js';
      else if (existsSync(join(target, 'index.js'))) target = join(target, 'index.js');
      else { missing.push(relative(TP, target)); continue; }
    }
    queue.push(relative(TP, target).replace(/\\/g, '/'));
  }
}

// 源码里有不带扩展名的相对引用（如 from '../libs/URL'）。Node 的 ESM 要求带扩展名，
// 微信开发者工具虽然能补，但统一规范化后两边行为一致，也便于在 Node 里跑验证。
function resolveSpec(absFile, spec) {
  let target = resolve(dirname(absFile), spec);
  if (existsSync(target) && statSync(target).isFile()) return target;
  if (existsSync(target + '.js')) return target + '.js';
  if (existsSync(join(target, 'index.js'))) return join(target, 'index.js');
  return null;
}

let total = 0;
for (const rel of seen) {
  const abs = join(TP, rel);
  let src = readFileSync(abs, 'utf8');
  src = src.replace(RE_IMPORT, (full, spec) => {
    const target = resolveSpec(abs, spec);
    if (!target) return full;
    let fixed = relative(dirname(abs), target).replace(/\\/g, '/');
    if (!fixed.startsWith('.')) fixed = './' + fixed;
    return full.replace(spec, fixed);
  });
  const to = join(OUT, rel);
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, src);
  total += statSync(to).size;
}
console.log(`three-platformize: 抽取 ${seen.size} 个文件，${(total / 1048576).toFixed(2)} MB`);

// cannon-es 是自包含的 ESM，单个文件即可
const cannonSrc = join(ROOT, 'node_modules/cannon-es/dist/cannon-es.js');
if (existsSync(cannonSrc)) {
  writeFileSync(join(OUT, 'cannon-es.js'), readFileSync(cannonSrc));
  total += statSync(join(OUT, 'cannon-es.js')).size;
  console.log('cannon-es: 已复制');
} else {
  console.error('未找到 cannon-es，请先 npm install');
  process.exit(1);
}

if (missing.length) {
  console.warn('未能解析的导入（请检查是否漏拷）：');
  for (const m of [...new Set(missing)]) console.warn('  ' + m);
}

console.log(`合计 ${(total / 1048576).toFixed(2)} MB → pkg-water/lib/`);
console.log(`分包上限 2 MB（上传时会压缩），${total / 1048576 < 2 ? '通过 ✓' : '已超限 ✗'}`);
