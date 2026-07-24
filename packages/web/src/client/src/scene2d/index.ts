// Public API of the framework-agnostic 2D scene module.
export type {
  Ctx2D,
  Vec2,
  Actor,
  ActorKind,
  BallisticSegment,
  SlideSegment,
  RaceSegment,
  RaceContact,
  ContactStyle,
  Scene2DModel,
  CameraState,
  RenderFrame,
} from './types.js';
export {
  buildScene2D,
  sampleActor,
  sampleActorVelocity,
  sampleRaceSegment,
  sampleRaceVelocity,
  ACTOR_GROUPS,
  DEFAULT_ROLE_ACTORS,
  type GroupDefinition,
  SCROLL_X,
  DRIFT_Y,
  GRAVITY,
  BALL_R,
} from './model.js';
export { createCamera, renderScene2D } from './render.js';
export {
  type Scene2DSettings,
  type ActorGroupConfig,
  type ActorOverride,
  ACTOR_COLOR_PALETTE,
  DEFAULT_SCENE_SETTINGS,
  DEFAULT_ACTOR_OVERRIDE,
  getActorOverride,
  mergeSceneSettings,
} from './settings.js';
