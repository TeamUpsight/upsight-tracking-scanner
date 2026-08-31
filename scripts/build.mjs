import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { build as bundleServer } from 'esbuild';
import { build as buildClient } from 'vite';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const distDirectory = resolve(projectRoot, 'dist');

function firstValue(...values) {
  return values.find((value) => typeof value === 'string' && value.trim())?.trim();
}

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

const buildCommit = firstValue(
  process.env.BUILD_COMMIT,
  process.env.CF_PAGES_COMMIT_SHA,
  process.env.GITHUB_SHA,
  gitCommit()
);
const buildTimestamp = firstValue(process.env.BUILD_TIMESTAMP) ?? new Date().toISOString();
const define = {
  __BUILD_COMMIT__: JSON.stringify(buildCommit ?? ''),
  __BUILD_TIMESTAMP__: JSON.stringify(buildTimestamp)
};

rmSync(distDirectory, { recursive: true, force: true });
await buildClient({
  configFile: false,
  root: projectRoot,
  plugins: [react(), tailwindcss()]
});
await bundleServer({
  absWorkingDir: projectRoot,
  entryPoints: [resolve(projectRoot, 'server.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  sourcemap: true,
  outfile: resolve(distDirectory, 'server.cjs'),
  define
});

console.log(`[Build] package_version=${packageJson.version} build_commit=${buildCommit ?? 'unavailable'} build_timestamp=${buildTimestamp}`);
