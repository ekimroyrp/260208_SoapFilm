# 260208_SoapFilm

260208_SoapFilm is a Three.js-based interactive soap-film simulator inspired by Frei Otto style frame experiments. You can place circular and rectangular wire frames in a 3D scene, transform them, and observe a connected triangulated soap film that continuously relaxes toward a lower-area minimal-surface-like shape.

## Features

- Vite + TypeScript + Three.js app scaffold
- Add circle and rectangle frames from a custom draggable/collapsible in-app control panel
- Frame selection and 3D transform controls (move/rotate/scale)
- Connected film network generated from frame MST strip topology
- Continuous relaxation solver with fixed boundary constraints
- Solver controls for quality, speed, strength, and retention
- Reset control for rebuilding the film from the current frame layout
- Transparent iridescent soap-film material using `MeshPhysicalMaterial` with a lightweight oily-rainbow enhancement
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

- UI panel:
  - `Add Circle`
  - `Add Rectangle`
  - `Mode` (`Gumball` combined Move/Rotate/Scale)
  - `Wireframe`
  - `Quality` (`Fast`, `Balanced`, `High`)
  - `Speed` (solver update speed scale)
  - `Strength` (overall relaxation force scale)
  - `Retention` (spring toward initial film shape to resist collapse)
  - `Reset` (rebuild/restart the film from the current frame layout)
- Mouse:
  - Left-click selects a frame
  - Left-click empty space deselects the current frame
  - Middle mouse button pans the camera
  - Right mouse button orbits the camera
  - Mouse wheel zooms
  - Drag transform gizmo handles to move/rotate/scale
- Keyboard:
  - `Ctrl+C` copy selected frame (`Cmd+C` on macOS)
  - `Ctrl+V` paste copied frame (`Cmd+V` on macOS)
  - `Delete` remove selected frame
  - `Escape` deselect current frame
