// @motionscore/renderer
//
// Stage E: interpolates the trajectory at the configured FPS and renders the
// ball, targets, trails, and impact effects to numbered PNG frames or directly
// streamed to ffmpeg (high-performance path).
//
// Two rendering paths:
// - `render()` — writes PNG frames to disk (original, compatible with any encoder)
// - `renderAndEncode()` — streams raw pixels directly to ffmpeg (3-5x faster,
//   skips PNG encode + disk I/O)

export { render, RenderError, exceedsFailureBudget } from './render.js';
export { interpolatePosition } from './interpolate.js';
export { renderAndEncode } from './stream-render.js';
