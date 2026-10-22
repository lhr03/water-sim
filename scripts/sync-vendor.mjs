/**
 * 把 node_modules 里的 three / cannon-es 拷贝到 vendor/，
 * 供 index.html 的 importmap 直接引用（这样运行时不需要打包工具）。
 *
 * vendor/ 不进 git，npm install 之后会自动跑这个脚本（见 package.json 的 postinstall）。
 * 也可以手动执行：npm run sync
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nm = (p) => path.join(root, 'node_modules', p);
const vd = (p) => path.join(root, 'vendor', p);

const JOBS = [
  { from: nm('three/build/three.module.js'), to: vd('three/three.module.js') },
  { from: nm('three/examples/jsm'), to: vd('three/addons'), dir: true },
  { from: nm('cannon-es/dist/cannon-es.js'), to: vd('cannon-es.js') },
];

let done = 0;
for (const job of JOBS) {
  if (!fs.existsSync(job.from)) {
    console.error(`[sync-vendor] 缺少 ${path.relative(root, job.from)}，请先执行 npm install`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(job.to), { recursive: true });
  fs.rmSync(job.to, { recursive: true, force: true });
  fs.cpSync(job.from, job.to, job.dir ? { recursive: true } : undefined);
  const size = job.dir ? dirSize(job.to) : fs.statSync(job.to).size;
  console.log(`  ✓ ${path.relative(root, job.to)}  (${(size / 1024 / 1024).toFixed(2)} MB)`);
  done++;
}

function dirSize(p) {
  let total = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const full = path.join(p, e.name);
    total += e.isDirectory() ? dirSize(full) : fs.statSync(full).size;
  }
  return total;
}

console.log(`[sync-vendor] 完成，共 ${done} 项。现在可以运行：npm start`);
