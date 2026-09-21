import { Chess, type Color, type Move, type PieceSymbol, type Square } from "chess.js";
import type { Lang } from "@/lib/i18n/lang";
import { pieceName, pieceWithColor, squaresOf } from "./describe";
import { fold, hintColor, parsePhrases, type Phrase } from "./grammar";
import { flipTurn, hasPieceAt, isSquare, tryMove } from "./resolve";
import type { PlanPart, PositionRef, WriterPart } from "./types";

/**
 * Deterministic verification of what a model says about the board. Language models are not a source of truth
 * for chess geometry, so every claim (a piece on a square, a move, a line) is checked with chess.js against the
 * positions it can legitimately refer to, and the problems are worded so the model can correct itself.
 */

/** The positions of one turn, keyed by the names the comment writer uses. */
export type TurnPositions = Record<PositionRef, string>;
const REFS: PositionRef[] = ["current", "before_tutor", "before_student"];

export interface Problem {
  /** Index of the offending part, or null for a claim found in the plain text. */
  part: number | null;
  text: string;
  message: string;
}

export interface Verification {
  /** The parts resolved to FENs (position references repaired where the claim was true elsewhere in the turn). */
  parts: PlanPart[];
  problems: Problem[];
}

/** Every legal move grouped by the piece that makes it, keyed like `pieces` in get_position ("Qd1": ["Qxd8+", ...]). */
export function legalMovesByPiece(fen: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let moves: Move[];
  try {
    moves = new Chess(fen).moves({ verbose: true });
  } catch {
    return out;
  }
  for (const m of moves) {
    const key = `${m.piece.toUpperCase()}${m.from}`;
    (out[key] ??= []).push(m.san);
  }
  return out;
}

/** Legal moves of one kind of piece for `color` in `fen`, whether or not it is that side's turn (SAN). */
function movesOf(fen: string, piece: PieceSymbol, color: Color): string[] {
  try {
    const chess = new Chess(fen);
    const f = chess.turn() === color ? fen : flipTurn(fen);
    return f ? new Chess(f).moves({ piece }) : [];
  } catch {
    return [];
  }
}

/** Legal moves for both sides of `fen` (the side not to move gets a null move first), so threats can be checked too. */
function movesBothSides(fen: string): Move[] {
  const out: Move[] = [];
  for (const f of [fen, flipTurn(fen)]) {
    if (!f) continue;
    try {
      out.push(...new Chess(f).moves({ verbose: true }));
    } catch {
      /* invalid position: nothing to add */
    }
  }
  return out;
}

const SAN_RE = /^([KQRBN])?([a-h])?([1-8])?x?([a-h][1-8])/;

