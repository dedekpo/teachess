"use client";

import { useLang } from "@/lib/i18n/LangProvider";
import { UI } from "@/lib/i18n/ui";
import type { Lang } from "@/lib/i18n/lang";
import type { GameStatus as Status } from "@/lib/useChessGame";

export function statusText(status: Status, lang: Lang): { title: string; subtitle: string } {
  const t = UI[lang].gameStatus;
  const name = { w: t.white, b: t.black } as const;
  switch (status.kind) {
    case "checkmate":
      return { title: t.checkmate, subtitle: t.wins(name[status.winner!]) };
    case "stalemate":
      return { title: t.draw, subtitle: t.stalemate };
    case "threefold":
      return { title: t.draw, subtitle: t.threefold };
    case "fifty-move":
      return { title: t.draw, subtitle: t.fifty };
    case "insufficient":
      return { title: t.draw, subtitle: t.insufficient };
    case "check":
      return { title: t.toMove(name[status.turn]), subtitle: t.check };
    default:
      return { title: t.toMove(name[status.turn]), subtitle: "" };
  }
}

export function GameStatus({ status }: { status: Status }) {
  const { title, subtitle } = statusText(status, useLang());
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
