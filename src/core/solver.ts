import type { Vector3 } from 'three';
import type { BoundaryConstraint, FilmState, SolverConfig } from '../types';
import type { FilmTopologyBuildResult } from './filmTopology';

export interface SolverContext {
  boundaryMask: Uint8Array;
  neighbors: number[][];
  gradient: Float32Array;
  scratchPositions: Float32Array;
  scratchVelocities: Float32Array;
}

export type BoundarySampler = (constraint: BoundaryConstraint) => Vector3 | null;

const DEFAULT_SOLVER_CONFIG: SolverConfig = {
  substeps: 4,
  stepSize: 0.14,
  damping: 0.92,
  laplacianWeight: 0.2,
  relaxationStrength: 1,
  shapeRetention: 0,
};

const EPSILON = 1e-8;

export function createFilmState(
  topology: FilmTopologyBuildResult,
  solverConfig: Partial<SolverConfig> = {},
): FilmState {
  return {
    positions: topology.positions.slice(),
    velocities: new Float32Array(topology.positions.length),
    indices: topology.indices,
    boundaryConstraints: topology.boundaryConstraints,
    restPositions: topology.positions.slice(),
    solverConfig: {
      ...DEFAULT_SOLVER_CONFIG,
      ...solverConfig,
    },
  };
}

export function createSolverContext(filmState: FilmState): SolverContext {
  const vertexCount = filmState.positions.length / 3;
  const neighbors = Array.from({ length: vertexCount }, () => new Set<number>());

  for (let i = 0; i < filmState.indices.length; i += 3) {
    const a = filmState.indices[i];
    const b = filmState.indices[i + 1];
    const c = filmState.indices[i + 2];

    neighbors[a].add(b);
    neighbors[a].add(c);
    neighbors[b].add(a);
    neighbors[b].add(c);
    neighbors[c].add(a);
    neighbors[c].add(b);
  }

  const boundaryMask = new Uint8Array(vertexCount);
  for (const constraint of filmState.boundaryConstraints) {
    boundaryMask[constraint.vertexIndex] = 1;
  }

  return {
    boundaryMask,
    neighbors: neighbors.map((entry) => Array.from(entry)),
    gradient: new Float32Array(filmState.positions.length),
    scratchPositions: new Float32Array(filmState.positions.length),
    scratchVelocities: new Float32Array(filmState.velocities.length),
  };
}

export function runRelaxationStep(
  filmState: FilmState,
  solverContext: SolverContext,
  boundarySampler: BoundarySampler,
  options: { computeSurfaceArea?: boolean } = {},
): number {
  if (filmState.indices.length === 0) {
    return 0;
  }

  const { substeps, stepSize, damping, laplacianWeight, relaxationStrength, shapeRetention } = filmState.solverConfig;
  const forceScale = Math.max(0, relaxationStrength);
  const retentionScale = Math.max(0, shapeRetention);
  for (let substep = 0; substep < substeps; substep += 1) {
    projectBoundaries(filmState, boundarySampler);
    solverContext.gradient.fill(0);
    accumulateAreaGradient(filmState, solverContext.gradient);

    solverContext.scratchPositions.set(filmState.positions);
    solverContext.scratchVelocities.set(filmState.velocities);

    const vertexCount = filmState.positions.length / 3;
    for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
      if (solverContext.boundaryMask[vertexIndex] === 1) {
        continue;
      }

      const offset = vertexIndex * 3;
      const px = filmState.positions[offset];
      const py = filmState.positions[offset + 1];
      const pz = filmState.positions[offset + 2];
      const rx = filmState.restPositions[offset];
      const ry = filmState.restPositions[offset + 1];
      const rz = filmState.restPositions[offset + 2];

      const gx = solverContext.gradient[offset];
      const gy = solverContext.gradient[offset + 1];
      const gz = solverContext.gradient[offset + 2];

      let lapX = 0;
      let lapY = 0;
      let lapZ = 0;
      const neighbors = solverContext.neighbors[vertexIndex];
      if (neighbors.length > 0) {
        for (const neighborIndex of neighbors) {
          const neighborOffset = neighborIndex * 3;
          lapX += filmState.positions[neighborOffset];
          lapY += filmState.positions[neighborOffset + 1];
          lapZ += filmState.positions[neighborOffset + 2];
        }

        const invNeighbors = 1 / neighbors.length;
        lapX = lapX * invNeighbors - px;
        lapY = lapY * invNeighbors - py;
        lapZ = lapZ * invNeighbors - pz;
      }

      const accelX = (-gx + laplacianWeight * lapX) * forceScale + (rx - px) * retentionScale;
      const accelY = (-gy + laplacianWeight * lapY) * forceScale + (ry - py) * retentionScale;
      const accelZ = (-gz + laplacianWeight * lapZ) * forceScale + (rz - pz) * retentionScale;

      const nextVelocityX = filmState.velocities[offset] * damping + accelX * stepSize;
      const nextVelocityY = filmState.velocities[offset + 1] * damping + accelY * stepSize;
      const nextVelocityZ = filmState.velocities[offset + 2] * damping + accelZ * stepSize;

      solverContext.scratchVelocities[offset] = nextVelocityX;
      solverContext.scratchVelocities[offset + 1] = nextVelocityY;
      solverContext.scratchVelocities[offset + 2] = nextVelocityZ;

      solverContext.scratchPositions[offset] = px + nextVelocityX * stepSize;
      solverContext.scratchPositions[offset + 1] = py + nextVelocityY * stepSize;
      solverContext.scratchPositions[offset + 2] = pz + nextVelocityZ * stepSize;
    }

    filmState.positions.set(solverContext.scratchPositions);
    filmState.velocities.set(solverContext.scratchVelocities);
    projectBoundaries(filmState, boundarySampler);
  }

  if (options.computeSurfaceArea === false) {
    return Number.NaN;
  }

  return computeSurfaceArea(filmState.positions, filmState.indices);
}

