/**
 * Colours a server can be marked with: the tile colours per design and the
 * swatches of the colour picker.
 */
import type { ServerColor, Theme } from '../backend/types';

export const serverColors: Record<ServerColor, Record<Theme, { bg: string; fg: string }>> = {
  blue: { dark: { bg: '#2B4A7A', fg: '#CFE0FF' }, light: { bg: '#DCE7FB', fg: '#1D4E9E' } },
  purple: { dark: { bg: '#4A3A6E', fg: '#E2D6FF' }, light: { bg: '#E9E1FA', fg: '#5B3A9E' } },
  green: { dark: { bg: '#3D4A3A', fg: '#D3E6CF' }, light: { bg: '#E2EDDF', fg: '#3A6A33' } },
  yellow: { dark: { bg: '#4D4232', fg: '#F0DFC3' }, light: { bg: '#F3E9DA', fg: '#7A5A26' } },
  orange: { dark: { bg: '#5A3A22', fg: '#FFD9BC' }, light: { bg: '#FBE4D3', fg: '#8A4515' } },
  red: { dark: { bg: '#5C2A2A', fg: '#FFD2CF' }, light: { bg: '#FADBD9', fg: '#8E1F1A' } },
  gray: { dark: { bg: '#3A3A3F', fg: '#E4E4E8' }, light: { bg: '#E4E4E8', fg: '#3A3A3F' } },
};

/** Swatch colours for the colour picker in the server dialog. */
export const swatch: Record<ServerColor, string> = {
  blue: '#2A6DE0', purple: '#AF52DE', green: '#30D158', yellow: '#FFCC00', orange: '#FF9F0A', red: '#FF453A', gray: '#8E8E93',
};
