import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const scanRoots = ['js', 'tests', 'research', 'scripts'];
const files = [];

async function visit(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const fullPath = join(path, entry.name);
    if (entry.isDirectory()) await visit(fullPath);
    else if (['.js', '.mjs'].includes(extname(entry.name))) files.push(fullPath);
  }
}

for (const dir of scanRoots) await visit(join(root, dir));
files.sort();

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    process.stderr.write(`\n문법 검사 실패: ${relative(root, file)}\n`);
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
}

console.log(`JavaScript 문법 검사 통과 · ${files.length}개 파일`);

