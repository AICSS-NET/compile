/**
 * javascript-obfuscator 浏览器包
 * 基于官方 browser 入口再 minify
 */
import { build } from 'esbuild';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const outDir = join(root, 'dist');
const outFile = join(outDir, 'javascript-obfuscator.min.js');
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

function resolveBrowserEntry(pkgDir) {
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  const candidates = [
    pkg.browser && join(pkgDir, pkg.browser),
    join(pkgDir, 'dist/index.browser.js'),
    join(pkgDir, 'dist/index.browser.min.js'),
    pkg.module && join(pkgDir, pkg.module),
    pkg.main && join(pkgDir, pkg.main),
  ].filter(Boolean);

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error('找不到 javascript-obfuscator browser 入口:\n' + candidates.join('\n'));
}

async function main() {
  mkdirSync(outDir, { recursive: true });

  const pkgDir = getPkgDir('javascript-obfuscator');
  const entry = resolveBrowserEntry(pkgDir);
  console.log('pkgDir:', pkgDir);
  console.log('entry:', entry);

  await build({
    entryPoints: [entry],
    outfile: outFile,
    bundle: true,
    minify: true,
    format: 'iife',
    globalName: 'JavaScriptObfuscator',
    platform: 'browser',
    target: ['es2020'],
    logLevel: 'info',
    mainFields: ['browser', 'module', 'main'],
    banner: {
      js: '/* javascript-obfuscator browser — compact/cff/deadcode/stringArray/renameGlobals/idgen/target */',
    },
    footer: {
      js: `
;(function () {
  var api = typeof JavaScriptObfuscator !== 'undefined' ? JavaScriptObfuscator : null;
  if (!api) return;
  if (api.default && typeof api.default.obfuscate === 'function') api = api.default;
  if (typeof self !== 'undefined') self.JavaScriptObfuscator = api;
  if (typeof window !== 'undefined') window.JavaScriptObfuscator = api;
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