export function resetFilmState(filmState: FilmState): void {
  filmState.positions.set(filmState.restPositions);
  filmState.velocities.fill(0);
}

export function computeSurfaceArea(positions: Float32Array, indices: Uint32Array): number {
  let area = 0;

  for (let i = 0; i < indices.length; i += 3) {
    const aOffset = indices[i] * 3;
    const bOffset = indices[i + 1] * 3;
    const cOffset = indices[i + 2] * 3;

    const ax = positions[aOffset];
    const ay = positions[aOffset + 1];
    const az = positions[aOffset + 2];
    const bx = positions[bOffset];
    const by = positions[bOffset + 1];
    const bz = positions[bOffset + 2];
    const cx = positions[cOffset];
    const cy = positions[cOffset + 1];
    const cz = positions[cOffset + 2];

    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;
    const acx = cx - ax;
    const acy = cy - ay;
    const acz = cz - az;

    const crossX = aby * acz - abz * acy;
    const crossY = abz * acx - abx * acz;
    const crossZ = abx * acy - aby * acx;

    area += 0.5 * Math.sqrt(crossX * crossX + crossY * crossY + crossZ * crossZ);
  }

  return area;
}

function projectBoundaries(filmState: FilmState, boundarySampler: BoundarySampler): void {
  for (const constraint of filmState.boundaryConstraints) {
    const point = boundarySampler(constraint);
    if (!point) {
      continue;
    }

    const offset = constraint.vertexIndex * 3;
    filmState.positions[offset] = point.x;
    filmState.positions[offset + 1] = point.y;
    filmState.positions[offset + 2] = point.z;

    filmState.velocities[offset] = 0;
    filmState.velocities[offset + 1] = 0;
    filmState.velocities[offset + 2] = 0;
  }
}

function accumulateAreaGradient(filmState: FilmState, gradient: Float32Array): void {
  const positions = filmState.positions;

  for (let i = 0; i < filmState.indices.length; i += 3) {
    const a = filmState.indices[i];
    const b = filmState.indices[i + 1];
    const c = filmState.indices[i + 2];

    const aOffset = a * 3;
    const bOffset = b * 3;
    const cOffset = c * 3;

    const ax = positions[aOffset];
    const ay = positions[aOffset + 1];
    const az = positions[aOffset + 2];
    const bx = positions[bOffset];
    const by = positions[bOffset + 1];
    const bz = positions[bOffset + 2];
    const cx = positions[cOffset];
    const cy = positions[cOffset + 1];
    const cz = positions[cOffset + 2];

    const e1x = bx - ax;
    const e1y = by - ay;
    const e1z = bz - az;
    const e2x = cx - ax;
    const e2y = cy - ay;
    const e2z = cz - az;

    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;

    const normalLength = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (normalLength < EPSILON) {
      continue;
    }

    const invNormalLength = 1 / normalLength;
    const unx = nx * invNormalLength;
    const uny = ny * invNormalLength;
    const unz = nz * invNormalLength;

    const bmcx = bx - cx;
    const bmcy = by - cy;
    const bmcz = bz - cz;
    const gradAx = 0.5 * (bmcy * unz - bmcz * uny);
    const gradAy = 0.5 * (bmcz * unx - bmcx * unz);
    const gradAz = 0.5 * (bmcx * uny - bmcy * unx);

    const cmax = cx - ax;
    const cmay = cy - ay;
    const cmaz = cz - az;
    const gradBx = 0.5 * (cmay * unz - cmaz * uny);
    const gradBy = 0.5 * (cmaz * unx - cmax * unz);
    const gradBz = 0.5 * (cmax * uny - cmay * unx);

    const ambx = ax - bx;
    const amby = ay - by;
    const ambz = az - bz;
    const gradCx = 0.5 * (amby * unz - ambz * uny);
    const gradCy = 0.5 * (ambz * unx - ambx * unz);
    const gradCz = 0.5 * (ambx * uny - amby * unx);

    gradient[aOffset] += gradAx;
    gradient[aOffset + 1] += gradAy;
    gradient[aOffset + 2] += gradAz;

    gradient[bOffset] += gradBx;
    gradient[bOffset + 1] += gradBy;
    gradient[bOffset + 2] += gradBz;

    gradient[cOffset] += gradCx;
    gradient[cOffset + 1] += gradCy;
    gradient[cOffset + 2] += gradCz;
  }
}
