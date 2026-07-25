import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const desktopDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(desktopDir, '..');
const outputDir = resolve(desktopDir, 'generated');

await mkdir(outputDir, { recursive: true });
await build({
  entryPoints: [resolve(projectRoot, 'packages', 'web', 'dist', 'server.js')],
  outfile: resolve(outputDir, 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});

const developmentPython = resolve(projectRoot, '.venv', 'Scripts', 'python.exe');
await writeFile(
  resolve(outputDir, 'runtime.json'),
  `${JSON.stringify(
    {
      developmentPython: existsSync(developmentPython) ? developmentPython : null,
    },
    null,
    2,
  )}\n`,
  'utf8',
);
