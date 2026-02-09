import {
  ACESFilmicToneMapping,
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  DynamicDrawUsage,
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
  SphereGeometry,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { BoundaryConstraint, FilmState, FrameState, FrameType, SoapFilmApp, SolverConfig } from '../types';
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
  transformObject: Object3D;
  scaleProxy: Object3D;
  line: LineLoop;
  material: LineBasicMaterial;
  controlPointGroup: Object3D;
  controlPoints: FrameControlPointEntity[];
}

interface FrameControlPointEntity {
  index: number;
  object: Object3D;
  mesh: Mesh;
}

interface FilmRuntime {
  state: FilmState;
  solverContext: SolverContext;
  geometry: BufferGeometry;
  mesh: Mesh;
  wireframeMesh: Mesh;
  material: MeshPhysicalMaterial;
  wireframeMaterial: MeshBasicMaterial;
  oilTimeUniform: { value: number };
}

interface UiState {
  solverQuality: 'fast' | 'balanced' | 'high';
  solverSpeed: number;
  relaxationStrength: number;
  shapeRetention: number;
  showWireframe: boolean;
}

interface UiElements {
  panel: HTMLDivElement;
  handleTop: HTMLDivElement;
  handleBottom: HTMLDivElement;
  collapseToggle: HTMLButtonElement;
  addCircleButton: HTMLButtonElement;
  addRectangleButton: HTMLButtonElement;
  addSquareButton: HTMLButtonElement;
  addTriangleButton: HTMLButtonElement;
  resetSolverButton: HTMLButtonElement;
  solverQualitySelect: HTMLSelectElement;
  solverSpeedRange: HTMLInputElement;
  solverSpeedValue: HTMLSpanElement;
  relaxationStrengthRange: HTMLInputElement;
  relaxationStrengthValue: HTMLSpanElement;
  shapeRetentionRange: HTMLInputElement;
  shapeRetentionValue: HTMLSpanElement;
  wireframeToggle: HTMLInputElement;
}

interface UiRangeBinding {
  input: HTMLInputElement;
  value: HTMLSpanElement;
  format: (value: number) => string;
}

interface FrameClipboardData {
  type: FrameType;
  radius: number;
  width: number;
  height: number;
  boundarySamples: number;
  controlPoints: [number, number, number][];
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
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

const DRAG_SUBSTEP_MULTIPLIER = 3;
const DRAG_MAX_SUBSTEPS = 24;
const DRAG_DAMPING_CAP = 0.82;
const DRAG_STEP_SIZE_SCALE = 0.9;
const DRAG_LAPLACIAN_SCALE = 1.2;
const DRAG_RELAXATION_BOOST = 1.35;
const DRAG_MAX_RELAXATION_STRENGTH = 3;
const SOLVER_SPEED_MIN = 0.1;
const SOLVER_SPEED_MAX = 4;
const SCALE_EPSILON = 1e-4;
const ENVIRONMENT_BLUR_SIGMA = 1.25;
const BACK_SCALE_HANDLE_OFFSET = 0.4;
const TRANSLATE_ARROW_HEAD_SCALE = 2 / 3;
const CONTROL_POINT_WORLD_RADIUS = 0.04;
const CONTROL_POINT_DEFAULT_COLOR = 0x2ecfff;
const CONTROL_POINT_SELECTED_COLOR = 0xffffff;

class SoapFilmAppImpl implements SoapFilmApp {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;
  private readonly scene: Scene;
  private readonly camera: PerspectiveCamera;
  private readonly orbitControls: OrbitControls;
  private readonly transformControls: TransformControls[];
  private readonly transformControlHelpers: Object3D[];
  private readonly controlPointTransformControl: TransformControls;
  private readonly controlPointTransformHelper: Object3D;
  private readonly uiElements: UiElements;
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private readonly boundarySampleScratch = new Vector3();
  private readonly worldScaleScratch = new Vector3();
  private readonly uiCleanupCallbacks: Array<() => void> = [];
  private readonly uiRangeBindings: UiRangeBinding[] = [];
  private readonly controlPointGeometry = new SphereGeometry(1, 14, 10);
  private readonly controlPointMaterial = new MeshBasicMaterial({ color: CONTROL_POINT_DEFAULT_COLOR });
  private readonly controlPointSelectedMaterial = new MeshBasicMaterial({ color: CONTROL_POINT_SELECTED_COLOR });

  private readonly frameEntities = new Map<string, FrameEntity>();
  private readonly frameSelectable = new Set<Object3D>();
  private readonly controlPointSelectable = new Set<Object3D>();
  private selectedFrameId: string | null = null;
  private pointEditFrameId: string | null = null;
  private selectedControlPoint: { frameId: string; controlPointIndex: number } | null = null;
  private frameClipboard: FrameClipboardData | null = null;
  private frameIdCounter = 0;

  private filmRuntime: FilmRuntime | null = null;
  private environmentRenderTarget: WebGLRenderTarget | null = null;

  private readonly uiState: UiState = {
    solverQuality: 'balanced',
    solverSpeed: 1,
    relaxationStrength: 1,
    shapeRetention: 0,
    showWireframe: false,
  };
  private isTransformDragging = false;
  private isUsingTransformControls = false;
  private geometryUpdateCounter = 0;
  private lastAnimationTimeSeconds = performance.now() * 0.001;

  private animationFrameHandle = 0;
  private readonly onResizeBound: () => void;
  private readonly onPointerDownBound: (event: PointerEvent) => void;
  private readonly onDoubleClickBound: (event: MouseEvent) => void;
  private readonly onKeyDownBound: (event: KeyboardEvent) => void;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.scene = new Scene();
    this.scene.background = new Color(0x000000);

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

    const translateControl = this.createTransformControl('translate', 1.0);
    const rotateControl = this.createTransformControl('rotate', 0.5);
    const scaleControl = this.createTransformControl('scale', 0.42);
    this.transformControls = [translateControl.control, rotateControl.control, scaleControl.control];
    this.transformControlHelpers = [translateControl.helper, rotateControl.helper, scaleControl.helper];
    const controlPointTransform = this.createControlPointTransformControl(0.8);
    this.controlPointTransformControl = controlPointTransform.control;
    this.controlPointTransformHelper = controlPointTransform.helper;

    this.raycaster.params.Line = { threshold: 0.2 };

    this.setupSceneHelpers();
    this.setupEnvironment();

    this.uiElements = this.resolveUiElements();
    this.setupUi();

    this.onResizeBound = () => this.handleResize();
    this.onPointerDownBound = (event) => this.handlePointerDown(event);
    this.onDoubleClickBound = (event) => this.handleDoubleClick(event);
    this.onKeyDownBound = (event) => this.handleKeyDown(event);

