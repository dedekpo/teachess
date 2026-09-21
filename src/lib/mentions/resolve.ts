import { Chess, type Color, type Move, type PieceSymbol, type Square } from "chess.js";
import type { Mention, MoveMention, PieceMention, Plan, PlanPart, Visual } from "./types";

const SQUARE_RE = /^[a-h][1-8]$/;
const PIECES: PieceSymbol[] = ["k", "q", "r", "b", "n", "p"];
/** Piece mentions with more candidate squares than this are too vague to show ("your pawn" with eight pawns). */
export const MAX_PIECE_CANDIDATES = 2;

export function isSquare(s: unknown): s is Square {
  return typeof s === "string" && SQUARE_RE.test(s);
}

export function isPieceSymbol(s: unknown): s is PieceSymbol {
  return typeof s === "string" && (PIECES as string[]).includes(s);
}

export function kingSquare(chess: Chess, color: Color): Square | null {
  return chess.findPiece({ type: "k", color })[0] ?? null;
}

/** True when `square` holds that piece in `fen` (false for an invalid FEN or square). */
export function hasPieceAt(fen: string, color: Color, piece: PieceSymbol, square: string | null): boolean {
  if (!isSquare(square)) return false;
  try {
    const at = new Chess(fen).get(square);
    return !!at && at.type === piece && at.color === color;
  } catch {
    return false;
  }
}

/** Same position with the other side to move (a "null move"), or null when chess.js rejects it. */
export function flipTurn(fen: string): string | null {
  const f = fen.split(" ");
  if (f.length < 2) return null;
  f[1] = f[1] === "w" ? "b" : "w";
  if (f.length > 3) f[3] = "-";
  try {
    new Chess(f.join(" "));
    return f.join(" ");
  } catch {
    return null;
  }
}

/** Every legal move (for the side to move) matching a piece type, a target and an optional origin. */
function candidateMoves(chess: Chess, piece: PieceSymbol | null, to: Square, from: Square | null): Move[] {
  return chess.moves({ verbose: true }).filter((m) => m.to === to && (!piece || m.piece === piece) && (!from || m.from === from));
}

/**
 * Tries to play `move` (SAN, or a piece/target/origin description) on `fen`. When it is not legal for the side to
 * move and `allowNullMove` is set, the other side is tried too (prose often lists only one side's moves).
 * Returns null when it is illegal for both sides or ambiguous.
 */
export function tryMove(
  fen: string,
  move: string | { piece: PieceSymbol | null; to: Square; from: Square | null },
  allowNullMove: boolean,
): { move: Move; fenBefore: string } | null {
  const attempt = (f: string): Move | null => {
    let chess: Chess;
    try {
      chess = new Chess(f);
    } catch {
      return null;
    }
    if (typeof move === "string") {
      try {
        return chess.move(move, { strict: false });
      } catch {
        return null;
      }
    }
    const cands = candidateMoves(chess, move.piece, move.to, move.from);
    // Promotions produce several candidates for the same from/to: prefer the queen.
    const distinct = new Map(cands.map((m) => [`${m.from}${m.to}`, m]));
    if (distinct.size !== 1) return null;
    const first = cands.find((m) => !m.promotion || m.promotion === "q") ?? cands[0];
    try {
      return chess.move({ from: first.from, to: first.to, promotion: first.promotion });
    } catch {
      return null;
    }
  };
  const direct = attempt(fen);
  if (direct) return { move: direct, fenBefore: fen };
  if (!allowNullMove) return null;
  const flipped = flipTurn(fen);
  if (!flipped) return null;
  const other = attempt(flipped);
  return other ? { move: other, fenBefore: flipped } : null;
}

