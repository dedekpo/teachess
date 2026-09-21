"use client";

import type { Color, Square } from "chess.js";
import type { ToolContext } from "./tools";
import { executeTool } from "./tools";
import type { LiveSessionOptions } from "./session-config";
import { SpeechMatcher, type MatchEvent } from "@/lib/mentions/matcher";
import type { Plan, RowMention } from "@/lib/mentions/types";
import type { Lang } from "@/lib/i18n/lang";

export type TutorStatus = "off" | "connecting" | "live" | "closing" | "idle" | "error";

export interface TranscriptRow {
  id: number;
  role: "user" | "assistant";
  text: string;
  startMs: number;
  endMs: number;
  /** Board position when the row started. */
  fen: string;
  /** Pieces and moves mentioned in the row, anchored to character ranges of `text`. */
  mentions: RowMention[];
}

export interface TutorState {
  status: TutorStatus;
  sessionId: string | null;
  transcript: TranscriptRow[];
  /** Seconds billed across all sessions of this lesson (live estimate). */
  usageSeconds: number;
  micLevel: number; // 0..1
  micAvailable: boolean;
  muted: boolean;
  speaking: boolean; // assistant currently producing speech (heuristic)
  thinking: boolean; // backend delegation in flight
  error: string | null;
  lastEvent: string | null;
  /** Last events received (type + short detail), newest last. For debugging. */
  eventLog: string[];
  /** Measured lead of transcript fragments over audible audio (ms, positive = transcript first). Null until calibrated. */
  syncLeadMs: number | null;
  /** Latency of the last turn: ms from the student's move to the Professor's voice being heard. */
  lastSpeechDelayMs: number | null;
}

const EMPTY: TutorState = {
  status: "off",
  sessionId: null,
  transcript: [],
  usageSeconds: 0,
  micLevel: 0,
  micAvailable: false,
  muted: true, // push-to-talk: the mic is open only while the student holds Space
  speaking: false,
  thinking: false,
  error: null,
  lastEvent: null,
  eventLog: [],
  syncLeadMs: null,
  lastSpeechDelayMs: null,
};

const MIC_THRESHOLD = 0.06; // RMS level considered "speech"
const ROW_GAP_MS = 1500; // transcript deltas further apart than this start a new row
const UTTERANCE_SETTLE_MS = 1800; // wall-clock silence after which a user transcript row is reported as an utterance
const STOP_MUTE_MS = 900; // output audio muted while a stop instruction takes effect
const COMMENTARY_FRESH_MS = 10_000; // commentary pushed within this window may still be unspoken
const OUTPUT_THRESHOLD = 0.012; // RMS of the Professor's audio considered speech
const OUTPUT_SILENCE_MS = 500; // silence before an energy rise counts as a new speech onset
const BURST_GAP_MS = 700; // transcript gap (session time) that starts a new burst of speech
/**
 * Manual correction added to every highlight time, in ms (positive = later). Tune after listening: if the
 * highlights land before the word is heard, increase it; if they lag, decrease it.
 */
const SYNC_BIAS_MS = 0;

const STOP_INSTRUCTION: Record<Lang, string> = {
  en:
    "The student has just played another move, so the comment about the previous move is out of date: if you are speaking it, " +
    "stop now, without finishing the sentence; if you have not started, do not say it. This applies only to that old comment: " +
    "the next ready-made comment arrives right after and must be spoken normally.",
  "pt-BR":
    "O aluno acabou de jogar outro lance, então o comentário sobre o lance anterior ficou desatualizado: se estiver falando dele, " +
    "interrompa agora, sem terminar a frase; se ainda não começou, não o fale. Isto vale só para esse comentário antigo: " +
    "o próximo comentário pronto chega em seguida e deve ser falado normalmente.",
};
const STOP_UNDO_INSTRUCTION: Record<Lang, string> = {
  en:
    "The student undid the move, so the comment you are speaking no longer makes sense, including the move you announced, " +
    "which will not be played: stop now, without finishing the sentence. This applies only to that comment: the next one " +
    "arrives right after and must be spoken normally.",
  "pt-BR":
    "O aluno desfez o lance, então o comentário que você está falando ficou sem sentido, inclusive o lance que você anunciou, " +
    "que não será jogado: interrompa agora, sem terminar a frase. Isto vale só para esse comentário: o próximo chega em " +
    "seguida e deve ser falado normalmente.",
};
/** The interrupt sent when the student undoes a move (see `stop`). */
export function stopUndoInstruction(lang: Lang): string {
  return STOP_UNDO_INSTRUCTION[lang];
}
const MIC_ERROR: Record<Lang, string> = { en: "Microphone unavailable", "pt-BR": "Microfone indisponível" };
const SESSION_ERROR: Record<Lang, string> = { en: "session error", "pt-BR": "erro na sessão" };
const COMMENTARY_QUIET_WAIT_MS = 5000; // max wait for the Professor to finish a sentence before handing it a new comment

