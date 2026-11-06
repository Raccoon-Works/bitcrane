/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * Vite configuration.
 *
 * - Default mode: regular build used later by Tauri (assets as separate files).
 * - "single" mode: bundles everything into one self-contained index.html so the
 *   clickable browser prototype can be published and opened without a server.
 * - `test`: Vitest runs the unit tests (`*.test.ts` next to the code).
 */
export default defineConfig(({ mode }) => ({
  plugins: mode === 'single' ? [react(), viteSingleFile()] : [react()],
  build: {
    outDir: mode === 'single' ? 'dist-single' : 'dist',
  },
  // Tauri expects a fixed port during development.
  server: { port: 1420, strictPort: true },
  clearScreen: false,
  test: {
    // The interface modules read browser globals (location, localStorage, navigator) when they
    // load. happy-dom provides them; its navigator reports "en-US", so the tests see English texts.
    environment: 'happy-dom',
  },
}));
