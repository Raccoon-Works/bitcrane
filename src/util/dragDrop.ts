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
import type { PaneSide } from '../backend/types';
import { getState, LIVE, panePath, paneLoc, paneOnServer, setState, showToast, upload, uploadLocalPaths, download, isOffline, activeTab, addPlace, addLocalPlace } from '../state/store';
import { join } from './paths';
import { $t } from '../i18n';

const THRESHOLD = 5;

interface DragState {
  side: PaneSide;
  names: string[];
  x: number;
  y: number;
  active: boolean;
  ghost: HTMLDivElement | null;
}

let drag: DragState | null = null;

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
  return !!document.querySelector(`.pane[data-side="${side}"] [role="option"][data-dir="true"][data-name="${CSS.escape(name)}"]`);
}

/** Folder a drop goes into. */
function dirOf(t: Target): string {
  if (t.place) return t.place;
  return t.name ? join(panePath(t.side), t.name) : panePath(t.side);
}

function setHint(hint: Target | null) {
  const cur = getState().dropHint;
  if (cur?.side === hint?.side && cur?.name === hint?.name && cur?.place === hint?.place && cur?.addPlace === hint?.addPlace && cur?.sidebar === hint?.sidebar) return;
  setState({ dropHint: hint });
}

function canDropOn(side: PaneSide): boolean {
  const t = activeTab();
  const [ls, sid] = paneLoc(side, t);
  return !!t && !(ls === 'remote' && isOffline(sid));
}

function onMove(e: PointerEvent) {
  if (!drag) return;
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
  setHint(t && (t.addPlace || (t.side !== drag.side && canDropOn(t.side))) ? t : null);
}

function finish(e: PointerEvent, cancel: boolean) {
  const d = drag;
  drag = null;
  window.removeEventListener('pointermove', onMove, true);
  window.removeEventListener('pointerup', onUp, true);
  window.removeEventListener('keydown', onKey, true);
  d?.ghost?.remove();
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
  if (hint.side === 'remote') upload(d.names, dir);
  else download(d.names, dir);
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
  drag = { side, names, x: e.clientX, y: e.clientY, active: false, ghost: null };
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
    if (!paneOnServer(t.side)) {
      showToast($t('Zum Hochladen die Dateien auf die Server-Seite ziehen.'));
      return;
    }
    uploadLocalPaths(p.paths, dirOf(t), t.side);
  });
}
