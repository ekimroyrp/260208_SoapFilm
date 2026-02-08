import { Object3D, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { buildFilmTopology, type FrameRuntime } from '../src/core/filmTopology';
import { createDefaultFrameState } from '../src/core/frameSampling';

function createRuntime(id: string, type: 'circle' | 'rectangle', position: Vector3): FrameRuntime {
  const state = createDefaultFrameState(id, type);
  if (type === 'circle') {
    state.radius = 1.1;
  } else {
    state.width = 2;
    state.height = 1.2;
  }

  const object = new Object3D();
  object.position.copy(position);
  object.rotation.set(0.2, 0.3, 0.1);
  object.updateMatrixWorld(true);

  state.position.copy(object.position);
  state.rotation.copy(object.rotation);
  state.scale.copy(object.scale);

  return { id, state, object };
}

describe('film topology', () => {
  it('builds valid indexed geometry for two frames', () => {
    const runtimes = [
      createRuntime('f1', 'circle', new Vector3(-1.5, 1, 0)),
      createRuntime('f2', 'rectangle', new Vector3(1.7, 1.2, 0.8)),
    ];

    const topology = buildFilmTopology(runtimes, { spanSubdivisions: 12 });
    const vertexCount = topology.positions.length / 3;

    expect(topology.indices.length).toBeGreaterThan(0);
    expect(topology.boundaryConstraints.length).toBeGreaterThan(0);

    for (const index of topology.indices) {
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(vertexCount);
    }
  });

  it('creates one connected network for three frames through mst strips', () => {
    const runtimes = [
      createRuntime('f1', 'circle', new Vector3(-2, 1, 0)),
      createRuntime('f2', 'rectangle', new Vector3(2, 1, 0)),
      createRuntime('f3', 'circle', new Vector3(0, 2, 2)),
    ];

    const topology = buildFilmTopology(runtimes, { spanSubdivisions: 8 });

    expect(topology.mstEdgeCount).toBe(2);
    expect(topology.indices.length).toBeGreaterThan(0);
    expect(topology.boundaryConstraints.length).toBe(3 * topology.sampleCount);
  });
});
