import type { Color, Square } from "chess.js";
import { hintColor, parsePhrases, resolvePhrase, type Phrase } from "./grammar";
import type { Mention, Plan } from "./types";
import type { Lang } from "@/lib/i18n/lang";

/**
 * Follows the transcript as it streams and decides, phrase by phrase, what the speaker is referring to:
 * a step of a registered plan when one fits, otherwise a heuristic resolution against the board.
 */

export interface MatchEvent {
  rowId: number;
  role: "user" | "assistant";
  start: number;
  end: number;
  mention: Mention;
  /** Session-timeline milliseconds where the phrase is spoken (interpolated inside its fragment). */
  atMs: number;
  /** Id of an earlier mention this one replaces (the phrase grew, e.g. "pawn on d2" → "pawn on d2 to d4"). */
  replacesId: string | null;
}

export interface Segment {
  startChar: number;
  endChar: number;
  startMs: number;
  endMs: number;
  /** Board position when the fragment arrived (rows can outlive a move). */
  fen: string;
}

interface RowState {
  id: number;
  role: "user" | "assistant";
  fen: string;
  text: string;
  segments: Segment[];
  /** Emitted phrases by start offset; `sig` summarises what the phrase said so growth can be detected. */
  emitted: Map<number, { id: string; end: number; fromPlan: boolean; sig: string }>;
}

function signature(p: Phrase): string {
  return `${p.piece ?? ""}|${p.at ?? ""}|${p.to ?? ""}|${p.capture ? `${p.capture.piece ?? ""}@${p.capture.square ?? ""}` : ""}`;
}

function coversSquare(m: Mention, sq: string): boolean {
  return m.visual.squares.includes(sq as never) || m.visual.arrows.some((a) => a.to === sq || a.from === sq);
}

const HOLD_MS = 250; // wait for a phrase touching the end of the text to grow before resolving it
const PLAN_TTL_MS = 120_000;
const LOOKAHEAD = 4;

export class SpeechMatcher {
  private plans: Plan[] = [];
  private cursors = new Map<string, number>();
  private fired = new Set<string>();
  private rows = new Map<number, RowState>();
  private holdTimer: number | null = null;
  private holdRow: number | null = null;
  private lastById = new Map<string, Mention>();

  constructor(
    private readonly opts: {
      lang: () => Lang;
      userColor: () => Color;
      recentSquares: () => Square[];
      /** Positions before the last moves, most recent first (speech about a piece that has just moved). */
      recentFens: () => string[];
      onMention: (e: MatchEvent) => void;
    },
  ) {}

  setPlan(plan: Plan) {
    if (plan.steps.length === 0) return;
    this.plans = [plan, ...this.plans.filter((p) => p.id !== plan.id)].slice(0, 3);
    this.cursors.set(plan.id, -1);
  }

  /** The board changed: plans about the old position no longer apply. */
  clearPlans() {
    this.plans = [];
    this.cursors.clear();
  }

  /** Feeds the text of one transcript fragment (the row text is the whole accumulated row). */
  delta(row: { id: number; role: "user" | "assistant"; fen: string; text: string }, segment: Segment) {
    let state = this.rows.get(row.id);
    if (!state) {
      state = { id: row.id, role: row.role, fen: row.fen, text: "", segments: [], emitted: new Map() };
      this.rows.set(row.id, state);
      if (this.rows.size > 40) this.rows.delete(this.rows.keys().next().value!);
    }
    state.text = row.text;
    state.segments.push(segment);
    this.process(state, false);
  }

  /** No more fragments are expected for a while: resolve whatever is still held. */
  settle(rowId: number) {
    const state = this.rows.get(rowId);
    if (state) this.process(state, true);
  }

  dispose() {
    if (this.holdTimer !== null) window.clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }

