import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 6208,
    strictPort: true,
  },
  build: {
    chunkSizeWarningLimit: 560,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/three/examples/jsm/')) {
            return 'three-extras';
          }
          if (id.includes('node_modules/three/')) {
            return 'three-core';
          }
          if (id.includes('node_modules/lil-gui')) {
            return 'ui-controls';
          }
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
