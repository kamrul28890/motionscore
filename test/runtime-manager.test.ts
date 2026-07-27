import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RuntimeManager } from '../packages/web/src/runtime-manager.js';

let cleanupPath: string | null = null;
const originalRuntimeRoot = process.env.MOTIONSCORE_RUNTIME_ROOT;

afterEach(() => {
  if (cleanupPath) rmSync(cleanupPath, { recursive: true, force: true });
  cleanupPath = null;
  if (originalRuntimeRoot === undefined) delete process.env.MOTIONSCORE_RUNTIME_ROOT;
  else process.env.MOTIONSCORE_RUNTIME_ROOT = originalRuntimeRoot;
});

describe('managed analysis runtime', () => {
  it('keeps Python, FFmpeg, models, and metadata inside the private runtime root', () => {
    cleanupPath = mkdtempSync(join(tmpdir(), 'motionscore-runtime-test-'));
    process.env.MOTIONSCORE_RUNTIME_ROOT = cleanupPath;
    const manager = new RuntimeManager('C:\\unused-project');

    expect(manager.managedPython).toBe(join(cleanupPath, 'python', 'python.exe'));
    expect(manager.ffmpegPath).toBe(join(cleanupPath, 'bin', 'ffmpeg.exe'));
    expect(manager.markerPath).toBe(join(cleanupPath, 'runtime.json'));
  });

  it('reads valid installation metadata and ignores malformed metadata', () => {
    cleanupPath = mkdtempSync(join(tmpdir(), 'motionscore-runtime-test-'));
    process.env.MOTIONSCORE_RUNTIME_ROOT = cleanupPath;
    const manager = new RuntimeManager('C:\\unused-project');

    writeFileSync(manager.markerPath, '{"version":1,"mode":"cpu"}', 'utf8');
    expect(manager.readMarker()).toEqual({ version: 1, mode: 'cpu' });

    writeFileSync(manager.markerPath, 'not-json', 'utf8');
    expect(manager.readMarker()).toBeNull();
  });
});
