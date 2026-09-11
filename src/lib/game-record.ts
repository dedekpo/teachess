import { Chess, type Color, type Move, type PieceSymbol, type Square } from "chess.js";
import type { AnalysisSnapshot } from "./useEngine";
import { formatScoreWhite, pvToSan, scoreToPawns } from "./engine-format";

export type MoveClass =
  | "brilliant"
  | "best"
  | "excellent"
  | "good"
  | "inaccuracy"
  | "mistake"
  | "blunder"
  | "unknown";

export interface PositionEval {
  fen: string;
  /** Pawns from White's perspective; mate mapped to ±100. */
  pawns: number;
  text: string; // "+0.5", "M3", "-M2"
  mate: number | null; // moves to mate from White's perspective (sign = who mates)
  bestMoveSan: string | null;
  bestLine: string[];
  depth: number;
}

export interface MoveRecord {
  ply: number; // 1-based
  moveNumber: number;
  color: Color;
  san: string;
  fenBefore: string;
  fenAfter: string;
  before: PositionEval | null;
  after: PositionEval | null;
  /** Pawns lost by the mover compared with the best move (≥ 0). */
  loss: number | null;
  classification: MoveClass;
  /** Engine's best move in the position before, when different from what was played. */
  bestAlternative: string | null;
  captured: PieceSymbol | null;
}

export const CLASS_LABEL_PT: Record<MoveClass, string> = {
  brilliant: "brilhante",
  best: "melhor lance",
  excellent: "excelente",
  good: "bom",
  inaccuracy: "imprecisão",
  mistake: "erro",
  blunder: "erro grave",
  unknown: "sem avaliação",
};

export const CLASS_SYMBOL: Record<MoveClass, string> = {
  brilliant: "!!",
  best: "★",
  excellent: "!",
  good: "",
  inaccuracy: "?!",
  mistake: "?",
  blunder: "??",
  unknown: "",
};

export const CLASS_COLOR: Record<MoveClass, string> = {
  brilliant: "#26c2a3",
  best: "#81b64c",
  excellent: "#96bc4b",
  good: "#a3b58a",
  inaccuracy: "#f7c631",
  mistake: "#ffa459",
  blunder: "#fa412d",
  unknown: "#888",
};

const PIECE_VALUE: Record<PieceSymbol, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const PIECE_PT: Record<PieceSymbol, string> = { p: "peão", n: "cavalo", b: "bispo", r: "torre", q: "dama", k: "rei" };
const PIECE_PT_PLURAL: Record<PieceSymbol, string> = { p: "peões", n: "cavalos", b: "bispos", r: "torres", q: "damas", k: "reis" };

export function positionEvalFromSnapshot(snap: AnalysisSnapshot | undefined): PositionEval | null {
  if (!snap || snap.lines.length === 0) return null;
  const turn = snap.fen.split(" ")[1] as Color;
  const top = snap.lines[0];
  const san = pvToSan(snap.fen, top.pv, 5);
  const sign = turn === "w" ? 1 : -1;
  return {
    fen: snap.fen,
    pawns: scoreToPawns(top.score, turn),
    text: formatScoreWhite(top.score, turn).text,
    mate: top.score.type === "mate" ? top.score.value * sign : null,
    bestMoveSan: san[0] ?? null,
    bestLine: san,
    depth: snap.depth,
  };
}

/** Terminal positions have a definite value even without engine lines. */
function terminalEval(fen: string): PositionEval | null {
  const chess = new Chess(fen);
  if (chess.isCheckmate()) {
    const loserIsWhite = chess.turn() === "w";
    return { fen, pawns: loserIsWhite ? -100 : 100, text: loserIsWhite ? "0-1" : "1-0", mate: 0, bestMoveSan: null, bestLine: [], depth: 99 };
  }
  if (chess.isDraw() || chess.isStalemate()) {
    return { fen, pawns: 0, text: "½-½", mate: null, bestMoveSan: null, bestLine: [], depth: 99 };
  }
  return null;
}

