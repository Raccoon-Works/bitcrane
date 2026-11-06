/**
 * Drag & drop between the two halves, built on pointer events.
 *
 * HTML5 drag & drop cannot be combined with dropping files from the Finder or
 * Explorer on Windows (the web view gets one or the other), so rows are
 * dragged with pointer events and files from outside arrive through Tauri's
 * native drop event (`startNativeDrop`).
 *
 * The current drop target lives in the store (`dropHint`) so both panes can
 * highlight it.
 */
import { showError } from '../state/errors';
import type { PaneSide } from '../backend/types';
import {
  getState,
  LIVE,
  panePath,
  paneLoc,
  paneOnServer,
  setState,
  showToast,
  upload,
  uploadLocalPaths,
  download,
  isOffline,
  activeTab,
  addPlace,
  addLocalPlace,
  moveIntoFolder,
  navigate,
  listEntries,
} from '../state/store';
import { invoke } from '@tauri-apps/api/core';
import { join } from './paths';
import { $t } from '../i18n';

const THRESHOLD = 5;
/** A folder held under a dragged item this long opens (spring-loaded folders, Finder). */
const SPRING_MS = 900;

interface DragState {
  side: PaneSide;
  /** Folder the dragged names belong to (the half may open another folder while dragging). */
  fromDir: string;
  names: string[];
  x: number;
  y: number;
  active: boolean;
  ghost: HTMLDivElement | null;
}

let drag: DragState | null = null;
/** Files handed to the system drag (to ignore them if they are dropped back into the window). */
let handedOut: { names: Set<string>; until: number } | null = null;
/** Server files copied to a temporary folder for dragging them out (started near the window edge). */
let prepared: { key: string; job: Promise<string[]> } | null = null;
/** Largest amount of server data copied for dragging out (more goes into the other half). */
const OUT_LIMIT = 100 * 1024 * 1024;
let spring: { key: string; timer: number } | null = null;

function clearSpring() {
  if (spring) window.clearTimeout(spring.timer);
  spring = null;
}

/** Starts or keeps the timer that opens the folder under the pointer. */
function armSpring(t: Target | null) {
  const key = t && t.name && !t.place && !t.addPlace ? `${t.side}|${t.name}` : '';
  if (spring?.key === key) return;
  clearSpring();
  if (!key || !t) return;
  spring = {
    key,
    timer: window.setTimeout(() => {
      spring = null;
      if (!drag?.active) return;
      navigate(t.side, join(panePath(t.side), t.name));
      // The folder now shown is the target until the pointer moves on (letting go right away drops into it).
      setState({ dropHint: { side: t.side, name: '' } });
    }, SPRING_MS),
  };
}

type Target = { side: PaneSide; name: string; place?: string; addPlace?: boolean; sidebar?: boolean };

/**
 * Drop target under a viewport point: side and folder name ('' = the folder
 * shown), a place in a half's places bar (its folder), or the empty part of
 * the places bar of the half a folder comes from (adds it as a place).
 */
function targetAt(x: number, y: number, from?: PaneSide, names: string[] = []): Target | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  // A folder of this computer dragged onto the sidebar's favourites becomes a favourite.
  if (el?.closest('[data-sidebar-favs]')) {
    const ok = !!from && names.length === 1 && paneLoc(from)[0] === 'local' && isDirName(from, names[0]);
    return ok && from ? { side: from, name: names[0], addPlace: true, sidebar: true } : null;
  }
  const pane = el?.closest<HTMLElement>('.pane[data-side]');
  if (!pane) return null;
  const side = pane.dataset.side as PaneSide;
  const place = el?.closest<HTMLElement>('[data-place-path]');
  if (place) return side === from ? null : { side, name: '', place: place.dataset.placePath };
  if (el?.closest('[data-places-bar]')) {
    // One folder dragged onto its own places bar becomes a place.
    const dir = names.length === 1 && side === from && isDirName(side, names[0]);
    return dir ? { side, name: names[0], addPlace: true } : null;
  }
  const row = el?.closest<HTMLElement>('[role="option"][data-dir="true"]');
  return { side, name: row?.dataset.name ?? '' };
}