  private process(state: RowState, force: boolean) {
    const now = performance.now();
    this.plans = this.plans.filter((p) => now - p.createdAt < PLAN_TTL_MS);
    let held = false;
    let lastMention: Mention | null = null;
    for (const phrase of parsePhrases(state.text, this.opts.lang())) {
      const prev = state.emitted.get(phrase.start);
      const sig = signature(phrase);
      if (prev && (prev.end >= phrase.end || prev.sig === sig)) {
        if (prev.id) lastMention = this.lastById.get(prev.id) ?? lastMention;
        continue;
      }
      if (!phrase.complete && !force) {
        held = true;
        continue;
      }
      // A bare square right after a mention that already covers it ("...to b4" then "b4") adds nothing.
      if (!phrase.piece && phrase.at && lastMention && coversSquare(lastMention, phrase.at)) {
        state.emitted.set(phrase.start, { id: "", end: phrase.end, fromPlan: false, sig });
        continue;
      }
      // The phrase grew since it was emitted: resolve it again (a plan step it took can be taken again).
      if (prev?.fromPlan) this.fired.delete(prev.id);
      const atMs = this.timeAt(state, phrase.start);
      const fen = this.fenAt(state, phrase.start);
      const match = state.role === "assistant" ? this.matchPlan(phrase) : null;
      let mention: Mention | null = null;
      let fromPlan = false;
      if (match) {
        mention = match;
        fromPlan = true;
      } else {
        const speaker = state.role === "assistant" ? "professor" : "student";
        const id = `h${state.id}:${phrase.start}`;
        mention =
          resolvePhrase(id, phrase, fen, {
            lang: this.opts.lang(),
            speaker,
            userColor: this.opts.userColor(),
            recentSquares: this.opts.recentSquares(),
            recentFens: this.opts.recentFens(),
          })?.mention ?? null;
      }
      if (!mention) {
        state.emitted.set(phrase.start, { id: "", end: phrase.end, fromPlan: false, sig });
        continue;
      }
      state.emitted.set(phrase.start, { id: mention.id, end: phrase.end, fromPlan, sig });
      this.lastById.set(mention.id, mention);
      lastMention = mention;
      this.opts.onMention({ rowId: state.id, role: state.role, start: phrase.start, end: phrase.end, mention, atMs, replacesId: prev?.id || null });
    }
    if (this.holdTimer !== null) {
      window.clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    if (held) {
      this.holdRow = state.id;
      this.holdTimer = window.setTimeout(() => {
        this.holdTimer = null;
        const s = this.holdRow !== null ? this.rows.get(this.holdRow) : undefined;
        if (s) this.process(s, true);
      }, HOLD_MS);
    }
  }

  private fenAt(state: RowState, char: number): string {
    const seg = state.segments.find((s) => char >= s.startChar && char < s.endChar) ?? state.segments[state.segments.length - 1];
    return seg?.fen || state.fen;
  }

  private timeAt(state: RowState, char: number): number {
    const seg = state.segments.find((s) => char >= s.startChar && char < s.endChar) ?? state.segments[state.segments.length - 1];
    if (!seg) return 0;
    const len = Math.max(1, seg.endChar - seg.startChar);
    const frac = Math.min(1, Math.max(0, (char - seg.startChar) / len));
    return seg.startMs + frac * (seg.endMs - seg.startMs);
  }

  /** Best unfired plan step for a phrase, or null when nothing fits well enough. */
  private matchPlan(phrase: Phrase): Mention | null {
    const hasSquare = !!(phrase.at || phrase.to || phrase.capture?.square);
    const color = hintColor(phrase.side, "professor", this.opts.userColor());
    let best: { plan: Plan; index: number; score: number } | null = null;
    for (const plan of this.plans) {
      const cursor = this.cursors.get(plan.id) ?? -1;
      for (let index = 0; index < plan.steps.length; index++) {
        const step = plan.steps[index];
        if (this.fired.has(step.id)) continue;
        let s = 0;
        const b = step.body;
        const sqs = b.kind === "piece" ? b.squares : b.kind === "square" ? [b.square] : [];
        if (phrase.to) {
          if (b.kind === "move" && b.to === phrase.to) s += 3;
          else if (sqs.includes(phrase.to)) s += 1;
        }
        if (phrase.at) {
          if (b.kind === "move" && b.from === phrase.at && phrase.to) s += 1.5;
          else if (b.kind === "move" && b.from === phrase.at) s += 1.5; // "bishop on b5" alone: origin only
          else if (b.kind === "move" && b.to === phrase.at) s += 2.5; // "bishop to f4" / "knight f3"
          else if (sqs.includes(phrase.at)) s += 3;
        }
        if (phrase.capture?.square && b.kind === "move" && b.to === phrase.capture.square) s += 3;
        if (phrase.capture && b.kind === "move" && b.captured && !phrase.capture.square) s += 1;
        if (phrase.piece) {
          if (b.kind !== "square") s += b.piece === phrase.piece ? 1 : -2;
        }
        if (color && b.kind !== "square") s += b.color === color ? 0.5 : -0.5;
        if (index > cursor) s -= 0.15 * Math.min(index - cursor - 1, LOOKAHEAD);
        else s -= 0.5;
        if (index > cursor + LOOKAHEAD && !hasSquare) s -= 1;
        if (!best || s > best.score) best = { plan, index, score: s };
      }
    }
    if (!best) return null;
    const threshold = hasSquare ? 3 : 0.7;
    if (best.score < threshold) return null;
    const step = best.plan.steps[best.index];
    this.fired.add(step.id);
    this.cursors.set(best.plan.id, Math.max(best.index, this.cursors.get(best.plan.id) ?? -1));
    return step;
  }
}
