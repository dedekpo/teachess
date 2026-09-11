"use client";

import type { Color } from "chess.js";
import { useMemo } from "react";
import type { EngineState } from "@/lib/useEngine";
import { formatScoreWhite, parseUci, pvToSan, type UciMove } from "@/lib/engine-format";

export type { UciMove };

interface EnginePanelProps {
  engine: EngineState;
  turn: Color;
  onHoverMove: (move: UciMove | null) => void;
}

export function EnginePanel({ engine, turn, onHoverMove }: EnginePanelProps) {
  const rows = useMemo(() => {
    if (!engine.fen) return [];
    return engine.lines.map((line) => {
      const san = pvToSan(engine.fen!, line.pv, 6);
      const score = formatScoreWhite(line.score, turn);
      return { key: line.multipv, uci: line.pv[0], san, score, depth: line.depth };
    });
  }, [engine.fen, engine.lines, turn]);

  const headline =
    engine.status === "loading"
      ? "Loading engine…"
      : engine.status === "error"
        ? `Engine error: ${engine.error ?? "unknown"}`
        : engine.status === "idle"
          ? "Engine idle"
          : null;

  return (
    <div
      className="absolute right-1.5 top-1.5 z-30 w-[38%] min-w-[11rem] max-w-[16rem] overflow-hidden rounded-md text-neutral-100 shadow-lg backdrop-blur-sm"
      style={{ backgroundColor: "rgba(38, 37, 34, 0.9)" }}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      onMouseLeave={() => onHoverMove(null)}
    >
      <div className="flex items-center justify-between px-2 py-1 text-[11px] uppercase tracking-wide text-neutral-400">
        <span>Stockfish 18</span>
        {engine.status === "thinking" && rows.length > 0 && (
          <span className="flex items-center gap-1">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
            depth {engine.depth}
          </span>
        )}
        {engine.status === "done" && rows.length > 0 && <span>depth {engine.depth}</span>}
      </div>

      {headline && <div className="px-2 pb-2 text-xs text-neutral-300">{headline}</div>}

      {!headline && rows.length === 0 && (
        <div className="px-2 pb-2 text-xs text-neutral-300">Thinking…</div>
      )}

      <ul className="flex flex-col">
        {rows.map((row) => (
          <li
            key={row.key}
            className="flex cursor-default items-center gap-2 border-t border-white/10 px-2 py-1.5 text-sm hover:bg-white/10"
            onMouseEnter={() => onHoverMove(parseUci(row.uci))}
            onFocus={() => onHoverMove(parseUci(row.uci))}
            onBlur={() => onHoverMove(null)}
            tabIndex={0}
          >
            <span
              className={`min-w-[2.8rem] rounded px-1 py-0.5 text-center font-mono text-xs font-bold ${
                row.score.whiteAhead ? "bg-neutral-100 text-neutral-900" : "bg-neutral-800 text-neutral-100"
              }`}
            >
              {row.score.text}
            </span>
            <span className="truncate">
              <span className="font-semibold">{row.san[0]}</span>
              {row.san.length > 1 && (
                <span className="ml-1 text-neutral-400">{row.san.slice(1).join(" ")}</span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
