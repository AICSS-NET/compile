/**
 * 构建浏览器版 webcrack 精简包
 * 目标：保留 unminify / deobfuscate / unpack / jsx / mangle
 * 去掉：CLI、result.save（fs）、isolated-vm 等 Node 专用路径
 */
import { build } from 'esbuild';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const outDir = join(root, 'dist');
const outFile = join(outDir, 'webcrack.min.js');

const require = createRequire(import.meta.url);

// 解析 webcrack 入口（优先用已安装的包）
function resolveWebcrackEntry() {
  try {
    const pkgPath = require.resolve('webcrack/package.json');
    const pkg = JSON.parse(awaitableRead(pkgPath));
    // ESM 入口
    if (pkg.exports?.['.']?.import) {
      return join(dirname(pkgPath), pkg.exports['.'].import.default || pkg.exports['.'].import);
    }
    if (pkg.module) return join(dirname(pkgPath), pkg.module);
    if (pkg.main) return join(dirname(pkgPath), pkg.main);
  } catch {
    // fallthrough
  }
  throw new Error('webcrack not found. Run: npm i webcrack');
}

function awaitableRead(p) {
  // sync helper for resolve path only
  return require('fs').readFileSync(p, 'utf8');
}

async function main() {
  await mkdir(outDir, { recursive: true });

  const entry = (() => {
    try {
      const pkgPath = require.resolve('webcrack/package.json');
      const pkg = JSON.parse(require('fs').readFileSync(pkgPath, 'utf8'));
      const dir = dirname(pkgPath);
      if (pkg.exports?.['.']?.import?.default) return join(dir, pkg.exports['.'].import.default);
      if (typeof pkg.exports?.['.']?.import === 'string') return join(dir, pkg.exports['.'].import);
      if (pkg.module) return join(dir, pkg.module);
      return join(dir, pkg.main || 'dist/index.js');
    } catch (e) {
      throw new Error('请先安装 webcrack: npm i webcrack@latest\n' + e.message);
    }
  })();

  console.log('entry:', entry);

  // 浏览器 stub：拦截 Node 专用模块，避免打进 fs / isolated-vm
  const stubFs = `
    export const readFile = async () => { throw new Error('fs not available in browser'); };
    export const writeFile = async () => { throw new Error('fs not available in browser'); };
    export const mkdir = async () => { throw new Error('fs not available in browser'); };
    export default { readFile, writeFile, mkdir };
  `;
  const stubPath = `
    export const join = (...a) => a.filter(Boolean).join('/').replace(/\\/+/g, '/');
    export const dirname = (p) => p.replace(/\\/?[^/]+\\/?$/, '') || '.';
    export const relative = (from, to) => to;
    export const normalize = (p) => p.replace(/\\/+/g, '/');
    export default { join, dirname, relative, normalize };
  `;
  const stubIsolatedVm = `
    export default class Isolate {
      constructor() { throw new Error('isolated-vm is not available in browser'); }
    }
  `;

  const stubDir = join(outDir, '.stubs');
  await mkdir(stubDir, { recursive: true });
  await writeFile(join(stubDir, 'fs-promises.js'), stubFs);
  await writeFile(join(stubDir, 'path.js'), stubPath);
  await writeFile(join(stubDir, 'isolated-vm.js'), stubIsolatedVm);

  await build({
    entryPoints: [entry],
    outfile: outFile,
    bundle: true,
    minify: true,
    format: 'iife',
    globalName: 'WebcrackBundle',
    platform: 'browser',
    target: ['es2020'],
    logLevel: 'info',
    // 不把 Node 内建打进去
    external: [],
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
      js: '/* webcrack browser slim build — unminify/deobfuscate/unpack/jsx/mangle */',
    },
    footer: {
      // 兼容你页面里的全局 webcrack(...)
      js: `
;typeof WebcrackBundle !== 'undefined' && (function () {
  var api = WebcrackBundle.webcrack || WebcrackBundle.default || WebcrackBundle;
  if (typeof api === 'function') {
    self.webcrack = api;
    if (typeof window !== 'undefined') window.webcrack = api;
  } else if (api && typeof api.webcrack === 'function') {
    self.webcrack = api.webcrack;
    if (typeof window !== 'undefined') window.webcrack = api.webcrack;
  }
})();
`,
    },
  });

  const buf = await readFile(outFile);
  console.log('built:', outFile, '(' + (buf.length / 1024).toFixed(1) + ' KB)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
