/**
 * Application state for the Bitcrane user interface, in one import.
 *
 * The store (core.ts) is a small external store (subscribe/getSnapshot)
 * consumed through `useStore`; the user actions live in one module per area
 * and are exported from here. In the browser prototype the actions work on
 * the demo file systems (backend/mockFs.ts, simulation.ts); in the app
 * (`LIVE`) they delegate to live.ts, which calls the Rust core.
 */
export * from './core';
export * from './tabs';
export * from './places';
export * from './undo';
export * from './selection';
export * from './panels';
export * from './fileOps';
export * from './transfers';
export * from './watches';
export * from './servers';
export * from './settings';
export * from './simulation';
