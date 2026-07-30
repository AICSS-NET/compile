/**
 * 构建浏览器版 webcrack 精简包
 */
import { build } from 'esbuild';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const outDir = join(root, 'dist');
const outFile = join(outDir, 'webcrack.min.js');
const require = createRequire(import.meta.url);

/** 不走 exports，直接定位 node_modules/webcrack */
function getPkgDir() {
  // 1) 优先用 require.resolve 主入口，再向上找 package.json
  try {
    const mainPath = require.resolve('webcrack');
    let dir = dirname(mainPath);
    for (let i = 0; i < 6; i++) {
      const pkgFile = join(dir, 'package.json');
      if (existsSync(pkgFile)) {
        const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
        if (pkg.name === 'webcrack') return dir;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // ignore
  }

  // 2) 回退：项目根 node_modules
  const fallback = join(root, 'node_modules', 'webcrack');
  if (existsSync(join(fallback, 'package.json'))) return fallback;

  throw new Error('找不到 webcrack 安装目录，请先: npm install webcrack');
}

function resolveEntry(pkgDir) {
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  const candidates = [];

  if (pkg.exports && pkg.exports['.']) {
    const exp = pkg.exports['.'];
    if (typeof exp === 'string') candidates.push(join(pkgDir, exp));
    if (exp && typeof exp === 'object') {
      if (typeof exp.import === 'string') candidates.push(join(pkgDir, exp.import));
      if (exp.import && typeof exp.import === 'object' && exp.import.default) {
        candidates.push(join(pkgDir, exp.import.default));
      }
      if (typeof exp.require === 'string') candidates.push(join(pkgDir, exp.require));
      if (exp.require && typeof exp.require === 'object' && exp.require.default) {
        candidates.push(join(pkgDir, exp.require.default));
      }
      if (typeof exp.default === 'string') candidates.push(join(pkgDir, exp.default));
    }
  }
  if (pkg.module) candidates.push(join(pkgDir, pkg.module));
  if (pkg.main) candidates.push(join(pkgDir, pkg.main));
  candidates.push(
    join(pkgDir, 'dist/index.js'),
    join(pkgDir, 'dist/index.mjs'),
    join(pkgDir, 'dist/index.cjs')
  );

  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  throw new Error('找不到 webcrack 入口文件，尝试过:\n' + candidates.join('\n'));
}

function main() {
  mkdirSync(outDir, { recursive: true });

  const pkgDir = getPkgDir();
  const entry = resolveEntry(pkgDir);
  console.log('pkgDir:', pkgDir);
  console.log('entry:', entry);

  const stubDir = join(outDir, '.stubs');
  mkdirSync(stubDir, { recursive: true });

  writeFileSync(
    join(stubDir, 'fs-promises.js'),
    `
export const readFile = async () => { throw new Error('fs not available in browser'); };
export const writeFile = async () => { throw new Error('fs not available in browser'); };
export const mkdir = async () => { throw new Error('fs not available in browser'); };
export default { readFile, writeFile, mkdir };
`
  );

  writeFileSync(
    join(stubDir, 'path.js'),
    `
export const join = (...a) => a.filter(Boolean).join('/').replace(/\\/+/g, '/');
export const dirname = (p) => String(p).replace(/\\/?[^/]+\\/?$/, '') || '.';
export const relative = (from, to) => to;
export const normalize = (p) => String(p).replace(/\\/+/g, '/');
export default { join, dirname, relative, normalize };
`
  );

  writeFileSync(
    join(stubDir, 'isolated-vm.js'),
    `
export default class Isolate {
  constructor() { throw new Error('isolated-vm is not available in browser'); }
}
`
  );

  return build({
    entryPoints: [entry],
    outfile: outFile,
    bundle: true,
    minify: true,
    format: 'iife',
    globalName: 'WebcrackBundle',
    platform: 'browser',
    target: ['es2020'],
    logLevel: 'info',
    alias: {
      'node:fs/promises': join(stubDir, 'fs-promises.js'),
      'fs/promises': join(stubDir, 'fs-promises.js'),
      'node:fs': join(stubDir, 'fs-promises.js'),
      fs: join(stubDir, 'fs-promises.js'),
      'node:path': join(stubDir, 'path.js'),
      path: join(stubDir, 'path.js'),
      'isolated-vm': join(stubDir, 'isolated-vm.js'),
    },
    define: {
      'process.env.NODE_ENV': '"production"',
      'process.browser': 'true',
    },
    banner: {
      js: '/* webcrack browser slim — unminify/deobfuscate/unpack/jsx/mangle */',
    },
    footer: {
      js: `
;(function () {
  var b = typeof WebcrackBundle !== 'undefined' ? WebcrackBundle : null;
  if (!b) return;
  var api = b.webcrack || b.default || b;
  if (api && typeof api.webcrack === 'function') api = api.webcrack;
  if (typeof api === 'function') {
    if (typeof self !== 'undefined') self.webcrack = api;
    if (typeof window !== 'undefined') window.webcrack = api;
  }
})();
`,
    },
  }).then(() => {
    const buf = readFileSync(outFile);
    console.log('built:', outFile, '(' + (buf.length / 1024).toFixed(1) + ' KB)');
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
