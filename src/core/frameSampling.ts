import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import type { FrameState, FrameType } from '../types';

const TWO_PI = Math.PI * 2;
const DEFAULT_CONTROL_POINT_COUNTS: Record<FrameType, number> = {
  circle: 12,
  rectangle: 12,
  square: 12,
  triangle: 12,
};

export function createDefaultFrameState(id: string, type: FrameType): FrameState {
  const frame: FrameState = {
    id,
    type,
    position: new Vector3(),
    rotation: new Euler(),
    scale: new Vector3(1, 1, 1),
    radius: 1,
    width: 2,
    height: 1.4,
    boundarySamples: 64,
    controlPoints: [],
  };

  frame.controlPoints = buildDefaultControlPoints(frame, DEFAULT_CONTROL_POINT_COUNTS[type]);
  return frame;
}

export function composeFrameMatrix(frame: Pick<FrameState, 'position' | 'rotation' | 'scale'>): Matrix4 {
  const matrix = new Matrix4();
  const quaternion = new Quaternion().setFromEuler(frame.rotation);
  matrix.compose(frame.position, quaternion, frame.scale);
  return matrix;
}

export function sampleFramePointLocal(
  frame: Pick<FrameState, 'type' | 'radius' | 'width' | 'height'> & { controlPoints?: Vector3[] },
  curveParamT: number,
  target: Vector3 = new Vector3(),
): Vector3 {
  if (frame.controlPoints && frame.controlPoints.length >= 4) {
    return sampleClosedCatmullRomPoint(frame.controlPoints, curveParamT, target);
  }

  return sampleBaseFramePointLocal(frame, curveParamT, target);
}

export function sampleFrameBoundaryLocal(frame: FrameState, samples = frame.boundarySamples): Vector3[] {
  const points: Vector3[] = [];
  for (let i = 0; i < samples; i += 1) {
    points.push(sampleFramePointLocal(frame, i / samples));
  }
  return points;
}

export function sampleFrameBoundaryWorld(frame: FrameState, samples = frame.boundarySamples): Vector3[] {
  const matrix = composeFrameMatrix(frame);
  return sampleFrameBoundaryLocal(frame, samples).map((point) => point.applyMatrix4(matrix));
}

export function sampleFramePointWorld(frame: FrameState, curveParamT: number): Vector3 {
  const matrix = composeFrameMatrix(frame);
  return sampleFramePointLocal(frame, curveParamT).applyMatrix4(matrix);
}

function buildDefaultControlPoints(
  frame: Pick<FrameState, 'type' | 'radius' | 'width' | 'height'>,
  controlPointCount: number,
): Vector3[] {
  const count = Math.max(4, controlPointCount);
  const points: Vector3[] = [];
  for (let i = 0; i < count; i += 1) {
    points.push(sampleBaseFramePointLocal(frame, i / count, new Vector3()));
  }
  return points;
}

function sampleBaseFramePointLocal(
  frame: Pick<FrameState, 'type' | 'radius' | 'width' | 'height'>,
  curveParamT: number,
  target: Vector3,
): Vector3 {
  const t = ((curveParamT % 1) + 1) % 1;
  if (frame.type === 'circle') {
    const angle = t * TWO_PI;
    return target.set(Math.cos(angle) * frame.radius, Math.sin(angle) * frame.radius, 0);
  }

  if (frame.type === 'square') {
    return sampleRoundedRectanglePoint(frame.width, frame.width, t, target);
  }

  if (frame.type === 'triangle') {
    return sampleTrianglePoint(frame.width, frame.height, t, target);
  }

  return sampleRoundedRectanglePoint(frame.width, frame.height, t, target);
}

function sampleTrianglePoint(width: number, height: number, t: number, target: Vector3): Vector3 {
  const halfWidth = width * 0.5;
  const halfHeight = height * 0.5;

  const ax = 0;
  const ay = halfHeight;
  const bx = -halfWidth;
  const by = -halfHeight;
  const cx = halfWidth;
  const cy = -halfHeight;

  const abLength = Math.hypot(bx - ax, by - ay);
  const bcLength = Math.hypot(cx - bx, cy - by);
  const caLength = Math.hypot(ax - cx, ay - cy);
  const perimeter = abLength + bcLength + caLength;

  let distance = t * perimeter;
  if (distance <= abLength) {
    const alpha = abLength <= 1e-8 ? 0 : distance / abLength;
    return target.set(ax + (bx - ax) * alpha, ay + (by - ay) * alpha, 0);
  }

  distance -= abLength;
  if (distance <= bcLength) {
    const alpha = bcLength <= 1e-8 ? 0 : distance / bcLength;
    return target.set(bx + (cx - bx) * alpha, by + (cy - by) * alpha, 0);
  }

  distance -= bcLength;
  const alpha = caLength <= 1e-8 ? 0 : distance / caLength;
  return target.set(cx + (ax - cx) * alpha, cy + (ay - cy) * alpha, 0);
}

