// Unit tests for the MotionScore frame renderer (task 7.1, Stage E).
//
// These are example-based tests (no property tests, per the task scope). They
// cover:
//   - interpolatePosition: clamping and linear interpolation (Req 5.1)
//   - exceedsFailureBudget: the 5% frame-failure abort threshold (Req 5.6)
//   - render(): correct frame count, sequential zero-padded naming (Req 5.5),
//     valid PNG output, target/trail/particle toggles not crashing, empty-input
//     handling, and config validation.
//
// The end-to-end render tests use a tiny scene (64x48, fps 10, <=0.3s, a couple
// of targets) written to a unique temp directory that is removed afterward, so
// the suite never generates a large number of frames or leaves artifacts.
//
// Sources are imported via their `.js` specifiers so Vitest runs against the
// current TypeScript rather than a possibly-stale `dist/`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ChoreographyTarget,
  ObjectTrajectory,
  RenderConfig,
} from '@motionscore/types';

import { render, RenderError, exceedsFailureBudget } from './render.js';
import { interpolatePosition } from './interpolate.js';

// --- Fixtures ---------------------------------------------------------------

/** Two targets struck at 0.1s and 0.3s. */
function makeTargets(): ChoreographyTarget[] {
  return [
    { noteId: 'n1', timeSec: 0.1, position: { x: 20, y: 30 }, impactSize: 0.5, colorHint: '#4477ff' },
    { noteId: 'n2', timeSec: 0.3, position: { x: 50, y: 30 }, impactSize: 0.9, colorHint: '#ff7700' },
  ];
}

/** A short trajectory ending at t=0.3s with two impact keyframes. */
function makeTrajectory(): ObjectTrajectory {
  return {
    objectId: 'ball_01',
    keyframes: [
      { tSec: 0, pos: [10, 40], vel: [100, -50] },
      { tSec: 0.1, pos: [20, 30], vel: [100, 0], hitsTarget: 'n1' },
      { tSec: 0.2, pos: [35, 32], vel: [100, 20] },
      { tSec: 0.3, pos: [50, 30], vel: [100, 0], hitsTarget: 'n2' },
    ],
  };
}

function makeConfig(outputDir: string, overrides: Partial<RenderConfig> = {}): RenderConfig {
  return {
    fps: 10,
    width: 64,
    height: 48,
    backgroundColor: '#1a1a2e',
    ballRadius: 4,
    showTrail: true,
    particlesOnImpact: true,
    outputDir,
    ...overrides,
  };
}

/** PNG file signature (magic bytes). */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

async function isValidPng(path: string): Promise<boolean> {
  const buf = await readFile(path);
  if (buf.length < PNG_MAGIC.length) {
    return false;
  }
  return PNG_MAGIC.every((byte, i) => buf[i] === byte);
}

// --- Temp directory lifecycle ----------------------------------------------

let baseDir: string;
let dirCounter = 0;

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'motionscore-renderer-'));
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

/** Allocate a fresh, unique output subdirectory for a single test. */
function nextOutDir(): string {
  dirCounter += 1;
  return join(baseDir, `frames-${dirCounter}`);
}

// --- interpolatePosition (Req 5.1) -----------------------------------------

describe('interpolatePosition', () => {
  const keyframes = makeTrajectory().keyframes;

  it('clamps to the first keyframe for times at or before the start', () => {
    expect(interpolatePosition(keyframes, -1)).toEqual([10, 40]);
    expect(interpolatePosition(keyframes, 0)).toEqual([10, 40]);
  });

  it('clamps to the last keyframe for times at or after the end', () => {
    expect(interpolatePosition(keyframes, 0.3)).toEqual([50, 30]);
    expect(interpolatePosition(keyframes, 99)).toEqual([50, 30]);
  });

  it('returns exact keyframe positions at keyframe times', () => {
    expect(interpolatePosition(keyframes, 0.1)).toEqual([20, 30]);
    expect(interpolatePosition(keyframes, 0.2)).toEqual([35, 32]);
  });

  it('linearly interpolates between two keyframes', () => {
    // Midpoint of [0.1 -> 0.2]: halfway between [20,30] and [35,32].
    const [x, y] = interpolatePosition(keyframes, 0.15);
    expect(x).toBeCloseTo(27.5, 6);
    expect(y).toBeCloseTo(31, 6);
  });

  it('interpolates at an arbitrary fraction within a segment', () => {
    // 25% into [0 -> 0.1]: [10,40] + 0.25*([20,30]-[10,40]) = [12.5, 37.5].
    const [x, y] = interpolatePosition(keyframes, 0.025);
    expect(x).toBeCloseTo(12.5, 6);
    expect(y).toBeCloseTo(37.5, 6);
  });

  it('holds a single-keyframe trajectory at its only position', () => {
    const single = [{ tSec: 1, pos: [7, 8] as [number, number], vel: [0, 0] as [number, number] }];
    expect(interpolatePosition(single, 0)).toEqual([7, 8]);
    expect(interpolatePosition(single, 1)).toEqual([7, 8]);
    expect(interpolatePosition(single, 5)).toEqual([7, 8]);
  });
});