/** Origins of the pieces that could make this move (for an ambiguous "knight to a4"). */
export function moveCandidates(fen: string, piece: PieceSymbol | null, to: Square, allowNullMove: boolean): { color: Color; from: Square[] } | null {
  const look = (f: string) => {
    try {
      const chess = new Chess(f);
      const cands = candidateMoves(chess, piece, to, null);
      return cands.length ? { color: chess.turn(), from: [...new Set(cands.map((m) => m.from))] } : null;
    } catch {
      return null;
    }
  };
  const direct = look(fen);
  if (direct) return direct;
  if (!allowNullMove) return null;
  const flipped = flipTurn(fen);
  return flipped ? look(flipped) : null;
}

export function moveMention(id: string, m: Move, fenBefore: string, text: string | null, lineId: string | null): Mention {
  const after = new Chess(m.after);
  const check = after.inCheck();
  const captured = m.captured ?? null;
  const visual: Visual = { squares: [m.from], arrows: [{ from: m.from, to: m.to, kind: captured ? "capture" : "move" }] };
  if (check) {
    const king = kingSquare(after, after.turn());
    if (king) {
      // Every checking piece (covers discovered and double checks).
      for (const sq of after.attackers(king, m.color)) visual.arrows.push({ from: sq, to: king, kind: "check" });
    }
  }
  const body: MoveMention = { kind: "move", color: m.color, piece: m.piece, from: m.from, to: m.to, san: m.san, captured, check };
  return { id, fen: fenBefore, body, visual, text, lineId };
}

export function pieceMention(id: string, fen: string, color: Color, piece: PieceSymbol, squares: Square[], text: string | null): Mention {
  const body: PieceMention = { kind: "piece", color, piece, squares };
  return { id, fen, body, visual: { squares, arrows: [] }, text, lineId: null };
}

export function squareMention(id: string, fen: string, square: Square, text: string | null): Mention {
  return { id, fen, body: { kind: "square", square }, visual: { squares: [square], arrows: [] }, text, lineId: null };
}

/**
 * Resolves "the white knight (on f3)" against a position. A wrong square is repaired when the side has exactly
 * one such piece; otherwise every candidate is returned (the UI shows them all, dimmed).
 */
export function resolvePiece(fen: string, color: Color, piece: PieceSymbol, square: Square | null): Square[] {
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch {
    return [];
  }
  if (square) {
    const at = chess.get(square);
    if (at && at.type === piece && at.color === color) return [square];
  }
  return chess.findPiece({ type: piece, color });
}

/** Plays a SAN line from `fen`, producing one move mention per step. Stops at the first illegal move. */
export function resolveLine(idPrefix: string, fen: string, moves: string[], text: string | null, lineId: string): Mention[] {
  const out: Mention[] = [];
  let cur = fen;
  for (let i = 0; i < moves.length; i++) {
    const res = tryMove(cur, moves[i].trim(), true);
    if (!res) break;
    out.push(moveMention(`${idPrefix}.${i}`, res.move, res.fenBefore, i === 0 ? text : null, lineId));
    cur = res.move.after;
  }
  return out;
}

/**
 * Turns the writer's structured parts into a validated plan. Invalid parts are dropped, and so are piece mentions that
 * cannot be pinned down to a couple of squares (highlighting every pawn helps nobody).
 */
export function planFromParts(id: string, fen: string, parts: PlanPart[], source: Plan["source"]): Plan {
  const steps: Mention[] = [];
  parts.forEach((part, i) => {
    if (part.type === "piece") {
      const at = part.fen || fen;
      const squares = resolvePiece(at, part.color, part.piece, isSquare(part.square) ? part.square : null);
      if (squares.length && squares.length <= MAX_PIECE_CANDIDATES) {
        steps.push(pieceMention(`${id}:${i}`, at, part.color, part.piece, squares, part.text));
      }
    } else if (part.type === "line") {
      steps.push(...resolveLine(`${id}:${i}`, part.fen || fen, part.moves, part.text, `${id}:${i}`));
    }
  });
  return { id, fen, steps, createdAt: performance.now(), source };
}

/** The speech text of a parts list (text fields concatenated). */
export function speechFromParts(parts: PlanPart[]): string {
  return parts
    .map((p) => p.text)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}
