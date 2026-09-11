"use client";

import type { Color } from "chess.js";
import { STRENGTH_PRESETS, type StrengthPreset } from "@/lib/engine-player";
import { VOICES } from "@/lib/live/session-config";

export interface LessonSettings {
  userColor: Color;
  strength: StrengthPreset["id"];
  voice: string;
  idleTimeoutSec: number;
  showEngine: boolean;
}

interface LessonSetupProps {
  settings: LessonSettings;
  onChange: (s: LessonSettings) => void;
  onStart: () => void;
  disabled: boolean;
}

const selectCls = "rounded bg-white/10 px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-white/40";

export function LessonSetup({ settings, onChange, onStart, disabled }: LessonSetupProps) {
  const set = <K extends keyof LessonSettings>(k: K, v: LessonSettings[K]) => onChange({ ...settings, [k]: v });
  return (
    <div className="flex flex-col gap-2 border-b border-white/10 px-3 py-2 text-sm">
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          Você joga de
          <select className={selectCls} value={settings.userColor} onChange={(e) => set("userColor", e.target.value as Color)} disabled={disabled}>
            <option value="w">Brancas</option>
            <option value="b">Pretas</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          Nível do Professor
          <select className={selectCls} value={settings.strength} onChange={(e) => set("strength", e.target.value as StrengthPreset["id"])} disabled={disabled}>
            {STRENGTH_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          Voz
          <select className={selectCls} value={settings.voice} onChange={(e) => set("voice", e.target.value)} disabled={disabled}>
            {VOICES.map((v) => (
              <option key={v.id} value={v.id}>{v.label}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          Pausar após (s de silêncio)
          <input
            type="number"
            min={15}
            max={600}
            className={selectCls}
            value={settings.idleTimeoutSec}
            onChange={(e) => set("idleTimeoutSec", Math.max(15, Number(e.target.value) || 90))}
          />
        </label>
      </div>
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-xs text-neutral-400">
          <input type="checkbox" checked={settings.showEngine} onChange={(e) => set("showEngine", e.target.checked)} />
          Mostrar motor no tabuleiro
        </label>
        <button
          type="button"
          onClick={onStart}
          disabled={disabled}
          className="rounded-md bg-[#81b64c] px-3 py-1.5 text-sm font-semibold text-white shadow hover:bg-[#8fc75a] disabled:opacity-50"
        >
          Iniciar aula
        </button>
      </div>
    </div>
  );
}
