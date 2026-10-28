/**
 * The prototype renders the app window on a "stage" that may be scaled down
 * on small screens. Overlays such as menus are positioned in stage
 * coordinates, so mouse positions have to be converted first.
 */
export const STAGE_ID = 'bitcrane-stage';

export function stagePoint(clientX: number, clientY: number): { x: number; y: number; w: number; h: number } {
  const el = document.getElementById(STAGE_ID);
  if (!el) return { x: clientX, y: clientY, w: window.innerWidth, h: window.innerHeight };
  const rect = el.getBoundingClientRect();
  const scale = Number(el.dataset.scale || '1');
  return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale, w: rect.width / scale, h: rect.height / scale };
}
