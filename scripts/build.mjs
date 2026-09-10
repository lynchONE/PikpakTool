import { readFile, mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = ['api.mjs', 'batch.mjs', 'connection.mjs', 'core.mjs', 'journal.mjs', 'local-api.mjs', 'progress.mjs', 'task.mjs', 'task.html', 'task.css', 'launcher.html', 'launcher.css', 'manifest.json', 'start-local.cmd', 'README.md', 'LICENSE', 'scripts/local-server.mjs'];
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (manifest.manifest_version !== 3 || manifest.version !== pkg.version) throw new Error('Package and extension versions must match');
if (manifest.host_permissions.join() !== 'https://api-drive.mypikpak.com/*') throw new Error('Unexpected host permissions');
if (!files.includes(manifest.action.default_popup) || !files.includes(manifest.options_page)) throw new Error('Missing extension entry point');
const html = await readFile(join(root, 'task.html'), 'utf8'), script = await readFile(join(root, 'task.mjs'), 'utf8');
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
for (const match of script.matchAll(/\$\('([^']+)'\)/g)) if (!ids.has(match[1])) throw new Error(`Missing task UI element: ${match[1]}`);
for (const name of files) {
  const source = join(root, name), target = join(root, 'dist', name);
  if (name.endsWith('.mjs')) execFileSync(process.execPath, ['--check', source], { windowsHide: true, stdio: 'pipe' });
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
}
console.log(`Build passed: PikpakTool ${manifest.version}; ${files.length} runtime files written to dist/`);
