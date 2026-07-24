// Framework-agnostic 2D race types shared by live canvas and snapshot/export code.

import type { HitRole, PitchDirection } from '../renderTypes.js';

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
  ellipse(
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    start: number,
    end: number,
    ccw?: boolean,
  ): void;
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void;
  bezierCurveTo(
    cp1x: number,
    cp1y: number,
    cp2x: number,
    cp2y: number,
    x: number,
    y: number,
  ): void;
  fill(): void;
  stroke(): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  fillText(text: string, x: number, y: number): void;
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  lineCap: string;
  lineJoin: string;
  globalAlpha: number;
  font: string;
  textAlign: string;
  textBaseline: string;
}

export interface Vec2 {
  x: number;
  y: number;
}

export type ActorKind = 'rhythm' | 'bass' | 'lead';
export type ContactStyle = 'kicker' | 'step' | 'ramp' | 'catch';

/** One exact physical contact can represent multiple exactly co-timed notes. */
export interface RaceContact {
  id: string;
  timeSec: number;
  noteIds: string[];
  sourceRoles: HitRole[];
  strength: number;
  pitchMidi: number;
  rapid: boolean;
  intentionalConvergence: boolean;
  position: Vec2;
  surfacePoint: Vec2;
  tangent: Vec2;
  /** Direction from ball centre toward the supporting/collision surface. */
  normal: Vec2;
  lineLength: number;
  supportLength: number;
  incomingSpeed: number;
  style: ContactStyle;
}

interface SegmentBase {
  t0: number;
  t1: number;
  p0: Vec2;
  p1: Vec2;
}

/** Unsupported constant-gravity motion between two music-fixed anchors. */
export interface BallisticSegment extends SegmentBase {
  kind: 'ballistic';
  gravity: number;
  velocity0: Vec2;
}

/** Supported cubic path while a separated role remains continuously active. */
export interface SlideSegment extends SegmentBase {
  kind: 'slide';
  c1: Vec2;
  c2: Vec2;
  activity: number;
  pitchDirection: PitchDirection;
}

export type RaceSegment = BallisticSegment | SlideSegment;

/** One semantic neural actor: drums/rhythm, bass, or foreground lead. */
export interface Actor {
  id: string;
  kind: ActorKind;
  color: string;
  label: string;
  sourceRoles: HitRole[];
  xBias: number;
  contacts: RaceContact[];
  segments: RaceSegment[];
  /** Sorted physical contact times for impact squash lookup. */
  hitTimes: Float64Array;
  /** Time range where this actor has real content; it is idle/hidden outside. */
  activeStartSec: number;
  activeEndSec: number;
}

export interface Scene2DModel {
  actors: Actor[];
  durationSec: number;
  ballRadius: number;
  gravity: number;
  bounds: { minY: number; maxY: number };
  /** Regression invariant: all source hits are represented by contact noteIds. */
  sourceHitCount: number;
  representedHitCount: number;
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
