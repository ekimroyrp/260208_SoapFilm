# 260208_SoapFilm

260208_SoapFilm is a Three.js-based interactive soap-film simulator inspired by Frei Otto frame experiments. You can place and edit circle, square, rectangle, and triangle frames in 3D, then observe a connected triangulated soap film that relaxes in real time using a configurable solver and iridescent transparent rendering.

## Features

- Vite + TypeScript + Three.js application scaffolded for fast local iteration.
- Custom draggable/collapsible in-canvas UI panel for frame creation and solver tuning.
- Frame types: `Circle`, `Square`, `Rectangle`, and `Triangle`.
- Rhino-style combined transform gizmo with move arrows, rotate arcs, per-axis scale handles, and uniform center scale handle.
- Frame point-edit mode on double-click with per-frame control points for non-planar frame deformation.
- Copy/paste selected frames (`Ctrl/Cmd+C`, `Ctrl/Cmd+V`) and delete selected frames (`Delete`).
- Connected soap film topology generated from frame boundary sampling and MST strip linking.
- Continuous relaxation solver with boundary constraints and live controls for `Quality`, `Speed`, `Strength`, `Retention`, and `Stiffness`.
- Reset action that rebuilds/restarts the solver from the current frame layout.
- Transparent iridescent film material (`MeshPhysicalMaterial`) plus a lightweight animated oily-rainbow shader enhancement.
- Optional wireframe overlay for debugging mesh flow.
- Automated tests for frame sampling, MST generation, film topology, and solver regression behavior.

## Getting Started

1. `npm install`
2. `npm run dev` to start Vite on `http://127.0.0.1:6208`
3. `npm run test` to run the solver/topology test suite
4. `npm run build` to emit a production build and type-check through `tsc -b`

## Controls

- UI panel:
  - `Add Circle`
  - `Add Square`
  - `Add Rectangle`
  - `Add Triangle`
  - `Quality` (`Fast`, `Balanced`, `High`)
  - `Speed` (solver update speed scale)
  - `Strength` (overall relaxation force scale)
  - `Retention` (spring toward initial film shape to resist collapse)
  - `Stiffness` (edge-length spring stiffness; higher values keep bridges tighter over longer spans)
  - `Wireframe` (toggle wire overlay)
  - `Reset` (rebuild/restart the film from the current frame layout)
- Mouse:
  - Left-click selects a frame
  - Left-click empty space deselects the current frame
  - Double-click a selected frame to toggle point edit mode
  - In point edit mode, click a control point and drag its gizmo to deform the frame in 3D
  - Middle mouse button pans the camera
  - Right mouse button orbits the camera
  - Mouse wheel zooms
  - Drag transform gizmo handles to move/rotate/scale
- Keyboard:
  - `Ctrl+C` copy selected frame (`Cmd+C` on macOS)
  - `Ctrl+V` paste copied frame (`Cmd+V` on macOS)
  - `Delete` remove selected frame
  - `Escape` exits point edit mode (if active), otherwise deselects current frame

## Deployment

- **Local production preview:** `npm install`, then `npm run build` followed by `npm run preview` to inspect the compiled bundle.
- **Publish to GitHub Pages:** From a clean `main`, run `npm run build -- --base=./`. Checkout (or create) the `gh-pages` branch in a separate worktree/clone, copy everything inside `dist/` plus a `.nojekyll` marker to its root (and keep the flat deploy structure with `assets/`, `env/`, and `index.html`), commit with a descriptive message, `git push origin gh-pages`, then switch back to `main`.
- **Live demo:** https://ekimroyrp.github.io/260208_SoapFilm/
