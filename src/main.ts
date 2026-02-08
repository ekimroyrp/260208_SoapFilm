import './style.css';
import { createSoapFilmApp } from './app/createSoapFilmApp';

const canvas = document.querySelector<HTMLCanvasElement>('#app-canvas');
if (!canvas) {
  throw new Error('Canvas element #app-canvas was not found.');
}

const app = createSoapFilmApp(canvas);

// Exposed for debugging in the browser console.
Object.assign(window, { soapFilmApp: app });
