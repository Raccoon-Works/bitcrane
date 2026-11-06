/**
 * Server files opened in an editor: downloaded to a temporary copy and uploaded
 * again when it is saved.
 */
import { tauriBackend as backend } from '../../backend/tauriBackend';
import { setState, uid, showToast, getState } from '../core';
import { editorFor } from '../fileOps';
import { showError } from '../errors';
import { addLog } from '../log';
import { $t } from '../../i18n';
import { basename, parent, relFolder } from '../../util/paths';
import { toBackendError } from '../../backend/api';
import { handleRemoteError } from './connections';
import { enqueue } from '../transfers';
import { type Transfer } from '../../backend/types';

interface EditSession {
  serverId: string;
  remotePath: string;
  localPath: string;
  /** Server modification time of the version the editor has. */
  remoteMtime: number;
  /** Ignore file events until then (our own download wrote the file). */
  quietUntil: number;
  /** Saved again while an upload was running: upload once more afterwards. */
  dirty?: boolean;
  watchId: string;
}

/** Mirrors the open working copies into the store ("Bearbeitete Dateien"). */
function publishEdits(patch?: { localPath: string; lastUpload: number }) {
  setState((st) => ({
    edits: [...editSessions.values()].map((e) => {
      const prev = st.edits.find((x) => x.localPath === e.localPath);
      return {
        localPath: e.localPath,
        serverId: e.serverId,
        remotePath: e.remotePath,
        openedAt: prev?.openedAt ?? Date.now(),
        lastUpload: patch?.localPath === e.localPath ? patch.lastUpload : prev?.lastUpload,
      };
    }),
  }));
}

/** Stops uploading a working copy when it is saved (the file stays). */
export async function stopEditing(localPath: string) {
  const e = editSessions.get(localPath);
  if (!e) return;
  editSessions.delete(localPath);
  await backend.watchStop(e.watchId).catch(() => undefined);
  publishEdits();
}

/** Opens a working copy in the editor again. */
export function reopenEditing(localPath: string) {
  backend.localOpen(localPath, editorFor(localPath)).catch((e) => showError(e));
}

/** Uploads a working copy now, without waiting for the next save. */
export function uploadEditingNow(localPath: string) {
  const e = editSessions.get(localPath);
  if (!e) return;
  e.quietUntil = 0;
  uploadEdited(localPath);
}

/** Open working copies, by local path. */
const editSessions = new Map<string, EditSession>();

/**
 * Downloads a server file into a working folder, opens it in the editor and
 * uploads it again every time it is saved.
 */
export async function editRemote(serverId: string, remotePath: string, app?: string) {
  try {
    const localPath = await backend.editTempPath(serverId, remotePath);
    const st = await backend.remoteStat(serverId, remotePath);
    const known = editSessions.get(localPath);
    if (known) known.quietUntil = Date.now() + 2000;
    await backend.download(
      uid('edit'),
      serverId,
      remotePath,
      localPath,
      { keepMtime: true, resume: false },
      () => undefined,
    );
    const watchId = known?.watchId ?? `edit-${uid('w')}`;
    editSessions.set(localPath, {
      serverId,
      remotePath,
      localPath,
      remoteMtime: st.mtime,
      quietUntil: Date.now() + 1500,
      watchId,
    });
    if (!known) {
      // One watcher per working copy; it reports each save of the editor.
      await backend.watchStart(watchId, parent(localPath), false, [], 400, (b) => {
        if (b.changed.includes(localPath)) uploadEdited(localPath);
      });
    }
    publishEdits();
    backend.localOpen(localPath, app ?? editorFor(localPath)).catch((e) => showError(e));
    addLog('info', $t('Im Editor geöffnet: {0}', remotePath), serverId);
    showToast(
      $t('„{0}“ ist im Editor geöffnet. Beim Sichern lädt Bitcrane die Datei wieder hoch.', basename(remotePath)),
    );
  } catch (e) {
    const err = toBackendError(e);
    handleRemoteError(serverId, err);
    showError(err);
  }
}

function uploadEdited(localPath: string) {
  const s = editSessions.get(localPath);
  if (!s || Date.now() < s.quietUntil) return;
  const pending = getState().transfers.filter(
    (x) => x.source === localPath && (x.state === 'queued' || x.state === 'running'),
  );
  // A queued upload reads the file when it starts, so it carries this save too.
  if (pending.some((x) => x.state === 'queued')) return;
  if (pending.length) {
    s.dirty = true;
    return;
  }
  backend
    .localStat(localPath)
    .then((st) => {
      addLog('info', $t('Im Editor gesichert: {0}', s.remotePath), s.serverId);
      enqueue([
        {
          id: uid('t'),
          name: basename(s.remotePath),
          direction: 'up',
          serverId: s.serverId,
          folder: relFolder(parent(s.remotePath), s.remotePath),
          source: localPath,
          target: s.remotePath,
          size: st.size,
          done: 0,
          state: 'queued',
          editMtime: s.remoteMtime,
        },
      ]);
    })
    .catch(() => undefined);
}

/** After an edited file went up: remember the new server time for the next save. */
export function editUploaded(tr: Transfer) {
  const s = editSessions.get(tr.source);
  if (!s) return;
  publishEdits({ localPath: s.localPath, lastUpload: Date.now() });
  backend
    .remoteStat(tr.serverId, tr.target)
    .then((st) => {
      s.remoteMtime = st.mtime;
    })
    .catch(() => undefined)
    .finally(() => {
      if (!s.dirty) return;
      s.dirty = false;
      uploadEdited(s.localPath);
    });
}