function isDirName(side: PaneSide, name: string): boolean {
  return !!document.querySelector(
    `.pane[data-side="${side}"] [role="option"][data-dir="true"][data-name="${CSS.escape(name)}"]`,
  );
}

/** Folder a drop goes into. */
function dirOf(t: Target): string {
  if (t.place) return t.place;
  return t.name ? join(panePath(t.side), t.name) : panePath(t.side);
}

function setHint(hint: Target | null) {
  const cur = getState().dropHint;
  if (
    cur?.side === hint?.side &&
    cur?.name === hint?.name &&
    cur?.place === hint?.place &&
    cur?.addPlace === hint?.addPlace &&
    cur?.sidebar === hint?.sidebar
  )
    return;
  setState({ dropHint: hint });
}

function canDropOn(side: PaneSide): boolean {
  const t = activeTab();
  const [ls, sid] = paneLoc(side, t);
  return !!t && !(ls === 'remote' && isOffline(sid));
}

/** Server files that may be dragged out: only files, together at most OUT_LIMIT. */
function outEligible(d: DragState): string[] | null {
  const t = activeTab();
  const loc = paneLoc(d.side, t);
  if (loc[0] === 'local') return d.names.map((n) => join(d.fromDir, n));
  const list = listEntries(...loc, d.fromDir) ?? [];
  let total = 0;
  for (const n of d.names) {
    const e = list.find((x) => x.name === n);
    if (!e || e.kind !== 'file') return null;
    total += e.size;
  }
  return total <= OUT_LIMIT ? d.names.map((n) => join(d.fromDir, n)) : null;
}

/** Near the window edge: start copying server files, so they are ready when the pointer leaves. */
function prepareOut(d: DragState) {
  const t = activeTab();
  const loc = paneLoc(d.side, t);
  if (loc[0] === 'local' || !LIVE) return;
  const list = outEligible(d);
  const key = `${loc[1]}|${list?.join('|')}`;
  if (!list || prepared?.key === key) return;
  prepared = { key, job: invoke<string[]>('remote_drag_prepare', { serverId: loc[1], paths: list }) };
}

/**
 * The pointer left the window during a drag: hand the files to the system,
 * so they can be dropped into the Finder, the Explorer or another program.
 */
async function handOut(d: DragState) {
  const t = activeTab();
  const loc = paneLoc(d.side, t);
  const list = outEligible(d);
  if (!list) {
    showToast(
      $t('Ordner und große Dateien vom Server bitte in die andere Hälfte ziehen; dort werden sie heruntergeladen.'),
    );
    return;
  }
  if (!LIVE) {
    showToast(
      d.names.length === 1
        ? $t('„{0}“ in den Finder gezogen (Prototyp).', d.names[0])
        : $t('{0} Objekte herausgezogen (Prototyp).', d.names.length),
    );
    return;
  }
  try {
    let files = list;
    if (loc[0] === 'remote') {
      prepareOut(d);
      files = (await prepared?.job) ?? [];
    }
    handedOut = { names: new Set(files.map((f) => f.split(/[\\/]/).pop() ?? '')), until: Date.now() + 120000 };
    await invoke('drag_out', { paths: files });
  } catch (e) {
    showError(e);
  } finally {
    prepared = null;
  }
}