function sampleClosedCatmullRomPoint(controlPoints: Vector3[], curveParamT: number, target: Vector3): Vector3 {
  const count = controlPoints.length;
  const t = ((curveParamT % 1) + 1) % 1;
  const scaled = t * count;
  const segment = Math.floor(scaled) % count;
  const localT = scaled - Math.floor(scaled);

  const p0 = controlPoints[(segment - 1 + count) % count];
  const p1 = controlPoints[segment];
  const p2 = controlPoints[(segment + 1) % count];
  const p3 = controlPoints[(segment + 2) % count];

  const tt = localT * localT;
  const ttt = tt * localT;

  const x =
    0.5 *
    (2 * p1.x +
      (-p0.x + p2.x) * localT +
      (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * tt +
      (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * ttt);
  const y =
    0.5 *
    (2 * p1.y +
      (-p0.y + p2.y) * localT +
      (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * tt +
      (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * ttt);
  const z =
    0.5 *
    (2 * p1.z +
      (-p0.z + p2.z) * localT +
      (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * tt +
      (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * ttt);

  return target.set(x, y, z);
}

function sampleRoundedRectanglePoint(width: number, height: number, t: number, target: Vector3): Vector3 {
  const halfWidth = width * 0.5;
  const halfHeight = height * 0.5;
  const cornerRadius = Math.min(Math.min(width, height) * 0.18, halfWidth, halfHeight);

  const edgeA = width - 2 * cornerRadius;
  const edgeB = height - 2 * cornerRadius;
  const perimeter = 2 * (edgeA + edgeB) + TWO_PI * cornerRadius;
  let distance = t * perimeter;

  const segments = [
    edgeA,
    Math.PI * 0.5 * cornerRadius,
    edgeB,
    Math.PI * 0.5 * cornerRadius,
    edgeA,
    Math.PI * 0.5 * cornerRadius,
    edgeB,
    Math.PI * 0.5 * cornerRadius,
  ];

  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segmentLength = segments[segmentIndex];
    if (distance <= segmentLength + 1e-8) {
      return pointOnRoundedRectSegment(segmentIndex, distance, halfWidth, halfHeight, cornerRadius, target);
    }
    distance -= segmentLength;
  }

  return target.set(halfWidth - cornerRadius, halfHeight, 0);
}

function pointOnRoundedRectSegment(
  segmentIndex: number,
  distance: number,
  halfWidth: number,
  halfHeight: number,
  cornerRadius: number,
  target: Vector3,
): Vector3 {
  const hw = halfWidth;
  const hh = halfHeight;
  const r = cornerRadius;

  if (segmentIndex === 0) {
    return target.set(-hw + r + distance, hh, 0);
  }

  if (segmentIndex === 1) {
    const angle = Math.PI * 0.5 - distance / r;
    return target.set(hw - r + Math.cos(angle) * r, hh - r + Math.sin(angle) * r, 0);
  }

  if (segmentIndex === 2) {
    return target.set(hw, hh - r - distance, 0);
  }

  if (segmentIndex === 3) {
    const angle = -distance / r;
    return target.set(hw - r + Math.cos(angle) * r, -hh + r + Math.sin(angle) * r, 0);
  }

  if (segmentIndex === 4) {
    return target.set(hw - r - distance, -hh, 0);
  }

  if (segmentIndex === 5) {
    const angle = -Math.PI * 0.5 - distance / r;
    return target.set(-hw + r + Math.cos(angle) * r, -hh + r + Math.sin(angle) * r, 0);
  }

  if (segmentIndex === 6) {
    return target.set(-hw, -hh + r + distance, 0);
  }

  const angle = Math.PI - distance / r;
  return target.set(-hw + r + Math.cos(angle) * r, hh - r + Math.sin(angle) * r, 0);
}