// --- exceedsFailureBudget (Req 5.6) ----------------------------------------

describe('exceedsFailureBudget', () => {
  it('is false at or below the 5% threshold', () => {
    expect(exceedsFailureBudget(0, 100)).toBe(false);
    expect(exceedsFailureBudget(5, 100)).toBe(false); // exactly 5%, not "more than"
  });

  it('is true above the 5% threshold', () => {
    expect(exceedsFailureBudget(6, 100)).toBe(true);
  });

  it('treats any single failure in a tiny render as over budget', () => {
    expect(exceedsFailureBudget(0, 1)).toBe(false);
    expect(exceedsFailureBudget(1, 1)).toBe(true); // 100% > 5%
  });
});

// --- render(): end-to-end frame output -------------------------------------

describe('render', () => {
  it('writes ceil(maxTSec*fps)+1 sequentially numbered, valid PNG frames (Req 5.5)', async () => {
    const outDir = nextOutDir();
    const paths = await render(makeTrajectory(), makeTargets(), makeConfig(outDir));

    // maxTSec=0.3, fps=10 -> ceil(3)+1 = 4 frames.
    expect(paths).toHaveLength(4);
    expect(paths[0]?.endsWith('frame_00001.png')).toBe(true);
    expect(paths[1]?.endsWith('frame_00002.png')).toBe(true);
    expect(paths[2]?.endsWith('frame_00003.png')).toBe(true);
    expect(paths[3]?.endsWith('frame_00004.png')).toBe(true);

    for (const path of paths) {
      expect(await isValidPng(path)).toBe(true);
      expect((await stat(path)).size).toBeGreaterThan(8);
    }
  });

  it('renders with trail and particles disabled without error', async () => {
    const outDir = nextOutDir();
    const paths = await render(
      makeTrajectory(),
      makeTargets(),
      makeConfig(outDir, { showTrail: false, particlesOnImpact: false }),
    );
    expect(paths).toHaveLength(4);
    expect(await isValidPng(paths[0]!)).toBe(true);
  });

  it('renders even when there are no targets', async () => {
    const outDir = nextOutDir();
    const paths = await render(makeTrajectory(), [], makeConfig(outDir));
    expect(paths).toHaveLength(4);
    expect(await isValidPng(paths[3]!)).toBe(true);
  });

  it('returns an empty list for a trajectory with no keyframes', async () => {
    const outDir = nextOutDir();
    const paths = await render({ objectId: 'ball_01', keyframes: [] }, makeTargets(), makeConfig(outDir));
    expect(paths).toEqual([]);
    // The output directory is still created for downstream stages.
    expect((await stat(outDir)).isDirectory()).toBe(true);
  });

  it('rejects invalid configuration with a RenderError', async () => {
    const outDir = nextOutDir();
    await expect(render(makeTrajectory(), makeTargets(), makeConfig(outDir, { fps: 0 }))).rejects.toBeInstanceOf(
      RenderError,
    );
    await expect(
      render(makeTrajectory(), makeTargets(), makeConfig(outDir, { ballRadius: -1 })),
    ).rejects.toBeInstanceOf(RenderError);
    await expect(
      render(makeTrajectory(), makeTargets(), makeConfig(outDir, { width: Number.NaN })),
    ).rejects.toBeInstanceOf(RenderError);
  });
});
