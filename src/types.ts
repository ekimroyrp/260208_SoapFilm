import type { Euler, Vector3 } from 'three';

export type FrameType = 'circle' | 'rectangle';

export interface FrameState {
  id: string;
  type: FrameType;
  position: Vector3;
  rotation: Euler;
  scale: Vector3;
  radius: number;
  width: number;
  height: number;
  boundarySamples: number;
}

export interface BoundaryConstraint {
  vertexIndex: number;
  frameId: string;
  curveParamT: number;
}

export interface SolverConfig {
  substeps: number;
  stepSize: number;
  damping: number;
  laplacianWeight: number;
  relaxationStrength: number;
  shapeRetention: number;
}

export interface FilmState {
  positions: Float32Array;
  velocities: Float32Array;
  indices: Uint32Array;
  boundaryConstraints: BoundaryConstraint[];
  restPositions: Float32Array;
  solverConfig: SolverConfig;
}

export interface SoapFilmApp {
  addFrame(type: FrameType): string;
  removeFrame(frameId: string): void;
  selectFrame(frameId: string | null): void;
  resetSimulation(): void;
  rebuildFilm(): void;
  dispose(): void;
}
