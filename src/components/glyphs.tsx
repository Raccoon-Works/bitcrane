/**
 * The interface symbols of dialogs and smaller views, all from Phosphor (the
 * icon set of the main window since round 3). Each export keeps the name the
 * component had in Lucide, so the views did not have to be rewritten; the
 * Lucide-only prop `strokeWidth` picks the Phosphor weight (2 and more = bold).
 */
import {
  ArrowDown as PArrowDown, ArrowElbowDownLeft, ArrowElbowDownRight, ArrowElbowLeftUp, ArrowLeft as PArrowLeft, ArrowRight as PArrowRight,
  ArrowsDownUp, ArrowsLeftRight, ArrowUp as PArrowUp, Broadcast, CaretDown, CaretRight, CaretUp, Check as PCheck, CheckCircle, CircleHalf,
  CircleNotch, Clock as PClock, Cloud as PCloud, Copy as PCopy, Dot as PDot, DotsSixVertical, DotsThree, DownloadSimple, Eye as PEye, EyeSlash, Flask,
  FolderPlus as PFolderPlus, Gear, Info as PInfo, Key, Keyboard as PKeyboard, Lightning, LinkSimple, Lock as PLock, MagnifyingGlass, Pause as PPause,
  Play as PPlay, Plug, Plus as PPlus, Shield as PShield, ShieldCheck as PShieldCheck, ShieldWarning, SlidersHorizontal as PSliders, Star as PStar,
  TerminalWindow, Trash, UploadSimple, Warning, WifiSlash, X as PX, XCircle as PXCircle, type Icon,
} from '@phosphor-icons/react';
import type { CSSProperties } from 'react';

interface GlyphProps {
  size?: number;
  strokeWidth?: number;
  className?: string;
  style?: CSSProperties;
  color?: string;
  'aria-hidden'?: boolean | 'true' | 'false';
  'aria-label'?: string;
}

function wrap(P: Icon) {
  return function Glyph({ size = 16, strokeWidth = 1.75, ...rest }: GlyphProps) {
    return <P size={size} weight={strokeWidth >= 2 ? 'bold' : 'regular'} aria-hidden={rest['aria-label'] ? undefined : true} {...rest} />;
  };
}

export const AlertTriangle = wrap(Warning);
export const ArrowDown = wrap(PArrowDown);
export const ArrowLeft = wrap(PArrowLeft);
export const ArrowLeftRight = wrap(ArrowsLeftRight);
export const ArrowRight = wrap(PArrowRight);
export const ArrowUp = wrap(PArrowUp);
export const ArrowUpDown = wrap(ArrowsDownUp);
export const Check = wrap(PCheck);
export const CheckCircle2 = wrap(CheckCircle);
export const ChevronDown = wrap(CaretDown);
export const ChevronRight = wrap(CaretRight);
export const ChevronUp = wrap(CaretUp);
export const Clock = wrap(PClock);
export const Cloud = wrap(PCloud);
export const Copy = wrap(PCopy);
export const CornerDownLeft = wrap(ArrowElbowDownLeft);
export const CornerDownRight = wrap(ArrowElbowDownRight);
export const CornerLeftUp = wrap(ArrowElbowLeftUp);
export const Dot = wrap(PDot);
export const Download = wrap(DownloadSimple);
export const Eye = wrap(PEye);
export const EyeOff = wrap(EyeSlash);
export const FlaskConical = wrap(Flask);
export const FolderPlus = wrap(PFolderPlus);
export const GripVertical = wrap(DotsSixVertical);
export const Info = wrap(PInfo);
export const KeyRound = wrap(Key);
export const Keyboard = wrap(PKeyboard);
export const Link2 = wrap(LinkSimple);
export const Loader2 = wrap(CircleNotch);
export const Lock = wrap(PLock);
export const MoreHorizontal = wrap(DotsThree);
export const Pause = wrap(PPause);
export const Play = wrap(PPlay);
export const PlugZap = wrap(Plug);
export const Plus = wrap(PPlus);
export const Radio = wrap(Broadcast);
export const Search = wrap(MagnifyingGlass);
export const Settings = wrap(Gear);
export const Shield = wrap(PShield);
export const ShieldAlert = wrap(ShieldWarning);
export const ShieldCheck = wrap(PShieldCheck);
export const SlidersHorizontal = wrap(PSliders);
export const SquareTerminal = wrap(TerminalWindow);
export const Star = wrap(PStar);
export const SunMoon = wrap(CircleHalf);
export const Trash2 = wrap(Trash);
export const Upload = wrap(UploadSimple);
export const WifiOff = wrap(WifiSlash);
export const X = wrap(PX);
export const XCircle = wrap(PXCircle);
export const Zap = wrap(Lightning);
