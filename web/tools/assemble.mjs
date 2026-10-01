// Assembles the browser version into ./_site (or the folder given), from the
// repository: the desktop app's own pages and scripts, the browser backend,
// the ported engine, the WebAssembly builds, the models, and pinned copies of
// third-party files (from node_modules, installed by `npm ci`).
//   node web/tools/assemble.mjs [out-dir]
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(web, '..');
const out = resolve(process.argv[2] || join(repo, '_site'));
const cp = (from, to, opts = {}) => {
  if (!existsSync(from)) throw new Error(`missing: ${from}`);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true, ...opts });
};
const notTests = { filter: (src) => !/[\\/](test|src)([\\/]|$)/.test(src.slice(web.length)) };

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// The pages and their scripts: the desktop app's, unchanged...
const pages = join(repo, 'vocalgraph', 'static');
for (const f of ['index.html', 'tracks.html', 'live.html']) cp(join(pages, f), join(out, f));
for (const f of ['nav.js', 'voice.js', 'resonance.js']) cp(join(pages, f), join(out, 'static', f));
// ...but with the browser version's boot.js, service worker and backend.
cp(join(web, 'app', 'static', 'boot.js'), join(out, 'static', 'boot.js'));
// The service worker carries the version: a new one makes browsers offer the update.
let version = 'local';
try { version = execSync('git rev-parse --short HEAD', { cwd: repo }).toString().trim(); } catch {}
version += '-' + Date.now().toString(36);
writeFileSync(join(out, 'sw.js'), readFileSync(join(web, 'app', 'sw.js'), 'utf8').replace("'__VERSION__'", JSON.stringify(version)));
cp(join(web, 'app', 'backend'), join(out, 'backend'));

// The engine (ports of the Python analysis) and the WebAssembly builds.
cp(join(web, 'engine'), join(out, 'engine'), notTests);
cp(join(web, 'smile'), join(out, 'smile'), notTests);
if (existsSync(join(web, 'ffmpeg'))) cp(join(web, 'ffmpeg'), join(out, 'ffmpeg'), notTests);
for (const f of readdirSync(join(repo, 'vocalgraph', 'models')).filter(f => f.endsWith('.onnx')))
  cp(join(repo, 'vocalgraph', 'models', f), join(out, 'models', f));

// ONNX Runtime Web, pinned by web/package-lock.json.
const ort = join(web, 'node_modules', 'onnxruntime-web');
for (const f of ['ort.all.bundle.min.mjs', 'ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.jsep.mjs',
                 'ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs'])
  cp(join(ort, 'dist', f), join(out, 'vendor', 'onnxruntime-web', f));
cp(join(web, 'licenses', 'onnxruntime-LICENSE.txt'), join(out, 'vendor', 'onnxruntime-web', 'LICENSE.txt'));

// The test page, as before, now under test/.
cp(join(web, 'pages-test'), join(out, 'test'));

// What was built, for the page's "update available" check and bug reports.
writeFileSync(join(out, 'version.json'), JSON.stringify({ version, built: new Date().toISOString() }) + '\n');
writeFileSync(join(out, '.nojekyll'), '');
console.log(`assembled ${out}`);
