"use client";

import { Chess, type Color } from "chess.js";
import { formatScoreWhite, parseUci, pvToSan, scoreToPawns } from "./engine-format";
import type { EngineScore } from "./useEngine";

/**
 * "Engine memory" for the tutor: a third Stockfish worker that evaluates EVERY legal
 * move of the position the student is looking at (one MultiPV search), so the tutor's
 * backend gets the whole picture from a single tool call instead of searching on demand.
 * Tables are kept for the last few positions (undo, "what if I had played...").
 */

export interface MoveEval {
  san: string;
  uci: string;
  /** Evaluation after the move, from White's perspective ("+0.3", "M2"). */
  eval: string;
  pawns: number;
  /** Opponent's best reply (SAN), when known. */
  bestReply: string | null;
  /** Short continuation after the move (SAN, opponent's reply first). */
  line: string[];
}

export interface MoveTable {
  fen: string;
  depth: number;
  /** All legal moves, best first. */
  moves: MoveEval[];
  /** Number of legal moves in the position. */
  legalMoves: number;
  /** True once the search reached its target depth. */
  complete: boolean;
}

const ENGINE_URL = "/stockfish/stockfish-18-lite-single.js";
const KEEP_TABLES = 4;
const TARGET_DEPTH = 14;
const FLUSH_MS = 120;

interface RawLine {
  multipv: number;
  depth: number;
  score: EngineScore;
  pv: string[];
}

function parseInfo(line: string): RawLine | null {
  if (!line.startsWith("info ") || !line.includes(" pv ") || !line.includes(" multipv ")) return null;
  if (line.includes(" lowerbound") || line.includes(" upperbound")) return null;
  const t = line.split(" ");
  let depth = 0;
  let multipv = 1;
  let score: EngineScore | null = null;
  let pv: string[] = [];
  for (let i = 1; i < t.length; i++) {
    switch (t[i]) {
      case "depth":
        depth = Number(t[++i]);
        break;
      case "multipv":
        multipv = Number(t[++i]);
        break;
      case "score":
        score = { type: t[++i] as "cp" | "mate", value: Number(t[++i]) };
        break;
      case "pv":
        pv = t.slice(i + 1);
        i = t.length;
        break;
    }
  }
  if (!score || pv.length === 0) return null;
  return { multipv, depth, score, pv };
}

