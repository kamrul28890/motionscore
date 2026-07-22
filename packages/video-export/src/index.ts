// @motionscore/video-export
//
// Stage F: muxes the rendered PNG frame sequence with the original audio into an
// H.264 MP4 via fluent-ffmpeg.
//
// Implemented in task 8.1. `exportVideo` is the stage entry point;
// `checkFfmpegAvailable` exposes the fail-fast pre-flight (Req 6.2) as a small,
// independently-usable helper.

export {
  exportVideo,
  checkFfmpegAvailable,
  type ExportProgress,
  type ExportProgressCallback,
} from './export-video.js';
