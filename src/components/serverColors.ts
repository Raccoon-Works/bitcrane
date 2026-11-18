/** Colours a server can be marked with; they show as a dot on its symbol and tint its half. */
import type { ServerColor, ServerColorKey } from '../backend/types';

/** One colour per key, also shown as the swatches of the colour picker in the server dialog. */
export const swatch: Record<ServerColorKey, string> = {
  blue: '#2A6DE0',
  purple: '#AF52DE',
  green: '#30D158',
  yellow: '#FFCC00',
  orange: '#FF9F0A',
  red: '#FF453A',
  gray: '#8E8E93',
};

/** An own colour as the system colour picker reports it. */
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Whether a server colour is an own colour ("#rrggbb") rather than one of the fixed keys. */
export function isOwnColor(color: ServerColor): color is `#${string}` {
  return color.startsWith('#');
}

/**
 * CSS colour of a server's colour, or undefined when it has none ("gray"), so
 * callers show no dot and no tint. Own colours are used as they are.
 */
export function serverColorCss(color: ServerColor | undefined): string | undefined {
  if (!color || color === 'gray') return undefined;
  return isOwnColor(color) ? color : swatch[color];
}

/**
 * Checks a value from the colour input before it becomes a server colour; the
 * input reports "#rrggbb", stored in lower case so equal colours compare equal.
 */
export function ownColorFromInput(value: string): ServerColor | null {
  return HEX_COLOR.test(value) ? (value.toLowerCase() as `#${string}`) : null;
}
