// Video exporter for MotionScore Stage F.
//
// `exportVideo` muxes the numbered PNG frame sequence produced by the renderer
// (Stage E) together with the original audio track into a single H.264 MP4
// (Req 6.1). Before touching the encoder it runs a fail-fast pre-flight check
// that an ffmpeg binary is actually runnable, throwing an `ExportError` with
// install instructions when it is not (Req 6.2). The video stream uses the
// libx264 codec (or a caller-supplied codec) at a configurable CRF quality
// (default 18, Req 6.3), and the output frame rate matches the configured fps.
//
// ffmpeg interop: `fluent-ffmpeg` is a CommonJS module whose `module.exports`
// is the command-factory function itself. Under ESM/nodenext that value is the
// default export, so it is imported as `import ffmpeg from 'fluent-ffmpeg'` and
// invoked as `ffmpeg()` (a named import of the factory would be undefined).
// fluent-ffmpeg spawns ffmpeg without a shell, so config paths are passed as
// arguments and never interpolated into a shell string.
//
// ffmpeg itself is an external runtime dependency: fluent-ffmpeg does NOT bundle
// a binary. It invokes `ffmpeg` from PATH, or the path in the `FFMPEG_PATH`
// environment variable. The pre-flight honors the same resolution so it verifies
// the exact binary that will be used.

import { spawn } from 'node:child_process';
import { join } from 'node:path';

import ffmpeg from 'fluent-ffmpeg';
import type { ExportConfig } from '@motionscore/types';
import { ExportError } from '@motionscore/types';

/** Default H.264 encoder used when `ExportConfig.codec` is omitted (Req 6.3). */
const DEFAULT_VIDEO_CODEC = 'libx264';

/** Default constant-rate-factor quality when `ExportConfig.quality` is omitted (Req 6.3). */
const DEFAULT_CRF = 18;

/**
 * AAC audio for the muxed track. The source audio may be WAV/MP3/FLAC/OGG;
 * re-encoding to AAC guarantees a codec the MP4 container accepts regardless of
 * the input format.
 */
const OUTPUT_AUDIO_CODEC = 'aac';

/** Binary name used when no explicit ffmpeg path is configured. */
const DEFAULT_FFMPEG_BINARY = 'ffmpeg';

/** Actionable guidance included in the "ffmpeg not found" error (Req 6.2). */
const FFMPEG_INSTALL_HINT =
  'Install ffmpeg from https://ffmpeg.org/download.html and ensure it is on your PATH ' +
  '(or set the FFMPEG_PATH environment variable to the ffmpeg binary path).';

/**
 * Progress reported by ffmpeg during encoding, passed through as-is from
 * fluent-ffmpeg's `progress` event. Both fields are best-effort: ffmpeg cannot
 * always estimate total duration up front, so `percent` may be undefined, and
 * for image-sequence inputs its estimate can be rough and occasionally exceed
 * 100. Treat `frames` as the reliable field and `percent` as an approximation.
 */
export interface ExportProgress {
  /** Approximate completion percentage (roughly [0, 100]), when ffmpeg reports it. */
  percent?: number;
  /** Number of frames processed so far. */
  frames?: number;
}

/** Callback invoked with encoding progress updates (see {@link exportVideo}). */
export type ExportProgressCallback = (progress: ExportProgress) => void;

/**
 * Resolve the ffmpeg binary fluent-ffmpeg will invoke: the `FFMPEG_PATH`
 * environment variable when set and non-empty, otherwise `ffmpeg` (resolved
 * against PATH by the OS at spawn time).
 */
function resolveFfmpegBinary(): string {
  const fromEnv = process.env.FFMPEG_PATH;
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : DEFAULT_FFMPEG_BINARY;
}

/**
 * Pre-flight check (Req 6.2): report whether an ffmpeg binary is runnable.
 *
 * Spawns `<ffmpeg> -version` directly with arguments passed as an array (no
 * shell, so nothing is interpolated) and resolves `true` only on a clean exit.
 * A missing binary (spawn `error`/ENOENT) or a non-zero exit resolves `false`.
 * Never rejects, so callers can branch on the boolean.
 */
export function checkFfmpegAvailable(): Promise<boolean> {
  const binary = resolveFfmpegBinary();
  return new Promise<boolean>((resolveCheck) => {
    let settled = false;
    const settle = (value: boolean): void => {
      if (!settled) {
        settled = true;
        resolveCheck(value);
      }
    };
    try {
      const child = spawn(binary, ['-version'], { shell: false, stdio: 'ignore' });
      // ENOENT (binary not found) and other spawn failures land here.
      child.on('error', () => settle(false));
      // `code` is null if the process was killed by a signal; only 0 is success.
      child.on('close', (code) => settle(code === 0));
    } catch {
      // spawn can throw synchronously for some invalid inputs.
      settle(false);
    }
  });
}

