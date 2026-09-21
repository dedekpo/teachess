"use client";

import { useEffect, useRef } from "react";
import type { TranscriptRow, TutorState } from "@/lib/live/live-client";
import type { RowMention } from "@/lib/mentions/types";
import { useLang } from "@/lib/i18n/LangProvider";
import { UI } from "@/lib/i18n/ui";
import { TranscriptText } from "./TranscriptText";

const STATUS_DOT: Record<TutorState["status"], string> = {
  off: "bg-neutral-500",
  connecting: "bg-amber-400 animate-pulse",
  live: "bg-emerald-400",
  closing: "bg-amber-400",
  idle: "bg-sky-400",
  error: "bg-red-500",
};

/** What the board should show while the user hovers a transcript chip or row. */
export interface BoardPreview {
  fen: string;
  focus: RowMention[];
  dim: RowMention[];
}

interface CoachPanelProps {
  state: TutorState;
  costPerMinute: number;
  /** Push-to-talk: true while the student holds Space (or the talk button), false on release. */
  onTalk: (on: boolean) => void;
  onEnd: () => void;
  onResume: () => void;
  onPreview: (preview: BoardPreview | null) => void;
}

/** Hovering one chip: that mention in focus, the earlier steps of the same variation dimmed. */
function previewForMention(row: TranscriptRow, m: RowMention): BoardPreview {
  const dim = m.mention.lineId ? row.mentions.filter((o) => o.start < m.start && o.mention.lineId === m.mention.lineId) : [];
  return { fen: m.mention.fen, focus: [m], dim };
}

/** Hovering the speaker label: everything the row mentions, on the board as it was then. */
function previewForRow(row: TranscriptRow): BoardPreview {
  return { fen: row.fen, focus: row.mentions, dim: [] };
}

/** True when the key event comes from a field where Space should type a space. */
function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

export function CoachPanel({ state, costPerMinute, onTalk, onEnd, onResume, onPreview }: CoachPanelProps) {
  const t = UI[useLang()].coach;
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [state.transcript]);

  const minutes = Math.floor(state.usageSeconds / 60);
  const seconds = Math.floor(state.usageSeconds % 60);
  const cost = (state.usageSeconds / 60) * costPerMinute;
  const active = state.status === "live" || state.status === "connecting" || state.status === "closing" || state.status === "idle";
  const talking = !state.muted;

  // Hold Space to talk. The callback lives in a ref so a re-render never re-binds (and never releases) mid-press.
  const talkRef = useRef(onTalk);
  useEffect(() => {
    talkRef.current = onTalk;
  }, [onTalk]);
  useEffect(() => {
    if (!active) return;
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || isTyping(e.target)) return;
      e.preventDefault(); // no page scroll, no click on whichever button has focus
      if (!e.repeat) talkRef.current(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      if (!isTyping(e.target)) e.preventDefault();
      talkRef.current(false);
    };
    const release = () => talkRef.current(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
      release();
    };
  }, [active]);

  let activity = "";
  if (state.status === "live") {
    if (state.thinking) activity = t.analyzing;
    else if (state.speaking) activity = t.speaking;
    else if (talking) activity = t.listening;
  }

  return (
    <div className="flex flex-col gap-2 border-b border-white/10 px-3 py-2 text-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`inline-block h-2.5 w-2.5 rounded-full ${STATUS_DOT[state.status]}`} />
          <span className="font-semibold">Professor</span>
          <span className="text-xs text-neutral-400">
            {t.status[state.status]}
            {activity ? ` · ${activity}` : ""}
            {state.syncLeadMs !== null ? ` · sync ${state.syncLeadMs >= 0 ? "+" : ""}${state.syncLeadMs}ms` : ""}
            {state.lastSpeechDelayMs !== null ? ` · ${t.spokeAfter((state.lastSpeechDelayMs / 1000).toFixed(1))}` : ""}
          </span>
        </div>
        <span className="font-mono text-xs text-neutral-400" title={t.billedTime}>
          {minutes}:{seconds.toString().padStart(2, "0")} · ${cost.toFixed(2)}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <div className="flex h-2 flex-1 overflow-hidden rounded bg-white/10" title={t.micLevel}>
          <div
            className={`h-full transition-[width] duration-100 ${talking ? "bg-emerald-400" : "bg-neutral-500"}`}
            style={{ width: `${Math.round(state.micLevel * 100)}%` }}
          />
        </div>
        <button
          type="button"
          disabled={!state.micAvailable || !active}
          onPointerDown={(e) => {
            e.preventDefault(); // keeps focus (and Space) away from the button itself
            try {
              e.currentTarget.setPointerCapture(e.pointerId); // release fires here even if the pointer slides off
            } catch {
              /* pointer already gone */
            }
            onTalk(true);
          }}
          onPointerUp={() => onTalk(false)}
          onPointerCancel={() => onTalk(false)}
          onContextMenu={(e) => e.preventDefault()}
          title={t.holdToTalk}
          className={`select-none rounded px-2 py-1 text-xs disabled:opacity-40 ${
            talking ? "bg-emerald-500 text-white" : "bg-white/10 hover:bg-white/20"
          }`}
        >
          {talking ? t.listeningRelease : t.holdSpace}
        </button>
        {active ? (
          <button type="button" onClick={onEnd} className="rounded bg-red-500/80 px-2 py-1 text-xs hover:bg-red-500">
            {t.endLesson}
          </button>
        ) : (
          <button type="button" onClick={onResume} className="rounded bg-[#81b64c] px-2 py-1 text-xs hover:bg-[#8fc75a]">
            {t.resumeLesson}
          </button>
        )}
      </div>

      {state.error && <p className="text-xs text-red-400">{state.error}</p>}
      {!state.micAvailable && active && (
        <p className="text-xs text-amber-300">{t.noMic}</p>
      )}
      {state.micAvailable && active && (
        <p className="text-[11px] text-neutral-500">{t.holdSpaceHint}</p>
      )}

      <div className="max-h-48 min-h-[4rem] overflow-y-auto rounded bg-black/20 p-2 text-xs leading-snug">
        {state.transcript.length === 0 && (
          <p className="text-neutral-500">{t.transcriptEmpty}</p>
        )}
        {state.transcript.map((row) => (
          <p key={row.id} className={row.role === "user" ? "text-sky-200" : "text-neutral-100"}>
            <span
              className={`mr-1 font-semibold text-neutral-400 ${row.mentions.length && row.fen ? "cursor-help hover:text-[#d7b6e6]" : ""}`}
              onMouseEnter={() => row.mentions.length && row.fen && onPreview(previewForRow(row))}
              onMouseLeave={() => row.mentions.length && onPreview(null)}
            >
              {row.role === "user" ? t.you : t.professor}
            </span>
            <TranscriptText text={row.text} mentions={row.mentions} onHover={(m) => onPreview(m ? previewForMention(row, m) : null)} />
          </p>
        ))}
        <div ref={endRef} />
      </div>

      <details className="text-[11px] text-neutral-500">
        <summary className="cursor-pointer select-none">{t.events} ({state.eventLog.length})</summary>
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/30 p-2 font-mono">
          {state.eventLog.join("\n")}
        </pre>
      </details>
    </div>
  );
}
