// @motionscore/note-extractor
//
// Turns an audio file into a rich {@link AudioAnalysis} using neural
// per-instrument separation (Demucs `htdemucs_6s`). This is the only analysis
// path: the mix is separated into real instrument stems, onsets are detected
// per stem, and compact continuous activity/register signals are emitted for
// every visual role.

import { extname } from 'node:path';

import { InputError, type AudioAnalysis } from '@motionscore/types';

import { analyzeAudioEvents, detectStemsGpuAvailable } from './audio-events.js';
import { summarizeAnalysis } from './summary.js';

export { analyzeAudioEvents, extractAudioEvents, detectStemsGpuAvailable } from './audio-events.js';
export { summarizeAnalysis } from './summary.js';

/** Audio file extensions the analyzer accepts (lower-cased, leading dot). */
export const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  '.wav',
  '.mp3',
  '.flac',
  '.ogg',
]);

/**
 * Analyze an audio file into a full {@link AudioAnalysis} (per-stem onsets,
 * 10 Hz feature frames, section cues, and per-role neural signals).
 *
 * @throws {InputError} if the extension is unsupported or no events are found.
 * @throws {TranscriptionError} if the analyzer subprocess fails (Python/Demucs
 *   unavailable, non-zero exit, or invalid output).
 */
export async function analyzeAudio(inputPath: string): Promise<AudioAnalysis> {
  const ext = extname(inputPath).toLowerCase();
  if (!AUDIO_EXTENSIONS.has(ext)) {
    throw new InputError(
      `Unsupported input file type "${ext || '(no extension)'}" for ${inputPath}. ` +
        `Supported audio extensions: ${[...AUDIO_EXTENSIONS].join(', ')}.`,
      { filePath: inputPath },
    );
  }
  const analysis = await analyzeAudioEvents(inputPath);
  if (analysis.hits.length === 0) {
    throw new InputError(`No instrument onsets were detected in ${inputPath}.`, {
      filePath: inputPath,
    });
  }
  return analysis;
}

/** Convenience: analyze and return the compact UI summary alongside the analysis. */
export async function analyzeAudioWithSummary(inputPath: string) {
  const analysis = await analyzeAudio(inputPath);
  return { analysis, summary: summarizeAnalysis(analysis) };
}
