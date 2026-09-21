import { Chess, type Color, type PieceSymbol, type Square } from "chess.js";
import type { Lang } from "@/lib/i18n/lang";
import { tryMove } from "./resolve";

/**
 * Chess → speech, the inverse of `grammar.ts`. Used for deterministic speech (the fallback announcement when the
 * comment writer cannot be trusted) and for the feedback handed back to the models.
 */

export const PIECE_NAMES: Record<Lang, Record<PieceSymbol, string>> = {
  en: { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" },
  "pt-BR": { p: "peão", n: "cavalo", b: "bispo", r: "torre", q: "dama", k: "rei" },
};

export function pieceName(piece: PieceSymbol, lang: Lang): string {
  return PIECE_NAMES[lang][piece];
}

const FEMININE_PT = new Set<PieceSymbol>(["q", "r"]);

/** "white queen" / "dama branca", "black pawn" / "peão preto". */
export function pieceWithColor(piece: PieceSymbol, color: Color, lang: Lang): string {
  if (lang === "pt-BR") {
    const adjective = color === "w" ? (FEMININE_PT.has(piece) ? "branca" : "branco") : FEMININE_PT.has(piece) ? "preta" : "preto";
    return `${PIECE_NAMES[lang][piece]} ${adjective}`;
  }
  return `${color === "w" ? "white" : "black"} ${PIECE_NAMES[lang][piece]}`;
}

/** Squares of every piece of that kind and colour, e.g. "c2, d4". */
export function squaresOf(fen: string, color: Color, piece: PieceSymbol): Square[] {
  try {
    return new Chess(fen).findPiece({ type: piece, color });
  } catch {
    return [];
  }
}

/**
 * A move as the Professor would say it: "pawn from d5 takes on c4", "knight to f3", "castles kingside" (Portuguese:
 * "peão de d5 toma em c4", "cavalo para f3", "roque pequeno"), with the origin square whenever the side has more than
 * one piece of the kind (the rule the prompts impose on the models too). Returns null when the move is not legal.
 */
export function describeMove(fen: string, san: string, lang: Lang): string | null {
  const res = tryMove(fen, san, false);
  if (!res) return null;
  const m = res.move;
  const N = PIECE_NAMES[lang];
  const pt = lang === "pt-BR";
  if (m.isKingsideCastle()) return pt ? "roque pequeno" : "castles kingside";
  if (m.isQueensideCastle()) return pt ? "roque grande" : "castles queenside";
  const several = squaresOf(fen, m.color, m.piece).length > 1;
  const subject = several ? `${N[m.piece]} ${pt ? "de" : "from"} ${m.from}` : N[m.piece];
  let text = m.captured ? `${subject} ${pt ? "toma em" : "takes on"} ${m.to}` : `${subject} ${pt ? "para" : "to"} ${m.to}`;
  if (m.promotion) text += pt ? `, promovendo a ${N[m.promotion]}` : `, promoting to a ${N[m.promotion]}`;
  const after = new Chess(m.after);
  if (after.isCheckmate()) text += pt ? ", xeque-mate" : ", checkmate";
  else if (after.inCheck()) text += pt ? ", xeque" : ", check";
  return text;
}
