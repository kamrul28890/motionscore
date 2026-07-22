import { defineConfig } from 'vitest/config';

/**
 * Workspace packages that make up the MotionScore pipeline.
 * Each becomes an isolated Vitest project so tests run with the correct
 * root and are reported per-package.
 */
const packages = [
  'types',
  'note-extractor',
  'musical-mapper',
  'trajectory-solver',
  'renderer',
  'video-export',
  'cli',
] as const;

export default defineConfig({
  test: {
    projects: [
      // Root-level infrastructure / toolchain smoke tests.
      {
        test: {
          name: 'root',
          root: '.',
          include: ['test/**/*.test.ts'],
        },
      },
      // One project per workspace package. Tests live alongside sources
      // as `*.test.ts` files under each package's `src` directory.
      ...packages.map((pkg) => ({
        test: {
          name: pkg,
          root: `./packages/${pkg}`,
          include: ['src/**/*.test.ts'],
        },
      })),
    ],
  },
});