function onMove(e: PointerEvent) {
  if (!drag) return;
  // Outside the window: the system takes over the drag (the web view keeps getting moves while the button is held).
  if (
    drag.active &&
    (e.clientX < 0 || e.clientY < 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight)
  ) {
    const d = drag;
    finish(e, true);
    void handOut(d);
    return;
  }
  if (
    drag.active &&
    (e.clientX < 40 || e.clientY < 40 || e.clientX > window.innerWidth - 40 || e.clientY > window.innerHeight - 40)
  )
    prepareOut(drag);
  if (!drag.active) {
    if (Math.abs(e.clientX - drag.x) < THRESHOLD && Math.abs(e.clientY - drag.y) < THRESHOLD) return;
    drag.active = true;
    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.textContent = drag.names.length === 1 ? drag.names[0] : $t('{0} Objekte', drag.names.length);
    document.body.appendChild(ghost);
    drag.ghost = ghost;
    document.body.classList.add('is-dragging');
  }
  if (drag.ghost) drag.ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 8}px)`;
  const t = targetAt(e.clientX, e.clientY, drag.side, drag.names);
  // In the same half only a folder that is not part of the drag is a target (moves it there).
  // After a spring-loaded folder opened, the empty part of the list is a target too.
  const sameOk =
    !!t &&
    t.side === drag.side &&
    !t.place &&
    canDropOn(t.side) &&
    (t.name ? !(panePath(t.side) === drag.fromDir && drag.names.includes(t.name)) : panePath(t.side) !== drag.fromDir);
  const ok = t && (t.addPlace || (t.side !== drag.side && canDropOn(t.side)) || sameOk) ? t : null;
  setHint(ok);
  armSpring(ok && !ok.addPlace ? ok : null);
}

function finish(e: PointerEvent, cancel: boolean) {
  const d = drag;
  drag = null;
  window.removeEventListener('pointermove', onMove, true);
  window.removeEventListener('pointerup', onUp, true);
  window.removeEventListener('keydown', onKey, true);
  d?.ghost?.remove();
  clearSpring();
  document.body.classList.remove('is-dragging');
  const hint = getState().dropHint;
  setHint(null);
  if (!d?.active || cancel || !hint) return;
  e.preventDefault();
  if (hint.addPlace) {
    if (hint.sidebar) addLocalPlace(join(panePath(hint.side), hint.name));
    else addPlace(hint.side, join(panePath(hint.side), hint.name));
    return;
  }
  const dir = dirOf(hint);
  if (hint.side === d.side) {
    moveIntoFolder(hint.side, d.names, dir, d.fromDir);
    return;
  }
  if (hint.side === 'remote') upload(d.names, dir, d.fromDir);
  else download(d.names, dir, d.fromDir);
}

function onUp(e: PointerEvent) {
  finish(e, false);
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && drag) {
    e.stopPropagation();
    finish(new PointerEvent('pointerup'), true);
  }
}

/** Called on pointerdown on a row; becomes a drag once the pointer moves. */
export function beginRowDrag(e: React.PointerEvent, side: PaneSide, names: string[]) {
  if (e.button !== 0 || drag) return;
  drag = { side, fromDir: panePath(side), names, x: e.clientX, y: e.clientY, active: false, ghost: null };
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('keydown', onKey, true);
}

/** Files dragged in from the Finder / Explorer (desktop app only). */
export async function startNativeDrop() {
  if (!LIVE) return;
  const { getCurrentWebview } = await import('@tauri-apps/api/webview');
  await getCurrentWebview().onDragDropEvent((ev) => {
    const p = ev.payload;
    if (p.type === 'leave') {
      setHint(null);
      return;
    }
    const ratio = window.devicePixelRatio || 1;
    const x = p.position.x / ratio;
    const y = p.position.y / ratio;
    const t = targetAt(x, y);
    if (p.type === 'over' || p.type === 'enter') {
      setHint(t && !t.addPlace && paneOnServer(t.side) && canDropOn(t.side) ? t : null);
      return;
    }
    // Drop.
    setHint(null);
    if (!t || t.addPlace) return;
    // Files just dragged out of Bitcrane and dropped back in: nothing to do.
    if (
      handedOut &&
      Date.now() < handedOut.until &&
      p.paths.every((x) => handedOut?.names.has(x.split(/[\\/]/).pop() ?? ''))
    )
      return;
    if (!paneOnServer(t.side)) {
      showToast($t('Zum Hochladen die Dateien auf die Server-Seite ziehen.'));
      return;
    }
    uploadLocalPaths(p.paths, dirOf(t), t.side);
  });
}
