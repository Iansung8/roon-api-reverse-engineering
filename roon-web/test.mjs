import { build } from 'esbuild';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function testFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(full);
    return entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

const root = path.dirname(fileURLToPath(import.meta.url));
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
    outExtension: { '.js': '.mjs' },
  });
  // Explicit ESM extensions also work on Node versions without syntax detection.
  const emitted = [];
  const collect = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) collect(full);
      else if (entry.name.endsWith('.test.mjs')) emitted.push(full);
    }
  };
  collect(output);
  const result = spawnSync(process.execPath, ['--test', ...emitted], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(output, { recursive: true, force: true });
}
