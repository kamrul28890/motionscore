// @motionscore/video-export
//
// Stage F: muxes the rendered PNG frame sequence with the original audio into an
// H.264 MP4 via fluent-ffmpeg. Supports CPU (libx264) and GPU-accelerated
// encoders (h264_nvenc, h264_amf, h264_qsv).

export {
  exportVideo,
  checkFfmpegAvailable,
  detectAvailableEncoders,
  type ExportProgress,
  type ExportProgressCallback,
} from './export-video.js';
