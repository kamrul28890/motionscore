// Video-only export for the CLI pipeline (task 9.2).
//
// Stage F (`@motionscore/video-export`'s `exportVideo`) always muxes an audio
// track: it declares a second ffmpeg input and maps `1:a:0`. That is exactly
// right for audio input (M2), where the original file carries the audio to sync
// against. A MIDI file, however, has no decodable audio track — synthesizing one
// (soundfont rendering) is out of scope for M1 — so there is nothing to mux.
//
// Rather than change the Stage F contract (its `ExportConfig.audioPath` is
// required and the audio mapping is intentional for the audio path), this module
// provides a sibling encoder that emits a video-only MP4 from the rendered frame
// sequence. The CLI selects it for MIDI input and keeps `exportVideo` for audio
// input (see `pipeline.ts`), so `motionscore song.mid -o out.mp4` still produces
// a valid, playable video — just without an audio track.
//
// It deliberately mirrors `exportVideo`'s ffmpeg setup (image2 sequence at fps,
// H.264 + CRF, `-pix_fmt yuv420p` for broad compatibility) and reuses Stage F's
// `checkFfmpegAvailable` pre-flight so behavior and error reporting stay
// consistent across both export paths. The only differences are the absence of
// an audio input/mapping and the explicit `.noAudio()`.
//
// ffmpeg interop matches Stage F: `fluent-ffmpeg` is a CommonJS module whose
// `module.exports` is the command factory itself, so under ESM/nodenext it is
// the default export — imported as `import ffmpeg from 'fluent-ffmpeg'` and
// called as `ffmpeg()`. fluent-ffmpeg spawns ffmpeg without a shell, so paths
// are passed as arguments and never interpolated into a shell string.

import { join } from 'node:path';

import ffmpeg from 'fluent-ffmpeg';
import { ExportError } from '@motionscore/types';
import {
  checkFfmpegAvailable,
  type ExportProgressCallback,
} from '@motionscore/video-export';

/** Default H.264 encoder, matching Stage F (Req 6.3). */
const DEFAULT_VIDEO_CODEC = 'libx264';

/** Default constant-rate-factor quality, matching Stage F (Req 6.3). */
const DEFAULT_CRF = 18;

/** Actionable guidance surfaced when ffmpeg is unavailable (Req 6.2). */
export const FFMPEG_INSTALL_HINT =
  'Install ffmpeg from https://ffmpeg.org/download.html and ensure it is on your PATH ' +
  '(or set the FFMPEG_PATH environment variable to the ffmpeg binary path).';

/**
 * Configuration for {@link exportVideoOnly}: the same fields as Stage F's
 * `ExportConfig` minus `audioPath` (there is no audio to mux).
 */
export interface VideoOnlyExportConfig {
  /** Directory containing the frame PNGs. */
  frameDir: string;
  /** ffmpeg frame filename pattern (e.g. `'frame_%05d.png'`). */
  framePattern: string;
  /** Final output video path. */
  outputPath: string;
  /** Frame rate of the input frame sequence. */
  fps: number;
  /** Video codec (default: `'libx264'`). */
  codec?: string;
  /** H.264 CRF quality value (default: 18). */
  quality?: number;
}

/**
 * Fail-fast pre-flight (Req 6.2 / design Error Scenario 4): throw an
 * {@link ExportError} with install instructions when no runnable ffmpeg binary
 * is found. Callers run this before the expensive render so a missing ffmpeg is
 * reported before any frames are produced.
 */
export async function assertFfmpegAvailable(): Promise<void> {
  const available = await checkFfmpegAvailable();
  if (!available) {
    throw new ExportError(`ffmpeg was not found or is not runnable. ${FFMPEG_INSTALL_HINT}`);
  }
}

/** Validate the config fields, throwing `ExportError` on misuse. */
function validateConfig(config: VideoOnlyExportConfig): void {
  const requireNonEmpty = (name: 'frameDir' | 'framePattern' | 'outputPath'): void => {
    const value = config[name];
    if (typeof value !== 'string' || value.length === 0) {
      throw new ExportError(`exportVideoOnly: config.${name} must be a non-empty string.`);
    }
  };
  requireNonEmpty('frameDir');
  requireNonEmpty('framePattern');
  requireNonEmpty('outputPath');
  if (!Number.isFinite(config.fps) || config.fps <= 0) {
    throw new ExportError(
      `exportVideoOnly: config.fps must be a finite number > 0, received ${config.fps}.`,
    );
  }
}

/**
 * Encode the rendered PNG frame sequence into an H.264 MP4 with no audio track.
 *
 * Pipeline: verify ffmpeg is available (fail fast, Req 6.2) -> feed the image2
 * frame sequence (`frameDir/framePattern`, e.g. `frame_%05d.png`) as the sole
 * input at `config.fps` -> encode with H.264 (`config.codec ?? 'libx264'`) at
 * CRF `config.quality ?? 18` with `-pix_fmt yuv420p` for broad player
 * compatibility -> write the MP4 to `config.outputPath`.
 *
 * Frame numbering uses `-start_number 1` to match the renderer's 1-based
 * `frame_00001.png` naming. This is the MIDI-input counterpart to Stage F's
 * `exportVideo` (which additionally muxes audio); see the module header for why
 * MIDI produces a video-only file in M1.
 *
 * @param config Frame directory + pattern, output path, fps, and optional
 *   codec/quality overrides.
 * @param onProgress Optional callback invoked with `{ percent?, frames? }` as
 *   ffmpeg reports encoding progress.
 * @returns A promise that resolves with `config.outputPath` once encoding
 *   finishes successfully.
 * @throws {ExportError} if the config is invalid, ffmpeg is unavailable, or the
 *   ffmpeg process fails (the underlying error is attached as `cause`).
 */
export async function exportVideoOnly(
  config: VideoOnlyExportConfig,
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
      // Sole input: the numbered PNG frames, read as an image sequence at `fps`.
      .input(framesInput)
      .inputOptions(['-framerate', fps, '-start_number', '1'])
      .videoCodec(videoCodec)
      .outputOptions([
        '-map', '0:v:0', // video from the frame sequence
        '-crf', String(crf),
        '-pix_fmt', 'yuv420p',
        '-r', fps,
      ])
      .noAudio()
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
