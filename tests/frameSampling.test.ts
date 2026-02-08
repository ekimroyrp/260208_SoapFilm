import { Euler, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  composeFrameMatrix,
  createDefaultFrameState,
  sampleFrameBoundaryLocal,
  sampleFramePointLocal,
  sampleFramePointWorld,
} from '../src/core/frameSampling';

describe('frame sampling', () => {
  it('samples closed circle and rectangle loops with requested counts', () => {
    const circle = createDefaultFrameState('circle-1', 'circle');
    circle.radius = 2;

    const rectangle = createDefaultFrameState('rect-1', 'rectangle');
    rectangle.width = 3;
    rectangle.height = 1.6;

    const circleLoop = sampleFrameBoundaryLocal(circle, 64);
    const rectangleLoop = sampleFrameBoundaryLocal(rectangle, 64);

    expect(circleLoop).toHaveLength(64);
    expect(rectangleLoop).toHaveLength(64);

    const circleStart = sampleFramePointLocal(circle, 0);
    const circleEnd = sampleFramePointLocal(circle, 1);
    const rectStart = sampleFramePointLocal(rectangle, 0);
    const rectEnd = sampleFramePointLocal(rectangle, 1);

    expect(circleStart.distanceTo(circleEnd)).toBeLessThan(1e-6);
    expect(rectStart.distanceTo(rectEnd)).toBeLessThan(1e-6);
  });

  it('applies world transform correctly', () => {
    const frame = createDefaultFrameState('circle-2', 'circle');
    frame.radius = 1.25;
    frame.position.copy(new Vector3(2, -1, 4));
    frame.rotation.copy(new Euler(0.2, 0.7, -0.15));
    frame.scale.copy(new Vector3(1.5, 0.8, 2));

    const worldPoint = sampleFramePointWorld(frame, 0.375);
    const localPoint = sampleFramePointLocal(frame, 0.375);
    const matrix = composeFrameMatrix(frame);
    const transformedLocal = localPoint.clone().applyMatrix4(matrix);

    expect(worldPoint.distanceTo(transformedLocal)).toBeLessThan(1e-7);
  });
});