export class MoveTableEngine {
  private worker: Worker | null = null;
  private ready = false;
  private searching = false;
  private currentFen: string | null = null;
  private pendingFen: string | null = null;
  private stopRequested = false;
  private lines = new Map<number, RawLine>();
  private flushTimer: number | null = null;
  private tables = new Map<string, MoveTable>();
  private listeners = new Set<() => void>();

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };
  private notify() {
    for (const l of this.listeners) l();
  }

  private ensure() {
    if (this.worker || typeof Worker === "undefined") return;
    const worker = new Worker(ENGINE_URL);
    this.worker = worker;
    worker.onmessage = (e: MessageEvent<string>) => this.onLine(String(e.data));
    worker.onerror = () => {
      this.worker = null;
      this.ready = false;
    };
    worker.postMessage("uci");
  }

  /** Evaluate every legal move of `fen`; `null` stops the current search. */
  setPosition(fen: string | null) {
    this.ensure();
    const worker = this.worker;
    if (!worker) return;
    if (fen === null) {
      this.pendingFen = null;
      if (this.searching) {
        this.stopRequested = true;
        worker.postMessage("stop");
      }
      return;
    }
    const existing = this.tables.get(fen);
    if (existing?.complete) return;
    if (this.currentFen === fen && this.searching) return;
    if (!this.ready || this.searching) {
      this.pendingFen = fen;
      if (this.searching) {
        this.stopRequested = true;
        worker.postMessage("stop");
      }
      return;
    }
    this.startSearch(fen);
  }

  get(fen: string): MoveTable | undefined {
    return this.tables.get(fen);
  }

  /** Waits until the table for `fen` reaches `minDepth` (or the timeout) and returns it. */
  async waitFor(fen: string, minDepth: number, timeoutMs: number): Promise<MoveTable | undefined> {
    const started = performance.now();
    for (;;) {
      const t = this.tables.get(fen);
      if (t && (t.depth >= minDepth || t.complete)) return t;
      if (performance.now() - started > timeoutMs) return t;
      await new Promise((r) => setTimeout(r, 100));
    }
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
  }

  private startSearch(fen: string) {
    const worker = this.worker;
    if (!worker) return;
    const legal = new Chess(fen).moves().length;
    if (legal === 0) return;
    this.currentFen = fen;
    this.lines = new Map();
    this.searching = true;
    this.stopRequested = false;
    worker.postMessage(`setoption name MultiPV value ${legal}`);
    worker.postMessage(`position fen ${fen}`);
    worker.postMessage(`go depth ${TARGET_DEPTH}`);
  }

  private scheduleFlush(complete: boolean) {
    if (complete && this.flushTimer !== null) {
      window.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.flushTimer !== null) return;
    const run = () => {
      this.flushTimer = null;
      this.flush(complete);
    };
    if (complete) run();
    else this.flushTimer = window.setTimeout(run, FLUSH_MS);
  }

  private flush(complete: boolean) {
    const fen = this.currentFen;
    if (!fen || this.lines.size === 0) return;
    const turn = fen.split(" ")[1] as Color;
    const raw = [...this.lines.values()];
    const depth = Math.min(...raw.map((l) => l.depth));
    const prev = this.tables.get(fen);
    if (prev && prev.depth > depth) return;
    const moves: MoveEval[] = raw
      .sort((a, b) => a.multipv - b.multipv)
      .map((l) => {
        const san = pvToSan(fen, l.pv, 5);
        return {
          san: san[0] ?? l.pv[0],
          uci: l.pv[0],
          eval: formatScoreWhite(l.score, turn).text,
          pawns: scoreToPawns(l.score, turn),
          bestReply: san[1] ?? null,
          line: san.slice(1),
        };
      });
    const legalMoves = new Chess(fen).moves().length;
    const table: MoveTable = { fen, depth, moves, legalMoves, complete: complete && moves.length >= legalMoves };
    this.tables.delete(fen);
    this.tables.set(fen, table);
    while (this.tables.size > KEEP_TABLES) {
      const oldest = this.tables.keys().next().value;
      if (oldest === undefined) break;
      this.tables.delete(oldest);
    }
    this.notify();
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
      const next = this.pendingFen;
      this.pendingFen = null;
      if (next) this.startSearch(next);
      return;
    }
    if (line.startsWith("bestmove")) {
      const interrupted = this.stopRequested || this.pendingFen !== null;
      this.searching = false;
      this.scheduleFlush(!interrupted);
      if (this.pendingFen) {
        const f = this.pendingFen;
        this.pendingFen = null;
        this.startSearch(f);
      }
      return;
    }
    if (!this.searching) return;
    const info = parseInfo(line);
    if (!info) return;
    this.lines.set(info.multipv, info);
    this.scheduleFlush(false);
  }
}

/** Applies a SAN/UCI sequence to `fen`; returns the resulting FEN and SAN moves, or null if any move is illegal. */
export function applyLine(fen: string, moves: string[]): { fen: string; san: string[] } | null {
  const chess = new Chess(fen);
  const san: string[] = [];
  for (const m of moves) {
    const text = m.trim();
    try {
      san.push(chess.move(text).san);
      continue;
    } catch {
      /* try UCI */
    }
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/i.test(text)) return null;
    try {
      san.push(chess.move(parseUci(text.toLowerCase())).san);
    } catch {
      return null;
    }
  }
  return { fen: chess.fen(), san };
}
