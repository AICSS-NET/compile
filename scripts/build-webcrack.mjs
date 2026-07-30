/**
 * webcrack 浏览器精简包
 * 保留：unminify / deobfuscate / unpack / jsx / mangle
 * 去掉运行时依赖：save 写盘、CLI、isolated-vm（stub）
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

function getPkgDir(name) {
  try {
    const mainPath = require.resolve(name);
    let dir = dirname(mainPath);
    for (let i = 0; i < 8; i++) {
      const pkgFile = join(dir, 'package.json');
      if (existsSync(pkgFile)) {
        const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
        if (pkg.name === name) return dir;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // ignore
  }
  const fallback = join(root, 'node_modules', name);
  if (existsSync(join(fallback, 'package.json'))) return fallback;
  throw new Error(`找不到 ${name}，请先 npm install ${name}`);
}

function resolveEntry(pkgDir) {
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  const candidates = [];

  if (pkg.exports?.['.']) {
    const exp = pkg.exports['.'];
    if (typeof exp === 'string') candidates.push(join(pkgDir, exp));
    if (exp && typeof exp === 'object') {
      if (typeof exp.import === 'string') candidates.push(join(pkgDir, exp.import));
      if (exp.import?.default) candidates.push(join(pkgDir, exp.import.default));
      if (typeof exp.require === 'string') candidates.push(join(pkgDir, exp.require));
      if (exp.require?.default) candidates.push(join(pkgDir, exp.require.default));
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
  throw new Error('找不到 webcrack 入口:\n' + candidates.join('\n'));
}

function resolvePolyfill(name, stubPath) {
  try {
    return require.resolve(name);
  } catch {
    try {
      return require.resolve(name + '/');
    } catch {
      return stubPath;
    }
  }
}

function writeStubs(stubDir) {
  mkdirSync(stubDir, { recursive: true });

  writeFileSync(
    join(stubDir, 'assert.js'),
    `
function ok(v, msg) { if (!v) throw new Error(msg || 'assertion failed'); }
function equal(a, b, msg) { if (a != b) throw new Error(msg || 'not equal'); }
function strictEqual(a, b, msg) { if (a !== b) throw new Error(msg || 'not strict equal'); }
function deepEqual() {}
const api = { ok, equal, strictEqual, deepEqual, assert: ok };
api.strict = api;
export default api;
export { ok, equal, strictEqual, deepEqual };
`
  );

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
export const basename = (p) => String(p).split('/').pop();
export const extname = (p) => { const m = String(p).match(/\\.\\w+$/); return m ? m[0] : ''; };
export const isAbsolute = (p) => String(p).startsWith('/');
export const sep = '/';
export default { join, dirname, relative, normalize, basename, extname, isAbsolute, sep };
`
  );

  writeFileSync(
    join(stubDir, 'util.js'),
    `
export function inherit(c, p) {
  c.prototype = Object.create(p.prototype, {
    constructor: { value: c, writable: true, configurable: true },
  });
}
export function format(f, ...args) {
  let i = 0;
  return String(f).replace(/%[sdj%]/g, (x) => {
    if (x === '%%') return '%';
    if (i >= args.length) return x;
    const a = args[i++];
    if (x === '%s') return String(a);
    if (x === '%d') return Number(a);
    if (x === '%j') { try { return JSON.stringify(a); } catch { return '[Circular]'; } }
    return x;
  });
}
export function inspect(v) { try { return JSON.stringify(v); } catch { return String(v); } }
export const types = {
  isDate: (v) => v instanceof Date,
  isRegExp: (v) => v instanceof RegExp,
};
export default { inherit, format, inspect, types };
`
  );

  writeFileSync(
    join(stubDir, 'process.js'),
    `
const process = {
  env: { NODE_ENV: 'production' },
  browser: true,
  nextTick: (fn) => queueMicrotask(fn),
  cwd: () => '/',
  platform: 'browser',
  version: '',
  versions: {},
  argv: [],
  title: 'browser',
  stdout: { write: () => {} },
  stderr: { write: () => {} },
};
export default process;
`
  );

  writeFileSync(
    join(stubDir, 'isolated-vm.js'),
    `
export default class Isolate {
  constructor() {
    throw new Error('isolated-vm is not available in browser');
  }
}
`
  );
}

async function main() {
  mkdirSync(outDir, { recursive: true });

  const pkgDir = getPkgDir('webcrack');
  const entry = resolveEntry(pkgDir);
  console.log('pkgDir:', pkgDir);
  console.log('entry:', entry);

  const stubDir = join(outDir, '.stubs-webcrack');
  writeStubs(stubDir);

  let pathPath = join(stubDir, 'path.js');
  try {
    pathPath = require.resolve('path-browserify');
  } catch {
    // stub
  }

  const assertPath = resolvePolyfill('assert/', join(stubDir, 'assert.js'));
  const utilPath = resolvePolyfill('util/', join(stubDir, 'util.js'));

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
    mainFields: ['browser', 'module', 'main'],
    conditions: ['browser', 'import', 'default'],
    alias: {
      assert: assertPath,
      'node:assert': assertPath,
      util: utilPath,
      'node:util': utilPath,
      path: pathPath,
      'node:path': pathPath,
      'node:fs/promises': join(stubDir, 'fs-promises.js'),
      'fs/promises': join(stubDir, 'fs-promises.js'),
      'node:fs': join(stubDir, 'fs-promises.js'),
      fs: join(stubDir, 'fs-promises.js'),
      'isolated-vm': join(stubDir, 'isolated-vm.js'),
      process: join(stubDir, 'process.js'),
      'node:process': join(stubDir, 'process.js'),
    },
    define: {
      'process.env.NODE_ENV': '"production"',
      'process.browser': 'true',
      global: 'globalThis',
    },
    banner: {
      js: '/* webcrack browser — unminify/deobfuscate/unpack/jsx/mangle (no save/cli) */',
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
  });

  const buf = readFileSync(outFile);
  console.log('built:', outFile, '(' + (buf.length / 1024).toFixed(1) + ' KB)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
