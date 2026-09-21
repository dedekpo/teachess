import type { Color, PieceSymbol, Square } from "chess.js";

export type ArrowKind = "move" | "capture" | "check";

export interface VisualArrow {
  from: Square;
  to: Square;
  kind: ArrowKind;
}

/** What to draw on the board for one mention. */
export interface Visual {
  squares: Square[];
  arrows: VisualArrow[];
}

/** A piece being talked about. Several squares means the speech was ambiguous ("the knight" with two knights). */
export interface PieceMention {
  kind: "piece";
  color: Color;
  piece: PieceSymbol;
  squares: Square[];
}

export interface MoveMention {
  kind: "move";
  color: Color;
  piece: PieceSymbol;
  from: Square;
  to: Square;
  san: string;
  captured: PieceSymbol | null;
  check: boolean;
}

export interface SquareMention {
  kind: "square";
  square: Square;
}

export type MentionBody = PieceMention | MoveMention | SquareMention;

export interface Mention {
  id: string;
  /** The position this mention refers to (for a move, the position before it is played). */
  fen: string;
  body: MentionBody;
  visual: Visual;
  /** Words the writer expects to say for it (the voice model may paraphrase). */
  text: string | null;
  /** Steps of the same variation share a line id, in order. */
  lineId: string | null;
}

/** Ordered mentions the Professor is about to speak, produced before the speech starts. */
export interface Plan {
  id: string;
  fen: string;
  steps: Mention[];
  createdAt: number;
  source: "comment" | "backend" | "speech";
}

/** Structured output of the comment writer / backend: speech interleaved with what it refers to. */
export type PlanPart =
  | { type: "text"; text: string }
  | {
      type: "piece";
      text: string;
      color: Color;
      piece: PieceSymbol;
      square: string | null;
      /** Position in which the piece stands on `square` (defaults to the plan's position). */
      fen?: string;
    }
  | { type: "line"; text: string; fen: string; moves: string[] };

/** The positions of one turn, by the names the comment writer uses. */
export type PositionRef = "current" | "before_student" | "before_tutor";

/** A part exactly as the comment writer returns it: positions by name, every field present (strict JSON schema). */
export interface WriterPart {
  type: "text" | "piece" | "line";
  text: string;
  color: Color | null;
  piece: PieceSymbol | null;
  square: string | null;
  from: PositionRef | null;
  moves: string[];
}

/** A mention anchored to a range of a transcript row. */
export interface RowMention {
  id: string;
  start: number;
  end: number;
  mention: Mention;
}