/** The wording of every problem reported to the models, per language. */
const MSG = {
  en: {
    noCastling: "castling is not possible in this position",
    notAMove: (san: string, turn: Color) => `"${san}" is not a valid move in this position (${turn === "w" ? "White" : "Black"} to move)`,
    cannotGo: (piece: string, where: Square[], target: string, legal: string[]) =>
      `the ${piece}${where.length ? ` (on ${where.join(", ")})` : ""} cannot go to ${target}; possible moves of that piece: ${legal.join(", ") || "none"}`,
    ref: (ref: PositionRef) => (ref === "current" ? "current (after this turn's moves)" : ref),
    needSquare: (text: string) => `"${text}": give the piece's square (square)`,
    notThere: (text: string, piece: string, square: string, ref: string, where: Square[], name: string) =>
      `"${text}": there is no ${piece} on ${square} in the ${ref} position` +
      (where.length ? ` (there ${where.length > 1 ? "they are" : "it is"} on ${where.join(", ")})` : ` (that side has no ${name} in that position)`),
    suggestion: (text: string, san: string) =>
      `"${text}" describes a move for the student (${san}) from the current position: that is a suggestion, and the student only gets suggestions when asking for one. Remove that sentence.`,
    badLine: (text: string, bad: string, ref: string, after: string[], why: string) =>
      `"${text}": the move ${bad} is not possible in the ${ref} position${after.length ? ` after ${after.join(" ")}` : ""} nor in the other positions of the turn: ${why}`,
    unreachable: (piece: string, target: string, legal: string[]) =>
      `the ${piece} cannot reach ${target} in any position of this turn; possible moves of that piece now: ${legal.join(", ") || "none"}`,
    nowhere: "does not exist in the positions of this turn",
    claim: (text: string, detail: string) => `"${text}": ${detail}. Describe only moves and pieces that exist, or remove the sentence.`,
  },
  "pt-BR": {
    noCastling: "o roque não é possível nessa posição",
    notAMove: (san: string, turn: Color) => `"${san}" não é um lance válido nessa posição (lado a jogar: ${turn === "w" ? "brancas" : "pretas"})`,
    cannotGo: (piece: string, where: Square[], target: string, legal: string[]) =>
      `${piece}${where.length ? ` (em ${where.join(", ")})` : ""} não pode ir para ${target}; lances possíveis dessa peça: ${legal.join(", ") || "nenhum"}`,
    ref: (ref: PositionRef) => (ref === "current" ? "current (depois dos lances deste turno)" : ref),
    needSquare: (text: string) => `"${text}": informe a casa da peça (square)`,
    notThere: (text: string, piece: string, square: string, ref: string, where: Square[], name: string) =>
      `"${text}": não há ${piece} em ${square} na posição ${ref}` +
      (where.length ? ` (lá ${where.length > 1 ? "estão" : "está"} em ${where.join(", ")})` : ` (esse lado não tem ${name} nessa posição)`),
    suggestion: (text: string, san: string) =>
      `"${text}" descreve um lance do aluno (${san}) a partir da posição atual: isso é uma sugestão, e o aluno só recebe sugestões quando pede. Retire essa frase.`,
    badLine: (text: string, bad: string, ref: string, after: string[], why: string) =>
      `"${text}": o lance ${bad} não é possível na posição ${ref}${after.length ? ` depois de ${after.join(" ")}` : ""} nem nas outras posições do turno: ${why}`,
    unreachable: (piece: string, target: string, legal: string[]) =>
      `${piece} não alcança ${target} em nenhuma posição deste turno; lances possíveis dessa peça agora: ${legal.join(", ") || "nenhum"}`,
    nowhere: "não existe nas posições deste turno",
    claim: (text: string, detail: string) => `"${text}": ${detail}. Descreva só lances e peças que existem, ou retire a frase.`,
  },
} satisfies Record<Lang, unknown>;

