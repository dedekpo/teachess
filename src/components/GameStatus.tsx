"use client";

import type { GameStatus as Status } from "@/lib/useChessGame";

const NAME = { w: "White", b: "Black" } as const;

export function statusText(status: Status): { title: string; subtitle: string } {
  switch (status.kind) {
    case "checkmate":
      return { title: "Checkmate", subtitle: `${NAME[status.winner!]} wins` };
    case "stalemate":
      return { title: "Draw", subtitle: "Stalemate" };
    case "threefold":
      return { title: "Draw", subtitle: "Threefold repetition" };
    case "fifty-move":
      return { title: "Draw", subtitle: "50-move rule" };
    case "insufficient":
      return { title: "Draw", subtitle: "Insufficient material" };
    case "check":
      return { title: `${NAME[status.turn]} to move`, subtitle: "Check!" };
    default:
      return { title: `${NAME[status.turn]} to move`, subtitle: "" };
  }
}

export function GameStatus({ status }: { status: Status }) {
  const { title, subtitle } = statusText(status);
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <span
        className="inline-block h-4 w-4 rounded-full border border-neutral-500"
        style={{ backgroundColor: status.turn === "w" ? "#fff" : "#222" }}
        aria-hidden
      />
      <div>
        <div className="text-lg font-semibold leading-tight">{title}</div>
        {subtitle && (
          <div className={`text-sm ${status.over ? "text-amber-300" : "text-red-400"}`}>{subtitle}</div>
        )}
      </div>
    </div>
  );
}
