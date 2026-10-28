/**
 * Backend implementation that calls the Rust core through Tauri commands.
 * Progress and watch events arrive as Tauri events and are routed to the
 * callbacks registered per transfer id or watch id.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Backend, WatchBatch } from './api';
import type { FileEntry } from './types';

const progressHandlers = new Map<string, (done: number, total: number) => void>();
const watchHandlers = new Map<string, (b: WatchBatch) => void>();
let listening = false;

async function ensureListeners() {
  if (listening) return;
  listening = true;
  await listen<{ id: string; done: number; total: number }>('transfer-progress', (e) => {
    progressHandlers.get(e.payload.id)?.(e.payload.done, e.payload.total);
  });
  await listen<WatchBatch>('watch-batch', (e) => {
    watchHandlers.get(e.payload.watchId)?.(e.payload);
  });
}

export const tauriBackend: Backend = {
  localList: (path) => invoke<FileEntry[]>('local_list', { path }),
  localStat: (path) => invoke<FileEntry>('local_stat', { path }),
  localMkdir: (path) => invoke('local_mkdir', { path }),
  localRename: (path, newName) => invoke('local_rename', { path, newName }),
  localTrash: (paths) => invoke('local_trash', { paths }),
  openUrl: (url) => invoke('open_url', { url }),
  localChecksum: (path) => invoke('local_checksum', { path }),
  remoteChecksum: (serverId, path) => invoke('remote_checksum', { serverId, path }),
  remoteSymlink: (serverId, link, target) => invoke('remote_symlink', { serverId, link, target }),
  localCopy: (paths, destDir, merge) => invoke('local_copy', { paths, destDir, merge: !!merge }),
  localMove: (paths, destDir, merge) => invoke('local_move', { paths, destDir, merge: !!merge }),
  localCopyFiles: (pairs) => invoke('local_copy_files', { pairs }),
  localWalk: (path) => invoke('local_walk', { path }),
  localPlaces: () => invoke('local_places'),
  localDrives: () => invoke('local_drives'),
  localCloudPlaces: () => invoke('local_cloud_places'),
  localOpen: (path, app) => invoke('local_open', { path, app: app || null }),
  editTempPath: (serverId, remotePath) => invoke('edit_temp_path', { serverId, remotePath }),
  localReveal: (path) => invoke('local_reveal', { path }),

  connect: (serverId, params) => invoke('ssh_connect', { serverId, params }),
  disconnect: (serverId) => invoke('ssh_disconnect', { serverId }),
  connectFtp: (serverId, params) => invoke('ftp_connect', { serverId, params }),
  connectDav: (serverId, params) => invoke('dav_connect', { serverId, params }),
  remoteList: (serverId, path) => invoke('remote_list', { serverId, path }),
  remoteStat: (serverId, path) => invoke('remote_stat', { serverId, path }),
  remoteMkdir: (serverId, path) => invoke('remote_mkdir', { serverId, path }),
  remoteRename: (serverId, path, newName) => invoke('remote_rename', { serverId, path, newName }),
  remoteRemove: (serverId, paths) => invoke('remote_remove', { serverId, paths }),
  remoteMove: (serverId, from, to) => invoke('remote_move', { serverId, from, to }),
  remoteCopy: (serverId, paths, destDir) => invoke('remote_copy', { serverId, paths, destDir }),
  remoteChmod: (serverId, path, perms, recursive) => invoke('remote_chmod', { serverId, path, perms, recursive }),
  remoteWalk: (serverId, path) => invoke('remote_walk', { serverId, path }),
  remoteExec: (serverId, command) => invoke('remote_exec', { serverId, command }),

  async upload(id, serverId, localPath, remotePath, options, onProgress) {
    await ensureListeners();
    progressHandlers.set(id, onProgress);
    try {
      return await invoke<number>('transfer_upload', { id, serverId, localPath, remotePath, options });
    } finally {
      progressHandlers.delete(id);
    }
  },
  async download(id, serverId, remotePath, localPath, options, onProgress) {
    await ensureListeners();
    progressHandlers.set(id, onProgress);
    try {
      return await invoke<number>('transfer_download', { id, serverId, remotePath, localPath, options });
    } finally {
      progressHandlers.delete(id);
    }
  },
  isConnected: (serverId) => invoke<boolean>('ssh_is_connected', { serverId }),
  async cross(id, fromServerId, fromPath, serverId, remotePath, options, onProgress) {
    await ensureListeners();
    progressHandlers.set(id, onProgress);
    try {
      return await invoke<number>('transfer_cross', { id, fromServerId, fromPath, serverId, remotePath, options });
    } finally {
      progressHandlers.delete(id);
    }
  },
  cancel: (id, discard) => invoke('transfer_cancel', { id, discard }),
  discardPartial: (serverId, direction, localPath, remotePath) => invoke('transfer_discard', { serverId, direction, localPath, remotePath }),

  async watchStart(watchId, localPath, recursive, excludes, delayMs, onBatch) {
    await ensureListeners();
    watchHandlers.set(watchId, onBatch);
    await invoke('watch_start', { watchId, localPath, recursive, excludes, delayMs });
  },
  async watchStop(watchId) {
    watchHandlers.delete(watchId);
    await invoke('watch_stop', { watchId });
  },

  configLoad: () => invoke('config_load'),
  configSave: (value) => invoke('config_save', { value }),
  secretGet: (account) => invoke('secret_get', { account }),
  secretSet: (account, value) => invoke('secret_set', { account, value }),
  secretDelete: (account) => invoke('secret_delete', { account }),
  sshConfigHosts: () => invoke('ssh_config_hosts'),
  importFind: () => invoke('import_find'),
  fileWrite: (path, text) => invoke('file_write', { path, text }),
  fileRead: (path) => invoke('file_read', { path }),

  localReadText: (path) => invoke('local_read_text', { path }),
  remoteReadText: (serverId, path) => invoke('remote_read_text', { serverId, path }),
  trayUpdate: (visible, status, paused, labels) => invoke('tray_update', { visible, status, paused, labels }),
  appQuit: () => invoke('app_quit'),

  localPreview: (path) => invoke('local_preview', { path }),
  remotePreview: (serverId, path) => invoke('remote_preview', { serverId, path }),
  keyInfo: (path) => invoke('key_info', { path }),
  keyGenerate: (path, comment, passphrase) => invoke('key_generate', { path, comment, passphrase: passphrase || null }),
  keyPublic: (path) => invoke('key_public', { path }),
  sshTest: (params) => invoke('ssh_test', { params }),
  knownHostsList: () => invoke('known_hosts_list'),
  knownHostsRemove: (host) => invoke('known_hosts_remove', { host }),
  logWrite: (lines) => invoke('log_write', { lines }),
  logPath: () => invoke('log_path'),
};