/** Why a SAN move is impossible in `fen`, with what that piece can do instead. */
function explainIllegal(fen: string, san: string, lang: Lang): string {
  const M = MSG[lang];
  const clean = san.replace(/[+#!?]/g, "");
  if (/^O-O(-O)?$/i.test(clean) || /^0-0(-0)?$/.test(clean)) return M.noCastling;
  const m = SAN_RE.exec(clean);
  let turn: Color = "w";
  try {
    turn = new Chess(fen).turn();
  } catch {
    /* keep the default */
  }
  if (!m) return M.notAMove(san, turn);
  const piece = (m[1]?.toLowerCase() ?? "p") as PieceSymbol;
  const target = m[4];
  return M.cannotGo(pieceWithColor(piece, turn, lang), squaresOf(fen, turn, piece), target, movesOf(fen, piece, turn));
}

interface PlayedLine {
  ok: boolean;
  san: string[];
  failedAt: number;
  fenAtFailure: string;
  /** The first move is legal for the side to move (false when it only works as the other side's "threat"). */
  firstStrict: boolean;
  firstColor: Color | null;
}

/** Plays a SAN line from `fen`; the first move may be the other side's (a threat), the rest must alternate. */
function playLine(fen: string, moves: string[]): PlayedLine {
  const san: string[] = [];
  let cur = fen;
  let firstStrict = false;
  let firstColor: Color | null = null;
  for (let i = 0; i < moves.length; i++) {
    const strict = tryMove(cur, moves[i].trim(), false);
    const res = strict ?? (i === 0 ? tryMove(cur, moves[0].trim(), true) : null);
    if (!res) return { ok: false, san, failedAt: i, fenAtFailure: cur, firstStrict, firstColor };
    if (i === 0) {
      firstStrict = !!strict;
      firstColor = res.move.color;
    }
    san.push(res.move.san);
    cur = res.move.after;
  }
  return { ok: true, san, failedAt: -1, fenAtFailure: cur, firstStrict, firstColor };
}

/** Whether the move or piece a phrase describes exists in at least one of the positions (either side's moves count). */
function phrasePossible(phrase: Phrase, fens: string[], color: Color | null): boolean {
  const piece = phrase.piece;
  if (!piece) return true;
  for (const fen of fens) {
    let chess: Chess;
    try {
      chess = new Chess(fen);
    } catch {
      continue;
    }
    const at = phrase.at ? chess.get(phrase.at) : undefined;
    const originHere = !!at && at.type === piece && (!color || at.color === color);
    const origin = originHere ? phrase.at : null;
    const fits = (m: Move) => m.piece === piece && (!color || m.color === color) && (!origin || m.from === origin);
    if (phrase.to) {
      const to = phrase.to;
      if (movesBothSides(fen).some((m) => fits(m) && m.to === to)) return true;
    } else if (phrase.capture) {
      const { square, piece: captured } = phrase.capture;
      if (movesBothSides(fen).some((m) => fits(m) && m.captured && (!square || m.to === square) && (!captured || m.captured === captured))) return true;
    } else if (phrase.at) {
      const at2 = phrase.at;
      if (originHere) return true;
      // "pawn on e3" with no pawn there yet is the move to e3.
      if (movesBothSides(fen).some((m) => fits(m) && m.to === at2)) return true;
    }
  }
  return false;
}

/**
 * Checks the comment writer's parts against the turn's positions. Piece parts must name a square the piece really is
 * on; line parts must be legal (from the named position, or repaired to the turn position where they are); a line
 * of the student's own moves from the current position is a hint, which the Professor never gives unasked; and every
 * move described in the plain text, marked or not, must be possible somewhere in the turn.
 */
export function verifyWriterParts(raw: WriterPart[], fens: TurnPositions, userColor: Color, lang: Lang): Verification {
  const M = MSG[lang];
  const problems: Problem[] = [];
  const parts: PlanPart[] = [];
  const lineRanges: [number, number][] = [];
  let studentToMove = false;
  try {
    studentToMove = new Chess(fens.current).turn() === userColor;
  } catch {
    /* an invalid current position fails every claim below anyway */
  }
  let offset = 0;

  raw.forEach((p, index) => {
    const start = offset;
    offset += p.text.length;
    if (p.type === "piece" && p.color && p.piece) {
      const { color, piece } = p;
      const ref = p.from ?? "current";
      let square = isSquare(p.square) ? p.square : null;
      if (!square) {
        // The writer may leave the square out for a unique piece (the king): fill it in rather than argue.
        const only = squaresOf(fens[ref], color, piece);
        if (only.length === 1) square = only[0];
      }
      if (!square) {
        problems.push({ part: index, text: p.text, message: M.needSquare(p.text) });
        parts.push({ type: "text", text: p.text });
        return;
      }
      let fen: string | null = hasPieceAt(fens[ref], color, piece, square) ? fens[ref] : null;
      if (!fen && new RegExp(`\\b${square}\\b`).test(fold(p.text))) {
        // The square is in the spoken words, so the student hears it: accept it if the piece stood there this turn.
        fen = REFS.map((r) => fens[r]).find((f) => hasPieceAt(f, color, piece, square)) ?? null;
      }
      if (!fen) {
        const where = squaresOf(fens[ref], color, piece);
        problems.push({ part: index, text: p.text, message: M.notThere(p.text, pieceWithColor(piece, color, lang), square, M.ref(ref), where, pieceName(piece, lang)) });
        parts.push({ type: "text", text: p.text });
        return;
      }
      parts.push({ type: "piece", text: p.text, color, piece, square, fen });
      return;
    }
    if (p.type === "line" && p.moves.length > 0) {
      lineRanges.push([start, offset]);
      const named = p.from ?? "current";
      const order: PositionRef[] = [named, ...REFS.filter((r) => r !== named)];
      for (const ref of order) {
        const played = playLine(fens[ref], p.moves);
        if (!played.ok) continue;
        if (ref === "current" && studentToMove && played.firstStrict && played.firstColor === userColor) {
          problems.push({ part: index, text: p.text, message: M.suggestion(p.text, played.san[0]) });
          parts.push({ type: "text", text: p.text });
          return;
        }
        parts.push({ type: "line", text: p.text, fen: fens[ref], moves: p.moves });
        return;
      }
      const played = playLine(fens[named], p.moves);
      const bad = p.moves[played.failedAt];
      problems.push({ part: index, text: p.text, message: M.badLine(p.text, bad, M.ref(named), played.failedAt > 0 ? played.san : [], explainIllegal(played.fenAtFailure, bad, lang)) });
      parts.push({ type: "text", text: p.text });
      return;
    }
    parts.push({ type: "text", text: p.text });
  });

  // Moves described in plain words (the writer forgot to mark them, or marked them as a piece) get the same check.
  const speech = raw.map((p) => p.text).join("");
  const positions = [...new Set(REFS.map((r) => fens[r]))];
  for (const phrase of parsePhrases(speech, lang)) {
    if (!phrase.piece || !(phrase.to || phrase.capture || phrase.at)) continue;
    if (phrase.capture && !phrase.capture.square && !phrase.capture.piece && !phrase.at) continue; // "takes" alone: nothing to check
    if (lineRanges.some(([s, e]) => phrase.start < e && phrase.end > s)) continue;
    const color = hintColor(phrase.side, "professor", userColor);
    if (phrasePossible(phrase, positions, color)) continue;
    const target = phrase.to ?? phrase.capture?.square ?? phrase.at;
    const detail = target && color ? M.unreachable(pieceWithColor(phrase.piece, color, lang), target, movesOf(fens.current, phrase.piece, color)) : M.nowhere;
    problems.push({ part: null, text: phrase.text, message: M.claim(phrase.text, detail) });
  }
  return { parts, problems };
}

/** Phrases in free prose (a backend answer) that describe a move or piece impossible in any of the positions. */
export function impossibleClaims(text: string, fens: string[], userColor: Color, lang: Lang): string[] {
  const positions = [...new Set(fens)];
  const out: string[] = [];
  for (const phrase of parsePhrases(text, lang)) {
    if (!phrase.piece || !(phrase.to || phrase.capture?.square || phrase.capture?.piece || phrase.at)) continue;
    const color = hintColor(phrase.side, "professor", userColor);
    if (!phrasePossible(phrase, positions, color)) out.push(phrase.text);
  }
  return out;
}

/** For the evaluate_move tool: which move of a sequence is illegal, and what the piece could do instead. */
export function illegalLineReport(fen: string, moves: string[], lang: Lang): { illegalMove: string; afterMoves: string[]; reason: string; legalMovesByPiece: Record<string, string[]> } | null {
  let cur = fen;
  const san: string[] = [];
  for (const m of moves) {
    const res = tryMove(cur, m.trim(), false);
    if (!res) return { illegalMove: m, afterMoves: san, reason: explainIllegal(cur, m, lang), legalMovesByPiece: legalMovesByPiece(cur) };
    san.push(res.move.san);
    cur = res.move.after;
  }
  return null;
}

export type { Square };
