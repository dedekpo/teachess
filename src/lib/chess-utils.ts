import type { Color, PieceSymbol, Square } from "chess.js";

export const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
export const RANKS = ["1", "2", "3", "4", "5", "6", "7", "8"] as const;

export type SquareHighlightColor = "red" | "green" | "blue" | "yellow";
export type ArrowColor =
  | "orange"
  | "green"
  | "blue"
  | "red"
  | "engine"
  | "coach"
  | "coachDim"
  | "capture"
  | "captureDim"
  | "check"
  | "checkDim";

export interface Arrow {
  from: Square;
  to: Square;
  color: ArrowColor;
}

export interface DisplayPos {
  col: number; // 0 = leftmost column on screen
  row: number; // 0 = topmost row on screen
}

export function fileIndex(sq: Square): number {
  return sq.charCodeAt(0) - 97;
}

export function rankIndex(sq: Square): number {
  return Number(sq[1]) - 1;
}

export function makeSquare(file: number, rank: number): Square {
  return `${FILES[file]}${RANKS[rank]}` as Square;
}

/** Board-relative square -> screen position, honoring orientation. */
export function toDisplay(sq: Square, flipped: boolean): DisplayPos {
  const f = fileIndex(sq);
  const r = rankIndex(sq);
  return flipped ? { col: 7 - f, row: r } : { col: f, row: 7 - r };
}

/** Screen position -> square, honoring orientation. */
export function fromDisplay(col: number, row: number, flipped: boolean): Square {
  return flipped ? makeSquare(7 - col, row) : makeSquare(col, 7 - row);
}

export function isLightSquare(sq: Square): boolean {
  return (fileIndex(sq) + rankIndex(sq)) % 2 === 1;
}

export function pieceImage(color: Color, type: PieceSymbol): string {
  return `/pieces/${color}${type.toUpperCase()}.svg`;
}

export const HIGHLIGHT_RGBA: Record<SquareHighlightColor, string> = {
  red: "rgba(235, 97, 80, 0.8)",
  green: "rgba(172, 206, 89, 0.8)",
  blue: "rgba(82, 176, 220, 0.8)",
  yellow: "rgba(255, 170, 0, 0.8)",
};

export const ARROW_RGBA: Record<ArrowColor, string> = {
  orange: "rgba(255, 170, 0, 0.85)",
  green: "rgba(172, 206, 89, 0.85)",
  blue: "rgba(82, 176, 220, 0.85)",
  red: "rgba(235, 97, 80, 0.85)",
  engine: "rgba(38, 140, 220, 0.9)",
  coach: "rgba(155, 89, 182, 0.9)",
  coachDim: "rgba(155, 89, 182, 0.35)",
  capture: "rgba(235, 97, 80, 0.9)",
  captureDim: "rgba(235, 97, 80, 0.35)",
  check: "rgba(255, 40, 40, 0.95)",
  checkDim: "rgba(255, 40, 40, 0.35)",
};

/** Coach highlight: the square being talked about right now vs. the ones mentioned just before. */
export type CoachLevel = "focus" | "dim";
export interface CoachSquare {
  square: Square;
  level: CoachLevel;
}
export const COACH_SQUARE_RGBA: Record<CoachLevel, string> = {
  focus: "rgba(155, 89, 182, 0.6)",
  dim: "rgba(155, 89, 182, 0.28)",
};

export function highlightColorFromModifiers(e: {
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}): SquareHighlightColor {
  if (e.shiftKey) return "green";
  if (e.altKey) return "blue";
  if (e.ctrlKey || e.metaKey) return "yellow";
  return "red";
}

export function arrowColorFromModifiers(e: {
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}): ArrowColor {
  if (e.shiftKey) return "green";
  if (e.altKey) return "blue";
  if (e.ctrlKey || e.metaKey) return "red";
  return "orange";
}