/** True when the moved piece is left hanging or exchanged down (a real sacrifice). */
function isSacrifice(move: Move): boolean {
  if (move.piece === "p" || move.piece === "k") return false;
  const chess = new Chess(move.after);
  const opponent: Color = move.color === "w" ? "b" : "w";
  const attackers = chess.attackers(move.to as Square, opponent);
  if (attackers.length === 0) return false;
  const defenders = chess.attackers(move.to as Square, move.color);
  const moved = PIECE_VALUE[move.piece];
  const gained = move.captured ? PIECE_VALUE[move.captured] : 0;
  const cheapest = Math.min(...attackers.map((sq) => PIECE_VALUE[chess.get(sq)!.type]));
  if (defenders.length === 0) return moved - gained >= 2;
  return cheapest < moved && moved - cheapest - gained >= 2;
}

export function classify(move: Move, before: PositionEval | null, after: PositionEval | null): {
  loss: number | null;
  classification: MoveClass;
} {
  if (!before || !after) return { loss: null, classification: "unknown" };
  const sign = move.color === "w" ? 1 : -1;
  const moverBefore = before.pawns * sign;
  const moverAfter = after.pawns * sign;
  const loss = Math.max(0, moverBefore - moverAfter);

  if (before.bestMoveSan === move.san || loss <= 0.02) {
    return { loss, classification: isSacrifice(move) && moverBefore < 3 ? "brilliant" : "best" };
  }
  // Already hopeless (or already completely winning): differences barely matter.
  if ((moverBefore <= -6 && moverAfter <= -6) || (moverBefore >= 6 && moverAfter >= 6)) {
    return { loss, classification: loss <= 1 ? "good" : "inaccuracy" };
  }
  if (loss <= 0.15) return { loss, classification: "excellent" };
  if (loss <= 0.5) return { loss, classification: "good" };
  if (loss <= 1.0) return { loss, classification: "inaccuracy" };
  if (loss <= 2.0) return { loss, classification: "mistake" };
  return { loss, classification: "blunder" };
}

export function buildRecords(history: Move[], analyses: ReadonlyMap<string, AnalysisSnapshot>): MoveRecord[] {
  return history.map((mv, i) => {
    const before = positionEvalFromSnapshot(analyses.get(mv.before)) ?? terminalEval(mv.before);
    const after = positionEvalFromSnapshot(analyses.get(mv.after)) ?? terminalEval(mv.after);
    const { loss, classification } = classify(mv, before, after);
    const bestAlternative = before?.bestMoveSan && before.bestMoveSan !== mv.san ? before.bestMoveSan : null;
    return {
      ply: i + 1,
      moveNumber: Math.floor(i / 2) + 1,
      color: mv.color,
      san: mv.san,
      fenBefore: mv.before,
      fenAfter: mv.after,
      before,
      after,
      loss,
      classification,
      bestAlternative,
      captured: mv.captured ?? null,
    };
  });
}

// ---------- material ----------

export interface MaterialSummary {
  /** Points from White's perspective (+ means White is up material). */
  balance: number;
  pieces: { w: string[]; b: string[] }; // e.g. "Qd1"
  text: string; // Portuguese description for the tutor
}

