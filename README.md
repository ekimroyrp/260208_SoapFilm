# 260208_SoapFilm

260208_SoapFilm is a Three.js-based interactive soap-film simulator inspired by Frei Otto style frame experiments. You can place circular and rectangular wire frames in a 3D scene, transform them, and observe a connected triangulated soap film that continuously relaxes toward a lower-area minimal-surface-like shape.

## Features

- Vite + TypeScript + Three.js app scaffold
- Add circle and rectangle frames from an in-app GUI
- Frame selection and 3D transform controls (move/rotate/scale)
- Connected film network generated from frame MST strip topology
- Continuous relaxation solver with fixed boundary constraints
- Reset simulation and explicit rebuild controls
- Transparent iridescent soap-film material using `MeshPhysicalMaterial`
- Optional wireframe debug overlay
- Unit and regression tests for sampling, MST, topology, and solver behavior

## Getting Started

1. Install dependencies:
   `npm install`
2. Start the dev server:
   `npm run dev`
   then open `http://127.0.0.1:6208`
3. Build for production:
   `npm run build`
4. Run tests:
   `npm run test`

## Controls

- GUI:
  - `Add Circle Frame`
  - `Add Rectangle Frame`
  - `Delete Selected Frame`
  - `Reset Simulation`
  - `Rebuild Film`
  - `Transform Mode` (`translate`, `rotate`, `scale`)
  - `Solver Quality` (`fast`, `balanced`, `high`)
  - `Show Wireframe`
- Mouse:
  - Left-click a frame to select it
  - Drag transform gizmo handles to move/rotate/scale
  - Orbit the camera with standard Three.js OrbitControls
- Keyboard:
  - `W` translate mode
  - `E` rotate mode
  - `R` scale mode
