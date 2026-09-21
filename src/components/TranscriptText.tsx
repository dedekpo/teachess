"use client";

import type { Color, PieceSymbol } from "chess.js";
import type { Mention, RowMention } from "@/lib/mentions/types";

const GLYPH: Record<Color, Record<PieceSymbol, string>> = {
  w: { k: "♔", q: "♕", r: "♖", b: "♗", n: "♘", p: "♙" },
  b: { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" },
};

/** Short label for a chip: "♘f3", "♘f3→a4+", "♛d8×f7". */
export function mentionLabel(m: Mention): string {
  const b = m.body;
  if (b.kind === "square") return b.square;
  if (b.kind === "piece") return `${GLYPH[b.color][b.piece]}${b.squares.length === 1 ? b.squares[0] : "?"}`;
  return `${GLYPH[b.color][b.piece]}${b.from}${b.captured ? "×" : "→"}${b.to}${b.check ? "+" : ""}`;
}

interface TranscriptTextProps {
  text: string;
  mentions: RowMention[];
  onHover: (m: RowMention | null) => void;
}

/** Transcript text with the mentioned pieces/moves rendered as hoverable chips. */
export function TranscriptText({ text, mentions, onHover }: TranscriptTextProps) {
  if (mentions.length === 0) return <>{text}</>;
  const out: React.ReactNode[] = [];
  let pos = 0;
  for (const m of mentions) {
    if (m.start < pos) continue;
    if (m.start > pos) out.push(text.slice(pos, m.start));
    const side = m.mention.body.kind === "square" ? null : m.mention.body.color;
    const cls =
      side === "w"
        ? "bg-white/15 text-white ring-white/30"
        : side === "b"
          ? "bg-black/40 text-neutral-100 ring-white/20"
          : "bg-[#9b59b6]/25 text-neutral-100 ring-[#9b59b6]/50";
    out.push(
      <span
        key={m.id}
        onMouseEnter={() => onHover(m)}
        onMouseLeave={() => onHover(null)}
        className={`mx-px inline-flex cursor-help items-baseline gap-1 rounded px-1 ring-1 ring-inset hover:bg-[#9b59b6]/60 ${cls}`}
        title={mentionLabel(m.mention)}
      >
        <span>{text.slice(m.start, m.end)}</span>
        {mentionLabel(m.mention) !== text.slice(m.start, m.end).trim() && (
          <span className="font-mono text-[10px] text-[#d7b6e6]">{mentionLabel(m.mention)}</span>
        )}
      </span>,
    );
    pos = m.end;
  }
  if (pos < text.length) out.push(text.slice(pos));
  return <>{out}</>;
}
