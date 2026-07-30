/**
 * 构建浏览器版 webcrack 精简包
 */
import { build } from 'esbuild';
import { mkdir, writeFile, readFile, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const mkdirAsync = promisify(mkdir);
const writeFileAsync = promisify(writeFile);
const readFileAsync = promisify(readFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const outDir = join(root, 'dist');
const outFile = join(outDir, 'webcrack.min.js');
const require = createRequire(import.meta.url);

function resolveEntry() {
  const pkgPath = require.resolve('webcrack/package.json');
  const dir = dirname(pkgPath);
  const pkg = JSON.parse(require('fs').readFileSync(pkgPath, 'utf8'));

  const candidates = [];
  if (pkg.exports?.['.']) {
    const exp = pkg.exports['.'];
    if (typeof exp === 'string') candidates.push(join(dir, exp));
    if (exp.import) {
      if (typeof exp.import === 'string') candidates.push(join(dir, exp.import));
      else if (exp.import.default) candidates.push(join(dir, exp.import.default));
    }
    if (exp.default) candidates.push(join(dir, exp.default));
  }
  if (pkg.module) candidates.push(join(dir, pkg.module));
  if (pkg.main) candidates.push(join(dir, pkg.main));
  candidates.push(join(dir, 'dist/index.js'));

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error('找不到 webcrack 入口，candidates:\n' + candidates.join('\n'));
}

async function main() {
  await mkdirAsync(outDir, { recursive: true });

  const entry = resolveEntry();
  console.log('entry:', entry);

  const stubDir = join(outDir, '.stubs');
  await mkdirAsync(stubDir, { recursive: true });

  await writeFileAsync(
    join(stubDir, 'fs-promises.js'),
    `
export const readFile = async () => { throw new Error('fs not available in browser'); };
export const writeFile = async () => { throw new Error('fs not available in browser'); };
export const mkdir = async () => { throw new Error('fs not available in browser'); };
export default { readFile, writeFile, mkdir };
`
  );

  await writeFileAsync(
    join(stubDir, 'path.js'),
    `
export const join = (...a) => a.filter(Boolean).join('/').replace(/\\/+/g, '/');
export const dirname = (p) => String(p).replace(/\\/?[^/]+\\/?$/, '') || '.';
export const relative = (from, to) => to;
export const normalize = (p) => String(p).replace(/\\/+/g, '/');
export default { join, dirname, relative, normalize };
`
  );

  await writeFileAsync(
    join(stubDir, 'isolated-vm.js'),
    `
export default class Isolate {
  constructor() { throw new Error('isolated-vm is not available in browser'); }
}
`
  );

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
  });

  const buf = await readFileAsync(outFile);
  console.log('built:', outFile, '(' + (buf.length / 1024).toFixed(1) + ' KB)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