    window.addEventListener('resize', this.onResizeBound);
    this.canvas.addEventListener('pointerdown', this.onPointerDownBound);
    this.canvas.addEventListener('dblclick', this.onDoubleClickBound);
    window.addEventListener('keydown', this.onKeyDownBound);

    this.animationLoop();
  }

  addFrame(type: FrameType): string {
    const id = `frame-${++this.frameIdCounter}`;
    const state = createDefaultFrameState(id, type);

    if (type === 'circle') {
      state.radius = 1;
    } else if (type === 'rectangle') {
      state.width = 2;
      state.height = 1.4;
    } else if (type === 'square') {
      state.width = 2;
      state.height = 2;
    } else {
      state.width = 2;
      state.height = 1.8;
    }

    const placement = FRAME_DEFAULT_POSITIONS[this.frameEntities.size % FRAME_DEFAULT_POSITIONS.length];
    state.position.set(placement[0], placement[1], placement[2]);
    state.rotation.set(0, (this.frameEntities.size * Math.PI) / 8, 0);

    return this.addFrameFromState(state);
  }

  private addFrameFromState(state: FrameState): string {
    const frameEntity = this.createFrameEntity(state);
    this.frameEntities.set(state.id, frameEntity);
    this.frameSelectable.add(frameEntity.line);
    this.selectFrame(state.id);
    this.rebuildFilm();
    return state.id;
  }

  private createFrameEntity(state: FrameState): FrameEntity {
    const transformObject = new Object3D();
    transformObject.position.copy(state.position);
    transformObject.rotation.copy(state.rotation);

    const scaleProxy = new Object3D();
    scaleProxy.scale.set(
      Math.max(SCALE_EPSILON, Math.abs(state.scale.x)),
      Math.max(SCALE_EPSILON, Math.abs(state.scale.y)),
      Math.max(SCALE_EPSILON, Math.abs(state.scale.z)),
    );

    const object = new Object3D();
    object.scale.set(this.getScaleSign(state.scale.x), this.getScaleSign(state.scale.y), this.getScaleSign(state.scale.z));

    const lineGeometry = new BufferGeometry().setFromPoints(sampleFrameBoundaryLocal(state, state.boundarySamples));
    const lineMaterial = new LineBasicMaterial({ color: 0xffffff });
    const line = new LineLoop(lineGeometry, lineMaterial);
    line.userData.frameId = state.id;
    line.renderOrder = 5;

    const controlPointGroup = new Object3D();
    controlPointGroup.visible = false;
    const controlPoints: FrameControlPointEntity[] = [];
    for (let i = 0; i < state.controlPoints.length; i += 1) {
      const handleObject = new Object3D();
      handleObject.position.copy(state.controlPoints[i]);

      const handleMesh = new Mesh(this.controlPointGeometry, this.controlPointMaterial);
      handleMesh.userData.frameId = state.id;
      handleMesh.userData.controlPointIndex = i;
      handleMesh.renderOrder = 6;

      handleObject.add(handleMesh);
      controlPointGroup.add(handleObject);
      controlPoints.push({
        index: i,
        object: handleObject,
        mesh: handleMesh,
      });
      this.controlPointSelectable.add(handleMesh);
    }

    transformObject.add(scaleProxy);
    scaleProxy.add(object);
    object.add(line);
    object.add(controlPointGroup);
    this.scene.add(transformObject);

    return {
      id: state.id,
      state,
      object,
      transformObject,
      scaleProxy,
      line,
      material: lineMaterial,
      controlPointGroup,
      controlPoints,
    };
  }

  removeFrame(frameId: string): void {
    const frameEntity = this.frameEntities.get(frameId);
    if (!frameEntity) {
      return;
    }

    if (this.pointEditFrameId === frameId) {
      this.exitPointEditMode();
    }
    if (this.selectedFrameId === frameId) {
      this.selectFrame(null);
    }

    this.frameSelectable.delete(frameEntity.line);
    for (const controlPoint of frameEntity.controlPoints) {
      this.controlPointSelectable.delete(controlPoint.mesh);
    }
    frameEntity.line.geometry.dispose();
    frameEntity.material.dispose();

    frameEntity.object.remove(frameEntity.line);
    frameEntity.object.remove(frameEntity.controlPointGroup);
    frameEntity.scaleProxy.remove(frameEntity.object);
    frameEntity.transformObject.remove(frameEntity.scaleProxy);
    this.scene.remove(frameEntity.transformObject);

    this.frameEntities.delete(frameId);
    this.rebuildFilm();
  }

  selectFrame(frameId: string | null): void {
    if (this.selectedFrameId === frameId) {
      return;
    }

    if (this.pointEditFrameId && this.pointEditFrameId !== frameId) {
      this.exitPointEditMode();
    }

    this.selectedFrameId = frameId;

    for (const [id, frameEntity] of this.frameEntities) {
      frameEntity.material.color.setHex(id === frameId ? 0x00ffff : 0xffffff);
    }
    this.updateControlPointVisibility();
    this.updateFrameTransformControlAttachments();
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

    const { material, oilTimeUniform } = this.createSoapFilmMaterial();

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
      oilTimeUniform,
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
    this.canvas.removeEventListener('dblclick', this.onDoubleClickBound);
    window.removeEventListener('keydown', this.onKeyDownBound);

    for (const cleanup of this.uiCleanupCallbacks) {
      cleanup();
    }
    this.uiCleanupCallbacks.length = 0;

    for (const helper of this.transformControlHelpers) {
      this.scene.remove(helper);
    }
    for (const control of this.transformControls) {
      control.dispose();
    }
    this.scene.remove(this.controlPointTransformHelper);
    this.controlPointTransformControl.dispose();
    this.orbitControls.dispose();

    for (const frameEntity of this.frameEntities.values()) {
      frameEntity.line.geometry.dispose();
      frameEntity.material.dispose();
      frameEntity.object.remove(frameEntity.controlPointGroup);
      frameEntity.object.remove(frameEntity.line);
      frameEntity.scaleProxy.remove(frameEntity.object);
      frameEntity.transformObject.remove(frameEntity.scaleProxy);
      this.scene.remove(frameEntity.transformObject);
    }
    this.frameEntities.clear();
    this.frameSelectable.clear();
    this.controlPointSelectable.clear();

    this.disposeFilmRuntime();

    if (this.environmentRenderTarget) {
      this.environmentRenderTarget.dispose();
      this.environmentRenderTarget = null;
    }

    this.controlPointGeometry.dispose();
    this.controlPointMaterial.dispose();
    this.controlPointSelectedMaterial.dispose();
    this.renderer.dispose();
  }

