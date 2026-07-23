// Framework-agnostic 2D scene types.
//
// The drawing code targets this minimal `Ctx2D` interface — the subset of the
// Canvas 2D API that both the browser's CanvasRenderingContext2D and the Node
// exporter's @napi-rs/canvas context implement. That lets the SAME rendering
// module drive the live browser preview and (later) the MP4 exporter, which is
// what guarantees the two stay pixel-aligned. Callers pass their real context
// via `as unknown as Ctx2D` at the boundary.

export interface Ctx2D {
  save(): void;
  restore(): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, start: number, end: number, ccw?: boolean): void;
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void;
  fill(): void;
  stroke(): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  lineCap: string;
  lineJoin: string;
  globalAlpha: number;
}

export interface Vec2 {
  x: number;
  y: number;
}

/** A short "kicker" line the ball taps on a beat (the drawn track feature). */
export interface Kicker {
  x: number;
  y: number;
  /** Segment orientation in radians (parallel to the world drift). */
  angle: number;
  half: number;
}

/** A continuous glide stroke drawn during a rise/fall section. */
export interface SlidePath {
  points: Vec2[];
}

/** One actor = one instrument role's ball, its contacts, and drawn track. */
export interface Actor {
  role: string;
  color: string;
  label: string;
  /** Baseline vertical offset that separates this role from the others. */
  laneY: number;
  /** Sorted contact (hit) times in seconds. */
  hitTimes: Float64Array;
  /** Sorted slide spans (rise/fall) during which the ball glides, not bounces. */
  slides: SlideSpan[];
  kickers: Kicker[];
  slidePaths: SlidePath[];
}

export interface SlideSpan {
  t0: number;
  t1: number;
  /** +1 for a downward (fall) glide, -1 for an upward (rise) glide. */
  dir: number;
  /** Peak vertical displacement magnitude of the glide, in world units. */
  amount: number;
}

export interface Scene2DModel {
  actors: Actor[];
  durationSec: number;
  /** Cached world-x of every kicker, sorted, for fast frustum culling. */
  bounds: { minY: number; maxY: number };
}

export interface CameraState {
  x: number;
  y: number;
  scale: number;
  inited: boolean;
}

export interface RenderFrame {
  timeSec: number;
  dt: number;
  width: number;
  height: number;
  camera: CameraState;
}
