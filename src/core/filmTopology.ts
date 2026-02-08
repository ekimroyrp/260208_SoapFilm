import { Vector3, type Object3D } from 'three';
import type { BoundaryConstraint, FrameState } from '../types';
import { sampleFrameBoundaryLocal } from './frameSampling';
import { buildMst } from './mst';

export interface FrameRuntime {
  id: string;
  state: FrameState;
  object: Object3D;
}

export interface FilmTopologyBuildResult {
  positions: Float32Array;
  indices: Uint32Array;
  boundaryConstraints: BoundaryConstraint[];
  sampleCount: number;
  mstEdgeCount: number;
}

interface LoopAlignment {
  reverse: boolean;
  shift: number;
}

export interface BuildTopologyOptions {
  spanSubdivisions?: number;
}

export function buildFilmTopology(
  frameRuntimes: FrameRuntime[],
  options: BuildTopologyOptions = {},
): FilmTopologyBuildResult {
  if (frameRuntimes.length < 2) {
    return {
      positions: new Float32Array(),
      indices: new Uint32Array(),
      boundaryConstraints: [],
      sampleCount: 0,
      mstEdgeCount: 0,
    };
  }

  const spanSubdivisions = Math.max(2, options.spanSubdivisions ?? 24);
  const sampleCount = Math.max(8, Math.min(...frameRuntimes.map((runtime) => runtime.state.boundarySamples)));

  const positionsData: number[] = [];
  const indicesData: number[] = [];
  const boundaryConstraints: BoundaryConstraint[] = [];

  const loopByFrame = new Map<string, Vector3[]>();
  const boundaryIndexByFrame = new Map<string, number[]>();
  const frameCenters = new Map<string, Vector3>();

  const pushVertex = (point: Vector3): number => {
    positionsData.push(point.x, point.y, point.z);
    return positionsData.length / 3 - 1;
  };

  for (const runtime of frameRuntimes) {
    runtime.object.updateMatrixWorld(true);
    const worldMatrix = runtime.object.matrixWorld;
    const localLoop = sampleFrameBoundaryLocal(runtime.state, sampleCount);
    const worldLoop = localLoop.map((point) => point.clone().applyMatrix4(worldMatrix));
    loopByFrame.set(runtime.id, worldLoop);

    const boundaryVertexIndices: number[] = [];
    for (let i = 0; i < sampleCount; i += 1) {
      const vertexIndex = pushVertex(worldLoop[i]);
      boundaryVertexIndices.push(vertexIndex);
      boundaryConstraints.push({
        vertexIndex,
        frameId: runtime.id,
        curveParamT: i / sampleCount,
      });
    }

    boundaryIndexByFrame.set(runtime.id, boundaryVertexIndices);
    frameCenters.set(runtime.id, new Vector3().setFromMatrixPosition(worldMatrix));
  }

  const frameIds = frameRuntimes.map((runtime) => runtime.id);
  const mstEdges = buildMst(frameIds, frameCenters);

  for (const edge of mstEdges) {
    const loopA = loopByFrame.get(edge.from);
    const loopB = loopByFrame.get(edge.to);
    const boundaryA = boundaryIndexByFrame.get(edge.from);
    const boundaryB = boundaryIndexByFrame.get(edge.to);

    if (!loopA || !loopB || !boundaryA || !boundaryB) {
      continue;
    }

    const alignment = findBestLoopAlignment(loopA, loopB);
    const grid: number[][] = Array.from({ length: sampleCount }, () => new Array(spanSubdivisions + 1).fill(-1));

    for (let i = 0; i < sampleCount; i += 1) {
      const mappedIndex = mapIndex(i, sampleCount, alignment);
      grid[i][0] = boundaryA[i];
      grid[i][spanSubdivisions] = boundaryB[mappedIndex];

      for (let step = 1; step < spanSubdivisions; step += 1) {
        const alpha = step / spanSubdivisions;
        const point = loopA[i].clone().lerp(loopB[mappedIndex], alpha);
        grid[i][step] = pushVertex(point);
      }
    }

    for (let i = 0; i < sampleCount; i += 1) {
      const next = (i + 1) % sampleCount;
      for (let step = 0; step < spanSubdivisions; step += 1) {
        const a = grid[i][step];
        const b = grid[next][step];
        const c = grid[next][step + 1];
        const d = grid[i][step + 1];

        indicesData.push(a, b, c);
        indicesData.push(a, c, d);
      }
    }
  }

  return {
    positions: new Float32Array(positionsData),
    indices: new Uint32Array(indicesData),
    boundaryConstraints,
    sampleCount,
    mstEdgeCount: mstEdges.length,
  };
}

function findBestLoopAlignment(loopA: Vector3[], loopB: Vector3[]): LoopAlignment {
  const count = loopA.length;
  const orientations = [false, true];
  let bestAlignment: LoopAlignment = { reverse: false, shift: 0 };
  let bestError = Number.POSITIVE_INFINITY;

  for (const reverse of orientations) {
    for (let shift = 0; shift < count; shift += 1) {
      let error = 0;
      for (let i = 0; i < count; i += 1) {
        const mapped = mapIndex(i, count, { reverse, shift });
        error += loopA[i].distanceToSquared(loopB[mapped]);
      }

      if (error < bestError) {
        bestError = error;
        bestAlignment = { reverse, shift };
      }
    }
  }

  return bestAlignment;
}

function mapIndex(index: number, count: number, alignment: LoopAlignment): number {
  if (!alignment.reverse) {
    return (index + alignment.shift) % count;
  }

  return ((alignment.shift - index) % count + count) % count;
}