  private setupSceneHelpers(): void {
    const ambient = new AmbientLight(0xffffff, 0.55);
    this.scene.add(ambient);

    const directional = new DirectionalLight(0xffffff, 1.15);
    directional.position.set(8, 10, 4);
    this.scene.add(directional);
  }

  private setupEnvironment(): void {
    const pmremGenerator = new PMREMGenerator(this.renderer);
    const roomEnvironment = new RoomEnvironment();
    this.environmentRenderTarget = pmremGenerator.fromScene(roomEnvironment, ENVIRONMENT_BLUR_SIGMA);
    this.scene.environment = this.environmentRenderTarget.texture;

    roomEnvironment.dispose();
    pmremGenerator.dispose();
  }

  private resolveUiElements(): UiElements {
    const panel = document.getElementById('ui-panel');
    const handleTop = document.getElementById('ui-handle');
    const handleBottom = document.getElementById('ui-handle-bottom');
    const collapseToggle = document.getElementById('collapse-toggle');
    const addCircleButton = document.getElementById('add-circle');
    const addRectangleButton = document.getElementById('add-rectangle');
    const addSquareButton = document.getElementById('add-square');
    const addTriangleButton = document.getElementById('add-triangle');
    const resetSolverButton = document.getElementById('reset-solver');
    const solverQualitySelect = document.getElementById('solver-quality');
    const solverSpeedRange = document.getElementById('solver-speed');
    const solverSpeedValue = document.getElementById('solver-speed-value');
    const relaxationStrengthRange = document.getElementById('relaxation-strength');
    const relaxationStrengthValue = document.getElementById('relaxation-strength-value');
    const shapeRetentionRange = document.getElementById('shape-retention');
    const shapeRetentionValue = document.getElementById('shape-retention-value');
    const wireframeToggle = document.getElementById('show-wireframe');

    if (
      !(panel instanceof HTMLDivElement) ||
      !(handleTop instanceof HTMLDivElement) ||
      !(handleBottom instanceof HTMLDivElement) ||
      !(collapseToggle instanceof HTMLButtonElement) ||
      !(addCircleButton instanceof HTMLButtonElement) ||
      !(addRectangleButton instanceof HTMLButtonElement) ||
      !(addSquareButton instanceof HTMLButtonElement) ||
      !(addTriangleButton instanceof HTMLButtonElement) ||
      !(resetSolverButton instanceof HTMLButtonElement) ||
      !(solverQualitySelect instanceof HTMLSelectElement) ||
      !(solverSpeedRange instanceof HTMLInputElement) ||
      !(solverSpeedValue instanceof HTMLSpanElement) ||
      !(relaxationStrengthRange instanceof HTMLInputElement) ||
      !(relaxationStrengthValue instanceof HTMLSpanElement) ||
      !(shapeRetentionRange instanceof HTMLInputElement) ||
      !(shapeRetentionValue instanceof HTMLSpanElement) ||
      !(wireframeToggle instanceof HTMLInputElement)
    ) {
      throw new Error('UI elements for controls panel are missing or invalid.');
    }

    return {
      panel,
      handleTop,
      handleBottom,
      collapseToggle,
      addCircleButton,
      addRectangleButton,
      addSquareButton,
      addTriangleButton,
      resetSolverButton,
      solverQualitySelect,
      solverSpeedRange,
      solverSpeedValue,
      relaxationStrengthRange,
      relaxationStrengthValue,
      shapeRetentionRange,
      shapeRetentionValue,
      wireframeToggle,
    };
  }

  private setupUi(): void {
    this.uiElements.solverQualitySelect.value = this.uiState.solverQuality;
    this.uiElements.wireframeToggle.checked = this.uiState.showWireframe;

    this.bindRangeControl(
      {
        input: this.uiElements.solverSpeedRange,
        value: this.uiElements.solverSpeedValue,
        format: (value) => value.toFixed(2),
      },
      (value) => {
        this.uiState.solverSpeed = value;
        if (this.filmRuntime) {
          this.applySolverQualityConfig();
        }
      },
      this.uiState.solverSpeed,
    );

    this.bindRangeControl(
      {
        input: this.uiElements.relaxationStrengthRange,
        value: this.uiElements.relaxationStrengthValue,
        format: (value) => value.toFixed(2),
      },
      (value) => {
        this.uiState.relaxationStrength = value;
        if (this.filmRuntime) {
          this.applySolverQualityConfig();
        }
      },
      this.uiState.relaxationStrength,
    );

    this.bindRangeControl(
      {
        input: this.uiElements.shapeRetentionRange,
        value: this.uiElements.shapeRetentionValue,
        format: (value) => value.toFixed(2),
      },
      (value) => {
        this.uiState.shapeRetention = value;
        if (this.filmRuntime) {
          this.applySolverQualityConfig();
        }
      },
      this.uiState.shapeRetention,
    );

    this.addDomListener(this.uiElements.addCircleButton, 'click', () => this.addFrame('circle'));
    this.addDomListener(this.uiElements.addRectangleButton, 'click', () => this.addFrame('rectangle'));
    this.addDomListener(this.uiElements.addSquareButton, 'click', () => this.addFrame('square'));
    this.addDomListener(this.uiElements.addTriangleButton, 'click', () => this.addFrame('triangle'));
    this.addDomListener(this.uiElements.resetSolverButton, 'click', () => this.rebuildFilm());

    this.addDomListener(this.uiElements.solverQualitySelect, 'change', () => {
      const quality = this.uiElements.solverQualitySelect.value as UiState['solverQuality'];
      if (quality === 'fast' || quality === 'balanced' || quality === 'high') {
        this.uiState.solverQuality = quality;
        if (this.filmRuntime) {
          this.applySolverQualityConfig();
        }
      }
    });

    this.addDomListener(this.uiElements.wireframeToggle, 'change', () => {
      this.uiState.showWireframe = this.uiElements.wireframeToggle.checked;
      if (this.filmRuntime) {
        this.filmRuntime.wireframeMesh.visible = this.uiState.showWireframe;
      }
    });

    this.setupUiPanelInteractions();
    this.refreshAllRangeProgress();
  }

