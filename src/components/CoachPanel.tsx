"use client";

import { useEffect, useRef } from "react";
import type { TutorState } from "@/lib/live/live-client";

const STATUS_LABEL: Record<TutorState["status"], string> = {
  off: "Aula encerrada",
  connecting: "Conectando…",
  live: "Ao vivo",
  closing: "Encerrando…",
  idle: "Em espera (fale ou jogue para retomar)",
  error: "Erro",
};

const STATUS_DOT: Record<TutorState["status"], string> = {
  off: "bg-neutral-500",
  connecting: "bg-amber-400 animate-pulse",
  live: "bg-emerald-400",
  closing: "bg-amber-400",
  idle: "bg-sky-400",
  error: "bg-red-500",
};

interface CoachPanelProps {
  state: TutorState;
  costPerMinute: number;
  onToggleMute: () => void;
  onEnd: () => void;
  onResume: () => void;
}

export function CoachPanel({ state, costPerMinute, onToggleMute, onEnd, onResume }: CoachPanelProps) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [state.transcript]);

  const minutes = Math.floor(state.usageSeconds / 60);
  const seconds = Math.floor(state.usageSeconds % 60);
  const cost = (state.usageSeconds / 60) * costPerMinute;
  const active = state.status === "live" || state.status === "connecting" || state.status === "closing" || state.status === "idle";

  let activity = "";
  if (state.status === "live") {
    if (state.thinking) activity = "analisando…";
    else if (state.speaking) activity = "falando";
    else activity = "ouvindo";
  }

  return (
    <div className="flex flex-col gap-2 border-b border-white/10 px-3 py-2 text-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`inline-block h-2.5 w-2.5 rounded-full ${STATUS_DOT[state.status]}`} />
          <span className="font-semibold">Professor</span>
          <span className="text-xs text-neutral-400">
            {STATUS_LABEL[state.status]}
            {activity ? ` · ${activity}` : ""}
          </span>
        </div>
        <span className="font-mono text-xs text-neutral-400" title="Tempo de sessão cobrado (estimativa)">
          {minutes}:{seconds.toString().padStart(2, "0")} · ${cost.toFixed(2)}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <div className="flex h-2 flex-1 overflow-hidden rounded bg-white/10" title="Nível do microfone">
          <div
            className={`h-full transition-[width] duration-100 ${state.muted ? "bg-neutral-500" : "bg-emerald-400"}`}
            style={{ width: `${Math.round(state.micLevel * 100)}%` }}
          />
        </div>
        <button
          type="button"
          onClick={onToggleMute}
          disabled={!state.micAvailable || !active}
          className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20 disabled:opacity-40"
        >
          {state.muted ? "Ativar mic" : "Mudo"}
        </button>
        {active ? (
          <button type="button" onClick={onEnd} className="rounded bg-red-500/80 px-2 py-1 text-xs hover:bg-red-500">
            Encerrar aula
          </button>
        ) : (
          <button type="button" onClick={onResume} className="rounded bg-[#81b64c] px-2 py-1 text-xs hover:bg-[#8fc75a]">
            Retomar aula
          </button>
        )}
      </div>

      {state.error && <p className="text-xs text-red-400">{state.error}</p>}
      {!state.micAvailable && active && (
        <p className="text-xs text-amber-300">Sem microfone: você ouve o Professor, mas ele não ouve você.</p>
      )}

      <div className="max-h-48 min-h-[4rem] overflow-y-auto rounded bg-black/20 p-2 text-xs leading-snug">
        {state.transcript.length === 0 && (
          <p className="text-neutral-500">A transcrição da conversa aparece aqui.</p>
        )}
        {state.transcript.map((row) => (
          <p key={row.id} className={row.role === "user" ? "text-sky-200" : "text-neutral-100"}>
            <span className="mr-1 font-semibold text-neutral-400">{row.role === "user" ? "Você:" : "Professor:"}</span>
            {row.text}
          </p>
        ))}
        <div ref={endRef} />
      </div>

      <details className="text-[11px] text-neutral-500">
        <summary className="cursor-pointer select-none">Eventos ({state.eventLog.length})</summary>
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/30 p-2 font-mono">
          {state.eventLog.join("\n")}
        </pre>
      </details>
    </div>
  );
}
