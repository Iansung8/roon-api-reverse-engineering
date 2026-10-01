import { build } from 'esbuild';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function testFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(full);
    return entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

const root = path.dirname(new URL(import.meta.url).pathname);
const entries = [...testFiles(path.join(root, 'server')), ...testFiles(path.join(root, 'public'))];
const output = mkdtempSync(path.join(tmpdir(), 'roon-web-tests-'));

try {
  await build({
    entryPoints: entries,
    outdir: output,
    outbase: root,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
  });
  // esbuild already emitted .js files, so discover them directly.
  const emitted = [];
  const collect = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) collect(full);
      else if (entry.name.endsWith('.test.js')) emitted.push(full);
    }
  };
  collect(output);
  const result = spawnSync(process.execPath, ['--test', ...emitted], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(output, { recursive: true, force: true });
}
