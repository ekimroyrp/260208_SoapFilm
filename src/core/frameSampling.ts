import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import type { FrameState } from '../types';

const TWO_PI = Math.PI * 2;

export function createDefaultFrameState(id: string, type: 'circle' | 'rectangle'): FrameState {
  return {
    id,
    type,
    position: new Vector3(),
    rotation: new Euler(),
    scale: new Vector3(1, 1, 1),
    radius: 1,
    width: 2,
    height: 1.4,
    boundarySamples: 64,
  };
}

export function composeFrameMatrix(frame: Pick<FrameState, 'position' | 'rotation' | 'scale'>): Matrix4 {
  const matrix = new Matrix4();
  const quaternion = new Quaternion().setFromEuler(frame.rotation);
  matrix.compose(frame.position, quaternion, frame.scale);
  return matrix;
}

export function sampleFramePointLocal(
  frame: Pick<FrameState, 'type' | 'radius' | 'width' | 'height'>,
  curveParamT: number,
  target: Vector3 = new Vector3(),
): Vector3 {
  const t = ((curveParamT % 1) + 1) % 1;
  if (frame.type === 'circle') {
    const angle = t * TWO_PI;
    return target.set(Math.cos(angle) * frame.radius, Math.sin(angle) * frame.radius, 0);
  }

  return sampleRoundedRectanglePoint(frame.width, frame.height, t, target);
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
