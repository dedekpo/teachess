"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

export interface EngineScore {
  type: "cp" | "mate";
  /** From the side-to-move's perspective, as UCI reports it. */
  value: number;
}

export interface EngineLine {
  multipv: number;
  depth: number;
  score: EngineScore;
  /** Principal variation in UCI long algebraic notation (e.g. "e2e4"). */
  pv: string[];
}

export type EngineStatus = "loading" | "idle" | "thinking" | "done" | "error";

export interface AnalysisSnapshot {
  fen: string;
  depth: number;
  lines: EngineLine[];
}

export interface EngineState {
  status: EngineStatus;
  /** The FEN the current `lines` belong to. */
  fen: string | null;
  lines: EngineLine[];
  depth: number;
  /** Deepest analysis seen for every position analysed so far (keyed by FEN). */
  analyses: ReadonlyMap<string, AnalysisSnapshot>;
  error?: string;
}

const ENGINE_URL = "/stockfish/stockfish-18-lite-single.js";
const EMPTY: EngineState = { status: "loading", fen: null, lines: [], depth: 0, analyses: new Map() };

function parseInfo(line: string): EngineLine | null {
  // Only principal-variation lines with a proper (non-bound) score are useful.
  if (!line.startsWith("info ") || !line.includes(" pv ") || !line.includes(" multipv ")) return null;
  if (line.includes(" lowerbound") || line.includes(" upperbound")) return null;
  const tokens = line.split(" ");
  let depth = 0;
  let multipv = 1;
  let score: EngineScore | null = null;
  let pv: string[] = [];
  for (let i = 1; i < tokens.length; i++) {
    switch (tokens[i]) {
      case "depth":
        depth = Number(tokens[++i]);
        break;
      case "multipv":
        multipv = Number(tokens[++i]);
        break;
      case "score": {
        const type = tokens[++i] as "cp" | "mate";
        const value = Number(tokens[++i]);
        score = { type, value };
        break;
      }
      case "pv":
        pv = tokens.slice(i + 1);
        i = tokens.length;
        break;
    }
  }
  if (!score || pv.length === 0) return null;
  return { multipv, depth, score, pv };
}

/**
 * Owns the Stockfish Web Worker and speaks UCI to it. Exposed to React through
 * useSyncExternalStore so worker callbacks never call setState directly.
 */
class EngineClient {
  private worker: Worker | null = null;
  private ready = false;
  private searching = false;
  private currentFen: string | null = null;
  private pendingFen: string | null = null;
  private wantedFen: string | null = null;
  private lines = new Map<number, EngineLine>();
  private flushTimer: number | null = null;
  private listeners = new Set<() => void>();
  private state: EngineState = EMPTY;
  private multiPv = 3;
  private maxDepth = 20;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.state;
  getServerSnapshot = () => EMPTY;

  private analyses = new Map<string, AnalysisSnapshot>();

  private setState(next: Omit<EngineState, "analyses">) {
    this.state = { ...next, analyses: this.analyses };
    for (const l of this.listeners) l();
  }

  configure(multiPv: number, maxDepth: number) {
    this.multiPv = multiPv;
    this.maxDepth = maxDepth;
  }

  start() {
    if (this.worker || typeof Worker === "undefined") return;
    let worker: Worker;
    try {
      worker = new Worker(ENGINE_URL);
    } catch (e) {
      this.setState({ status: "error", fen: null, lines: [], depth: 0, error: String(e) });
      return;
    }
    this.worker = worker;
    worker.onmessage = (e: MessageEvent<string>) => this.onLine(String(e.data));
    worker.onerror = (e) => {
      this.setState({ status: "error", fen: null, lines: [], depth: 0, error: e.message || "Engine failed to load" });
    };
    worker.postMessage("uci");
  }

  dispose() {
    if (this.flushTimer !== null) window.clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
    this.searching = false;
    this.currentFen = null;
    this.pendingFen = null;
    this.lines = new Map();
    this.state = EMPTY;
  }

  /** Analyse `fen`, or stop analysing when `null`. */
  setPosition(fen: string | null) {
    this.wantedFen = fen;
    const worker = this.worker;
    if (!worker) return;

    if (fen === null) {
      this.pendingFen = null;
      if (this.searching) worker.postMessage("stop");
      this.currentFen = null;
      this.lines = new Map();
      if (this.state.status !== "error") this.setState({ status: "idle", fen: null, lines: [], depth: 0 });
      return;
    }

    if (this.currentFen === fen && (this.searching || this.lines.size > 0)) return;

    if (!this.ready) {
      this.pendingFen = fen;
      return;
    }
    if (this.searching) {
      this.pendingFen = fen;
      worker.postMessage("stop");
      return;
    }
    this.startSearch(fen);
  }

  private startSearch(fen: string) {
    const worker = this.worker;
    if (!worker) return;
    this.currentFen = fen;
    this.lines = new Map();
    this.searching = true;
    worker.postMessage(`setoption name MultiPV value ${this.multiPv}`);
    worker.postMessage(`position fen ${fen}`);
    worker.postMessage(`go depth ${this.maxDepth}`);
    this.setState({ status: "thinking", fen, lines: [], depth: 0 });
  }

  private scheduleFlush() {
    if (this.flushTimer !== null) return;
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      const lines = [...this.lines.values()].sort((a, b) => a.multipv - b.multipv);
      const depth = lines.length ? Math.min(...lines.map((l) => l.depth)) : 0;
      if (this.currentFen && lines.length > 0) {
        const prev = this.analyses.get(this.currentFen);
        if (!prev || depth >= prev.depth) {
          this.analyses = new Map(this.analyses);
          this.analyses.set(this.currentFen, { fen: this.currentFen, depth, lines });
        }
      }
      this.setState({
        status: this.searching ? "thinking" : "done",
        fen: this.currentFen,
        lines,
        depth,
      });
    }, 80);
  }

  private onLine(line: string) {
    const worker = this.worker;
    if (!worker) return;

    if (line === "uciok") {
      worker.postMessage("isready");
      return;
    }
    if (line === "readyok") {
      this.ready = true;
      const next = this.pendingFen ?? this.wantedFen;
      this.pendingFen = null;
      if (next) this.startSearch(next);
      else this.setState({ status: "idle", fen: null, lines: [], depth: 0 });
      return;
    }
    if (line.startsWith("bestmove")) {
      this.searching = false;
      if (this.pendingFen) {
        const f = this.pendingFen;
        this.pendingFen = null;
        this.startSearch(f);
      } else {
        this.scheduleFlush();
      }
      return;
    }
    if (!this.searching) return;
    const info = parseInfo(line);
    if (!info) return;
    this.lines.set(info.multipv, info);
    this.scheduleFlush();
  }
}

interface Options {
  enabled: boolean;
  multiPv: number;
  maxDepth: number;
}

/**
 * Runs Stockfish (WASM) in a Web Worker and keeps the top `multiPv` lines for
 * the given position up to date. A new position interrupts the current search.
 */
export function useEngine(fen: string, { enabled, multiPv, maxDepth }: Options): EngineState {
  const [client] = useState(() => new EngineClient());

  useEffect(() => {
    client.start();
    return () => client.dispose();
  }, [client]);

  useEffect(() => {
    client.configure(multiPv, maxDepth);
    client.setPosition(enabled ? fen : null);
  }, [client, fen, enabled, multiPv, maxDepth]);

  return useSyncExternalStore(client.subscribe, client.getSnapshot, client.getServerSnapshot);
}
