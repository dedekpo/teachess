"use client";

/**
 * A second Stockfish worker used for (a) choosing the tutor's own moves at a
 * chosen strength and (b) evaluating hypothetical moves for the tutor's tools.
 * Requests are serialised; each resolves on "bestmove".
 */

export interface StrengthPreset {
  id: "iniciante" | "intermediario" | "avancado";
  label: string;
  elo: number; // Stockfish UCI_Elo (min 1320)
  depth: number;
}

export const STRENGTH_PRESETS: StrengthPreset[] = [
  { id: "iniciante", label: "Iniciante (~1320)", elo: 1320, depth: 6 },
  { id: "intermediario", label: "Intermediário (~1700)", elo: 1700, depth: 10 },
  { id: "avancado", label: "Avançado (~2200)", elo: 2200, depth: 14 },
];

export interface SearchResult {
  bestmove: string; // UCI, "(none)" when no legal move
  ponder?: string;
  /** Score from the side-to-move's perspective. */
  score: { type: "cp" | "mate"; value: number } | null;
  pv: string[];
  depth: number;
}

interface SearchOptions {
  depth: number;
  /** When set, limits strength via UCI_LimitStrength/UCI_Elo. */
  elo?: number;
}

const ENGINE_URL = "/stockfish/stockfish-18-lite-single.js";

export class EnginePlayer {
  private worker: Worker | null = null;
  private readyPromise: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private listeners: ((line: string) => void)[] = [];

  private ensure(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      try {
        const worker = new Worker(ENGINE_URL);
        this.worker = worker;
        worker.onmessage = (e: MessageEvent<string>) => {
          const line = String(e.data);
          if (line === "uciok") worker.postMessage("isready");
          else if (line === "readyok") resolve();
          for (const l of this.listeners) l(line);
        };
        worker.onerror = (e) => reject(new Error(e.message || "engine failed"));
        worker.postMessage("uci");
      } catch (e) {
        reject(e);
      }
    });
    return this.readyPromise;
  }

  search(fen: string, opts: SearchOptions): Promise<SearchResult> {
    const run = async (): Promise<SearchResult> => {
      await this.ensure();
      const worker = this.worker!;
      return new Promise<SearchResult>((resolve) => {
        let last: SearchResult = { bestmove: "(none)", score: null, pv: [], depth: 0 };
        const listener = (line: string) => {
          if (line.startsWith("info ") && line.includes(" score ") && line.includes(" pv ")) {
            const t = line.split(" ");
            const d = Number(t[t.indexOf("depth") + 1]);
            const si = t.indexOf("score");
            const score = { type: t[si + 1] as "cp" | "mate", value: Number(t[si + 2]) };
            const pv = t.slice(t.indexOf("pv") + 1);
            if (!line.includes("multipv") || t[t.indexOf("multipv") + 1] === "1") {
              last = { ...last, score, pv, depth: d };
            }
          } else if (line.startsWith("bestmove")) {
            const t = line.split(" ");
            this.listeners = this.listeners.filter((l) => l !== listener);
            resolve({ ...last, bestmove: t[1], ponder: t[3] });
          }
        };
        this.listeners.push(listener);
        worker.postMessage("setoption name MultiPV value 1");
        if (opts.elo) {
          worker.postMessage("setoption name UCI_LimitStrength value true");
          worker.postMessage(`setoption name UCI_Elo value ${opts.elo}`);
        } else {
          worker.postMessage("setoption name UCI_LimitStrength value false");
        }
        worker.postMessage(`position fen ${fen}`);
        worker.postMessage(`go depth ${opts.depth}`);
      });
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    this.readyPromise = null;
    this.listeners = [];
  }
}