export function materialSummary(fen: string): MaterialSummary {
  const chess = new Chess(fen);
  const pieces = { w: [] as string[], b: [] as string[] };
  const counts: Record<Color, Record<PieceSymbol, string[]>> = {
    w: { p: [], n: [], b: [], r: [], q: [], k: [] },
    b: { p: [], n: [], b: [], r: [], q: [], k: [] },
  };
  let balance = 0;
  for (const row of chess.board()) {
    for (const cell of row) {
      if (!cell) continue;
      counts[cell.color][cell.type].push(cell.square);
      pieces[cell.color].push(`${cell.type.toUpperCase()}${cell.square}`);
      balance += (cell.color === "w" ? 1 : -1) * PIECE_VALUE[cell.type];
    }
  }
  const describe = (c: Color) =>
    (["k", "q", "r", "b", "n", "p"] as PieceSymbol[])
      .filter((t) => counts[c][t].length > 0)
      .map((t) => `${counts[c][t].length > 1 ? PIECE_PT_PLURAL[t] : PIECE_PT[t]} ${counts[c][t].join(" ")}`)
      .join(", ");
  const missing = (c: Color) =>
    (["q", "r", "b", "n"] as PieceSymbol[])
      .filter((t) => counts[c][t].length === 0)
      .map((t) => PIECE_PT[t]);
  const parts = [`Brancas: ${describe("w")}.`, `Pretas: ${describe("b")}.`];
  const mw = missing("w");
  const mb = missing("b");
  if (mw.length) parts.push(`Brancas não têm mais: ${mw.join(", ")}.`);
  if (mb.length) parts.push(`Pretas não têm mais: ${mb.join(", ")}.`);
  parts.push(
    balance === 0
      ? "Material igual."
      : `${balance > 0 ? "Brancas" : "Pretas"} têm ${Math.abs(balance)} ponto(s) de material a mais.`,
  );
  return { balance, pieces, text: parts.join(" ") };
}

// ---------- text for the tutor ----------

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return "?";
  if (n >= 100) return "mate";
  if (n <= -100) return "mate contra";
  return `${n > 0 ? "+" : ""}${n.toFixed(1)}`;
}

/** One line per move, e.g. "12. Dh5?? erro grave (+1.2 → -3.4), melhor: Cf3". */
export function recordLine(r: MoveRecord): string {
  const num = r.color === "w" ? `${r.moveNumber}.` : `${r.moveNumber}...`;
  const cls = r.classification === "unknown" ? "" : ` ${CLASS_LABEL_PT[r.classification]}`;
  const evals = ` (${fmt(r.before?.pawns)} → ${fmt(r.after?.pawns)})`;
  const alt = r.bestAlternative && ["inaccuracy", "mistake", "blunder"].includes(r.classification) ? `, melhor era ${r.bestAlternative}` : "";
  return `${num} ${r.san}${CLASS_SYMBOL[r.classification]}${cls}${evals}${alt}`;
}

export function recordsText(records: MoveRecord[], lastN?: number): string {
  const slice = lastN ? records.slice(-lastN) : records;
  return slice.map(recordLine).join("; ");
}

export interface RecordJson {
  ply: number;
  move: string; // "12. Qh5" / "12... Nf6"
  color: Color;
  evalBefore: string | null;
  evalAfter: string | null;
  loss: number | null;
  classification: MoveClass;
  classificationPt: string;
  bestAlternative: string | null;
  captured: string | null;
}

export function recordToJson(r: MoveRecord): RecordJson {
  return {
    ply: r.ply,
    move: `${r.moveNumber}${r.color === "w" ? "." : "..."} ${r.san}`,
    color: r.color,
    evalBefore: r.before?.text ?? null,
    evalAfter: r.after?.text ?? null,
    loss: r.loss === null ? null : Number(r.loss.toFixed(2)),
    classification: r.classification,
    classificationPt: CLASS_LABEL_PT[r.classification],
    bestAlternative: r.bestAlternative,
    captured: r.captured ? PIECE_PT[r.captured] : null,
  };
}

/** Worst moves per side, for a quick "where did it go wrong" summary. */
export function worstMoves(records: MoveRecord[], color: Color, n = 3): RecordJson[] {
  return records
    .filter((r) => r.color === color && r.loss !== null)
    .sort((a, b) => (b.loss ?? 0) - (a.loss ?? 0))
    .slice(0, n)
    .filter((r) => (r.loss ?? 0) >= 0.5)
    .map(recordToJson);
}
