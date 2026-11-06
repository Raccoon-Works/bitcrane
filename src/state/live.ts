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
 *
 * Only what the rest of the interface uses is exported here; the modules in
 * live/ share the rest among themselves.
 */
export { cachedList, cachedStat, invalidate, listingStatus, refreshVisible, requestListing } from './live/listing';
export {
  autoConnect,
  autoConnectPair,
  clearFailed,
  clockOffset,
  cloudAccount,
  collectSecrets,
  connectAs,
  connectNow,
  connectServer,
  davUrl,
  disconnectServer,
  forgetSecrets,
  hasStoredSecret,
  homeOf,
  installPublicKey,
  isConnected,
  isConnecting,
  isSftp,
  presetPassword,
  proxyAccount,
  restoreSecrets,
  submitSecret,
  testServer,
  trustAndConnect,
} from './live/connections';
export {
  changePerms,
  copyLocal,
  copyOnServer,
  copyShareLink,
  makeFile,
  makeFolder,
  moveInto,
  moveLocal,
  openLocal,
  openUrl,
  removeEntries,
  renameEntry,
  revealLocal,
  serverTrash,
  unzipLocal,
  walkFiles,
  zipLocal,
} from './live/fileOps';
export { editRemote, reopenEditing, stopEditing, uploadEditingNow } from './live/editing';
export {
  crossNames,
  downloadInstead,
  downloadNames,
  forcedLive,
  grep,
  localRel,
  moveAcross,
  remoteRel,
  uploadNames,
  uploadNativePaths,
} from './live/transfers';
export {
  copyLocalFiles,
  runCommandNow,
  runRemoteCommand,
  syncDeletes,
  syncWatch,
  testCommand,
  testRun,
} from './live/watches';
export { cloudPlaces, isConfigLoaded, quickConnect, saveNow } from './live/config';
export { startLive } from './live/start';
