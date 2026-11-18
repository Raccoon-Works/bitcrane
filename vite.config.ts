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
 *
 * `__BITCRANE_LIVE__` tells the interface at build time whether it is the app or the demo (see
 * `LIVE` in src/state/core.ts): the app's build is "true", so the minifier drops the demo data
 * and the simulation; the demo's single-file build is "false", so its `LIVE` branches are never
 * taken, but the app's modules stay in it, as they are imported statically. The development server serves
 * both the browser demo (`npm run dev`) and `npm run tauri dev`, so there it stays open
 * ("undefined") and the interface asks at run time.
 */
export default defineConfig(({ command, mode }) => ({
  define: {
    __BITCRANE_LIVE__: command === 'build' ? String(mode !== 'single') : 'undefined',
  },
  plugins: mode === 'single' ? [react(), viteSingleFile()] : [react()],
  build: {
    outDir: mode === 'single' ? 'dist-single' : 'dist',
    // Rollup keeps every branch inside a try block by default (for feature checks that rely on a
    // built-in throwing), and many of the interface's `LIVE` branches are inside one. The setting
    // applies to the whole bundle, dependencies included: such a feature check there could be
    // removed as unused. The interface's own code has none.
    rollupOptions: { treeshake: { tryCatchDeoptimization: false } },
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
