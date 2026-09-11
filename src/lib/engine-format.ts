import { Chess, type Color, type PieceSymbol, type Square } from "chess.js";
import type { EngineLine, EngineScore } from "./useEngine";

export interface UciMove {
  from: Square;
  to: Square;
  promotion?: PieceSymbol;
}

export function parseUci(uci: string): UciMove {
  return {
    from: uci.slice(0, 2) as Square,
    to: uci.slice(2, 4) as Square,
    promotion: uci.length > 4 ? (uci[4] as PieceSymbol) : undefined,
  };
}

/** Score normalised to White's perspective ("+1.3", "-0.5", "M3", "-M2"). */
export function formatScoreWhite(score: EngineScore, turn: Color): { text: string; whiteAhead: boolean } {
  const sign = turn === "w" ? 1 : -1;
  if (score.type === "mate") {
    const m = score.value * sign;
    return { text: m > 0 ? `M${m}` : `-M${Math.abs(m)}`, whiteAhead: m > 0 };
  }
  const pawns = (score.value * sign) / 100;
  return { text: `${pawns > 0 ? "+" : ""}${pawns.toFixed(1)}`, whiteAhead: pawns >= 0 };
}

/** Numeric pawns from White's perspective (mate mapped to ±100). */
export function scoreToPawns(score: EngineScore, turn: Color): number {
  const sign = turn === "w" ? 1 : -1;
  if (score.type === "mate") return (score.value > 0 ? 100 : -100) * sign;
  return (score.value * sign) / 100;
}

/** Convert the first `count` PV moves to SAN, starting from `fen`. */
export function pvToSan(fen: string, pv: string[], count: number): string[] {
  const chess = new Chess(fen);
  const out: string[] = [];
  for (const uci of pv.slice(0, count)) {
    try {
      out.push(chess.move(parseUci(uci)).san);
    } catch {
      break;
    }
  }
  return out;
}

export function summarizeLines(fen: string, lines: EngineLine[], count = 6) {
  const turn = fen.split(" ")[1] as Color;
  return lines.map((l) => {
    const san = pvToSan(fen, l.pv, count);
    return { move: san[0] ?? l.pv[0], eval: formatScoreWhite(l.score, turn).text, line: san.slice(1) };
  });
}
