import { Object3D, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { buildFilmTopology, type FrameRuntime } from '../src/core/filmTopology';
import { createDefaultFrameState, sampleFramePointLocal } from '../src/core/frameSampling';
import {
  computeSurfaceArea,
  createFilmState,
  createSolverContext,
  resetFilmState,
  runRelaxationStep,
} from '../src/core/solver';
import type { BoundaryConstraint } from '../src/types';

function createRuntime(id: string, type: 'circle' | 'rectangle', position: Vector3): FrameRuntime {
  const state = createDefaultFrameState(id, type);
  if (type === 'rectangle') {
    state.width = 2.2;
    state.height = 1.3;
  } else {
    state.radius = 1.15;
  }

  const object = new Object3D();
  object.position.copy(position);
  object.rotation.set(0.1, -0.2, 0.04);
  object.updateMatrixWorld(true);

  state.position.copy(object.position);
  state.rotation.copy(object.rotation);
  state.scale.copy(object.scale);

  return { id, state, object };
}

function buildBoundarySampler(frameRuntimes: FrameRuntime[]) {
  const map = new Map(frameRuntimes.map((runtime) => [runtime.id, runtime]));

  return (constraint: BoundaryConstraint) => {
    const frame = map.get(constraint.frameId);
    if (!frame) {
      return null;
    }

    frame.object.updateMatrixWorld(true);
    return sampleFramePointLocal(frame.state, constraint.curveParamT).applyMatrix4(frame.object.matrixWorld);
  };
}

describe('film solver', () => {
  it('resetSimulation restores rest positions and clears velocity', () => {
    const runtimes = [
      createRuntime('a', 'circle', new Vector3(-1.8, 1, 0)),
      createRuntime('b', 'circle', new Vector3(1.8, 1, 0)),
    ];

    const topology = buildFilmTopology(runtimes, { spanSubdivisions: 10 });
    const filmState = createFilmState(topology);

    filmState.positions[0] += 0.4;
    filmState.positions[1] -= 0.2;
    filmState.velocities.fill(0.25);

    resetFilmState(filmState);

    expect(Array.from(filmState.positions)).toEqual(Array.from(filmState.restPositions));
    expect(Array.from(filmState.velocities).every((value) => value === 0)).toBe(true);
  });

  it('reduces total area over relaxation iterations in a fixed two-frame setup', () => {
    const runtimes = [
      createRuntime('left', 'circle', new Vector3(-2, 1.1, 0)),
      createRuntime('right', 'circle', new Vector3(2.1, 0.9, 0.3)),
    ];

    const topology = buildFilmTopology(runtimes, { spanSubdivisions: 18 });
    const filmState = createFilmState(topology, {
      substeps: 5,
      stepSize: 0.1,
      damping: 0.9,
      laplacianWeight: 0.2,
    });
    const solverContext = createSolverContext(filmState);
    const boundarySampler = buildBoundarySampler(runtimes);

    const initialArea = computeSurfaceArea(filmState.positions, filmState.indices);

    for (let i = 0; i < 40; i += 1) {
      runRelaxationStep(filmState, solverContext, boundarySampler);
    }

    const finalArea = computeSurfaceArea(filmState.positions, filmState.indices);
    expect(finalArea).toBeLessThan(initialArea * 0.995);
  });
});