/** Throw an `ExportError` with install instructions when ffmpeg is unavailable (Req 6.2). */
async function assertFfmpegAvailable(): Promise<void> {
  const available = await checkFfmpegAvailable();
  if (!available) {
    throw new ExportError(`ffmpeg was not found or is not runnable. ${FFMPEG_INSTALL_HINT}`);
  }
}

/** Validate the config fields `exportVideo` relies on, throwing `ExportError` on misuse. */
function validateConfig(config: ExportConfig): void {
  const requireNonEmpty = (name: 'frameDir' | 'framePattern' | 'audioPath' | 'outputPath'): void => {
    const value = config[name];
    if (typeof value !== 'string' || value.length === 0) {
      throw new ExportError(`exportVideo: config.${name} must be a non-empty string.`);
    }
  };
  requireNonEmpty('frameDir');
  requireNonEmpty('framePattern');
  requireNonEmpty('audioPath');
  requireNonEmpty('outputPath');
  if (!Number.isFinite(config.fps) || config.fps <= 0) {
    throw new ExportError(
      `exportVideo: config.fps must be a finite number > 0, received ${config.fps}.`,
    );
  }
}

/**
 * Export the rendered frame sequence + audio into an H.264 MP4 (Stage F).
 *
 * Pipeline: verify ffmpeg is available (fail fast, Req 6.2) -> feed the image2
 * frame sequence (`frameDir/framePattern`, e.g. `frame_%05d.png`) as the video
 * input at `config.fps` -> add `config.audioPath` as the audio input -> encode
 * video with H.264 (`config.codec ?? 'libx264'`) at CRF `config.quality ?? 18`
 * with `-pix_fmt yuv420p` for broad player compatibility, and audio as AAC ->
 * write the MP4 to `config.outputPath` (Req 6.1, 6.3).
 *
 * Frame numbering: the input uses `-start_number 1` to match the renderer's
 * 1-based `frame_00001.png` naming (the image2 demuxer already defaults to 1,
 * so this is belt-and-suspenders).
 *
 * Duration matching (Req 6.4): the renderer emits one frame per `1/fps` spanning
 * the whole trajectory (which covers the notes' timeline), so the video length
 * tracks the audio length. `-shortest` is intentionally NOT used: truncating to
 * the shorter stream could clip the audio tail. The output therefore runs to the
 * longer of the two streams, and correct duration relies on the frame count
 * covering the audio.
 *
 * @param config Frame directory + pattern, audio path, output path, fps, and
 *   optional codec/quality overrides.
 * @param onProgress Optional callback invoked with `{ percent?, frames? }` as
 *   ffmpeg reports encoding progress.
 * @returns A promise that resolves with `config.outputPath` once encoding
 *   finishes successfully.
 * @throws {ExportError} if the config is invalid, ffmpeg is unavailable, or the
 *   ffmpeg process fails (the underlying error is attached as `cause`).
 */
export async function exportVideo(
  config: ExportConfig,
  onProgress?: ExportProgressCallback,
): Promise<string> {
  validateConfig(config);

  // Fail fast before spending time on the encode (Req 6.2).
  await assertFfmpegAvailable();

  const videoCodec = config.codec ?? DEFAULT_VIDEO_CODEC;
  const crf = config.quality ?? DEFAULT_CRF;
  const framesInput = join(config.frameDir, config.framePattern);
  const fps = String(config.fps);

  return new Promise<string>((resolveExport, rejectExport) => {
    ffmpeg()
      // Input 0: the numbered PNG frames, read as an image sequence at `fps`.
      .input(framesInput)
      .inputOptions(['-framerate', fps, '-start_number', '1'])
      // Input 1: the original audio track to mux alongside the video.
      .input(config.audioPath)
      .videoCodec(videoCodec)
      .audioCodec(OUTPUT_AUDIO_CODEC)
      .outputOptions([
        '-map', '0:v:0', // video from the frame sequence
        '-map', '1:a:0', // audio from the audio file
        '-crf', String(crf),
        '-pix_fmt', 'yuv420p',
        '-r', fps,
      ])
      .format('mp4')
      .on('progress', (progress) => {
        onProgress?.({ percent: progress.percent, frames: progress.frames });
      })
      .on('error', (err: Error) => {
        rejectExport(
          new ExportError(
            `ffmpeg failed while exporting to ${config.outputPath}: ${err.message}`,
            { cause: err },
          ),
        );
      })
      .on('end', () => {
        resolveExport(config.outputPath);
      })
      .save(config.outputPath);
  });
}
