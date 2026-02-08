import GUI from 'lil-gui';
import {
  ACESFilmicToneMapping,
  AmbientLight,
  AxesHelper,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  DynamicDrawUsage,
  GridHelper,
  LineBasicMaterial,
  LineLoop,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MOUSE,
  Object3D,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PMREMGenerator,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { BoundaryConstraint, FilmState, FrameType, SoapFilmApp, SolverConfig } from '../types';
import { createDefaultFrameState, sampleFrameBoundaryLocal, sampleFramePointLocal } from '../core/frameSampling';
import { buildFilmTopology, type FrameRuntime } from '../core/filmTopology';
import {
  createFilmState,
  createSolverContext,
  resetFilmState,
  runRelaxationStep,
  type SolverContext,
} from '../core/solver';

interface FrameEntity extends FrameRuntime {
  line: LineLoop;
  material: LineBasicMaterial;
}

interface FilmRuntime {
  state: FilmState;
  solverContext: SolverContext;
  geometry: BufferGeometry;
  mesh: Mesh;
  wireframeMesh: Mesh;
  material: MeshPhysicalMaterial;
  wireframeMaterial: MeshBasicMaterial;
}

interface UiState {
  transformMode: 'translate' | 'rotate' | 'scale';
  solverQuality: 'fast' | 'balanced' | 'high';
  relaxationStrength: number;
  shapeRetention: number;
  showWireframe: boolean;
}

interface SolverQualityConfig extends SolverConfig {
  normalsUpdateInterval: number;
}

const FRAME_DEFAULT_POSITIONS: ReadonlyArray<readonly [number, number, number]> = [
  [-2.2, 1.2, 0],
  [2.2, 1.2, 0],
  [0, 2.2, 2],
  [0, 0.8, -2],
  [-2, 1.8, -2],
  [2, 0.8, 2],
];

const SOLVER_QUALITY_CONFIGS: Record<UiState['solverQuality'], SolverQualityConfig> = {
  fast: {
    substeps: 2,
    stepSize: 0.16,
    damping: 0.91,
    laplacianWeight: 0.2,
    relaxationStrength: 1,
    shapeRetention: 0,
    normalsUpdateInterval: 4,
  },
  balanced: {
    substeps: 4,
    stepSize: 0.14,
    damping: 0.92,
    laplacianWeight: 0.2,
    relaxationStrength: 1,
    shapeRetention: 0,
    normalsUpdateInterval: 2,
  },
  high: {
    substeps: 6,
    stepSize: 0.13,
    damping: 0.93,
    laplacianWeight: 0.22,
    relaxationStrength: 1,
    shapeRetention: 0,
    normalsUpdateInterval: 1,
  },
};

class SoapFilmAppImpl implements SoapFilmApp {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;
  private readonly scene: Scene;
  private readonly camera: PerspectiveCamera;
  private readonly orbitControls: OrbitControls;
  private readonly transformControls: TransformControls;
  private readonly transformControlsHelper: Object3D;
  private readonly gui: GUI;
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private readonly boundarySampleScratch = new Vector3();

  private readonly frameEntities = new Map<string, FrameEntity>();
  private readonly frameSelectable = new Set<Object3D>();
  private selectedFrameId: string | null = null;
  private frameIdCounter = 0;

  private filmRuntime: FilmRuntime | null = null;
  private environmentRenderTarget: WebGLRenderTarget | null = null;

  private readonly uiState: UiState = {
    transformMode: 'translate',
    solverQuality: 'balanced',
    relaxationStrength: 1,
    shapeRetention: 0,
    showWireframe: false,
  };
  private isTransformDragging = false;
  private isUsingTransformControls = false;
  private geometryUpdateCounter = 0;

  private animationFrameHandle = 0;
  private readonly onResizeBound: () => void;
  private readonly onPointerDownBound: (event: PointerEvent) => void;
  private readonly onKeyDownBound: (event: KeyboardEvent) => void;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.scene = new Scene();
    this.scene.background = new Color(0x101722);

    this.renderer = new WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;

    this.camera = new PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 300);
    this.camera.position.set(8, 5.5, 8);

    this.orbitControls = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbitControls.enableDamping = true;
    this.orbitControls.dampingFactor = 0.08;
    this.orbitControls.mouseButtons.LEFT = undefined;
    this.orbitControls.mouseButtons.MIDDLE = MOUSE.PAN;
    this.orbitControls.mouseButtons.RIGHT = MOUSE.ROTATE;

    this.transformControls = new TransformControls(this.camera, this.renderer.domElement);
    this.transformControls.setMode(this.uiState.transformMode);
    this.transformControls.setSize(1.25);
    this.transformControls.addEventListener('dragging-changed', (event) => {
      const isDragging = Boolean((event as { value?: unknown }).value);
      this.isTransformDragging = isDragging;
      this.orbitControls.enabled = !isDragging;
    });
    this.transformControls.addEventListener('mouseDown', () => {
      this.isUsingTransformControls = true;
    });
    this.transformControls.addEventListener('mouseUp', () => {
      window.setTimeout(() => {
        this.isUsingTransformControls = false;
      }, 0);
    });
    this.transformControlsHelper = this.transformControls.getHelper();
    this.scene.add(this.transformControlsHelper);

    this.raycaster.params.Line = { threshold: 0.2 };

    this.setupSceneHelpers();
    this.setupEnvironment();

    this.gui = new GUI({ title: 'Soap Film Controls', width: 320 });
    this.setupGui();

    this.onResizeBound = () => this.handleResize();
    this.onPointerDownBound = (event) => this.handlePointerDown(event);
    this.onKeyDownBound = (event) => this.handleKeyDown(event);

    window.addEventListener('resize', this.onResizeBound);
    this.canvas.addEventListener('pointerdown', this.onPointerDownBound);
    window.addEventListener('keydown', this.onKeyDownBound);

    this.animationLoop();
  }

  addFrame(type: FrameType): string {
    const id = `frame-${++this.frameIdCounter}`;
    const state = createDefaultFrameState(id, type);

    if (type === 'circle') {
      state.radius = 1;
    } else {
      state.width = 2;
      state.height = 1.4;
    }

    const placement = FRAME_DEFAULT_POSITIONS[this.frameEntities.size % FRAME_DEFAULT_POSITIONS.length];
    state.position.set(placement[0], placement[1], placement[2]);
    state.rotation.set(0, (this.frameEntities.size * Math.PI) / 8, 0);

    const object = new Object3D();
    object.position.copy(state.position);
    object.rotation.copy(state.rotation);
    object.scale.copy(state.scale);

    const lineGeometry = new BufferGeometry().setFromPoints(sampleFrameBoundaryLocal(state, state.boundarySamples));
    const lineMaterial = new LineBasicMaterial({ color: 0xd22e2e });
    const line = new LineLoop(lineGeometry, lineMaterial);
    line.userData.frameId = id;
    line.renderOrder = 5;

    object.add(line);
    this.scene.add(object);

    const frameEntity: FrameEntity = {
      id,
      state,
      object,
      line,
      material: lineMaterial,
    };

    this.frameEntities.set(id, frameEntity);
    this.frameSelectable.add(line);

    this.selectFrame(id);
    this.rebuildFilm();

    return id;
  }

  removeFrame(frameId: string): void {
    const frameEntity = this.frameEntities.get(frameId);
    if (!frameEntity) {
      return;
    }

    if (this.selectedFrameId === frameId) {
      this.selectFrame(null);
    }

    this.frameSelectable.delete(frameEntity.line);
    frameEntity.line.geometry.dispose();
    frameEntity.material.dispose();

    frameEntity.object.remove(frameEntity.line);
    this.scene.remove(frameEntity.object);

    this.frameEntities.delete(frameId);
    this.rebuildFilm();
  }

  selectFrame(frameId: string | null): void {
    if (this.selectedFrameId === frameId) {
      return;
    }

    this.selectedFrameId = frameId;

    for (const [id, frameEntity] of this.frameEntities) {
      frameEntity.material.color.setHex(id === frameId ? 0xffc85c : 0xd22e2e);
    }

    this.transformControls.detach();
    if (!frameId) {
      return;
    }

    const frameEntity = this.frameEntities.get(frameId);
    if (frameEntity) {
      this.transformControls.attach(frameEntity.object);
    }
  }

  resetSimulation(): void {
    if (!this.filmRuntime) {
      return;
    }

    resetFilmState(this.filmRuntime.state);
    this.geometryUpdateCounter = 0;
    this.refreshFilmGeometry(true);
  }

  rebuildFilm(): void {
    this.syncFrameStatesFromObjects();
    this.updateFrameWorldMatrices();

    this.disposeFilmRuntime();

    const frameRuntimes = Array.from(this.frameEntities.values());
    const topology = buildFilmTopology(frameRuntimes, { spanSubdivisions: 24 });
    if (topology.indices.length === 0) {
      return;
    }

    const solverConfig = this.getActiveSolverConfig();
    const filmState = createFilmState(topology, solverConfig);
    const solverContext = createSolverContext(filmState);

    const geometry = new BufferGeometry();
    const positionAttribute = new BufferAttribute(filmState.positions, 3);
    positionAttribute.setUsage(DynamicDrawUsage);
    geometry.setAttribute('position', positionAttribute);
    geometry.setIndex(new BufferAttribute(filmState.indices, 1));
    geometry.computeVertexNormals();

    const material = new MeshPhysicalMaterial({
      color: 0xbdd7ff,
      transparent: true,
      opacity: 0.45,
      transmission: 1,
      thickness: 0.02,
      ior: 1.33,
      roughness: 0.08,
      metalness: 0,
      iridescence: 1,
      iridescenceIOR: 1.3,
      iridescenceThicknessRange: [100, 400],
      side: DoubleSide,
      clearcoat: 0.4,
      clearcoatRoughness: 0.12,
    });

    const mesh = new Mesh(geometry, material);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.renderOrder = 1;

    const wireframeMaterial = new MeshBasicMaterial({
      color: 0x205cff,
      wireframe: true,
      transparent: true,
      opacity: 0.7,
      depthTest: false,
    });

    const wireframeMesh = new Mesh(geometry, wireframeMaterial);
    wireframeMesh.visible = this.uiState.showWireframe;
    wireframeMesh.renderOrder = 2;

    this.scene.add(mesh);
    this.scene.add(wireframeMesh);

    this.filmRuntime = {
      state: filmState,
      solverContext,
      geometry,
      mesh,
      wireframeMesh,
      material,
      wireframeMaterial,
    };

    runRelaxationStep(
      this.filmRuntime.state,
      this.filmRuntime.solverContext,
      (constraint) => this.sampleConstraintPoint(constraint),
      { computeSurfaceArea: false },
    );
    this.geometryUpdateCounter = 0;

    this.refreshFilmGeometry(true);
  }

  dispose(): void {
    cancelAnimationFrame(this.animationFrameHandle);

    window.removeEventListener('resize', this.onResizeBound);
    this.canvas.removeEventListener('pointerdown', this.onPointerDownBound);
    window.removeEventListener('keydown', this.onKeyDownBound);

    this.gui.destroy();
    this.scene.remove(this.transformControlsHelper);
    this.transformControls.dispose();
    this.orbitControls.dispose();

    for (const frameEntity of this.frameEntities.values()) {
      frameEntity.line.geometry.dispose();
      frameEntity.material.dispose();
      frameEntity.object.remove(frameEntity.line);
      this.scene.remove(frameEntity.object);
    }
    this.frameEntities.clear();
    this.frameSelectable.clear();

    this.disposeFilmRuntime();

    if (this.environmentRenderTarget) {
      this.environmentRenderTarget.dispose();
      this.environmentRenderTarget = null;
    }

    this.renderer.dispose();
  }

  private setupSceneHelpers(): void {
    const ambient = new AmbientLight(0xffffff, 0.55);
    this.scene.add(ambient);

    const directional = new DirectionalLight(0xffffff, 1.15);
    directional.position.set(8, 10, 4);
    this.scene.add(directional);

    const grid = new GridHelper(26, 52, 0x3f4f63, 0x253243);
    this.scene.add(grid);

    const axes = new AxesHelper(1.4);
    this.scene.add(axes);
  }

  private setupEnvironment(): void {
    const pmremGenerator = new PMREMGenerator(this.renderer);
    const roomEnvironment = new RoomEnvironment();
    this.environmentRenderTarget = pmremGenerator.fromScene(roomEnvironment);
    this.scene.environment = this.environmentRenderTarget.texture;

    roomEnvironment.dispose();
    pmremGenerator.dispose();
  }

  private setupGui(): void {
    const actions = {
      addCircle: () => this.addFrame('circle'),
      addRectangle: () => this.addFrame('rectangle'),
      resetSimulation: () => this.resetSimulation(),
      rebuildFilm: () => this.rebuildFilm(),
    };

    this.gui.add(actions, 'addCircle').name('Add Circle Frame');
    this.gui.add(actions, 'addRectangle').name('Add Rectangle Frame');
    this.gui.add(actions, 'resetSimulation').name('Reset Simulation');
    this.gui.add(actions, 'rebuildFilm').name('Rebuild Film');

    this.gui
      .add(this.uiState, 'transformMode', ['translate', 'rotate', 'scale'])
      .name('Transform Mode')
      .onChange((mode: UiState['transformMode']) => {
        this.setTransformMode(mode);
      });

    this.gui
      .add(this.uiState, 'solverQuality', ['fast', 'balanced', 'high'])
      .name('Solver Quality')
      .onChange(() => {
        if (this.filmRuntime) {
          this.applySolverQualityConfig();
        }
      });

    this.gui
      .add(this.uiState, 'relaxationStrength', 0.05, 2, 0.01)
      .name('Relaxation Strength')
      .onChange(() => {
        if (this.filmRuntime) {
          this.applySolverQualityConfig();
        }
      });

    this.gui
      .add(this.uiState, 'shapeRetention', 0, 0.5, 0.01)
      .name('Shape Retention')
      .onChange(() => {
        if (this.filmRuntime) {
          this.applySolverQualityConfig();
        }
      });

    this.gui
      .add(this.uiState, 'showWireframe')
      .name('Show Wireframe')
      .onChange((value: boolean) => {
        if (this.filmRuntime) {
          this.filmRuntime.wireframeMesh.visible = value;
        }
      });

  }

  private handleResize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  private handlePointerDown(event: PointerEvent): void {
    if (event.button !== 0) {
      return;
    }
    if (this.isUsingTransformControls || this.isTransformDragging) {
      return;
    }

    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.pointer, this.camera);
    const intersections = this.raycaster.intersectObjects(Array.from(this.frameSelectable));
    if (intersections.length === 0) {
      this.selectFrame(null);
      return;
    }

    const selectedObject = intersections[0].object;
    const frameId = selectedObject.userData.frameId as string | undefined;
    this.selectFrame(frameId ?? null);
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (event.key === 'w' || event.key === 'W') {
      this.setTransformMode('translate');
    }

    if (event.key === 'e' || event.key === 'E') {
      this.setTransformMode('rotate');
    }

    if (event.key === 'r' || event.key === 'R') {
      this.setTransformMode('scale');
    }

    if (event.key === 'Escape') {
      this.selectFrame(null);
    }

    if (event.key === 'Delete' && this.selectedFrameId) {
      this.removeFrame(this.selectedFrameId);
    }
  }

  private animationLoop = (): void => {
    this.animationFrameHandle = requestAnimationFrame(this.animationLoop);

    this.orbitControls.update();
    this.updateFrameWorldMatrices();

    if (this.filmRuntime) {
      this.applySolverQualityConfig();
      const quality = SOLVER_QUALITY_CONFIGS[this.uiState.solverQuality];

      runRelaxationStep(
        this.filmRuntime.state,
        this.filmRuntime.solverContext,
        (constraint) => this.sampleConstraintPoint(constraint),
        { computeSurfaceArea: false },
      );

      this.geometryUpdateCounter += 1;

      const normalsInterval = this.isTransformDragging
        ? Math.max(quality.normalsUpdateInterval, 4)
        : quality.normalsUpdateInterval;
      const shouldRefreshNormals = this.geometryUpdateCounter % normalsInterval === 0;
      this.refreshFilmGeometry(shouldRefreshNormals);
    }

    this.renderer.render(this.scene, this.camera);
  };

  private refreshFilmGeometry(recomputeNormals: boolean): void {
    if (!this.filmRuntime) {
      return;
    }

    const positionAttribute = this.filmRuntime.geometry.getAttribute('position') as BufferAttribute;
    positionAttribute.needsUpdate = true;
    if (recomputeNormals) {
      this.filmRuntime.geometry.computeVertexNormals();
      this.filmRuntime.geometry.computeBoundingSphere();
    }
  }

  private sampleConstraintPoint(constraint: BoundaryConstraint): Vector3 | null {
    const frameEntity = this.frameEntities.get(constraint.frameId);
    if (!frameEntity) {
      return null;
    }

    const localPoint = sampleFramePointLocal(frameEntity.state, constraint.curveParamT, this.boundarySampleScratch);
    return localPoint.applyMatrix4(frameEntity.object.matrixWorld);
  }

  private updateFrameWorldMatrices(): void {
    for (const frameEntity of this.frameEntities.values()) {
      frameEntity.object.updateMatrixWorld(true);
    }
  }

  private setTransformMode(mode: UiState['transformMode']): void {
    this.uiState.transformMode = mode;
    this.transformControls.setMode(mode);
  }

  private getActiveSolverConfig(): SolverConfig {
    const baseConfig = SOLVER_QUALITY_CONFIGS[this.uiState.solverQuality];
    const substeps = baseConfig.substeps;
    const relaxationStrength = Math.min(2, Math.max(0.05, this.uiState.relaxationStrength));
    const shapeRetention = Math.min(0.5, Math.max(0, this.uiState.shapeRetention));

    return {
      substeps,
      stepSize: baseConfig.stepSize,
      damping: baseConfig.damping,
      laplacianWeight: baseConfig.laplacianWeight,
      relaxationStrength,
      shapeRetention,
    };
  }

  private applySolverQualityConfig(): void {
    if (!this.filmRuntime) {
      return;
    }

    this.filmRuntime.state.solverConfig = this.getActiveSolverConfig();
  }

  private syncFrameStatesFromObjects(): void {
    for (const frameEntity of this.frameEntities.values()) {
      frameEntity.state.position.copy(frameEntity.object.position);
      frameEntity.state.rotation.copy(frameEntity.object.rotation);
      frameEntity.state.scale.copy(frameEntity.object.scale);
    }
  }

  private disposeFilmRuntime(): void {
    if (!this.filmRuntime) {
      return;
    }

    this.scene.remove(this.filmRuntime.mesh);
    this.scene.remove(this.filmRuntime.wireframeMesh);

    this.filmRuntime.geometry.dispose();
    this.filmRuntime.material.dispose();
    this.filmRuntime.wireframeMaterial.dispose();

    this.filmRuntime = null;
  }
}

export function createSoapFilmApp(canvas: HTMLCanvasElement): SoapFilmApp {
  return new SoapFilmAppImpl(canvas);
}
