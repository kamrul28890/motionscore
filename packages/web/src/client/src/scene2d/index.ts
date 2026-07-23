// Public API of the framework-agnostic 2D scene module.
export type {
  Ctx2D,
  Vec2,
  Actor,
  Scene2DModel,
  CameraState,
  RenderFrame,
  SlideSpan,
} from './types.js';
export { buildScene2D, sampleActor, SCROLL_X, DRIFT_Y, BALL_R } from './model.js';
export { createCamera, renderScene2D } from './render.js';
export {
  type Scene2DSettings,
  DEFAULT_SCENE_SETTINGS,
  mergeSceneSettings,
} from './settings.js';