export interface LiveClientConfig {
  buildOptions: () => LiveSessionOptions;
  /** Language of the lesson: interrupt instructions, the speech grammar and user-facing errors follow it. */
  lang: () => Lang;
  tools: ToolContext;
  idleTimeoutMs: number;
  /** Invoked when a brand-new (not forked) session starts, e.g. to greet. */
  onFreshSession?: () => void;
  /** Invoked once a student utterance (transcript row) has settled; `before` is the Professor's previous line. */
  onUserUtterance?: (text: string, before: string | null) => void;
  /** Current board position (stored on each transcript row). */
  getFen: () => string;
  userColor: () => Color;
  /** Destinations of the last moves, most recent first (tie-breaker when the speech is ambiguous). */
  recentSquares: () => Square[];
  /** Positions before the last moves, most recent first (the speech is often about what just happened). */
  recentFens: () => string[];
  /** A piece or move was mentioned. For the Professor it fires when the words are (estimated to be) audible. */
  onMention?: (e: MatchEvent) => void;
  /** The delegated backend finished writing an answer the Professor is about to paraphrase. */
  onBackendText?: (text: string) => void;
}

/**
 * Owns the WebRTC connection to GPT-Live, the mic, the data channel and the
 * idle/wake lifecycle. Exposed to React through useSyncExternalStore.
 */
export class LiveTutorClient {
  private state: TutorState = EMPTY;
  private listeners = new Set<() => void>();
  private config: LiveClientConfig | null = null;

  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private micStream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private levelTimer: number | null = null;

  private idleTimer: number | null = null;
  private speakingTimer: number | null = null;
  private closeResolver: (() => void) | null = null;
  private enabled = false;
  private connectSeq = 0;
  private rowSeq = 0;
  private eventSeq = 0;
  private sessionUsageBase = 0; // usage of previous sessions in this lesson
  private pendingCalls: { call_id: string; name: string; arguments: string }[] = [];
  private pendingCallTimer: number | null = null;

  // ---- speech → board sync ----
  private matcher = new SpeechMatcher({
    lang: () => this.config?.lang() ?? "en",
    userColor: () => this.config?.userColor() ?? "w",
    recentSquares: () => this.config?.recentSquares() ?? [],
    recentFens: () => this.config?.recentFens() ?? [],
    onMention: (e) => this.onMatched(e),
  });
  private mentionTimers = new Set<number>();
  private outputAnalyser: AnalyserNode | null = null;
  private outputTimer: number | null = null;
  private outputAboveSince: number | null = null;
  private outputBelowSince: number | null = null;
  /** local ms = session ms + offset; estimated from audio onsets. */
  private timelineOffset: number | null = null;
  private lastOnsetLocal: number | null = null;
  private burstStart: { startMs: number; localAt: number; text: string } | null = null;
  private lastOutputEndMs = -Infinity;
  private backendText = "";

