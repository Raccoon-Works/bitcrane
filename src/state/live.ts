/**
 * Live mode: connects the store to the real backend (Rust core via Tauri).
 *
 * The browser prototype keeps using the synchronous mock file systems. In the
 * app, the store delegates to the functions in this module, which
 * - cache directory listings and reload them when a pane shows a new folder,
 * - open SSH sessions (host key check, passphrase and password prompts),
 * - run the transfer queue against the backend with real progress,
 * - start and stop folder watchers and turn their events into uploads,
 * - persist servers, watches and settings in the app's config file.
 */
export * from './live/listing';
export * from './live/connections';
export * from './live/fileOps';
export * from './live/editing';
export * from './live/transfers';
export * from './live/watches';
export * from './live/config';
export * from './live/start';
