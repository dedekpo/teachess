import { Chess, type Color, type PieceSymbol } from "chess.js";
import type { Lang } from "@/lib/i18n/lang";
import { fold } from "./grammar";
import { isSquare } from "./resolve";
import type { PlanPart } from "./types";

/** Singular piece nouns as the writer spells them, after `fold` (no accents), and the word that joins the square. */
const NOUNS: Record<Lang, { re: RegExp; on: string }> = {
  en: { re: /\b(pawn|queen|rook|bishop|knight|king)\b/, on: "on" },
  "pt-BR": { re: /\b(peao|dama|rainha|torre|bispo|cavalo|rei)\b/, on: "de" },
};

/**
 * Makes piece mentions unambiguous in the speech itself: "your pawn" becomes "your pawn on c2" ("seu peão de c2")
 * whenever that side has more than one piece of the kind, so the student hears which piece is meant (and the voice
 * model, which paraphrases, has the square in front of it). Only parts whose square is confirmed on the board are
 * touched; a unique piece (the king, usually the queen) keeps its short form.
 */
export function qualifyPieceParts(parts: PlanPart[], fen: string, lang: Lang): PlanPart[] {
  return parts.map((part) => {
    if (part.type !== "piece") return part;
    const text = qualifiedPieceText(part.text, part.color, part.piece, part.square, part.fen || fen, lang);
    return text === part.text ? part : { ...part, text };
  });
}

/** The text with " on <square>" inserted after the piece noun when needed; unchanged when it is already unambiguous. */
export function qualifiedPieceText(text: string, color: Color, piece: PieceSymbol, square: string | null, fen: string, lang: Lang): string {
  if (!isSquare(square)) return text;
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch {
    return text;
  }
  const at = chess.get(square);
  if (!at || at.type !== piece || at.color !== color) return text;
  if (chess.findPiece({ type: piece, color }).length < 2) return text;
  const folded = fold(text); // same length as `text`, so indices carry over
  if (new RegExp(`\\b${square}\\b`).test(folded)) return text;
  const noun = NOUNS[lang].re.exec(folded);
  if (!noun) return text;
  const end = noun.index + noun[0].length;
  return `${text.slice(0, end)} ${NOUNS[lang].on} ${square}${text.slice(end)}`;
}