  // ---- store plumbing ----
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };
  getSnapshot = () => this.state;
  getServerSnapshot = () => EMPTY;
  private set(patch: Partial<TutorState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  configure(config: LiveClientConfig) {
    this.config = config;
  }

  // ---- public API ----

  /** Start (or resume) the lesson: connects now and keeps auto-resuming until end(). */
  async start() {
    this.enabled = true;
    await this.ensureMic();
    await this.connect();
  }

  /** End the lesson: closes the session and stops auto-resume. Keeps the session id for a manual resume. */
  async end() {
    this.enabled = false;
    await this.closeSession("off");
  }

  /** Forget the stored session (new game): the next start() creates a fresh session. */
  resetConversation() {
    this.sessionUsageBase = this.state.usageSeconds;
    this.set({ sessionId: null, transcript: [] });
  }

  /**
   * Push-to-talk: the mic is open only while `on` (the student holds Space or the talk button). Muting disables the
   * track, so the session keeps receiving a (silent) audio stream and behaves as before between utterances. A press
   * while the session is idle wakes it.
   */
  setTalking(on: boolean) {
    if (on && this.state.status === "idle" && this.enabled) void this.connect();
    this.applyMute(!on);
    if (on && this.state.status === "live") this.resetIdle();
  }

  private applyMute(muted: boolean) {
    if (this.micStream) for (const t of this.micStream.getAudioTracks()) t.enabled = !muted;
    if (this.state.muted !== muted) this.set({ muted });
  }

  /** Call when something happened (a move) that should keep or wake the session. */
  noteActivity() {
    if (this.state.status === "live") this.resetIdle();
    else if (this.state.status === "idle" && this.enabled) void this.connect();
  }

  sendThinking(content: string) {
    return this.sendAppend("session.thinking.append", content);
  }
  /** Adds a line to the events panel (the page uses it to trace the turn pipeline). */
  trace(text: string) {
    this.log(text);
  }
  /** A turn began (the student moved, or the Professor opens the game): speech latency is measured from here. */
  noteTurnStart() {
    this.turnStartedAt = performance.now();
    this.speechReported = false;
  }
  /**
   * Hands the Professor a comment to speak. If it is mid-sentence the comment waits (up to a few seconds) so the
   * model does not abandon what it is saying; `stillValid` is checked again before sending.
   */
  async sendCommentary(content: string, stillValid: () => boolean = () => true): Promise<boolean> {
    const started = performance.now();
    while (this.state.speaking && performance.now() - started < COMMENTARY_QUIET_WAIT_MS) {
      await new Promise((r) => window.setTimeout(r, 100));
    }
    if (!stillValid()) return false;
    const sent = this.sendAppend("session.commentary.append", content);
    if (sent) {
      this.lastCommentaryAt = performance.now();
      this.spokeSinceCommentary = false;
      this.speechReported = false;
    }
    return sent;
  }

  /**
   * Interrupts the Professor programmatically. The Live API has no cancel event, so this
   * follows OpenAI's documented pattern: send a corrective instruction and mute the output
   * on the client for a moment so already-queued audio is not heard. Returns true when an
   * interruption was attempted (the model was speaking or had fresh commentary to speak).
   */
  stop(instruction?: string): boolean {
    if (this.state.status !== "live") return false;
    instruction ??= STOP_INSTRUCTION[this.config?.lang() ?? "en"];
    // A comment sent recently may not have been spoken yet; with the output analyser we know when speech ended.
    const fresh = performance.now() - this.lastCommentaryAt < COMMENTARY_FRESH_MS && !this.spokeSinceCommentary;
    if (!this.state.speaking && !fresh) return false;
    this.lastCommentaryAt = 0;
    this.cancelMentionTimers();
    this.send({ type: "session.instructions.append", event_id: `stop_${++this.eventSeq}`, delegation_id: null, content: instruction });
    if (this.audioEl) {
      this.audioEl.muted = true;
      if (this.unmuteTimer !== null) window.clearTimeout(this.unmuteTimer);
      this.unmuteTimer = window.setTimeout(() => {
        this.unmuteTimer = null;
        if (this.audioEl) this.audioEl.muted = false;
      }, STOP_MUTE_MS);
    }
    this.set({ speaking: false });
    return true;
  }
  sendInstructions(content: string) {
    return this.sendAppend("session.instructions.append", content);
  }

  /** Registers what the Professor is about to talk about, so the transcript can be matched to it. */
  setPlan(plan: Plan) {
    this.matcher.setPlan(plan);
    this.log(`plan registered (${plan.source}): ${plan.steps.map((m) => (m.body.kind === "move" ? m.body.san : m.body.kind === "piece" ? `${m.body.piece}@${m.body.squares.join("/")}` : m.body.square)).join(" ")}`);
  }

  /**
   * Development aid: feeds `text` as if the Professor were saying it now, in fragments at a speaking pace,
   * so the highlight pipeline can be exercised without a session (window.__teachess.client.debugSpeak("...")).
   */
  debugSpeak(text: string, charsPerSec = 15) {
    const words = text.split(/(\s+)/).filter((w) => w.length);
    const frags: string[] = [];
    let cur = "";
    for (const w of words) {
      cur += w;
      if (cur.trim().split(/\s+/).length >= 3 && !/\s$/.test(cur)) {
        frags.push(cur);
        cur = "";
      }
    }
    if (cur) frags.push(cur);
    const base = Math.max(0, this.lastOutputEndMs + 2000);
    // Fragments arrive as if generated 300 ms ahead of the audio.
    this.timelineOffset = performance.now() - base + 300;
    let ms = base;
    let wall = 0;
    for (const f of frags) {
      const dur = (f.length / charsPerSec) * 1000;
      const startMs = ms;
      const endMs = ms + dur;
      window.setTimeout(() => this.appendTranscript("assistant", { delta: f, start_ms: startMs, end_ms: endMs }), wall);
      ms = endMs;
      wall += dur;
    }
  }

  /** The board changed: pending plans and scheduled highlights are about an old position. */
  boardChanged() {
    this.matcher.clearPlans();
    this.cancelMentionTimers();
  }

  dispose() {
    this.enabled = false;
    void this.closeSession("off");
    this.stopMic();
    this.matcher.dispose();
  }

  // ---- internals ----

  private pendingAppends: { type: string; content: string }[] = [];
  private lastCommentaryAt = 0;
  /** True once the Professor has spoken (audio heard) after the last comment was sent. */
  private spokeSinceCommentary = false;
  private unmuteTimer: number | null = null;
  private utteranceTimer: number | null = null;
  /** When the current turn began (null before the first) and whether its speech was already reported. */
  private turnStartedAt: number | null = null;
  private speechReported = false;
  private lastUtterance: { id: number; text: string } | null = null;
  /** Timing of the delegation in flight: start, tool timings, for the events panel. */
  private delegation: { startedAt: number; tools: string[] } | null = null;

  private sendAppend(type: string, content: string): boolean {
    if (this.state.status !== "live") {
      // Keep the most recent context for when the session (re)opens.
      if (this.enabled) this.pendingAppends = [...this.pendingAppends.slice(-5), { type, content }];
      return false;
    }
    this.send({ type, event_id: `evt_${++this.eventSeq}`, delegation_id: null, content });
    this.resetIdle();
    return true;
  }

  private send(event: Record<string, unknown>) {
    const stamp = new Date().toISOString().slice(11, 19);
    const ok = !!this.dc && this.dc.readyState === "open";
    this.set({ eventLog: [...this.state.eventLog.slice(-60), `${stamp} → ${String(event.type)}${ok ? "" : " (dropped: channel not open)"}`] });
    if (ok) this.dc!.send(JSON.stringify(event));
  }

  private async ensureMic() {
    if (this.micStream) return;
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      for (const t of this.micStream.getAudioTracks()) t.enabled = !this.state.muted; // closed until Space is held
      this.audioCtx = new AudioContext();
      const src = this.audioCtx.createMediaStreamSource(this.micStream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 1024;
      src.connect(this.analyser);
      const buf = new Float32Array(this.analyser.fftSize);
      this.levelTimer = window.setInterval(() => {
        if (!this.analyser) return;
        this.analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        const level = Math.min(1, rms * 4);
        if (Math.abs(level - this.state.micLevel) > 0.01) this.set({ micLevel: level });
        this.onMicLevel(rms);
      }, 100);
      this.set({ micAvailable: true });
    } catch (e) {
      this.set({ micAvailable: false, error: `${MIC_ERROR[this.config?.lang() ?? "en"]}: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  private silent: MediaStream | null = null;
  private silentStream(): MediaStream {
    if (this.silent) return this.silent;
    const ctx = this.audioCtx ?? new AudioContext();
    this.audioCtx = ctx;
    const dest = ctx.createMediaStreamDestination();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const osc = ctx.createOscillator();
    osc.connect(gain).connect(dest);
    osc.start();
    this.silent = dest.stream;
    return this.silent;
  }

  private stopMic() {
    if (this.levelTimer !== null) window.clearInterval(this.levelTimer);
    this.levelTimer = null;
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
    void this.audioCtx?.close();
    this.audioCtx = null;
    this.analyser = null;
  }

  /** Speech while the mic is open keeps the session awake (an idle session is woken by the Space press itself). */
  private onMicLevel(rms: number) {
    if (this.state.muted || this.state.status !== "live") return;
    if (rms >= MIC_THRESHOLD) this.resetIdle();
  }

  private resetIdle() {
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
    const ms = this.config?.idleTimeoutMs ?? 90_000;
    this.idleTimer = window.setTimeout(() => {
      if (this.state.status === "live" && !this.state.thinking) void this.closeSession("idle");
      else this.resetIdle();
    }, ms);
  }

  private async connect() {
    if (!this.config) throw new Error("LiveTutorClient not configured");
    if (this.state.status === "connecting" || this.state.status === "live") return;
    const seq = ++this.connectSeq;
    this.set({ status: "connecting", error: null });

    try {
      const pc = new RTCPeerConnection();
      this.pc = pc;

      if (this.micStream) {
        for (const track of this.micStream.getAudioTracks()) pc.addTrack(track, this.micStream);
      } else {
        // No microphone: send a silent track so the session still has an inbound audio stream.
        const silent = this.silentStream();
        for (const track of silent.getAudioTracks()) pc.addTrack(track, silent);
      }

      if (!this.audioEl) {
        this.audioEl = document.createElement("audio");
        this.audioEl.autoplay = true;
      }
      pc.ontrack = (e) => {
        if (this.audioEl) {
          this.audioEl.srcObject = e.streams[0];
          void this.audioEl.play().catch(() => undefined);
        }
        this.watchOutput(e.streams[0]);
      };

      const dc = pc.createDataChannel("oai-events");
      this.dc = dc;
      dc.onmessage = (e) => this.onEvent(String(e.data));
      dc.onclose = () => {
        if (this.connectSeq === seq && this.state.status === "live") this.teardown("idle", "connection_lost");
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIce(pc, 2000);

      const sdp = pc.localDescription?.sdp;
      if (!sdp) throw new Error("no local SDP");

      const forkId = this.state.sessionId;
      let res = forkId
        ? await fetch("/api/live/session/fork", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId: forkId, sdp }),
          })
        : null;
      let fresh = false;
      if (!res || !res.ok) {
        fresh = true;
        res = await fetch("/api/live/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sdp, options: this.config.buildOptions() }),
        });
      }
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { session: { id: string }; transport: { sdp: string } };
      if (this.connectSeq !== seq) return; // superseded
      await pc.setRemoteDescription({ type: "answer", sdp: data.transport.sdp });
      this.set({ sessionId: data.session.id });
      this.freshPending = fresh;
    } catch (e) {
      this.teardown("error", e instanceof Error ? e.message : String(e));
    }
  }

  private freshPending = false;

  private onEvent(raw: string) {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = String(ev.type);
    const detail =
      type === "error"
        ? JSON.stringify(ev.error)
        : type === "response.event"
          ? String((ev.event as { type?: string })?.type)
          : type.endsWith("transcript.delta")
            ? JSON.stringify(ev.delta)
            : "";
    const stamp = new Date().toISOString().slice(11, 19);
    this.set({ lastEvent: type, eventLog: [...this.state.eventLog.slice(-60), `${stamp} ${type} ${detail}`.trim()] });

    switch (type) {
      case "session.started": {
        this.set({ status: "live", error: null });
        this.resetIdle();
        if (this.freshPending) {
          this.freshPending = false;
          this.config?.onFreshSession?.();
        }
        const queued = this.pendingAppends;
        this.pendingAppends = [];
        for (const a of queued) this.sendAppend(a.type, a.content);
        return;
      }
      case "session.closed": {
        const usage = (ev.usage as { seconds?: number } | undefined)?.seconds ?? 0;
        this.set({ usageSeconds: this.sessionUsageBase + usage });
        this.sessionUsageBase = this.state.usageSeconds;
        this.closeResolver?.();
        this.closeResolver = null;
        return;
      }
      case "session.usage.updated": {
        const usage = (ev.usage as { seconds?: number } | undefined)?.seconds ?? 0;
        this.set({ usageSeconds: this.sessionUsageBase + usage });
        return;
      }
      case "session.input_transcript.delta":
        this.appendTranscript("user", ev);
        this.resetIdle();
        return;
      case "session.output_transcript.delta":
        this.appendTranscript("assistant", ev);
        if (!this.outputAnalyser) this.reportSpeech("transcript"); // no audio analyser: the transcript is the best onset we have
        this.markSpeaking();
        this.resetIdle();
        return;
      case "session.commentary.appended":
        if (this.lastCommentaryAt) {
          this.log(`  ⤷ comment accepted ${Math.round(performance.now() - this.lastCommentaryAt)}ms after sending (timeline ${String(ev.start_ms)}–${String(ev.end_ms)}ms)`);
        }
        return;
      case "session.delegation.created":
        this.set({ thinking: true });
        this.delegation = { startedAt: performance.now(), tools: [] };
        this.resetIdle();
        return;
      case "response.event":
        this.onResponseEvent(ev.event as Record<string, unknown>);
        this.resetIdle();
        return;
      case "error": {
        const err = ev.error as { message?: string; code?: string } | undefined;
        this.set({ error: err?.message ?? SESSION_ERROR[this.config?.lang() ?? "en"] });
        return;
      }
      default:
        return;
    }
  }

  /**
   * Logs when the Professor starts speaking the pending comment: time since the comment was sent (the voice model's
   * own reaction time) and since the reply was played (what the student experiences). Once per comment.
   */
  private reportSpeech(kind: "audio" | "transcript") {
    if (this.speechReported || !this.lastCommentaryAt || this.spokeSinceCommentary) return;
    this.speechReported = true;
    const now = performance.now();
    const sinceComment = Math.round(now - this.lastCommentaryAt);
    const sinceMove = this.turnStartedAt !== null && this.turnStartedAt <= this.lastCommentaryAt ? Math.round(now - this.turnStartedAt) : null;
    this.log(`voice: Professor ${kind} ${sinceComment}ms after the comment${sinceMove !== null ? ` (${(sinceMove / 1000).toFixed(1)}s after the student's move)` : ""}`);
    if (sinceMove !== null) this.set({ lastSpeechDelayMs: sinceMove });
  }

  /** Adds a line to the debugging event log. */
  private log(text: string) {
    const stamp = new Date().toISOString().slice(11, 19);
    this.set({ eventLog: [...this.state.eventLog.slice(-60), `${stamp} ${text}`] });
  }

  private sinceDelegation(): string {
    return this.delegation ? `+${Math.round(performance.now() - this.delegation.startedAt)}ms` : "";
  }

  private markSpeaking() {
    if (!this.state.speaking) this.set({ speaking: true });
    if (this.speakingTimer !== null) window.clearTimeout(this.speakingTimer);
    // With the output analyser running, silence ends "speaking" quickly; otherwise transcript fragments keep it alive.
    this.speakingTimer = window.setTimeout(() => this.set({ speaking: false }), this.outputAnalyser ? 600 : 1200);
  }

  private appendTranscript(role: "user" | "assistant", ev: Record<string, unknown>) {
    const delta = String(ev.delta ?? "");
    const startMs = Number(ev.start_ms ?? 0);
    const endMs = Number(ev.end_ms ?? startMs);
    const rows = this.state.transcript;
    const last = rows[rows.length - 1];
    let row: TranscriptRow;
    let startChar: number;
    if (last && last.role === role && startMs - last.endMs <= ROW_GAP_MS) {
      startChar = last.text.length;
      row = { ...last, text: last.text + delta, endMs };
      this.set({ transcript: [...rows.slice(0, -1), row] });
    } else {
      startChar = 0;
      row = { id: ++this.rowSeq, role, text: delta, startMs, endMs, fen: this.config?.getFen() ?? "", mentions: [] };
      this.set({ transcript: [...rows, row] });
    }
    if (role === "assistant") this.noteOutputFragment(startMs, endMs, delta);
    this.matcher.delta(
      { id: row.id, role, fen: row.fen, text: row.text },
      { startChar, endChar: row.text.length, startMs, endMs, fen: this.config?.getFen() ?? row.fen },
    );
    if (role === "user") this.scheduleUtterance();
  }

  /** Tracks bursts of Professor speech on the session timeline (for the audio calibration). */
  private noteOutputFragment(startMs: number, endMs: number, text: string) {
    const now = performance.now();
    if (startMs - this.lastOutputEndMs > BURST_GAP_MS) {
      this.burstStart = { startMs, localAt: now, text: text.trim().slice(0, 30) };
      this.tryCalibrate();
    }
    this.lastOutputEndMs = Math.max(this.lastOutputEndMs, endMs);
  }

  /** Pairs the start of a transcript burst with the audio onset heard closest to it. */
  private tryCalibrate() {
    const burst = this.burstStart;
    const onset = this.lastOnsetLocal;
    if (!burst || onset === null || Math.abs(onset - burst.localAt) > 3000) return;
    const offset = onset - burst.startMs;
    const lead = onset - burst.localAt;
    this.timelineOffset = this.timelineOffset === null ? offset : this.timelineOffset * 0.5 + offset * 0.5;
    this.set({ syncLeadMs: this.state.syncLeadMs === null ? lead : Math.round(this.state.syncLeadMs * 0.5 + lead * 0.5) });
    this.log(`sync: "${burst.text}" arrived ${Math.round(lead)}ms ${lead >= 0 ? "before" : "after"} the audio (offset ${Math.round(offset)}ms)`);
    this.burstStart = null;
    this.lastOnsetLocal = null;
  }

  /** Local time at which a session-timeline instant is (estimated to be) audible. */
  private localTimeFor(sessionMs: number): number {
    if (this.timelineOffset === null) return performance.now();
    return sessionMs + this.timelineOffset + SYNC_BIAS_MS;
  }

  private onMatched(e: MatchEvent) {
    // Keep the transcript row's chips up to date.
    const rows = this.state.transcript;
    const idx = rows.findIndex((r) => r.id === e.rowId);
    if (idx >= 0) {
      const row = rows[idx];
      const entry: RowMention = { id: e.mention.id, start: e.start, end: e.end, mention: e.mention };
      const mentions = [...row.mentions.filter((m) => m.id !== entry.id && m.id !== e.replacesId && m.start !== entry.start), entry].sort(
        (a, b) => a.start - b.start,
      );
      this.set({ transcript: [...rows.slice(0, idx), { ...row, mentions }, ...rows.slice(idx + 1)] });
    }
    if (!this.config?.onMention) return;
    if (e.role !== "assistant") {
      this.config.onMention(e);
      return;
    }
    const delay = Math.max(0, this.localTimeFor(e.atMs) - performance.now());
    const timer = window.setTimeout(() => {
      this.mentionTimers.delete(timer);
      this.config?.onMention?.(e);
    }, delay);
    this.mentionTimers.add(timer);
    const what = e.mention.body.kind === "move" ? e.mention.body.san : e.mention.body.kind === "piece" ? `${e.mention.body.piece}@${e.mention.body.squares.join("/")}` : e.mention.body.square;
    this.log(`  ⤷ mention "${e.mention.text ?? ""}" → ${what} in ${Math.round(delay)}ms${this.timelineOffset === null ? " (uncalibrated)" : ""}`);
  }

  private cancelMentionTimers() {
    for (const t of this.mentionTimers) window.clearTimeout(t);
    this.mentionTimers.clear();
  }

  /** Listens to the Professor's audio to detect speech onsets (calibration) and whether it is speaking. */
  private watchOutput(stream: MediaStream) {
    this.stopWatchingOutput();
    try {
      const ctx = this.audioCtx ?? new AudioContext();
      this.audioCtx = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(analyser);
      this.outputAnalyser = analyser;
      const buf = new Float32Array(analyser.fftSize);
      this.outputTimer = window.setInterval(() => {
        if (!this.outputAnalyser) return;
        this.outputAnalyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        const now = performance.now();
        if (rms >= OUTPUT_THRESHOLD) {
          const silentFor = this.outputBelowSince === null ? Infinity : now - this.outputBelowSince;
          if (this.outputAboveSince === null) {
            this.outputAboveSince = now;
            if (silentFor >= OUTPUT_SILENCE_MS) {
              this.lastOnsetLocal = now;
              this.tryCalibrate();
            }
            this.reportSpeech("audio");
          }
          this.outputBelowSince = null;
          this.markSpeaking();
        } else {
          if (this.outputBelowSince === null) this.outputBelowSince = now;
          // A sentence spoken for a while and then silence: the pending comment has been delivered.
          if (this.outputAboveSince !== null && now - this.outputAboveSince > 1500) this.spokeSinceCommentary = true;
          this.outputAboveSince = null;
        }
      }, 40);
    } catch {
      this.outputAnalyser = null;
    }
  }

  private stopWatchingOutput() {
    if (this.outputTimer !== null) window.clearInterval(this.outputTimer);
    this.outputTimer = null;
    this.outputAnalyser = null;
    this.outputAboveSince = null;
    this.outputBelowSince = null;
  }

  /** Reports the latest user row once no more fragments arrive for a moment (there is no turn-done event). */
  private scheduleUtterance() {
    if (this.utteranceTimer !== null) window.clearTimeout(this.utteranceTimer);
    this.utteranceTimer = window.setTimeout(() => {
      this.utteranceTimer = null;
      const rows = this.state.transcript;
      let idx = rows.length - 1;
      while (idx >= 0 && rows[idx].role !== "user") idx--;
      if (idx < 0) return;
      const row = rows[idx];
      const text = row.text.trim();
      if (!text || (this.lastUtterance?.id === row.id && this.lastUtterance.text === text)) return;
      this.lastUtterance = { id: row.id, text };
      let before: string | null = null;
      for (let j = idx - 1; j >= 0; j--) {
        if (rows[j].role === "assistant") {
          before = rows[j].text.trim();
          break;
        }
      }
      this.config?.onUserUtterance?.(text, before);
    }, UTTERANCE_SETTLE_MS);
  }

  private onResponseEvent(event: Record<string, unknown>) {
    const type = String(event.type);
    if (type === "response.created") {
      this.backendText = "";
      return;
    }
    if (type === "response.output_text.delta") {
      this.backendText += String(event.delta ?? "");
      return;
    }
    if (type === "response.output_text.done") {
      const text = (typeof event.text === "string" && event.text) || this.backendText;
      this.backendText = "";
      if (text.trim()) {
        this.log(`  ⤷ backend answer (${text.length} chars) ${this.sinceDelegation()}`);
        this.config?.onBackendText?.(text);
      }
      return;
    }
    if (type === "response.output_item.done") {
      const item = event.item as { type?: string; call_id?: string; name?: string; arguments?: string } | undefined;
      if (item?.type === "function_call" && item.call_id && item.name) {
        this.log(`  ⤷ backend calls ${item.name} ${this.sinceDelegation()}`);
        this.pendingCalls.push({ call_id: item.call_id, name: item.name, arguments: item.arguments ?? "" });
        // Fallback in case response.completed never arrives.
        if (this.pendingCallTimer !== null) window.clearTimeout(this.pendingCallTimer);
        this.pendingCallTimer = window.setTimeout(() => void this.runPendingCalls(), 2500);
      }
      return;
    }
    if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
      if (this.pendingCalls.length > 0) void this.runPendingCalls();
      else {
        if (this.delegation) {
          const total = Math.round(performance.now() - this.delegation.startedAt);
          this.log(`  ⤷ delegation finished in ${total}ms (${this.delegation.tools.join(", ") || "no tools"})`);
          this.delegation = null;
        }
        this.set({ thinking: false });
      }
    }
  }

  private async runPendingCalls() {
    if (this.pendingCallTimer !== null) window.clearTimeout(this.pendingCallTimer);
    this.pendingCallTimer = null;
    const calls = this.pendingCalls;
    this.pendingCalls = [];
    if (calls.length === 0 || !this.config) return;
    for (const call of calls) {
      let output: string;
      const t0 = performance.now();
      try {
        output = await executeTool(call.name, call.arguments, this.config.tools);
      } catch (e) {
        output = JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
      }
      const ms = Math.round(performance.now() - t0);
      this.delegation?.tools.push(`${call.name} ${ms}ms`);
      this.log(`  ⤷ ${call.name} respondida em ${ms}ms (${output.length} chars)`);
      this.send({
        type: "response.item.create",
        event_id: `tool_${++this.eventSeq}`,
        item: { type: "function_call_output", call_id: call.call_id, output },
      });
    }
    this.send({ type: "response.create", event_id: `continue_${++this.eventSeq}` });
  }

  private async closeSession(nextStatus: "idle" | "off") {
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (!this.pc || this.state.status === "off" || this.state.status === "idle") {
      if (this.state.status !== nextStatus && this.state.status !== "error") this.set({ status: nextStatus });
      return;
    }
    this.set({ status: "closing" });
    const closed = new Promise<void>((resolve) => {
      this.closeResolver = resolve;
    });
    this.send({ type: "session.close" });
    await Promise.race([closed, new Promise<void>((r) => window.setTimeout(r, 3000))]);
    this.teardown(nextStatus, null);
  }

  private teardown(status: TutorStatus, error: string | null) {
    this.connectSeq++;
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.dc?.close();
    this.pc?.close();
    this.dc = null;
    this.pc = null;
    if (this.unmuteTimer !== null) window.clearTimeout(this.unmuteTimer);
    this.unmuteTimer = null;
    if (this.utteranceTimer !== null) window.clearTimeout(this.utteranceTimer);
    this.utteranceTimer = null;
    if (this.audioEl) {
      this.audioEl.srcObject = null;
      this.audioEl.muted = false;
    }
    this.lastCommentaryAt = 0;
    this.pendingCalls = [];
    this.closeResolver = null;
    this.cancelMentionTimers();
    this.stopWatchingOutput();
    this.burstStart = null;
    this.lastOnsetLocal = null;
    this.lastOutputEndMs = -Infinity;
    this.backendText = "";
    this.set({ status, thinking: false, speaking: false, error: error ?? (status === "error" ? this.state.error : null) });
  }
}

function waitForIce(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = window.setTimeout(done, timeoutMs);
    function done() {
      window.clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    }
    function check() {
      if (pc.iceGatheringState === "complete") done();
    }
    pc.addEventListener("icegatheringstatechange", check);
  });
}