  private setupUiPanelInteractions(): void {
    const { panel, handleTop, handleBottom, collapseToggle } = this.uiElements;
    let dragOffset: { x: number; y: number } | null = null;

    this.addDomListener(collapseToggle, 'pointerdown', (event) => {
      event.stopPropagation();
    });

    this.addDomListener(collapseToggle, 'click', () => {
      const collapsed = panel.classList.toggle('is-collapsed');
      collapseToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      this.clampPanelToViewport();
      requestAnimationFrame(() => this.refreshAllRangeProgress());
    });

    const sectionHeadings = panel.querySelectorAll<HTMLButtonElement>('.panel-section .panel-heading');
    for (const heading of sectionHeadings) {
      this.addDomListener(heading, 'click', () => {
        const section = heading.closest('.panel-section');
        if (!section) {
          return;
        }
        const collapsed = section.classList.toggle('is-collapsed');
        heading.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        this.clampPanelToViewport();
        requestAnimationFrame(() => this.refreshAllRangeProgress());
      });
    }

    const startDrag = (event: Event): void => {
      const pointerEvent = event as PointerEvent;
      const target = pointerEvent.target;
      if (target instanceof Element && target.closest('.collapse-button')) {
        return;
      }
      const currentTarget = pointerEvent.currentTarget;
      if (!(currentTarget instanceof Element)) {
        return;
      }
      if ('setPointerCapture' in currentTarget) {
        (currentTarget as HTMLElement).setPointerCapture(pointerEvent.pointerId);
      }
      dragOffset = {
        x: pointerEvent.clientX - panel.offsetLeft,
        y: pointerEvent.clientY - panel.offsetTop,
      };
    };

    const moveDrag = (event: Event): void => {
      const pointerEvent = event as PointerEvent;
      if (!dragOffset) {
        return;
      }
      const margin = 10;
      const nextX = Math.max(
        margin,
        Math.min(window.innerWidth - panel.offsetWidth - margin, pointerEvent.clientX - dragOffset.x),
      );
      const nextY = Math.max(margin, pointerEvent.clientY - dragOffset.y);
      panel.style.left = `${nextX}px`;
      panel.style.top = `${nextY}px`;
      this.clampPanelToViewport();
    };

    const endDrag = (): void => {
      dragOffset = null;
    };

    const dragTargets = [handleTop, handleBottom];
    for (const dragTarget of dragTargets) {
      this.addDomListener(dragTarget, 'pointerdown', startDrag);
      this.addDomListener(dragTarget, 'pointermove', moveDrag);
      this.addDomListener(dragTarget, 'pointerup', endDrag);
      this.addDomListener(dragTarget, 'pointercancel', endDrag);
    }

    this.clampPanelToViewport();
  }

  private bindRangeControl(binding: UiRangeBinding, onChange: (value: number) => void, initialValue: number): void {
    this.uiRangeBindings.push(binding);
    binding.input.value = String(initialValue);
    const update = (): void => {
      const value = Number(binding.input.value);
      binding.value.textContent = binding.format(value);
      this.setRangeProgress(binding.input);
      onChange(value);
    };
    this.addDomListener(binding.input, 'input', update);
    update();
  }

  private setRangeProgress(input: HTMLInputElement): void {
    const min = Number(input.min);
    const max = Number(input.max);
    const value = Number(input.value);
    const span = max - min;
    const percent = span <= 0 ? 0 : (value - min) / span;
    const thumbSize = 16;
    const trackWidth = input.clientWidth || 1;
    const usable = Math.max(trackWidth - thumbSize, 1);
    const px = percent * usable + thumbSize * 0.5;
    input.style.setProperty('--range-progress', `${px}px`);
  }

  private refreshAllRangeProgress(): void {
    for (const binding of this.uiRangeBindings) {
      this.setRangeProgress(binding.input);
    }
  }

  private clampPanelToViewport(): void {
    const { panel, handleTop, handleBottom } = this.uiElements;
    const margin = 10;

    const minHeight = handleTop.offsetHeight + handleBottom.offsetHeight + 40;
    const maxTop = Math.max(margin, window.innerHeight - minHeight - margin);
    const clampedTop = Math.min(Math.max(panel.offsetTop, margin), maxTop);
    if (clampedTop !== panel.offsetTop) {
      panel.style.top = `${clampedTop}px`;
    }

    const availableHeight = window.innerHeight - clampedTop - margin;
    panel.style.maxHeight = `${Math.max(availableHeight, minHeight)}px`;

    const maxLeft = Math.max(margin, window.innerWidth - panel.offsetWidth - margin);
    const clampedLeft = Math.min(Math.max(panel.offsetLeft, margin), maxLeft);
    if (clampedLeft !== panel.offsetLeft) {
      panel.style.left = `${clampedLeft}px`;
    }
  }

  private addDomListener(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions | boolean,
  ): void {
    target.addEventListener(type, listener, options);
    this.uiCleanupCallbacks.push(() => {
      target.removeEventListener(type, listener, options);
    });
  }

