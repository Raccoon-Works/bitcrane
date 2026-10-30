/**
 * Git in folders of this computer (after ForkLift): which files of a working
 * copy changed, the branch with commits to push or pull, and the everyday
 * commands. The state comes from the installed git (src-tauri/src/git.rs);
 * outside a repository, on servers and without git nothing is shown.
 */
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';
import { $t } from '../i18n';
import { addLog } from './log';
import { LIVE, showToast, subscribeStore, getState } from './store';

export interface GitStatus {
  root: string;
  branch: string;
  ahead: number;
  behind: number;
  /** Path relative to root → M, A, D, R, ? or U. */
  files: Record<string, string>;
}

const cache = new Map<string, GitStatus | null>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/** Reads the state of a folder again (after file actions, a commit, a pull …). */
export async function refreshGit(dir: string) {
  if (!LIVE || !dir) return;
  const st = await invoke<GitStatus | null>('git_status', { dir }).catch(() => null);
  const before = JSON.stringify(cache.get(dir) ?? null);
  cache.set(dir, st);
  if (JSON.stringify(st) !== before) notify();
}

/** Git state for a local folder; refreshed when the folder's listing changes. */
export function useGit(dir: string, enabled: boolean): GitStatus | null {
  const [, setTick] = useState(0);
  const fsRev = getState().fsRev;
  useEffect(() => {
    const l = () => setTick((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  useEffect(() => {
    if (enabled && dir) void refreshGit(dir);
  }, [dir, enabled, fsRev]);
  return enabled ? cache.get(dir) ?? null : null;
}

// File actions bump fsRev; the visible git folders follow (at most every 1.5 s).
let pending = 0;
subscribeStore(() => {
  if (pending || !LIVE || !cache.size) return;
  pending = window.setTimeout(() => {
    pending = 0;
    for (const dir of cache.keys()) void refreshGit(dir);
  }, 1500);
});

/** Letter for an entry of `dir`: its own state, or "•" for a folder with changes inside. */
export function gitMark(st: GitStatus | null, dir: string, name: string, isDir: boolean): string | null {
  if (!st) return null;
  const full = `${dir.replace(/\/$/, '')}/${name}`;
  if (!full.startsWith(`${st.root}/`)) return null;
  const rel = full.slice(st.root.length + 1);
  if (st.files[rel]) return st.files[rel];
  if (isDir) {
    const prefix = `${rel}/`;
    if (Object.keys(st.files).some((k) => k.startsWith(prefix))) return '•';
  }
  return null;
}

export const GIT_LABEL: Record<string, string> = {
  M: $t('geändert'), A: $t('hinzugefügt'), D: $t('gelöscht'), R: $t('umbenannt'), '?': $t('neu, nicht in Git'), U: $t('Konflikt'), '•': $t('enthält Änderungen'),
};

/** Runs add, addAll, commit, pull or push and reports the outcome. */
export async function gitRun(root: string, what: 'add' | 'addAll' | 'commit' | 'pull' | 'push', opts: { paths?: string[]; message?: string; all?: boolean } = {}) {
  if (!LIVE) {
    showToast($t('Git geht im echten Programm.'));
    return false;
  }
  const label = { add: $t('Hinzufügen'), addAll: $t('Alles hinzufügen'), commit: $t('Commit'), pull: 'Pull', push: 'Push' }[what];
  try {
    const out = await invoke<string>('git_action', { root, what, paths: opts.paths ?? [], message: opts.message ?? '', all: !!opts.all });
    addLog('ok', `Git ${label}: ${out.split('\n').filter(Boolean).slice(-1)[0] ?? $t('fertig')}`);
    showToast($t('Git: {0} erledigt.', label), 'ok');
    return true;
  } catch (e) {
    const err = e as { message?: string; detail?: string };
    addLog('error', `Git ${label}: ${err.detail ?? err.message ?? String(e)}`);
    showToast(err.message ?? String(e), 'error');
    return false;
  } finally {
    for (const dir of cache.keys()) void refreshGit(dir);
  }
}

/** Last known state of a folder (for menus). */
export function gitFor(dir: string): GitStatus | null {
  return cache.get(dir) ?? null;
}
