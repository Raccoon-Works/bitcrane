/** Colours a server can be marked with; they tint its tile, tab and half. */
import type { ServerColor } from '../backend/types';

/** One colour per key, also shown as the swatches of the colour picker in the server dialog. */
export const swatch: Record<ServerColor, string> = {
  blue: '#2A6DE0',
  purple: '#AF52DE',
  green: '#30D158',
  yellow: '#FFCC00',
  orange: '#FF9F0A',
  red: '#FF453A',
  gray: '#8E8E93',
};
