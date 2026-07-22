// @motionscore/renderer
//
// Stage E: interpolates the trajectory at the configured FPS and renders the
// ball, targets, trails, and impact effects to numbered PNG frames.
//
// Implemented in task 7.1. `render` is the stage entry point; `RenderError` is
// thrown when too many frames fail (Req 5.6). `interpolatePosition` and
// `exceedsFailureBudget` are exported as small, independently-testable helpers.
//
// Rendering is backed by `@napi-rs/canvas` (Skia, prebuilt N-API binaries)
// rather than `@pixi/node`, whose native `gl`/`canvas` peer dependencies do not
// install in this environment. The backend is fully encapsulated by `render()`.

export { render, RenderError, exceedsFailureBudget } from './render.js';
export { interpolatePosition } from './interpolate.js';