  private handleResize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.clampPanelToViewport();
    this.refreshAllRangeProgress();
  }

  private handlePointerDown(event: PointerEvent): void {
    if (event.button !== 0) {
      return;
    }
    if (this.isUsingTransformControls || this.isTransformDragging) {
      return;
    }

    this.updatePointerFromEvent(event);
    this.raycaster.setFromCamera(this.pointer, this.camera);

    if (this.pointEditFrameId) {
      const controlPointIntersections = this.raycaster.intersectObjects(Array.from(this.controlPointSelectable), false);
      const matchingControlPointHit = controlPointIntersections.find(
        (intersection) => (intersection.object.userData.frameId as string | undefined) === this.pointEditFrameId,
      );
      if (matchingControlPointHit) {
        const frameId = matchingControlPointHit.object.userData.frameId as string | undefined;
        const controlPointIndex = matchingControlPointHit.object.userData.controlPointIndex as number | undefined;
        if (frameId && typeof controlPointIndex === 'number') {
          this.selectControlPoint(frameId, controlPointIndex);
          return;
        }
      }
    }

    const intersections = this.raycaster.intersectObjects(Array.from(this.frameSelectable));
    if (intersections.length === 0) {
      this.exitPointEditMode();
      this.selectFrame(null);
      return;
    }

    const selectedObject = intersections[0].object;
    const frameId = selectedObject.userData.frameId as string | undefined;
    if (!frameId) {
      this.exitPointEditMode();
      this.selectFrame(null);
      return;
    }

    this.selectFrame(frameId);
    if (this.pointEditFrameId === frameId) {
      this.selectControlPoint(null);
    }
  }

  private handleDoubleClick(event: MouseEvent): void {
    if (event.button !== 0) {
      return;
    }
    if (this.isUsingTransformControls || this.isTransformDragging) {
      return;
    }

    this.updatePointerFromEvent(event);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const intersections = this.raycaster.intersectObjects(Array.from(this.frameSelectable));
    if (intersections.length === 0) {
      this.exitPointEditMode();
      return;
    }

    const frameId = intersections[0].object.userData.frameId as string | undefined;
    if (!frameId) {
      this.exitPointEditMode();
      return;
    }

    this.selectFrame(frameId);
    if (this.pointEditFrameId === frameId) {
      this.exitPointEditMode();
    } else {
      this.enterPointEditMode(frameId);
    }
  }

  private handleKeyDown(event: KeyboardEvent): void {
    const hasModifier = event.ctrlKey || event.metaKey;
    if (hasModifier) {
      const key = event.key.toLowerCase();
      if (key === 'c') {
        this.copySelectedFrame();
        event.preventDefault();
        return;
      }
      if (key === 'v') {
        this.pasteFrameFromClipboard();
        event.preventDefault();
        return;
      }
    }

    if (!hasModifier && event.key === 'Escape') {
      if (this.pointEditFrameId) {
        this.exitPointEditMode();
      } else {
        this.selectFrame(null);
      }
      event.preventDefault();
    }

    if (!hasModifier && event.key === 'Delete' && this.selectedFrameId) {
      this.removeFrame(this.selectedFrameId);
    }
  }

  private updatePointerFromEvent(event: PointerEvent | MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  private enterPointEditMode(frameId: string): void {
    const frameEntity = this.frameEntities.get(frameId);
    if (!frameEntity || frameEntity.controlPoints.length === 0) {
      return;
    }

    this.pointEditFrameId = frameId;
    this.updateControlPointVisibility();
    this.updateFrameTransformControlAttachments();
    this.selectControlPoint(frameId, 0);
  }

  private exitPointEditMode(): void {
    if (!this.pointEditFrameId && !this.selectedControlPoint) {
      return;
    }

    this.pointEditFrameId = null;
    this.selectControlPoint(null);
    this.updateControlPointVisibility();
    this.updateFrameTransformControlAttachments();
  }

  private updateControlPointVisibility(): void {
    for (const [frameId, frameEntity] of this.frameEntities) {
      frameEntity.controlPointGroup.visible = this.pointEditFrameId === frameId;
    }
  }

  private updateFrameTransformControlAttachments(): void {
    for (const control of this.transformControls) {
      control.detach();
    }

    if (!this.selectedFrameId) {
      return;
    }
    if (this.pointEditFrameId === this.selectedFrameId) {
      return;
    }

    const frameEntity = this.frameEntities.get(this.selectedFrameId);
    if (!frameEntity) {
      return;
    }

    const [translateControl, rotateControl, scaleControl] = this.transformControls;
    translateControl?.attach(frameEntity.transformObject);
    rotateControl?.attach(frameEntity.transformObject);
    scaleControl?.attach(frameEntity.scaleProxy);
  }

  private selectControlPoint(frameId: string, controlPointIndex: number): void;
  private selectControlPoint(frameId: null): void;
  private selectControlPoint(frameId: string | null, controlPointIndex = -1): void {
    if (!frameId || controlPointIndex < 0) {
      this.selectedControlPoint = null;
      this.controlPointTransformControl.detach();
      this.refreshControlPointVisuals();
      return;
    }

    const frameEntity = this.frameEntities.get(frameId);
    if (!frameEntity) {
      this.selectedControlPoint = null;
      this.controlPointTransformControl.detach();
      this.refreshControlPointVisuals();
      return;
    }

    const controlPoint = frameEntity.controlPoints[controlPointIndex];
    if (!controlPoint) {
      return;
    }

    this.selectedControlPoint = { frameId, controlPointIndex };
    this.controlPointTransformControl.attach(controlPoint.object);
    this.refreshControlPointVisuals();
  }

  private refreshControlPointVisuals(): void {
    for (const [frameId, frameEntity] of this.frameEntities) {
      for (const controlPoint of frameEntity.controlPoints) {
        const isSelected =
          this.selectedControlPoint?.frameId === frameId &&
          this.selectedControlPoint.controlPointIndex === controlPoint.index;
        controlPoint.mesh.material = isSelected ? this.controlPointSelectedMaterial : this.controlPointMaterial;
      }
    }
  }

  private syncFrameControlPointsFromHandles(frameEntity: FrameEntity): void {
    if (frameEntity.state.controlPoints.length !== frameEntity.controlPoints.length) {
      frameEntity.state.controlPoints = frameEntity.controlPoints.map(() => new Vector3());
    }

    for (const controlPoint of frameEntity.controlPoints) {
      frameEntity.state.controlPoints[controlPoint.index].copy(controlPoint.object.position);
    }
  }

  private refreshFrameLineGeometry(frameEntity: FrameEntity): void {
    const samples = sampleFrameBoundaryLocal(frameEntity.state, frameEntity.state.boundarySamples);
    const geometry = frameEntity.line.geometry as BufferGeometry;
    const positionAttribute = geometry.getAttribute('position') as BufferAttribute | undefined;
    if (!positionAttribute || positionAttribute.count !== samples.length) {
      frameEntity.line.geometry.dispose();
      frameEntity.line.geometry = new BufferGeometry().setFromPoints(samples);
      frameEntity.line.computeLineDistances?.();
      return;
    }

    for (let i = 0; i < samples.length; i += 1) {
      const point = samples[i];
      positionAttribute.setXYZ(i, point.x, point.y, point.z);
    }
    positionAttribute.needsUpdate = true;
    geometry.computeBoundingSphere();
  }

  private copySelectedFrame(): void {
    if (!this.selectedFrameId) {
      return;
    }

    const frameEntity = this.frameEntities.get(this.selectedFrameId);
    if (!frameEntity) {
      return;
    }

    frameEntity.state.position.copy(frameEntity.transformObject.position);
    frameEntity.state.rotation.copy(frameEntity.transformObject.rotation);
    this.copyFrameScaleFromNodes(frameEntity, frameEntity.state.scale);
    this.syncFrameControlPointsFromHandles(frameEntity);

    this.frameClipboard = {
      type: frameEntity.state.type,
      radius: frameEntity.state.radius,
      width: frameEntity.state.width,
      height: frameEntity.state.height,
      boundarySamples: frameEntity.state.boundarySamples,
      controlPoints: frameEntity.state.controlPoints.map((point) => [point.x, point.y, point.z]),
      position: [frameEntity.state.position.x, frameEntity.state.position.y, frameEntity.state.position.z],
      rotation: [frameEntity.state.rotation.x, frameEntity.state.rotation.y, frameEntity.state.rotation.z],
      scale: [frameEntity.state.scale.x, frameEntity.state.scale.y, frameEntity.state.scale.z],
    };
  }

  private pasteFrameFromClipboard(): void {
    if (!this.frameClipboard) {
      return;
    }

    const id = `frame-${++this.frameIdCounter}`;
    const state = createDefaultFrameState(id, this.frameClipboard.type);
    state.radius = this.frameClipboard.radius;
    state.width = this.frameClipboard.width;
    state.height = this.frameClipboard.height;
    state.boundarySamples = this.frameClipboard.boundarySamples;
    state.controlPoints = this.frameClipboard.controlPoints.map(
      (point) => new Vector3(point[0], point[1], point[2]),
    );

    state.position.set(
      this.frameClipboard.position[0] + 0.5,
      this.frameClipboard.position[1],
      this.frameClipboard.position[2] + 0.5,
    );
    state.rotation.set(
      this.frameClipboard.rotation[0],
      this.frameClipboard.rotation[1],
      this.frameClipboard.rotation[2],
    );
    state.scale.set(this.frameClipboard.scale[0], this.frameClipboard.scale[1], this.frameClipboard.scale[2]);

    this.addFrameFromState(state);
  }

  private animationLoop = (): void => {
    this.animationFrameHandle = requestAnimationFrame(this.animationLoop);
    const nowSeconds = performance.now() * 0.001;
    const deltaSeconds = Math.min(0.05, Math.max(0.001, nowSeconds - this.lastAnimationTimeSeconds));
    this.lastAnimationTimeSeconds = nowSeconds;

    this.orbitControls.update();
    this.updateFrameWorldMatrices();
    this.updateControlPointHandleScales();

    if (this.filmRuntime) {
      this.filmRuntime.oilTimeUniform.value += deltaSeconds;
      this.applySolverQualityConfig();
      const quality = SOLVER_QUALITY_CONFIGS[this.uiState.solverQuality];

      runRelaxationStep(
        this.filmRuntime.state,
        this.filmRuntime.solverContext,
        (constraint) => this.sampleConstraintPoint(constraint),
        { computeSurfaceArea: false },
      );

      this.geometryUpdateCounter += 1;

      const normalsInterval = this.isTransformDragging ? 1 : quality.normalsUpdateInterval;
      const shouldRefreshNormals = this.geometryUpdateCounter % normalsInterval === 0;
      this.refreshFilmGeometry(shouldRefreshNormals);
    }

    this.renderer.render(this.scene, this.camera);
  };

  private updateControlPointHandleScales(): void {
    for (const frameEntity of this.frameEntities.values()) {
      frameEntity.object.getWorldScale(this.worldScaleScratch);
      const sx = Math.max(1e-4, Math.abs(this.worldScaleScratch.x));
      const sy = Math.max(1e-4, Math.abs(this.worldScaleScratch.y));
      const sz = Math.max(1e-4, Math.abs(this.worldScaleScratch.z));

      for (const controlPoint of frameEntity.controlPoints) {
        controlPoint.mesh.scale.set(
          CONTROL_POINT_WORLD_RADIUS / sx,
          CONTROL_POINT_WORLD_RADIUS / sy,
          CONTROL_POINT_WORLD_RADIUS / sz,
        );
      }
    }
  }

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
      frameEntity.transformObject.updateMatrixWorld(true);
    }
  }

  private getActiveSolverConfig(): SolverConfig {
    const baseConfig = SOLVER_QUALITY_CONFIGS[this.uiState.solverQuality];
    const speedScale = Math.min(SOLVER_SPEED_MAX, Math.max(SOLVER_SPEED_MIN, this.uiState.solverSpeed));
    let substeps = Math.max(1, Math.round(baseConfig.substeps * speedScale));
    let stepSize = baseConfig.stepSize;
    let damping = baseConfig.damping;
    let laplacianWeight = baseConfig.laplacianWeight;
    let relaxationStrength = Math.min(2, Math.max(0.05, this.uiState.relaxationStrength));
    const shapeRetention = Math.min(0.5, Math.max(0, this.uiState.shapeRetention));

    if (this.isTransformDragging) {
      substeps = Math.min(
        DRAG_MAX_SUBSTEPS,
        Math.max(baseConfig.substeps + 2, baseConfig.substeps * DRAG_SUBSTEP_MULTIPLIER),
      );
      stepSize = baseConfig.stepSize * DRAG_STEP_SIZE_SCALE;
      damping = Math.min(baseConfig.damping, DRAG_DAMPING_CAP);
      laplacianWeight = baseConfig.laplacianWeight * DRAG_LAPLACIAN_SCALE;
      relaxationStrength = Math.min(
        DRAG_MAX_RELAXATION_STRENGTH,
        Math.max(0.05, relaxationStrength * DRAG_RELAXATION_BOOST),
      );
    }

    return {
      substeps,
      stepSize,
      damping,
      laplacianWeight,
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
      frameEntity.state.position.copy(frameEntity.transformObject.position);
      frameEntity.state.rotation.copy(frameEntity.transformObject.rotation);
      this.copyFrameScaleFromNodes(frameEntity, frameEntity.state.scale);
      this.syncFrameControlPointsFromHandles(frameEntity);
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

  private createControlPointTransformControl(size: number): { control: TransformControls; helper: Object3D } {
    const control = new TransformControls(this.camera, this.renderer.domElement);
    control.setMode('translate');
    control.setSpace('local');
    control.setSize(size);
    control.addEventListener('dragging-changed', () => {
      if (control.dragging) {
        this.setExclusiveTransformControl(control);
      } else {
        this.setExclusiveTransformControl(null);
      }
      this.updateTransformDraggingState();
    });
    control.addEventListener('mouseDown', () => {
      if (!this.getTransformControlAxis(control)) {
        return;
      }
      this.setExclusiveTransformControl(control);
      this.isUsingTransformControls = true;
    });
    control.addEventListener('mouseUp', () => {
      window.setTimeout(() => {
        this.isUsingTransformControls = false;
        this.setExclusiveTransformControl(null);
      }, 0);
    });
    control.addEventListener('objectChange', () => {
      this.handleControlPointObjectChange();
    });

    this.stripNonAxisTransformHandles(control, 'translate');
    this.stripTranslateBackArrows(control);
    this.resizeTranslateArrowHeads(control, TRANSLATE_ARROW_HEAD_SCALE);

    const helper = control.getHelper();
    this.scene.add(helper);
    return { control, helper };
  }

  private createTransformControl(
    mode: 'translate' | 'rotate' | 'scale',
    size: number,
  ): { control: TransformControls; helper: Object3D } {
    const control = new TransformControls(this.camera, this.renderer.domElement);
    control.setMode(mode);
    control.setSpace('local');
    control.setSize(size);
    control.addEventListener('dragging-changed', () => {
      if (control.dragging) {
        this.setExclusiveTransformControl(control);
      } else {
        this.setExclusiveTransformControl(null);
      }
      this.updateTransformDraggingState();
    });
    control.addEventListener('mouseDown', () => {
      if (!this.getTransformControlAxis(control)) {
        return;
      }
      this.setExclusiveTransformControl(control);
      this.isUsingTransformControls = true;
    });
    control.addEventListener('mouseUp', () => {
      window.setTimeout(() => {
        this.isUsingTransformControls = false;
        this.setExclusiveTransformControl(null);
      }, 0);
    });
    if (mode === 'scale') {
      control.addEventListener('objectChange', () => {
        this.handleScaleProxyObjectChange();
      });
    }

    const helper = control.getHelper();
    this.stripNonAxisTransformHandles(control, mode);
    if (mode === 'translate') {
      this.stripTranslateBackArrows(control);
      this.resizeTranslateArrowHeads(control, TRANSLATE_ARROW_HEAD_SCALE);
    }
    if (mode === 'scale') {
      this.pushBackScaleHandles(control, BACK_SCALE_HANDLE_OFFSET);
    }
    this.scene.add(helper);
    return { control, helper };
  }

  private handleControlPointObjectChange(): void {
    if (!this.selectedControlPoint) {
      return;
    }

    const frameEntity = this.frameEntities.get(this.selectedControlPoint.frameId);
    if (!frameEntity) {
      return;
    }

    const controlPoint = frameEntity.controlPoints[this.selectedControlPoint.controlPointIndex];
    if (!controlPoint) {
      return;
    }

    frameEntity.state.controlPoints[controlPoint.index].copy(controlPoint.object.position);
    this.refreshFrameLineGeometry(frameEntity);
  }

  private handleScaleProxyObjectChange(): void {
    if (!this.selectedFrameId) {
      return;
    }

    const frameEntity = this.frameEntities.get(this.selectedFrameId);
    if (!frameEntity) {
      return;
    }

    frameEntity.scaleProxy.scale.set(
      Math.max(SCALE_EPSILON, Math.abs(frameEntity.scaleProxy.scale.x)),
      Math.max(SCALE_EPSILON, Math.abs(frameEntity.scaleProxy.scale.y)),
      Math.max(SCALE_EPSILON, Math.abs(frameEntity.scaleProxy.scale.z)),
    );
  }

  private updateTransformDraggingState(): void {
    const wasDragging = this.isTransformDragging;
    const isDragging =
      this.controlPointTransformControl.dragging || this.transformControls.some((control) => control.dragging);
    this.isTransformDragging = isDragging;
    this.orbitControls.enabled = !isDragging;
    if (!wasDragging && isDragging && this.filmRuntime) {
      this.filmRuntime.state.velocities.fill(0);
    }
  }

  private getTransformControlAxis(control: TransformControls): string | null {
    const axis = (control as unknown as { axis?: string | null }).axis;
    if (typeof axis === 'string') {
      return axis;
    }
    return null;
  }

  private setExclusiveTransformControl(activeControl: TransformControls | null): void {
    const controls = [...this.transformControls, this.controlPointTransformControl];
    for (const control of controls) {
      control.enabled = !activeControl || control === activeControl;
    }
  }

  private getScaleSign(value: number): number {
    return value < 0 ? -1 : 1;
  }

  private copyFrameScaleFromNodes(frameEntity: FrameEntity, target: Vector3): void {
    target.set(
      frameEntity.scaleProxy.scale.x * frameEntity.object.scale.x,
      frameEntity.scaleProxy.scale.y * frameEntity.object.scale.y,
      frameEntity.scaleProxy.scale.z * frameEntity.object.scale.z,
    );
  }

  private stripNonAxisTransformHandles(control: TransformControls, mode: 'translate' | 'rotate' | 'scale'): void {
    const allowedHandleNames = new Set(mode === 'scale' ? ['X', 'Y', 'Z', 'XYZ'] : ['X', 'Y', 'Z']);
    const internal = control as unknown as {
      _gizmo?: {
        gizmo?: Record<string, Object3D>;
        picker?: Record<string, Object3D>;
        helper?: Record<string, Object3D>;
      };
    };

    const gizmo = internal._gizmo;
    if (!gizmo) {
      return;
    }

    const helperGroup = gizmo.helper?.[mode];
    if (helperGroup) {
      for (const child of [...helperGroup.children]) {
        helperGroup.remove(child);
      }
    }

    const groups: Array<Object3D | undefined> = [gizmo.gizmo?.[mode], gizmo.picker?.[mode]];
    for (const group of groups) {
      if (!group) {
        continue;
      }
      const toRemove = group.children.filter((child) => !allowedHandleNames.has(child.name));
      for (const child of toRemove) {
        group.remove(child);
      }
    }
  }

  private stripTranslateBackArrows(control: TransformControls): void {
    const axisVectors: Record<'X' | 'Y' | 'Z', Vector3> = {
      X: new Vector3(1, 0, 0),
      Y: new Vector3(0, 1, 0),
      Z: new Vector3(0, 0, 1),
    };

    const internal = control as unknown as {
      _gizmo?: {
        gizmo?: Record<string, Object3D>;
        picker?: Record<string, Object3D>;
      };
    };

    const gizmo = internal._gizmo;
    if (!gizmo) {
      return;
    }

    const groups: Array<Object3D | undefined> = [gizmo.gizmo?.translate, gizmo.picker?.translate];
    for (const group of groups) {
      if (!group) {
        continue;
      }

      for (const axisName of ['X', 'Y', 'Z'] as const) {
        const axisChildren = group.children.filter((child) => child.name === axisName);
        if (axisChildren.length <= 1) {
          continue;
        }

        const axisVector = axisVectors[axisName];
        const toRemove: Object3D[] = [];

        for (const child of axisChildren) {
          const meshLike = child as Object3D & { geometry?: BufferGeometry };
          const geometry = meshLike.geometry;
          if (!geometry) {
            continue;
          }

          geometry.computeBoundingBox();
          const boundingBox = geometry.boundingBox;
          if (!boundingBox) {
            continue;
          }

          const center = boundingBox.getCenter(new Vector3());
          const projection = center.dot(axisVector);
          if (projection < -1e-4) {
            toRemove.push(child);
          }
        }

        for (const child of toRemove) {
          group.remove(child);
        }
      }
    }
  }

  private resizeTranslateArrowHeads(control: TransformControls, scaleFactor: number): void {
    const axisVectors: Record<'X' | 'Y' | 'Z', Vector3> = {
      X: new Vector3(1, 0, 0),
      Y: new Vector3(0, 1, 0),
      Z: new Vector3(0, 0, 1),
    };

    const internal = control as unknown as {
      _gizmo?: {
        gizmo?: Record<string, Object3D>;
      };
    };

    const group = internal._gizmo?.gizmo?.translate;
    if (!group) {
      return;
    }

    for (const axisName of ['X', 'Y', 'Z'] as const) {
      const axisVector = axisVectors[axisName];
      for (const child of group.children) {
        if (child.name !== axisName) {
          continue;
        }

        const meshLike = child as Object3D & { geometry?: BufferGeometry };
        const geometry = meshLike.geometry;
        if (!geometry) {
          continue;
        }

        geometry.computeBoundingBox();
        const boundingBox = geometry.boundingBox;
        if (!boundingBox) {
          continue;
        }

        const center = boundingBox.getCenter(new Vector3());
        const size = boundingBox.getSize(new Vector3());
        const maxExtent = Math.max(size.x, size.y, size.z);
        const minExtent = Math.min(size.x, size.y, size.z);

        // Arrow heads are compact meshes near the positive axis tip.
        const projection = center.dot(axisVector);
        const isArrowHead = projection > 0.35 && maxExtent <= 0.16 && minExtent > 0.03;
        if (!isArrowHead) {
          continue;
        }

        const centerInv = center.clone().multiplyScalar(-1);
        geometry.translate(centerInv.x, centerInv.y, centerInv.z);
        geometry.scale(scaleFactor, scaleFactor, scaleFactor);
        geometry.translate(center.x, center.y, center.z);
      }
    }
  }

  private pushBackScaleHandles(control: TransformControls, offset: number): void {
    const axisVectors: Record<'X' | 'Y' | 'Z', Vector3> = {
      X: new Vector3(1, 0, 0),
      Y: new Vector3(0, 1, 0),
      Z: new Vector3(0, 0, 1),
    };

    const internal = control as unknown as {
      _gizmo?: {
        gizmo?: Record<string, Object3D>;
        picker?: Record<string, Object3D>;
      };
    };

    const gizmo = internal._gizmo;
    if (!gizmo) {
      return;
    }

    const visualGroup = gizmo.gizmo?.scale;
    if (visualGroup) {
      for (const axisName of ['X', 'Y', 'Z'] as const) {
        const axisVector = axisVectors[axisName];
        const toRemove: Object3D[] = [];
        for (const child of visualGroup.children) {
          if (child.name !== axisName) {
            continue;
          }
          const meshLike = child as Object3D & { geometry?: BufferGeometry };
          const geometry = meshLike.geometry;
          if (!geometry) {
            continue;
          }

          geometry.computeBoundingBox();
          const boundingBox = geometry.boundingBox;
          if (!boundingBox) {
            continue;
          }

          const size = boundingBox.getSize(new Vector3());
          const maxExtent = Math.max(size.x, size.y, size.z);
          if (maxExtent > 0.2) {
            continue;
          }

          const center = boundingBox.getCenter(new Vector3());
          const projection = center.dot(axisVector);
          if (projection > 1e-4) {
            toRemove.push(child);
          } else if (projection < -1e-4) {
            geometry.translate(-axisVector.x * offset, -axisVector.y * offset, -axisVector.z * offset);
          }
        }
        for (const child of toRemove) {
          visualGroup.remove(child);
        }
      }
    }

    const pickerGroup = gizmo.picker?.scale;
    if (pickerGroup) {
      for (const axisName of ['X', 'Y', 'Z'] as const) {
        const axisVector = axisVectors[axisName];
        const toRemove: Object3D[] = [];
        for (const child of pickerGroup.children) {
          if (child.name !== axisName) {
            continue;
          }
          const meshLike = child as Object3D & { geometry?: BufferGeometry };
          const geometry = meshLike.geometry;
          if (!geometry) {
            continue;
          }

          geometry.computeBoundingBox();
          const boundingBox = geometry.boundingBox;
          if (!boundingBox) {
            continue;
          }

          const center = boundingBox.getCenter(new Vector3());
          const projection = center.dot(axisVector);
          if (projection > 1e-4) {
            toRemove.push(child);
          } else if (projection < -1e-4) {
            geometry.translate(-axisVector.x * offset, -axisVector.y * offset, -axisVector.z * offset);
          }
        }
        for (const child of toRemove) {
          pickerGroup.remove(child);
        }
      }
    }
  }

  private createSoapFilmMaterial(): { material: MeshPhysicalMaterial; oilTimeUniform: { value: number } } {
    const material = new MeshPhysicalMaterial({
      color: 0xd5e4f8,
      transparent: true,
      opacity: 0.39,
      transmission: 1,
      thickness: 0.018,
      ior: 1.33,
      roughness: 0.035,
      metalness: 0,
      envMapIntensity: 0.92,
      iridescence: 1,
      iridescenceIOR: 1.45,
      iridescenceThicknessRange: [80, 1200],
      side: DoubleSide,
      clearcoat: 0.75,
      clearcoatRoughness: 0.06,
    });

    const oilTimeUniform = { value: 0 };
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uOilTime = oilTimeUniform;

      shader.vertexShader =
        `
varying vec3 vSoapWorldPos;
` + shader.vertexShader;

      shader.vertexShader = shader.vertexShader.replace(
        '#include <worldpos_vertex>',
        `
#include <worldpos_vertex>
vSoapWorldPos = worldPosition.xyz;
`,
      );

      shader.fragmentShader =
        `
uniform float uOilTime;
varying vec3 vSoapWorldPos;

vec3 soapSpectrum(float t) {
  return clamp(abs(mod(t * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
}
` + shader.fragmentShader;

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        `
#include <opaque_fragment>
vec3 soapViewDir = normalize(vViewPosition);
float soapFresnel = pow(1.0 - clamp(dot(normalize(normal), soapViewDir), 0.0, 1.0), 2.25);
float soapSwirlA = sin(vSoapWorldPos.x * 0.55 + vSoapWorldPos.y * 0.4 - vSoapWorldPos.z * 0.48 + uOilTime * 0.08) * 0.5 + 0.5;
float soapSwirlB = sin((vSoapWorldPos.x + vSoapWorldPos.y + vSoapWorldPos.z) * 0.95 - uOilTime * 0.055) * 0.5 + 0.5;
float soapHue = fract(soapSwirlA * 0.68 + soapSwirlB * 0.32 + soapFresnel * 0.22 + uOilTime * 0.0018);
vec3 soapTint = soapSpectrum(soapHue);
float soapAmount = (0.04 + 0.3 * soapFresnel) * (0.48 + 0.22 * soapSwirlB);
gl_FragColor.rgb += soapTint * soapAmount * 0.7;
`,
      );
    };

    material.customProgramCacheKey = () => 'soap-film-oily-v1';
    material.needsUpdate = true;

    return { material, oilTimeUniform };
  }
}

export function createSoapFilmApp(canvas: HTMLCanvasElement): SoapFilmApp {
  return new SoapFilmAppImpl(canvas);
}
