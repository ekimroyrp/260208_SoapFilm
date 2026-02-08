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
  resetSolverButton: HTMLButtonElement;
  transformModeSelect: HTMLSelectElement;
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

class SoapFilmAppImpl implements SoapFilmApp {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;
  private readonly scene: Scene;
  private readonly camera: PerspectiveCamera;
  private readonly orbitControls: OrbitControls;
  private readonly transformControls: TransformControls;
  private readonly transformControlsHelper: Object3D;
  private readonly uiElements: UiElements;
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private readonly boundarySampleScratch = new Vector3();
  private readonly uiCleanupCallbacks: Array<() => void> = [];
  private readonly uiRangeBindings: UiRangeBinding[] = [];

  private readonly frameEntities = new Map<string, FrameEntity>();
  private readonly frameSelectable = new Set<Object3D>();
  private selectedFrameId: string | null = null;
  private frameClipboard: FrameClipboardData | null = null;
  private frameIdCounter = 0;

  private filmRuntime: FilmRuntime | null = null;
  private environmentRenderTarget: WebGLRenderTarget | null = null;

  private readonly uiState: UiState = {
    transformMode: 'translate',
    solverQuality: 'balanced',
    solverSpeed: 1,
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

    this.transformControls = new TransformControls(this.camera, this.renderer.domElement);
    this.transformControls.setMode(this.uiState.transformMode);
    this.transformControls.setSpace('local');
    this.transformControls.setSize(0.625);
    this.transformControls.addEventListener('dragging-changed', (event) => {
      const isDragging = Boolean((event as { value?: unknown }).value);
      this.isTransformDragging = isDragging;
      this.orbitControls.enabled = !isDragging;
      if (isDragging && this.filmRuntime) {
        this.filmRuntime.state.velocities.fill(0);
      }
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

    this.uiElements = this.resolveUiElements();
    this.setupUi();

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
    const object = new Object3D();
    object.position.copy(state.position);
    object.rotation.copy(state.rotation);
    object.scale.copy(state.scale);

    const lineGeometry = new BufferGeometry().setFromPoints(sampleFrameBoundaryLocal(state, state.boundarySamples));
    const lineMaterial = new LineBasicMaterial({ color: 0xffffff });
    const line = new LineLoop(lineGeometry, lineMaterial);
    line.userData.frameId = state.id;
    line.renderOrder = 5;

    object.add(line);
    this.scene.add(object);

    return {
      id: state.id,
      state,
      object,
      line,
      material: lineMaterial,
    };
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
      frameEntity.material.color.setHex(id === frameId ? 0x00ffff : 0xffffff);
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

    for (const cleanup of this.uiCleanupCallbacks) {
      cleanup();
    }
    this.uiCleanupCallbacks.length = 0;

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
  }

  private setupEnvironment(): void {
    const pmremGenerator = new PMREMGenerator(this.renderer);
    const roomEnvironment = new RoomEnvironment();
    this.environmentRenderTarget = pmremGenerator.fromScene(roomEnvironment);
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
    const resetSolverButton = document.getElementById('reset-solver');
    const transformModeSelect = document.getElementById('transform-mode');
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
      !(resetSolverButton instanceof HTMLButtonElement) ||
      !(transformModeSelect instanceof HTMLSelectElement) ||
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
      resetSolverButton,
      transformModeSelect,
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
    this.uiElements.transformModeSelect.value = this.uiState.transformMode;
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
    this.addDomListener(this.uiElements.resetSolverButton, 'click', () => this.rebuildFilm());

    this.addDomListener(this.uiElements.transformModeSelect, 'change', () => {
      const mode = this.uiElements.transformModeSelect.value as UiState['transformMode'];
      if (mode === 'translate' || mode === 'rotate' || mode === 'scale') {
        this.setTransformMode(mode);
      }
    });

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

    if (!hasModifier && (event.key === 'w' || event.key === 'W')) {
      this.setTransformMode('translate');
    }

    if (!hasModifier && (event.key === 'e' || event.key === 'E')) {
      this.setTransformMode('rotate');
    }

    if (!hasModifier && (event.key === 'r' || event.key === 'R')) {
      this.setTransformMode('scale');
    }

    if (!hasModifier && event.key === 'Escape') {
      this.selectFrame(null);
    }

    if (!hasModifier && event.key === 'Delete' && this.selectedFrameId) {
      this.removeFrame(this.selectedFrameId);
    }
  }

  private copySelectedFrame(): void {
    if (!this.selectedFrameId) {
      return;
    }

    const frameEntity = this.frameEntities.get(this.selectedFrameId);
    if (!frameEntity) {
      return;
    }

    frameEntity.state.position.copy(frameEntity.object.position);
    frameEntity.state.rotation.copy(frameEntity.object.rotation);
    frameEntity.state.scale.copy(frameEntity.object.scale);

    this.frameClipboard = {
      type: frameEntity.state.type,
      radius: frameEntity.state.radius,
      width: frameEntity.state.width,
      height: frameEntity.state.height,
      boundarySamples: frameEntity.state.boundarySamples,
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

      const normalsInterval = this.isTransformDragging ? 1 : quality.normalsUpdateInterval;
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
    if (this.uiElements.transformModeSelect.value !== mode) {
      this.uiElements.transformModeSelect.value = mode;
    }
    this.transformControls.setMode(mode);
    this.transformControls.setSpace('local');
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
