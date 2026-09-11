"use client";

import type { PositionEval } from "@/lib/game-record";

interface EvalBarProps {
  evaluation: PositionEval | null;
  flipped: boolean;
}

/** Share of the bar (0..100) that belongs to White, from a pawn evaluation. */
function whiteShare(ev: PositionEval | null): number {
  if (!ev) return 50;
  if (ev.mate !== null) return ev.mate > 0 ? 100 : ev.mate < 0 ? 0 : ev.pawns > 0 ? 100 : 0;
  // Lichess-style winning chances curve on centipawns.
  const cp = Math.max(-1500, Math.min(1500, ev.pawns * 100));
  const chances = 2 / (1 + Math.exp(-0.00368208 * cp)) - 1;
  return 50 + 50 * chances;
}

export function EvalBar({ evaluation, flipped }: EvalBarProps) {
  const share = whiteShare(evaluation);
  const whiteAhead = share >= 50;
  const label = evaluation ? evaluation.text.replace(/^([+-])/, "$1") : "0.0";
  // White grows from the bottom when White is at the bottom of the board.
  const whiteAtBottom = !flipped;

  return (
    <div
      className="relative flex h-full w-5 shrink-0 select-none overflow-hidden rounded-sm bg-[#403d39]"
      title={`Avaliação: ${label}`}
      aria-label={`Avaliação ${label}`}
    >
      <div
        className="absolute left-0 w-full bg-[#f0f0f0] transition-[height] duration-500 ease-out"
        style={{ height: `${share}%`, ...(whiteAtBottom ? { bottom: 0 } : { top: 0 }) }}
      />
      <span
        className={`absolute left-0 w-full text-center text-[9px] font-bold leading-none ${
          whiteAhead ? "text-neutral-800" : "text-neutral-100"
        }`}
        style={whiteAhead === whiteAtBottom ? { bottom: 3 } : { top: 3 }}
      >
        {label.replace(/^[+-]/, "")}
      </span>
    </div>
  );
}
